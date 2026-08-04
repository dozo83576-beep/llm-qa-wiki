---
title: "Pattern: полноэкранные скриншоты веб-страниц без обрезок"
category: "pattern"
updated: "2026-08-03"
status: "active"
tags: ["screenshots", "playwright", "chrome", "evidence", "visual-quality"]
source_priority: "mixed"
area: "ui"
test_level: "e2e"
date: "2026-08-03"
---

# Полноэкранные скриншоты веб-страниц без обрезок

Единый способ получать воспроизводимые QA-доказательства во встроенном браузере или внешнем
Chromium/Chrome и не смешивать видимую область, всю прокручиваемую страницу и фрагмент элемента.

## Назначение

Исключить кадры с обрезанным интерфейсом, незагруженными изображениями, разрывами от склейки и
разным размером между кейсами. Приём применим к текущему проекту и к следующим заказам через общий
раннер `tools/ui-evidence/`.

## Какой снимок нужен

| Режим | Playwright | Что попадает в PNG | Когда применять |
|---|---|---|---|
| `viewport` | `page.screenshot({ fullPage: false })` | вся видимая область страницы без рамки Chrome | итоговый кадр кейса; именно такой формат у образцов 1920×907 и 1643×743 |
| `document` | `page.screenshot({ fullPage: true })` | весь scrollable document, включая область ниже fold | дополнительный обзор длинной страницы |
| `element` | `locator.screenshot()` или `clip` | один элемент или прямоугольник | диагностическое увеличение, не замена общего кадра |

«Развернуть Chrome» и `fullPage: true` — не одно и то же. Для образцов нужен `viewport` после
максимизации окна. `fullscreen` в WebDriver похож на F11 и убирает интерфейс браузера; это отдельный
режим, который включается только по явному требованию. Обычный `maximize` заполняет доступную область
экрана, сохраняя системные панели.

## Кадр должен доказать кейс

- Основной `<Case ID>.png` показывает не просто нужный участок страницы, а результат, записанный в
  кейсе: раскрытый список, закрытое меню, появившееся окно, обрезанный текст или доступный блок.
- Для перехода, который нельзя однозначно прочитать по одному кадру, снимаются именованные состояния
  «до/после» либо запись экрана. Информативный промежуточный кадр назначается основным через
  `primaryCaptureAfter`.
- Невидимое условие подтверждается декларативной метрикой в `capture.proof`: например,
  `page-overflow` для горизонтального скролла или `element-state` для скрытого окна. Значение видно
  на PNG и остаётся в manifest.
- Точные дубликаты основных PNG разных Case ID блокируют прогон. Визуально похожие кадры принимаются
  только после просмотра contact sheet, если каждый показывает своё состояние или измерение.

## Рекомендуемая архитектура

Поверхность выбирается по назначению доказательства. Если встроенный браузер агентного рантайма
доступен, устойчивее выполняет пользовательские действия и позволяет задать нужный viewport, он
предпочтителен для интерактивного прогона и клиентских PNG. В отчёте фиксируются поверхность
захвата, viewport и размер image; такому кадру нельзя приписывать версию Chrome.

Playwright + Chromium/Chrome в headed-режиме с отдельным persistent profile остаётся обязательным
кросс-рантайм fallback и вариантом для воспроизводимого CLI-прогона. Он используется в
`tools/ui-evidence/`, умеет `viewport`, `fullPage`, `clip`, скрытие caret, остановку анимаций,
маскирование и временный stylesheet. Проверка конкретной версии Chrome выполняется в Chrome
отдельно — автоматически либо вручную — и записывается отдельно от окружения снимка.

Подключение к уже открытому Chrome через `chromium.connectOverCDP()` оставить fallback для сессии,
которую трудно повторно авторизовать. Playwright прямо предупреждает, что CDP-соединение менее
полнофункционально, чем его собственный протокол. При CDP раннер обязан вызвать
`Browser.getWindowForTarget`, установить `Browser.setWindowBounds({windowState: "maximized"})`,
повторно прочитать bounds и активировать вкладку. CDP запрещает одновременно передавать состояние
`maximized`/`fullscreen` и координаты или размеры.

Selenium подходит как запасной WebDriver-инструмент для матрицы браузеров, но его стандартная
команда screenshot снимает visual viewport. Для Chrome full-page всё равно понадобится CDP,
скролл/склейка или иной браузерный механизм, поэтому вводить Selenium вторым основным стеком
невыгодно.

Рабочий контракт конфига:

```json
{
  "browser": {
    "mode": "launch",
    "windowState": "maximized",
    "expectedScreen": { "width": 1920, "height": 1080 }
  },
  "capture": {
    "mode": "viewport",
    "scroll": "top",
    "contextSelector": "header",
    "scale": "css",
    "animations": "disabled",
    "stableFrames": 2,
    "collapseEmptyAds": [
      { "container": ".header-ann", "slot": ":scope > .ad-slot", "optional": true }
    ]
  },
  "readiness": {
    "readySelector": "main",
    "fonts": true,
    "visibleImages": true
  },
  "navigation": {
    "attempts": 3,
    "timeoutMs": 45000,
    "retryDelayMs": 1000,
    "networkIdleTimeoutMs": 3000
  },
  "diagnostics": { "trace": "off" }
}
```

`collapseEmptyAds` — не общий CSS для рекламы. Это объявленное проектом правило для конкретного
контейнера и слота; срабатывание проверяется и записывается в manifest.

## Как это делается

1. Выбрать поверхность захвата. Во встроенном браузере установить требуемый viewport и записать
   `captureSurface`, URL, viewport и фактический размер PNG. Для CLI-прогона открыть отдельный
   профиль Chromium/Chrome в headed-режиме и дополнительно зафиксировать версию Playwright, locale и
   `devicePixelRatio`.
2. При внешнем запуске максимизировать окно через CDP и проверить полученное состояние либо
   использовать фиксированный viewport. `screen`, CSS-`viewport` и `image` записываются раздельно;
   `viewport: null` зависит от окна ОС и недетерминирован между машинами.
3. Выполнить шаги кейса и дождаться предметного сигнала: целевой locator видим, ответ нужного API
   получен, счётчик обновился. Не использовать фиксированную паузу как основной критерий:
   `waitForTimeout()` в документации Playwright помечен как discouraged и flaky.
4. Дождаться `document.fonts.ready` и загрузки изображений, которые уже видимы в viewport. Для
   итогового кадра с `scroll: "top"` не прокручивать страницу ради lazy content: это меняет
   пользовательское состояние. Прокрутка допустима только как явный шаг кейса или настройка
   `scroll: "anchor"`/`"current"`.
5. Динамическую рекламу не останавливать `window.stop()`: это может оставить iframe, картинку или
   слот в промежуточном состоянии. Заполненную рекламу сохранять. Доказанно пустой зарезервированный
   слот разрешено свернуть перед снимком только по объявленному правилу: slot скрыт или имеет
   нулевой размер, а внутри container нет видимого `iframe`, `img`, `video`, `canvas`, `object` или
   `embed`. В manifest записать селекторы и исходную высоту; без этой записи кадр нельзя считать raw.
6. Перед `viewport`-снимком проверить, что целевой элемент целиком лежит внутри viewport и не
   перекрыт. Если он не помещается, сделать два именованных viewport-кадра либо дополнительный
   `document`-кадр — не обрезать и не склеивать молча.
7. Снять PNG с `scale: "css"`, `animations: "disabled"`, `caret: "hide"`. `scale: "css"` даёт один
   пиксель на CSS-пиксель и исключает неожиданное удвоение на HiDPI; `deviceScaleFactor: 1`
   дополнительно фиксирует Windows-окружение.
8. Снять второй кадр после следующего стабильного состояния и сравнить размеры и пиксели. Сохранить
   последний только если два последовательных кадра совпали в заданном допуске. Такой принцип уже
   использует `toHaveScreenshot()` Playwright.
9. Записать рядом manifest JSON и построить contact sheet. Автоматический gate проверяет PNG,
   image и viewport, URL, наличие целевого и контекстного элемента, отсутствие полностью пустого
   кадра, одинаковый размер основных viewport-кадров, единую ширину full-page кадров и крупные внутренние белые
   полосы. Практический порог: `max(160 px, 18% высоты viewport)`. Срабатывание блокирует кадр;
   меньшие области всё равно просматриваются на contact sheet.

## Пустой рекламный слот: безопасная нормализация

Белая полоса может быть не склейкой, а внешним контейнером фиксированной высоты, внутри которого
рекламная сеть оставила скрытый slot и iframe высотой 0. В обычном пользовательском профиле этот
слот иногда заполнен или корректно схлопнут, а в отдельной сессии остаётся пустым.

Порядок решения:

1. В момент съёмки измерить container и slot, а не делать вывод по одному белому цвету PNG.
2. Не сворачивать container, если найдено видимое рекламное содержимое больше технического пикселя.
3. Сворачивать только селектор из проектного конфига; произвольный JavaScript в конфиг не добавлять.
4. После нормализации повторно проверить `scrollY`, положение target и белую полосу на готовом PNG.
5. Записать результат в `manifest.cases[].collapsedEmptyAds`.

Такой кадр честно показывает интерфейс без незаполненного технического слота, но не скрывает
реально отданную рекламу.

Для `document` сначала использовать `fullPage: true`. На страницах, где прокручивается не document,
а вложенный контейнер, Playwright считает это ожидаемым ограничением: `fullPage` не раскрывает
внутренние scroller-элементы. Тогда снимается `locator.screenshot()` контейнера или отдельные
viewport-кадры. Невидимая склейка нескольких скроллов запрещена: fixed/sticky элементы и
догружаемый контент дают повторы, разрывы и разные состояния.

## Сопоставление с текущей системой

- `tools/ui-evidence/functional-capture.js` обслуживает декларативные функциональные кейсы,
  viewport-снимки, стабильные кадры, manifest и contact sheet. Проектные одноразовые JS-скрипты для
  той же задачи не нужны.
- `tools/ui-evidence/collect.js` остаётся legacy-режимом для доказательств отдельных элементов:
  hover, dropdown, focus и readability. Его clip-кадры не подменяют снимок всего viewport.
- `tools/ui-evidence/pw-env.js` проверяет maximized bounds через CDP, активирует вкладку и фиксирует
  фактические screen, viewport, DPR и User-Agent.
- Конфиг `schemaVersion: 2` объявляет разрешённые действия, origin, scroll, target,
  `contextSelector`, предметные ожидания состояния, `capture.proof`, `primaryCaptureAfter`,
  `collapseEmptyAds` и правила готовности. Произвольный JavaScript в проектном JSON запрещён.
- Прогон сначала живёт в `.evidence-runs/`; `evidence/` меняется только после quality gate,
  просмотра contact sheet и явного `-Approve` с резервной копией предыдущих кадров. Частичный
  `-Approve` создаёт новую ревизию, сохраняет прежние кейсы и source run каждого PNG.

## Как поймать ошибку

Кадр не проходит gate, если: PNG не читается; image не совпадает с manifest; основные viewport-кадры
имеют разные dimensions или full-page кадры разную ширину; URL не из разрешённого origin; target либо
обязательный context отсутствует, обрезан или перекрыт;
document-кадр короче зафиксированного `cssContentSize`; два стабильных кадра существенно различаются;
внутренняя белая полоса превышает `max(160 px, 18% высоты viewport)`; применённое сворачивание не
записано в manifest; два Case ID получили точные дубликаты основных PNG. После gate обязателен
contact sheet всех Case ID с ручной проверкой смыслового соответствия кейсам.

## Источники

- [Playwright: Page.screenshot — `fullPage`, `clip`, animations, caret, scale и style](https://playwright.dev/docs/api/class-page#page-screenshot) — проверено 2026-08-03.
- [Playwright: screenshots](https://playwright.dev/docs/screenshots) — проверено 2026-08-03.
- [Playwright: visual comparisons и одинаковое окружение](https://playwright.dev/docs/test-snapshots) — проверено 2026-08-03.
- [Playwright: `connectOverCDP()` и ограниченная fidelity](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp) — проверено 2026-08-03.
- [Chrome DevTools Protocol: `Page.captureScreenshot` и `Page.getLayoutMetrics`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot) — проверено 2026-08-03.
- [Chrome DevTools Protocol: управление bounds окна](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-setWindowBounds) — проверено 2026-08-03.
- [Selenium: maximize, fullscreen и screenshot](https://www.selenium.dev/documentation/webdriver/interactions/windows/) — проверено 2026-08-03.
- [W3C WebDriver: screenshot снимает visual viewport](https://www.w3.org/TR/webdriver/#screen-capture) — проверено 2026-08-03.
- [Playwright issue #12962: `fullPage` не раскрывает внутренний scroll container](https://github.com/microsoft/playwright/issues/12962#issuecomment-1077256077) — ответ участника команды Playwright, проверено 2026-08-03.
- [Chrome/web.dev: browser-level image lazy loading](https://web.dev/articles/browser-level-image-lazy-loading) — проверено 2026-08-03.
- [Playwright: HAR replay и network mocking](https://playwright.dev/docs/mock#mocking-with-har-files) — проверено 2026-08-03.

## Связанное

- `docs/09-automation/ui-evidence-runner.md` — общий раннер доказательств
- `docs/09-automation/evidence-collection.md` — правила хранения и передачи доказательств
- `patterns/process/blocked-target-browser-config.md` — отдельный профиль для анти-бот защиты

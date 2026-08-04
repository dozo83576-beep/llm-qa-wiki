# tools/ui-evidence — сбор UI-доказательств одним прогоном

Единая точка входа для двух совместимых режимов:

- legacy UI-замеры hover/dropdown/readability — результат сразу в `evidence/`;
- `functional-screenshots` — пользовательские шаги и снимок всей видимой области сайта сначала в
  `.evidence-runs/<run-id>/`, затем ручное подтверждение в `evidence/`.

Документация: [docs/09-automation/ui-evidence-runner.md](../../docs/09-automation/ui-evidence-runner.md).

## Быстрый старт

```
pwsh tools/ui-evidence/Invoke-UiEvidence.ps1 -Check
cp tools/ui-evidence/config.example.json D:\Rabota\projects\<проект>\ui-cases.json
pwsh tools/ui-evidence/Invoke-UiEvidence.ps1 -Config D:\Rabota\projects\<проект>\ui-cases.json -ProjectRoot D:\Rabota\projects\<проект>
```

Полноэкранные функциональные снимки:

```
cp tools/ui-evidence/config.functional.example.json D:\Rabota\projects\<проект>\ui-cases.json
pwsh tools/ui-evidence/Invoke-UiEvidence.ps1 -Check -Config D:\Rabota\projects\<проект>\ui-cases.json -ProjectRoot D:\Rabota\projects\<проект>
pwsh tools/ui-evidence/Invoke-UiEvidence.ps1 -Config D:\Rabota\projects\<проект>\ui-cases.json -ProjectRoot D:\Rabota\projects\<проект>
pwsh tools/ui-evidence/Invoke-UiEvidence.ps1 -ProjectRoot D:\Rabota\projects\<проект> -Approve <run-id>
```

До `-Approve` действующий `evidence/` не изменяется. Сначала открой
`.evidence-runs/<run-id>/contact-sheet.png` и проверь каждый Case ID вместе с кадрами
`captureAfter`. Основной кадр должен показывать результат кейса; точные дубликаты основных PNG
блокируют прогон. Для переходов используй «до/после», а для невидимых свойств — `capture.proof` с
декларативной метрикой. `primaryCaptureAfter` позволяет назначить информативный промежуточный кадр
основным. `capture.contextSelector` проверяет, что в кадре осталась шапка или другой контекст
страницы; для внешнего popup унаследованное правило отключается значением `false`.

## Файлы

| Файл | Назначение |
|---|---|
| `Invoke-UiEvidence.ps1` | Точка входа: находит Node и playwright, подставляет `NODE_PATH`, запускает раннер |
| `collect.js` | Раннер: читает конфиг, выполняет проверки, пишет снимки и JSON |
| `functional-capture.js` | Функциональные шаги, viewport-снимки, manifest, contact sheet и staging |
| `functional-core.js` | Валидация schemaVersion 2, PNG, прогона и безопасное подтверждение |
| `lib-cursor.js` | Отрисовка указателя мыши и рамки на снимке: браузер курсор в скриншот не пишет |
| `lib-measure.js` | Замеры: вычисленные стили с псевдоэлементами, попиксельное сравнение, контраст по пикселям, геометрия |
| `pw-env.js` | Конфигурация браузера, сохраняемый профиль, навигация с повторами |
| `config.example.json` | Образец конфига со всеми типами проверок |
| `config.functional.example.json` | Образец полноэкранных функциональных сценариев |

## Требования

- Node.js в `PATH`.
- Модуль `playwright` — глобально (`npm i -g playwright`) либо тот, что приехал с `@playwright/mcp`.
- Браузер Chromium: `npx playwright install chromium`.

Optional accessibility check использует только локально закреплённый `axe-core 4.12.1`:
`npm ci --prefix tools/ui-evidence`. Раннер ничего не устанавливает; если `checks.accessibility`
включён, а dependency отсутствует, имеет другую версию либо SHA-256 `axe.min.js` не совпадает с
`axe-integrity.json`, прогон блокируется до запуска браузера.
Настройка поддерживает `tags`, boolean-`rules`, `include` и `exclude`, глобально и на уровне кейса.
После шагов создаётся `accessibility/<Case ID>.json`, а после approval —
`evidence/data/accessibility/<Case ID>.json`; manifest хранит version, применённые настройки,
counts и SHA-256. `violations` и `incomplete` не меняют QA verdict автоматически, а `incomplete`
всегда получает `manual_review_required: true`; автоматический результат не доказывает WCAG compliance.
Raw HTML не сохраняется, а selector/failure summary проходят redaction; человек всё равно проверяет
artifact на чувствительные данные перед передачей наружу.

Проверить всё сразу: `pwsh tools/ui-evidence/Invoke-UiEvidence.ps1 -Check`.

Для persistent-профиля, которому нужна ручная авторизация или проверка сайта:

```
pwsh tools/ui-evidence/Invoke-UiEvidence.ps1 -Config .\ui-cases.json -ProjectRoot . -PrepareProfile
```

Это не обход антибот-защиты: тестировщик выполняет разрешённый ручной шаг один раз, после чего
профиль используется повторно.

Для CDP-сессии `browser.isolateContext: true` создаёт отдельный контекст прогона и переносит в него
только cookies `baseUrl`. Это сохраняет ручную проверку тестируемого сайта, но не наследует сессии
Google и других внешних сервисов. В шагах с `captureAfter` можно задать `captureReady`,
`captureTarget`, `captureAnchor`, `captureProof`, `capturePage` и `captureAllowedOrigins`. Действие
`clickAt` воспроизводит касание свободной области координатами `x`, `y`. URL в manifest и сетевом журнале
автоматически очищаются от токенов, ПДн и значений query-параметров.

Ожидания `waitForText`, `waitForCount`, `waitForAttribute`, `waitForHidden` и соответствующие
assertions подтверждают состояние приложения после клика. Начальный URL и `goto` повторяются по
настройкам `navigation`. `diagnostics.trace="failures"` сохраняет trace только для заблокированных
кейсов. Частичный `-Approve` объединяет переснятые кейсы с предыдущей ревизией и сохраняет
`sourceRunId`; разные окружения молча не смешиваются.

Для незаполненных рекламных слотов можно задать `capture.collapseEmptyAds`: раннер сворачивает
только проверенный пустой контейнер и записывает изменение в manifest. В CDP-режиме
`browser.cookieBlocklist` исключает перечисленные cookies при создании изолированного контекста.

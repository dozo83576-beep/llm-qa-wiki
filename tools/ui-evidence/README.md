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
`captureAfter`.

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
`captureTarget`, `capturePage` и `captureAllowedOrigins`. URL в manifest и сетевом журнале
автоматически очищаются от токенов, ПДн и значений query-параметров.

Для незаполненных рекламных слотов можно задать `capture.collapseEmptyAds`: раннер сворачивает
только проверенный пустой контейнер и записывает изменение в manifest. В CDP-режиме
`browser.cookieBlocklist` исключает перечисленные cookies при создании изолированного контекста.

# tools/ui-evidence — сбор UI-доказательств одним прогоном

Раннер, который снимает доказательства по всем UI-кейсам заказа за **одну навигацию** и кладёт
результат в `evidence/` и `evidence/data/ui-evidence.json`.

Документация: [docs/09-automation/ui-evidence-runner.md](../../docs/09-automation/ui-evidence-runner.md).

## Быстрый старт

```
pwsh tools/ui-evidence/Invoke-UiEvidence.ps1 -Check
cp tools/ui-evidence/config.example.json D:\Rabota\projects\<проект>\ui-cases.json
pwsh tools/ui-evidence/Invoke-UiEvidence.ps1 -Config D:\Rabota\projects\<проект>\ui-cases.json -ProjectRoot D:\Rabota\projects\<проект>
```

## Файлы

| Файл | Назначение |
|---|---|
| `Invoke-UiEvidence.ps1` | Точка входа: находит Node и playwright, подставляет `NODE_PATH`, запускает раннер |
| `collect.js` | Раннер: читает конфиг, выполняет проверки, пишет снимки и JSON |
| `lib-cursor.js` | Отрисовка указателя мыши и рамки на снимке: браузер курсор в скриншот не пишет |
| `lib-measure.js` | Замеры: вычисленные стили с псевдоэлементами, попиксельное сравнение, контраст по пикселям, геометрия |
| `pw-env.js` | Конфигурация браузера, сохраняемый профиль, навигация с повторами |
| `config.example.json` | Образец конфига со всеми типами проверок |

## Требования

- Node.js в `PATH`.
- Модуль `playwright` — глобально (`npm i -g playwright`) либо тот, что приехал с `@playwright/mcp`.
- Браузер Chromium: `npx playwright install chromium`.

Проверить всё сразу: `pwsh tools/ui-evidence/Invoke-UiEvidence.ps1 -Check`.

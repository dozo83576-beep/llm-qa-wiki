---
title: "Безопасный QA toolkit"
category: "automation"
updated: "2026-08-03"
status: "active"
tags: ["tooling", "evidence", "security", "cross-runtime"]
source_priority: "mixed"
---

# Безопасный QA toolkit

QA toolkit даёт единый локальный интерфейс к OSS-инструментам, но не превращает их вывод в дефект
или релизный вердикт. Он сохраняет нормализованный сигнал и доказательства отдельно от семи фаз,
`_qa-report.json` и XLSX; решение после проверки принимает тестировщик.

## Когда использовать

- Нужно повторяемо собрать accessibility, API-contract, mobile, security, performance или secret
  scanning сигналы в `evidence/data/tool-runs/`.
- В проекте уже закреплена совместимая версия инструмента и доступен требуемый runtime.
- Для сетевой проверки владелец дал точный scope, origin и временное окно.
- Требуется одинаковый CLI-маршрут в Codex, Claude Code и обычном PowerShell 7.

## Когда не использовать

- Нет письменного разрешения на scanner, proxy/record или потенциально изменяющие API-методы.
- Нужна ручная оценка UX, keyboard navigation, screen reader либо реальная field performance.
- Инструмент требует установки Docker, Java, Android SDK, Xcode или другого системного компонента.
- Артефакт содержит реальные персональные данные, договоры, credentials или коммерческую тайну.

## Как это делается

1. Выберите профиль в `resources/qa-tool-catalog.yaml`. Для каждого профиля закреплена точная
   проверенная версия; неизвестная либо отличающаяся runtime-версия блокирует preflight и execution.
2. Подготовьте JSON внутри `ProjectRoot`; используйте только вымышленные тестовые данные. Начните с
   `-Preflight`, чтобы safety gates сработали до scan/test process.
3. Для ZAP, unsafe Schemathesis или WireMock proxy/record добавьте authorization JSON с точным
   `allowed_origins`, `allowed_operations`, `not_before` и `expires` с timezone.
4. Запустите `tools/qa-toolkit/Invoke-QaTool.ps1`. Неизвестный профиль, выход пути за корень,
   отсутствующий prerequisite и запрещённый режим дают детерминированный `blocked`.
5. Проверьте `result.json`, исходный артефакт и SHA-256. Переносите подтверждённый факт в обычный
   маршрут вручную; toolkit никогда не меняет отчёт.

| Профиль | Safety boundary |
|---|---|
| `axe-core` | Автоматические правила — только часть accessibility review |
| `schemathesis` | Unsafe/stateful всегда требует разрешение; test environment — только метка |
| `oasdiff` | Только project-local specs, remote `$ref` запрещён |
| `appium`, `maestro` | OS SDK не устанавливается; iOS/Windows блокируется |
| `pact` | Fixed local-pact verifier; broker/publish запрещены; remote provider требует authorization |
| `appium`, `wiremock` | Bounded loopback smoke; server/session закрывается в `finally` |
| `testcontainers` | Fixed digest-pinned Alpine smoke; cleanup выполняется в `finally` |
| `zap-baseline` | Только spider/passive, active и AJAX spider запрещены |
| `lighthouse-ci` | Минимум три запуска; это lab data |
| `gitleaks` | Только delivery directory, `--no-git`, без истории |

Paid products (Applitools, BrowserStack, Sauce Labs и vendor skills) представлены только как
переносимые паттерны. Runtime не подключает SaaS, не создаёт account и не загружает артефакты.

## Частые ошибки

- Считать `clean` доказательством отсутствия дефектов. Это означает лишь отсутствие
  нормализованных findings в конкретном ограниченном прогоне.
- Передавать authorization без timezone или с более широким origin, чем фактический target.
- Запускать Gitleaks от корня репозитория вместо каталога поставки и затем публиковать сырой SARIF.
- Сравнивать один Lighthouse run с production RUM и игнорировать вариативность lab environment.
- Использовать `InstallLocal` как package manager. Он допускает лишь allowlisted standalone binary
  с заранее известным SHA-256 и не распаковывает архивы.

## Проверка

- `result.json` соответствует schema contract: статус из четырёх значений, tool/version/target,
  timestamps, limitations, artifacts и hashes; `signals_only` равен `true`.
- Все artifact paths находятся внутри `ProjectRoot`, каждый существующий файл имеет SHA-256.
- Unit tests подтверждают нормализацию JUnit/SARIF/JSON, redaction, path traversal и gates до
  запуска процесса; они не обращаются к интернету.
- `python -m unittest discover -s tools/qa-toolkit/tests -p "test_*.py"` и
  `pwsh tools/wiki-audit.ps1` завершаются успешно.

## Источники

- [Каталог профилей](../../resources/qa-tool-catalog.yaml) — official upstream, лицензия,
  version policy, ограничения и дата проверки каждого инструмента.
- [OWASP ZAP Baseline Scan](https://www.zaproxy.org/docs/docker/baseline-scan/) — passive baseline
  workflow (проверено 2026-08-03).
- [Schemathesis](https://github.com/schemathesis/schemathesis) — официальный репозиторий
  property-based API testing (проверено 2026-08-03).
- [Gitleaks](https://github.com/gitleaks/gitleaks) — официальный репозиторий secret scanner
  (проверено 2026-08-03).
- [Lighthouse CI](https://github.com/GoogleChrome/lighthouse-ci) — официальный репозиторий lab
  automation (проверено 2026-08-03).

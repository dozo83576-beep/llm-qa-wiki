# QA toolkit

Локальный кросс-рантайм адаптер для ограниченных профилей QA-инструментов. Он не заменяет
семифазный маршрут, не меняет `_qa-report.json` или XLSX и не принимает решение о качестве:
`result.json` содержит только сигналы для проверки тестировщиком.

## Требования

- PowerShell 7 и Python 3 со стандартной библиотекой.
- Инструмент уже доступен в `PATH` или как проверенный локальный файл в `.qa-tools/<id>/bin/`.
- Все пути из конфигурации находятся внутри `ProjectRoot`.
- Для сетевых операций повышенного риска — действующее authorization JSON владельца системы.

Toolkit не устанавливает Docker, Java, Node.js, Android SDK, Xcode, браузеры, драйверы или системные
пакеты. Он не создаёт SaaS-аккаунты и не передаёт данные внешним поставщикам.

## Интерфейс

```powershell
pwsh tools/qa-toolkit/Invoke-QaTool.ps1 `
  -Tool lighthouse-ci `
  -Config '{"target":"https://example.invalid/health","runs":3,"budget_file":"budget.json"}' `
  -ProjectRoot D:\Rabota\projects\example `
  -Preflight
```

`-Config` принимает inline JSON object либо путь к JSON внутри проекта. `-Authorization` также
принимает inline JSON либо путь внутри проекта. Сначала используйте `-Preflight`: он проверяет
конфигурацию и safety gates, находит prerequisite и читает версию, но не запускает проверку.
Неизвестная или отличающаяся от точного pin в каталоге версия получает `blocked`.
Файловые config, authorization и budget сначала копируются внутрь `ProjectRoot`.

Точный публичный контракт параметров:

```text
Invoke-QaTool.ps1 -Tool <id> -Config <json> -ProjectRoot <path>
                  [-Preflight] [-InstallLocal] [-Authorization <path>]
```

## Результат

Каждый вызов создаёт новый каталог:

```text
<ProjectRoot>/evidence/data/tool-runs/<run-id>/result.json
```

Статусы: `clean`, `findings`, `blocked`, `error`. Артефакты остаются внутри каталога прогона,
получают SHA-256 и по возможности нормализуются из JUnit XML, SARIF или profile JSON. Токены,
cookies, ключи, пароли, email, телефоны и чувствительные query-параметры редактируются. Исходный
отчёт инструмента может содержать данные, которые не распознал общий фильтр; до передачи наружу
его всё равно проверяет человек.

## Safety gates

- `zap-baseline`: existing Docker запускает только `zaproxy/zap-stable:2.17.0` с обязательным
  digest и `--pull=never`; traditional spider/passive scan требуют authorization, active/AJAX
  scan отклоняются.
- `schemathesis`: `POST`, `PUT`, `PATCH`, `DELETE` и stateful всегда требуют authorization с
  операцией `schemathesis-unsafe`; признак test environment не заменяет разрешение.
- `oasdiff`: оба документа локальные; remote `$ref` отклоняется.
- `pact`: только project-local pact JSON и явный provider URL; broker/publish отключены, а
  non-loopback provider требует test environment и authorization.
- `appium`: создаёт и удаляет одну W3C session через сервер только на loopback; сервер всегда
  завершается в `finally`; iOS на Windows получает `blocked`.
- `wiremock`: bounded serve/probe на loopback с local mappings; сервер завершается в `finally`,
  proxy/record требует authorization.
- `testcontainers`: фиксированный Alpine smoke с image digest и `--pull=never`; cleanup
  `docker rm -f` всегда запускается в `finally`. `dependency_lock` подтверждает точный pin
  `testcontainers-java`, версия Docker записывается отдельно.
- `maestro`: iOS на Windows получает `blocked`.
- `gitleaks`: только явно заданный delivery directory с `--no-git`, без истории Git.
- `lighthouse-ci`: не менее трёх lab-прогонов; результат не равен field data.

Authorization проверяет точное совпадение origin, разрешённую операцию и активное временное окно.
Пример в `authorization.example.json` содержит только вымышленный домен и не является разрешением.

## InstallLocal

Установка по умолчанию блокируется. Для разрешённых standalone-профилей (`oasdiff`, `gitleaks`)
нужны `download_url`, простое `download_filename` и ожидаемый `expected_sha256`. Разрешены только
официальные HTTPS-хосты, редирект повторно проверяется, размер ограничен 256 MiB, а файл становится
доступен только после совпадения SHA-256. Архивы не распаковываются, package manager и глобальная
установка не вызываются.

## Самопроверка

```powershell
python -m unittest discover -s tools/qa-toolkit/tests -p "test_*.py"
```

Тесты используют только локальные fixtures и подмены executable; интернет и внешние scan target
не задействуются.

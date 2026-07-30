---
title: "LLM QA Wiki"
category: "start"
updated: "2026-07-30"
status: "active"
tags: ["qa", "testing", "wiki", "skills"]
source_priority: "internal"
---

# LLM QA Wiki

Практическая база знаний по QA-тестированию и система скиллов поверх неё. Работает одинаково в
Claude Code и Codex.

Предмет — то, что реально приходит в заказах: веб-приложения и мобильные приложения. Конечный продукт
заказчика — XLSX-отчёт формата Test Management, собираемый и проверяемый автоматически.

## Как пользоваться

1. Новый заказ — начните с [обзора](docs/00-start-here/overview.md) и выберите
   [playbook](docs/13-playbooks/index.md) под тип объекта.
2. Не помните, где нужное — спросите вики:
   `pwsh tools/ask-wiki.ps1 "граничные значения форма регистрации"`.
3. Проверки берите из [чек-листов](checklists/), кейсы стройте
   [техниками тест-дизайна](docs/03-test-design/index.md).
4. Оценивайте дефекты по [таксономии](bug-taxonomy/index.md).
5. Отчёт собирайте по [спецификации](docs/14-templates/xlsx-test-management.md) и обязательно
   прогоняйте валидатор.
6. После заказа — [зафиксируйте опыт](docs/15-maintenance/update-process.md).

## Система скиллов

Семь фаз от приёма объекта до фиксации опыта, каждая со своим артефактом:
`qa-intake` → `qa-plan` → `qa-design` → `qa-execute` → `qa-defects` → `qa-report` → `qa-capture`.
Оркестратор — `run-qa-project`. Подробнее: [система скиллов](docs/00-start-here/skill-system.md).

Канон скиллов — `agent-skills/`. Раскатка в оба рантайма:

```
pwsh agent-skills/sync-skills.ps1 -DryRun
pwsh agent-skills/sync-skills.ps1
```

## Отчёт

Сборка из JSON и независимая проверка готового файла:

```
python tools/build-qa-report.py --input _qa-report.json --out outputs/QA_Проект_2026-07-30.xlsx
python tools/verify-qa-report.py outputs/QA_Проект_2026-07-30.xlsx --expect-pass 10 --expect-fail 5
```

Валидатор читает XLSX, а не исходный JSON, поэтому ловит ошибки самого генератора. Его собственная
способность падать проверяется негативными тестами:

```
python tools/test-qa-report.py
```

## Локальные проверки

```
pwsh tools/ci-local.ps1
```

Гейт: структура и frontmatter, контракт пайплайна, самотест генератора отчёта, паритет скиллов,
качество текстов, идемпотентность генерируемых файлов, offline-проверка поиска.

## Принципы

- Документы короткие, проверяемые, связаны внутренними ссылками.
- Каждое внешнее утверждение — со ссылкой и датой проверки. Чужие материалы целиком не копируются.
- Любой повторяемый успех становится паттерном, любая существенная ошибка — уроком и пунктом
  чек-листа.
- Проверка, которая не умеет провалиться, не умеет и подтвердить успех.
- Персональные данные, реквизиты заказчиков и учётные данные в вики не попадают.

## Источники

Внешние опоры корпуса: [ISTQB Glossary](https://glossary.istqb.org/),
[ISO/IEC/IEEE 29119](https://www.iso.org/standard/79429.html),
[WCAG 2.2](https://www.w3.org/TR/WCAG22/),
[OWASP WSTG](https://owasp.org/www-project-web-security-testing-guide/),
[Playwright](https://playwright.dev/docs/intro).

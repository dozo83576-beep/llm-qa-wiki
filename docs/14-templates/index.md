---
title: "Шаблоны"
category: "template"
updated: "2026-07-30"
status: "active"
tags: ["templates", "index", "artifacts"]
source_priority: "internal"
---

# Шаблоны

Заготовки артефактов и спецификация формата поставки.

- [Спецификация XLSX Test Management](xlsx-test-management.md) — формат конечного документа.
- [Схема `_qa-report.json`](report-json-schema.md) — вход генератора отчёта.
- [Шаблон тест-кейса](test-case-template.md)
- [Шаблон баг-репорта](bug-report-template.md)
- [Шаблон тест-плана](test-plan-template.md)

## Что чем заполняется

| Фаза | Артефакт | Шаблон |
|---|---|---|
| `qa-plan` | `_qa-plan.md` | [тест-план](test-plan-template.md) |
| `qa-design` | `_qa-cases.md` | [тест-кейс](test-case-template.md) |
| `qa-defects` | `_qa-defects.md` | [баг-репорт](bug-report-template.md) |
| `qa-report` | `_qa-report.json` | [схема](report-json-schema.md) |

## Правило

Шаблон — отправная точка, а не форма для механического заполнения. Раздел, не относящийся к заказу,
удаляется, а не заполняется словом «не применимо». Раздел, которого не хватает, добавляется.

Единственное исключение — [формат XLSX](xlsx-test-management.md): он согласован с заказчиком и
проверяется валидатором посимвольно.

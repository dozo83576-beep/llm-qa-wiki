"""
verify-qa-report — независимая проверка собранного XLSX-отчёта.

Читает готовый файл, а не исходный JSON: иначе проверка повторяла бы логику
генератора и не поймала бы его собственную ошибку. Инварианты перенесены из
валидатора, написанного под первый реальный отчёт этого формата.

Использование:
    python tools/verify-qa-report.py QA_Проект_2026-07-30.xlsx
    python tools/verify-qa-report.py отчёт.xlsx --expect-pass 10 --expect-fail 5
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

try:
    import openpyxl
except ImportError:
    print("Не установлен openpyxl: pip install openpyxl", file=sys.stderr)
    raise SystemExit(2)

EXPECTED_SHEETS = ["Data", "Test Cases", "Test Run", "Bug Reports"]

EXPECTED_CASE_HEADERS = [
    "Case ID\n(Номер кейса)",
    "Title\n(Название кейса)",
    "Preconditions\n(Предусловия)",
    "Steps\n(Шаги)",
    "Expected Result\n(Ожидаемый результат)",
    "Postconditions\n(Постусловия)",
    "Priority\n(Приоритет)",
]

EXPECTED_RUN_HEADERS = [
    "Session ID\n(Номер сессии)",
    "Date\n(Время)",
    "Session Name\n(Имя сессии)",
    "Tester\n(Тестировщик)",
    "Case ID\n(Номер кейса)",
    "Result\n(Результат)",
    "Comment\n(Комментарий)",
    "Bug ID\n(Номер бага)",
]

EXPECTED_BUG_HEADERS = [
    "Bug ID\n(Номер бага)",
    "Title\n(Название бага)",
    "Related Case ID\n(Связанные кейсы)",
    "Session ID\n(Номер сессии)",
    "Preconditions\n(Предусловия)",
    "Error Step\n(Шаг с ошибкой)",
    "Expected Result\n(Ожидаемый результат)",
    "Actual Result\n(Фактический результат)",
    "Severity\n(Серьёзность)",
    "Priority\n(Приоритет)",
    "Environment\n(Окружение)",
    "Attachments/Links\n(Скриншоты/Ссылки)",
    "Date Reported\n(Дата обнаружения)",
]

FORMULA_ERROR_RE = re.compile(r"#REF!|#DIV/0!|#VALUE!|#NAME\?|#N/A|#NULL!|#NUM!")

RESULT_VALUES = {"Pass", "Fail", "Blocked", "N/A"}
SEVERITY_VALUES = {"Critical", "Major", "Minor", "Trivial"}
PRIORITY_VALUES = {"High", "Medium", "Low"}


def text(value) -> str:
    return str(value).strip() if value is not None else ""


def column(ws, col: int, first_row: int = 2) -> list[str]:
    return [text(ws.cell(row=r, column=col).value) for r in range(first_row, ws.max_row + 1)]


def check_headers(ws, expected: list[str], failures: list[str]) -> None:
    for index, want in enumerate(expected, start=1):
        got = text(ws.cell(row=1, column=index).value)
        if got != want:
            failures.append(
                f"Лист «{ws.title}», колонка {index}: шапка «{got}», ожидается «{want}»."
            )


def check_formula_errors(wb, failures: list[str]) -> None:
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if cell.value is None:
                    continue
                if FORMULA_ERROR_RE.search(str(cell.value)):
                    failures.append(f"Ошибка формулы в «{ws.title}»!{cell.coordinate}: {cell.value}")


def verify(path: Path, expect_pass: int | None, expect_fail: int | None) -> list[str]:
    failures: list[str] = []
    wb = openpyxl.load_workbook(path)

    if wb.sheetnames != EXPECTED_SHEETS:
        failures.append(
            f"Неверный состав или порядок листов: {wb.sheetnames}, ожидается {EXPECTED_SHEETS}."
        )
        return failures

    if wb["Data"].sheet_state != "hidden":
        failures.append("Лист «Data» должен быть скрытым — он служебный справочник.")

    cases_ws = wb["Test Cases"]
    run_ws = wb["Test Run"]
    bugs_ws = wb["Bug Reports"]

    check_headers(cases_ws, EXPECTED_CASE_HEADERS, failures)
    check_headers(run_ws, EXPECTED_RUN_HEADERS, failures)
    check_headers(bugs_ws, EXPECTED_BUG_HEADERS, failures)

    # --- тест-кейсы: сплошная нумерация с TC-001
    case_ids = [value for value in column(cases_ws, 1) if value]
    if not case_ids:
        failures.append("На листе «Test Cases» нет ни одного кейса.")
        return failures

    for index, case_id in enumerate(case_ids, start=1):
        expected_id = f"TC-{index:03d}"
        if case_id != expected_id:
            failures.append(
                f"Нарушена сплошная нумерация кейсов: строка {index + 1} содержит «{case_id}», ожидается «{expected_id}»."
            )

    for index in range(2, len(case_ids) + 2):
        priority = text(cases_ws.cell(row=index, column=7).value)
        if priority not in PRIORITY_VALUES:
            failures.append(f"Кейс в строке {index}: недопустимый Priority «{priority}».")
        expected_result = text(cases_ws.cell(row=index, column=5).value)
        if not expected_result:
            failures.append(f"Кейс в строке {index}: пустой Expected Result — проверить нечего.")

    # --- прогон: покрывает все кейсы в том же порядке
    run_case_ids = [value for value in column(run_ws, 5) if value]
    if run_case_ids != case_ids:
        failures.append(
            f"Test Run не покрывает все кейсы по порядку: в прогоне {len(run_case_ids)} строк, "
            f"в кейсах {len(case_ids)}; первое расхождение — "
            f"{next((f'ожидался {a}, найден {b}' for a, b in zip(case_ids, run_case_ids) if a != b), 'состав совпал, различается длина')}."
        )

    # --- дефекты: собираем объявленные Bug ID
    declared_bugs: list[str] = []
    for index in range(2, bugs_ws.max_row + 1):
        bug_id = text(bugs_ws.cell(row=index, column=1).value)
        if bug_id:
            declared_bugs.append(bug_id)
        severity = text(bugs_ws.cell(row=index, column=9).value)
        priority = text(bugs_ws.cell(row=index, column=10).value)
        actual = text(bugs_ws.cell(row=index, column=8).value)
        if not severity and not priority and not actual:
            continue  # пустая строка-хвост
        if severity not in SEVERITY_VALUES:
            failures.append(f"Дефект в строке {index}: недопустимый Severity «{severity}».")
        if priority not in PRIORITY_VALUES:
            failures.append(f"Дефект в строке {index}: недопустимый Priority «{priority}».")
        if not actual:
            failures.append(f"Дефект в строке {index}: пустой Actual Result.")

    bug_set = set(declared_bugs)
    if len(bug_set) != len(declared_bugs):
        failures.append("На листе «Bug Reports» встречаются повторяющиеся Bug ID.")

    # --- трассируемость результата и дефекта
    passed = 0
    failed = 0
    referenced_bugs: set[str] = set()
    for index in range(2, run_ws.max_row + 1):
        case_id = text(run_ws.cell(row=index, column=5).value)
        if not case_id:
            continue
        result = text(run_ws.cell(row=index, column=6).value)
        bug = text(run_ws.cell(row=index, column=8).value)

        if result not in RESULT_VALUES:
            failures.append(f"Строка прогона {case_id}: недопустимый Result «{result}».")
            continue

        if result == "Pass":
            passed += 1
            if bug:
                failures.append(f"Pass ошибочно связан с багом: {case_id} -> «{bug}».")
        elif result == "Fail":
            failed += 1
            if not bug:
                failures.append(f"Fail без корректного Bug ID: {case_id}.")
            elif bug not in bug_set:
                failures.append(f"Fail без корректного Bug ID: {case_id} ссылается на несуществующий «{bug}».")
            else:
                referenced_bugs.add(bug)

    orphan_bugs = bug_set - referenced_bugs
    if orphan_bugs:
        failures.append(
            f"Дефекты не связаны ни с одним Fail: {', '.join(sorted(orphan_bugs))}."
        )

    if expect_pass is not None and passed != expect_pass:
        failures.append(f"Итог Pass={passed}, ожидается {expect_pass}.")
    if expect_fail is not None and failed != expect_fail:
        failures.append(f"Итог Fail={failed}, ожидается {expect_fail}.")

    check_formula_errors(wb, failures)
    return failures


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Проверить собранный XLSX-отчёт Test Management.")
    parser.add_argument("report", help="Путь к .xlsx")
    parser.add_argument("--expect-pass", type=int, default=None)
    parser.add_argument("--expect-fail", type=int, default=None)
    args = parser.parse_args(argv)

    path = Path(args.report)
    if not path.exists():
        print(f"Не найден файл отчёта: {path}", file=sys.stderr)
        return 2

    failures = verify(path, args.expect_pass, args.expect_fail)

    print(f"Проверка отчёта: {path}")
    if failures:
        print(f"Нарушений: {len(failures)}")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print("Нарушений: 0")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

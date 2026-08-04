"""Сборка архива для заказчика.

Что кладётся в архив:
  - книга отчёта XLSX;
  - каталог `Скриншоты/` — только PNG-кадры доказательств.

Что НЕ кладётся:
  - `ОТЧЁТ.md` — его текст идёт заказчику отдельным сообщением, в поле «Ответ на отчёт»;
  - журналы прогона и замеры (`*.json`), служебные заметки, сами скрипты: их читает команда,
    их место в артефактах фаз.

Каталог назван по-русски: заказчик открывает архив и должен понимать, что внутри, без словаря.

Имя каждого кадра начинается с Case ID (`TC-001.png`) — то же правило, по которому заполняется
колонка `Attachments/Links`, поэтому файл в архиве ищется по имени из книги напрямую.

Запуск:
    python tools/pack-delivery.py --project D:\\Rabota\\projects\\<проект>
    python tools/pack-delivery.py --project . --out outputs/QA_Проект_2026-08-01.zip
"""
from __future__ import annotations

import argparse
import pathlib
import sys
import zipfile

from evidence_manifest import validate_approved_manifest

SHOTS_DIR = "Скриншоты"


class PackError(Exception):
    pass


def find_one(directory: pathlib.Path, pattern: str, what: str) -> pathlib.Path:
    found = sorted(directory.glob(pattern))
    if not found:
        raise PackError(f"{what} не найден: {directory / pattern}")
    if len(found) > 1:
        names = ", ".join(p.name for p in found)
        raise PackError(f"{what} найден в нескольких экземплярах ({names}). Укажи нужный явно.")
    return found[0]


def pack(project: pathlib.Path, out: pathlib.Path | None = None) -> pathlib.Path:
    outputs = project / "outputs"
    evidence = project / "evidence"
    if not outputs.is_dir():
        raise PackError(f"Каталог поставки не найден: {outputs}")
    if not evidence.is_dir():
        raise PackError(f"Каталог доказательств не найден: {evidence}")

    manifest_failures = validate_approved_manifest(evidence)
    if manifest_failures:
        raise PackError("Проверка manifest скриншотов не пройдена:\n- " + "\n- ".join(manifest_failures))

    book = find_one(outputs, "QA_*.xlsx", "Книга отчёта")
    # ОТЧЁТ.md обязан существовать — его сверяет валидатор ключом --summary, — но в архив не идёт:
    # заказчик получает его текст отдельным сообщением.
    summary = outputs / "ОТЧЁТ.md"
    if not summary.is_file():
        raise PackError(f"Сопроводительный отчёт не найден: {summary}. "
                        "В архив он не кладётся, но собран быть обязан.")

    shots = sorted(p for p in evidence.rglob("*") if p.is_file() and p.suffix.lower() == ".png")
    if not shots:
        raise PackError(f"В {evidence} нет ни одного PNG: архив без скриншотов заказчику не нужен.")

    target = out or outputs / (book.stem + ".zip")
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(book, book.name)
        for shot in shots:
            archive.write(shot, f"{SHOTS_DIR}/{shot.name}")

    skipped = sorted(p.name for p in evidence.rglob("*") if p.is_file() and p.suffix.lower() != ".png")
    print(f"Собран {target}")
    print(f"Книга: {book.name} | скриншотов: {len(shots)} | размер: {target.stat().st_size / 1048576:.2f} МБ")
    if skipped:
        print(f"Не вошли в архив (не скриншоты): {', '.join(skipped)}")
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description="Сборка архива поставки заказчику.")
    parser.add_argument("--project", default=".", help="Каталог проекта с outputs/ и evidence/")
    parser.add_argument("--out", default=None, help="Путь к архиву. По умолчанию outputs/<имя книги>.zip")
    args = parser.parse_args()
    try:
        pack(pathlib.Path(args.project).resolve(),
             pathlib.Path(args.out).resolve() if args.out else None)
    except PackError as error:
        print(f"Ошибка: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Проверка одобренного manifest функциональных скриншотов."""
from __future__ import annotations

import hashlib
import json
import pathlib


MANIFEST_RELATIVE = pathlib.Path("data") / "screenshot-run.json"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def png_dimensions(path: pathlib.Path) -> tuple[int, int]:
    header = path.read_bytes()[:24]
    if len(header) < 24 or header[:8] != PNG_SIGNATURE or header[12:16] != b"IHDR":
        raise ValueError("файл не является PNG с заголовком IHDR")
    width = int.from_bytes(header[16:20], "big")
    height = int.from_bytes(header[20:24], "big")
    if width <= 0 or height <= 0:
        raise ValueError("PNG содержит нулевой размер")
    return width, height


def validate_approved_manifest(evidence: pathlib.Path) -> list[str]:
    """Legacy-каталог без manifest допустим; существующий manifest проверяется строго."""
    failures: list[str] = []
    manifest_path = evidence / MANIFEST_RELATIVE
    if not manifest_path.is_file():
        return failures
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        return [f"Manifest скриншотов не читается: {manifest_path}: {error}"]

    if manifest.get("runner") != "functional-screenshots":
        failures.append("Manifest скриншотов имеет неизвестный runner.")
        return failures
    if manifest.get("approval", {}).get("status") != "approved":
        failures.append("Прогон functional-screenshots не одобрен: выполни -Approve после просмотра contact sheet.")
        return failures

    cases = manifest.get("cases")
    if not isinstance(cases, list) or not cases:
        return ["Одобренный manifest скриншотов не содержит cases."]
    seen: set[str] = set()
    for case in cases:
        case_id = str(case.get("id", ""))
        if not case_id:
            failures.append("В manifest найден кейс без Case ID.")
            continue
        if case_id in seen:
            failures.append(f"Case ID {case_id} повторяется в manifest.")
        seen.add(case_id)
        if case.get("status") != "captured":
            failures.append(f"{case_id}: в одобренном manifest нет готового снимка.")
            continue
        references = [case.get("file"), *(case.get("extraFiles") or [])]
        for index, reference in enumerate(references):
            if not isinstance(reference, str) or pathlib.Path(reference).name != reference:
                failures.append(f"{case_id}: manifest содержит небезопасный путь «{reference}».")
                continue
            screenshot = evidence / reference
            if not screenshot.is_file():
                failures.append(f"{case_id}: одобренный снимок не найден: {screenshot}.")
                continue
            try:
                width, height = png_dimensions(screenshot)
            except (OSError, ValueError) as error:
                failures.append(f"{case_id}: {screenshot.name}: {error}.")
                continue
            if index == 0:
                viewport = case.get("viewport") or {}
                if viewport.get("width") != width or viewport.get("height") != height:
                    failures.append(f"{case_id}: размер {screenshot.name} не совпадает с viewport в manifest.")
                expected_hash = case.get("sha256")
                actual_hash = hashlib.sha256(screenshot.read_bytes()).hexdigest()
                if expected_hash != actual_hash:
                    failures.append(f"{case_id}: SHA-256 файла {screenshot.name} не совпадает с manifest.")
    return failures

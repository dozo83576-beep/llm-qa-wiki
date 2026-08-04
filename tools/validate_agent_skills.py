#!/usr/bin/env python3
"""Deterministic local validator for the tracked Agent Skills subset."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
MARKER_RE = re.compile(r"\b(?:TODO|TBD|FIXME)\b", re.IGNORECASE)
REFERENCE_RE = re.compile(r"`((?:docs|resources|prompts|checklists|bug-taxonomy|patterns|tools)[\\/][^`\s]+)`")
MANDATORY_RUNTIME_RE = re.compile(r"(?:обязател|требует|\bmust\b|\brequired\b).*(?:MCP|Codex|Claude|ChatGPT)", re.IGNORECASE)
NEGATED_RUNTIME_RE = re.compile(r"(?:не опирается|не является обязатель|не зависит|not required|does not depend)", re.IGNORECASE)


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError("SKILL.md должен начинаться с YAML frontmatter")
    try:
        end = next(index for index in range(1, len(lines)) if lines[index].strip() == "---")
    except StopIteration as exc:
        raise ValueError("frontmatter не закрыт строкой ---") from exc
    raw = lines[1:end]
    keys: list[str] = []
    values: dict[str, str] = {}
    current: str | None = None
    for line in raw:
        match = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$", line)
        if match:
            current = match.group(1)
            keys.append(current)
            values[current] = (match.group(2) or "").strip().strip('"\'')
        elif current and (line.startswith(" ") or line.startswith("\t")):
            piece = line.strip()
            if piece and piece not in {">", ">-", "|", "|-"}:
                values[current] = f"{values[current]} {piece}".strip()
        elif line.strip():
            raise ValueError(f"некорректная строка frontmatter: {line}")
    if len(keys) != len(set(keys)):
        raise ValueError("frontmatter содержит повторяющиеся ключи")
    if set(keys) != {"name", "description"}:
        raise ValueError("frontmatter должен содержать только name и description")
    return values, "\n".join(lines[end + 1 :])


def parse_openai_yaml(path: Path, skill_name: str) -> list[str]:
    errors: list[str] = []
    if not path.is_file():
        return ["agents/openai.yaml отсутствует"]
    text = path.read_text(encoding="utf-8")
    if MARKER_RE.search(text):
        errors.append("agents/openai.yaml содержит незавершённый marker")
    top_keys = [match.group(1) for line in text.splitlines() if (match := re.match(r"^([A-Za-z_][\w-]*):\s*$", line))]
    if not top_keys or top_keys[0] != "interface" or set(top_keys) - {"interface", "policy"}:
        errors.append("openai.yaml допускает только top-level interface и optional policy")
    sections: dict[str, dict[str, str]] = {"interface": {}, "policy": {}}
    current: str | None = None
    for line in text.splitlines():
        top = re.match(r"^([A-Za-z_][\w-]*):\s*$", line)
        if top:
            current = top.group(1)
            continue
        nested = re.match(r"^  ([A-Za-z_][\w-]*):\s*(.*?)\s*$", line)
        if nested and current in sections:
            key, value = nested.groups()
            if key in sections[current]:
                errors.append(f"{current}.{key} повторяется")
            sections[current][key] = value
    allowed_interface = {"display_name", "short_description", "default_prompt"}
    if set(sections["interface"]) - allowed_interface:
        errors.append("interface содержит неподдерживаемые поля")
    if set(sections["policy"]) - {"allow_implicit_invocation"}:
        errors.append("policy содержит неподдерживаемые поля")
    fields: dict[str, str] = {}
    for key in allowed_interface:
        raw = sections["interface"].get(key, "")
        match = re.fullmatch(r'"([^"\r\n]+)"', raw)
        if match:
            fields[key] = match.group(1)
    for key in ("display_name", "short_description", "default_prompt"):
        if not fields.get(key):
            errors.append(f"interface.{key} отсутствует или не является quoted string")
    short = fields.get("short_description", "")
    if short and not 25 <= len(short) <= 64:
        errors.append("interface.short_description должен иметь длину 25-64 символа")
    prompt = fields.get("default_prompt", "")
    if prompt and f"${skill_name}" not in prompt:
        errors.append(f"interface.default_prompt должен вызывать ${skill_name}")
    policy_value = sections["policy"].get("allow_implicit_invocation")
    if policy_value is not None and policy_value not in {"false", "true"}:
        errors.append("policy.allow_implicit_invocation должен быть boolean")
    return errors


def validate_skill(skill_dir: Path, repo_root: Path) -> list[str]:
    errors: list[str] = []
    skill_file = skill_dir / "SKILL.md"
    if not skill_file.is_file():
        return ["SKILL.md отсутствует"]
    text = skill_file.read_text(encoding="utf-8")
    try:
        metadata, body = parse_frontmatter(text)
    except ValueError as exc:
        return [str(exc)]
    name = metadata.get("name", "")
    description = metadata.get("description", "")
    if name != skill_dir.name:
        errors.append(f"name {name!r} не совпадает с каталогом {skill_dir.name!r}")
    if not NAME_RE.fullmatch(name) or len(name) > 64:
        errors.append("name должен быть lowercase hyphen-case длиной до 64 символов")
    if not description or description in {">", ">-", "|", "|-"}:
        errors.append("description должен быть непустым")
    if not body.strip():
        errors.append("тело SKILL.md пусто")
    if MARKER_RE.search(text):
        errors.append("SKILL.md содержит TODO/TBD/FIXME")
    for line_number, line in enumerate(text.splitlines(), 1):
        if MANDATORY_RUNTIME_RE.search(line) and not NEGATED_RUNTIME_RE.search(line):
            errors.append(f"строка {line_number}: обязательная runtime-specific зависимость запрещена")
    for match in REFERENCE_RE.finditer(body):
        raw = match.group(1).rstrip(".,;:)")
        if "<" in raw or ">" in raw:
            continue
        target = repo_root / Path(raw.replace("\\", "/"))
        if not target.exists():
            errors.append(f"внутренняя ссылка не существует: {raw}")
    errors.extend(parse_openai_yaml(skill_dir / "agents" / "openai.yaml", name or skill_dir.name))
    return errors


def validate_root(root: Path) -> dict[str, object]:
    root = root.resolve()
    repo_root = root.parent
    skills = sorted(path for path in root.iterdir() if path.is_dir() and (path / "SKILL.md").is_file())
    results = {skill.name: validate_skill(skill, repo_root) for skill in skills}
    return {
        "root": str(root),
        "skill_count": len(skills),
        "errors": sum(len(items) for items in results.values()),
        "skills": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    report = validate_root(args.root)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"Agent Skills: {report['skill_count']}; errors: {report['errors']}")
        for skill, errors in report["skills"].items():
            for error in errors:
                print(f"- {skill}: {error}")
    return 1 if report["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())

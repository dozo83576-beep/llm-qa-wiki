#!/usr/bin/env python3
"""Safe, dependency-free adapter for explicitly approved QA tools."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import platform
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET


STATUSES = {"clean", "findings", "blocked", "error"}
TOOLS = {
    "axe-core": ("axe",),
    "schemathesis": ("schemathesis",),
    "oasdiff": ("oasdiff",),
    "appium": ("appium",),
    "maestro": ("maestro",),
    "pact": ("pact_verifier_cli", "pact-verifier"),
    "wiremock": ("wiremock",),
    "testcontainers": ("docker",),
    "zap-baseline": ("docker",),
    "lighthouse-ci": ("lhci",),
    "gitleaks": ("gitleaks",),
}
OS_DEPENDENCY_TOOLS = {"appium", "maestro", "wiremock", "testcontainers", "zap-baseline"}
OFFICIAL_DOWNLOAD_HOSTS = {
    "oasdiff": {"github.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com"},
    "gitleaks": {"github.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com"},
}
SENSITIVE_KEYS = re.compile(r"(?i)(authorization|cookie|token|secret|password|passwd|api[_-]?key|session)")
EMAIL = re.compile(r"(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}(?![\w.-])")
PHONE = re.compile(r"(?<!\d)(?:\+?\d[\s().-]?){9,15}(?!\d)")
SENSITIVE_QUERY = re.compile(r"(?i)(token|secret|password|passwd|key|api[_-]?key|session|cookie|email|phone)")
URL_IN_TEXT = re.compile(r"https?://[^\s<>'\"]+")
SECRET_ASSIGNMENT = re.compile(r"(?i)\b(token|secret|password|passwd|api[_-]?key|session|cookie)\s*[:=]\s*[^\s,;]+")


class Blocked(Exception):
    pass


def load_catalog(path: pathlib.Path | None = None) -> dict[str, dict]:
    catalog_path = path or (pathlib.Path(__file__).parents[2] / "resources" / "qa-tool-catalog.yaml")
    data = json.loads(catalog_path.read_text(encoding="utf-8"))
    profiles = {}
    for profile in data.get("tools", []):
        tool_id = profile.get("id")
        version = profile.get("version")
        tested_version = profile.get("tested_version")
        if not isinstance(tool_id, str) or tool_id in profiles:
            raise Blocked("catalog tool ids must be unique strings")
        if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", version):
            raise Blocked(f"catalog exact version is missing or invalid for {tool_id}")
        if tested_version != version:
            raise Blocked(f"catalog tested_version must exactly equal version for {tool_id}")
        profiles[tool_id] = profile
    if set(profiles) != set(TOOLS):
        raise Blocked("catalog and runner tool ids differ")
    return profiles


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def inside(root: pathlib.Path, candidate: pathlib.Path, *, must_exist: bool = False) -> pathlib.Path:
    root = root.resolve(strict=True)
    resolved = candidate.resolve(strict=must_exist)
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise Blocked(f"path is outside project root: {candidate}") from exc
    return resolved


def project_path(root: pathlib.Path, value: str, *, must_exist: bool = False) -> pathlib.Path:
    candidate = pathlib.Path(value)
    if not candidate.is_absolute():
        candidate = root / candidate
    return inside(root, candidate, must_exist=must_exist)


def load_json_argument(root: pathlib.Path, value: str, label: str) -> dict:
    value = value.strip()
    if value.startswith("{"):
        data = json.loads(value)
    else:
        path = project_path(root, value, must_exist=True)
        data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise Blocked(f"{label} must be a JSON object")
    return data


def parse_time(value: object, field: str) -> dt.datetime:
    if not isinstance(value, str):
        raise Blocked(f"authorization {field} is required")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise Blocked(f"authorization {field} is not ISO-8601") from exc
    if parsed.tzinfo is None:
        raise Blocked(f"authorization {field} must include timezone")
    return parsed.astimezone(dt.timezone.utc)


def normalized_origin(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise Blocked("target must be an HTTP(S) URL without embedded credentials")
    port = parsed.port
    default = (parsed.scheme == "http" and port == 80) or (parsed.scheme == "https" and port == 443)
    authority = parsed.hostname.lower() if not port or default else f"{parsed.hostname.lower()}:{port}"
    return f"{parsed.scheme.lower()}://{authority}"


def is_loopback_url(url: str) -> bool:
    parsed = urllib.parse.urlsplit(url)
    return parsed.scheme in {"http", "https"} and (parsed.hostname or "").lower() in {"127.0.0.1", "localhost", "::1"}


def authorize(auth: dict | None, target: str, operation: str, now: dt.datetime | None = None) -> None:
    if auth is None:
        raise Blocked(f"written authorization is required for {operation}")
    current = now or utc_now()
    not_before = parse_time(auth.get("not_before"), "not_before")
    expires = parse_time(auth.get("expires"), "expires")
    if expires <= not_before:
        raise Blocked("authorization window is invalid")
    if current < not_before or current > expires:
        raise Blocked("authorization window is not active")
    origins = auth.get("allowed_origins")
    operations = auth.get("allowed_operations")
    if not isinstance(origins, list) or normalized_origin(target) not in {normalized_origin(str(x)) for x in origins}:
        raise Blocked("target origin is not allowlisted")
    if not isinstance(operations, list) or operation not in operations:
        raise Blocked(f"operation is not authorized: {operation}")


def redact_url(value: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError:
        return value
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return value
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    clean = [(key, "[REDACTED]" if SENSITIVE_QUERY.search(key) else val) for key, val in query]
    netloc = parsed.hostname or ""
    if parsed.port:
        netloc += f":{parsed.port}"
    return urllib.parse.urlunsplit((parsed.scheme, netloc, parsed.path, urllib.parse.urlencode(clean), parsed.fragment))


def redact(value, key: str = ""):
    if SENSITIVE_KEYS.search(key):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {str(k): redact(v, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, str):
        if re.fullmatch(r"[0-9a-fA-F]{64}", value):
            return value.lower()
        text = URL_IN_TEXT.sub(lambda match: redact_url(match.group(0)), value)
        text = SECRET_ASSIGNMENT.sub(lambda match: f"{match.group(1)}=[REDACTED]", text)
        text = EMAIL.sub("[REDACTED_EMAIL]", text)
        text = PHONE.sub("[REDACTED_PHONE]", text)
        return text
    return value


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_junit(path: pathlib.Path) -> dict:
    root = ET.parse(path).getroot()
    cases = root.findall(".//testcase")
    findings = []
    skipped = 0
    for case in cases:
        node = case.find("failure")
        if node is None:
            node = case.find("error")
        if node is not None:
            findings.append(redact({
                "rule_id": node.tag,
                "level": "error",
                "message": node.get("message") or (node.text or "test failed").strip(),
                "location": case.get("classname", "") + "." + case.get("name", ""),
            }))
        if case.find("skipped") is not None:
            skipped += 1
    return {"format": "junit", "summary": {"tests": len(cases), "findings": len(findings), "skipped": skipped}, "findings": findings}


def normalize_sarif(path: pathlib.Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    findings = []
    for run in data.get("runs", []):
        for item in run.get("results", []):
            location = ""
            locations = item.get("locations") or []
            if locations:
                location = locations[0].get("physicalLocation", {}).get("artifactLocation", {}).get("uri", "")
            message = item.get("message", {})
            findings.append(redact({
                "rule_id": item.get("ruleId", "unknown"),
                "level": item.get("level", "warning"),
                "message": message.get("text", "") if isinstance(message, dict) else str(message),
                "location": location,
            }))
    return {"format": "sarif", "summary": {"findings": len(findings)}, "findings": findings}


def normalize_profile_json(path: pathlib.Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and isinstance(data.get("findings"), list):
        findings = data["findings"]
    elif isinstance(data, list):
        findings = data
    elif isinstance(data, dict):
        findings = data.get("results", []) if isinstance(data.get("results"), list) else []
    else:
        findings = []
    return {"format": "profile-json", "summary": {"findings": len(findings)}, "findings": redact(findings)}


def normalize_axe(path: pathlib.Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    findings = []
    for bucket, manual in (("violations", False), ("incomplete", True)):
        for item in data.get(bucket, []):
            nodes = item.get("nodes") or [{}]
            for node in nodes:
                findings.append(redact({
                    "rule_id": item.get("id", "unknown"),
                    "level": item.get("impact") or "warning",
                    "message": item.get("help") or item.get("description", ""),
                    "location": ", ".join(node.get("target", [])),
                    "manual_review_required": manual,
                    "signal": bucket,
                }))
    manual_count = sum(1 for finding in findings if finding["manual_review_required"])
    return {"format": "axe", "summary": {"findings": len(findings), "manual_review_required": manual_count}, "findings": findings}


def normalize_zap(path: pathlib.Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    findings = []
    for site in data.get("site", []):
        for alert in site.get("alerts", []):
            instances = alert.get("instances") or [{}]
            for instance in instances:
                findings.append(redact({
                    "rule_id": str(alert.get("pluginid") or alert.get("alertRef") or "unknown"),
                    "level": str(alert.get("riskdesc") or alert.get("riskcode") or "warning"),
                    "message": alert.get("name") or alert.get("alert", ""),
                    "location": instance.get("uri") or site.get("@name", ""),
                    "method": instance.get("method"),
                }))
    return {"format": "zap", "summary": {"findings": len(findings)}, "findings": findings}


def normalize_oasdiff(path: pathlib.Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    raw = data.get("breakingChanges") or data.get("changes") or data.get("errors") or []
    if isinstance(raw, dict):
        raw = [dict(value, group=key) if isinstance(value, dict) else {"group": key, "message": value} for key, values in raw.items() for value in (values if isinstance(values, list) else [values])]
    findings = [redact({
        "rule_id": str(item.get("id") or item.get("ruleId") or item.get("code") or "breaking-change"),
        "level": item.get("level") or "error",
        "message": item.get("text") or item.get("message") or item.get("description") or "breaking API change",
        "location": item.get("path") or item.get("operation") or item.get("source") or "",
    }) for item in raw if isinstance(item, dict)]
    return {"format": "oasdiff", "summary": {"findings": len(findings)}, "findings": findings}


def normalize_lighthouse(path: pathlib.Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    findings = []
    for category_id, category in data.get("categories", {}).items():
        score = category.get("score")
        if isinstance(score, (int, float)) and score < 1:
            findings.append({"rule_id": f"category:{category_id}", "level": "warning", "message": f"Lighthouse category score {score}", "location": redact(data.get("finalUrl", "")), "lab_signal": True})
    for audit_id, audit in data.get("audits", {}).items():
        if audit.get("scoreDisplayMode") == "error" or audit.get("score") == 0:
            findings.append(redact({"rule_id": f"audit:{audit_id}", "level": "warning", "message": audit.get("title") or audit.get("description", ""), "location": data.get("finalUrl", ""), "lab_signal": True}))
    budgets = data.get("budgetSignals") or data.get("budgetResults") or []
    for budget in budgets:
        if isinstance(budget, dict) and budget.get("overBudget"):
            findings.append(redact({"rule_id": "budget", "level": "error", "message": budget.get("message") or "Lighthouse budget exceeded", "location": data.get("finalUrl", ""), "lab_signal": True}))
    return {"format": "lighthouse-lhr", "summary": {"findings": len(findings), "lab_data": True}, "findings": findings}


def normalize_artifact(path: pathlib.Path, tool: str | None = None) -> dict:
    suffix = path.suffix.lower()
    if suffix == ".json" and tool == "axe-core":
        return normalize_axe(path)
    if suffix == ".json" and tool == "zap-baseline":
        return normalize_zap(path)
    if suffix == ".json" and tool == "oasdiff":
        return normalize_oasdiff(path)
    if suffix == ".json" and tool == "lighthouse-ci":
        return normalize_lighthouse(path)
    if suffix == ".xml":
        return normalize_junit(path)
    if suffix == ".sarif":
        return normalize_sarif(path)
    if suffix == ".json":
        return normalize_profile_json(path)
    return {"format": "opaque", "summary": {}, "findings": []}


def sanitize_artifact(path: pathlib.Path) -> None:
    """Redact structured artifacts before hashing or exposing them as evidence."""
    suffix = path.suffix.lower()
    if suffix in {".json", ".sarif"}:
        data = json.loads(path.read_text(encoding="utf-8"))
        path.write_text(json.dumps(redact(data), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    elif suffix == ".xml":
        tree = ET.parse(path)
        for node in tree.iter():
            node.attrib = {key: str(redact(value, key)) for key, value in node.attrib.items()}
            if node.text:
                node.text = str(redact(node.text))
            if node.tail:
                node.tail = str(redact(node.tail))
        tree.write(path, encoding="utf-8", xml_declaration=True)


def _is_link_or_reparse(path: pathlib.Path) -> bool:
    stat = path.lstat()
    return path.is_symlink() or bool(getattr(stat, "st_file_attributes", 0) & 0x400)


def find_executable(tool: str, local_root: pathlib.Path, expected_version: str | None = None) -> str | None:
    for name in TOOLS[tool]:
        local = local_root / tool / "bin" / name
        candidates = [local, local.with_suffix(".exe")]
        for candidate in candidates:
            if candidate.is_file():
                tool_root = inside(local_root, local_root / tool)
                resolved = inside(tool_root, candidate, must_exist=True)
                if _is_link_or_reparse(candidate) or resolved != candidate.absolute():
                    raise Blocked(f"local executable must be a regular non-link file inside .qa-tools/{tool}")
                manifest_path = tool_root / "install-manifest.json"
                if not manifest_path.is_file() or _is_link_or_reparse(manifest_path):
                    raise Blocked(f"local executable manifest is missing for {tool}")
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                relative = candidate.relative_to(tool_root).as_posix()
                if manifest.get("path") != relative or manifest.get("version") != expected_version:
                    raise Blocked(f"local executable manifest path/version mismatch for {tool}")
                expected_hash = manifest.get("sha256")
                if not isinstance(expected_hash, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", expected_hash):
                    raise Blocked(f"local executable manifest SHA-256 is invalid for {tool}")
                if sha256(resolved).lower() != expected_hash.lower():
                    raise Blocked(f"local executable SHA-256 mismatch for {tool}")
                return str(resolved)
        found = shutil.which(name)
        if found:
            return found
    return None


def discover_version(executable: str, tool: str) -> str | None:
    args = [executable, "--version"]
    try:
        completed = subprocess.run(args, capture_output=True, text=True, timeout=10, shell=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    text = (completed.stdout or completed.stderr).strip()
    match = re.search(r"(?<!\d)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?!\d)", text)
    return match.group(1) if match else None


def verify_testcontainers_pin(root: pathlib.Path, config: dict, expected_version: str) -> pathlib.Path:
    value = config.get("dependency_lock")
    if not isinstance(value, str) or not value:
        raise Blocked("testcontainers requires a project-local dependency_lock/config file")
    lock_path = project_path(root, value, must_exist=True)
    if not lock_path.is_file() or lock_path.stat().st_size > 10 * 1024 * 1024:
        raise Blocked("testcontainers dependency_lock must be a file no larger than 10 MiB")
    text = lock_path.read_text(encoding="utf-8")
    escaped = re.escape(expected_version)
    library = r"org\.testcontainers(?:[A-Za-z0-9_.:/-]*testcontainers[A-Za-z0-9_.:/-]*|[A-Za-z0-9_.:/-]*)"
    forward = re.search(library + r"[^\r\n]{0,200}(?<![0-9.])" + escaped + r"(?![0-9.])", text, re.IGNORECASE)
    reverse = re.search(r"(?<![0-9.])" + escaped + r"(?![0-9.])[^\r\n]{0,200}" + library, text, re.IGNORECASE)
    if not (forward or reverse):
        raise Blocked(f"testcontainers dependency_lock does not confirm exact testcontainers-java pin {expected_version}")
    return lock_path


def ensure_local_install(root: pathlib.Path, tool: str, config: dict, expected_version: str) -> pathlib.Path:
    if tool in OS_DEPENDENCY_TOOLS or tool not in OFFICIAL_DOWNLOAD_HOSTS:
        raise Blocked(f"InstallLocal is unavailable for {tool}; install its OS/runtime prerequisites outside the toolkit")
    url = config.get("download_url")
    expected = config.get("expected_sha256")
    filename = config.get("download_filename")
    if not all(isinstance(x, str) and x for x in (url, expected, filename)):
        raise Blocked("InstallLocal requires download_url, download_filename, and expected_sha256")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in OFFICIAL_DOWNLOAD_HOSTS[tool] or parsed.username or parsed.password:
        raise Blocked("download URL is not an allowlisted official HTTPS host")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", expected):
        raise Blocked("expected_sha256 must be 64 hexadecimal characters")
    if pathlib.Path(filename).name != filename:
        raise Blocked("download_filename must be a plain file name")
    destination = inside(root, root / ".qa-tools" / tool / "bin" / filename)
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "qa-toolkit/1"})
    with urllib.request.urlopen(request, timeout=30) as response:
        final_host = urllib.parse.urlsplit(response.geturl()).hostname
        if final_host not in OFFICIAL_DOWNLOAD_HOSTS[tool]:
            raise Blocked("download redirect left the allowlisted official hosts")
        payload = response.read(256 * 1024 * 1024 + 1)
    if len(payload) > 256 * 1024 * 1024:
        raise Blocked("download exceeds 256 MiB limit")
    actual = hashlib.sha256(payload).hexdigest()
    if actual.lower() != expected.lower():
        raise Blocked("download SHA-256 mismatch")
    destination.write_bytes(payload)
    if os.name != "nt":
        destination.chmod(0o755)
    manifest = destination.parents[1] / "install-manifest.json"
    manifest.write_text(json.dumps({
        "path": destination.relative_to(destination.parents[1]).as_posix(),
        "version": expected_version,
        "sha256": actual.lower(),
    }, indent=2) + "\n", encoding="utf-8")
    return destination


def validate_safety(tool: str, root: pathlib.Path, config: dict, auth: dict | None) -> None:
    target = str(config.get("target", ""))
    if tool in {"axe-core", "lighthouse-ci"}:
        normalized_origin(target)
    if tool == "zap-baseline":
        if config.get("active_scan") or config.get("ajax_spider") or config.get("mode") not in (None, "baseline", "passive"):
            raise Blocked("ZAP safe profile permits only traditional spider and passive baseline scan")
        authorize(auth, target, "zap-baseline")
    if tool == "schemathesis":
        configured_methods = config.get("methods", ["GET"])
        if not isinstance(configured_methods, list) or not configured_methods:
            raise Blocked("schemathesis methods must be a non-empty JSON array")
        methods = {str(x).upper() for x in configured_methods}
        if not methods <= {"GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"}:
            raise Blocked("schemathesis methods contain an unsupported value")
        schema = str(config.get("schema", ""))
        if urllib.parse.urlsplit(schema).scheme:
            normalized_origin(schema)
        if config.get("base_url"):
            normalized_origin(str(config["base_url"]))
        unsafe = bool(methods & {"POST", "PUT", "PATCH", "DELETE"}) or bool(config.get("stateful"))
        if unsafe:
            authorize(auth, str(config.get("base_url") or target), "schemathesis-unsafe")
    if tool == "oasdiff":
        for field in ("base", "revision"):
            path = project_path(root, str(config.get(field, "")), must_exist=True)
            if re.search(r"(?i)[\"']?\$ref[\"']?\s*:\s*[\"']?\s*https?://", path.read_text(encoding="utf-8")):
                raise Blocked("remote $ref is rejected by the oasdiff safe profile")
    if tool == "wiremock" and (config.get("proxy") or config.get("record")):
        authorize(auth, target, "wiremock-proxy-record")
    if tool == "pact":
        pact_files = config.get("pact_files")
        if not isinstance(pact_files, list) or not pact_files:
            raise Blocked("pact requires a non-empty pact_files array")
        for value in pact_files:
            path = project_path(root, str(value), must_exist=True)
            if not path.is_file() or path.suffix.lower() != ".json":
                raise Blocked("pact sources must be project-local JSON files")
        provider_url = str(config.get("provider_url", ""))
        normalized_origin(provider_url)
        provider_parts = urllib.parse.urlsplit(provider_url)
        if provider_parts.query or provider_parts.fragment:
            raise Blocked("Pact provider URL cannot contain query or fragment")
        if not is_loopback_url(provider_url):
            if config.get("test_environment") is not True:
                raise Blocked("non-loopback Pact provider requires test_environment=true")
            authorize(auth, provider_url, "pact-provider-verification")
        if config.get("broker") or config.get("publish"):
            raise Blocked("Pact broker and result publishing are not supported")
    if tool == "appium":
        port = int(config.get("port", 4723))
        if not 1024 <= port <= 65535:
            raise Blocked("appium port is outside the allowed range")
        capabilities_path = project_path(root, str(config.get("capabilities", "")), must_exist=True)
        capabilities = json.loads(capabilities_path.read_text(encoding="utf-8"))
        if not isinstance(capabilities, dict):
            raise Blocked("appium capabilities must be a JSON object")
        always_match = capabilities.get("alwaysMatch", {})
        app_path = capabilities.get("appium:app")
        if not app_path and isinstance(always_match, dict):
            app_path = always_match.get("appium:app")
        if app_path and not urllib.parse.urlsplit(str(app_path)).scheme:
            project_path(root, str(app_path), must_exist=True)
    if tool == "wiremock":
        mappings = project_path(root, str(config.get("mappings_dir", "")), must_exist=True)
        if not mappings.is_dir():
            raise Blocked("wiremock mappings_dir must be a project-local directory")
        port = int(config.get("port", 18089))
        if not 1024 <= port <= 65535:
            raise Blocked("wiremock port is outside the allowed range")
        if not re.fullmatch(r"/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*", str(config.get("probe_path", "/"))):
            raise Blocked("wiremock probe_path must be a relative URL path")
    if tool in {"appium", "maestro"} and str(config.get("platform", "")).lower() == "ios" and platform.system() == "Windows":
        raise Blocked(f"{tool} iOS execution is blocked on Windows")
    if tool == "gitleaks":
        delivery = project_path(root, str(config.get("delivery_dir", "")), must_exist=True)
        if not delivery.is_dir():
            raise Blocked("delivery_dir must be a directory")
    if tool == "lighthouse-ci" and int(config.get("runs", 3)) < 3:
        raise Blocked("lighthouse-ci requires at least 3 runs")
    if tool == "lighthouse-ci":
        budget = project_path(root, str(config.get("budget_file", "")), must_exist=True)
        if not budget.is_file():
            raise Blocked("lighthouse-ci budget_file must be a project-local file")
    if tool in {"testcontainers", "zap-baseline"}:
        digest = config.get("image_digest")
        if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-fA-F]{64}", digest):
            raise Blocked(f"{tool} requires image_digest in sha256:<64 hex> form")


def output_path(run_dir: pathlib.Path, name: str) -> pathlib.Path:
    return inside(run_dir, run_dir / name)


def build_command(tool: str, executable: str, root: pathlib.Path, run_dir: pathlib.Path, config: dict) -> tuple[list[str], pathlib.Path | None]:
    target = str(config.get("target", ""))
    if tool == "axe-core":
        if not target:
            raise Blocked("target is required")
        out = output_path(run_dir, "axe.json")
        tags = config.get("tags", [])
        if not isinstance(tags, list) or any(not re.fullmatch(r"[A-Za-z0-9._-]+", str(x)) for x in tags):
            raise Blocked("axe tags contain unsupported characters")
        command = [executable, target, "--save", str(out)]
        for tag in tags:
            command += ["--tags", str(tag)]
        return command, out
    if tool == "schemathesis":
        schema = str(config.get("schema", ""))
        if not schema:
            raise Blocked("schema is required")
        if not urllib.parse.urlsplit(schema).scheme:
            schema = str(project_path(root, schema, must_exist=True))
        out = output_path(run_dir, "schemathesis.xml")
        command = [executable, "run", schema, "--report", "junit", "--report-junit-path", str(out)]
        if config.get("base_url"):
            command += ["--url", str(config["base_url"])]
        methods = [str(x).upper() for x in config.get("methods", ["GET"])]
        for method in methods:
            command += ["--include-method", method]
        return command, out
    if tool == "oasdiff":
        out = output_path(run_dir, "oasdiff.json")
        return [executable, "breaking", str(project_path(root, str(config["base"]), must_exist=True)), str(project_path(root, str(config["revision"]), must_exist=True)), "--format", "json", "--output", str(out)], out
    if tool == "appium":
        port = int(config.get("port", 4723))
        return [executable, "--address", "127.0.0.1", "--port", str(port), "--base-path", "/wd/hub", "--log-level", "warn"], None
    if tool == "maestro":
        flow = project_path(root, str(config.get("flow", "")), must_exist=True)
        out = output_path(run_dir, "maestro.xml")
        return [executable, "test", str(flow), "--format", "junit", "--output", str(out)], out
    if tool == "zap-baseline":
        out = output_path(run_dir, "zap.json")
        image = f"zaproxy/zap-stable:2.17.0@{config['image_digest']}"
        name = "qa-zap-" + hashlib.sha256(str(run_dir).encode("utf-8")).hexdigest()[:12]
        return [executable, "run", "--rm", "--pull=never", "--name", name, "-v", f"{run_dir}:/zap/wrk:rw", image, "zap-baseline.py", "-t", target, "-J", "/zap/wrk/zap.json", "-m", str(int(config.get("spider_minutes", 1)))], out
    if tool == "lighthouse-ci":
        if not target:
            raise Blocked("target is required")
        runs = int(config.get("runs", 3))
        budget = project_path(root, str(config["budget_file"]), must_exist=True)
        return [executable, "collect", "--url", target, "--numberOfRuns", str(runs), "--outputDir", str(run_dir), "--settings.budgetsPath", str(budget)], None
    if tool == "gitleaks":
        out = output_path(run_dir, "gitleaks.sarif")
        delivery = project_path(root, str(config["delivery_dir"]), must_exist=True)
        return [executable, "detect", "--no-git", "--source", str(delivery), "--report-format", "sarif", "--report-path", str(out), "--redact"], out
    if tool == "pact":
        out = output_path(run_dir, "pact.xml")
        provider = urllib.parse.urlsplit(str(config["provider_url"]))
        port = provider.port or (443 if provider.scheme == "https" else 80)
        command = [executable, "--hostname", str(provider.hostname), "--port", str(port), "--transport", provider.scheme, "--junit", str(out)]
        base_path = urllib.parse.unquote(provider.path or "")
        if base_path and base_path != "/":
            normalized_base = "/" + "/".join(segment for segment in base_path.split("/") if segment not in {"", "."})
            if ".." in base_path.split("/"):
                raise Blocked("Pact provider base path cannot contain parent traversal")
            command += ["--base-path", normalized_base]
        for pact_file in config["pact_files"]:
            command += ["--file", str(project_path(root, str(pact_file), must_exist=True))]
        return command, out
    if tool == "wiremock":
        port = int(config.get("port", 18089))
        mappings = project_path(root, str(config["mappings_dir"]), must_exist=True)
        command = [executable, "--port", str(port), "--bind-address", "127.0.0.1", "--root-dir", str(mappings)]
        if config.get("proxy"):
            command += ["--proxy-all", str(config["target"])]
        if config.get("record"):
            command += ["--record-mappings"]
        return command, None
    if tool == "testcontainers":
        name = "qa-toolkit-" + run_dir.name[-12:].lower()
        image = f"alpine:3.22@{config['image_digest']}"
        return [executable, "run", "--rm", "--pull=never", "--name", name, image, "/bin/sh", "-c", "printf qa-toolkit-smoke"], None
    raise Blocked(f"hardcoded command builder is unavailable for {tool}")


def artifact_record(root: pathlib.Path, path: pathlib.Path, tool: str | None = None) -> dict:
    safe = inside(root, path, must_exist=True)
    sanitize_artifact(safe)
    return {
        "path": safe.relative_to(root).as_posix(),
        "sha256": sha256(safe),
        "size": safe.stat().st_size,
        "normalized": normalize_artifact(safe, tool),
    }


def controlled_artifact_path(value: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError("artifact path must be a controlled relative POSIX path")
    candidate = pathlib.PurePosixPath(value)
    if candidate.is_absolute() or any(part in {"", ".", ".."} for part in candidate.parts):
        raise ValueError("artifact path must stay inside ProjectRoot")
    return candidate.as_posix()


def redact_result(result: dict) -> dict:
    """Redact untrusted content while preserving already-contained artifact path identifiers."""
    safe = redact(result)
    artifacts = result.get("artifacts", [])
    restored_hashes: dict[str, str] = {}
    for index, artifact in enumerate(artifacts):
        relative = controlled_artifact_path(artifact.get("path"))
        digest = artifact.get("sha256")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("artifact sha256 is invalid")
        if result.get("hashes", {}).get(relative) != digest:
            raise ValueError("artifact path and hashes key must match exactly")
        safe["artifacts"][index]["path"] = relative
        restored_hashes[relative] = digest
    if set(result.get("hashes", {})) != set(restored_hashes):
        raise ValueError("hashes contains an unknown artifact path")
    safe["hashes"] = restored_hashes
    return safe


def validate_result_schema(result: dict) -> bool:
    required = {"schema_version", "run_id", "status", "tool", "version", "target", "artifacts", "hashes", "timestamps", "limitations", "signals_only"}
    return (
        required <= result.keys()
        and result.get("status") in STATUSES
        and isinstance(result.get("artifacts"), list)
        and isinstance(result.get("hashes"), dict)
        and isinstance(result.get("timestamps"), dict)
        and result.get("signals_only") is True
    )


def terminate_server(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def _loopback_request(url: str, method: str = "GET", payload: dict | None = None, timeout: float = 2.0) -> dict:
    if not is_loopback_url(url):
        raise Blocked("bounded server smoke only permits loopback HTTP")
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=body, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read(1024 * 1024)
    return json.loads(raw.decode("utf-8")) if raw else {}


def execute_appium_smoke(command: list[str], root: pathlib.Path, config: dict) -> subprocess.CompletedProcess:
    process = subprocess.Popen(command, cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, shell=False)
    port = int(config.get("port", 4723))
    base = f"http://127.0.0.1:{port}/wd/hub"
    session_id = None
    try:
        deadline = time.monotonic() + min(30, int(config.get("startup_timeout_seconds", 10)))
        while True:
            try:
                _loopback_request(base + "/status")
                break
            except (OSError, ValueError, json.JSONDecodeError):
                if time.monotonic() >= deadline or process.poll() is not None:
                    raise Blocked("Appium loopback server did not become ready")
                time.sleep(0.1)
        capabilities_path = project_path(root, str(config["capabilities"]), must_exist=True)
        capabilities = json.loads(capabilities_path.read_text(encoding="utf-8"))
        response = _loopback_request(base + "/session", "POST", {"capabilities": capabilities})
        value = response.get("value", {}) if isinstance(response, dict) else {}
        session_id = response.get("sessionId") or (value.get("sessionId") if isinstance(value, dict) else None)
        if not isinstance(session_id, str) or not session_id:
            raise Blocked("Appium did not return a W3C session id")
        return subprocess.CompletedProcess(command, 0, "session created and deleted", "")
    finally:
        if session_id:
            try:
                _loopback_request(base + "/session/" + urllib.parse.quote(session_id, safe=""), "DELETE")
            except (OSError, ValueError, json.JSONDecodeError, Blocked):
                pass
        terminate_server(process)


def execute_wiremock_smoke(command: list[str], root: pathlib.Path, config: dict) -> subprocess.CompletedProcess:
    process = subprocess.Popen(command, cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, shell=False)
    url = f"http://127.0.0.1:{int(config.get('port', 18089))}{config.get('probe_path', '/')}"
    try:
        deadline = time.monotonic() + min(30, int(config.get("startup_timeout_seconds", 10)))
        while True:
            try:
                _loopback_request(url)
                return subprocess.CompletedProcess(command, 0, "loopback mapping probe completed", "")
            except (OSError, ValueError, json.JSONDecodeError):
                if time.monotonic() >= deadline or process.poll() is not None:
                    raise Blocked("WireMock loopback server/probe did not become ready")
                time.sleep(0.1)
    finally:
        terminate_server(process)


def execute_container_smoke(command: list[str], executable: str, root: pathlib.Path, timeout: int) -> tuple[subprocess.CompletedProcess, subprocess.CompletedProcess]:
    name = command[command.index("--name") + 1]
    try:
        completed = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=timeout, shell=False)
    finally:
        cleanup = subprocess.run([executable, "rm", "-f", name], cwd=root, capture_output=True, text=True, timeout=30, shell=False)
    return completed, cleanup


def run(tool: str, config_value: str, project_root: str, preflight: bool, install_local: bool, authorization_value: str | None) -> tuple[dict, pathlib.Path]:
    started = utc_now()
    root = pathlib.Path(project_root).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("project root must be a directory")
    run_id = started.strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:12]
    run_dir = inside(root, root / "evidence" / "data" / "tool-runs" / run_id)
    run_dir.mkdir(parents=True, exist_ok=False)
    result = {
        "schema_version": 1,
        "run_id": run_id,
        "status": "error",
        "tool": {"id": tool},
        "version": None,
        "target": None,
        "artifacts": [],
        "hashes": {},
        "timestamps": {"started_at": iso(started)},
        "limitations": ["Tool output is a signal for tester review, not a QA verdict."],
        "signals_only": True,
    }
    result_path = run_dir / "result.json"
    try:
        catalog = load_catalog()
        if tool not in catalog:
            raise Blocked(f"unknown tool id: {tool}")
        config = load_json_argument(root, config_value, "config")
        result["target"] = redact(config.get("target") or config.get("base_url") or config.get("delivery_dir"))
        auth = load_json_argument(root, authorization_value, "authorization") if authorization_value else None
        validate_safety(tool, root, config, auth)
        local_root = inside(root, root / ".qa-tools")
        expected_version = catalog[tool]["version"]
        executable = find_executable(tool, local_root, expected_version)
        if install_local and not executable:
            executable = str(ensure_local_install(root, tool, config, expected_version))
        if not executable:
            raise Blocked(f"prerequisite executable is missing for {tool}")
        result["version"] = discover_version(executable, tool)
        if tool in {"testcontainers", "zap-baseline"}:
            docker_version = result["version"]
            if docker_version is None:
                raise Blocked("unable to discover existing Docker runtime version")
            if tool == "testcontainers":
                verify_testcontainers_pin(root, config, expected_version)
            result["version"] = expected_version
            result["prerequisite_versions"] = {"docker": docker_version}
        else:
            if result["version"] is None:
                raise Blocked(f"unable to discover an exact semantic version for {tool}; required {expected_version}")
            if result["version"] != expected_version:
                raise Blocked(f"version mismatch for {tool}: discovered {result['version']}, required {expected_version}")
        if tool == "testcontainers":
            result["limitations"].append("Cleanup contract: the project harness must stop containers in finally/teardown and keep resource reaping enabled.")
        if tool == "lighthouse-ci":
            result["limitations"].append("Lighthouse values are variable lab data; use multiple runs and do not treat them as field data.")
        command, expected_artifact = build_command(tool, executable, root, run_dir, config)
        result["preflight"] = {"executable": pathlib.Path(executable).name, "command": [pathlib.Path(command[0]).name] + command[1:]}
        if preflight:
            result["status"] = "clean"
            result["limitations"].append("Preflight only: no scan or test was started; version discovery may invoke the executable with --version.")
        else:
            cleanup = None
            if tool == "appium":
                completed = execute_appium_smoke(command, root, config)
            elif tool == "wiremock":
                completed = execute_wiremock_smoke(command, root, config)
            elif tool in {"testcontainers", "zap-baseline"}:
                completed, cleanup = execute_container_smoke(command, executable, root, int(config.get("timeout_seconds", 120)))
            else:
                completed = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=int(config.get("timeout_seconds", 300)), shell=False)
            executions = [{"step": "collect" if tool == "lighthouse-ci" else "run", "exit_code": completed.returncode, "stdout": redact(completed.stdout[-4000:]), "stderr": redact(completed.stderr[-4000:])}]
            if cleanup is not None:
                executions.append({"step": "cleanup", "exit_code": cleanup.returncode, "stdout": redact(cleanup.stdout[-4000:]), "stderr": redact(cleanup.stderr[-4000:])})
                if cleanup.returncode != 0:
                    completed = subprocess.CompletedProcess(command, cleanup.returncode, completed.stdout, "container cleanup failed")
            if tool == "lighthouse-ci" and completed.returncode == 0:
                budget = project_path(root, str(config["budget_file"]), must_exist=True)
                asserted = subprocess.run([executable, "assert", "--budgetsFile", str(budget)], cwd=root, capture_output=True, text=True, timeout=int(config.get("timeout_seconds", 300)), shell=False)
                executions.append({"step": "assert-budget", "exit_code": asserted.returncode, "stdout": redact(asserted.stdout[-4000:]), "stderr": redact(asserted.stderr[-4000:])})
                completed = asserted
            result["execution"] = executions
            if expected_artifact and expected_artifact.is_file():
                record = artifact_record(root, expected_artifact, tool)
                result["artifacts"].append(record)
                result["hashes"][record["path"]] = record["sha256"]
                count = record["normalized"].get("summary", {}).get("findings", 0)
                result["status"] = "findings" if count else ("clean" if completed.returncode == 0 else "error")
            elif tool == "lighthouse-ci":
                finding_count = 0
                for artifact in sorted(run_dir.rglob("*.json")):
                    if artifact != result_path:
                        record = artifact_record(root, artifact, tool)
                        result["artifacts"].append(record)
                        result["hashes"][record["path"]] = record["sha256"]
                        finding_count += int(record["normalized"].get("summary", {}).get("findings", 0))
                if not result["artifacts"]:
                    result["status"] = "error"
                    result["reason"] = "lighthouse-ci did not produce a local JSON artifact"
                else:
                    result["status"] = "findings" if finding_count else ("clean" if completed.returncode == 0 else "error")
            else:
                result["status"] = "clean" if completed.returncode == 0 else "error"
    except Blocked as exc:
        result["status"] = "blocked"
        result["reason"] = redact(str(exc))
    except (OSError, ValueError, KeyError, json.JSONDecodeError, ET.ParseError, subprocess.TimeoutExpired) as exc:
        result["status"] = "error"
        result["reason"] = redact(f"{type(exc).__name__}: {exc}")
    result["timestamps"]["finished_at"] = iso(utc_now())
    safe_result = redact_result(result)
    result_path.write_text(json.dumps(safe_result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return safe_result, result_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tool", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--install-local", action="store_true")
    parser.add_argument("--authorization")
    args = parser.parse_args(argv)
    try:
        result, result_path = run(args.tool, args.config, args.project_root, args.preflight, args.install_local, args.authorization)
    except (OSError, ValueError) as exc:
        print(json.dumps({"status": "error", "reason": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps({"status": result["status"], "result": str(result_path)}, ensure_ascii=False))
    if result["status"] in {"clean", "findings"}:
        return 0
    if result["status"] == "blocked":
        return 3
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

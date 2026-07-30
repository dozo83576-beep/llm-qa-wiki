"""
Build a corpus snapshot for the wiki.

Walks the configured content roots, parses front matter, chunks by `##` / `###`
headings, computes sha256 per chunk, and writes:

- embeddings/snapshot.jsonl  (one chunk per line; vectors only in openai-embeddings mode)
- embeddings/manifest.json   (corpus-level hash + counts; always written)

Usage:
    python tools/build_embeddings.py
    python tools/build_embeddings.py --mode offline-text
    OPENAI_API_KEY=sk-... python tools/build_embeddings.py --mode openai-embeddings
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator

try:
    import frontmatter  # python-frontmatter
    _HAS_FRONTMATTER = True
except ImportError:
    _HAS_FRONTMATTER = False


class _FallbackPost:
    """Stand-in for frontmatter.Post when python-frontmatter is unavailable."""
    __slots__ = ("metadata", "content")

    def __init__(self, metadata: dict, content: str):
        self.metadata = metadata
        self.content = content


def _parse_frontmatter_fallback(text: str) -> _FallbackPost:
    """Regex-based YAML front-matter parser supporting the subset used in this wiki:
    string scalars (quoted or unquoted) and flow-style lists `[a, b, c]`.
    """
    meta: dict = {}
    body = text
    m = re.match(r"^---\s*\r?\n(.*?)\r?\n---\s*\r?\n?(.*)$", text, flags=re.DOTALL)
    if m:
        fm_raw = m.group(1)
        body = m.group(2)
        for line in fm_raw.splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            kv = re.match(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$", line)
            if not kv:
                continue
            key = kv.group(1)
            value = kv.group(2).strip()
            if value.startswith("[") and value.endswith("]"):
                inner = value[1:-1]
                parts = [p.strip().strip('"').strip("'") for p in inner.split(",") if p.strip()]
                meta[key] = parts
            else:
                meta[key] = value.strip('"').strip("'")
    return _FallbackPost(meta, body)

EMBED_MODEL_DEFAULT = "text-embedding-3-small"
RETRIEVAL_MODE_OFFLINE = "offline-text"
RETRIEVAL_MODE_OPENAI = "openai-embeddings"

CONTENT_ROOTS = [
    "docs",
    "patterns",
    "prompts",
    "checklists",
    "bug-taxonomy",
    "case-studies",
    "lessons-learned",
]

# Files to exclude from indexing: redirect stubs are caught by status check;
# templates are caught by filename pattern.
EXCLUDED_NAMES = {"INDEX.md"}


@dataclass
class Chunk:
    chunk_id: str
    path: str
    title: str
    section_path: list[str]
    category: str | None
    tags: list[str]
    updated: str | None
    source_priority: str | None
    status: str | None
    sha256: str
    text: str
    embedding: list[float] | None = None


def is_template(name: str) -> bool:
    return name.startswith("_template") or name == "_template.md"


def discover_files(root: Path) -> Iterator[Path]:
    for cr in CONTENT_ROOTS:
        base = root / cr
        if not base.exists():
            continue
        for md in base.rglob("*.md"):
            if md.name in EXCLUDED_NAMES:
                continue
            if is_template(md.name):
                continue
            yield md


def slugify(s: str) -> str:
    s = s.strip().lower()
    s = re.sub(r"[^\w\s-]", "", s, flags=re.UNICODE)
    s = re.sub(r"[\s-]+", "-", s)
    return s.strip("-")[:80]


def chunk_document(text: str) -> list[tuple[list[str], str]]:
    """Split body by `##` / `###` headings; returns list of (section_path, content)."""
    lines = text.splitlines()
    chunks: list[tuple[list[str], str]] = []
    current_h2 = ""
    current_h3 = ""
    buf: list[str] = []

    def flush():
        nonlocal buf
        content = "\n".join(buf).strip()
        if not content:
            buf = []
            return
        path = [p for p in [current_h2, current_h3] if p]
        if not path:
            path = ["__intro__"]
        chunks.append((path, content))
        buf = []

    for line in lines:
        if line.startswith("## ") and not line.startswith("### "):
            flush()
            current_h2 = line[3:].strip()
            current_h3 = ""
            buf.append(line)
        elif line.startswith("### "):
            flush()
            current_h3 = line[4:].strip()
            buf.append(line)
        else:
            buf.append(line)
    flush()
    return chunks


def parse_file(path: Path, root: Path) -> tuple[dict, str] | None:
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as e:
        print(f"warn: failed to read {path}: {e}", file=sys.stderr)
        return None
    try:
        if _HAS_FRONTMATTER:
            post = frontmatter.loads(text)
        else:
            post = _parse_frontmatter_fallback(text)
    except Exception as e:
        print(f"warn: failed to parse front matter in {path}: {e}", file=sys.stderr)
        return None
    meta = dict(post.metadata or {})
    # Filter out drafts and archived from the index
    status = (meta.get("status") or "").lower()
    if status in {"draft", "archived", "redirect"}:
        return None
    return meta, post.content


def build_chunks(root: Path) -> list[Chunk]:
    chunks: list[Chunk] = []
    for fp in discover_files(root):
        parsed = parse_file(fp, root)
        if parsed is None:
            continue
        meta, body = parsed
        rel = fp.relative_to(root).as_posix()
        title = str(meta.get("title") or fp.stem)
        category = meta.get("category")
        tags = list(meta.get("tags") or [])
        updated = meta.get("updated")
        source_priority = meta.get("source_priority")
        status = meta.get("status")
        for section_path, content in chunk_document(body):
            full_text = f"# {title}\n\n{' > '.join(section_path)}\n\n{content}".strip()
            sha = hashlib.sha256(full_text.encode("utf-8")).hexdigest()
            slug = "-".join(slugify(p) for p in section_path) or "intro"
            chunk_id = f"{rel}#{slug}"
            chunks.append(Chunk(
                chunk_id=chunk_id,
                path=rel,
                title=title,
                section_path=section_path,
                category=str(category) if category else None,
                tags=[str(t) for t in tags],
                updated=str(updated) if updated else None,
                source_priority=str(source_priority) if source_priority else None,
                status=str(status) if status else None,
                sha256=sha,
                text=full_text,
            ))
    return chunks


def load_cache(cache_path: Path) -> dict[str, list[float]]:
    if not cache_path.exists():
        return {}
    cache: dict[str, list[float]] = {}
    with cache_path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "sha256" in rec and "embedding" in rec and isinstance(rec["embedding"], list):
                cache[rec["sha256"]] = rec["embedding"]
    return cache


def embed_chunks(chunks: list[Chunk], model: str, batch_size: int, cache: dict[str, list[float]]) -> None:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("OPENAI_API_KEY not set — cannot run openai-embeddings mode.", file=sys.stderr)
        sys.exit(3)
    try:
        from openai import OpenAI
    except ImportError:
        print("Missing dependency: openai (pip install -r tools/requirements.txt)", file=sys.stderr)
        sys.exit(2)

    client = OpenAI(api_key=api_key)
    # Apply cache first
    for ch in chunks:
        if ch.sha256 in cache:
            ch.embedding = cache[ch.sha256]
    pending = [ch for ch in chunks if ch.embedding is None]
    print(f"Embedding {len(pending)} of {len(chunks)} chunks (cache hits: {len(chunks) - len(pending)})")
    for i in range(0, len(pending), batch_size):
        batch = pending[i:i + batch_size]
        inputs = [ch.text for ch in batch]
        resp = client.embeddings.create(model=model, input=inputs)
        for ch, item in zip(batch, resp.data):
            ch.embedding = item.embedding


def corpus_hash(chunks: list[Chunk]) -> str:
    h = hashlib.sha256()
    for ch in sorted(chunks, key=lambda c: c.chunk_id):
        h.update(ch.chunk_id.encode("utf-8"))
        h.update(b":")
        h.update(ch.sha256.encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


def write_snapshot(chunks: list[Chunk], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        for ch in sorted(chunks, key=lambda c: c.chunk_id):
            rec = asdict(ch)
            f.write(json.dumps(rec, ensure_ascii=False))
            f.write("\n")


def _load_existing_manifest(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def _manifest_content_matches(existing: dict, candidate: dict) -> bool:
    stable_keys = (
        "embedding_model",
        "corpus_hash",
        "chunk_count",
        "files_indexed",
        "has_vectors",
        "retrieval_mode",
    )
    return all(existing.get(key) == candidate.get(key) for key in stable_keys)


def write_manifest(chunks: list[Chunk], model: str, out_path: Path, retrieval_mode: str, has_vectors: bool) -> None:
    manifest = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "embedding_model": model if has_vectors else None,
        "corpus_hash": corpus_hash(chunks),
        "chunk_count": len(chunks),
        "files_indexed": sorted({c.path for c in chunks}),
        "has_vectors": has_vectors,
        "retrieval_mode": retrieval_mode,
    }
    existing = _load_existing_manifest(out_path)
    if existing and _manifest_content_matches(existing, manifest):
        generated_at = existing.get("generated_at")
        if isinstance(generated_at, str) and generated_at:
            manifest["generated_at"] = generated_at

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Build corpus snapshot for wiki retrieval.")
    parser.add_argument("--root", default=".", help="Repository root.")
    parser.add_argument("--model", default=EMBED_MODEL_DEFAULT, help="Embedding model.")
    parser.add_argument("--mode", choices=[RETRIEVAL_MODE_OFFLINE, RETRIEVAL_MODE_OPENAI], default=RETRIEVAL_MODE_OFFLINE)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--snapshot", default="embeddings/snapshot.jsonl")
    parser.add_argument("--manifest", default="embeddings/manifest.json")
    args = parser.parse_args(argv)

    root = Path(args.root).resolve()
    snapshot_path = root / args.snapshot
    manifest_path = root / args.manifest

    cache = load_cache(snapshot_path)
    chunks = build_chunks(root)
    print(f"Discovered {len(chunks)} chunks across {len({c.path for c in chunks})} files.")

    has_vectors = False
    if args.mode == RETRIEVAL_MODE_OPENAI:
        embed_chunks(chunks, args.model, args.batch_size, cache)
        has_vectors = True

    write_snapshot(chunks, snapshot_path)
    write_manifest(chunks, args.model, manifest_path, retrieval_mode=args.mode, has_vectors=has_vectors)
    print(f"Wrote {snapshot_path.relative_to(root)} and {manifest_path.relative_to(root)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

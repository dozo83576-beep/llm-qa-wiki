"""
ask-wiki — runtime CLI: query the wiki corpus snapshot with BM25 (offline).

Lets an agent pull relevant wiki docs, patterns, checklists and lessons-learned
mid-project instead of navigating by hardcoded links. Same scoring core as the
CI retrieval evals (tools/retrieval_lib.py), so quality is continuously gated
by golden-qa.yaml.

Usage:
    python tools/ask_wiki.py "WooCommerce маркетплейс комиссия" [--top 5]
    pwsh tools/ask-wiki.ps1 "..."   # wrapper with UTF-8/python discovery

No network access or API keys.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from retrieval_lib import (
    build_index,
    load_snapshot,
    load_synonyms,
    score_query_chunks,
)


def make_snippet(text: str, limit: int = 120) -> str:
    flat = " ".join(text.split())
    if len(flat) <= limit:
        return flat
    return flat[: limit - 1].rstrip() + "…"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Query the wiki corpus snapshot (offline BM25).")
    parser.add_argument("query", help="Свободный запрос: тема + контекст, напр. 'граничные значения форма регистрации'")
    parser.add_argument("--top", type=int, default=5, help="Сколько результатов показать (default 5)")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parent.parent))
    parser.add_argument("--snapshot", default="embeddings/snapshot.jsonl")
    parser.add_argument("--synonyms", default="resources/retrieval-synonyms.yaml")
    args = parser.parse_args(argv)

    root = Path(args.root).resolve()
    snapshot_path = root / args.snapshot

    if not snapshot_path.exists():
        print(f"snapshot not found: {snapshot_path}", file=sys.stderr)
        print("build it first: python tools/build_embeddings.py", file=sys.stderr)
        return 2

    chunks = load_snapshot(snapshot_path)
    if not chunks:
        print("snapshot is empty", file=sys.stderr)
        return 2

    synonyms = load_synonyms(root / args.synonyms)
    docs, doc_freq, avg_len = build_index(chunks)
    ranked = score_query_chunks(args.query, chunks, docs, doc_freq, avg_len, synonyms)

    if not ranked:
        print("Ничего не найдено — переформулируй запрос (тема + стек).")
        return 1

    # One result per path (best chunk wins) so top-N covers N distinct docs.
    seen_paths: set[str] = set()
    results = []
    for chunk, score in ranked:
        if chunk.path in seen_paths:
            continue
        seen_paths.add(chunk.path)
        results.append((chunk, score))
        if len(results) >= args.top:
            break

    mtime = _dt.datetime.fromtimestamp(snapshot_path.stat().st_mtime)
    print(f"corpus as of {mtime:%Y-%m-%d %H:%M} | chunks: {len(chunks)} | query: {args.query}")
    print()
    for rank, (chunk, score) in enumerate(results, start=1):
        section = " > ".join(chunk.section_path) if chunk.section_path else chunk.title
        print(f"{rank}. [{score:.2f}] {chunk.path}")
        if section:
            print(f"   § {section}")
        print(f"   {make_snippet(chunk.text)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

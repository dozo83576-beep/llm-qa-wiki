"""
Offline retrieval evaluation against golden Q&A.

Uses the text-only corpus snapshot from tools/build_embeddings.py and a local
BM25-style scorer. No network access or external API keys are required.

Usage:
    python tools/build_embeddings.py
    python tools/run_offline_retrieval_evals.py --min-precision 0.6 --top-k 5 --warn-rank 3
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("Missing dependency: pyyaml (pip install -r tools/requirements.txt)", file=sys.stderr)
    sys.exit(2)

# Shared BM25 core lives in retrieval_lib.py (also consumed by ask_wiki.py) —
# scoring changes must go there so CI evals and the runtime CLI never diverge.
from retrieval_lib import (  # noqa: F401  (re-exported for tests)
    Chunk,
    build_index,
    expand_query_tokens,
    load_snapshot,
    load_synonyms,
    score_query,
    tokenize,
)


def load_questions(path: Path) -> list[dict]:
    raw = path.read_text(encoding="utf-8")
    if raw.startswith("---"):
        parts = raw.split("---", 2)
        if len(parts) >= 3:
            raw = parts[2]
    data = yaml.safe_load(raw) or {}
    questions = data.get("questions") or []
    if not isinstance(questions, list):
        raise ValueError("golden Q&A field 'questions' must be a list")
    return questions


def validate_questions(questions: list[dict], root: Path) -> list[str]:
    errors: list[str] = []
    seen_ids: set[str] = set()

    for index, item in enumerate(questions, start=1):
        if not isinstance(item, dict):
            errors.append(f"question {index} must be an object")
            continue

        qid = str(item.get("id") or "").strip()
        question = str(item.get("question") or "").strip()
        expected_paths = item.get("expected_paths") or []

        if not qid:
            errors.append(f"question {index} missing id")
        elif qid in seen_ids:
            errors.append(f"duplicate question id: {qid}")
        else:
            seen_ids.add(qid)

        if not question:
            errors.append(f"question {qid or index} missing question text")

        if not isinstance(expected_paths, list) or not expected_paths:
            errors.append(f"question {qid or index} must define non-empty expected_paths")
            continue

        for raw_path in expected_paths:
            rel_path = str(raw_path or "").strip()
            if not rel_path:
                errors.append(f"question {qid or index} has empty expected path")
                continue
            if (root / rel_path).exists():
                continue
            errors.append(f"question {qid or index} references missing expected path: {rel_path}")

    return errors


def find_best_expected_rank(ranked: list[tuple[str, float]], expected_paths: list[str]) -> int | None:
    ranks = {path: index + 1 for index, (path, _) in enumerate(ranked)}
    expected_ranks = [ranks[path] for path in expected_paths if path in ranks]
    if not expected_ranks:
        return None
    return min(expected_ranks)


def render_report(rows: list[dict], top_k: int, min_precision: float, precision: float, warn_rank: int, weak_count: int) -> str:
    weak_rows = [row for row in rows if row["weak"]]
    missing_rows = [row for row in rows if row["best_expected_rank"] is None]
    lines = [
        "# Offline retrieval evals",
        "",
        f"- Mode: offline-text",
        f"- Questions: {len(rows)}",
        f"- Precision@{top_k}: {precision:.3f}",
        f"- Minimum precision: {min_precision:.3f}",
        f"- Weak rank threshold: {warn_rank}",
        f"- Weak rank warnings: {weak_count}",
        f"- Missing expected paths: {len(missing_rows)}",
        "",
    ]
    if weak_rows:
        lines.extend([
            "## Weak queries",
            "",
        ])
        for row in weak_rows:
            lines.append(f"- {row['id']}: best expected rank {row['best_expected_rank']}")
        lines.append("")

    if missing_rows:
        lines.extend([
            "## Missing expected paths",
            "",
        ])
        for row in missing_rows:
            lines.append(f"- {row['id']}: {', '.join(row['expected_paths'])}")
        lines.append("")

    lines.extend([
        "| ID | Pass | Weak | Best expected rank | Expected | Top results |",
        "|---|---:|---:|---:|---|---|",
    ])
    for row in rows:
        expected = "<br>".join(row["expected_paths"])
        top = "<br>".join(f"{path} ({score:.3f})" for path, score in row["top_results"])
        best_rank = row["best_expected_rank"] if row["best_expected_rank"] is not None else "-"
        lines.append(f"| {row['id']} | {'yes' if row['passed'] else 'no'} | {'yes' if row['weak'] else 'no'} | {best_rank} | {expected} | {top} |")
    lines.append("")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Run offline retrieval evals on golden Q&A.")
    parser.add_argument("--root", default=".")
    parser.add_argument("--snapshot", default="embeddings/snapshot.jsonl")
    parser.add_argument("--golden", default="resources/golden-qa.yaml")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--top-k-strict", type=int, default=10)
    parser.add_argument("--min-precision", type=float, default=0.6)
    parser.add_argument("--warn-rank", type=int, default=3)
    parser.add_argument("--synonyms", default="resources/retrieval-synonyms.yaml")
    parser.add_argument("--report", default="evals-report.md")
    args = parser.parse_args(argv)

    root = Path(args.root).resolve()
    snapshot_path = root / args.snapshot
    golden_path = root / args.golden
    synonyms_path = root / args.synonyms
    report_path = root / args.report

    if not snapshot_path.exists():
        print(f"snapshot not found: {snapshot_path}", file=sys.stderr)
        return 2
    if not golden_path.exists():
        print(f"golden Q&A not found: {golden_path}", file=sys.stderr)
        return 2

    chunks = load_snapshot(snapshot_path)
    questions = load_questions(golden_path)
    synonyms = load_synonyms(synonyms_path)
    if not chunks:
        print("snapshot is empty", file=sys.stderr)
        return 2
    if not questions:
        print("no questions in golden set", file=sys.stderr)
        return 2
    question_errors = validate_questions(questions, root)
    if question_errors:
        for error in question_errors:
            print(f"golden Q&A validation error: {error}", file=sys.stderr)
        return 2

    docs, doc_freq, avg_len = build_index(chunks)
    rows: list[dict] = []
    passed = 0
    weak_warnings: list[str] = []
    strict_failures: list[str] = []

    for item in questions:
        qid = str(item.get("id") or "")
        question = str(item.get("question") or "")
        expected_paths = [str(path) for path in item.get("expected_paths") or []]
        ranked = score_query(question, chunks, docs, doc_freq, avg_len, synonyms)
        top = ranked[:args.top_k]
        strict_top_paths = {path for path, _ in ranked[:args.top_k_strict]}
        hit = any(path in {p for p, _ in top} for path in expected_paths)
        best_expected_rank = find_best_expected_rank(ranked, expected_paths)
        weak = bool(best_expected_rank and best_expected_rank > args.warn_rank)
        if hit:
            passed += 1
        if weak:
            weak_warnings.append(f"{qid} rank {best_expected_rank}")
        if expected_paths and not any(path in strict_top_paths for path in expected_paths):
            strict_failures.append(qid)
        rows.append({
            "id": qid,
            "passed": hit,
            "weak": weak,
            "best_expected_rank": best_expected_rank,
            "expected_paths": expected_paths,
            "top_results": top,
        })

    precision = passed / len(questions)
    report = render_report(rows, args.top_k, args.min_precision, precision, args.warn_rank, len(weak_warnings))
    report_path.write_text(report, encoding="utf-8")
    print(report)
    if weak_warnings:
        print(f"weak expected ranks above {args.warn_rank}: {', '.join(weak_warnings)}", file=sys.stderr)

    if precision < args.min_precision:
        print(f"precision@{args.top_k} below threshold: {precision:.3f} < {args.min_precision:.3f}", file=sys.stderr)
        return 1
    if strict_failures:
        print(f"expected paths missing from top-{args.top_k_strict}: {', '.join(strict_failures)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

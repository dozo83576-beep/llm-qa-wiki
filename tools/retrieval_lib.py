"""
Shared offline retrieval library (BM25-style) over the wiki corpus snapshot.

Single source of truth for tokenization, snapshot loading, index building and
query scoring. Consumers:
  - tools/run_offline_retrieval_evals.py (CI quality gate on golden Q&A)
  - tools/ask_wiki.py (runtime CLI: agents query the wiki mid-project)

No network access or API keys. Corpus: embeddings/snapshot.jsonl built by
tools/build_embeddings.py (includes docs/, patterns/, prompts/, checklists/,
bug-taxonomy/, lessons-learned/, case-studies/).
"""
from __future__ import annotations

import json
import math
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

TOKEN_RE = re.compile(r"[a-zA-Zа-яА-ЯёЁ0-9][a-zA-Zа-яА-ЯёЁ0-9_-]*", re.UNICODE)

STOPWORDS = {
    "a", "an", "and", "are", "as", "by", "for", "from", "how", "in", "is", "of", "or", "the", "to", "with",
    "без", "в", "где", "для", "и", "из", "как", "какая", "какие", "какой", "когда", "ли", "на", "нужна",
    "нужно", "от", "по", "перед", "при", "с", "что",
    # Частотные служебные слова русских запросов: встречаются почти в каждом документе
    # и тянут выдачу в сторону длинных текстов вместо релевантных.
    "не", "но", "или", "если", "это", "так", "то", "же", "бы", "уже", "ещё", "еще",
    "есть", "быть", "надо", "делать", "сделать", "можно", "нельзя", "чем", "чтобы",
    "его", "их", "она", "они", "оно", "мы", "вы", "я", "все", "всё", "весь",
    "за", "до", "об", "о", "у", "к", "во", "со", "над", "под", "про", "меж",
}


@dataclass(frozen=True)
class Chunk:
    path: str
    chunk_id: str
    text: str
    title: str
    category: str
    tags: tuple[str, ...]
    section_path: tuple[str, ...]


def tokenize(text: str) -> list[str]:
    tokens = [m.group(0).lower().replace("ё", "е") for m in TOKEN_RE.finditer(text)]
    return [t for t in tokens if len(t) > 1 and t not in STOPWORDS]


def load_synonyms(path: Path) -> dict[str, list[str]]:
    if not path.exists():
        print(f"synonyms file not found, continuing without synonyms: {path}", file=sys.stderr)
        return {}

    try:
        import yaml
    except ImportError:
        print("pyyaml not installed, continuing without synonyms", file=sys.stderr)
        return {}

    raw = path.read_text(encoding="utf-8")
    if raw.startswith("---"):
        parts = raw.split("---", 2)
        if len(parts) >= 3:
            raw = parts[2]

    data = yaml.safe_load(raw) or {}
    raw_synonyms = data.get("synonyms") or {}
    if not isinstance(raw_synonyms, dict):
        print(f"synonyms file has invalid 'synonyms' section, continuing without synonyms: {path}", file=sys.stderr)
        return {}

    synonyms: dict[str, list[str]] = {}
    for key, values in raw_synonyms.items():
        key_tokens = tokenize(str(key))
        if not key_tokens:
            continue
        if isinstance(values, str):
            value_items = [values]
        elif isinstance(values, list):
            value_items = values
        else:
            continue

        expanded_values: list[str] = []
        for value in value_items:
            expanded_values.extend(tokenize(str(value)))
        if expanded_values:
            synonyms[key_tokens[0]] = expanded_values
    return synonyms


def expand_query_tokens(tokens: list[str], synonyms: dict[str, list[str]]) -> list[str]:
    expanded = list(tokens)
    for token in tokens:
        expanded.extend(synonyms.get(token, []))
    return expanded


def load_snapshot(path: Path) -> list[Chunk]:
    chunks: list[Chunk] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            chunks.append(Chunk(
                path=str(rec["path"]),
                chunk_id=str(rec["chunk_id"]),
                title=str(rec.get("title") or ""),
                category=str(rec.get("category") or ""),
                tags=tuple(str(tag) for tag in (rec.get("tags") or [])),
                section_path=tuple(str(section) for section in (rec.get("section_path") or [])),
                text=str(rec.get("text") or ""),
            ))
    return chunks


def build_index(chunks: list[Chunk]) -> tuple[list[Counter], dict[str, int], float]:
    docs: list[Counter] = []
    doc_freq: dict[str, int] = defaultdict(int)
    total_len = 0

    for chunk in chunks:
        metadata_text = " ".join([
            chunk.title,
            chunk.title,
            chunk.title,
            chunk.path,
            chunk.path,
            chunk.category,
            " ".join(chunk.tags),
            " ".join(chunk.tags),
            " ".join(chunk.section_path),
            " ".join(chunk.section_path),
        ])
        weighted_text = f"{metadata_text} {chunk.text}"
        counts = Counter(tokenize(weighted_text))
        docs.append(counts)
        total_len += sum(counts.values())
        for token in counts:
            doc_freq[token] += 1

    avg_len = total_len / max(len(docs), 1)
    return docs, dict(doc_freq), avg_len


def score_query(query: str, chunks: list[Chunk], docs: list[Counter], doc_freq: dict[str, int], avg_len: float, synonyms: dict[str, list[str]]) -> list[tuple[str, float]]:
    query_tokens = expand_query_tokens(tokenize(query), synonyms)
    if not query_tokens:
        return []

    n_docs = len(docs)
    k1 = 1.5
    b = 0.75
    path_scores: dict[str, float] = defaultdict(float)

    for chunk, counts in zip(chunks, docs):
        doc_len = sum(counts.values()) or 1
        score = 0.0
        for token in query_tokens:
            tf = counts.get(token, 0)
            if tf == 0:
                continue
            df = doc_freq.get(token, 0)
            idf = math.log(1 + (n_docs - df + 0.5) / (df + 0.5))
            denom = tf + k1 * (1 - b + b * doc_len / max(avg_len, 1e-9))
            score += idf * (tf * (k1 + 1) / denom)

        if score > path_scores[chunk.path]:
            path_scores[chunk.path] = score

    return sorted(path_scores.items(), key=lambda item: (-item[1], item[0]))


def score_query_chunks(query: str, chunks: list[Chunk], docs: list[Counter], doc_freq: dict[str, int], avg_len: float, synonyms: dict[str, list[str]]) -> list[tuple[Chunk, float]]:
    """Chunk-level variant of score_query: returns best-scoring chunks (not
    collapsed by path). Used by ask_wiki.py to show relevant snippets."""
    query_tokens = expand_query_tokens(tokenize(query), synonyms)
    if not query_tokens:
        return []

    n_docs = len(docs)
    k1 = 1.5
    b = 0.75
    scored: list[tuple[Chunk, float]] = []

    for chunk, counts in zip(chunks, docs):
        doc_len = sum(counts.values()) or 1
        score = 0.0
        for token in query_tokens:
            tf = counts.get(token, 0)
            if tf == 0:
                continue
            df = doc_freq.get(token, 0)
            idf = math.log(1 + (n_docs - df + 0.5) / (df + 0.5))
            denom = tf + k1 * (1 - b + b * doc_len / max(avg_len, 1e-9))
            score += idf * (tf * (k1 + 1) / denom)
        if score > 0:
            scored.append((chunk, score))

    scored.sort(key=lambda item: (-item[1], item[0].path, item[0].chunk_id))
    return scored

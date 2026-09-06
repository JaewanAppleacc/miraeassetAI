"""DocumentIR 4파일 위의 byte-offset 색인 — 8GB를 메모리에 올리지 않고 문서·노드를 꺼낸다.

왜 필요한가:
  Stage 2(ChunkIndex)는 `docs_by_id[doc_id]`로 문서를 받아 그 자리에서 청킹한다. 예전에는
  후보 문서만 모은 evidence_documents.jsonl(28MB)을 통째로 메모리에 올렸다. 전체 코퍼스
  (DocumentIR 4,204건·8GB)에는 그 방식이 안 통한다. 여기서는 문서마다 (파일, offset, 길이)만
  들고 있다가 필요한 문서만 그 지점에서 읽는다. 새 대용량 파일을 만들지 않는다(저장공간 원칙).

두 가지 형식:
  raw DocumentIR    parser가 쓴 그대로. 노드에 raw_cells·raw_rows(크기의 89%)가 있다.
  evidence document 청킹·근거 선택이 읽는 가공 형식(옛 evidence_documents.jsonl과 동일):
      {"doc_id", "doc_group", "nodes": [{"node_index", "kind", "text", "section_hierarchy"}]}
  변환은 `node_dict_to_text`가 한다 — `dart_corpus.chunking.node_text.node_to_text`와 같은 규칙을
  IR 객체 없이 dict 위에서 수행한다(raw_cells 객체화를 피해 메모리·시간을 아낀다). 두 함수의
  동치는 테스트(tests/retrieval/test_node_store.py)가 대표 문서 11건으로 잠근다.

node_index = DocumentIR `nodes[]`의 0-based 위치. Gold locator의 `#node=N`·`::nN`과 같은 번호다.

색인 파일(`data/index/`, git 제외 · `scripts/build_index.py`로 재생성):
  node_offsets.jsonl   {"doc_id", "file", "offset", "length", "n_nodes"}
  index_manifest.json  DocumentIR 4파일의 SHA-256·크기·문서 수, manifest SHA, 빌드 파라미터
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from collections import OrderedDict
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

DOC_GROUPS = ("exchange", "holding", "major", "periodic")
OFFSETS_NAME = "node_offsets.jsonl"
MANIFEST_NAME = "index_manifest.json"
DOC_INDEX_NAME = "doc_index.jsonl"
TEXT_RECIPE = "node_texts_joined_v1"     # doc_index.text 생성 규칙 이름. 바꾸면 버전을 올린다.
DEFAULT_TEXT_CAP = 3000                  # DocumentIndex.from_jsonl(text_cap=3000)과 같다.
DEFAULT_CACHE_SIZE = 32                  # 파싱된 evidence document LRU. Stage 1 k=50이면 재읽기 일부 발생.


def default_document_ir_dir() -> Path:
    env = os.environ.get("DART_QA_DOCUMENT_IR_DIR")
    return Path(env) if env else Path.home() / "Desktop" / "document_ir"


# ---------- raw node dict -> 텍스트 (node_text.node_to_text와 같은 규칙) ----------

def table_dict_to_text(node: dict) -> str:
    lines: list[str] = []
    if node.get("title_confirmed") and node.get("normalized_title_guess"):
        lines.append(str(node["normalized_title_guess"]).strip())
    rows = node.get("normalized_rows") or [
        [str(c.get("text", "")) for c in row] for row in (node.get("raw_rows") or [])
    ]
    for row in rows:
        lines.append(" | ".join(str(cell).strip() for cell in row))
    return "\n".join(lines)


def node_dict_to_text(node: dict) -> str:
    kind = node.get("kind")
    if kind == "section":
        return str(node.get("title_text") or "").strip()
    if kind == "paragraph":
        return str(node.get("text") or "").strip()
    if kind == "table":
        return table_dict_to_text(node).strip()
    return ""


def to_evidence_document(raw: dict, doc_group: str | None = None) -> dict:
    """raw DocumentIR dict -> evidence document. 노드마다 node_index·kind·text·section_hierarchy만."""
    doc_id = raw["doc_id"]
    group = doc_group or doc_id.split("_", 1)[0]
    nodes = []
    for i, n in enumerate(raw.get("nodes") or []):
        nodes.append({
            "node_index": i,
            "kind": n.get("kind"),
            "text": node_dict_to_text(n),
            "section_hierarchy": list(n.get("section_hierarchy") or []),
        })
    return {"doc_id": doc_id, "doc_group": group, "nodes": nodes}


# ---------- 색인 ----------

@dataclass(frozen=True)
class DocLocation:
    file: str
    offset: int
    length: int
    n_nodes: int


class NodeStore(Mapping):
    """doc_id -> evidence document. `docs_by_id`로 CorpusRetriever에 그대로 꽂힌다."""

    def __init__(self, index_dir: Path | str, document_ir_dir: Path | str | None = None,
                 cache_size: int = DEFAULT_CACHE_SIZE):
        self.index_dir = Path(index_dir)
        self.manifest = json.loads((self.index_dir / MANIFEST_NAME).read_text(encoding="utf-8"))
        self.document_ir_dir = Path(document_ir_dir or self.manifest.get("document_ir_dir")
                                    or default_document_ir_dir())
        self._locations: dict[str, DocLocation] = {}
        with (self.index_dir / OFFSETS_NAME).open(encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    d = json.loads(line)
                    self._locations[d["doc_id"]] = DocLocation(
                        d["file"], int(d["offset"]), int(d["length"]), int(d["n_nodes"]))
        self._cache: OrderedDict[str, dict] = OrderedDict()
        self.cache_size = cache_size
        self._handles: dict[str, Any] = {}
        self.verify_files()

    # ----- 무결성 -----
    def verify_files(self) -> None:
        """파일 크기가 빌드 당시와 같은지 확인한다(SHA 전체 재계산은 8GB라 하지 않는다)."""
        for name, info in (self.manifest.get("files") or {}).items():
            path = self.document_ir_dir / name
            if not path.exists():
                raise FileNotFoundError(f"DocumentIR 파일이 없다: {path}")
            actual = path.stat().st_size
            if actual != info.get("bytes"):
                raise RuntimeError(
                    f"{name} 크기가 색인과 다르다: {actual} != {info.get('bytes')} — "
                    "scripts/build_index.py로 색인을 다시 만들어라")

    def readiness(self) -> dict[str, Any]:
        return {
            "n_docs": len(self._locations),
            "document_ir_dir": str(self.document_ir_dir),
            "pins": {
                "document_ir": {k: v.get("sha256") for k, v in (self.manifest.get("files") or {}).items()},
                "manifest_sha256": self.manifest.get("manifest_sha256"),
                "text_recipe": self.manifest.get("text_recipe"),
                "text_cap": self.manifest.get("text_cap"),
            },
        }

    # ----- 읽기 -----
    def location(self, doc_id: str) -> DocLocation:
        return self._locations[doc_id]

    def _handle(self, name: str):
        h = self._handles.get(name)
        if h is None:
            h = (self.document_ir_dir / name).open("rb")
            self._handles[name] = h
        return h

    def get_raw(self, doc_id: str) -> dict:
        loc = self._locations[doc_id]
        h = self._handle(loc.file)
        # pread: 오프셋 지정 원자 읽기 — seek/read 쌍은 공유 핸들에서 스레드가 겹치면
        # 커서가 밀려 다른 문서의 바이트를 읽는다(클라이언트 단절 후 좀비 스레드와
        # 재시도 요청이 겹치는 시나리오, 리허설 1차에서 겹침 실재 확인 — 검수 발견 9).
        data = os.pread(h.fileno(), loc.length, loc.offset)
        return json.loads(data)

    def get_document(self, doc_id: str) -> dict:
        cached = self._cache.get(doc_id)
        if cached is not None:
            self._cache.move_to_end(doc_id)
            return cached
        doc = to_evidence_document(self.get_raw(doc_id))
        self._cache[doc_id] = doc
        if len(self._cache) > self.cache_size:
            self._cache.popitem(last=False)
        return doc

    def fetch_node(self, doc_id: str, node_index: int) -> dict:
        """근거 확정용 원문 역참조(retriever_adapter.fetch_node)."""
        doc = self.get_document(doc_id)
        nodes = doc["nodes"]
        if not 0 <= node_index < len(nodes):
            raise KeyError(f"{doc_id}에 node {node_index}가 없다 (노드 {len(nodes)}개)")
        node = nodes[node_index]
        return {"doc_id": doc_id, "doc_group": doc["doc_group"], **node,
                "lines": node["text"].split("\n") if node["text"] else []}

    # ----- Mapping -----
    def __getitem__(self, doc_id: str) -> dict:
        if doc_id not in self._locations:
            raise KeyError(doc_id)
        return self.get_document(doc_id)

    def __contains__(self, doc_id: object) -> bool:
        return doc_id in self._locations

    def __iter__(self) -> Iterator[str]:
        return iter(self._locations)

    def __len__(self) -> int:
        return len(self._locations)

    def close(self) -> None:
        for h in self._handles.values():
            h.close()
        self._handles.clear()


# ---------- 빌드 ----------

def _iter_lines_with_offsets(path: Path):
    """(offset, raw_bytes) — f.tell()은 readline 직전에만 믿을 수 있다."""
    with path.open("rb") as f:
        while True:
            pos = f.tell()
            line = f.readline()
            if not line:
                break
            if line.strip():
                yield pos, line


def build_index(document_ir_dir: Path | str, manifest_path: Path | str, out_dir: Path | str, *,
                text_cap: int = DEFAULT_TEXT_CAP, groups: tuple[str, ...] = DOC_GROUPS,
                progress=None) -> dict[str, Any]:
    """한 번의 스트리밍 패스로 offsets + doc_index + 파일 SHA를 만든다. 메모리는 문서 한 건."""
    document_ir_dir = Path(document_ir_dir)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest_bytes = Path(manifest_path).read_bytes()
    meta_by_id: dict[str, dict] = {}
    for line in manifest_bytes.decode("utf-8").splitlines():
        if line.strip():
            row = json.loads(line)
            meta_by_id[row["doc_id"]] = row

    offsets_tmp = out_dir / (OFFSETS_NAME + ".tmp")
    index_tmp = out_dir / (DOC_INDEX_NAME + ".tmp")
    files_info: dict[str, dict[str, Any]] = {}
    n_docs = 0
    missing_meta: list[str] = []
    t0 = time.perf_counter()

    with offsets_tmp.open("w", encoding="utf-8") as fo, index_tmp.open("w", encoding="utf-8") as fi:
        for group in groups:
            name = f"{group}.jsonl"
            path = document_ir_dir / name
            if not path.exists():
                raise FileNotFoundError(f"DocumentIR 파일이 없다: {path}")
            sha = hashlib.sha256()
            n_in_file = 0
            for offset, raw in _iter_lines_with_offsets(path):
                sha.update(raw)
                doc = json.loads(raw)
                doc_id = doc["doc_id"]
                nodes = doc.get("nodes") or []
                texts = [t for t in (node_dict_to_text(n) for n in nodes) if t]
                text = "\n".join(texts)[:text_cap]
                m = meta_by_id.get(doc_id)
                if m is None:
                    missing_meta.append(doc_id)
                    m = {}
                fo.write(json.dumps({"doc_id": doc_id, "file": name, "offset": offset,
                                     "length": len(raw), "n_nodes": len(nodes)},
                                    ensure_ascii=False) + "\n")
                fi.write(json.dumps({
                    "doc_id": doc_id,
                    "corp_name": m.get("corp_name", ""),
                    "corp_code": m.get("corp_code", ""),
                    "filer_name": m.get("flr_nm", ""),
                    "doc_group": m.get("doc_group") or group,
                    "doc_subtype": m.get("doc_subtype", ""),
                    "report_nm": m.get("report_nm", ""),
                    "rcept_dt": m.get("rcept_dt", ""),
                    "base_year": m.get("base_year"),
                    "base_month": m.get("base_month"),
                    "is_correction": bool(m.get("is_correction", False)),
                    "n_nodes": len(nodes),
                    "text": text,
                }, ensure_ascii=False) + "\n")
                n_in_file += 1
                n_docs += 1
                if progress and n_docs % 200 == 0:
                    progress(f"{n_docs} docs · {name} · {time.perf_counter() - t0:.0f}s")
            files_info[name] = {"sha256": sha.hexdigest(), "bytes": path.stat().st_size,
                                "n_docs": n_in_file}

    offsets_path = out_dir / OFFSETS_NAME
    index_path = out_dir / DOC_INDEX_NAME
    offsets_tmp.replace(offsets_path)
    index_tmp.replace(index_path)

    summary = {
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "document_ir_dir": str(document_ir_dir),
        "files": files_info,
        "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "text_recipe": TEXT_RECIPE,
        "text_cap": text_cap,
        "n_docs": n_docs,
        "n_missing_manifest": len(missing_meta),
        "missing_manifest_doc_ids": missing_meta[:20],
        "doc_index_sha256": hashlib.sha256(index_path.read_bytes()).hexdigest(),
        "node_offsets_sha256": hashlib.sha256(offsets_path.read_bytes()).hexdigest(),
        "elapsed_s": round(time.perf_counter() - t0, 1),
    }
    (out_dir / MANIFEST_NAME).write_text(json.dumps(summary, ensure_ascii=False, indent=1),
                                         encoding="utf-8")
    return summary

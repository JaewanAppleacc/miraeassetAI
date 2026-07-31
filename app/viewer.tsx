"use client";

import { useEffect, useMemo, useState } from "react";

const API_BASE = "http://127.0.0.1:4318";

type SourceFile = {
  name: string;
  path: string;
  size: number;
  detectedFormat: "html" | "xml" | "json" | "text";
};

type DisclosureDocument = {
  id: string;
  folder: string;
  title: string;
  reportName?: string;
  receiptDate?: string;
  isCorrection?: boolean;
  files: SourceFile[];
};

type Company = {
  name: string;
  documents: DisclosureDocument[];
};

type Group = {
  id: "exchange" | "holding" | "major" | "periodic";
  label: string;
  companies: Company[];
  documentCount: number;
  fileCount: number;
};

type CorpusIndex = {
  corpusRoot: string;
  generatedAt: string;
  groups: Group[];
  stats: {
    documents: number;
    files: number;
    companies: number;
  };
};

const GROUP_HINT: Record<string, string> = {
  exchange: "거래소공시",
  holding: "지분공시",
  major: "주요사항",
  periodic: "정기공시",
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const formatDate = (date?: string) => {
  if (!date || date.length !== 8) return date ?? "";
  return `${date.slice(0, 4)}.${date.slice(4, 6)}.${date.slice(6, 8)}`;
};

export function DisclosureViewer() {
  const [index, setIndex] = useState<CorpusIndex | null>(null);
  const [loadError, setLoadError] = useState("");
  const [groupId, setGroupId] = useState("exchange");
  const [companyName, setCompanyName] = useState("전체 기업");
  const [query, setQuery] = useState("");
  const [selectedDocument, setSelectedDocument] =
    useState<DisclosureDocument | null>(null);
  const [selectedFile, setSelectedFile] = useState<SourceFile | null>(null);
  const [mode, setMode] = useState<"rendered" | "source">("rendered");

  useEffect(() => {
    fetch(`${API_BASE}/api/index`)
      .then(async (response) => {
        if (!response.ok) throw new Error("문서 목록을 불러오지 못했습니다.");
        return response.json();
      })
      .then((data: CorpusIndex) => setIndex(data))
      .catch(() =>
        setLoadError(
          "로컬 문서 서버에 연결할 수 없습니다. 터미널에서 npm run viewer를 실행해 주세요.",
        ),
      );
  }, []);

  const group = useMemo(
    () => index?.groups.find((item) => item.id === groupId) ?? null,
    [groupId, index],
  );

  const companies = useMemo(() => group?.companies ?? [], [group]);

  const documents = useMemo(() => {
    if (!group) return [];
    const normalizedQuery = query.trim().toLocaleLowerCase("ko");

    return group.companies
      .filter(
        (company) =>
          companyName === "전체 기업" || company.name === companyName,
      )
      .flatMap((company) =>
        company.documents.map((document) => ({
          ...document,
          company: company.name,
        })),
      )
      .filter((document) => {
        if (!normalizedQuery) return true;
        return [
          document.company,
          document.id,
          document.title,
          document.reportName,
          document.folder,
        ]
          .filter(Boolean)
          .some((value) =>
            String(value).toLocaleLowerCase("ko").includes(normalizedQuery),
          );
      });
  }, [companyName, group, query]);

  useEffect(() => {
    setCompanyName("전체 기업");
    setQuery("");
    setSelectedDocument(null);
    setSelectedFile(null);
  }, [groupId]);

  const selectDocument = (document: DisclosureDocument) => {
    setSelectedDocument(document);
    setSelectedFile(document.files[0] ?? null);
    setMode("rendered");
  };

  const viewerUrl = selectedFile
    ? `${API_BASE}/view?path=${encodeURIComponent(selectedFile.path)}&mode=${mode}`
    : "";

  if (loadError) {
    return (
      <main className="connection-page">
        <section className="connection-card">
          <div className="brand-mark">D</div>
          <p className="eyebrow">DART CORPUS VIEWER</p>
          <h1>문서 서버를 기다리고 있어요</h1>
          <p>{loadError}</p>
          <code>npm run viewer</code>
        </section>
      </main>
    );
  }

  if (!index) {
    return (
      <main className="connection-page">
        <section className="connection-card loading-card">
          <div className="brand-mark">D</div>
          <p className="eyebrow">DART CORPUS VIEWER</p>
          <h1>공시 목록을 정리하고 있어요</h1>
          <div className="loading-line" />
        </section>
      </main>
    );
  }

  return (
    <main className="viewer-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">D</div>
          <div>
            <p className="eyebrow">DISCLOSURE ANALYST LAB</p>
            <h1>DART Corpus Viewer</h1>
          </div>
        </div>
        <div className="corpus-summary">
          <span className="status-dot" />
          <span>원본 읽기 전용</span>
          <strong>{index.stats.documents.toLocaleString()}개 문서</strong>
          <span>{index.stats.files.toLocaleString()}개 파일</span>
        </div>
      </header>

      <nav className="group-nav" aria-label="공시 문서군">
        {index.groups.map((item) => (
          <button
            className={item.id === groupId ? "group-tab active" : "group-tab"}
            key={item.id}
            onClick={() => setGroupId(item.id)}
          >
            <span>{item.label}</span>
            <small>{item.documentCount.toLocaleString()}</small>
          </button>
        ))}
      </nav>

      <section className="workspace">
        <aside className="document-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{groupId.toUpperCase()}</p>
              <h2>{GROUP_HINT[groupId]} 문서</h2>
            </div>
            <span>{documents.length.toLocaleString()}건</span>
          </div>

          <label className="search-box">
            <span aria-hidden="true">⌕</span>
            <input
              aria-label="문서 검색"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="기업·접수번호·보고서명 검색"
              value={query}
            />
          </label>

          <label className="company-filter">
            <span>기업</span>
            <select
              aria-label="기업 필터"
              onChange={(event) => setCompanyName(event.target.value)}
              value={companyName}
            >
              <option>전체 기업</option>
              {companies.map((company) => (
                <option key={company.name}>{company.name}</option>
              ))}
            </select>
          </label>

          <div className="document-list">
            {documents.slice(0, 500).map((document) => (
              <button
                className={
                  selectedDocument?.folder === document.folder
                    ? "document-item selected"
                    : "document-item"
                }
                key={`${groupId}-${document.folder}`}
                onClick={() => selectDocument(document)}
              >
                <div className="document-item-top">
                  <strong>{document.company}</strong>
                  {document.isCorrection && <em>정정</em>}
                </div>
                <p>{document.reportName || document.title}</p>
                <div className="document-meta">
                  <span>{formatDate(document.receiptDate)}</span>
                  <span>{document.id}</span>
                  {document.files.length > 1 && (
                    <span>파일 {document.files.length}</span>
                  )}
                </div>
              </button>
            ))}
            {documents.length > 500 && (
              <p className="list-limit">
                결과가 많아 500건만 표시 중입니다. 검색어나 기업 필터를
                사용해 주세요.
              </p>
            )}
            {documents.length === 0 && (
              <div className="empty-list">조건에 맞는 문서가 없습니다.</div>
            )}
          </div>
        </aside>

        <section className="content-panel">
          {selectedDocument && selectedFile ? (
            <>
              <header className="document-header">
                <div className="document-title">
                  <div className="title-line">
                    <span className={`format-badge ${selectedFile.detectedFormat}`}>
                      {selectedFile.detectedFormat.toUpperCase()}
                    </span>
                    {selectedDocument.isCorrection && (
                      <span className="correction-badge">정정공시</span>
                    )}
                  </div>
                  <h2>
                    {selectedDocument.reportName || selectedDocument.title}
                  </h2>
                  <p>
                    {selectedDocument.id}
                    {selectedDocument.receiptDate &&
                      ` · ${formatDate(selectedDocument.receiptDate)}`}
                    {` · ${formatBytes(selectedFile.size)}`}
                  </p>
                </div>

                <div className="view-actions">
                  <div className="mode-switch" aria-label="보기 모드">
                    <button
                      className={mode === "rendered" ? "active" : ""}
                      onClick={() => setMode("rendered")}
                    >
                      문서 보기
                    </button>
                    <button
                      className={mode === "source" ? "active" : ""}
                      onClick={() => setMode("source")}
                    >
                      원문 보기
                    </button>
                  </div>
                  <a href={viewerUrl} rel="noreferrer" target="_blank">
                    새 창
                  </a>
                </div>
              </header>

              {selectedDocument.files.length > 1 && (
                <div className="file-strip">
                  <span>첨부 파일</span>
                  {selectedDocument.files.map((file) => (
                    <button
                      className={
                        selectedFile.path === file.path ? "active" : ""
                      }
                      key={file.path}
                      onClick={() => setSelectedFile(file)}
                    >
                      {file.name}
                    </button>
                  ))}
                </div>
              )}

              <div className="document-frame-wrap">
                <iframe
                  key={`${selectedFile.path}-${mode}`}
                  className="document-frame"
                  src={viewerUrl}
                  title={`${selectedDocument.title} 문서`}
                />
              </div>
            </>
          ) : (
            <div className="welcome-state">
              <div className="welcome-icon">문</div>
              <p className="eyebrow">READ THE SOURCE</p>
              <h2>공시 원문을 한곳에서 확인하세요</h2>
              <p>
                왼쪽에서 기업과 문서를 선택하면 HTML과 XML을 자동으로 판별해
                읽기 편한 형식으로 보여줍니다. 원본 파일은 변경하지 않습니다.
              </p>
              <div className="welcome-grid">
                <article>
                  <strong>4</strong>
                  <span>문서군</span>
                </article>
                <article>
                  <strong>{index.stats.companies}</strong>
                  <span>기업</span>
                </article>
                <article>
                  <strong>{index.stats.documents.toLocaleString()}</strong>
                  <span>문서 폴더</span>
                </article>
              </div>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

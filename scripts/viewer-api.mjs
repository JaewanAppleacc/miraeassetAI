import { createServer } from "node:http";
import { open, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.DISCLOSURE_VIEWER_PORT || 4318);
const CORPUS_ROOT =
  process.env.DISCLOSURE_CORPUS_ROOT ||
  "/Users/jaewan/Downloads/3.공시/corpus";
const RAW_ROOT = path.join(CORPUS_ROOT, "raw");
const GROUPS = [
  { id: "exchange", label: "거래소공시" },
  { id: "holding", label: "지분공시" },
  { id: "major", label: "주요사항" },
  { id: "periodic", label: "정기공시" },
];

const collator = new Intl.Collator("ko", {
  numeric: true,
  sensitivity: "base",
});

const escapeHtml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const decodeBuffer = (buffer) => {
  for (const encoding of ["utf-8", "euc-kr"]) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(buffer);
    } catch {
      // Try the next known corpus encoding.
    }
  }
  return new TextDecoder("utf-8").decode(buffer);
};

const detectFormat = (buffer, fileName) => {
  const sample = buffer.subarray(0, 2048).toString("utf8").trimStart().toLowerCase();
  if (sample.startsWith("<!doctype html") || sample.startsWith("<html")) {
    return "html";
  }
  if (
    sample.startsWith("<?xml") ||
    sample.startsWith("<document") ||
    fileName.toLowerCase().endsWith(".xml")
  ) {
    return "xml";
  }
  if (fileName.toLowerCase().endsWith(".json")) return "json";
  return "text";
};

const readSample = async (filePath, length = 2048) => {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

const collectFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
      continue;
    }
    if (!entry.isFile()) continue;

    const fileStat = await stat(fullPath);
    const sample = await readSample(fullPath);
    files.push({
      name: entry.name.normalize("NFC"),
      path: path.relative(RAW_ROOT, fullPath),
      size: fileStat.size,
      detectedFormat: detectFormat(sample, entry.name),
    });
  }

  return files.sort((a, b) => collator.compare(a.name, b.name));
};

const loadManifest = async () => {
  try {
    const content = await readFile(path.join(CORPUS_ROOT, "manifest.jsonl"), "utf8");
    return new Map(
      content
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .map((row) => [
          String(row.file_path || "")
            .replace(/^raw\//, "")
            .normalize("NFC"),
          row,
        ]),
    );
  } catch {
    return new Map();
  }
};

const buildIndex = async () => {
  const manifest = await loadManifest();
  const groups = [];
  const allCompanies = new Set();
  let totalFiles = 0;
  let totalDocuments = 0;

  for (const group of GROUPS) {
    const groupPath = path.join(RAW_ROOT, group.id);
    const entries = await readdir(groupPath, { withFileTypes: true });
    const companies = [];

    for (const companyEntry of entries.filter((entry) => entry.isDirectory())) {
      const companyPath = path.join(groupPath, companyEntry.name);
      const documentEntries = await readdir(companyPath, {
        withFileTypes: true,
      });
      const documents = [];

      for (const documentEntry of documentEntries.filter((entry) =>
        entry.isDirectory(),
      )) {
        const folderPath = path.join(companyPath, documentEntry.name);
        const files = await collectFiles(folderPath);
        if (!files.length) continue;

        const relativeFolder = path
          .relative(RAW_ROOT, folderPath)
          .normalize("NFC");
        const metadata = manifest.get(relativeFolder);
        const id =
          String(metadata?.rcept_no || "") ||
          documentEntry.name.match(/\d{14}/)?.[0] ||
          documentEntry.name;

        documents.push({
          id,
          folder: relativeFolder,
          title:
            metadata?.report_nm ||
            documentEntry.name.normalize("NFC").replaceAll("_", " "),
          reportName: metadata?.report_nm,
          receiptDate: metadata?.rcept_dt,
          isCorrection: Boolean(metadata?.is_correction),
          files,
        });
        totalFiles += files.length;
      }

      documents.sort((a, b) => {
        const dateCompare = String(b.receiptDate || b.id).localeCompare(
          String(a.receiptDate || a.id),
        );
        return dateCompare || collator.compare(a.title, b.title);
      });

      if (documents.length) {
        const companyName = companyEntry.name.normalize("NFC");
        allCompanies.add(companyName);
        companies.push({ name: companyName, documents });
        totalDocuments += documents.length;
      }
    }

    companies.sort((a, b) => collator.compare(a.name, b.name));
    groups.push({
      ...group,
      companies,
      documentCount: companies.reduce(
        (sum, company) => sum + company.documents.length,
        0,
      ),
      fileCount: companies.reduce(
        (sum, company) =>
          sum +
          company.documents.reduce(
            (documentSum, document) => documentSum + document.files.length,
            0,
          ),
        0,
      ),
    });
  }

  return {
    corpusRoot: CORPUS_ROOT,
    generatedAt: new Date().toISOString(),
    groups,
    stats: {
      documents: totalDocuments,
      files: totalFiles,
      companies: allCompanies.size,
    },
  };
};

const safeSourcePath = (relativePath) => {
  const resolved = path.resolve(RAW_ROOT, relativePath);
  const rootPrefix = `${path.resolve(RAW_ROOT)}${path.sep}`;
  if (!resolved.startsWith(rootPrefix)) {
    throw new Error("허용되지 않은 파일 경로입니다.");
  }
  return resolved;
};

const removeUnsafeMarkup = (markup) =>
  markup
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(["']).*?\1/gi, "")
    .replace(/\s(href|src)\s*=\s*(["'])javascript:.*?\2/gi, "");

const documentStyles = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html { background: #eef1ed; }
  body {
    background: white; color: #1e2925; font-family: "Apple SD Gothic Neo",
    "Noto Sans KR", sans-serif; font-size: 13px; line-height: 1.65;
    margin: 0 auto; max-width: 1180px; min-height: 100vh; padding: 42px 48px 100px;
  }
  h1, h2, h3, h4 { color: #173c30; line-height: 1.35; }
  h1 { border-bottom: 2px solid #145c46; font-size: 25px; padding-bottom: 15px; }
  h2 { border-left: 4px solid #145c46; font-size: 19px; margin-top: 38px; padding-left: 11px; }
  h3 { font-size: 16px; margin-top: 28px; }
  p { margin: 7px 0; white-space: pre-wrap; }
  section { margin: 20px 0; }
  .table-group { margin: 17px 0 28px; overflow-x: auto; }
  table { border-collapse: collapse; font-size: 12px; min-width: 620px; width: 100% !important; }
  th, td { border: 1px solid #aeb8b2; height: auto !important; padding: 7px 8px; vertical-align: middle; }
  th { background: #edf3ef; font-weight: 700; }
  tr:nth-child(even) td { background: #fafbf9; }
  hr.page-break { border: 0; border-top: 1px dashed #aeb8b2; margin: 34px 0; }
  .document-name { color: #145c46; font-size: 12px; font-weight: 800; letter-spacing: .04em; }
  .company-name { color: #65716c; display: block; font-size: 11px; margin-bottom: 24px; }
  .source-note {
    background: #edf6f1; border: 1px solid #d3e7dd; border-radius: 9px;
    color: #486057; font-size: 11px; margin-bottom: 26px; padding: 10px 13px;
  }
  img { height: auto; max-width: 100%; }
  extraction, formula-version { display: none; }
  pre {
    background: #17231f; border-radius: 10px; color: #dce9e3; font-family:
    ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
    line-height: 1.55; margin: 0; overflow: auto; padding: 24px;
    white-space: pre-wrap; word-break: break-all;
  }
  @media (max-width: 720px) { body { padding: 24px 16px 70px; } }
`;

const wrapDocument = (body, title) => `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${documentStyles}</style>
</head>
<body>${body}</body>
</html>`;

const renderXml = (source, fileName) => {
  let markup = source
    .replace(/^\uFEFF/, "")
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<DOCUMENT\b[^>]*>/gi, '<main class="dart-document">')
    .replace(/<\/DOCUMENT>/gi, "</main>")
    .replace(/<DOCUMENT-NAME\b[^>]*>/gi, '<div class="document-name">')
    .replace(/<\/DOCUMENT-NAME>/gi, "</div>")
    .replace(/<COMPANY-NAME\b[^>]*>/gi, '<span class="company-name">')
    .replace(/<\/COMPANY-NAME>/gi, "</span>")
    .replace(/<COVER-TITLE\b[^>]*>/gi, "<h1>")
    .replace(/<\/COVER-TITLE>/gi, "</h1>")
    .replace(/<TITLE\b[^>]*>/gi, "<h2>")
    .replace(/<\/TITLE>/gi, "</h2>")
    .replace(/<TABLE-GROUP\b[^>]*>/gi, '<div class="table-group">')
    .replace(/<\/TABLE-GROUP>/gi, "</div>")
    .replace(/<SECTION-[0-9]+\b[^>]*>/gi, "<section>")
    .replace(/<\/SECTION-[0-9]+>/gi, "</section>")
    .replace(/<(?:BODY|COVER|LIBRARY)\b[^>]*>/gi, "<div>")
    .replace(/<\/(?:BODY|COVER|LIBRARY)>/gi, "</div>")
    .replace(/<PGBRK\b[^>]*\/?>/gi, '<hr class="page-break">')
    .replace(/<\/PGBRK>/gi, "")
    .replace(/<TE\b([^>]*)>/gi, "<td$1>")
    .replace(/<\/TE>/gi, "</td>")
    .replace(/<TU\b([^>]*)>/gi, "<td$1>")
    .replace(/<\/TU>/gi, "</td>")
    .replace(/<COL\b([^>]*)><\/COL>/gi, "<col$1>")
    .replace(/<COL\b([^>]*)\/>/gi, "<col$1>")
    .replace(/\sWIDTH="(\d+)"/gi, ' style="min-width:$1px"')
    .replace(/\sHEIGHT="(\d+)"/gi, "")
    .replace(/\sALIGN="([^"]+)"/gi, ' data-align="$1"')
    .replace(/\sVALIGN="([^"]+)"/gi, "")
    .replace(/\sxmlns(?::\w+)?="[^"]*"/gi, "")
    .replace(/\sxsi:[\w-]+="[^"]*"/gi, "");

  markup = removeUnsafeMarkup(markup);
  return wrapDocument(
    `<div class="source-note">원본 XML을 열람용 HTML로 변환해 표시합니다. 원본 파일은 변경되지 않았습니다.</div>${markup}`,
    fileName,
  );
};

const renderHtml = (source, fileName) => {
  let markup = removeUnsafeMarkup(source)
    .replace(/charset\s*=\s*euc-kr/gi, "charset=utf-8")
    .replace(/charset\s*=\s*cp949/gi, "charset=utf-8");

  if (/<head\b[^>]*>/i.test(markup)) {
    markup = markup.replace(
      /<head\b([^>]*)>/i,
      `<head$1><meta charset="utf-8"><style>${documentStyles}</style>`,
    );
  } else {
    markup = wrapDocument(markup, fileName);
  }
  return markup;
};

const renderJson = (source, fileName) => {
  let formatted = source;
  try {
    formatted = JSON.stringify(JSON.parse(source), null, 2);
  } catch {
    // Preserve malformed source for inspection.
  }
  return wrapDocument(`<pre>${escapeHtml(formatted)}</pre>`, fileName);
};

const renderSource = (source, fileName) =>
  wrapDocument(`<pre>${escapeHtml(source)}</pre>`, `${fileName} 원문`);

let cachedIndex;

const sendJson = (response, status, body) => {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
};

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url || "/", `http://127.0.0.1:${PORT}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
    response.end();
    return;
  }

  try {
    if (requestUrl.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, corpusRoot: CORPUS_ROOT });
      return;
    }

    if (requestUrl.pathname === "/api/index") {
      cachedIndex ||= await buildIndex();
      sendJson(response, 200, cachedIndex);
      return;
    }

    if (requestUrl.pathname === "/view") {
      const relativePath = requestUrl.searchParams.get("path");
      const mode = requestUrl.searchParams.get("mode") || "rendered";
      if (!relativePath) throw new Error("파일 경로가 없습니다.");

      const sourcePath = safeSourcePath(relativePath);
      const buffer = await readFile(sourcePath);
      const source = decodeBuffer(buffer);
      const fileName = path.basename(sourcePath);
      const format = detectFormat(buffer.subarray(0, 2048), fileName);

      let html;
      if (mode === "source") html = renderSource(source, fileName);
      else if (format === "html") html = renderHtml(source, fileName);
      else if (format === "xml") html = renderXml(source, fileName);
      else if (format === "json") html = renderJson(source, fileName);
      else html = renderSource(source, fileName);

      response.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline';",
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(html);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "문서를 처리하지 못했습니다.";
    if (requestUrl.pathname === "/view") {
      response.writeHead(500, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(
        wrapDocument(
          `<h1>문서를 열 수 없습니다</h1><p>${escapeHtml(message)}</p>`,
          "오류",
        ),
      );
      return;
    }
    sendJson(response, 500, { error: message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Disclosure viewer API: http://127.0.0.1:${PORT}`);
  console.log(`Corpus root: ${CORPUS_ROOT}`);
});

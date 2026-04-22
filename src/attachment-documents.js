import fs from 'node:fs/promises';
import path from 'node:path';

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Max characters injected per document into the model context */
export const DOCUMENT_CONTEXT_CHAR_CAP = 200_000;

const TEXT_EXT = new Set([
  '.txt', '.md', '.json', '.yaml', '.yml', '.toml', '.ini', '.env', '.log',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.php', '.rb', '.lua', '.sql',
  '.css', '.scss', '.less', '.html', '.htm', '.vue', '.svelte',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.xml', '.svg', '.plist', '.gradle', '.properties',
  '.csv', '.tsv', '.rtf'
]);

const DOCX_EXT = new Set(['.docx']);
const PDF_EXT = new Set(['.pdf']);
const SHEET_EXT = new Set(['.xlsx', '.xls', '.ods']);

export function isImageMime(mimeType) {
  return IMAGE_MIMES.has(String(mimeType || '').toLowerCase());
}

export function classifyUploadedFile(mimeType, filename) {
  const mime = String(mimeType || '').toLowerCase();
  const ext = path.extname(String(filename || '')).toLowerCase();

  if (IMAGE_MIMES.has(mime)) return { kind: 'image', normalizedMime: mime };

  if (mime.startsWith('text/') || mime === 'application/json' || mime.includes('json')) {
    return { kind: 'document', normalizedMime: mime || 'text/plain' };
  }

  if (
    mime === 'application/pdf'
    || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    || mime === 'application/vnd.ms-excel'
    || mime === 'application/vnd.oasis.opendocument.spreadsheet'
    || mime === 'application/octet-stream'
  ) {
    return { kind: 'document', normalizedMime: mime || 'application/octet-stream' };
  }

  if (TEXT_EXT.has(ext)) return { kind: 'document', normalizedMime: mime || 'text/plain' };
  if (DOCX_EXT.has(ext)) {
    return { kind: 'document', normalizedMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  if (PDF_EXT.has(ext)) return { kind: 'document', normalizedMime: 'application/pdf' };
  if (SHEET_EXT.has(ext)) {
    let nm = mime;
    if (ext === '.xlsx') nm = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    else if (ext === '.xls') nm = 'application/vnd.ms-excel';
    else if (ext === '.ods') nm = 'application/vnd.oasis.opendocument.spreadsheet';
    return { kind: 'document', normalizedMime: nm || 'application/octet-stream' };
  }

  return { kind: 'unsupported', normalizedMime: mime };
}

function capText(text) {
  const t = String(text || '').replace(/\r\n/g, '\n');
  if (t.length <= DOCUMENT_CONTEXT_CHAR_CAP) return t;
  return `${t.slice(0, DOCUMENT_CONTEXT_CHAR_CAP)}\n\n[Document truncated after ${DOCUMENT_CONTEXT_CHAR_CAP} characters]`;
}

async function extractDocx(filePath) {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  return String(result.value || '').trim();
}

async function extractPdf(buffer) {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return String(result.text || '').trim();
  } finally {
    await parser.destroy?.();
  }
}

async function extractSpreadsheet(buffer) {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const parts = [];
  for (const sheetName of wb.SheetNames || []) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { FS: '\t' });
    parts.push(`### ${sheetName}\n${csv}`);
  }
  return parts.join('\n\n').trim();
}

export async function extractDocumentText(filePath, mimeType, originalName) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  const buf = await fs.readFile(filePath);
  const mime = String(mimeType || '').toLowerCase();

  if (DOCX_EXT.has(ext) || mime.includes('wordprocessingml')) {
    return capText(await extractDocx(filePath));
  }
  if (PDF_EXT.has(ext) || mime === 'application/pdf') {
    return capText(await extractPdf(buf));
  }
  if (SHEET_EXT.has(ext) || mime.includes('spreadsheetml') || mime.includes('ms-excel') || mime.includes('opendocument.spreadsheet')) {
    return capText(await extractSpreadsheet(buf));
  }

  let text = '';
  try {
    text = buf.toString('utf8');
  } catch {
    text = '';
  }
  if (!text && buf.length) {
    try {
      text = buf.toString('latin1');
    } catch {
      text = '';
    }
  }
  return capText(text);
}

export function formatAttachmentContextBlock(originalName, extractedText) {
  const name = String(originalName || 'attachment').trim() || 'attachment';
  const body = String(extractedText || '').trim();
  if (!body) return '';
  return [`---`, `Attached file (text): ${name}`, `---`, '', body].join('\n');
}

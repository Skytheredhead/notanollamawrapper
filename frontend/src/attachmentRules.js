const MAX_BYTES = 100 * 1024 * 1024

const TEXTUAL_EXT =
  /\.(txt|md|json|ya?ml|toml|ini|env|log|js|jsx|mjs|cjs|ts|tsx|mts|cts|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|rb|lua|sql|css|scss|less|html|htm|vue|svelte|sh|bash|zsh|fish|xml|svg|plist|gradle|properties|csv|tsv|ps1|bat|cmd)$/i

const DOC_EXT = /\.(pdf|docx|xlsx|xls|ods)$/i

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i

export const ATTACHMENT_INPUT_ACCEPT = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/*',
  'application/json',
  'application/pdf',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.oasis.opendocument.spreadsheet',
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.env',
  '.csv',
  '.tsv',
  '.pdf',
  '.docx',
  '.xlsx',
  '.xls',
  '.ods',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.css',
  '.html',
  '.htm',
  '.sh',
  '.bash',
  '.zsh',
  '.xml',
  '.sql',
  '.vue',
  '.rb',
  '.php',
  '.cs',
  '.swift',
  '.kt',
  '.scala',
  '.r',
  '.m',
  '.pl',
  '.lua',
  '.gradle',
  '.properties',
  '.svg',
  '.log'
].join(',')

export function pendingAttachmentKind(file) {
  const t = String(file?.type || '')
  if (t.startsWith('image/')) return 'image'
  const n = String(file?.name || '')
  if (IMAGE_EXT.test(n)) return 'image'
  return 'document'
}

export function validateAttachmentFile(file) {
  if (!file) return { ok: false, reason: 'Invalid file.' }
  if (file.size > MAX_BYTES) return { ok: false, reason: 'File is larger than 100 MB.' }
  const name = String(file.name || '')
  const type = String(file.type || '').toLowerCase()
  if (type.startsWith('image/')) return { ok: true }
  if (IMAGE_EXT.test(name)) return { ok: true }
  if (TEXTUAL_EXT.test(name)) return { ok: true }
  if (DOC_EXT.test(name)) return { ok: true }
  if (type.startsWith('text/')) return { ok: true }
  if (type === 'application/json' || type.includes('json')) return { ok: true }
  if (type === 'application/pdf') return { ok: true }
  if (type.includes('wordprocessingml.document')) return { ok: true }
  if (type.includes('spreadsheetml') || type.includes('ms-excel') || type.includes('opendocument.spreadsheet')) return { ok: true }
  if (type === 'application/xml' || type === 'application/javascript' || type === 'application/typescript') return { ok: true }
  return { ok: false, reason: `Unsupported file type (${name || 'file'}). Use images, PDF, DOCX, spreadsheets, or plain text and code files.` }
}

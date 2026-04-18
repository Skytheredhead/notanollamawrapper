import fs from 'node:fs';
import path from 'node:path';

let cachedPath = '';
let cachedMtimeMs = 0;
let cachedContent = '';

export function loadToolsMarkdown(filePath = path.resolve(process.cwd(), 'tools.md')) {
  try {
    const stats = fs.statSync(filePath);
    if (cachedPath === filePath && cachedMtimeMs === stats.mtimeMs) {
      return cachedContent;
    }
    const content = fs.readFileSync(filePath, 'utf8').trim();
    cachedPath = filePath;
    cachedMtimeMs = stats.mtimeMs;
    cachedContent = content;
    return content;
  } catch {
    return '';
  }
}

export function prependToolsContext(messages, { filePath, toolsEnabled = true } = {}) {
  const content = loadToolsMarkdown(filePath);
  const parts = [];
  if (content) parts.push(content);
  if (!toolsEnabled) {
    parts.push('Tool execution is disabled for this turn. Do not claim that you used tools.');
  }
  if (!parts.length) return messages;
  return [
    {
      role: 'system',
      content: parts.join('\n\n')
    },
    ...messages
  ];
}

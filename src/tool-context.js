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

export function formatToolStateContext(state = {}) {
  const calculators = Object.values(state?.calculators || {})
    .filter((item) => item && item.result != null)
    .slice(-3);
  const parts = [];
  if (calculators.length) {
    parts.push([
      'Current interactive calculator state:',
      ...calculators.map((item, index) => {
        const expression = String(item.expression || '').trim();
        const result = String(item.result || '').trim();
        return `${index + 1}. ${expression ? `${expression} = ` : ''}${result}`;
      }),
      'Use the latest calculator result for references like "that", "this number", or "add that to ...".'
    ].join('\n'));
  }
  return parts.join('\n\n');
}

export function prependToolsContext(messages, { filePath, toolsEnabled = true, state = null } = {}) {
  const content = loadToolsMarkdown(filePath);
  const parts = [];
  if (content) parts.push(content);
  const stateContext = formatToolStateContext(state);
  if (stateContext) parts.push(stateContext);
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

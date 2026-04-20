import fs from 'node:fs';
import path from 'node:path';
 
function ts() {
  return new Date().toISOString();
}
 
function safeString(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
 
export function createLogger({ filePath }) {
  const target = String(filePath || '').trim();
  if (target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  const write = (level, parts) => {
    const line = `[${ts()}] ${level.toUpperCase()} ${parts.map(safeString).join(' ')}\n`;
    try {
      if (target) fs.appendFileSync(target, line);
    } catch {
      // ignore file write issues
    }
    try {
      (level === 'error' ? process.stderr : process.stdout).write(line);
    } catch {
      // ignore closed stdout/stderr
    }
  };
  return {
    info: (...parts) => write('info', parts),
    warn: (...parts) => write('warn', parts),
    error: (...parts) => write('error', parts),
  };
}


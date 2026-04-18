import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { sendError } from './errors.js';

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp'
};

async function fileExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function isInsideDir(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function contentType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function isBackendRoute(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/') || pathname === '/health';
}

export function registerFrontend(app, { distDir }) {
  app.get('/*', async (request, reply) => {
    const pathname = new URL(request.url, 'http://naow.local').pathname;

    if (isBackendRoute(pathname)) {
      return sendError(reply, 404, 'not_found', 'Route not found.');
    }

    const indexPath = path.join(distDir, 'index.html');
    if (!(await fileExists(indexPath))) {
      return sendError(
        reply,
        404,
        'frontend_not_built',
        'Frontend build not found. Run npm run build:frontend first.'
      );
    }

    let requestedPath;
    try {
      requestedPath = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    } catch {
      requestedPath = '/index.html';
    }

    const candidatePath = path.resolve(distDir, `.${requestedPath}`);
    const filePath =
      isInsideDir(distDir, candidatePath) && (await fileExists(candidatePath))
        ? candidatePath
        : indexPath;

    return reply.type(contentType(filePath)).send(createReadStream(filePath));
  });
}

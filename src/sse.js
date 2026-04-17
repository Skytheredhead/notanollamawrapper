import { once } from 'node:events';

export function startSse(reply) {
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  response.flushHeaders?.();
  return response;
}

export async function writeSse(response, event, data) {
  if (response.destroyed || response.writableEnded) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if (!response.write(frame)) {
    await once(response, 'drain');
  }
}

export function startPing(response, intervalMs = 15000) {
  return setInterval(() => {
    if (response.destroyed || response.writableEnded) return;
    response.write(`event: ping\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);
  }, intervalMs);
}

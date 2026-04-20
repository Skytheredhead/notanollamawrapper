export class ApiError extends Error {
  constructor(statusCode, code, message, { details = null, cause = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.cause = cause;
  }
}

function errorDetailsForClient(details, { debugErrors = false } = {}) {
  if (!debugErrors) return null;
  if (!details) return null;
  if (typeof details === 'string') return details;
  if (details instanceof Error) return details.stack || details.message;
  try {
    return JSON.parse(JSON.stringify(details));
  } catch {
    return String(details);
  }
}

export function sendError(reply, statusCode, code, message, { requestId = null, details = null, debugErrors = false } = {}) {
  return reply.code(statusCode).send({
    error: {
      code,
      message,
      requestId: requestId || null,
      details: errorDetailsForClient(details, { debugErrors })
    }
  });
}

export function notFound(message = 'Not found.') {
  return new ApiError(404, 'not_found', message);
}

export function badRequest(code, message, details = null) {
  return new ApiError(400, code, message, { details });
}

export function conflict(code, message, details = null) {
  return new ApiError(409, code, message, { details });
}

export function unavailable(code, message, details = null) {
  return new ApiError(503, code, message, { details });
}

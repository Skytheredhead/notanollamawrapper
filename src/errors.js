export class ApiError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function sendError(reply, statusCode, code, message) {
  return reply.code(statusCode).send({
    error: {
      code,
      message
    }
  });
}

export function notFound(message = 'Not found.') {
  return new ApiError(404, 'not_found', message);
}

export function badRequest(code, message) {
  return new ApiError(400, code, message);
}

export function conflict(code, message) {
  return new ApiError(409, code, message);
}

export function unavailable(code, message) {
  return new ApiError(503, code, message);
}

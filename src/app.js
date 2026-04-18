import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { ApiError, sendError } from './errors.js';
import { registerFrontend } from './frontend.js';
import { registerRoutes } from './routes.js';

export function buildApp({ config, db, ollama, generationManager, searchClient = null }) {
  const app = Fastify({
    logger: false,
    bodyLimit: 24 * 1024 * 1024
  });

  app.register(multipart, {
    limits: {
      fileSize: 20 * 1024 * 1024,
      files: 8
    }
  });

  app.addHook('onRequest', (request, reply, done) => {
    reply.header('Access-Control-Allow-Origin', config.corsOrigin);
    reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type');
    reply.header('Access-Control-Max-Age', '86400');

    if (request.method === 'OPTIONS') {
      reply.code(204).send();
      return;
    }

    done();
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return sendError(reply, error.statusCode, error.code, error.message);
    }

    if (error.validation) {
      return sendError(reply, 400, 'invalid_request', error.message);
    }

    request.log.error(error);
    return sendError(reply, 500, 'internal_error', 'Unexpected backend error.');
  });

  registerRoutes(app, {
    config,
    db,
    ollama,
    generationManager,
    searchClient
  });
  registerFrontend(app, {
    distDir: config.frontendDist
  });

  return app;
}

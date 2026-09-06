import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { registerRoutes } from './routes.js';

const log = createLogger('server');

/** `public/` est a la racine du depot, deux niveaux au-dessus de dist/src/http. */
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', '..', '..', 'public');

export async function buildServer(db: BetterSqlite3.Database): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    // Le dashboard n'est jamais derriere un proxy de confiance par defaut ;
    // active-le explicitement si tu places un reverse proxy devant.
    trustProxy: process.env['TRUST_PROXY'] === 'true',
    bodyLimit: 1_000_000,
  });

  app.addHook('onRequest', async (request, reply) => {
    // Outil personnel : aucune raison d'etre embarque dans une page tierce,
    // ni d'exposer les reponses de l'API a une origine externe.
    void reply.header('X-Content-Type-Options', 'nosniff');
    void reply.header('X-Frame-Options', 'DENY');
    void reply.header('Referrer-Policy', 'no-referrer');
    if (request.url.startsWith('/api')) void reply.header('Cache-Control', 'no-store');
  });

  await app.register(fastifyStatic, { root: publicDir, index: ['index.html'] });

  registerRoutes(app, db);

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api')) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.sendFile('index.html');
  });

  app.setErrorHandler(async (error: unknown, request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: unknown }).statusCode) || 500
        : 500;
    log.error('erreur non geree', { url: request.url, err: message });
    return reply.code(statusCode).send({
      error: 'internal_error',
      message: config.env === 'production' ? 'Erreur interne.' : message,
    });
  });

  return app;
}

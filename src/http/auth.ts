import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

/** Comparaison a temps constant, pour ne pas fuiter le jeton octet par octet. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Extrait le jeton d'un en-tete Authorization, d'un en-tete dedie ou de la query. */
function extractToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  const custom = request.headers['x-auth-token'];
  if (typeof custom === 'string') return custom.trim();
  const query = request.query as Record<string, unknown> | undefined;
  const fromQuery = query?.['token'];
  if (typeof fromQuery === 'string') return fromQuery.trim();
  return '';
}

/**
 * Garde d'authentification pour `/api`.
 *
 * Outil mono-utilisateur : un seul jeton partage suffit. Si `AUTH_TOKEN` est
 * vide, l'API est ouverte — pratique en local, dangereux des que le service
 * est joignable depuis Internet. Le demarrage emet un avertissement explicite
 * dans ce cas.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!config.authToken) return;
  const token = extractToken(request);
  if (token && safeEqual(token, config.authToken)) return;
  await reply.code(401).send({ error: 'unauthorized', message: 'Jeton invalide ou absent.' });
}

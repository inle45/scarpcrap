/** Client HTTP : timeout, retry exponentiel, respect de Retry-After. */

import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { RateLimiter, sleep } from './ratelimit.js';

const log = createLogger('http');

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`HTTP ${status} sur ${url}`);
    this.name = 'HttpError';
  }

  /** Une erreur transitoire merite un retry ; une 4xx metier non. */
  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retries?: number;
  limiter?: RateLimiter;
}

/**
 * Effectue une requete et renvoie le corps parse en JSON.
 * Le retry est exponentiel avec jitter ; un 429 assorti d'un `Retry-After`
 * penalise en plus le limiteur partage, pour que les appels suivants
 * n'aggravent pas la situation.
 */
export async function requestJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 15_000,
    retries = 3,
    limiter,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (limiter) await limiter.acquire();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          'User-Agent': config.userAgent,
          ...headers,
        },
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new HttpError(res.status, url, text.slice(0, 500));

        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after'));
          const penaltyMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5_000;
          limiter?.penalize(penaltyMs);
          log.warn('429 recu, ralentissement', { url, penaltyMs });
        }

        if (!err.retryable || attempt === retries) throw err;
        lastError = err;
      } else {
        // 204 / corps vide : renvoyer un objet vide plutot que planter sur JSON.parse.
        const text = await res.text();
        return (text ? JSON.parse(text) : {}) as T;
      }
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const isHttp = err instanceof HttpError;
      if (isHttp && !err.retryable) throw err;
      if (attempt === retries) throw err;
      lastError = err;
      if (isAbort) log.warn('timeout, nouvelle tentative', { url, attempt });
    } finally {
      clearTimeout(timer);
    }

    const backoffMs = Math.round(500 * 2 ** attempt * (0.75 + Math.random() * 0.5));
    await sleep(backoffMs);
  }

  throw lastError instanceof Error ? lastError : new Error(`Echec de la requete ${url}`);
}

/** Variante texte, utilisee pour les endpoints qui ne renvoient pas de JSON (ntfy). */
export async function requestText(url: string, options: RequestOptions = {}): Promise<string> {
  const { method = 'GET', headers = {}, body, timeoutMs = 10_000 } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'User-Agent': config.userAgent, ...headers },
      ...(body === undefined ? {} : { body }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, url, text.slice(0, 500));
    return text;
  } finally {
    clearTimeout(timer);
  }
}

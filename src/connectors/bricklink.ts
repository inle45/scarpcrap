import { createHmac, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import type { CompResult, RawListing } from '../types.js';
import { requestJson } from '../util/http.js';
import type { Connector, ConnectorContext } from './types.js';

/**
 * BrickLink — fournisseur de comparaisons pour le domaine LEGO.
 *
 * Comme Discogs, l'API v3 ne permet pas de parcourir les stocks des autres
 * vendeurs : ce n'est pas une source d'achat. Elle donne en revanche le
 * guide de prix `sold`, c'est-a-dire les transactions **reellement conclues**
 * sur les six derniers mois. C'est la donnee la plus solide du projet.
 *
 * L'authentification est OAuth 1.0a « one-legged » (HMAC-SHA1) : pas de
 * redirection, juste quatre secrets a generer une fois sur son compte.
 */

const API = 'https://api.bricklink.com/api/store/v1';

/** Encodage percent conforme RFC 3986, requis par OAuth 1.0a. */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Construit l'en-tete Authorization OAuth 1.0a.
 * Les parametres de requete entrent dans la signature : les oublier produit
 * un 401 impossible a diagnostiquer depuis les logs de BrickLink.
 */
function oauthHeader(method: string, url: string, query: Record<string, string>): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: config.bricklink.consumerKey,
    oauth_token: config.bricklink.token,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_version: '1.0',
  };

  const allParams = { ...query, ...oauth };
  const normalized = Object.keys(allParams)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(allParams[k] ?? '')}`)
    .join('&');

  const baseString = [method.toUpperCase(), rfc3986(url), rfc3986(normalized)].join('&');
  const signingKey = `${rfc3986(config.bricklink.consumerSecret)}&${rfc3986(config.bricklink.tokenSecret)}`;
  const signature = createHmac('sha1', signingKey).update(baseString).digest('base64');

  const header: Record<string, string> = { ...oauth, oauth_signature: signature };
  return (
    'OAuth ' +
    Object.keys(header)
      .sort()
      .map((k) => `${rfc3986(k)}="${rfc3986(header[k] ?? '')}"`)
      .join(', ')
  );
}

interface PriceGuideResponse {
  meta?: { code?: number; message?: string };
  data?: {
    currency_code?: string;
    min_price?: string;
    max_price?: string;
    avg_price?: string;
    qty_avg_price?: string;
    unit_quantity?: number;
    total_quantity?: number;
  };
}

/**
 * Extrait un numero de set LEGO depuis un titre d'annonce.
 * BrickLink identifie les sets par « numero-variante », presque toujours
 * `-1`. Les nombres a 2-3 chiffres sont ecartes : ce sont des nombres de
 * pieces ou des annees, pas des references.
 */
export function extractSetNumber(title: string): string | null {
  const explicit = /\b(\d{4,7})-(\d{1,2})\b/.exec(title);
  if (explicit?.[1] && explicit[2]) return `${explicit[1]}-${explicit[2]}`;

  const candidates = [...title.matchAll(/\b(\d{4,7})\b/g)]
    .map((m) => m[1] as string)
    // Une annee de sortie n'est pas une reference de set.
    .filter((n) => !(n.length === 4 && Number(n) >= 1930 && Number(n) <= 2100));

  const first = candidates[0];
  return first ? `${first}-1` : null;
}

function toCents(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

async function priceGuide(
  setNo: string,
  usedOrNew: 'N' | 'U',
  ctx: ConnectorContext,
): Promise<PriceGuideResponse['data'] | null> {
  const url = `${API}/items/SET/${encodeURIComponent(setNo)}/price`;
  const query: Record<string, string> = {
    guide_type: 'sold',
    new_or_used: usedOrNew,
    country_code: config.market.country,
    currency_code: config.market.currency,
  };

  ctx.budget.take();
  const res = await requestJson<PriceGuideResponse>(
    `${url}?${new URLSearchParams(query).toString()}`,
    {
      headers: { Authorization: oauthHeader('GET', url, query) },
      limiter: ctx.limiter,
      retries: 2,
    },
  );

  if (res.meta?.code !== 200) {
    ctx.log.debug('BrickLink a refuse la requete', { setNo, meta: res.meta });
    return null;
  }
  return res.data ?? null;
}

export const bricklinkConnector: Connector = {
  id: 'bricklink',
  label: 'BrickLink',
  domains: ['lego'],
  compliance: {
    level: 'official-api',
    summary:
      'API officielle gratuite (OAuth 1.0a). Le guide de prix « sold » couvre les ' +
      'transactions reellement conclues sur six mois : donnee de vente reelle, pas ' +
      'un prix demande.',
    reference: 'https://www.bricklink.com/v3/api.page',
  },

  isConfigured(): boolean {
    const b = config.bricklink;
    return Boolean(b.consumerKey && b.consumerSecret && b.token && b.tokenSecret);
  },

  missingConfig(): string {
    return (
      'BRICKLINK_CONSUMER_KEY / _SECRET / TOKEN / TOKEN_SECRET manquants ' +
      '(bricklink.com/v2/api/register_consumer.page, gratuit).'
    );
  },

  async comps(listing: RawListing, ctx: ConnectorContext): Promise<CompResult[]> {
    if (listing.domain !== 'lego') return [];
    if (ctx.budget.remaining < 1) return [];

    const setNo = listing.productKey ?? extractSetNumber(listing.title);
    if (!setNo) {
      ctx.log.debug('aucun numero de set identifiable', { title: listing.title });
      return [];
    }

    const usedOrNew = listing.condition === 'new' ? 'N' : 'U';
    let data: PriceGuideResponse['data'] | null;
    try {
      data = await priceGuide(setNo, usedOrNew, ctx);
    } catch (err) {
      ctx.log.debug('guide de prix BrickLink indisponible', {
        setNo,
        err: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
    if (!data) return [];

    // `qty_avg_price` pondere par les quantites vendues : plus representatif
    // que la moyenne simple quand un vendeur ecoule un gros lot.
    const avgCents = toCents(data.qty_avg_price) || toCents(data.avg_price);
    if (avgCents <= 0) return [];

    const times = data.unit_quantity ?? 0;
    const totalQty = data.total_quantity ?? 0;
    if (times < 2) {
      ctx.log.debug('trop peu de ventes BrickLink pour conclure', { setNo, times });
      return [];
    }

    return [
      {
        source: 'bricklink',
        kind: 'sold',
        sampleSize: times,
        priceMinCents: toCents(data.min_price) || Math.round(avgCents * 0.7),
        priceMedianCents: avgCents,
        priceMaxCents: toCents(data.max_price) || Math.round(avgCents * 1.3),
        currency: data.currency_code ?? config.market.currency,
        quality: Math.round(Math.min(0.7 + times / 100, 0.95) * 100) / 100,
        daysToSell: estimateDaysToSell(times),
        note: `BrickLink set ${setNo} (${usedOrNew === 'N' ? 'neuf' : 'occasion'}) — ${times} ventes conclues sur 6 mois, ${totalQty} unites`,
      },
    ];
  },
};

/**
 * Le guide « sold » couvre six mois. Le nombre de ventes sur cette periode
 * donne directement un delai moyen entre deux ventes.
 */
function estimateDaysToSell(salesInSixMonths: number): number {
  if (salesInSixMonths <= 0) return 90;
  const days = Math.round(180 / salesInSixMonths);
  return Math.min(Math.max(days, 7), 120);
}

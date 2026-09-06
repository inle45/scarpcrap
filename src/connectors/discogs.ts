import { config } from '../config.js';
import type { CompResult, Condition, RawListing } from '../types.js';
import { requestJson } from '../util/http.js';
import { searchQueryFromTitle, similarity } from '../util/text.js';
import type { Connector, ConnectorContext } from './types.js';

/**
 * Discogs — fournisseur de comparaisons pour le domaine musique.
 *
 * Discogs n'expose pas de recherche publique sur les annonces de la
 * marketplace : impossible d'en faire une source d'achat via l'API. En
 * revanche `marketplace/price_suggestions` s'appuie sur l'historique des
 * ventes reelles, ce qui en fait la meilleure donnee de prix gratuite du
 * projet — bien meilleure que les prix demandes d'eBay.
 *
 * L'arbitrage typique : acheter un lot de vinyles mal titre sur eBay,
 * revendre a la piece sur Discogs.
 */

const API = 'https://api.discogs.com';

/** Correspondance entre nos etats et les grades Goldmine utilises par Discogs. */
const GRADE_BY_CONDITION: Record<Condition, string> = {
  new: 'Mint (M)',
  like_new: 'Near Mint (NM or M-)',
  good: 'Very Good Plus (VG+)',
  fair: 'Very Good (VG)',
  poor: 'Good (G)',
  unknown: 'Very Good Plus (VG+)',
};

/** Ordre de repli si le grade exact n'a pas de suggestion de prix. */
const GRADE_FALLBACK: readonly string[] = [
  'Very Good Plus (VG+)',
  'Near Mint (NM or M-)',
  'Very Good (VG)',
  'Mint (M)',
  'Good Plus (G+)',
  'Good (G)',
];

interface SearchResponse {
  results?: Array<{
    id?: number;
    title?: string;
    year?: string;
    format?: string[];
    type?: string;
  }>;
}

interface ReleaseResponse {
  id?: number;
  title?: string;
  num_for_sale?: number;
  lowest_price?: number | null;
  community?: { have?: number; want?: number };
}

type PriceSuggestions = Record<string, { currency?: string; value?: number } | undefined>;

function authHeaders(): Record<string, string> {
  return { Authorization: `Discogs token=${config.discogs.token}` };
}

/** Extrait un identifiant de release depuis une URL ou un texte Discogs. */
function releaseIdFromText(text: string): number | null {
  const match = /discogs\.com\/(?:[a-z]{2}\/)?release\/(\d+)/i.exec(text);
  if (!match?.[1]) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) ? id : null;
}

export const discogsConnector: Connector = {
  id: 'discogs',
  label: 'Discogs',
  domains: ['music'],
  compliance: {
    level: 'official-api',
    summary:
      "API officielle gratuite, 60 requetes/minute avec jeton personnel. " +
      "`price_suggestions` s'appuie sur des ventes reellement conclues : " +
      "c'est la donnee de prix la plus fiable du projet.",
    reference: 'https://www.discogs.com/developers',
  },

  isConfigured(): boolean {
    return Boolean(config.discogs.token);
  },

  missingConfig(): string {
    return 'DISCOGS_TOKEN manquant (discogs.com/settings/developers, gratuit, jeton personnel).';
  },

  async comps(listing: RawListing, ctx: ConnectorContext): Promise<CompResult[]> {
    if (listing.domain !== 'music') return [];
    if (ctx.budget.remaining < 3) return [];

    // 1. Retrouver la release. Une URL Discogs dans l'annonce evite la recherche.
    let releaseId = listing.productKey ? Number(listing.productKey) : null;
    if (!releaseId || !Number.isFinite(releaseId)) {
      releaseId = releaseIdFromText(`${listing.title} ${listing.description}`);
    }
    let matchedTitle = '';

    if (!releaseId) {
      const query = searchQueryFromTitle(listing.title, 5);
      if (!query) return [];
      ctx.budget.take();
      const search = await requestJson<SearchResponse>(
        `${API}/database/search?${new URLSearchParams({ q: query, type: 'release', per_page: '5' })}`,
        { headers: authHeaders(), limiter: ctx.limiter, retries: 2 },
      );
      const candidates = (search.results ?? []).filter((r) => typeof r.id === 'number' && r.title);
      // Le moteur Discogs est permissif : sans seuil de similarite on
      // rattache l'annonce a une release qui n'a rien a voir.
      const best = candidates
        .map((r) => ({ r, score: similarity(r.title ?? '', listing.title) }))
        .sort((a, b) => b.score - a.score)[0];
      if (!best || best.score < 0.3) {
        ctx.log.debug('aucune release Discogs correspondante', { title: listing.title });
        return [];
      }
      releaseId = best.r.id as number;
      matchedTitle = best.r.title ?? '';
    }

    // 2. Etat du marche : nombre d'exemplaires en vente, demande de la communaute.
    ctx.budget.take();
    const release = await requestJson<ReleaseResponse>(
      `${API}/releases/${releaseId}?${new URLSearchParams({ curr_abbr: config.market.currency })}`,
      { headers: authHeaders(), limiter: ctx.limiter, retries: 2 },
    );

    // 3. Prix suggeres par grade, derives des ventes passees.
    ctx.budget.take();
    const suggestions = await requestJson<PriceSuggestions>(
      `${API}/marketplace/price_suggestions/${releaseId}`,
      { headers: authHeaders(), limiter: ctx.limiter, retries: 2 },
    );

    const wanted = GRADE_BY_CONDITION[listing.condition];
    const order = [wanted, ...GRADE_FALLBACK.filter((g) => g !== wanted)];
    const picked = order
      .map((grade) => ({ grade, entry: suggestions[grade] }))
      .find((x) => typeof x.entry?.value === 'number' && x.entry.value > 0);

    if (!picked?.entry?.value) {
      ctx.log.debug('pas de suggestion de prix Discogs', { releaseId });
      return [];
    }

    // Les suggestions sont libellees dans la devise du compte proprietaire du
    // jeton. Convertir a l'aveugle produirait des ROI faux : on refuse plutot.
    const currency = picked.entry.currency ?? config.market.currency;
    if (currency !== config.market.currency) {
      ctx.log.warn(
        'devise Discogs differente du marche : regle la devise par defaut de ton compte Discogs',
        { got: currency, expected: config.market.currency },
      );
      return [];
    }

    const suggested = Math.round(picked.entry.value * 100);
    const lowest = typeof release.lowest_price === 'number' ? Math.round(release.lowest_price * 100) : null;
    const forSale = release.num_for_sale ?? 0;
    const have = release.community?.have ?? 0;
    const want = release.community?.want ?? 0;

    // Une meilleure suggestion existe presque toujours au grade superieur :
    // on prend le maximum des grades comme borne haute realiste.
    const allValues = Object.values(suggestions)
      .map((e) => (typeof e?.value === 'number' ? Math.round(e.value * 100) : 0))
      .filter((v) => v > 0);
    const maxCents = allValues.length > 0 ? Math.max(...allValues) : suggested;

    return [
      {
        source: 'discogs',
        kind: 'sold',
        sampleSize: Math.max(forSale, 1),
        priceMinCents: lowest ?? Math.round(suggested * 0.7),
        priceMedianCents: suggested,
        priceMaxCents: maxCents,
        currency,
        quality: discogsQuality(have, want, forSale),
        daysToSell: estimateDaysToSell(have, want, forSale),
        note:
          `Discogs release ${releaseId}${matchedTitle ? ` (${matchedTitle})` : ''} — ` +
          `prix suggere pour ${picked.grade}, ${forSale} en vente, ${want} recherches / ${have} possedes`,
      },
    ];
  },
};

/**
 * Confiance elevee (base sur des ventes reelles) mais moderee quand la
 * communaute est petite : une suggestion calculee sur trois ventes vaut peu.
 */
function discogsQuality(have: number, want: number, forSale: number): number {
  const community = Math.min((have + want) / 400, 1);
  const depth = Math.min(forSale / 15, 1);
  return Math.round((0.55 + 0.25 * community + 0.2 * depth) * 100) / 100;
}

/**
 * Le rapport « recherches / possedes » est l'indicateur de demande standard
 * sur Discogs : au-dessus de 1, il y a plus d'acheteurs que de detenteurs.
 */
function estimateDaysToSell(have: number, want: number, forSale: number): number {
  const ratio = have > 0 ? want / have : 0;
  let days: number;
  if (ratio >= 1) days = 14;
  else if (ratio >= 0.5) days = 21;
  else if (ratio >= 0.25) days = 35;
  else days = 60;
  // Beaucoup d'exemplaires deja en vente = concurrence sur le prix, donc plus lent.
  if (forSale > 50) days = Math.round(days * 1.5);
  return days;
}

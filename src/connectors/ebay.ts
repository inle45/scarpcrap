import { config } from '../config.js';
import type { CompResult, Condition, RawListing } from '../types.js';
import { requestJson } from '../util/http.js';
import { dropOutliers, median, percentile } from '../util/money.js';
import { searchQueryFromTitle, similarity } from '../util/text.js';
import { huntsForSource, type Hunt } from './hunts.js';
import type { Connector, ConnectorContext } from './types.js';

/**
 * eBay Browse API — la seule source de decouverte du MVP.
 *
 * Officielle, gratuite, ~5000 appels/jour tous quotas confondus.
 * Limite structurelle a garder en tete : Browse ne renvoie que les annonces
 * **actives**. Les prix de vente reels demandent l'API Marketplace Insights,
 * dont l'acces est soumis a validation eBay. Toutes les comparaisons issues
 * d'eBay sont donc des prix *demandes*, systematiquement optimistes — c'est
 * pourquoi elles sont marquees `kind: 'active'` et decotees par le moteur.
 */

const BASE = config.ebay.sandbox ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
const OAUTH_URL = `${BASE}/identity/v1/oauth2/token`;
const SEARCH_URL = `${BASE}/buy/browse/v1/item_summary/search`;
const ITEM_URL = `${BASE}/buy/browse/v1/item`;

interface TokenState {
  accessToken: string;
  expiresAt: number;
}

let token: TokenState | null = null;

async function getToken(): Promise<string> {
  // 60 s de marge : evite d'utiliser un jeton qui expire pendant l'appel.
  if (token && token.expiresAt > Date.now() + 60_000) return token.accessToken;

  const basic = Buffer.from(`${config.ebay.clientId}:${config.ebay.clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'https://api.ebay.com/oauth/api_scope',
  }).toString();

  const res = await requestJson<{ access_token: string; expires_in: number }>(OAUTH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    retries: 2,
  });

  token = {
    accessToken: res.access_token,
    expiresAt: Date.now() + res.expires_in * 1000,
  };
  return token.accessToken;
}

/** Reinitialise le jeton en cache. Utilise par les tests. */
export function resetEbayToken(): void {
  token = null;
}

/* ───────────────────────── Types de reponse ───────────────────── */

interface EbayPrice {
  value?: string;
  currency?: string;
}

interface EbayItemSummary {
  itemId?: string;
  legacyItemId?: string;
  title?: string;
  shortDescription?: string;
  price?: EbayPrice;
  condition?: string;
  conditionId?: string;
  itemWebUrl?: string;
  image?: { imageUrl?: string };
  thumbnailImages?: Array<{ imageUrl?: string }>;
  additionalImages?: Array<{ imageUrl?: string }>;
  seller?: {
    username?: string;
    feedbackPercentage?: string;
    feedbackScore?: number;
  };
  shippingOptions?: Array<{
    shippingCost?: EbayPrice;
    minEstimatedDeliveryDate?: string;
    maxEstimatedDeliveryDate?: string;
  }>;
  itemLocation?: { country?: string; postalCode?: string; city?: string };
  categories?: Array<{ categoryId?: string; categoryName?: string }>;
  itemCreationDate?: string;
}

interface EbaySearchResponse {
  total?: number;
  itemSummaries?: EbayItemSummary[];
  warnings?: Array<{ message?: string }>;
}

interface EbayItemDetail extends EbayItemSummary {
  description?: string;
  itemCreationDate?: string;
  estimatedAvailabilities?: Array<{ estimatedAvailableQuantity?: number }>;
  seller?: EbayItemSummary['seller'] & { userRegistrationDate?: string };
}

/* ────────────────────────── Conversions ───────────────────────── */

const CONDITION_BY_ID: Record<string, Condition> = {
  '1000': 'new',
  '1500': 'like_new',
  '1750': 'like_new',
  '2000': 'good',
  '2010': 'like_new',
  '2020': 'good',
  '2030': 'good',
  '2500': 'good',
  '3000': 'good',
  '4000': 'good',
  '5000': 'fair',
  '6000': 'fair',
  '7000': 'poor',
};

function toCondition(item: EbayItemSummary): Condition {
  const byId = item.conditionId ? CONDITION_BY_ID[item.conditionId] : undefined;
  if (byId) return byId;
  const label = (item.condition ?? '').toLowerCase();
  if (label.includes('new')) return 'new';
  if (label.includes('refurb')) return 'good';
  if (label.includes('parts')) return 'poor';
  if (label.includes('used')) return 'good';
  return 'unknown';
}

function toCents(price: EbayPrice | undefined): number {
  const value = Number(price?.value);
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

function shippingCents(item: EbayItemSummary): number {
  const option = item.shippingOptions?.[0];
  if (!option) return 0;
  return toCents(option.shippingCost);
}

/** Delai de reception en jours, deduit de la date de livraison estimee la plus tardive. */
function shippingDays(item: EbayItemSummary): number | null {
  const iso = item.shippingOptions?.[0]?.maxEstimatedDeliveryDate;
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.max(1, Math.round(ms / 86_400_000));
}

function imagesCount(item: EbayItemSummary): number {
  const extra = item.additionalImages?.length ?? 0;
  return (item.image?.imageUrl ? 1 : 0) + extra;
}

/** Construit le parametre `filter` de l'API Browse. */
function buildFilter(hunt: Hunt): string {
  const parts: string[] = ['buyingOptions:{FIXED_PRICE}'];

  const min = hunt.minPriceEur;
  const max = hunt.maxPriceEur;
  if (min !== null || max !== null) {
    parts.push(`price:[${min ?? ''}..${max ?? ''}]`);
    parts.push(`priceCurrency:${config.market.currency}`);
  }

  // eBay ne distingue que NEW / USED dans les filtres de recherche ;
  // le grain fin (`conditionId`) n'est disponible qu'a la lecture.
  const wantsNew = hunt.conditions.includes('new');
  const wantsUsed = hunt.conditions.some((c) => c !== 'new');
  if (wantsNew && !wantsUsed) parts.push('conditions:{NEW}');
  else if (wantsUsed && !wantsNew) parts.push('conditions:{USED}');

  parts.push(`deliveryCountry:${config.market.country}`);
  return parts.join(',');
}

function toRawListing(item: EbayItemSummary, hunt: Hunt, marketplace: string): RawListing | null {
  const externalId = item.itemId ?? item.legacyItemId;
  const title = item.title;
  if (!externalId || !title) return null;
  const priceCents = toCents(item.price);
  if (priceCents <= 0) return null;

  const feedbackPct = Number(item.seller?.feedbackPercentage);

  return {
    source: 'ebay',
    externalId,
    url: item.itemWebUrl ?? `https://www.ebay.fr/itm/${externalId}`,
    title,
    description: item.shortDescription ?? '',
    priceCents,
    shippingCents: shippingCents(item),
    currency: item.price?.currency ?? config.market.currency,
    condition: toCondition(item),
    sourceCategory: item.categories?.[0]?.categoryName ?? '',
    domain: hunt.domain,
    sellerId: item.seller?.username ?? '',
    sellerName: item.seller?.username ?? '',
    sellerRating: Number.isFinite(feedbackPct) ? feedbackPct : null,
    sellerFeedbackCount: item.seller?.feedbackScore ?? null,
    sellerSince: null,
    imageUrl: item.image?.imageUrl ?? item.thumbnailImages?.[0]?.imageUrl ?? null,
    imagesCount: imagesCount(item),
    location: item.itemLocation?.country ?? null,
    shippingDays: shippingDays(item),
    raw: { marketplace, huntId: hunt.id, item },
  };
}

/* ─────────────────────── Appels API ───────────────────────────── */

async function search(
  params: URLSearchParams,
  marketplace: string,
  ctx: ConnectorContext,
): Promise<EbaySearchResponse> {
  ctx.budget.take();
  const accessToken = await getToken();
  return requestJson<EbaySearchResponse>(`${SEARCH_URL}?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-EBAY-C-MARKETPLACE-ID': marketplace,
      'Content-Type': 'application/json',
    },
    limiter: ctx.limiter,
  });
}

/* ─────────────────────────── Connecteur ───────────────────────── */

export const ebayConnector: Connector = {
  id: 'ebay',
  label: 'eBay',
  domains: ['*'],
  compliance: {
    level: 'official-api',
    summary:
      "API Browse officielle et gratuite (~5000 appels/jour). Aucun scraping HTML. " +
      "Limite : ne renvoie que les annonces actives, pas les prix de vente reels.",
    reference: 'https://developer.ebay.com/api-docs/buy/browse/overview.html',
  },

  isConfigured(): boolean {
    return Boolean(config.ebay.clientId && config.ebay.clientSecret);
  },

  missingConfig(): string {
    return 'EBAY_CLIENT_ID et EBAY_CLIENT_SECRET manquants (developer.ebay.com, gratuit).';
  },

  async discover(ctx: ConnectorContext): Promise<RawListing[]> {
    const hunts = huntsForSource('ebay');
    const out: RawListing[] = [];
    const seen = new Set<string>();

    for (const hunt of hunts) {
      if (ctx.budget.remaining <= 0) {
        ctx.log.warn('budget eBay epuise, chasses restantes ignorees', { stopped: hunt.id });
        break;
      }

      const params = new URLSearchParams({
        q: hunt.query,
        limit: String(Math.min(hunt.limit, 200)),
        filter: buildFilter(hunt),
        // Les meilleures affaires sont dans les annonces recentes : trie
        // par date pour ne pas revoir les memes invendus a chaque cycle.
        sort: 'newlyListed',
      });
      if (hunt.categoryIds.length > 0) params.set('category_ids', hunt.categoryIds.join(','));

      try {
        const res = await search(params, config.ebay.marketplaceId, ctx);
        for (const item of res.itemSummaries ?? []) {
          const listing = toRawListing(item, hunt, config.ebay.marketplaceId);
          if (!listing) continue;
          if (seen.has(listing.externalId)) continue;
          seen.add(listing.externalId);
          out.push(listing);
        }
        ctx.log.debug('chasse terminee', { hunt: hunt.id, found: res.itemSummaries?.length ?? 0 });
      } catch (err) {
        ctx.log.warn('chasse en echec', {
          hunt: hunt.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return out;
  },

  /**
   * Recupere la fiche complete : description, anciennete du vendeur, photos.
   * Un appel par annonce, donc reserve aux candidats deja prometteurs.
   */
  async enrich(listing: RawListing, ctx: ConnectorContext): Promise<RawListing> {
    if (!ctx.budget.tryTake()) return listing;
    try {
      const accessToken = await getToken();
      const detail = await requestJson<EbayItemDetail>(
        `${ITEM_URL}/${encodeURIComponent(listing.externalId)}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'X-EBAY-C-MARKETPLACE-ID': config.ebay.marketplaceId,
          },
          limiter: ctx.limiter,
          retries: 1,
        },
      );

      const description = (detail.description ?? detail.shortDescription ?? listing.description)
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      return {
        ...listing,
        description: description || listing.description,
        sellerSince: detail.seller?.userRegistrationDate ?? listing.sellerSince,
        imagesCount: Math.max(listing.imagesCount, imagesCount(detail)),
        shippingDays: shippingDays(detail) ?? listing.shippingDays,
        raw: { ...(listing.raw as object), detail },
      };
    } catch (err) {
      ctx.log.debug('enrichissement eBay impossible', {
        id: listing.externalId,
        err: err instanceof Error ? err.message : String(err),
      });
      return listing;
    }
  },

  /**
   * Estime le prix de revente en cherchant des annonces actives comparables
   * sur les marketplaces de comparaison configures (par defaut FR + DE).
   */
  async comps(listing: RawListing, ctx: ConnectorContext): Promise<CompResult[]> {
    const query = searchQueryFromTitle(listing.title);
    if (!query) return [];

    const results: CompResult[] = [];

    for (const marketplace of config.ebay.compMarketplaces) {
      if (ctx.budget.remaining <= 0) break;

      const params = new URLSearchParams({
        q: query,
        limit: '50',
        filter: `buyingOptions:{FIXED_PRICE},priceCurrency:${config.market.currency}`,
      });

      try {
        const res = await search(params, marketplace, ctx);
        const candidates = (res.itemSummaries ?? []).filter((item) => {
          if (!item.title) return false;
          if (item.itemId === listing.externalId) return false;
          // Sans filtre de similarite, le moteur eBay ramene des accessoires
          // et des pieces detachees qui effondrent la mediane.
          return similarity(item.title, listing.title) >= 0.34;
        });

        const prices = dropOutliers(candidates.map((c) => toCents(c.price)).filter((c) => c > 0));
        if (prices.length < 3) {
          ctx.log.debug('echantillon insuffisant', { marketplace, kept: prices.length });
          continue;
        }

        results.push({
          source: `ebay:${marketplace}`,
          kind: 'active',
          sampleSize: prices.length,
          priceMinCents: Math.min(...prices),
          priceMedianCents: median(prices),
          // Le p90 plutot que le maximum : le prix haut atteignable, pas le
          // delire d'un vendeur isole.
          priceMaxCents: percentile(prices, 0.9),
          currency: config.market.currency,
          quality: compQuality(prices.length, res.total ?? prices.length),
          daysToSell: estimateDaysToSell(res.total ?? prices.length),
          note: `${prices.length} annonces actives comparables sur ${marketplace} (prix demandes, non vendus)`,
        });
      } catch (err) {
        ctx.log.debug('comparaison eBay en echec', {
          marketplace,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  },
};

/**
 * Confiance dans une serie de comparaisons actives.
 * Plafonnee a 0.6 : un prix demande ne vaudra jamais un prix de vente reel.
 */
function compQuality(sampleSize: number, total: number): number {
  const bySample = Math.min(sampleSize / 15, 1);
  const byDepth = Math.min(total / 40, 1);
  return Math.round((0.25 + 0.35 * bySample * 0.6 + 0.35 * byDepth * 0.4) * 100) / 100;
}

/**
 * Liquidite : plus il y a d'annonces concurrentes, plus la revente est lente.
 * Heuristique volontairement grossiere, remplacee des qu'on dispose de
 * ventes reelles dans la table `capital`.
 */
function estimateDaysToSell(activeCount: number): number {
  if (activeCount <= 5) return 45;
  if (activeCount <= 20) return 30;
  if (activeCount <= 60) return 21;
  if (activeCount <= 200) return 14;
  return 10;
}

import type BetterSqlite3 from 'better-sqlite3';
import { config } from '../config.js';
import type {
  CompResult,
  DealStatus,
  Domain,
  Economics,
  RawListing,
  TrustResult,
} from '../types.js';
import { median, mean, round } from '../util/money.js';

type Db = BetterSqlite3.Database;

const now = (): string => new Date().toISOString();

/* ─────────────────────────── Reglages ─────────────────────────── */

export interface Settings {
  minTrustScore: number;
  minRoiPct: number;
  minNetProfitCents: number;
  alertMinTrustScore: number;
  alertMinRoiPerDayCents: number;
  alertMaxPerRun: number;
}

const SETTING_KEYS: ReadonlyArray<keyof Settings> = [
  'minTrustScore',
  'minRoiPct',
  'minNetProfitCents',
  'alertMinTrustScore',
  'alertMinRoiPerDayCents',
  'alertMaxPerRun',
];

/**
 * Les seuils vivent en base pour etre modifiables depuis le dashboard sans
 * redemarrage. Les variables d'environnement ne servent qu'a l'amorcage.
 */
export function getSettings(db: Db): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{
    key: string;
    value: string;
  }>;
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const out = { ...config.defaultSettings } as Settings;
  for (const key of SETTING_KEYS) {
    const raw = stored.get(key);
    if (raw === undefined) continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) out[key] = parsed;
  }
  return out;
}

export function setSettings(db: Db, patch: Partial<Settings>): Settings {
  const stmt = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const ts = now();
  const apply = db.transaction((entries: Array<[string, number]>) => {
    for (const [key, value] of entries) stmt.run(key, String(value), ts);
  });
  const entries = SETTING_KEYS.filter((k) => typeof patch[k] === 'number' && Number.isFinite(patch[k]))
    .map((k) => [k, patch[k] as number] as [string, number]);
  if (entries.length > 0) apply(entries);
  return getSettings(db);
}

/* ─────────────────────────── Annonces ─────────────────────────── */

export function listingId(source: string, externalId: string): string {
  return `${source}:${externalId}`;
}

/**
 * Insere l'annonce ou rafraichit ses champs volatils (prix, dates).
 * `first_seen_at` n'est jamais ecrase : c'est ce qui permet de savoir
 * depuis combien de temps une annonce traine sans trouver preneur.
 */
export function upsertListing(db: Db, listing: RawListing): string {
  const id = listingId(listing.source, listing.externalId);
  const ts = now();
  db.prepare(
    `INSERT INTO listings (
       id, source, external_id, url, title, description, price_cents, shipping_cents,
       currency, condition, source_category, domain, product_key,
       seller_id, seller_name, seller_rating, seller_feedback_count, seller_since,
       image_url, images_count, location, shipping_days, raw_json,
       first_seen_at, last_seen_at
     ) VALUES (
       @id, @source, @externalId, @url, @title, @description, @priceCents, @shippingCents,
       @currency, @condition, @sourceCategory, @domain, @productKey,
       @sellerId, @sellerName, @sellerRating, @sellerFeedbackCount, @sellerSince,
       @imageUrl, @imagesCount, @location, @shippingDays, @rawJson,
       @ts, @ts
     )
     ON CONFLICT (id) DO UPDATE SET
       url = excluded.url,
       title = excluded.title,
       description = excluded.description,
       price_cents = excluded.price_cents,
       shipping_cents = excluded.shipping_cents,
       condition = excluded.condition,
       image_url = excluded.image_url,
       images_count = excluded.images_count,
       shipping_days = excluded.shipping_days,
       seller_rating = excluded.seller_rating,
       seller_feedback_count = excluded.seller_feedback_count,
       raw_json = excluded.raw_json,
       last_seen_at = excluded.last_seen_at`,
  ).run({
    id,
    source: listing.source,
    externalId: listing.externalId,
    url: listing.url,
    title: listing.title,
    description: listing.description,
    priceCents: listing.priceCents,
    shippingCents: listing.shippingCents,
    currency: listing.currency,
    condition: listing.condition,
    sourceCategory: listing.sourceCategory,
    domain: listing.domain,
    productKey: listing.productKey ?? null,
    sellerId: listing.sellerId,
    sellerName: listing.sellerName,
    sellerRating: listing.sellerRating,
    sellerFeedbackCount: listing.sellerFeedbackCount,
    sellerSince: listing.sellerSince,
    imageUrl: listing.imageUrl,
    imagesCount: listing.imagesCount,
    location: listing.location,
    shippingDays: listing.shippingDays,
    rawJson: JSON.stringify(listing.raw ?? {}),
    ts,
  });
  return id;
}

export function hasListing(db: Db, source: string, externalId: string): boolean {
  const row = db
    .prepare('SELECT 1 AS x FROM listings WHERE id = ?')
    .get(listingId(source, externalId));
  return row !== undefined;
}

/* ─────────────────────── Comparaisons de prix ─────────────────── */

export function replaceComps(db: Db, listingIdValue: string, comps: CompResult[]): void {
  const ts = now();
  const del = db.prepare('DELETE FROM comps WHERE listing_id = ?');
  const ins = db.prepare(
    `INSERT INTO comps (
       listing_id, source, kind, sample_size, price_min_cents, price_median_cents,
       price_max_cents, currency, quality, days_to_sell, note, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    del.run(listingIdValue);
    for (const c of comps) {
      ins.run(
        listingIdValue,
        c.source,
        c.kind,
        c.sampleSize,
        c.priceMinCents,
        c.priceMedianCents,
        c.priceMaxCents,
        c.currency,
        c.quality,
        c.daysToSell,
        c.note,
        ts,
      );
    }
  })();
}

export function getComps(db: Db, listingIdValue: string): CompResult[] {
  const rows = db
    .prepare('SELECT * FROM comps WHERE listing_id = ? ORDER BY quality DESC')
    .all(listingIdValue) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    source: r['source'] as string,
    kind: r['kind'] as CompResult['kind'],
    sampleSize: r['sample_size'] as number,
    priceMinCents: r['price_min_cents'] as number,
    priceMedianCents: r['price_median_cents'] as number,
    priceMaxCents: r['price_max_cents'] as number,
    currency: r['currency'] as string,
    quality: r['quality'] as number,
    daysToSell: r['days_to_sell'] as number,
    note: r['note'] as string,
  }));
}

/* ─────────────────────────── Deals ────────────────────────────── */

export interface UpsertDealInput {
  listingId: string;
  economics: Economics;
  trust: TrustResult;
  compQuality: number;
  categoryIndexDelta: number | null;
}

/**
 * Cree ou met a jour l'evaluation d'une annonce.
 * Un deal deja tranche (`bought`, `skipped`, `sold`) garde son statut :
 * une reevaluation ne doit jamais faire reapparaitre un deal ecarte.
 */
export function upsertDeal(db: Db, input: UpsertDealInput): { id: number; created: boolean } {
  const ts = now();
  const e = input.economics;
  const existing = db
    .prepare('SELECT id FROM deals WHERE listing_id = ?')
    .get(input.listingId) as { id: number } | undefined;

  const params = {
    listingId: input.listingId,
    buyTotal: e.buyTotalCents,
    resaleEstimate: e.resaleEstimateCents,
    resaleMax: e.resaleMaxCents,
    resaleMarketplace: e.resaleMarketplace,
    feesTotal: e.feesTotalCents,
    netProfit: e.netProfitCents,
    roiPct: e.roiPct,
    daysToReceive: e.daysToReceive,
    daysToSell: e.daysToSell,
    totalDays: e.totalDays,
    roiPerDay: e.roiPerDayCents,
    trustScore: input.trust.score,
    trustJson: JSON.stringify(input.trust),
    compQuality: input.compQuality,
    economicsJson: JSON.stringify(e),
    categoryIndexDelta: input.categoryIndexDelta,
    ts,
  };

  if (existing) {
    db.prepare(
      `UPDATE deals SET
         buy_total_cents = @buyTotal,
         resale_estimate_cents = @resaleEstimate,
         resale_max_cents = @resaleMax,
         resale_marketplace = @resaleMarketplace,
         fees_total_cents = @feesTotal,
         net_profit_cents = @netProfit,
         roi_pct = @roiPct,
         days_to_receive = @daysToReceive,
         days_to_sell = @daysToSell,
         total_days = @totalDays,
         roi_per_day_cents = @roiPerDay,
         trust_score = @trustScore,
         trust_json = @trustJson,
         comp_quality = @compQuality,
         economics_json = @economicsJson,
         category_index_delta = @categoryIndexDelta,
         updated_at = @ts
       WHERE listing_id = @listingId`,
    ).run(params);
    return { id: existing.id, created: false };
  }

  const info = db
    .prepare(
      `INSERT INTO deals (
         listing_id, buy_total_cents, resale_estimate_cents, resale_max_cents,
         resale_marketplace, fees_total_cents, net_profit_cents, roi_pct,
         days_to_receive, days_to_sell, total_days, roi_per_day_cents,
         trust_score, trust_json, comp_quality, economics_json,
         category_index_delta, status, created_at, updated_at
       ) VALUES (
         @listingId, @buyTotal, @resaleEstimate, @resaleMax,
         @resaleMarketplace, @feesTotal, @netProfit, @roiPct,
         @daysToReceive, @daysToSell, @totalDays, @roiPerDay,
         @trustScore, @trustJson, @compQuality, @economicsJson,
         @categoryIndexDelta, 'new', @ts, @ts
       )`,
    )
    .run(params);
  return { id: Number(info.lastInsertRowid), created: true };
}

export interface DealFilters {
  status?: DealStatus | 'all';
  domain?: Domain | 'all';
  source?: string | 'all';
  minRoiPct?: number;
  minTrust?: number;
  minNetProfitCents?: number;
  sort?: 'roi_per_day' | 'roi' | 'profit' | 'trust' | 'recent';
  limit?: number;
  offset?: number;
}

const SORTS: Record<NonNullable<DealFilters['sort']>, string> = {
  roi_per_day: 'd.roi_per_day_cents DESC, d.trust_score DESC',
  roi: 'd.roi_pct DESC, d.trust_score DESC',
  profit: 'd.net_profit_cents DESC, d.trust_score DESC',
  trust: 'd.trust_score DESC, d.roi_per_day_cents DESC',
  recent: 'd.created_at DESC',
};

const DEAL_COLUMNS = `
  d.id, d.listing_id, d.buy_total_cents, d.resale_estimate_cents, d.resale_max_cents,
  d.resale_marketplace, d.fees_total_cents, d.net_profit_cents, d.roi_pct,
  d.days_to_receive, d.days_to_sell, d.total_days, d.roi_per_day_cents,
  d.trust_score, d.trust_json, d.comp_quality, d.economics_json,
  d.category_index_delta, d.status, d.alerted_at, d.created_at, d.updated_at,
  l.source, l.external_id, l.url, l.title, l.description, l.price_cents,
  l.shipping_cents, l.currency, l.condition, l.domain, l.source_category,
  l.seller_name, l.seller_rating, l.seller_feedback_count, l.image_url,
  l.images_count, l.location, l.first_seen_at
`;

export function listDeals(db: Db, filters: DealFilters = {}): Array<Record<string, unknown>> {
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  const status = filters.status ?? 'new';
  if (status !== 'all') {
    where.push('d.status = @status');
    params['status'] = status;
  }
  if (filters.domain && filters.domain !== 'all') {
    where.push('l.domain = @domain');
    params['domain'] = filters.domain;
  }
  if (filters.source && filters.source !== 'all') {
    where.push('l.source = @source');
    params['source'] = filters.source;
  }
  if (typeof filters.minRoiPct === 'number') {
    where.push('d.roi_pct >= @minRoiPct');
    params['minRoiPct'] = filters.minRoiPct;
  }
  if (typeof filters.minTrust === 'number') {
    where.push('d.trust_score >= @minTrust');
    params['minTrust'] = filters.minTrust;
  }
  if (typeof filters.minNetProfitCents === 'number') {
    where.push('d.net_profit_cents >= @minNetProfit');
    params['minNetProfit'] = filters.minNetProfitCents;
  }

  const orderBy = SORTS[filters.sort ?? 'roi_per_day'];
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);

  const sql = `
    SELECT ${DEAL_COLUMNS}
    FROM deals d
    JOIN listings l ON l.id = d.listing_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${offset}
  `;
  return db.prepare(sql).all(params) as Array<Record<string, unknown>>;
}

export function countDeals(db: Db, filters: DealFilters = {}): number {
  const rows = listDeals(db, { ...filters, limit: 500, offset: 0 });
  return rows.length;
}

export function getDeal(db: Db, id: number): Record<string, unknown> | undefined {
  return db
    .prepare(
      `SELECT ${DEAL_COLUMNS} FROM deals d JOIN listings l ON l.id = d.listing_id WHERE d.id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
}

export function setDealStatus(db: Db, id: number, status: DealStatus, note = ''): boolean {
  const ts = now();
  const info = db
    .prepare('UPDATE deals SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, ts, id);
  if (info.changes === 0) return false;
  db.prepare('INSERT INTO decisions (deal_id, action, note, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    status,
    note,
    ts,
  );
  return true;
}

export function markAlerted(db: Db, id: number): void {
  db.prepare('UPDATE deals SET alerted_at = ? WHERE id = ?').run(now(), id);
}

/** Deals eligibles a une alerte : jamais alertes, encore ouverts, au-dessus des seuils. */
export function dealsToAlert(db: Db, settings: Settings, limit: number): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT ${DEAL_COLUMNS}
       FROM deals d
       JOIN listings l ON l.id = d.listing_id
       WHERE d.alerted_at IS NULL
         AND d.status = 'new'
         AND d.trust_score >= @minTrust
         AND d.roi_per_day_cents >= @minRoiPerDay
       ORDER BY d.roi_per_day_cents DESC
       LIMIT @limit`,
    )
    .all({
      minTrust: settings.alertMinTrustScore,
      minRoiPerDay: settings.alertMinRoiPerDayCents,
      limit: Math.max(1, limit),
    }) as Array<Record<string, unknown>>;
}

/* ────────────────────────── Capital ───────────────────────────── */

export function recordPurchase(db: Db, dealId: number, boughtPriceCents: number, note = ''): void {
  db.prepare(
    `INSERT INTO capital (deal_id, bought_price_cents, bought_at, note)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (deal_id) DO UPDATE SET
       bought_price_cents = excluded.bought_price_cents,
       note = excluded.note`,
  ).run(dealId, boughtPriceCents, now(), note);
}

export function recordSale(
  db: Db,
  dealId: number,
  soldPriceCents: number,
  soldFeesCents: number,
  note = '',
): boolean {
  const info = db
    .prepare(
      `UPDATE capital SET sold_price_cents = ?, sold_fees_cents = ?, sold_at = ?,
         note = CASE WHEN ? = '' THEN note ELSE ? END
       WHERE deal_id = ?`,
    )
    .run(soldPriceCents, soldFeesCents, now(), note, note, dealId);
  return info.changes > 0;
}

export interface CapitalSummary {
  investedCents: number;
  recoveredCents: number;
  realisedProfitCents: number;
  openPositions: number;
  closedPositions: number;
  openCapitalCents: number;
  avgHoldDays: number;
  winRate: number;
}

export function capitalSummary(db: Db): CapitalSummary {
  const rows = db.prepare('SELECT * FROM capital').all() as Array<Record<string, unknown>>;
  let invested = 0;
  let recovered = 0;
  let realised = 0;
  let open = 0;
  let closed = 0;
  let openCapital = 0;
  let wins = 0;
  const holdDays: number[] = [];

  for (const r of rows) {
    const bought = r['bought_price_cents'] as number;
    const sold = r['sold_price_cents'] as number | null;
    const fees = (r['sold_fees_cents'] as number) ?? 0;
    invested += bought;
    if (sold === null || sold === undefined) {
      open += 1;
      openCapital += bought;
      continue;
    }
    closed += 1;
    recovered += sold - fees;
    const profit = sold - fees - bought;
    realised += profit;
    if (profit > 0) wins += 1;
    const boughtAt = Date.parse(r['bought_at'] as string);
    const soldAt = Date.parse((r['sold_at'] as string) ?? '');
    if (Number.isFinite(boughtAt) && Number.isFinite(soldAt) && soldAt >= boughtAt) {
      holdDays.push((soldAt - boughtAt) / 86_400_000);
    }
  }

  return {
    investedCents: invested,
    recoveredCents: recovered,
    realisedProfitCents: realised,
    openPositions: open,
    closedPositions: closed,
    openCapitalCents: openCapital,
    avgHoldDays: holdDays.length ? round(holdDays.reduce((a, b) => a + b, 0) / holdDays.length, 1) : 0,
    winRate: closed > 0 ? round((wins / closed) * 100, 1) : 0,
  };
}

export function capitalPositions(db: Db): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT c.*, d.id AS deal_id, d.net_profit_cents AS estimated_profit_cents,
              l.title, l.url, l.domain, l.source, l.currency
       FROM capital c
       JOIN deals d ON d.id = c.deal_id
       JOIN listings l ON l.id = d.listing_id
       ORDER BY c.bought_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;
}

/* ────────────────── Indice de revente par categorie ───────────── */

/**
 * Recalcule la marge normale par domaine.
 *
 * On s'appuie d'abord sur les ventes reelles (table capital) : c'est la
 * seule verite terrain. Faute d'historique suffisant, on retombe sur les
 * marges estimees des deals evalues, ce qui reste utile pour comparer un
 * deal a la normale de sa categorie des le premier jour.
 */
export function recomputeCategoryStats(db: Db): void {
  const realised = db
    .prepare(
      `SELECT l.domain AS domain,
              (c.sold_price_cents - c.sold_fees_cents - c.bought_price_cents) * 100.0
                / NULLIF(c.bought_price_cents, 0) AS margin_pct,
              (julianday(c.sold_at) - julianday(c.bought_at)) AS hold_days
       FROM capital c
       JOIN deals d ON d.id = c.deal_id
       JOIN listings l ON l.id = d.listing_id
       WHERE c.sold_price_cents IS NOT NULL AND c.bought_price_cents > 0`,
    )
    .all() as Array<{ domain: string; margin_pct: number | null; hold_days: number | null }>;

  const estimated = db
    .prepare(
      `SELECT l.domain AS domain, d.roi_pct AS margin_pct, d.days_to_sell AS hold_days
       FROM deals d
       JOIN listings l ON l.id = d.listing_id
       WHERE d.comp_quality >= 0.3`,
    )
    .all() as Array<{ domain: string; margin_pct: number | null; hold_days: number | null }>;

  const byDomain = new Map<string, { margins: number[]; days: number[]; realised: number }>();
  const push = (
    rows: Array<{ domain: string; margin_pct: number | null; hold_days: number | null }>,
    isRealised: boolean,
  ): void => {
    for (const row of rows) {
      if (row.margin_pct === null || !Number.isFinite(row.margin_pct)) continue;
      const bucket = byDomain.get(row.domain) ?? { margins: [], days: [], realised: 0 };
      bucket.margins.push(row.margin_pct);
      if (row.hold_days !== null && Number.isFinite(row.hold_days)) bucket.days.push(row.hold_days);
      if (isRealised) bucket.realised += 1;
      byDomain.set(row.domain, bucket);
    }
  };

  // Au-dela de 8 ventes reelles dans un domaine, on ignore les estimations :
  // elles ne feraient que diluer une donnee de meilleure qualite.
  push(realised, true);
  for (const [domain, bucket] of byDomain) {
    if (bucket.realised >= 8) continue;
    push(estimated.filter((r) => r.domain === domain), false);
  }
  push(
    estimated.filter((r) => !byDomain.has(r.domain)),
    false,
  );

  const ts = now();
  const stmt = db.prepare(
    `INSERT INTO category_stats (domain, sample_size, avg_margin_pct, median_margin_pct, avg_days_to_sell, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (domain) DO UPDATE SET
       sample_size = excluded.sample_size,
       avg_margin_pct = excluded.avg_margin_pct,
       median_margin_pct = excluded.median_margin_pct,
       avg_days_to_sell = excluded.avg_days_to_sell,
       updated_at = excluded.updated_at`,
  );
  db.transaction(() => {
    for (const [domain, bucket] of byDomain) {
      stmt.run(
        domain,
        bucket.margins.length,
        round(mean(bucket.margins.map((m) => m * 100)) / 100, 2),
        round(median(bucket.margins.map((m) => m * 100)) / 100, 2),
        bucket.days.length ? round(mean(bucket.days.map((d) => d * 100)) / 100, 1) : 0,
        ts,
      );
    }
  })();
}

export function getCategoryStats(db: Db): Array<Record<string, unknown>> {
  return db
    .prepare('SELECT * FROM category_stats ORDER BY median_margin_pct DESC')
    .all() as Array<Record<string, unknown>>;
}

export function getCategoryMedianMargin(db: Db, domain: string): number | null {
  const row = db
    .prepare('SELECT median_margin_pct, sample_size FROM category_stats WHERE domain = ?')
    .get(domain) as { median_margin_pct: number; sample_size: number } | undefined;
  // En dessous de 5 observations, l'indice n'est pas exploitable.
  if (!row || row.sample_size < 5) return null;
  return row.median_margin_pct;
}

/* ─────────────────────── Cycles de collecte ───────────────────── */

export function startRun(db: Db, trigger: string): number {
  const info = db
    .prepare('INSERT INTO runs (started_at, status, trigger) VALUES (?, ?, ?)')
    .run(now(), 'running', trigger);
  return Number(info.lastInsertRowid);
}

export function finishRun(
  db: Db,
  id: number,
  data: {
    status: 'ok' | 'partial' | 'failed';
    listingsFound: number;
    dealsCreated: number;
    alertsSent: number;
    sources: unknown;
    errors: unknown;
  },
): void {
  db.prepare(
    `UPDATE runs SET finished_at = ?, status = ?, listings_found = ?, deals_created = ?,
       alerts_sent = ?, sources_json = ?, errors_json = ? WHERE id = ?`,
  ).run(
    now(),
    data.status,
    data.listingsFound,
    data.dealsCreated,
    data.alertsSent,
    JSON.stringify(data.sources ?? []),
    JSON.stringify(data.errors ?? []),
    id,
  );
}

export function listRuns(db: Db, limit = 20): Array<Record<string, unknown>> {
  return db
    .prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?')
    .all(Math.min(Math.max(limit, 1), 100)) as Array<Record<string, unknown>>;
}

export function listDecisions(db: Db, limit = 100): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT dec.*, l.title, l.domain, l.source, d.net_profit_cents, d.roi_pct
       FROM decisions dec
       JOIN deals d ON d.id = dec.deal_id
       JOIN listings l ON l.id = d.listing_id
       ORDER BY dec.created_at DESC LIMIT ?`,
    )
    .all(Math.min(Math.max(limit, 1), 500)) as Array<Record<string, unknown>>;
}

/**
 * Purge les annonces anciennes jamais tranchees.
 * Sans ca, la base grossit indefiniment avec des annonces disparues depuis
 * longtemps. Les deals achetes/vendus sont conserves : c'est l'historique.
 */
export function pruneOldListings(db: Db, maxAgeDays = 30): number {
  const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
  const info = db
    .prepare(
      `DELETE FROM listings
       WHERE last_seen_at < ?
         AND id NOT IN (SELECT listing_id FROM deals WHERE status IN ('bought', 'sold'))`,
    )
    .run(cutoff);
  return info.changes;
}

/**
 * Nombre d'autres vendeurs utilisant deja cette image dans la base.
 *
 * Substitut gratuit a une recherche d'image inversee : les annonces
 * frauduleuses recyclent massivement les memes photos. Ca ne detecte que la
 * reutilisation *a l'interieur* de nos propres donnees, mais ca ne coute
 * rien et ca attrape les campagnes multi-comptes.
 */
export function imageReuseCount(db: Db, imageUrl: string | null, sellerId: string): number {
  if (!imageUrl) return 0;
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT seller_id) AS n
       FROM listings
       WHERE image_url = ? AND seller_id <> ? AND seller_id <> ''`,
    )
    .get(imageUrl, sellerId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Vrai si l'annonce a deja ete tranchee : inutile de la reevaluer. */
export function isDealDecided(db: Db, listingIdValue: string): boolean {
  const row = db
    .prepare(`SELECT status FROM deals WHERE listing_id = ?`)
    .get(listingIdValue) as { status: string } | undefined;
  return row !== undefined && row.status !== 'new';
}

/** Date de derniere evaluation d'une annonce, pour eviter de la refaire trop tot. */
export function lastEvaluatedAt(db: Db, listingIdValue: string): number | null {
  const row = db
    .prepare('SELECT updated_at FROM deals WHERE listing_id = ?')
    .get(listingIdValue) as { updated_at: string } | undefined;
  if (!row) return null;
  const ts = Date.parse(row.updated_at);
  return Number.isFinite(ts) ? ts : null;
}

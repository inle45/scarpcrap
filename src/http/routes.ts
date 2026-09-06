import type BetterSqlite3 from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { createLogger, errInfo } from '../logger.js';
import { connectorStatus } from '../connectors/registry.js';
import { loadHunts } from '../connectors/hunts.js';
import { allFeeModels } from '../pipeline/fees.js';
import { runCycle, type RunSummary } from '../pipeline/run.js';
import { isNtfyReady, sendTestAlert } from '../alerts/ntfy.js';
import * as repo from '../db/repo.js';
import { DOMAIN_LABELS, DOMAINS, type DealStatus, type Domain } from '../types.js';
import { round } from '../util/money.js';
import { requireAuth } from './auth.js';

const log = createLogger('api');

/** Un seul cycle a la fois : deux collectes simultanees gaspillent le quota. */
let runInFlight: Promise<RunSummary> | null = null;

function asNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Convertit une ligne SQL en objet JSON stable pour le front. */
function serializeDeal(row: Record<string, unknown>): Record<string, unknown> {
  let trust: unknown = {};
  try {
    trust = JSON.parse((row['trust_json'] as string) ?? '{}');
  } catch {
    trust = {};
  }
  return {
    id: row['id'],
    listingId: row['listing_id'],
    status: row['status'],
    title: row['title'],
    url: row['url'],
    description: row['description'],
    source: row['source'],
    domain: row['domain'],
    domainLabel: DOMAIN_LABELS[row['domain'] as Domain] ?? row['domain'],
    condition: row['condition'],
    currency: row['currency'],
    imageUrl: row['image_url'],
    imagesCount: row['images_count'],
    location: row['location'],
    sellerName: row['seller_name'],
    sellerRating: row['seller_rating'],
    sellerFeedbackCount: row['seller_feedback_count'],
    firstSeenAt: row['first_seen_at'],
    buyPriceCents: row['price_cents'],
    buyShippingCents: row['shipping_cents'],
    buyTotalCents: row['buy_total_cents'],
    resaleEstimateCents: row['resale_estimate_cents'],
    resaleMaxCents: row['resale_max_cents'],
    resaleMarketplace: row['resale_marketplace'],
    feesTotalCents: row['fees_total_cents'],
    netProfitCents: row['net_profit_cents'],
    roiPct: row['roi_pct'],
    daysToReceive: row['days_to_receive'],
    daysToSell: row['days_to_sell'],
    totalDays: row['total_days'],
    roiPerDayCents: row['roi_per_day_cents'],
    trustScore: row['trust_score'],
    trust,
    compQuality: row['comp_quality'],
    categoryIndexDelta: row['category_index_delta'],
    alertedAt: row['alerted_at'],
    createdAt: row['created_at'],
    updatedAt: row['updated_at'],
  };
}

export function registerRoutes(app: FastifyInstance, db: BetterSqlite3.Database): void {
  /** Sonde de vie : volontairement hors authentification, pour les healthchecks. */
  app.get('/api/health', async () => ({ ok: true, version: '0.1.0', time: new Date().toISOString() }));

  app.register(async (api) => {
    api.addHook('onRequest', requireAuth);

    /* ── Etat general ──────────────────────────────────────── */

    api.get('/api/status', async () => {
      const runs = repo.listRuns(db, 1);
      return {
        market: config.market,
        demoMode: config.demoMode,
        schedule: {
          enabled: config.schedule.enabled,
          cron: config.schedule.cron,
          timezone: config.schedule.timezone,
        },
        alerts: {
          ready: isNtfyReady(),
          server: config.ntfy.server,
          topicConfigured: Boolean(config.ntfy.topic),
        },
        connectors: connectorStatus(),
        hunts: loadHunts().map((h) => ({
          id: h.id,
          source: h.source,
          domain: h.domain,
          query: h.query,
          enabled: h.enabled,
          note: h.note,
        })),
        fees: allFeeModels(),
        settings: repo.getSettings(db),
        lastRun: runs[0] ?? null,
        runInFlight: runInFlight !== null,
        domains: DOMAINS.map((d) => ({ id: d, label: DOMAIN_LABELS[d] })),
      };
    });

    /* ── Deals ─────────────────────────────────────────────── */

    api.get('/api/deals', async (request) => {
      const q = request.query as Record<string, string | undefined>;
      const settings = repo.getSettings(db);

      // Les seuils enregistres servent de filtre par defaut ; la query peut
      // les assouplir pour inspecter ce qui a ete ecarte.
      const rows = repo.listDeals(db, {
        status: (q['status'] as DealStatus | 'all') ?? 'new',
        domain: (q['domain'] as Domain | 'all') ?? 'all',
        source: q['source'] ?? 'all',
        minRoiPct: asNumber(q['minRoi']) ?? settings.minRoiPct,
        minTrust: asNumber(q['minTrust']) ?? settings.minTrustScore,
        minNetProfitCents: asNumber(q['minProfit']) ?? settings.minNetProfitCents,
        sort: (q['sort'] as 'roi_per_day') ?? 'roi_per_day',
        limit: asNumber(q['limit']) ?? 100,
        offset: asNumber(q['offset']) ?? 0,
      });

      return { deals: rows.map(serializeDeal), count: rows.length };
    });

    api.get('/api/deals/:id', async (request, reply) => {
      const id = Number((request.params as { id: string }).id);
      const row = repo.getDeal(db, id);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const deal = serializeDeal(row);
      return { deal, comps: repo.getComps(db, row['listing_id'] as string) };
    });

    /** Marque un deal comme achete. N'effectue evidemment aucun achat reel. */
    api.post('/api/deals/:id/buy', async (request, reply) => {
      const id = Number((request.params as { id: string }).id);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const row = repo.getDeal(db, id);
      if (!row) return reply.code(404).send({ error: 'not_found' });

      const paid = asNumber(body['pricePaidCents']) ?? (row['buy_total_cents'] as number);
      const note = typeof body['note'] === 'string' ? body['note'] : '';

      db.transaction(() => {
        repo.setDealStatus(db, id, 'bought', note);
        repo.recordPurchase(db, id, paid, note);
      })();

      return { ok: true, status: 'bought', pricePaidCents: paid };
    });

    api.post('/api/deals/:id/skip', async (request, reply) => {
      const id = Number((request.params as { id: string }).id);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const note = typeof body['note'] === 'string' ? body['note'] : '';
      if (!repo.setDealStatus(db, id, 'skipped', note)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return { ok: true, status: 'skipped' };
    });

    /** Saisie manuelle du prix de vente reel, une fois l'article ecoule. */
    api.post('/api/deals/:id/sold', async (request, reply) => {
      const id = Number((request.params as { id: string }).id);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const soldPriceCents = asNumber(body['soldPriceCents']);
      if (soldPriceCents === undefined || soldPriceCents < 0) {
        return reply.code(400).send({ error: 'bad_request', message: 'soldPriceCents est requis.' });
      }
      const feesCents = asNumber(body['feesCents']) ?? 0;
      const note = typeof body['note'] === 'string' ? body['note'] : '';

      const row = repo.getDeal(db, id);
      if (!row) return reply.code(404).send({ error: 'not_found' });

      // Une vente saisie sans achat enregistre : on cree la position
      // d'achat a la volee, au prix estime, pour que le suivi reste coherent.
      if (row['status'] !== 'bought' && row['status'] !== 'sold') {
        repo.recordPurchase(db, id, row['buy_total_cents'] as number, 'achat deduit de la vente');
      }

      db.transaction(() => {
        repo.recordSale(db, id, soldPriceCents, feesCents, note);
        repo.setDealStatus(db, id, 'sold', note);
      })();

      // La marge reelle vient d'entrer : l'indice de categorie doit en tenir compte.
      repo.recomputeCategoryStats(db);
      return { ok: true, status: 'sold' };
    });

    api.post('/api/deals/:id/reset', async (request, reply) => {
      const id = Number((request.params as { id: string }).id);
      if (!repo.setDealStatus(db, id, 'new', 'remis en liste')) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return { ok: true, status: 'new' };
    });

    /* ── Statistiques ──────────────────────────────────────── */

    api.get('/api/stats/categories', async () => ({
      categories: repo.getCategoryStats(db).map((row) => ({
        domain: row['domain'],
        label: DOMAIN_LABELS[row['domain'] as Domain] ?? row['domain'],
        sampleSize: row['sample_size'],
        avgMarginPct: row['avg_margin_pct'],
        medianMarginPct: row['median_margin_pct'],
        avgDaysToSell: row['avg_days_to_sell'],
        updatedAt: row['updated_at'],
      })),
    }));

    api.get('/api/stats/domains', async () => {
      const rows = db
        .prepare(
          `SELECT l.domain AS domain,
                  COUNT(*) AS deals,
                  AVG(d.roi_pct) AS avg_roi,
                  AVG(d.net_profit_cents) AS avg_profit,
                  AVG(d.roi_per_day_cents) AS avg_roi_per_day,
                  AVG(d.trust_score) AS avg_trust
           FROM deals d JOIN listings l ON l.id = d.listing_id
           GROUP BY l.domain
           ORDER BY avg_roi_per_day DESC`,
        )
        .all() as Array<Record<string, unknown>>;

      return {
        domains: rows.map((r) => ({
          domain: r['domain'],
          label: DOMAIN_LABELS[r['domain'] as Domain] ?? r['domain'],
          deals: r['deals'],
          avgRoiPct: round(Number(r['avg_roi'] ?? 0), 1),
          avgProfitCents: Math.round(Number(r['avg_profit'] ?? 0)),
          avgRoiPerDayCents: Math.round(Number(r['avg_roi_per_day'] ?? 0)),
          avgTrust: round(Number(r['avg_trust'] ?? 0), 1),
        })),
      };
    });

    /** Nuage risque/profit : confiance en abscisse, profit net en ordonnee. */
    api.get('/api/stats/risk', async () => {
      const rows = db
        .prepare(
          `SELECT d.id, d.trust_score, d.net_profit_cents, d.roi_pct, d.roi_per_day_cents,
                  d.status, l.domain, l.title, l.currency
           FROM deals d JOIN listings l ON l.id = d.listing_id
           ORDER BY d.created_at DESC LIMIT 400`,
        )
        .all() as Array<Record<string, unknown>>;

      return {
        points: rows.map((r) => ({
          id: r['id'],
          trustScore: r['trust_score'],
          netProfitCents: r['net_profit_cents'],
          roiPct: r['roi_pct'],
          roiPerDayCents: r['roi_per_day_cents'],
          status: r['status'],
          domain: r['domain'],
          label: DOMAIN_LABELS[r['domain'] as Domain] ?? r['domain'],
          title: r['title'],
          currency: r['currency'],
        })),
      };
    });

    api.get('/api/stats/capital', async () => ({
      summary: repo.capitalSummary(db),
      positions: repo.capitalPositions(db).map((r) => ({
        dealId: r['deal_id'],
        title: r['title'],
        url: r['url'],
        domain: r['domain'],
        source: r['source'],
        currency: r['currency'],
        boughtPriceCents: r['bought_price_cents'],
        boughtAt: r['bought_at'],
        soldPriceCents: r['sold_price_cents'],
        soldFeesCents: r['sold_fees_cents'],
        soldAt: r['sold_at'],
        estimatedProfitCents: r['estimated_profit_cents'],
        note: r['note'],
      })),
    }));

    api.get('/api/stats/decisions', async (request) => {
      const q = request.query as Record<string, string | undefined>;
      return {
        decisions: repo.listDecisions(db, asNumber(q['limit']) ?? 100).map((r) => ({
          id: r['id'],
          dealId: r['deal_id'],
          action: r['action'],
          note: r['note'],
          createdAt: r['created_at'],
          title: r['title'],
          domain: r['domain'],
          source: r['source'],
          netProfitCents: r['net_profit_cents'],
          roiPct: r['roi_pct'],
        })),
      };
    });

    api.get('/api/runs', async (request) => {
      const q = request.query as Record<string, string | undefined>;
      return { runs: repo.listRuns(db, asNumber(q['limit']) ?? 20) };
    });

    /* ── Reglages ──────────────────────────────────────────── */

    api.get('/api/settings', async () => repo.getSettings(db));

    api.put('/api/settings', async (request) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const patch: Record<string, number> = {};
      for (const key of [
        'minTrustScore',
        'minRoiPct',
        'minNetProfitCents',
        'alertMinTrustScore',
        'alertMinRoiPerDayCents',
        'alertMaxPerRun',
      ]) {
        const value = asNumber(body[key]);
        if (value !== undefined) patch[key] = value;
      }
      return repo.setSettings(db, patch);
    });

    /* ── Actions ───────────────────────────────────────────── */

    api.post('/api/run', async (_request, reply) => {
      if (runInFlight) {
        return reply.code(409).send({ error: 'already_running', message: 'Un cycle est deja en cours.' });
      }
      runInFlight = runCycle(db, 'manual');
      try {
        const summary = await runInFlight;
        return { ok: true, summary };
      } catch (err) {
        log.error('cycle manuel en echec', errInfo(err));
        return reply.code(500).send({ error: 'run_failed', message: String(err) });
      } finally {
        runInFlight = null;
      }
    });

    api.post('/api/alerts/test', async (_request, reply) => {
      if (!isNtfyReady()) {
        return reply
          .code(400)
          .send({ error: 'ntfy_not_configured', message: 'NTFY_TOPIC absent ou alertes desactivees.' });
      }
      const ok = await sendTestAlert();
      return { ok };
    });
  });
}

/** Expose l'etat du verrou de cycle au planificateur. */
export function isRunInFlight(): boolean {
  return runInFlight !== null;
}

export function setRunInFlight(promise: Promise<RunSummary> | null): void {
  runInFlight = promise;
}

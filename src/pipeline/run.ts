import type BetterSqlite3 from 'better-sqlite3';
import { config } from '../config.js';
import { createLogger, errInfo } from '../logger.js';
import { compSources, discoverySources, getConnector } from '../connectors/registry.js';
import type { Connector, ConnectorContext } from '../connectors/types.js';
import * as repo from '../db/repo.js';
import type { RawListing } from '../types.js';
import { CallBudget, RateLimiter } from '../util/ratelimit.js';
import { sendAlert, isNtfyReady } from '../alerts/ntfy.js';
import { gatherComps, marketMedianCents } from './comps.js';
import { evaluate } from './economics.js';
import { scoreTrust } from './trust.js';

const log = createLogger('pipeline');

export interface RunSummary {
  runId: number;
  status: 'ok' | 'partial' | 'failed';
  listingsFound: number;
  listingsEvaluated: number;
  dealsCreated: number;
  dealsUpdated: number;
  alertsSent: number;
  sources: Array<{ id: string; found: number; callsUsed: number }>;
  errors: string[];
  durationMs: number;
}

/** Quotas d'appels par connecteur, pour ne pas epuiser un quota quotidien en un cycle. */
function budgetFor(connectorId: string): CallBudget {
  const limits: Record<string, number> = {
    ebay: config.ebay.maxCallsPerRun,
    discogs: config.discogs.maxCallsPerRun,
    bricklink: config.bricklink.maxCallsPerRun,
    demo: 10_000,
  };
  return new CallBudget(connectorId, limits[connectorId] ?? 100);
}

/** Debits respectueux des limites publiees par chaque API. */
function limiterFor(connectorId: string): RateLimiter {
  const perMinute: Record<string, number> = {
    ebay: 120,
    discogs: 55, // la limite documentee est 60/min : on garde une marge.
    bricklink: 60,
    demo: 100_000,
  };
  return new RateLimiter(perMinute[connectorId] ?? 30);
}

/**
 * Un cycle complet : decouverte, comparaison, evaluation, scoring, alertes.
 *
 * Chaque etape est isolee : l'echec d'une source ou d'une annonce est
 * journalise et le cycle continue. Un cycle qui plante entierement est le
 * pire scenario pour un outil cense tourner sans surveillance.
 */
export async function runCycle(
  db: BetterSqlite3.Database,
  trigger: 'cron' | 'manual' | 'boot' = 'manual',
): Promise<RunSummary> {
  const startedAt = Date.now();
  const runId = repo.startRun(db, trigger);
  const errors: string[] = [];
  const sources: RunSummary['sources'] = [];

  const budgets = new Map<string, CallBudget>();
  const limiters = new Map<string, RateLimiter>();
  const contextFor = (connector: Connector): ConnectorContext => {
    if (!budgets.has(connector.id)) budgets.set(connector.id, budgetFor(connector.id));
    if (!limiters.has(connector.id)) limiters.set(connector.id, limiterFor(connector.id));
    return {
      log: log.child(connector.id),
      budget: budgets.get(connector.id)!,
      limiter: limiters.get(connector.id)!,
    };
  };

  /* ── 1. Decouverte ─────────────────────────────────────────── */

  const discovered: RawListing[] = [];
  const discoverers = discoverySources();

  if (discoverers.length === 0) {
    const msg =
      'Aucune source de decouverte active. Renseigne EBAY_CLIENT_ID / EBAY_CLIENT_SECRET, ' +
      'ou active DEMO_MODE=true pour explorer le dashboard avec des donnees fictives.';
    log.warn(msg);
    errors.push(msg);
  }

  for (const connector of discoverers) {
    try {
      const found = await connector.discover!(contextFor(connector));
      discovered.push(...found);
      sources.push({
        id: connector.id,
        found: found.length,
        callsUsed: budgets.get(connector.id)?.spent ?? 0,
      });
      log.info('decouverte terminee', { source: connector.id, found: found.length });
    } catch (err) {
      const msg = `Decouverte ${connector.id} en echec : ${err instanceof Error ? err.message : String(err)}`;
      log.error(msg, errInfo(err));
      errors.push(msg);
      sources.push({ id: connector.id, found: 0, callsUsed: budgets.get(connector.id)?.spent ?? 0 });
    }
  }

  /* ── 2. Persistance et pre-filtrage ────────────────────────── */

  const providers = compSources();
  const cutoffMs = config.pipeline.reevaluateAfterHours * 3_600_000;
  const toEvaluate: RawListing[] = [];

  for (const listing of discovered) {
    const id = repo.listingId(listing.source, listing.externalId);
    // Un deal deja achete ou ecarte ne doit jamais revenir : on economise
    // les appels de comparaison et on ne re-propose pas ce qui a ete refuse.
    if (repo.isDealDecided(db, id)) continue;
    const last = repo.lastEvaluatedAt(db, id);
    if (last !== null && Date.now() - last < cutoffMs) continue;

    repo.upsertListing(db, listing);
    toEvaluate.push(listing);
    if (toEvaluate.length >= config.pipeline.maxListingsPerRun) break;
  }

  log.info('annonces retenues pour evaluation', {
    decouvertes: discovered.length,
    a_evaluer: toEvaluate.length,
  });

  /* ── 3. Comparaisons et economie ───────────────────────────── */

  interface Candidate {
    listing: RawListing;
    listingKey: string;
    evaluation: NonNullable<ReturnType<typeof evaluate>>;
    marketMedian: number | null;
  }

  const candidates: Candidate[] = [];

  for (const listing of toEvaluate) {
    try {
      const comps = await gatherComps(listing, providers, contextFor, log);
      if (comps.length === 0) continue;

      const evaluation = evaluate(listing, comps);
      if (!evaluation) continue;

      const listingKey = repo.listingId(listing.source, listing.externalId);
      repo.replaceComps(db, listingKey, comps);
      candidates.push({
        listing,
        listingKey,
        evaluation,
        marketMedian: marketMedianCents(comps),
      });
    } catch (err) {
      log.debug('evaluation impossible', { id: listing.externalId, ...errInfo(err) });
    }
  }

  /* ── 4. Enrichissement des meilleurs candidats ─────────────── */

  // L'enrichissement coute un appel API par annonce : on ne le depense que
  // sur les candidats deja prometteurs, tries par ROI/jour.
  const ranked = [...candidates].sort(
    (a, b) => b.evaluation.best.roiPerDayCents - a.evaluation.best.roiPerDayCents,
  );
  const toEnrich = ranked.slice(0, config.pipeline.maxEnrichPerRun);

  for (const candidate of toEnrich) {
    const connector = getConnector(candidate.listing.source);
    if (!connector?.enrich) continue;
    try {
      const enriched = await connector.enrich(candidate.listing, contextFor(connector));
      candidate.listing = enriched;
      repo.upsertListing(db, enriched);
    } catch (err) {
      log.debug('enrichissement en echec', { id: candidate.listing.externalId, ...errInfo(err) });
    }
  }

  /* ── 5. Score de confiance et enregistrement ───────────────── */

  let dealsCreated = 0;
  let dealsUpdated = 0;

  for (const candidate of candidates) {
    try {
      const { listing, evaluation } = candidate;
      const trust = scoreTrust({
        listing,
        marketMedianCents: candidate.marketMedian,
        imageReuseCount: repo.imageReuseCount(db, listing.imageUrl, listing.sellerId),
        descriptionAvailable: listing.description.trim().length > 0,
      });

      // L'indice de categorie est fige sur les statistiques du cycle
      // precedent : il est recalcule en fin de cycle, une fois les nouveaux
      // deals connus.
      const categoryMedian = repo.getCategoryMedianMargin(db, listing.domain);
      const categoryIndexDelta =
        categoryMedian === null ? null : Math.round((evaluation.best.roiPct - categoryMedian) * 100) / 100;

      const result = repo.upsertDeal(db, {
        listingId: candidate.listingKey,
        economics: evaluation.best,
        trust,
        compQuality: evaluation.compQuality,
        categoryIndexDelta,
      });
      if (result.created) dealsCreated += 1;
      else dealsUpdated += 1;
    } catch (err) {
      log.error('enregistrement du deal impossible', {
        id: candidate.listing.externalId,
        ...errInfo(err),
      });
    }
  }

  /* ── 6. Indice de revente par categorie ────────────────────── */

  try {
    repo.recomputeCategoryStats(db);
  } catch (err) {
    log.error('recalcul de l indice par categorie en echec', errInfo(err));
    errors.push('Recalcul de l indice par categorie en echec.');
  }

  /* ── 7. Alertes montre ─────────────────────────────────────── */

  let alertsSent = 0;
  const settings = repo.getSettings(db);

  if (isNtfyReady()) {
    const toAlert = repo.dealsToAlert(db, settings, settings.alertMaxPerRun);
    for (const row of toAlert) {
      const ok = await sendAlert(
        {
          dealId: row['id'] as number,
          title: row['title'] as string,
          domain: row['domain'] as never,
          source: row['source'] as string,
          url: row['url'] as string,
          buyTotalCents: row['buy_total_cents'] as number,
          resaleEstimateCents: row['resale_estimate_cents'] as number,
          netProfitCents: row['net_profit_cents'] as number,
          roiPct: row['roi_pct'] as number,
          roiPerDayCents: row['roi_per_day_cents'] as number,
          totalDays: row['total_days'] as number,
          trustScore: row['trust_score'] as number,
          currency: (row['currency'] as string) ?? config.market.currency,
        },
        config.publicUrl,
      );
      // On marque le deal meme en cas d'echec : sinon un ntfy indisponible
      // provoquerait une rafale de notifications au cycle suivant.
      repo.markAlerted(db, row['id'] as number);
      if (ok) alertsSent += 1;
    }
  }

  /* ── 8. Entretien ──────────────────────────────────────────── */

  try {
    const pruned = repo.pruneOldListings(db, config.pipeline.pruneAfterDays);
    if (pruned > 0) log.info('annonces anciennes purgees', { pruned });
  } catch (err) {
    log.warn('purge impossible', errInfo(err));
  }

  const status: RunSummary['status'] =
    errors.length === 0 ? 'ok' : candidates.length > 0 ? 'partial' : 'failed';

  repo.finishRun(db, runId, {
    status,
    listingsFound: discovered.length,
    dealsCreated,
    alertsSent,
    sources,
    errors,
  });

  const summary: RunSummary = {
    runId,
    status,
    listingsFound: discovered.length,
    listingsEvaluated: candidates.length,
    dealsCreated,
    dealsUpdated,
    alertsSent,
    sources,
    errors,
    durationMs: Date.now() - startedAt,
  };

  log.info('cycle termine', { ...summary, sources: undefined });
  return summary;
}

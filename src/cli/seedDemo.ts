/**
 * Remplit la base avec des donnees fictives.
 * Permet de voir le dashboard vivant avant d'avoir la moindre cle API.
 */
import { createLogger, errInfo } from '../logger.js';
import { closeDb, getDb } from '../db/index.js';
import { demoConnector } from '../connectors/demo.js';
import * as repo from '../db/repo.js';
import { gatherComps, marketMedianCents } from '../pipeline/comps.js';
import { evaluate } from '../pipeline/economics.js';
import { scoreTrust } from '../pipeline/trust.js';
import { CallBudget, RateLimiter } from '../util/ratelimit.js';

const log = createLogger('cli:seed');

async function main(): Promise<void> {
  const db = getDb();
  const ctx = {
    log: log.child('demo'),
    budget: new CallBudget('demo', 10_000),
    limiter: new RateLimiter(100_000),
  };

  const listings = await demoConnector.discover!(ctx);
  let created = 0;

  for (const listing of listings) {
    const key = repo.upsertListing(db, listing);
    const comps = await gatherComps(listing, [demoConnector], () => ctx, log);
    if (comps.length === 0) continue;
    repo.replaceComps(db, key, comps);

    const evaluation = evaluate(listing, comps);
    if (!evaluation) continue;

    const trust = scoreTrust({
      listing,
      marketMedianCents: marketMedianCents(comps),
      imageReuseCount: repo.imageReuseCount(db, listing.imageUrl, listing.sellerId),
      descriptionAvailable: listing.description.trim().length > 0,
    });

    const result = repo.upsertDeal(db, {
      listingId: key,
      economics: evaluation.best,
      trust,
      compQuality: evaluation.compQuality,
      categoryIndexDelta: null,
    });
    if (result.created) created += 1;
  }

  repo.recomputeCategoryStats(db);
  log.info('donnees de demonstration inserees', { listings: listings.length, deals: created });
  closeDb();
}

main().catch((err) => {
  log.error('insertion impossible', errInfo(err));
  closeDb();
  process.exit(1);
});

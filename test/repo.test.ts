import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type BetterSqlite3 from 'better-sqlite3';
import { createMemoryDb } from '../src/db/index.js';
import * as repo from '../src/db/repo.js';
import type { Economics, RawListing, TrustResult } from '../src/types.js';

function listing(overrides: Partial<RawListing> = {}): RawListing {
  return {
    source: 'ebay',
    externalId: 'a1',
    url: 'https://example.invalid/a1',
    title: 'Objet de test',
    description: 'description',
    priceCents: 5_000,
    shippingCents: 500,
    currency: 'EUR',
    condition: 'good',
    sourceCategory: 'cat',
    domain: 'electronics',
    sellerId: 'seller-1',
    sellerName: 'seller',
    sellerRating: 98,
    sellerFeedbackCount: 100,
    sellerSince: null,
    imageUrl: 'https://img.invalid/a.jpg',
    imagesCount: 3,
    location: 'FR',
    shippingDays: 4,
    raw: {},
    ...overrides,
  };
}

function economics(overrides: Partial<Economics> = {}): Economics {
  return {
    buyPriceCents: 5_000,
    buyShippingCents: 500,
    buyTotalCents: 5_500,
    resaleEstimateCents: 10_000,
    resaleMaxCents: 12_000,
    resaleMarketplace: 'ebay:EBAY_FR',
    sellCommissionCents: 1_280,
    sellShippingCents: 690,
    packagingCents: 150,
    feesTotalCents: 2_120,
    netProfitCents: 2_380,
    roiPct: 43.27,
    daysToReceive: 4,
    daysToSell: 20,
    totalDays: 26,
    roiPerDayCents: 92,
    ...overrides,
  };
}

const trust: TrustResult = { score: 82, components: [], flags: [] };

let db: BetterSqlite3.Database;

beforeEach(() => {
  db = createMemoryDb();
});

describe('upsertListing', () => {
  it('conserve la premiere date de decouverte lors d une mise a jour', () => {
    const id = repo.upsertListing(db, listing());
    const first = db.prepare('SELECT first_seen_at FROM listings WHERE id = ?').get(id) as { first_seen_at: string };

    repo.upsertListing(db, listing({ priceCents: 4_000 }));
    const after = db
      .prepare('SELECT first_seen_at, price_cents FROM listings WHERE id = ?')
      .get(id) as { first_seen_at: string; price_cents: number };

    assert.equal(after.first_seen_at, first.first_seen_at);
    assert.equal(after.price_cents, 4_000, 'le prix doit etre rafraichi');
  });
});

describe('upsertDeal', () => {
  it('cree puis met a jour sans dupliquer', () => {
    const id = repo.upsertListing(db, listing());
    const created = repo.upsertDeal(db, { listingId: id, economics: economics(), trust, compQuality: 0.6, categoryIndexDelta: null });
    assert.equal(created.created, true);

    const updated = repo.upsertDeal(db, {
      listingId: id,
      economics: economics({ netProfitCents: 3_000 }),
      trust,
      compQuality: 0.6,
      categoryIndexDelta: null,
    });
    assert.equal(updated.created, false);
    assert.equal(updated.id, created.id);

    const count = db.prepare('SELECT COUNT(*) AS n FROM deals').get() as { n: number };
    assert.equal(count.n, 1);
  });

  it('ne ressuscite pas un deal ecarte', () => {
    const id = repo.upsertListing(db, listing());
    const { id: dealId } = repo.upsertDeal(db, { listingId: id, economics: economics(), trust, compQuality: 0.6, categoryIndexDelta: null });
    repo.setDealStatus(db, dealId, 'skipped', 'pas interesse');

    repo.upsertDeal(db, { listingId: id, economics: economics(), trust, compQuality: 0.6, categoryIndexDelta: null });
    const row = db.prepare('SELECT status FROM deals WHERE id = ?').get(dealId) as { status: string };
    assert.equal(row.status, 'skipped');
    assert.equal(repo.isDealDecided(db, id), true);
  });
});

describe('listDeals', () => {
  it('filtre par seuils et trie par ROI/jour', () => {
    const a = repo.upsertListing(db, listing({ externalId: 'a' }));
    const b = repo.upsertListing(db, listing({ externalId: 'b' }));
    repo.upsertDeal(db, { listingId: a, economics: economics({ roiPerDayCents: 50 }), trust, compQuality: 0.6, categoryIndexDelta: null });
    repo.upsertDeal(db, { listingId: b, economics: economics({ roiPerDayCents: 500 }), trust, compQuality: 0.6, categoryIndexDelta: null });

    const rows = repo.listDeals(db, { sort: 'roi_per_day' });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!['roi_per_day_cents'], 500);

    const filtered = repo.listDeals(db, { minTrust: 90 });
    assert.equal(filtered.length, 0, 'le seuil de confiance doit ecarter les deux deals');
  });
});

describe('suivi du capital', () => {
  it('calcule investi, recupere et profit realise', () => {
    const id = repo.upsertListing(db, listing());
    const { id: dealId } = repo.upsertDeal(db, { listingId: id, economics: economics(), trust, compQuality: 0.6, categoryIndexDelta: null });

    repo.recordPurchase(db, dealId, 5_500);
    let summary = repo.capitalSummary(db);
    assert.equal(summary.investedCents, 5_500);
    assert.equal(summary.openPositions, 1);
    assert.equal(summary.realisedProfitCents, 0);

    repo.recordSale(db, dealId, 10_000, 1_500);
    summary = repo.capitalSummary(db);
    assert.equal(summary.closedPositions, 1);
    assert.equal(summary.openPositions, 0);
    assert.equal(summary.recoveredCents, 8_500);
    assert.equal(summary.realisedProfitCents, 3_000);
    assert.equal(summary.winRate, 100);
  });

  it('compte une vente a perte comme un echec', () => {
    const id = repo.upsertListing(db, listing());
    const { id: dealId } = repo.upsertDeal(db, { listingId: id, economics: economics(), trust, compQuality: 0.6, categoryIndexDelta: null });
    repo.recordPurchase(db, dealId, 10_000);
    repo.recordSale(db, dealId, 8_000, 500);

    const summary = repo.capitalSummary(db);
    assert.equal(summary.realisedProfitCents, -2_500);
    assert.equal(summary.winRate, 0);
  });
});

describe('indice de revente par categorie', () => {
  it('reste indisponible sous cinq observations', () => {
    for (let i = 0; i < 3; i += 1) {
      const id = repo.upsertListing(db, listing({ externalId: `x${i}` }));
      repo.upsertDeal(db, { listingId: id, economics: economics(), trust, compQuality: 0.8, categoryIndexDelta: null });
    }
    repo.recomputeCategoryStats(db);
    assert.equal(repo.getCategoryMedianMargin(db, 'electronics'), null);
  });

  it('devient exploitable a partir de cinq observations', () => {
    for (let i = 0; i < 6; i += 1) {
      const id = repo.upsertListing(db, listing({ externalId: `y${i}` }));
      repo.upsertDeal(db, {
        listingId: id,
        economics: economics({ roiPct: 40 }),
        trust,
        compQuality: 0.8,
        categoryIndexDelta: null,
      });
    }
    repo.recomputeCategoryStats(db);
    const value = repo.getCategoryMedianMargin(db, 'electronics');
    assert.ok(value !== null);
    assert.ok(Math.abs(value - 40) < 0.5, `mediane attendue ~40, obtenue ${value}`);
  });

  it('ignore les deals a comparaison trop faible', () => {
    for (let i = 0; i < 6; i += 1) {
      const id = repo.upsertListing(db, listing({ externalId: `z${i}` }));
      repo.upsertDeal(db, { listingId: id, economics: economics(), trust, compQuality: 0.1, categoryIndexDelta: null });
    }
    repo.recomputeCategoryStats(db);
    assert.equal(repo.getCategoryMedianMargin(db, 'electronics'), null);
  });
});

describe('imageReuseCount', () => {
  it('compte les autres vendeurs partageant la meme image', () => {
    repo.upsertListing(db, listing({ externalId: 'a', sellerId: 'seller-1' }));
    repo.upsertListing(db, listing({ externalId: 'b', sellerId: 'seller-2' }));
    repo.upsertListing(db, listing({ externalId: 'c', sellerId: 'seller-3' }));

    assert.equal(repo.imageReuseCount(db, 'https://img.invalid/a.jpg', 'seller-1'), 2);
    assert.equal(repo.imageReuseCount(db, null, 'seller-1'), 0);
  });
});

describe('pruneOldListings', () => {
  it('conserve les annonces achetees et supprime les anciennes non tranchees', () => {
    const kept = repo.upsertListing(db, listing({ externalId: 'kept' }));
    const dropped = repo.upsertListing(db, listing({ externalId: 'dropped' }));
    const { id: dealId } = repo.upsertDeal(db, { listingId: kept, economics: economics(), trust, compQuality: 0.6, categoryIndexDelta: null });
    repo.setDealStatus(db, dealId, 'bought');

    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    db.prepare('UPDATE listings SET last_seen_at = ?').run(old);

    const removed = repo.pruneOldListings(db, 30);
    assert.equal(removed, 1);
    assert.ok(db.prepare('SELECT 1 FROM listings WHERE id = ?').get(kept));
    assert.equal(db.prepare('SELECT 1 FROM listings WHERE id = ?').get(dropped), undefined);
  });
});

describe('settings', () => {
  it('persiste les seuils modifies et ignore les valeurs invalides', () => {
    const updated = repo.setSettings(db, { minTrustScore: 85, minRoiPct: Number.NaN });
    assert.equal(updated.minTrustScore, 85);
    assert.equal(repo.getSettings(db).minTrustScore, 85);
    assert.ok(Number.isFinite(updated.minRoiPct));
  });
});

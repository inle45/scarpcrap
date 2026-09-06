// Les tests doivent etre hermetiques : on force des chemins de configuration
// inexistants pour que le bareme de frais soit celui compile dans le code,
// et non un fichier local que l'utilisateur aurait modifie.
process.env['FEES_FILE'] = '/nonexistent/fees.json';
process.env['HUNTS_FILE'] = '/nonexistent/hunts.json';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTIVE_COMP_DISCOUNT,
  evaluate,
  evaluateAgainstComp,
  expectedResaleCents,
  sellingFeesCents,
} from '../src/pipeline/economics.js';
import { feeModelFor } from '../src/pipeline/fees.js';
import type { CompResult, RawListing } from '../src/types.js';

function listing(overrides: Partial<RawListing> = {}): RawListing {
  return {
    source: 'ebay',
    externalId: 'x1',
    url: 'https://example.invalid/x1',
    title: 'Casque Sony WH-1000XM4',
    description: 'Tres bon etat, boite et cable inclus.',
    priceCents: 10_000,
    shippingCents: 500,
    currency: 'EUR',
    condition: 'good',
    sourceCategory: 'audio',
    domain: 'electronics',
    sellerId: 's1',
    sellerName: 'vendeur',
    sellerRating: 99,
    sellerFeedbackCount: 500,
    sellerSince: new Date(Date.now() - 3 * 365 * 86_400_000).toISOString(),
    imageUrl: null,
    imagesCount: 5,
    location: 'FR',
    shippingDays: 4,
    raw: {},
    ...overrides,
  };
}

function comp(overrides: Partial<CompResult> = {}): CompResult {
  return {
    source: 'ebay:EBAY_FR',
    kind: 'active',
    sampleSize: 12,
    priceMinCents: 15_000,
    priceMedianCents: 20_000,
    priceMaxCents: 26_000,
    currency: 'EUR',
    quality: 0.5,
    daysToSell: 20,
    note: '',
    ...overrides,
  };
}

describe('expectedResaleCents', () => {
  it('decote les comparaisons de type "active"', () => {
    const value = expectedResaleCents(comp({ kind: 'active', priceMedianCents: 10_000 }));
    assert.equal(value, Math.round(10_000 * ACTIVE_COMP_DISCOUNT));
  });

  it('laisse intactes les comparaisons issues de ventes reelles', () => {
    const value = expectedResaleCents(comp({ kind: 'sold', priceMedianCents: 10_000 }));
    assert.equal(value, 10_000);
  });
});

describe('sellingFeesCents', () => {
  it('applique la commission au port encaisse quand le bareme le prevoit', () => {
    const fee = { ...feeModelFor('ebay'), commissionPct: 10, commissionIncludesShipping: true, fixedCents: 0, paymentPct: 0, paymentFixedCents: 0, shipOutCents: 1000, packagingCents: 0 };
    const fees = sellingFeesCents(fee, 10_000);
    // 10 % de (10 000 + 1 000) = 1 100
    assert.equal(fees.commission, 1100);
    assert.equal(fees.total, 1100 + 1000);
  });

  it('exclut le port de l assiette quand le bareme l exclut', () => {
    const fee = { ...feeModelFor('bricklink'), commissionPct: 10, commissionIncludesShipping: false, fixedCents: 0, paymentPct: 0, paymentFixedCents: 0, shipOutCents: 1000, packagingCents: 0 };
    const fees = sellingFeesCents(fee, 10_000);
    assert.equal(fees.commission, 1000);
  });
});

describe('evaluateAgainstComp', () => {
  it('calcule un profit net coherent avec ses composants', () => {
    const result = evaluateAgainstComp(listing(), comp({ kind: 'sold', priceMedianCents: 20_000 }));
    assert.equal(result.buyTotalCents, 10_500);
    assert.equal(result.resaleEstimateCents, 20_000);
    assert.equal(
      result.netProfitCents,
      result.resaleEstimateCents - result.buyTotalCents - result.feesTotalCents,
    );
  });

  it('exprime le ROI par jour en centimes sur la duree totale', () => {
    const result = evaluateAgainstComp(
      listing({ shippingDays: 3 }),
      comp({ kind: 'sold', daysToSell: 25 }),
    );
    // 3 jours de reception + 2 jours de mise en vente + 25 jours de revente
    assert.equal(result.totalDays, 30);
    assert.equal(result.roiPerDayCents, Math.round(result.netProfitCents / 30));
  });

  it('ne divise jamais par zero, meme sur des delais absents', () => {
    const result = evaluateAgainstComp(
      listing({ shippingDays: 0 }),
      comp({ kind: 'sold', daysToSell: 0 }),
    );
    assert.ok(Number.isFinite(result.roiPerDayCents));
    assert.ok(result.totalDays >= 1);
  });

  it('produit un ROI negatif quand les frais depassent la marge', () => {
    const result = evaluateAgainstComp(
      listing({ priceCents: 19_000 }),
      comp({ kind: 'sold', priceMedianCents: 20_000 }),
    );
    assert.ok(result.netProfitCents < 0, 'le profit doit etre negatif');
    assert.ok(result.roiPct < 0);
  });
});

describe('evaluate', () => {
  it('retourne null sans comparaison', () => {
    assert.equal(evaluate(listing(), []), null);
  });

  it('choisit la marketplace au meilleur profit net, pas au meilleur prix affiche', () => {
    // BrickLink affiche moins cher mais ne preleve que 3 % : c'est lui qui gagne.
    const expensive = comp({
      source: 'ebay:EBAY_FR',
      kind: 'sold',
      priceMedianCents: 21_000,
      quality: 0.9,
    });
    const cheaper = comp({ source: 'bricklink', kind: 'sold', priceMedianCents: 20_500, quality: 0.9 });

    const result = evaluate(listing(), [expensive, cheaper]);
    assert.ok(result);
    assert.equal(result.best.resaleMarketplace, 'bricklink');
    assert.ok(result.best.netProfitCents >= result.options[1]!.netProfitCents);
  });

  it('departage deux options a profit egal par la qualite de la comparaison', () => {
    const low = comp({ source: 'ebay:EBAY_FR', kind: 'sold', priceMedianCents: 20_000, quality: 0.3 });
    const high = comp({ source: 'ebay:EBAY_DE', kind: 'sold', priceMedianCents: 20_000, quality: 0.9 });
    const result = evaluate(listing(), [low, high]);
    assert.ok(result);
    assert.equal(result.compQuality, 0.9);
  });
});

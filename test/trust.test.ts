import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scoreTrust, type TrustInput } from '../src/pipeline/trust.js';
import type { RawListing } from '../src/types.js';

function listing(overrides: Partial<RawListing> = {}): RawListing {
  return {
    source: 'ebay',
    externalId: 'x1',
    url: 'https://example.invalid/x1',
    title: 'Console retro complete en boite',
    description:
      'Console testee et fonctionnelle, boite d origine avec cales, notice complete, ' +
      'manettes nettoyees. Facture disponible sur demande. Envoi soigne en colis suivi.',
    priceCents: 8_000,
    shippingCents: 500,
    currency: 'EUR',
    condition: 'good',
    sourceCategory: 'jeux',
    domain: 'videogames',
    sellerId: 's1',
    sellerName: 'vendeur',
    sellerRating: 99.5,
    sellerFeedbackCount: 1200,
    sellerSince: new Date(Date.now() - 4 * 365 * 86_400_000).toISOString(),
    imageUrl: 'https://img.invalid/a.jpg',
    imagesCount: 8,
    location: 'FR',
    shippingDays: 4,
    raw: {},
    ...overrides,
  };
}

function input(overrides: Partial<TrustInput> = {}): TrustInput {
  return {
    listing: listing(),
    marketMedianCents: 12_000,
    imageReuseCount: 0,
    descriptionAvailable: true,
    ...overrides,
  };
}

describe('scoreTrust', () => {
  it('note haut une annonce complete d un vendeur etabli', () => {
    const result = scoreTrust(input());
    assert.ok(result.score >= 85, `score attendu >= 85, obtenu ${result.score}`);
    assert.equal(result.flags.length, 0);
  });

  it('reste borne entre 0 et 100', () => {
    const worst = scoreTrust(
      input({
        listing: listing({
          sellerRating: 40,
          sellerFeedbackCount: 0,
          sellerSince: new Date().toISOString(),
          imagesCount: 0,
          description: 'urgent vente cause demenagement, contactez moi sur WhatsApp, paiement par virement direct',
        }),
        marketMedianCents: 100_000,
        imageReuseCount: 5,
      }),
    );
    assert.ok(worst.score >= 0 && worst.score <= 100);
    assert.ok(worst.score < 35, `score attendu < 35, obtenu ${worst.score}`);
  });

  it('sanctionne un prix derisoire par rapport au marche', () => {
    const bait = scoreTrust(input({ listing: listing({ priceCents: 1_000 }), marketMedianCents: 100_000 }));
    const component = bait.components.find((c) => c.key === 'price_coherence');
    assert.ok(component);
    assert.ok(component.score <= 8, 'un prix a 1 % du marche doit effondrer la coherence de prix');
    assert.ok(bait.flags.includes('prix anormalement bas'));
  });

  it('ne penalise pas une bonne affaire credible', () => {
    const good = scoreTrust(input({ listing: listing({ priceCents: 7_000 }), marketMedianCents: 12_000 }));
    const component = good.components.find((c) => c.key === 'price_coherence');
    assert.ok(component);
    assert.equal(component.score, 25);
  });

  it('detecte les tentatives de sortie de plateforme', () => {
    const risky = scoreTrust(
      input({
        listing: listing({
          description: 'Contactez moi directement sur Telegram, paiement par virement bancaire uniquement.',
        }),
      }),
    );
    const component = risky.components.find((c) => c.key === 'red_flags');
    assert.ok(component);
    assert.ok(component.score < 10);
    assert.ok(risky.flags.length > 0);
  });

  it('attribue un score neutre — jamais un bonus — quand l information manque', () => {
    const unknown = scoreTrust(
      input({
        listing: listing({ sellerRating: null, sellerFeedbackCount: null, sellerSince: null }),
        marketMedianCents: null,
        descriptionAvailable: false,
      }),
    );
    const byKey = new Map(unknown.components.map((c) => [c.key, c]));
    assert.equal(byKey.get('reputation')!.score, 12);
    assert.equal(byKey.get('account_age')!.score, 5);
    assert.equal(byKey.get('price_coherence')!.score, 12);
    assert.equal(byKey.get('description')!.score, 7);
    // Une annonce sur laquelle on ne sait rien ne doit pas franchir le seuil par defaut de 70.
    assert.ok(unknown.score < 70, `score attendu < 70, obtenu ${unknown.score}`);
  });

  it('penalise une photo deja vue chez d autres vendeurs', () => {
    const clean = scoreTrust(input());
    const reused = scoreTrust(input({ imageReuseCount: 3 }));
    assert.ok(reused.score < clean.score);
    assert.ok(reused.flags.includes('photo reutilisee'));
  });

  it('penalise une annonce d un compte tout neuf', () => {
    const fresh = scoreTrust(
      input({ listing: listing({ sellerSince: new Date(Date.now() - 5 * 86_400_000).toISOString() }) }),
    );
    const component = fresh.components.find((c) => c.key === 'account_age');
    assert.ok(component);
    assert.equal(component.score, 0);
  });
});

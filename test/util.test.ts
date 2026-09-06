import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dropOutliers, median, percentile, pctOf, formatCents } from '../src/util/money.js';
import { normalize, searchQueryFromTitle, similarity, scamSignals, truncate } from '../src/util/text.js';
import { CallBudget, RateLimiter } from '../src/util/ratelimit.js';
import { extractSetNumber } from '../src/connectors/bricklink.js';

describe('money', () => {
  it('calcule une mediane sur un nombre pair de valeurs', () => {
    assert.equal(median([100, 200, 300, 400]), 250);
  });

  it('renvoie 0 sur une serie vide plutot que NaN', () => {
    assert.equal(median([]), 0);
    assert.equal(percentile([], 0.5), 0);
  });

  it('retire les valeurs aberrantes par ecart interquartile', () => {
    const values = [1000, 1050, 1100, 1150, 1200, 50, 99_000];
    const kept = dropOutliers(values);
    assert.ok(!kept.includes(50), 'la valeur basse aberrante doit disparaitre');
    assert.ok(!kept.includes(99_000), 'la valeur haute aberrante doit disparaitre');
    assert.ok(kept.includes(1100));
  });

  it('laisse les series trop courtes intactes', () => {
    assert.deepEqual(dropOutliers([10, 5000]), [10, 5000]);
  });

  it('ne renvoie jamais une serie vide', () => {
    assert.ok(dropOutliers([1, 1, 1, 1, 999_999]).length > 0);
  });

  it('applique un pourcentage en centimes entiers', () => {
    assert.equal(pctOf(10_000, 12.8), 1280);
    assert.equal(pctOf(333, 9), 30);
  });

  it('formate en euros francais', () => {
    assert.match(formatCents(123_456, 'EUR'), /1\s?234/);
  });
});

describe('text', () => {
  it('normalise accents, casse et ponctuation', () => {
    assert.equal(normalize('Télé-viseur, 4K !'), 'tele viseur 4k');
  });

  it('remonte les references produit en tete de requete', () => {
    const query = searchQueryFromTitle('Superbe casque en tres bon etat Sony WH-1000XM4 envoi rapide');
    const first = query.split(' ')[0] ?? '';
    // Le token le plus discriminant est la reference produit, pas un adjectif.
    assert.match(first, /\d/, `requete inattendue : ${query}`);
    assert.ok(query.includes('sony'), `la marque doit survivre : ${query}`);
    for (const noise of ['envoi', 'rapide', 'etat', 'superbe', 'tres']) {
      assert.ok(!query.split(' ').includes(noise), `« ${noise} » aurait du etre filtre : ${query}`);
    }
  });

  it('mesure une similarite exploitable entre titres', () => {
    const high = similarity('Casque Sony WH-1000XM4 noir', 'Sony WH-1000XM4 casque bluetooth noir');
    const low = similarity('Casque Sony WH-1000XM4', 'Coque de protection pour casque');
    assert.ok(high > low);
    assert.ok(high > 0.4, `similarite trop faible : ${high}`);
  });

  it('detecte les signaux de sortie de plateforme', () => {
    const signals = scamSignals('Paiement par Western Union, contactez moi sur WhatsApp');
    assert.ok(signals.length >= 2);
    assert.ok(signals.every((s) => s.weight > 0));
  });

  it('ne signale rien sur une annonce ordinaire', () => {
    assert.equal(scamSignals('Vends console en bon etat, envoi via Mondial Relay.').length, 0);
  });

  it('tronque avec une ellipse', () => {
    assert.equal(truncate('abcdefghij', 5).length, 5);
    assert.equal(truncate('abc', 10), 'abc');
  });
});

describe('CallBudget', () => {
  it('leve une fois le plafond atteint', () => {
    const budget = new CallBudget('test', 2);
    budget.take();
    budget.take();
    assert.throws(() => budget.take(), /Budget d'appels epuise/);
  });

  it('propose une variante non levee', () => {
    const budget = new CallBudget('test', 1);
    assert.equal(budget.tryTake(), true);
    assert.equal(budget.tryTake(), false);
    assert.equal(budget.remaining, 0);
  });
});

describe('RateLimiter', () => {
  it('espace effectivement deux acquisitions', async () => {
    const limiter = new RateLimiter(600); // 100 ms entre deux appels
    const started = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    assert.ok(Date.now() - started >= 90, 'la seconde acquisition doit avoir attendu');
  });
});

describe('extractSetNumber', () => {
  it('reconnait une reference explicite avec variante', () => {
    assert.equal(extractSetNumber('LEGO Star Wars 75192-1 complet'), '75192-1');
  });

  it('complete la variante par defaut', () => {
    assert.equal(extractSetNumber('Lego Technic 42115 neuf'), '42115-1');
  });

  it('ignore une annee de sortie', () => {
    assert.equal(extractSetNumber('Lego vintage de 1998 set 6090 complet'), '6090-1');
  });

  it('renvoie null sans reference identifiable', () => {
    assert.equal(extractSetNumber('Gros lot de LEGO au kilo'), null);
  });
});

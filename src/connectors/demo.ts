import type { CompResult, Condition, Domain, RawListing } from '../types.js';
import type { Connector, ConnectorContext } from './types.js';

/**
 * Connecteur de demonstration.
 *
 * Genere des annonces fictives pour que le dashboard soit utilisable avant
 * d'avoir la moindre cle API. Aucune requete reseau. A n'activer qu'avec
 * `DEMO_MODE=true` : les donnees ne valent evidemment rien.
 */

interface Template {
  title: string;
  domain: Domain;
  buyEuros: number;
  resaleEuros: number;
  condition: Condition;
  rating: number;
  feedback: number;
  images: number;
  description: string;
  daysToSell: number;
}

const TEMPLATES: ReadonlyArray<Template> = [
  {
    title: 'Lot 25 vinyles 33 tours rock annees 70 bon etat',
    domain: 'music',
    buyEuros: 45,
    resaleEuros: 138,
    condition: 'good',
    rating: 99.2,
    feedback: 1840,
    images: 8,
    description:
      'Lot de 25 albums vinyle des annees 70, pochettes correctes, disques nettoyes. ' +
      'Liste detaillee des titres disponible sur demande. Envoi en carton renforce.',
    daysToSell: 24,
  },
  {
    title: 'LEGO Star Wars 75192 Millennium Falcon complet avec notice',
    domain: 'lego',
    buyEuros: 480,
    resaleEuros: 690,
    condition: 'good',
    rating: 100,
    feedback: 412,
    images: 12,
    description:
      'Set complet verifie piece par piece, notice incluse, boite non conservee. ' +
      'Monte une fois puis expose en vitrine. Demontage soigne, sachets refaits.',
    daysToSell: 30,
  },
  {
    title: 'Casque Sony WH-1000XM4 noir avec etui',
    domain: 'electronics',
    buyEuros: 118,
    resaleEuros: 175,
    condition: 'like_new',
    rating: 98.4,
    feedback: 96,
    images: 5,
    description:
      'Casque tres peu servi, mousses impeccables, etui rigide et cable jack fournis. ' +
      'Facture d achat de mars disponible.',
    daysToSell: 12,
  },
  {
    title: 'Objectif Canon EF 50mm f/1.8 STM monture EF',
    domain: 'electronics',
    buyEuros: 62,
    resaleEuros: 95,
    condition: 'good',
    rating: 99.8,
    feedback: 5210,
    images: 6,
    description:
      'Optique testee sur boitier, autofocus silencieux fonctionnel, lentilles sans rayure ' +
      'ni champignon. Bouchons avant et arriere inclus.',
    daysToSell: 18,
  },
  {
    title: 'Montre automatique Seiko 5 vintage annees 80 revisee',
    domain: 'watches',
    buyEuros: 95,
    resaleEuros: 210,
    condition: 'good',
    rating: 87.5,
    feedback: 23,
    images: 2,
    description: 'Montre urgente cause demenagement, envoi rapide, contactez moi sur WhatsApp.',
    daysToSell: 45,
  },
  {
    title: 'Jeu Super Nintendo complet en boite avec notice',
    domain: 'videogames',
    buyEuros: 38,
    resaleEuros: 72,
    condition: 'good',
    rating: 97.1,
    feedback: 640,
    images: 7,
    description:
      'Cartouche testee et fonctionnelle, boite avec legeres marques d usage, notice complete ' +
      'et cale interieure presente.',
    daysToSell: 21,
  },
];

function makeListing(t: Template, index: number, runSalt: number): RawListing {
  const externalId = `demo-${index}-${runSalt}`;
  const priceCents = Math.round(t.buyEuros * 100);
  return {
    source: 'demo',
    externalId,
    url: `https://example.invalid/annonce/${externalId}`,
    title: t.title,
    description: t.description,
    priceCents,
    shippingCents: 690,
    currency: 'EUR',
    condition: t.condition,
    sourceCategory: t.domain,
    domain: t.domain,
    sellerId: `demo-seller-${index}`,
    sellerName: `vendeur_demo_${index}`,
    sellerRating: t.rating,
    sellerFeedbackCount: t.feedback,
    sellerSince: new Date(Date.now() - (t.feedback * 3 + 30) * 86_400_000).toISOString(),
    imageUrl: null,
    imagesCount: t.images,
    location: 'FR',
    shippingDays: 4,
    raw: { demo: true, template: t },
  };
}

export const demoConnector: Connector = {
  id: 'demo',
  label: 'Demo (donnees fictives)',
  domains: ['*'],
  compliance: {
    level: 'official-api',
    summary: 'Donnees fabriquees localement, aucune requete reseau. Ne jamais utiliser pour decider d un achat.',
    reference: '',
  },

  isConfigured(): boolean {
    return true;
  },

  missingConfig(): string {
    return '';
  },

  async discover(ctx: ConnectorContext): Promise<RawListing[]> {
    // Un sel horaire pour que chaque cycle produise de nouveaux deals plutot
    // que de reevaluer eternellement les six memes annonces.
    const runSalt = Math.floor(Date.now() / 3_600_000);
    ctx.log.info('mode demo : generation d annonces fictives', { count: TEMPLATES.length });
    return TEMPLATES.map((t, i) => makeListing(t, i, runSalt));
  },

  async comps(listing: RawListing): Promise<CompResult[]> {
    const raw = listing.raw as { template?: Template } | undefined;
    const template = raw?.template;
    if (!template) return [];
    const median = Math.round(template.resaleEuros * 100);
    return [
      {
        source: 'demo:comps',
        kind: 'sold',
        sampleSize: 12,
        priceMinCents: Math.round(median * 0.82),
        priceMedianCents: median,
        priceMaxCents: Math.round(median * 1.18),
        currency: 'EUR',
        quality: 0.8,
        daysToSell: template.daysToSell,
        note: 'Comparaison fictive (mode demo)',
      },
    ];
  },
};

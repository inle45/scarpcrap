/** Types partages entre connecteurs, moteur d'evaluation, base et API. */

/**
 * Domaine produit. Sert a deux choses : filtrer dans le dashboard, et
 * calculer l'indice de revente par categorie (on ne compare pas la marge
 * d'un vinyle a celle d'une montre).
 */
export const DOMAINS = [
  'electronics',
  'fashion',
  'sneakers',
  'watches',
  'collectibles',
  'videogames',
  'music',
  'lego',
  'furniture',
  'books',
  'toys',
  'art',
  'perfume',
  'other',
] as const;

export type Domain = (typeof DOMAINS)[number];

export const DOMAIN_LABELS: Record<Domain, string> = {
  electronics: 'Electronique',
  fashion: 'Vetements',
  sneakers: 'Sneakers',
  watches: 'Montres',
  collectibles: 'Collectibles',
  videogames: 'Jeux video',
  music: 'Musique / vinyles',
  lego: 'LEGO',
  furniture: 'Meubles',
  books: 'Livres',
  toys: 'Jouets',
  art: 'Art / deco',
  perfume: 'Parfums',
  other: 'Autre',
};

export type Condition = 'new' | 'like_new' | 'good' | 'fair' | 'poor' | 'unknown';

export type DealStatus = 'new' | 'bought' | 'skipped' | 'sold';

/** Une annonce telle que renvoyee par un connecteur, avant toute evaluation. */
export interface RawListing {
  /** Identifiant du connecteur, ex 'ebay'. */
  source: string;
  /** Identifiant chez la source. Unique au sein de la source. */
  externalId: string;
  url: string;
  title: string;
  description: string;
  priceCents: number;
  shippingCents: number;
  currency: string;
  condition: Condition;
  /** Categorie brute cote source, gardee telle quelle pour le debug. */
  sourceCategory: string;
  domain: Domain;
  /** Cle de recherche stable si la source en fournit une (ex: release_id Discogs, n° de set LEGO). */
  productKey?: string;
  sellerId: string;
  sellerName: string;
  /** Pourcentage d'avis positifs, 0-100, ou null si inconnu. */
  sellerRating: number | null;
  sellerFeedbackCount: number | null;
  /** Date de creation du compte vendeur en ISO, ou null si inconnue. */
  sellerSince: string | null;
  imageUrl: string | null;
  imagesCount: number;
  location: string | null;
  /** Delai de reception estime en jours, si la source le fournit. */
  shippingDays: number | null;
  /** Charge utile d'origine, pour pouvoir reanalyser sans re-scraper. */
  raw: unknown;
}

/** Qualite d'une serie de comparaisons de prix. Determine la confiance dans l'estimation. */
export type CompKind = 'sold' | 'active';

export interface CompResult {
  /** Marketplace ou les comparaisons ont ete trouvees. */
  source: string;
  /**
   * 'sold' = prix reellement payes (Discogs, BrickLink) — fiable.
   * 'active' = prix demandes (eBay Browse) — structurellement optimiste.
   */
  kind: CompKind;
  sampleSize: number;
  priceMinCents: number;
  priceMedianCents: number;
  priceMaxCents: number;
  currency: string;
  /** 0..1 : confiance dans cette serie (taille d'echantillon, type, dispersion). */
  quality: number;
  /** Delai de revente estime en jours a partir de la liquidite observee. */
  daysToSell: number;
  /** Trace lisible pour le dashboard : d'ou vient l'estimation. */
  note: string;
}

/** Resultat complet de l'evaluation economique d'une annonce. */
export interface Economics {
  buyPriceCents: number;
  buyShippingCents: number;
  buyTotalCents: number;
  resaleEstimateCents: number;
  resaleMaxCents: number;
  resaleMarketplace: string;
  sellCommissionCents: number;
  sellShippingCents: number;
  packagingCents: number;
  feesTotalCents: number;
  netProfitCents: number;
  roiPct: number;
  daysToReceive: number;
  daysToSell: number;
  totalDays: number;
  /** Metrique de tri principale : profit net rapporte au capital immobilise par jour. */
  roiPerDayCents: number;
}

export interface TrustComponent {
  key: string;
  label: string;
  score: number;
  max: number;
  detail: string;
}

export interface TrustResult {
  score: number;
  components: TrustComponent[];
  /** Signaux rouges a afficher tels quels dans le dashboard. */
  flags: string[];
}

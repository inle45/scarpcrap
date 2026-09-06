import type { RawListing, TrustComponent, TrustResult } from '../types.js';
import { clamp } from '../util/money.js';
import { scamSignals } from '../util/text.js';

/**
 * Score de confiance 0-100.
 *
 * Principe directeur : en cas d'information manquante, on attribue un score
 * **neutre**, jamais un bonus. Une annonce dont on ne sait rien ne doit pas
 * franchir le seuil par defaut de 70 sur la seule foi du silence.
 *
 * Repartition : reputation 25, anciennete 10, coherence du prix 25,
 * photos 15, description 15, signaux d'arnaque 10.
 */

export interface TrustInput {
  listing: RawListing;
  /** Prix de marche observe (mediane des comparaisons, sans decote), ou null. */
  marketMedianCents: number | null;
  /** Nombre d'autres vendeurs utilisant deja la meme photo dans notre base. */
  imageReuseCount: number;
  /** Faux quand la source ne fournit pas de description exploitable. */
  descriptionAvailable: boolean;
}

/** Reputation du vendeur : croise le taux d'avis positifs et le volume. */
function reputationComponent(listing: RawListing): TrustComponent {
  const max = 25;
  const rating = listing.sellerRating;
  const count = listing.sellerFeedbackCount ?? 0;

  if (rating === null) {
    return {
      key: 'reputation',
      label: 'Reputation du vendeur',
      score: 12,
      max,
      detail: 'Aucune note disponible sur cette source — score neutre.',
    };
  }

  // En dessous de 90 % d'avis positifs, la note ne vaut plus rien.
  const quality = clamp((rating - 90) / 10, 0, 1);
  // Le volume sature vers 1000 evaluations : au-dela, ca n'apprend plus rien.
  const volume = clamp(Math.log10(count + 1) / 3, 0, 1);
  const score = Math.round(max * (0.6 * quality + 0.4 * volume));

  return {
    key: 'reputation',
    label: 'Reputation du vendeur',
    score,
    max,
    detail: `${rating.toFixed(1)} % d'avis positifs sur ${count} evaluations.`,
  };
}

/** Anciennete du compte : un compte cree la semaine derniere est un signal fort. */
function accountAgeComponent(listing: RawListing): TrustComponent {
  const max = 10;
  if (!listing.sellerSince) {
    return {
      key: 'account_age',
      label: 'Anciennete du compte',
      score: 5,
      max,
      detail: 'Date de creation inconnue — score neutre.',
    };
  }

  const ms = Date.now() - Date.parse(listing.sellerSince);
  if (!Number.isFinite(ms)) {
    return { key: 'account_age', label: 'Anciennete du compte', score: 5, max, detail: 'Date illisible.' };
  }

  const days = ms / 86_400_000;
  let score: number;
  if (days < 30) score = 0;
  else if (days < 180) score = 3;
  else if (days < 730) score = 7;
  else score = 10;

  const years = days / 365;
  return {
    key: 'account_age',
    label: 'Anciennete du compte',
    score,
    max,
    detail: years >= 1 ? `Compte ouvert depuis ${years.toFixed(1)} an(s).` : `Compte ouvert depuis ${Math.round(days)} jours.`,
  };
}

/**
 * Coherence du prix.
 *
 * C'est le composant le plus utile contre les fausses annonces : une
 * PlayStation a 15 % du prix du marche n'est pas une bonne affaire, c'est un
 * appat. Mais un prix *proche* du marche n'est pas non plus rassurant en soi,
 * donc il plafonne au meme niveau qu'une bonne affaire credible.
 */
function priceCoherenceComponent(input: TrustInput): TrustComponent {
  const max = 25;
  const { listing, marketMedianCents } = input;

  if (!marketMedianCents || marketMedianCents <= 0) {
    return {
      key: 'price_coherence',
      label: 'Coherence du prix',
      score: 12,
      max,
      detail: 'Aucun prix de marche fiable trouve — score neutre.',
    };
  }

  const buyTotal = listing.priceCents + listing.shippingCents;
  const ratio = buyTotal / marketMedianCents;
  const pct = Math.round(ratio * 100);

  let score: number;
  let detail: string;
  if (ratio >= 0.85) {
    score = 25;
    detail = `Prix a ${pct} % du marche : coherent, marge faible.`;
  } else if (ratio >= 0.5) {
    score = 25;
    detail = `Prix a ${pct} % du marche : bonne affaire credible.`;
  } else if (ratio >= 0.35) {
    score = 17;
    detail = `Prix a ${pct} % du marche : agressif, verifier l'etat et les photos.`;
  } else if (ratio >= 0.2) {
    score = 8;
    detail = `Prix a ${pct} % du marche : anormalement bas, mefiance.`;
  } else {
    score = 1;
    detail = `Prix a ${pct} % du marche : profil typique d'annonce appat.`;
  }

  return { key: 'price_coherence', label: 'Coherence du prix', score, max, detail };
}

/** Photos : quantite, et surtout reutilisation de la meme image par plusieurs vendeurs. */
function photosComponent(input: TrustInput): TrustComponent {
  const max = 15;
  const n = input.listing.imagesCount;

  let score: number;
  if (n <= 0) score = 0;
  else if (n === 1) score = 4;
  else if (n <= 3) score = 8;
  else if (n <= 6) score = 12;
  else score = 15;

  let detail = `${n} photo(s) dans l'annonce.`;

  // Substitut gratuit a la recherche d'image inversee : si la meme URL
  // d'image apparait chez d'autres vendeurs de notre base, c'est une photo
  // reprise, pas une photo de l'objet reellement detenu.
  if (input.imageReuseCount > 0) {
    const penalty = Math.min(input.imageReuseCount * 4, 10);
    score = Math.max(0, score - penalty);
    detail += ` Photo deja vue chez ${input.imageReuseCount} autre(s) vendeur(s) — probable image reprise.`;
  }

  return { key: 'photos', label: 'Photos', score, max, detail };
}

/** Mots qui signalent une description ecrite par quelqu'un qui a l'objet en main. */
const SPECIFICITY_HINTS =
  /\b(facture|notice|complet|complete|teste|testee|serie|numero|dimensions?|reference|garantie|origine|fonctionne|revise|revisee|nettoye|nettoyee)\b/i;

function descriptionComponent(input: TrustInput): TrustComponent {
  const max = 15;
  if (!input.descriptionAvailable) {
    return {
      key: 'description',
      label: 'Qualite de la description',
      score: 7,
      max,
      detail: 'Description non fournie par la source — score neutre.',
    };
  }

  const text = input.listing.description.trim();
  const len = text.length;

  let score: number;
  if (len < 40) score = 2;
  else if (len < 120) score = 6;
  else if (len < 400) score = 11;
  else score = 14;

  const specific = SPECIFICITY_HINTS.test(text);
  if (specific) score = Math.min(max, score + 1);

  return {
    key: 'description',
    label: 'Qualite de la description',
    score,
    max,
    detail:
      `${len} caracteres` +
      (specific ? ', mentions concretes (etat, accessoires, tests).' : ', peu de details verifiables.'),
  };
}

/** Signaux d'arnaque textuels : sortie de plateforme, urgence, contrefacon. */
function redFlagsComponent(listing: RawListing): { component: TrustComponent; flags: string[] } {
  const max = 10;
  const haystack = `${listing.title}\n${listing.description}`;
  const signals = scamSignals(haystack);
  const penalty = signals.reduce((sum, s) => sum + s.weight, 0);
  const score = Math.max(0, max - penalty);

  return {
    component: {
      key: 'red_flags',
      label: "Signaux d'alerte",
      score,
      max,
      detail:
        signals.length === 0
          ? 'Aucun signal suspect detecte dans le texte.'
          : `Detecte : ${signals.map((s) => s.label).join(', ')}.`,
    },
    flags: signals.map((s) => s.label),
  };
}

export function scoreTrust(input: TrustInput): TrustResult {
  const red = redFlagsComponent(input.listing);
  const components: TrustComponent[] = [
    reputationComponent(input.listing),
    accountAgeComponent(input.listing),
    priceCoherenceComponent(input),
    photosComponent(input),
    descriptionComponent(input),
    red.component,
  ];

  const score = clamp(
    Math.round(components.reduce((sum, c) => sum + c.score, 0)),
    0,
    components.reduce((sum, c) => sum + c.max, 0),
  );

  const flags = [...red.flags];

  // Un prix aberrant est un drapeau a part entiere, meme sans mot-cle suspect.
  const priceComponent = components.find((c) => c.key === 'price_coherence');
  if (priceComponent && priceComponent.score <= 8) flags.push('prix anormalement bas');
  if (input.imageReuseCount > 0) flags.push('photo reutilisee');

  return { score, components, flags };
}

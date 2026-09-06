import type { Logger } from '../logger.js';
import type { CallBudget, RateLimiter } from '../util/ratelimit.js';
import type { CompResult, Domain, RawListing } from '../types.js';

/**
 * Statut CGU d'une source. Affiche tel quel dans le dashboard : c'est
 * l'utilisateur qui decide en connaissance de cause, pas l'outil.
 */
export type ComplianceLevel = 'official-api' | 'tolerated' | 'against-tos';

export interface ComplianceNote {
  level: ComplianceLevel;
  /** Explication courte, en francais, affichee dans l'interface. */
  summary: string;
  /** Lien vers la doc ou les CGU concernees. */
  reference: string;
}

export interface ConnectorContext {
  log: Logger;
  /** Plafond d'appels pour ce cycle, partage entre decouverte et comparaisons. */
  budget: CallBudget;
  limiter: RateLimiter;
}

/**
 * Un connecteur implemente au choix la decouverte (trouver des annonces a
 * acheter), la comparaison (estimer un prix de revente), ou les deux.
 *
 * Cette separation est volontaire : la plupart des API officielles gratuites
 * exposent d'excellentes donnees de prix mais aucun moyen de parcourir les
 * annonces d'autres vendeurs. Discogs et BrickLink sont dans ce cas.
 */
export interface Connector {
  readonly id: string;
  readonly label: string;
  readonly compliance: ComplianceNote;
  /** Domaines produits couverts. `['*']` signifie « tous ». */
  readonly domains: ReadonlyArray<Domain | '*'>;

  /** Vrai si les identifiants necessaires sont presents. */
  isConfigured(): boolean;

  /** Raison lisible de l'indisponibilite, quand `isConfigured()` est faux. */
  missingConfig(): string;

  /** Trouve des annonces potentiellement sous-evaluees. */
  discover?(ctx: ConnectorContext): Promise<RawListing[]>;

  /**
   * Complete une annonce avec les champs couteux (description complete,
   * anciennete du vendeur, nombre de photos). Appele uniquement sur les
   * candidats deja prometteurs, pour economiser le quota.
   */
  enrich?(listing: RawListing, ctx: ConnectorContext): Promise<RawListing>;

  /** Estime le prix de revente d'une annonce sur cette plateforme. */
  comps?(listing: RawListing, ctx: ConnectorContext): Promise<CompResult[]>;
}

export const COMPLIANCE_LABELS: Record<ComplianceLevel, string> = {
  'official-api': 'API officielle',
  tolerated: 'Tolere (page publique, sans API)',
  'against-tos': 'Contraire aux CGU',
};

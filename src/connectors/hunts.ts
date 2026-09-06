import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from '../logger.js';
import { DOMAINS, type Condition, type Domain } from '../types.js';

const log = createLogger('hunts');

/**
 * Une « chasse » = une recherche recurrente sur une source.
 *
 * C'est le point d'extension principal du projet : ajouter un domaine
 * produit ne demande pas de code, seulement une entree dans
 * `config/hunts.json`. Un fichier absent fait retomber sur les defauts
 * compiles plus bas.
 */
export interface Hunt {
  id: string;
  source: string;
  domain: Domain;
  enabled: boolean;
  query: string;
  /** Identifiants de categorie cote source, si la source en accepte. */
  categoryIds: string[];
  minPriceEur: number | null;
  maxPriceEur: number | null;
  conditions: Condition[];
  limit: number;
  /** Commentaire libre, pour se souvenir de pourquoi cette chasse existe. */
  note: string;
}

const DEFAULT_HUNTS: ReadonlyArray<Hunt> = [
  // ── Musique : le meilleur couple decouverte/comparaison du MVP.
  //    eBay a des lots de vinyles mal titres, Discogs donne des prix reels.
  hunt('ebay-music-vinyl-lot', 'ebay', 'music', 'vinyle 33 tours lot', ['306'], 15, 120, ['good', 'fair'], 60,
    'Lots de vinyles sous-titres sur eBay, revente a la piece sur Discogs.'),
  hunt('ebay-music-vinyl-rock', 'ebay', 'music', 'vinyl lp rock original pressing', ['306'], 10, 90, ['good', 'like_new'], 60,
    'Pressages originaux ; Discogs price_suggestions donne un prix de vente reel.'),

  // ── LEGO : BrickLink fournit un guide de prix sur les ventes des 6 derniers mois.
  hunt('ebay-lego-sets', 'ebay', 'lego', 'lego set complet boite', ['19006'], 20, 250, ['good', 'like_new', 'new'], 60,
    'Sets LEGO ; comparaison BrickLink « sold », la donnee la plus fiable du projet.'),
  hunt('ebay-lego-vrac', 'ebay', 'lego', 'lego vrac lot kg', ['19006'], 15, 150, ['good', 'fair'], 40,
    'Lots au poids : marge elevee mais tri chronophage, surveiller le ROI/jour.'),

  // ── Electronique : gros volume, liquidite forte, marges moyennes.
  hunt('ebay-audio-casques', 'ebay', 'electronics', 'casque audio sans fil', ['112529'], 25, 250, ['good', 'like_new'], 50,
    'Casques Sony/Bose/Sennheiser ; comparaison eBay DE souvent 15-25 % au-dessus.'),
  hunt('ebay-photo-objectifs', 'ebay', 'electronics', 'objectif appareil photo monture', ['3323'], 40, 400, ['good', 'like_new'], 50,
    'Optiques : peu de contrefacon, prix stables, acheteurs internationaux.'),

  // ── Jeux video : forte liquidite, attention aux contrefacons de cartouches.
  hunt('ebay-jeux-retro', 'ebay', 'videogames', 'jeu retro console complet boite', ['139973'], 15, 200, ['good', 'like_new'], 50,
    'Retro en boite ; verifier les repro-carts, le score de confiance compte double ici.'),

  // ── Montres : marges elevees mais contrefacon massive, seuil de confiance haut.
  hunt('ebay-montres-mecaniques', 'ebay', 'watches', 'montre mecanique automatique vintage', ['31387'], 60, 600, ['good', 'like_new'], 40,
    'Domaine a plus fort risque de contrefacon : ne rien acheter sous 85 de confiance.'),

  // ── Sneakers : verifier l'authenticite, marges bonnes sur les tailles rares.
  hunt('ebay-sneakers', 'ebay', 'sneakers', 'sneakers baskets edition', ['15709'], 40, 350, ['like_new', 'new'], 40,
    'Contrefacon frequente ; privilegier les vendeurs a fort historique.'),

  // ── Collectibles : cartes, figurines, monnaies.
  hunt('ebay-cartes-collection', 'ebay', 'collectibles', 'carte collection lot rare', ['2536'], 15, 200, ['good', 'like_new'], 40,
    'Lots de cartes ; la valeur se concentre souvent sur 2-3 pieces du lot.'),
];

function hunt(
  id: string,
  source: string,
  domain: Domain,
  query: string,
  categoryIds: string[],
  minPriceEur: number | null,
  maxPriceEur: number | null,
  conditions: Condition[],
  limit: number,
  note: string,
): Hunt {
  return { id, source, domain, enabled: true, query, categoryIds, minPriceEur, maxPriceEur, conditions, limit, note };
}

let cache: Hunt[] | null = null;

/** Charge `config/hunts.json` s'il existe, sinon les chasses par defaut. */
export function loadHunts(path = process.env['HUNTS_FILE'] ?? './config/hunts.json'): Hunt[] {
  if (cache) return cache;
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    log.info('config/hunts.json absent, utilisation des chasses par defaut', {
      count: DEFAULT_HUNTS.length,
    });
    cache = DEFAULT_HUNTS.map((h) => ({ ...h }));
    return cache;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(absolute, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('le fichier doit contenir un tableau');
    const hunts = parsed.map(normalizeHunt).filter((h): h is Hunt => h !== null);
    log.info('chasses chargees', { path: absolute, count: hunts.length });
    cache = hunts;
    return cache;
  } catch (err) {
    log.error('config/hunts.json illisible, retour aux defauts', {
      path: absolute,
      err: err instanceof Error ? err.message : String(err),
    });
    cache = DEFAULT_HUNTS.map((h) => ({ ...h }));
    return cache;
  }
}

export function resetHuntsCache(): void {
  cache = null;
}

export function huntsForSource(source: string): Hunt[] {
  return loadHunts().filter((h) => h.enabled && h.source === source);
}

/** Valide et complete une entree du fichier de configuration. */
function normalizeHunt(input: unknown): Hunt | null {
  if (typeof input !== 'object' || input === null) return null;
  const o = input as Record<string, unknown>;
  const id = typeof o['id'] === 'string' ? o['id'] : '';
  const source = typeof o['source'] === 'string' ? o['source'] : '';
  const query = typeof o['query'] === 'string' ? o['query'] : '';
  if (!id || !source || !query) {
    log.warn('chasse ignoree : id, source et query sont obligatoires', { entry: o });
    return null;
  }
  const domain = (DOMAINS as ReadonlyArray<string>).includes(String(o['domain']))
    ? (o['domain'] as Domain)
    : 'other';
  return {
    id,
    source,
    domain,
    enabled: o['enabled'] !== false,
    query,
    categoryIds: Array.isArray(o['categoryIds']) ? o['categoryIds'].map(String) : [],
    minPriceEur: typeof o['minPriceEur'] === 'number' ? o['minPriceEur'] : null,
    maxPriceEur: typeof o['maxPriceEur'] === 'number' ? o['maxPriceEur'] : null,
    conditions: Array.isArray(o['conditions']) ? (o['conditions'] as Condition[]) : [],
    limit: typeof o['limit'] === 'number' ? Math.min(Math.max(o['limit'], 1), 200) : 50,
    note: typeof o['note'] === 'string' ? o['note'] : '',
  };
}

export { DEFAULT_HUNTS };

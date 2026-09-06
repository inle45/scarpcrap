import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('fees');

/**
 * Modele de frais d'une marketplace de revente.
 *
 * Les commissions bougent souvent et dependent du statut du vendeur
 * (particulier ou professionnel) et de la categorie. Les valeurs ci-dessous
 * sont **volontairement conservatrices** : mieux vaut ecarter un deal
 * correct que d'en proposer un qui perd de l'argent. Elles sont surchargeables
 * sans toucher au code via `config/fees.json`.
 */
export interface FeeModel {
  marketplace: string;
  label: string;
  /** Commission sur le prix de vente, en pourcentage. */
  commissionPct: number;
  /** Vrai si la commission s'applique aussi aux frais de port encaisses. */
  commissionIncludesShipping: boolean;
  /** Frais fixes par commande, en centimes. */
  fixedCents: number;
  /** Frais d'encaissement (PSP), en pourcentage du total. */
  paymentPct: number;
  paymentFixedCents: number;
  /** Cout d'expedition a la revente, en centimes. */
  shipOutCents: number;
  /** Emballage : carton, bulle, etiquette. */
  packagingCents: number;
  /** Delai de revente par defaut quand la comparaison n'en fournit pas. */
  defaultDaysToSell: number;
  /** Precision utile a afficher dans le dashboard. */
  note: string;
}

const DEFAULTS: Record<string, FeeModel> = {
  ebay: {
    marketplace: 'ebay',
    label: 'eBay',
    // eBay France ne facture plus de commission aux vendeurs *particuliers*
    // depuis fin 2024. Le defaut retenu ici est celui d'un vendeur
    // professionnel, parce qu'une activite d'arbitrage reguliere finit par
    // etre requalifiee. Mets `commissionPct: 0` dans config/fees.json si tu
    // vends bien en tant que particulier.
    commissionPct: 12.8,
    commissionIncludesShipping: true,
    fixedCents: 35,
    paymentPct: 0,
    paymentFixedCents: 0,
    shipOutCents: 690,
    packagingCents: 150,
    defaultDaysToSell: 25,
    note: 'Commission pro par defaut (12,8 % + 0,35 EUR). Passe a 0 si tu vends en particulier.',
  },
  discogs: {
    marketplace: 'discogs',
    label: 'Discogs',
    commissionPct: 9,
    commissionIncludesShipping: true,
    fixedCents: 0,
    // Discogs Payments preleve des frais d'encaissement en plus de la commission.
    paymentPct: 2.9,
    paymentFixedCents: 30,
    shipOutCents: 550,
    packagingCents: 200,
    defaultDaysToSell: 35,
    note: 'Commission 9 % + encaissement ~2,9 %. Emballage vinyle plus cher que la moyenne.',
  },
  bricklink: {
    marketplace: 'bricklink',
    label: 'BrickLink',
    commissionPct: 3,
    commissionIncludesShipping: false,
    fixedCents: 0,
    paymentPct: 2.9,
    paymentFixedCents: 30,
    shipOutCents: 790,
    packagingCents: 250,
    defaultDaysToSell: 40,
    note: 'Commission 3 %. Colis LEGO souvent volumineux : port et emballage plus eleves.',
  },
  demo: {
    marketplace: 'demo',
    label: 'Demo',
    commissionPct: 10,
    commissionIncludesShipping: true,
    fixedCents: 0,
    paymentPct: 0,
    paymentFixedCents: 0,
    shipOutCents: 690,
    packagingCents: 150,
    defaultDaysToSell: 25,
    note: 'Frais fictifs (mode demo).',
  },
};

let cache: Record<string, FeeModel> | null = null;

/** Charge `config/fees.json` si present, en fusionnant avec les defauts. */
export function loadFees(path = process.env['FEES_FILE'] ?? './config/fees.json'): Record<string, FeeModel> {
  if (cache) return cache;
  const absolute = resolve(path);
  const merged: Record<string, FeeModel> = Object.fromEntries(
    Object.entries(DEFAULTS).map(([k, v]) => [k, { ...v }]),
  );

  if (existsSync(absolute)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(absolute, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value !== 'object' || value === null) continue;
          const base = merged[key] ?? { ...DEFAULTS['ebay']!, marketplace: key, label: key };
          merged[key] = { ...base, ...(value as Partial<FeeModel>), marketplace: key };
        }
        log.info('bareme de frais charge', { path: absolute });
      }
    } catch (err) {
      log.error('config/fees.json illisible, defauts conserves', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  cache = merged;
  return cache;
}

export function resetFeesCache(): void {
  cache = null;
}

/**
 * Retrouve le bareme d'une marketplace.
 * Les identifiants de comparaison eBay sont suffixes (`ebay:EBAY_DE`) :
 * on ne garde que la partie avant les deux-points.
 */
export function feeModelFor(marketplace: string): FeeModel {
  const fees = loadFees();
  const base = marketplace.split(':')[0] ?? marketplace;
  return fees[base] ?? fees['ebay']!;
}

export function allFeeModels(): FeeModel[] {
  return Object.values(loadFees());
}

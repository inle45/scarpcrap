import type { CompResult, Economics, RawListing } from '../types.js';
import { pctOf, round } from '../util/money.js';
import { feeModelFor, type FeeModel } from './fees.js';

/**
 * Decote appliquee aux comparaisons de type `active`.
 *
 * Une mediane de prix *demandes* est structurellement au-dessus des prix
 * reellement payes : les annonces les plus cheres restent en ligne, les
 * moins cheres partent. 15 % est un compromis prudent, ajustable ici une
 * fois qu'on a assez de ventes reelles dans la table `capital` pour le
 * calibrer sur ses propres donnees.
 */
export const ACTIVE_COMP_DISCOUNT = 0.85;

/** Delai de reception par defaut quand la source ne l'indique pas. */
const DEFAULT_DAYS_TO_RECEIVE = 5;

/** Temps de mise en vente : photos, description, expedition. */
const HANDLING_DAYS = 2;

export interface EvaluationOption extends Economics {
  comp: CompResult;
  fee: FeeModel;
}

/** Prix de revente retenu pour une comparaison, apres decote eventuelle. */
export function expectedResaleCents(comp: CompResult): number {
  const factor = comp.kind === 'active' ? ACTIVE_COMP_DISCOUNT : 1;
  return Math.round(comp.priceMedianCents * factor);
}

/** Total des frais de revente pour un prix de vente donne. */
export function sellingFeesCents(fee: FeeModel, resaleCents: number): {
  commission: number;
  payment: number;
  shipping: number;
  packaging: number;
  total: number;
} {
  const commissionBase = fee.commissionIncludesShipping ? resaleCents + fee.shipOutCents : resaleCents;
  const commission = pctOf(commissionBase, fee.commissionPct) + fee.fixedCents;
  const payment = pctOf(resaleCents + fee.shipOutCents, fee.paymentPct) + fee.paymentFixedCents;
  const shipping = fee.shipOutCents;
  const packaging = fee.packagingCents;
  return { commission, payment, shipping, packaging, total: commission + payment + shipping + packaging };
}

/** Evalue une annonce contre une comparaison precise. */
export function evaluateAgainstComp(listing: RawListing, comp: CompResult): EvaluationOption {
  const fee = feeModelFor(comp.source);
  const buyTotalCents = listing.priceCents + listing.shippingCents;

  const resaleEstimateCents = expectedResaleCents(comp);
  const resaleMaxCents = Math.round(
    comp.priceMaxCents * (comp.kind === 'active' ? ACTIVE_COMP_DISCOUNT : 1),
  );

  const fees = sellingFeesCents(fee, resaleEstimateCents);
  const netProfitCents = resaleEstimateCents - buyTotalCents - fees.total;

  const daysToReceive = listing.shippingDays ?? DEFAULT_DAYS_TO_RECEIVE;
  const daysToSell = comp.daysToSell > 0 ? comp.daysToSell : fee.defaultDaysToSell;
  const totalDays = Math.max(1, daysToReceive + HANDLING_DAYS + daysToSell);

  return {
    comp,
    fee,
    buyPriceCents: listing.priceCents,
    buyShippingCents: listing.shippingCents,
    buyTotalCents,
    resaleEstimateCents,
    resaleMaxCents,
    resaleMarketplace: comp.source,
    sellCommissionCents: fees.commission + fees.payment,
    sellShippingCents: fees.shipping,
    packagingCents: fees.packaging,
    feesTotalCents: fees.total,
    netProfitCents,
    roiPct: buyTotalCents > 0 ? round((netProfitCents / buyTotalCents) * 100, 2) : 0,
    daysToReceive,
    daysToSell,
    totalDays,
    // Metrique de tri principale : ce que le capital immobilise rapporte
    // chaque jour. Un deal a +40 EUR en 90 jours vaut moins qu'un deal a
    // +15 EUR en 10 jours.
    roiPerDayCents: Math.round(netProfitCents / totalDays),
  };
}

export interface EvaluationResult {
  best: EvaluationOption;
  /** Toutes les options examinees, triees du meilleur au moins bon. */
  options: EvaluationOption[];
  /** Qualite de la comparaison retenue, 0..1. */
  compQuality: number;
}

/**
 * Choisit la meilleure marketplace de revente.
 *
 * On ne compare pas les prix bruts mais le **profit net apres frais** : une
 * plateforme qui affiche 10 % de plus mais preleve 12 % de commission est
 * moins interessante. A profit net egal, la comparaison la plus fiable gagne.
 */
export function evaluate(listing: RawListing, comps: CompResult[]): EvaluationResult | null {
  if (comps.length === 0) return null;

  const options = comps
    .map((comp) => evaluateAgainstComp(listing, comp))
    .sort((a, b) => {
      const byProfit = b.netProfitCents - a.netProfitCents;
      if (byProfit !== 0) return byProfit;
      return b.comp.quality - a.comp.quality;
    });

  const best = options[0]!;
  return { best, options, compQuality: best.comp.quality };
}

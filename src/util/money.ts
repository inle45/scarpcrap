/**
 * Tout l'argent circule en **centimes entiers** dans ce projet.
 * Les flottants n'apparaissent que pour l'affichage et les pourcentages.
 */

export function eurosToCents(euros: number): number {
  return Math.round(euros * 100);
}

export function centsToEuros(cents: number): number {
  return cents / 100;
}

export function formatCents(cents: number, currency = 'EUR'): string {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(cents / 100);
}

/** Applique un pourcentage a un montant en centimes, en arrondissant a l'entier. */
export function pctOf(cents: number, pct: number): number {
  return Math.round((cents * pct) / 100);
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/** Percentile lineaire (p entre 0 et 1). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * Math.min(Math.max(p, 0), 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo));
}

/**
 * Retire les valeurs aberrantes par la methode de l'ecart interquartile.
 *
 * Indispensable sur des comparaisons de prix : une annonce a 1 EUR
 * (piece detachee, lot incomplet, erreur de saisie) ou a 5000 EUR
 * (vendeur delirant) fausse completement une moyenne.
 * En dessous de 4 valeurs l'IQR n'a pas de sens : on renvoie tel quel.
 */
export function dropOutliers(values: number[], k = 1.5): number[] {
  if (values.length < 4) return [...values];
  const q1 = percentile(values, 0.25);
  const q3 = percentile(values, 0.75);
  const iqr = q3 - q1;
  if (iqr === 0) return [...values];
  const lo = q1 - k * iqr;
  const hi = q3 + k * iqr;
  const kept = values.filter((v) => v >= lo && v <= hi);
  return kept.length > 0 ? kept : [...values];
}

/** Borne une valeur dans un intervalle. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Arrondi a `digits` decimales, pour les pourcentages stockes en REAL. */
export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

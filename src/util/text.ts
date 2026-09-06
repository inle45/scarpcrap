/** Normalisation de titres et heuristiques textuelles (matching de comparaisons, detection d'arnaque). */

/** Minuscules, sans accents, sans ponctuation, espaces normalises. */
export function normalize(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Mots vides + bruit marketing typique des annonces.
 * Les retirer avant de construire une requete de comparaison evite de
 * chercher "tres bon etat envoi rapide" au lieu du produit lui-meme.
 */
const NOISE = new Set([
  // articles / liaisons
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'a', 'au', 'aux',
  'en', 'pour', 'avec', 'sans', 'sur', 'dans', 'par', 'the', 'and', 'for', 'with',
  // bruit d'annonce
  'neuf', 'neuve', 'occasion', 'tbe', 'bon', 'tres', 'etat', 'parfait', 'excellent',
  'rare', 'vintage', 'authentique', 'original', 'originale', 'garantie', 'facture',
  'envoi', 'rapide', 'gratuit', 'livraison', 'port', 'offert', 'offerte', 'lot',
  'urgent', 'promo', 'solde', 'destockage', 'cause', 'demenagement', 'prix',
  'negociable', 'ferme', 'vends', 'vendre', 'vend', 'cede', 'dispo', 'disponible',
  'new', 'used', 'mint', 'condition', 'free', 'shipping', 'fast', 'sale',
  // adjectifs valorisants, omnipresents et sans valeur discriminante
  'superbe', 'magnifique', 'sublime', 'joli', 'jolie', 'beau', 'belle', 'bel',
  'impeccable', 'nickel', 'propre', 'super', 'genial', 'top', 'exceptionnel',
  'exceptionnelle', 'incroyable', 'unique', 'grand', 'grande', 'petit', 'petite',
]);

export function tokens(input: string): string[] {
  return normalize(input)
    .split(' ')
    .filter((t) => t.length > 1 && !NOISE.has(t));
}

/**
 * Construit une requete de recherche courte a partir d'un titre d'annonce.
 * On garde les premiers tokens significatifs : les moteurs de recherche
 * marketplace degradent vite quand la requete depasse ~8 mots.
 */
export function searchQueryFromTitle(title: string, maxTokens = 6): string {
  const t = tokens(title);
  // Les references produit (alphanumeriques, ex "wh-1000xm4", "75192") sont
  // les tokens les plus discriminants : on les remonte en tete.
  const refs = t.filter((x) => /\d/.test(x) && /[a-z]/.test(x));
  const nums = t.filter((x) => /^\d{3,}$/.test(x));
  const rest = t.filter((x) => !refs.includes(x) && !nums.includes(x));
  const ordered = [...refs, ...nums, ...rest];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of ordered) {
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= maxTokens) break;
  }
  return out.join(' ');
}

/** Similarite de Jaccard sur les tokens : 0 = rien en commun, 1 = identique. */
export function similarity(a: string, b: string): number {
  const sa = new Set(tokens(a));
  const sb = new Set(tokens(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Signaux textuels d'arnaque, ponderes.
 * Volontairement conservateur : on penalise ce qui pousse a sortir de la
 * plateforme (le vecteur d'arnaque numero un) plutot que le style d'ecriture.
 */
const SCAM_PATTERNS: ReadonlyArray<{ re: RegExp; weight: number; label: string }> = [
  { re: /\bwhat'?s ?app\b|\btelegram\b|\bsignal\b/i, weight: 4, label: 'contact hors plateforme' },
  { re: /\b(western ?union|paypal ?(amis|friends|family)|virement ?(direct|bancaire)|crypto|bitcoin)\b/i, weight: 4, label: 'paiement hors plateforme' },
  { re: /\b(mandat ?cash|cheque ?de ?banque|coupon|paysafe)\b/i, weight: 3, label: 'moyen de paiement a risque' },
  { re: /\bhors ?(du )?site\b|\ben ?dehors ?(du|de la) ?(site|plateforme|app)\b/i, weight: 3, label: 'sortie de plateforme' },
  { re: /\b(0[67])[ .-]?(\d{2}[ .-]?){4}\b/, weight: 2, label: 'numero de telephone dans l\'annonce' },
  { re: /\burgent(e|issime)?\b.*\b(vente|vendre|depart|demenagement)\b/i, weight: 2, label: 'urgence appuyee' },
  { re: /\bderniere? (piece|chance)\b|\bplus qu'?un seul\b|\bstock limite\b/i, weight: 2, label: 'rarete artificielle' },
  { re: /\b(replique|copie|inspire de|style [a-z]+ ?(vuitton|gucci|rolex|nike))\b/i, weight: 5, label: 'contrefacon probable' },
  { re: /\benvoi (uniquement )?(apres|contre) (paiement|virement)\b/i, weight: 3, label: 'paiement avant protection' },
];

export interface ScamSignal {
  label: string;
  weight: number;
}

export function scamSignals(text: string): ScamSignal[] {
  const found: ScamSignal[] = [];
  for (const { re, weight, label } of SCAM_PATTERNS) {
    if (re.test(text)) found.push({ label, weight });
  }
  return found;
}

/** Tronque proprement pour l'affichage et les notifications. */
export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return input.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

import type { Connector, ConnectorContext } from '../connectors/types.js';
import type { CompResult, RawListing } from '../types.js';
import { errInfo, type Logger } from '../logger.js';

/**
 * Interroge tous les fournisseurs de comparaisons pertinents pour une annonce.
 *
 * Un fournisseur est retenu s'il declare couvrir le domaine du produit, ou
 * s'il declare `'*'`. Les echecs sont avales et journalises : une source
 * indisponible ne doit jamais faire echouer tout un cycle.
 */
export async function gatherComps(
  listing: RawListing,
  providers: Connector[],
  contextFor: (connector: Connector) => ConnectorContext,
  log: Logger,
): Promise<CompResult[]> {
  const out: CompResult[] = [];

  for (const provider of providers) {
    if (!provider.comps) continue;
    const covers = provider.domains.includes('*') || provider.domains.includes(listing.domain);
    if (!covers) continue;

    const ctx = contextFor(provider);
    if (ctx.budget.remaining <= 0) continue;

    try {
      const results = await provider.comps(listing, ctx);
      for (const r of results) {
        if (r.sampleSize > 0 && r.priceMedianCents > 0) out.push(r);
      }
    } catch (err) {
      log.debug('fournisseur de comparaison en echec', {
        provider: provider.id,
        listing: listing.externalId,
        ...errInfo(err),
      });
    }
  }

  return out;
}

/**
 * Prix de marche de reference, toutes comparaisons confondues.
 * Sert au score de coherence du prix : on veut la meilleure estimation
 * disponible du prix reel, pas celle de la marketplace de revente choisie.
 */
export function marketMedianCents(comps: CompResult[]): number | null {
  if (comps.length === 0) return null;
  const best = [...comps].sort((a, b) => {
    // Une vente reelle prime toujours sur un prix demande.
    if (a.kind !== b.kind) return a.kind === 'sold' ? -1 : 1;
    return b.quality - a.quality;
  })[0];
  return best ? best.priceMedianCents : null;
}

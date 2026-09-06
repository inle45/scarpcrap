import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { bricklinkConnector } from './bricklink.js';
import { demoConnector } from './demo.js';
import { discogsConnector } from './discogs.js';
import { ebayConnector } from './ebay.js';
import type { Connector } from './types.js';

const log = createLogger('connectors');

/**
 * Registre des connecteurs.
 *
 * Ajouter une source = ajouter un fichier qui exporte un `Connector` et
 * l'inscrire ici. Rien d'autre dans le projet ne connait les sources par leur
 * nom : le moteur d'evaluation, l'API et le dashboard travaillent tous sur
 * cette liste.
 */
const ALL: ReadonlyArray<Connector> = [
  ebayConnector,
  discogsConnector,
  bricklinkConnector,
  demoConnector,
];

export function allConnectors(): ReadonlyArray<Connector> {
  return ALL;
}

export function getConnector(id: string): Connector | undefined {
  return ALL.find((c) => c.id === id);
}

/** Connecteurs reellement utilisables : configures, et demo seulement si demande. */
export function activeConnectors(): Connector[] {
  return ALL.filter((c) => {
    if (c.id === 'demo') return config.demoMode;
    return c.isConfigured();
  });
}

export function discoverySources(): Connector[] {
  return activeConnectors().filter((c) => typeof c.discover === 'function');
}

export function compSources(): Connector[] {
  return activeConnectors().filter((c) => typeof c.comps === 'function');
}

/** Etat de chaque connecteur, expose au dashboard. */
export function connectorStatus(): Array<{
  id: string;
  label: string;
  configured: boolean;
  active: boolean;
  canDiscover: boolean;
  canCompare: boolean;
  domains: string[];
  compliance: Connector['compliance'];
  missing: string;
}> {
  const active = new Set(activeConnectors().map((c) => c.id));
  return ALL.map((c) => ({
    id: c.id,
    label: c.label,
    configured: c.isConfigured(),
    active: active.has(c.id),
    canDiscover: typeof c.discover === 'function',
    canCompare: typeof c.comps === 'function',
    domains: [...c.domains],
    compliance: c.compliance,
    missing: c.isConfigured() ? '' : c.missingConfig(),
  }));
}

export function logConnectorState(): void {
  for (const status of connectorStatus()) {
    if (status.active) {
      log.info('connecteur actif', { id: status.id, discover: status.canDiscover, compare: status.canCompare });
    } else if (status.id !== 'demo') {
      log.warn('connecteur inactif', { id: status.id, raison: status.missing });
    }
  }
}

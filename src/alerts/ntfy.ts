import { config } from '../config.js';
import { createLogger, errInfo } from '../logger.js';
import { requestText } from '../util/http.js';
import { formatCents } from '../util/money.js';
import { truncate } from '../util/text.js';
import { DOMAIN_LABELS, type Domain } from '../types.js';

const log = createLogger('ntfy');

/**
 * Notifications push via ntfy.sh.
 *
 * Choix assume : ntfy est gratuit, open source, auto-hebergeable, et son
 * application Android officielle se telecharge en .apk. Une notification
 * Android standard remonte automatiquement sur une Pixel Watch appairee —
 * pas besoin d'application Wear OS dediee.
 *
 * Sur l'instance publique ntfy.sh, **le nom du topic est le seul secret** :
 * n'importe qui le connaissant peut lire les alertes. D'ou l'avertissement
 * emis au demarrage si le topic est trop court.
 */

export interface AlertPayload {
  dealId: number;
  title: string;
  domain: Domain;
  source: string;
  url: string;
  buyTotalCents: number;
  resaleEstimateCents: number;
  netProfitCents: number;
  roiPct: number;
  roiPerDayCents: number;
  totalDays: number;
  trustScore: number;
  currency: string;
}

interface NtfyMessage {
  topic: string;
  title: string;
  message: string;
  priority: number;
  tags: string[];
  click?: string;
  actions?: Array<Record<string, unknown>>;
}

export function isNtfyReady(): boolean {
  return config.ntfy.enabled && config.ntfy.topic.length > 0;
}

/** Un deal exceptionnel merite de faire vibrer la montre plus fort. */
function priorityFor(payload: AlertPayload): number {
  if (payload.trustScore >= 90 && payload.roiPct >= 80) return 5;
  if (payload.roiPct >= 50) return 4;
  return 3;
}

function buildMessage(payload: AlertPayload, dashboardUrl: string): NtfyMessage {
  const money = (cents: number): string => formatCents(cents, payload.currency);
  const lines = [
    `Achat ${money(payload.buyTotalCents)} → revente ~${money(payload.resaleEstimateCents)}`,
    `Net ${money(payload.netProfitCents)} (${payload.roiPct.toFixed(0)} % ROI)`,
    `${money(payload.roiPerDayCents)}/jour sur ~${payload.totalDays} j · confiance ${payload.trustScore}/100`,
    `${DOMAIN_LABELS[payload.domain] ?? payload.domain} · ${payload.source}`,
  ];

  return {
    topic: config.ntfy.topic,
    title: truncate(payload.title, 90),
    message: lines.join('\n'),
    priority: priorityFor(payload),
    tags: ['moneybag', payload.trustScore >= 85 ? 'white_check_mark' : 'warning'],
    click: payload.url,
    actions: [
      { action: 'view', label: 'Voir l annonce', url: payload.url, clear: false },
      ...(dashboardUrl
        ? [{ action: 'view', label: 'Dashboard', url: `${dashboardUrl}/#deal-${payload.dealId}`, clear: false }]
        : []),
    ],
  };
}

/**
 * Envoie une alerte. Renvoie `false` en cas d'echec sans lever : une
 * notification perdue ne doit jamais interrompre un cycle de collecte.
 */
export async function sendAlert(payload: AlertPayload, dashboardUrl = ''): Promise<boolean> {
  if (!isNtfyReady()) return false;

  const body = buildMessage(payload, dashboardUrl);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.ntfy.token) headers['Authorization'] = `Bearer ${config.ntfy.token}`;

  try {
    // Publication en JSON plutot que par en-tetes : les en-tetes HTTP sont
    // limites a l'ASCII et casseraient les titres accentues.
    await requestText(config.ntfy.server, { method: 'POST', headers, body: JSON.stringify(body) });
    log.info('alerte envoyee', { dealId: payload.dealId, priority: body.priority });
    return true;
  } catch (err) {
    log.error('envoi de l alerte impossible', { dealId: payload.dealId, ...errInfo(err) });
    return false;
  }
}

/** Message de test, pour verifier la chaine jusqu'a la montre. */
export async function sendTestAlert(): Promise<boolean> {
  if (!isNtfyReady()) return false;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.ntfy.token) headers['Authorization'] = `Bearer ${config.ntfy.token}`;
  try {
    await requestText(config.ntfy.server, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        topic: config.ntfy.topic,
        title: 'scarpcrap — test',
        message: 'Si tu lis ceci sur ta montre, la chaine d alertes fonctionne.',
        priority: 3,
        tags: ['satellite'],
      }),
    });
    return true;
  } catch (err) {
    log.error('test d alerte en echec', errInfo(err));
    return false;
  }
}

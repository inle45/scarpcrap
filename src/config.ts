/**
 * Configuration derivee de l'environnement.
 *
 * Regle : tout ce qui est un secret ou depend de l'hebergement vit ici.
 * Tout ce que l'utilisateur peut vouloir changer a chaud (seuils) vit en
 * base, dans la table `settings`, et est lu via `db/repo.getSettings()`.
 */

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function list(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  env: str('NODE_ENV', 'development'),
  port: num('PORT', 8080),
  host: str('HOST', '0.0.0.0'),
  authToken: str('AUTH_TOKEN', ''),
  databasePath: str('DATABASE_PATH', './data/scarpcrap.db'),

  market: {
    country: str('MARKET_COUNTRY', 'FR'),
    currency: str('MARKET_CURRENCY', 'EUR'),
  },

  schedule: {
    enabled: bool('SCHEDULE_ENABLED', true),
    cron: str('SCHEDULE_CRON', '17 */3 * * *'),
    timezone: str('SCHEDULE_TIMEZONE', 'Europe/Paris'),
    runOnBoot: bool('RUN_ON_BOOT', false),
  },

  /** Valeurs de depart des seuils : ecrites en base au premier demarrage. */
  defaultSettings: {
    minTrustScore: num('MIN_TRUST_SCORE', 70),
    minRoiPct: num('MIN_ROI_PCT', 25),
    minNetProfitCents: Math.round(num('MIN_NET_PROFIT_EUR', 8) * 100),
    alertMinTrustScore: num('ALERT_MIN_TRUST_SCORE', 80),
    alertMinRoiPerDayCents: Math.round(num('ALERT_MIN_ROI_PER_DAY_EUR', 1.5) * 100),
    alertMaxPerRun: num('ALERT_MAX_PER_RUN', 5),
  },

  ntfy: {
    enabled: bool('NTFY_ENABLED', true),
    server: str('NTFY_SERVER', 'https://ntfy.sh').replace(/\/+$/, ''),
    topic: str('NTFY_TOPIC', ''),
    token: str('NTFY_TOKEN', ''),
  },

  ebay: {
    clientId: str('EBAY_CLIENT_ID', ''),
    clientSecret: str('EBAY_CLIENT_SECRET', ''),
    marketplaceId: str('EBAY_MARKETPLACE_ID', 'EBAY_FR'),
    compMarketplaces: list('EBAY_COMP_MARKETPLACES', ['EBAY_FR', 'EBAY_DE']),
    maxCallsPerRun: num('EBAY_MAX_CALLS_PER_RUN', 250),
    sandbox: bool('EBAY_SANDBOX', false),
  },

  discogs: {
    token: str('DISCOGS_TOKEN', ''),
    maxCallsPerRun: num('DISCOGS_MAX_CALLS_PER_RUN', 120),
  },

  bricklink: {
    consumerKey: str('BRICKLINK_CONSUMER_KEY', ''),
    consumerSecret: str('BRICKLINK_CONSUMER_SECRET', ''),
    token: str('BRICKLINK_TOKEN', ''),
    tokenSecret: str('BRICKLINK_TOKEN_SECRET', ''),
    maxCallsPerRun: num('BRICKLINK_MAX_CALLS_PER_RUN', 120),
  },

  /** URL publique du dashboard, incluse dans les notifications. */
  publicUrl: str('PUBLIC_URL', '').replace(/\/+$/, ''),

  pipeline: {
    /** Nombre d'annonces enrichies (1 appel API chacune) par cycle. */
    maxEnrichPerRun: num('MAX_ENRICH_PER_RUN', 25),
    /** Delai avant de reevaluer une annonce deja vue, en heures. */
    reevaluateAfterHours: num('REEVALUATE_AFTER_HOURS', 12),
    /** Age au-dela duquel une annonce non tranchee est purgee, en jours. */
    pruneAfterDays: num('PRUNE_AFTER_DAYS', 30),
    /** Plafond d'annonces evaluees par cycle, toutes sources confondues. */
    maxListingsPerRun: num('MAX_LISTINGS_PER_RUN', 300),
  },

  demoMode: bool('DEMO_MODE', false),

  /** User-Agent unique, honnete, avec un point de contact : exige par Discogs et poli ailleurs. */
  userAgent: str('USER_AGENT', 'scarpcrap/0.1 (+https://github.com/inle45/scarpcrap)'),
} as const;

export type Config = typeof config;

/** Problemes de configuration qui n'empechent pas de demarrer mais valent un avertissement. */
export function configWarnings(): string[] {
  const warnings: string[] = [];
  if (!config.authToken) {
    warnings.push(
      'AUTH_TOKEN est vide : le dashboard est accessible sans authentification. ' +
        'Genere un jeton avec `openssl rand -hex 32` avant toute exposition sur Internet.',
    );
  } else if (config.authToken.length < 16) {
    warnings.push('AUTH_TOKEN fait moins de 16 caracteres : trop court pour etre expose publiquement.');
  }
  if (config.ntfy.enabled && !config.ntfy.topic) {
    warnings.push('NTFY_TOPIC est vide : aucune alerte ne partira vers la montre.');
  }
  if (config.ntfy.enabled && config.ntfy.server === 'https://ntfy.sh' && config.ntfy.topic.length < 12) {
    warnings.push(
      'Sur ntfy.sh public, le nom du topic est le seul secret. Utilise un topic long et imprevisible.',
    );
  }
  return warnings;
}

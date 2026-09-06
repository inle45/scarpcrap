import type BetterSqlite3 from 'better-sqlite3';
import { createLogger } from '../logger.js';

const log = createLogger('db:migrations');

/**
 * Migrations additives, appliquees dans l'ordre et une seule fois.
 * `user_version` de SQLite sert de compteur : pas de table de suivi a gerer.
 */
const MIGRATIONS: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: '001-initial',
    sql: `
      -- Annonces brutes collectees par les connecteurs.
      CREATE TABLE listings (
        id                    TEXT PRIMARY KEY,          -- '<source>:<external_id>'
        source                TEXT NOT NULL,
        external_id           TEXT NOT NULL,
        url                   TEXT NOT NULL,
        title                 TEXT NOT NULL,
        description           TEXT NOT NULL DEFAULT '',
        price_cents           INTEGER NOT NULL,
        shipping_cents        INTEGER NOT NULL DEFAULT 0,
        currency              TEXT NOT NULL DEFAULT 'EUR',
        condition             TEXT NOT NULL DEFAULT 'unknown',
        source_category       TEXT NOT NULL DEFAULT '',
        domain                TEXT NOT NULL DEFAULT 'other',
        product_key           TEXT,
        seller_id             TEXT NOT NULL DEFAULT '',
        seller_name           TEXT NOT NULL DEFAULT '',
        seller_rating         REAL,
        seller_feedback_count INTEGER,
        seller_since          TEXT,
        image_url             TEXT,
        images_count          INTEGER NOT NULL DEFAULT 0,
        location              TEXT,
        shipping_days         INTEGER,
        raw_json              TEXT NOT NULL DEFAULT '{}',
        first_seen_at         TEXT NOT NULL,
        last_seen_at          TEXT NOT NULL,
        UNIQUE (source, external_id)
      );
      CREATE INDEX idx_listings_source     ON listings (source);
      CREATE INDEX idx_listings_domain     ON listings (domain);
      CREATE INDEX idx_listings_last_seen  ON listings (last_seen_at);

      -- Series de comparaisons de prix rattachees a une annonce.
      CREATE TABLE comps (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_id          TEXT NOT NULL REFERENCES listings (id) ON DELETE CASCADE,
        source              TEXT NOT NULL,
        kind                TEXT NOT NULL,               -- 'sold' | 'active'
        sample_size         INTEGER NOT NULL,
        price_min_cents     INTEGER NOT NULL,
        price_median_cents  INTEGER NOT NULL,
        price_max_cents     INTEGER NOT NULL,
        currency            TEXT NOT NULL DEFAULT 'EUR',
        quality             REAL NOT NULL DEFAULT 0,
        days_to_sell        INTEGER NOT NULL DEFAULT 30,
        note                TEXT NOT NULL DEFAULT '',
        created_at          TEXT NOT NULL
      );
      CREATE INDEX idx_comps_listing ON comps (listing_id);

      -- Une annonce evaluee = un deal. Une ligne par annonce.
      CREATE TABLE deals (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_id             TEXT NOT NULL UNIQUE REFERENCES listings (id) ON DELETE CASCADE,
        buy_total_cents        INTEGER NOT NULL,
        resale_estimate_cents  INTEGER NOT NULL,
        resale_max_cents       INTEGER NOT NULL,
        resale_marketplace     TEXT NOT NULL DEFAULT '',
        fees_total_cents       INTEGER NOT NULL,
        net_profit_cents       INTEGER NOT NULL,
        roi_pct                REAL NOT NULL,
        days_to_receive        INTEGER NOT NULL,
        days_to_sell           INTEGER NOT NULL,
        total_days             INTEGER NOT NULL,
        roi_per_day_cents      INTEGER NOT NULL,
        trust_score            INTEGER NOT NULL,
        trust_json             TEXT NOT NULL DEFAULT '{}',
        comp_quality           REAL NOT NULL DEFAULT 0,
        economics_json         TEXT NOT NULL DEFAULT '{}',
        -- Ecart entre la marge de ce deal et la marge normale de sa categorie,
        -- en points de pourcentage. Positif = meilleur que la normale.
        category_index_delta   REAL,
        status                 TEXT NOT NULL DEFAULT 'new',
        alerted_at             TEXT,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL
      );
      CREATE INDEX idx_deals_status      ON deals (status);
      CREATE INDEX idx_deals_roi_per_day ON deals (roi_per_day_cents DESC);
      CREATE INDEX idx_deals_created     ON deals (created_at DESC);

      -- Journal des decisions, pour l'historique du dashboard.
      CREATE TABLE decisions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        deal_id    INTEGER NOT NULL REFERENCES deals (id) ON DELETE CASCADE,
        action     TEXT NOT NULL,                        -- 'bought' | 'skipped' | 'sold' | 'reset'
        note       TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_decisions_deal    ON decisions (deal_id);
      CREATE INDEX idx_decisions_created ON decisions (created_at DESC);

      -- Suivi du capital reel : saisie manuelle une fois l'article vendu.
      CREATE TABLE capital (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        deal_id           INTEGER NOT NULL UNIQUE REFERENCES deals (id) ON DELETE CASCADE,
        bought_price_cents INTEGER NOT NULL,
        bought_at         TEXT NOT NULL,
        sold_price_cents  INTEGER,
        sold_fees_cents   INTEGER NOT NULL DEFAULT 0,
        sold_at           TEXT,
        note              TEXT NOT NULL DEFAULT ''
      );

      -- Indice de revente par categorie : marge moyenne observee par domaine.
      CREATE TABLE category_stats (
        domain            TEXT PRIMARY KEY,
        sample_size       INTEGER NOT NULL DEFAULT 0,
        avg_margin_pct    REAL NOT NULL DEFAULT 0,
        median_margin_pct REAL NOT NULL DEFAULT 0,
        avg_days_to_sell  REAL NOT NULL DEFAULT 0,
        updated_at        TEXT NOT NULL
      );

      -- Historique des cycles de collecte.
      CREATE TABLE runs (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at     TEXT NOT NULL,
        finished_at    TEXT,
        status         TEXT NOT NULL DEFAULT 'running',  -- 'running' | 'ok' | 'partial' | 'failed'
        trigger        TEXT NOT NULL DEFAULT 'cron',     -- 'cron' | 'manual' | 'boot'
        listings_found INTEGER NOT NULL DEFAULT 0,
        deals_created  INTEGER NOT NULL DEFAULT 0,
        alerts_sent    INTEGER NOT NULL DEFAULT 0,
        sources_json   TEXT NOT NULL DEFAULT '[]',
        errors_json    TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX idx_runs_started ON runs (started_at DESC);

      -- Reglages modifiables a chaud depuis le dashboard.
      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
];

export function migrate(db: BetterSqlite3.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current >= MIGRATIONS.length) return;

  for (let i = current; i < MIGRATIONS.length; i += 1) {
    const migration = MIGRATIONS[i]!;
    log.info('application de la migration', { name: migration.name });
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.pragma(`user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  log.info('migrations a jour', { version: MIGRATIONS.length });
}

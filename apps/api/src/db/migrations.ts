/**
 * Migrations de schéma.
 *
 * Règles :
 *  - une migration publiée n'est JAMAIS modifiée : on en ajoute une nouvelle ;
 *  - chaque version s'applique dans une transaction (voir `Db.migrate`) ;
 *  - toutes les dates sont stockées en texte ISO (`YYYY-MM-DD` pour les dates
 *    métier, ISO complet pour les horodatages techniques) : c'est lisible,
 *    trié correctement en SQL et sans ambiguïté de fuseau.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

const CORE_V1 = `
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  csrf_token   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Secrets des connecteurs : chiffrés AES-256-GCM. Aucune colonne en clair.
CREATE TABLE secrets (
  name       TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv         TEXT NOT NULL,
  tag        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE connections (
  id                   TEXT PRIMARY KEY,
  provider_id          TEXT NOT NULL,
  label                TEXT NOT NULL,
  config_json          TEXT NOT NULL DEFAULT '{}',
  secret_refs_json     TEXT NOT NULL DEFAULT '[]',
  status               TEXT NOT NULL DEFAULT 'DISCONNECTED',
  last_synced_at       TEXT,
  last_error           TEXT,
  requires_user_action INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE accounts (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  type                TEXT NOT NULL CHECK (type IN ('SECURITIES','CASH','CRYPTO','REAL_ESTATE','LIABILITY','OTHER')),
  provider_id         TEXT NOT NULL,
  connection_id       TEXT REFERENCES connections(id) ON DELETE SET NULL,
  currency            TEXT NOT NULL,
  initial_balance     REAL NOT NULL DEFAULT 0,
  is_active           INTEGER NOT NULL DEFAULT 1,
  external_account_id TEXT,
  notes               TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_accounts_provider ON accounts(provider_id);
CREATE UNIQUE INDEX idx_accounts_external ON accounts(provider_id, external_account_id)
  WHERE external_account_id IS NOT NULL;

CREATE TABLE instruments (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('EQUITY','ETF','FUND','BOND','CRYPTO','CASH','REAL_ESTATE','OTHER')),
  symbol           TEXT,
  isin             TEXT,
  name             TEXT NOT NULL,
  currency         TEXT NOT NULL,
  exchange         TEXT,
  chain            TEXT,
  contract_address TEXT,
  decimals         INTEGER,
  country          TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_instruments_isin ON instruments(isin) WHERE isin IS NOT NULL;
CREATE UNIQUE INDEX idx_instruments_contract ON instruments(chain, contract_address)
  WHERE contract_address IS NOT NULL;
CREATE INDEX idx_instruments_symbol ON instruments(symbol);

CREATE TABLE activities (
  id                       TEXT PRIMARY KEY,
  account_id               TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  instrument_id            TEXT REFERENCES instruments(id) ON DELETE SET NULL,
  type                     TEXT NOT NULL,
  date                     TEXT NOT NULL,
  quantity                 REAL,
  unit_price               REAL,
  amount                   REAL NOT NULL,
  currency                 TEXT NOT NULL,
  fees                     REAL NOT NULL DEFAULT 0,
  taxes                    REAL NOT NULL DEFAULT 0,
  fx_rate_to_base          REAL,
  description              TEXT,
  provider_id              TEXT NOT NULL,
  external_account_id      TEXT,
  external_transaction_id  TEXT,
  external_asset_id        TEXT,
  raw_source_type          TEXT,
  last_synced_at           TEXT NOT NULL,
  dedup_hash               TEXT NOT NULL,
  sync_run_id              TEXT,
  import_id                TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
-- Idempotence garantie par la base : un identifiant externe ne peut pas être
-- inséré deux fois pour un même couple (fournisseur, compte).
CREATE UNIQUE INDEX idx_activities_external
  ON activities(provider_id, external_account_id, external_transaction_id)
  WHERE external_transaction_id IS NOT NULL;
-- Repli pour les sources sans identifiant (exports CSV, transferts on-chain).
CREATE UNIQUE INDEX idx_activities_dedup
  ON activities(dedup_hash)
  WHERE external_transaction_id IS NULL;
CREATE INDEX idx_activities_account_date ON activities(account_id, date);
CREATE INDEX idx_activities_date ON activities(date);
CREATE INDEX idx_activities_type ON activities(type);
CREATE INDEX idx_activities_instrument ON activities(instrument_id);

CREATE TABLE valuations (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  instrument_id TEXT REFERENCES instruments(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  value         REAL NOT NULL,
  currency      TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('MARKET','MANUAL','APPRAISAL','CONNECTOR')),
  note          TEXT,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_valuations_unique ON valuations(account_id, COALESCE(instrument_id,''), date);

CREATE TABLE quotes (
  instrument_id TEXT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  close         REAL NOT NULL,
  currency      TEXT NOT NULL,
  provider      TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  PRIMARY KEY (instrument_id, date)
);

CREATE TABLE fx_rates (
  base   TEXT NOT NULL,
  quote  TEXT NOT NULL,
  date   TEXT NOT NULL,
  rate   REAL NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (base, quote, date, source)
);

CREATE TABLE net_worth_snapshots (
  date              TEXT PRIMARY KEY,
  total             REAL NOT NULL,
  by_class_json     TEXT NOT NULL,
  by_provider_json  TEXT NOT NULL,
  currency          TEXT NOT NULL,
  computed_at       TEXT NOT NULL
);

CREATE TABLE sync_runs (
  sync_run_id  TEXT PRIMARY KEY,
  connection_id TEXT,
  provider_id  TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('MANUAL','SCHEDULED','IMPORT')),
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCESS','PARTIAL','FAILED','AUTH_REQUIRED')),
  created      INTEGER NOT NULL DEFAULT 0,
  updated      INTEGER NOT NULL DEFAULT 0,
  skipped      INTEGER NOT NULL DEFAULT 0,
  errors       INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER,
  message      TEXT,
  details_json TEXT
);
CREATE INDEX idx_sync_runs_connection ON sync_runs(connection_id, started_at);

CREATE TABLE imports (
  import_id     TEXT PRIMARY KEY,
  filename      TEXT NOT NULL,
  format_id     TEXT,
  account_id    TEXT,
  connection_id TEXT,
  imported_at   TEXT NOT NULL,
  created       INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  details_json  TEXT
);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  details_json TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at);
`;

const REAL_ESTATE_V2 = `
CREATE TABLE properties (
  account_id        TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL,
  address           TEXT,
  purchase_date     TEXT,
  purchase_price    REAL NOT NULL DEFAULT 0,
  notary_fees       REAL NOT NULL DEFAULT 0,
  agency_fees       REAL NOT NULL DEFAULT 0,
  initial_works     REAL NOT NULL DEFAULT 0,
  surface_m2        REAL,
  current_value     REAL NOT NULL DEFAULT 0,
  notes             TEXT,
  updated_at        TEXT NOT NULL
);

CREATE TABLE property_loans (
  account_id         TEXT PRIMARY KEY REFERENCES properties(account_id) ON DELETE CASCADE,
  loan_type          TEXT NOT NULL CHECK (loan_type IN ('AMORTIZABLE','IN_FINE','VARIABLE','OTHER')),
  principal          REAL NOT NULL,
  remaining_principal REAL NOT NULL DEFAULT 0,
  annual_rate        REAL NOT NULL,
  months             INTEGER NOT NULL,
  start_date         TEXT NOT NULL,
  monthly_payment    REAL NOT NULL DEFAULT 0,
  insurance_monthly  REAL NOT NULL DEFAULT 0,
  interest_paid      REAL NOT NULL DEFAULT 0,
  principal_repaid   REAL NOT NULL DEFAULT 0
);

CREATE TABLE property_appraisals (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES properties(account_id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  value      REAL NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_appraisals_account ON property_appraisals(account_id, date);

CREATE TABLE property_cash_flows (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES properties(account_id) ON DELETE CASCADE,
  direction  TEXT NOT NULL CHECK (direction IN ('INCOME','EXPENSE')),
  category   TEXT NOT NULL,
  label      TEXT NOT NULL,
  amount     REAL NOT NULL,
  currency   TEXT NOT NULL,
  date       TEXT NOT NULL,
  recurrence TEXT NOT NULL CHECK (recurrence IN ('ONE_OFF','MONTHLY','QUARTERLY','YEARLY')),
  received   INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_cash_flows_account ON property_cash_flows(account_id, date);
`;

const INDEXES_V3 = `
-- Timeline globale : le tri par date décroissante est la requête la plus fréquente.
CREATE INDEX idx_activities_date_desc ON activities(date DESC, id DESC);
CREATE INDEX idx_activities_provider ON activities(provider_id, date);
CREATE INDEX idx_activities_import ON activities(import_id);
CREATE INDEX idx_activities_sync_run ON activities(sync_run_id);
-- Recherche plein-texte simple sur la description (LIKE '%x%' reste acceptable
-- à l'échelle d'un patrimoine personnel, mais l'index accélère le préfiltrage).
CREATE INDEX idx_activities_description ON activities(description);
CREATE INDEX idx_quotes_instrument_date ON quotes(instrument_id, date DESC);
CREATE INDEX idx_fx_pair_date ON fx_rates(base, quote, date DESC);
CREATE INDEX idx_valuations_account_date ON valuations(account_id, date DESC);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'core', statements: [CORE_V1] },
  { version: 2, name: 'real_estate', statements: [REAL_ESTATE_V2] },
  { version: 3, name: 'indexes', statements: [INDEXES_V3] },
];
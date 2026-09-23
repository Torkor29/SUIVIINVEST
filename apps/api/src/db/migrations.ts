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

/**
 * Mission 2 — synchronisation réelle des sources.
 *
 *  - `net_worth_snapshots` gagne les dettes, le détail par compte et l'ORIGINE de
 *    la donnée : `RECORDED` (relevé enregistré par l'application) ou
 *    `RECONSTRUCTED` (reconstruit depuis les activités). L'interface doit pouvoir
 *    distinguer les deux, on ne présente jamais un historique reconstruit comme
 *    une observation réelle.
 *  - `net_worth_snapshot_accounts` conserve le détail par compte et par classe.
 *  - `sync_runs.error_code` permet d'afficher un message compréhensible sans
 *    exposer l'erreur technique (voir `ConnectorError.kind`).
 *  - `chain_sync_state` mémorise la progression par (connexion, chaîne) : c'est
 *    ce qui rend la reprise après erreur possible sans re-parcourir tout l'historique.
 */
const MISSION2_V4 = `
ALTER TABLE net_worth_snapshots ADD COLUMN liabilities REAL NOT NULL DEFAULT 0;
ALTER TABLE net_worth_snapshots ADD COLUMN by_account_json TEXT;
ALTER TABLE net_worth_snapshots ADD COLUMN source TEXT NOT NULL DEFAULT 'RECORDED';
ALTER TABLE net_worth_snapshots ADD COLUMN positions_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sync_runs ADD COLUMN error_code TEXT;

CREATE TABLE net_worth_snapshot_accounts (
  snapshot_date  TEXT NOT NULL,
  account_id     TEXT NOT NULL,
  provider_id    TEXT NOT NULL,
  asset_class    TEXT NOT NULL,
  currency       TEXT NOT NULL,
  value_original REAL NOT NULL,
  value_base     REAL NOT NULL,
  PRIMARY KEY (snapshot_date, account_id)
);
CREATE INDEX idx_snapshot_accounts_date ON net_worth_snapshot_accounts(snapshot_date);
CREATE INDEX idx_snapshot_accounts_provider ON net_worth_snapshot_accounts(provider_id, snapshot_date);

CREATE TABLE chain_sync_state (
  connection_id TEXT NOT NULL,
  chain         TEXT NOT NULL,
  address       TEXT NOT NULL,
  last_block    INTEGER,
  last_synced_at TEXT,
  cursor        TEXT,
  PRIMARY KEY (connection_id, chain, address)
);
`;

/**
 * Mission 2 (suite) — quantités des positions collectées.
 *
 * `valuations` ne stockait qu'une valeur totale : la quantité et le prix
 * unitaire communiqués par le connecteur étaient perdus, ce qui empêchait
 * d'afficher un portefeuille crypto (jeton, quantité, prix) et obligeait à
 * rejouer les transactions pour deviner les positions — impossible pour un
 * transfert natif, qui n'a pas d'adresse de contrat.
 *
 * Les deux colonnes sont NULLABLES : les valorisations manuelles et les soldes
 * de trésorerie gardent exactement leur comportement d'avant.
 */
const POSITION_QUANTITIES_V5 = `
ALTER TABLE valuations ADD COLUMN quantity REAL;
ALTER TABLE valuations ADD COLUMN unit_price REAL;
`;

/**
 * Mission 3 — comptes multiples et récupération d'accès.
 *
 * Avant cette migration, l'application n'avait qu'UN compte sans identifiant :
 * impossible d'en créer un second, et un mot de passe oublié était définitif
 * (aucun chemin de récupération). Les colonnes ajoutées sont NULLABLES pour que
 * les installations existantes continuent de fonctionner à l'identique : un
 * compte sans `username` se connecte au mot de passe seul, comme avant.
 *
 * `recovery_hash` ne contient QUE l'empreinte SHA-256 du code de récupération,
 * jamais le code lui-même : même avec la base sous les yeux, on ne peut pas
 * reconstituer un accès.
 */
const ACCOUNTS_V6 = `
ALTER TABLE users ADD COLUMN username TEXT;
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'MEMBER';
ALTER TABLE users ADD COLUMN recovery_hash TEXT;
ALTER TABLE users ADD COLUMN created_by TEXT;
ALTER TABLE users ADD COLUMN last_login_at TEXT;
ALTER TABLE users ADD COLUMN password_changed_at TEXT;
ALTER TABLE users ADD COLUMN disabled_at TEXT;

CREATE UNIQUE INDEX idx_users_username ON users(LOWER(username)) WHERE username IS NOT NULL;
`;

/**
 * Version 7 — vrai compte : e-mail chiffré, liens de réinitialisation.
 *
 * L'adresse e-mail n'est JAMAIS stockée en clair :
 *  - `email_ciphertext` : AES-256-GCM (clé dérivée de la clé maîtresse, qui n'est
 *    pas en base) — sert à l'afficher au titulaire et à lui écrire ;
 *  - `email_index` : HMAC-SHA256 de l'adresse normalisée (« index aveugle ») —
 *    sert à retrouver un compte par e-mail sans pouvoir remonter à l'adresse.
 *
 * Les jetons de réinitialisation ne sont stockés qu'en SHA-256, sont à usage
 * unique et expirent vite : même avec la base sous les yeux, on ne peut pas s'en
 * servir.
 */
const ACCOUNT_EMAIL_V7 = `
ALTER TABLE users ADD COLUMN email_ciphertext TEXT;
ALTER TABLE users ADD COLUMN email_index TEXT;
CREATE UNIQUE INDEX idx_users_email_index ON users(email_index) WHERE email_index IS NOT NULL;

CREATE TABLE password_resets (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'core', statements: [CORE_V1] },
  { version: 2, name: 'real_estate', statements: [REAL_ESTATE_V2] },
  { version: 3, name: 'indexes', statements: [INDEXES_V3] },
  { version: 4, name: 'mission2_sync_state_and_snapshots', statements: [MISSION2_V4] },
  { version: 5, name: 'position_quantities', statements: [POSITION_QUANTITIES_V5] },
  { version: 6, name: 'accounts_and_recovery', statements: [ACCOUNTS_V6] },
  { version: 7, name: 'account_email_and_resets', statements: [ACCOUNT_EMAIL_V7] },
];
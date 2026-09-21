# Wealthfolio — verified technical audit

Repo: `/opt/data/work/wealthfolio`, commit `57ed695d07628d79c03eee3ede040cfc6ddcfb99` ("fix(insights): refine widget grips and align highlight cards", Sun Sep 20 2026). Workspace version `3.9.0` (`Cargo.toml` `[workspace.package] version`, `package.json` `version`).

Everything below was read from the files cited. Where a search found nothing, that is stated in §11 rather than guessed.

---

## 1. Top-level layout and build/runtime story

### 1.1 Rust workspace

`Cargo.toml` (root) declares `resolver = "2"`, members `apps/tauri`, `apps/server`, `crates/*`, and workspace lints `unsafe_code = "forbid"`, `clippy::all = "warn"`. Rust toolchain pinned in `rust-toolchain.toml`. Key shared deps: `diesel 2.2` (sqlite, chrono, r2d2, numeric), `diesel_migrations`, `rusqlite 0.40`, `libsqlite3-sys 0.38` built with `bundled-sqlcipher-vendored-openssl` — i.e. **SQLCipher is always compiled in**; with no key applied it behaves as plain SQLite (comment in root `Cargo.toml`). `rust_decimal` with `serde-float`, `uuid` v4+v7, `reqwest 0.13` (rustls), `rmcp 1.7` for MCP.

Ten crates under `crates/`:

| crate | role |
|---|---|
| `wealthfolio-core` | domain models + services (accounts, activities, assets, portfolio, quotes, fx, goals, taxonomies, limits, health, addons, secrets, sync) |
| `wealthfolio-storage-sqlite` | Diesel repositories, migrations, generated `schema.rs` |
| `wealthfolio-market-data` | providers, registry, symbol/instrument resolver |
| `wealthfolio-spending` | spending/budget domain on top of taxonomies |
| `wealthfolio-connect` | Wealthfolio Connect cloud client, broker sync, token lifecycle |
| `wealthfolio-device-sync` | E2EE device sync engine |
| `wealthfolio-ai` | AI chat/providers |
| `wealthfolio-agent-tools` | tool catalog exposed to agents/MCP |
| `wealthfolio-mcp` | MCP server surface |
| `wealthfolio-http` | shared HTTP client plumbing |

### 1.2 Apps

- `apps/server` — Axum 0.8 web server (`axum`, `tower-http`, `openidconnect 4`, `jsonwebtoken`, `argon2`, `tower_governor`). API modules registered in `apps/server/src/api.rs`: `accounts, activities, addon_network, addons, agent_access, ai_chat, ai_providers, allocation_targets, alternative_assets, assets, connect (feature `connect-sync`), custom_providers, data_exports, database_backups, device_sync (feature `device-sync`), device_sync_engine, exchange_rates, goals, health, holdings, limits, market_data, net_worth, performance, portable_backups, portfolio, portfolios, secrets, settings, shared, spending, sync_crypto, taxonomies`. Cargo features: `default = ["connect-sync", "device-sync"]`. Routes are versioned under `/api/v1` (`healthz`, `readyz`, accounts CRUD, …), served by `apps/server/src/main_lib.rs` (constructs every core service, `AppState`), static frontend served by `apps/server/src/static_files.rs` (`ServeDir` + SPA fallback, reserved prefixes `/assets /__generated__ /api /mcp` never fall back to `index.html`).
- `apps/frontend` — React + Vite + Tailwind 4 + React Router, Vitest for unit tests. `apps/frontend/vite.config.ts` selects the adapter layer at build time from `BUILD_TARGET` (`"tauri"` default, `"web"` for browser): aliases `@/adapters` → `src/adapters/tauri` or `src/adapters/web`, `#platform` → the matching `core` module, and `define: { __BUILD_TARGET__ }`. Web build is `pnpm --filter frontend build` → `tsc && BUILD_TARGET=web pnpm build:addon-sandbox-runtime && BUILD_TARGET=web vite build && node scripts/verify-addon-sandbox-runtime.mjs --dist --web` (`apps/frontend/package.json`).
- `apps/tauri` — `wealthfolio-app`: Tauri 2.11 desktop/mobile shell, commands in `apps/tauri/src/commands/` (`account, activity, addon, addon_network, ai_chat, broker(s)_sync, device_sync, market_data, mcp, portfolio, providers_settings, secrets, settings, spending, taxonomy, wealthfolio_connect, …`), registered in `apps/tauri/src/lib.rs`; native secret store in `apps/tauri/src/secret_store.rs` (`keyring-core`, `chacha20poly1305`).
- `packages/` — `addon-sdk` (published `@wealthfolio/addon-sdk`), `addon-dev-tools` (scaffold CLI + dev server + templates), `ui` (shared React components). pnpm workspaces: `apps/frontend`, `packages/*`; pnpm `10.33.4`, Node 24 (`.node-version`).

### 1.3 Web / self-hosted build

`Dockerfile` (multi-stage, `rust:1.95-alpine` + `tonistiigi/xx` cross-compile):

1. stage `frontend`: `node:24-alpine`, `ENV CI=1`, `BUILD_TARGET=web`, `pnpm install --frozen-lockfile`, `pnpm --filter frontend... build`, `mv dist /web-dist`. Build args `CONNECT_AUTH_URL`, `CONNECT_AUTH_PUBLISHABLE_KEY` are baked into the JS bundle at build time.
2. stage `backend`: build args `CONNECT_AUTH_URL`, `CONNECT_AUTH_PUBLISHABLE_KEY`; `apps/tauri` is stubbed (`fn main(){}`) so the workspace resolves; builds only `apps/server/Cargo.toml` (`xx-cargo build --locked --release`) → `/wealthfolio-server`.
3. final `alpine:3.19`: binary at `/usr/local/bin/wealthfolio-server`, frontend at `/app/dist`, `ENV WF_DB_PATH=/data/wealthfolio.db`, `ARG/ENV CONNECT_API_URL`, non-root user 1000, `VOLUME ["/data"]`, `EXPOSE 8088`, `CMD ["/usr/local/bin/wealthfolio-server"]`.

`compose.yml` (production): service `wealthfolio`, image `wealthfolio/wealthfolio:latest`, port `${WF_PORT:-8088}:8088`, named volume `wealthfolio-data:/data`, healthcheck `wget --spider http://127.0.0.1:8088/api/v1/healthz`, `read_only: true`, `no-new-privileges`, 512M memory limit. Overlays: `compose.dev.yml` (build from source, `WF_AUTH_REQUIRED=false`, CORS `localhost:1420,localhost:3000`, hardening relaxed) and `compose.proxy.yml` (unpublish port; proxy routes to `http://wealthfolio:8088`).

Env vars actually read by the server (`apps/server/src/config.rs`) and documented in `.env.web.example` / `compose.yml`:

- Core: `WF_LISTEN_ADDR` (default `0.0.0.0:8088`), `WF_DB_PATH` (default `./db/app.db`), `WF_STATIC_DIR` (`dist`), `WF_ADDONS_DIR` (default under app data dir), `WF_REQUEST_TIMEOUT_MS` (30000), `WF_CORS_ALLOW_ORIGINS` (`*` default; cannot be `*` when auth is enabled).
- Secrets: `WF_SECRET_KEY` **or** `WF_SECRET_KEY_FILE` (exactly one; 32-byte base64 or 32 ASCII chars) — used for secrets at rest **and** JWT signing. `WF_DB_REQUIRE_ENCRYPTION`.
- Auth: `WF_AUTH_PASSWORD_HASH` (Argon2id PHC), `WF_AUTH_REQUIRED`, `WF_AUTH_TOKEN_TTL_MINUTES` (60), `WF_COOKIE_SECURE` (`auto`).
- OIDC: `WF_OIDC_ISSUER_URL`, `WF_OIDC_CLIENT_ID`, `WF_OIDC_CLIENT_SECRET`, `WF_OIDC_REDIRECT_URL`, `WF_OIDC_SCOPES`, `WF_OIDC_ALLOWED_EMAILS`, `WF_OIDC_ALLOWED_SUBS`, `WF_OIDC_ALLOW_ANY`, `WF_OIDC_POST_LOGOUT_REDIRECT_URL`, `WF_OIDC_RP_LOGOUT`.
- Agent/MCP: `WF_MCP_ENABLED` (false), `WF_MCP_AUDIT_ENABLED` (true), `WF_MCP_ALLOWED_HOSTS`; server refuses to start if MCP is enabled on a non-loopback bind without authentication.
- Desktop/dev only: `WF_DATA_DIR`, `DATABASE_URL` (`.env.example`), `CONNECT_AUTH_URL`, `CONNECT_AUTH_PUBLISHABLE_KEY`, `CONNECT_API_URL`, `CONNECT_OAUTH_CALLBACK_URL`.

Web dev: `pnpm dev:web` → `scripts/dev-web.mjs` loads `.env.web`, sets `BUILD_TARGET=web`, and runs Vite (`VITE_DEV_PORT`, default 1420) plus the server; `WF_ENABLE_VITE_PROXY=true` proxies `/api` and `/docs` to `VITE_API_TARGET`/`WF_API_TARGET` (default `http://127.0.0.1:8088`).

---

## 2. SQLite data model

`crates/storage-sqlite/migrations/` holds 51 directories (102 `.sql` files: `up.sql`/`down.sql` each), applied by `diesel_migrations`; `crates/storage-sqlite/src/schema.rs` is the hand-maintained Diesel schema and lists exactly the same 56 tables in their final shape (verified by diff — no drift).

**Final table count: 56.** Tables created and later dropped are listed at the end of this section.

### 2.1 Chronological migration ledger (what each migration did)

| migration | effect |
|---|---|
| `2023-11-08-162221_init_db` | creates `platforms`, `accounts`, `assets`, `activities`, `quotes`, `settings`, `goals`, `goals_allocation`; indexes `assets_data_source_symbol_key` (unique on `data_source,symbol`), `market_data_data_source_date_symbol_key`. |
| `2024-09-16-023604_portfolio_history` | creates `portfolio_history` (per-account daily: `total_value, market_value, book_cost, available_cash, net_deposit, total_gain_*, day_gain_*, allocation_percentage, exchange_rate, holdings JSON`, unique `(account_id,date)`); retypes `goals.target_amount`/`is_achieved` to NUMERIC/BOOLEAN; creates `exchange_rates` (`from_currency,to_currency,rate,source`, unique pair). |
| `2024-09-21-023605_settings_to_kv` | drops `settings`, creates `app_settings(setting_key PK, setting_value)` and migrates `theme`, `font`, `base_currency`. |
| `2024-09-22-012202_init_exchange_rates` | seeds MANUAL `exchange_rates` rows for account/activity/base-currency pairs, ids like `<FROM><TO>=X`. |
| `2024-09-28-225756_add_calculated_at` | adds `portfolio_history.calculated_at`; index `activities(account_id)`. |
| `2024-10-08-193300_contrib_limits` | creates `contribution_limits`; inserts `app_settings.instance_id`. |
| `2024-10-15-173026_csv_import_profiles` | creates `activity_import_profiles` (`field_mappings`, `activity_mappings`, `symbol_mappings` JSON). |
| `2025-01-27-000001_migrate_fx_to_quotes` | **FX becomes assets**: rewrites/inserts `assets` rows for currency pairs (`asset_type='FOREX'`, symbol `XXXYYY=X`), copies rates into `quotes`, **drops `exchange_rates`**; uppercase asset types; adds indexes `quotes(symbol,date)`, `quotes(date)`, `assets(asset_type)`. |
| `2025-03-17-185736_…contribution_limits` | adds `contribution_limits.start_date`, `end_date`. |
| `2025-03-18-222805_add_amount_field_and_use_decimal` | adds `activities.amount`; moves cash-only amounts from `unit_price*quantity` → `amount`; renames `TRANSFER_IN/OUT` non-cash rows to `ADD_HOLDING`/`REMOVE_HOLDING`; renames `CONVERSION_IN/OUT` → `TRANSFER_IN/OUT`; renames `assets.comment` → `notes`; rebuilds `activities` and `quotes` with **TEXT-stored decimals** (BigDecimal-as-string) and RFC3339 timestamps; `quotes` gains `currency`. |
| `2025-04-21-195716_create_daily_account_history` | **drops `portfolio_history`**; creates `holdings_snapshots` (JSON `positions`, `cash_balances`, `cost_basis`, `net_contribution`, `calculated_at`) and `daily_account_valuation` (per account/day: `account_currency, base_currency, fx_rate_to_base, cash_balance, investment_market_value, total_value, cost_basis, net_contribution`) + indexes. |
| `2025-06-09-150456_add_net_contribution_base_to_snapshots` | `holdings_snapshots.net_contribution_base`; deletes all `quotes`, `holdings_snapshots`, `daily_account_valuation` (forced recalculation); adds `daily_account_valuation` indexes. |
| `2025-06-11-133126_account_import_mapping` | `activity_import_profiles.account_mappings`. |
| `2025-06-27-145729_create_market_data_providers_table` | creates `market_data_providers`; seeds `YAHOO` (priority 1, enabled), `MARKETDATA_APP` (2), `ALPHA_VANTAGE` (3). |
| `2026-01-01-000000_refactor_asset_model` | **core schema v2** (single atomic migration): rebuilds `assets` with UUID ids, `kind` CHECK (`INVESTMENT, PROPERTY, VEHICLE, COLLECTIBLE, PRECIOUS_METAL, PRIVATE_EQUITY, LIABILITY, OTHER, FX`), `quote_mode` CHECK (`MARKET|MANUAL`), `instrument_type/symbol/exchange_mic` and a **generated STORED `instrument_key`** (`TYPE:SYMBOL@MIC`, or `TYPE:SYMBOL/CCY` for FX/CRYPTO); dedupes by `instrument_key`; rebuilds `activities` with the closed 14-value `activity_type` CHECK, `status`, `activity_type_override`, `source_*`, `idempotency_key`, `import_run_id`, `is_user_modified`, `needs_review`; creates `import_runs` and `brokers_sync_state`; extends `platforms` (`external_id, kind, website_url, logo_url`) and `accounts` (`account_number, meta, provider, provider_account_id`); adds `holdings_snapshots.cash_total_account_currency`, `cash_total_base_currency`. |
| `2026-01-01-000001_quotes_market_data` | rebuilds `quotes` (`symbol`→`asset_id`, `data_source`→`source`, adds `day`, `notes`; unique `(asset_id,day,source)`, id = `{asset_id}_{day}_{source}`); creates `quote_sync_state`; adds `FINNHUB` provider. |
| `2026-01-01-000002_taxonomies` | creates `taxonomies`, `taxonomy_categories` (hierarchical, composite PK `(taxonomy_id,id)`), `asset_taxonomy_assignments` (weight 0–10000 bps) + ~1.3k lines of seeded default taxonomies. |
| `2026-01-15-000001_ai_chat_persistence` | `ai_threads`, `ai_messages` (role CHECK user/assistant/system/tool, `content_json`), `ai_thread_tags`. |
| `2026-01-20-000001_health_issue_dismissals` | `health_issue_dismissals(issue_id, dismissed_at, data_hash)`. |
| `2026-01-24-000001_improve_import_profiles` | collapses `activity_import_profiles` to `(account_id, name, config JSON)`; `parseConfig` becomes a config key. |
| `2026-01-26-000001_tracking_mode` | `accounts.tracking_mode` (`NOT_SET`→backfill `TRANSACTIONS`), `accounts.is_archived`, `holdings_snapshots.source` (default `CALCULATED`). |
| `2026-02-12-000001_device_sync_foundation` | device-sync tables: `sync_cursor`, `sync_outbox`, `sync_entity_metadata`, `sync_device_config`, `sync_engine_state`, `sync_table_state` (seeded enabled tables), `sync_applied_events`. |
| `2026-03-03-000001_add_phase2_providers` | providers `US_TREASURY_CALC`, `BOERSE_FRANKFURT`, `OPENFIGI`, `METAL_PRICE_API`. |
| `2026-03-09-000001_fix_provider_logos` | backfills `logo_filename`. |
| `2026-03-10-000001_sync_freshness_gate` | `sync_device_config.min_snapshot_created_at`. |
| `2026-03-18-000001_remove_income_fallback_quotes` | deletes `source='BROKER'` quotes derived from DIVIDEND/INTEREST/FEE/TAX/CREDIT activities. |
| `2026-03-19-000001_import_templates` | creates `import_templates` (kind `CSV_ACTIVITY`/`CSV_HOLDINGS`/`BROKER_ACTIVITY`, scope SYSTEM/USER, `config` JSON, `config_version`), seeds Schwab / TD WebBroker / Trading 212 / Wealthsimple templates, creates `import_account_templates`, migrates profiles, **drops `activity_import_profiles`**; index `activities(source_system, account_id, source_record_id)`. |
| `2026-03-25-000001_custom_provider_sources` | `market_data_providers.provider_type` + `config`; seeds `CUSTOM_SCRAPER`; creates `market_data_custom_providers`. |
| `2026-03-30-000001_goals_and_retirement_planning` | extends `goals` (`goal_type, status_lifecycle CHECK active/achieved/archived, status_health, priority, cover_image_key, currency, start_date, target_date, summary_current_value, summary_progress, projected_completion_date, projected_value_at_target_date, summary_target_amount, created_at, updated_at`), drops `is_achieved`; creates `goal_plans`; rebuilds `goals_allocation` share-based (`share_percent` 0–100, `tax_bucket`). |
| `2026-04-29-000001_sync_entity_metadata_last_op` | `sync_entity_metadata.last_op` (+ backfill, tombstones per entity). |
| `2026-05-11-000001_portfolios` | `portfolios`, `portfolio_accounts` (unique name case-insensitive; unique `(portfolio_id,account_id)`). |
| `2026-05-19-000001_lots_and_snapshot_positions` | creates `lots` (tax-lot inventory) and `snapshot_positions` (relational sibling of the `positions` JSON); normalizes HOLDINGS-mode `CALCULATED` snapshots to `MANUAL_ENTRY`; clears derived snapshots/valuations. |
| `2026-05-22-000001_scoped_lots_valuation` | drops/recreates `daily_account_valuation` with `*_base` columns plus `external_inflow_base`, `external_outflow_base`, `performance_eligible_value_base`. |
| `2026-05-25-000001_spending_module` | adds `taxonomies.scope` (`asset|activity`) and `taxonomy_categories.icon`; normalizes legacy `accounts.account_type` (only `SECURITIES, CASH, CREDIT_CARD, CRYPTOCURRENCY` survive); creates `activity_taxonomy_assignments`, `spending_event_types`, `spending_events`, `spending_activity_events`, `spending_categorization_rules`, `spending_preset_rule_deletions`, `budget_groups`, `budget_group_assignments`, `budget_targets`, `budget_rollover_settings`; seeds 6 budget groups, `spending_categories`/`income_sources`/`savings_categories` taxonomies with a full category tree, 7 event types, and `app_settings('spending.enabled','true')`. |
| `2026-05-25-000002_allocation_targets` | `allocation_targets`, `allocation_target_weights` (bps, taxonomy consistency enforced by 3 triggers). |
| `2026-05-26-000001_lot_disposals` | adds base/currency/method columns to `lots`; `daily_account_valuation.external_flow_source`; creates `lot_disposals`; indexes on `activities(source_group_id)` and transfer scope; clears derived read models. |
| `2026-06-21-000001_valuation_quality` | `daily_account_valuation.value_status` (`COMPLETE` default) and `basis_status` (`NOT_APPLICABLE`); deletes `SYNTHETIC` snapshots. |
| `2026-06-22-000001_hybrid_drift_bands` | `allocation_targets.band_type` (`absolute|hybrid`), `relative_factor_bps`. |
| `2026-06-25-000001_allocation_constraints` | `allocation_targets.max_turnover_bps`; creates `allocation_target_constraints`. |
| `2026-06-26-000001_agent_access` | `personal_access_tokens` (token hash, scopes, expiry) and `mcp_audit_log` — both explicitly local-only, not device-synced. |
| `2026-06-28-000001_spending_activity_splits` | `spending_activity_splits` (per-activity split amounts). |
| `2026-06-29-000001_activity_trade_tax` | `activities.tax`, `lots.tax_allocated`, `lots.tax_allocated_base`. |
| `2026-07-01-000001_activity_account_date_index` | index `activities(account_id, activity_date)`. |
| `2026-07-02-000001_snapshot_position_cost_basis` | `snapshot_positions.cost_basis_base`, `cost_basis_account` (nullable precomputed scalars). |
| `2026-07-04-000001_reset_derived_read_models` | `lots.fx_rate_to_account`, `lots.account_currency`; preserves HOLDINGS-mode source snapshots; deletes and rebuilds CALCULATED snapshots, valuations, lots, disposals. |
| `2026-07-08-000001_addon_storage` | creates `addon_storage(addon_id, key, value)` PK `(addon_id,key)` — local-only today. |
| `2026-08-02-000001_reclaim_storage` | drops redundant index `idx_quotes_asset_day`; clears valuations; `PRAGMA synchronous=FULL; VACUUM;`. |
| `2026-08-09-000001_rule_amount_condition` | `spending_categorization_rules.amount_op/amount_value/amount_value2`. |
| `2026-08-14-000001_cboe_canada_iso_mic` | rewrites `assets.instrument_exchange_mic` `XNEO` → `NEOE`. |
| `2026-09-02-000001_asset_logos` | creates `asset_logos` (base64 `data`, `sha256`, dimensions) so logos travel through device sync. |
| `2026-09-15-000001_account_delete_cleanup` | deletes orphaned snapshot/valuation/template/allocation rows for confirmed account deletions (keyed off `sync_entity_metadata.last_op='delete'`). |

### 2.2 Final tables (56) with columns and purpose

Column lists are the final on-disk shape (migrations + `crates/storage-sqlite/src/schema.rs`). Decimal amounts are stored as TEXT.

**Core identity & portfolio**

- `platforms(id, name, url, external_id, kind, website_url, logo_url)` — brokers/institutions referenced by accounts.
- `accounts(id, name, account_type, group, currency, is_default, is_active, created_at, updated_at, platform_id, account_number, meta, provider, provider_account_id, is_archived, tracking_mode)` — `account_type` in `SECURITIES|CASH|CREDIT_CARD|CRYPTOCURRENCY`; `tracking_mode` in `TRANSACTIONS|HOLDINGS|NOT_SET`; `provider` = `SNAPTRADE|PLAID|MANUAL|…`.
- `assets(id, kind, name, display_code, notes, metadata, is_active, quote_mode, quote_ccy, instrument_type, instrument_symbol, instrument_exchange_mic, instrument_key, provider_config, created_at, updated_at)` — instruments *and* alternative assets *and* liabilities (see `kind`); `instrument_key` is generated-stored and unique when non-null; `provider_config` JSON holds `preferred_provider` and per-provider `overrides` (`equity_symbol`, `fx_symbol`, `crypto_symbol`).
- `activities(id, account_id, asset_id, activity_type, activity_type_override, source_type, subtype, status, activity_date, settlement_date, quantity, unit_price, amount, fee, tax, currency, fx_rate, notes, metadata, source_system, source_record_id, source_group_id, idempotency_key, import_run_id, is_user_modified, needs_review, created_at, updated_at)` — one row per transaction/flow; `asset_id` nullable for pure cash; `metadata.flow.is_external` marks external transfers.
- `quotes(id, asset_id, day, source, open, high, low, close, adjclose, volume, currency, notes, created_at, timestamp)` — id `{asset_id}_{day}_{source}`, unique `(asset_id, day, source)`; `source` = provider id or `MANUAL` (and `BROKER` for broker-derived rows).
- `quote_sync_state(asset_id, position_closed_date, last_synced_at, data_source, sync_priority, error_count, last_error, profile_enriched_at, created_at, updated_at)` — per-asset sync coordination (explicitly documented as *not* a data cache; activity bounds are recomputed from `activities`).
- `market_data_providers(id, name, description, url, priority, enabled, logo_filename, last_synced_at, last_sync_status, last_sync_error, provider_type, config)` — provider catalog with user-configurable priority/enabled.
- `market_data_custom_providers(id, code, name, description, enabled, priority, config, created_at, updated_at)` — user-authored scrapers; `code` is the slug used by assets/FX.
- `holdings_snapshots(id, account_id, snapshot_date, currency, positions, cash_balances, cost_basis, net_contribution, calculated_at, net_contribution_base, cash_total_account_currency, cash_total_base_currency, source)` — per-account/day keyframe; `positions` and `cash_balances` are JSON blobs; `source` in `CALCULATED|MANUAL_ENTRY|CSV_IMPORT|BROKER_IMPORTED|SYNTHETIC`.
- `snapshot_positions(id INTEGER PK AUTOINCREMENT, snapshot_id, asset_id, quantity, average_cost, total_cost_basis, currency, inception_date, is_alternative, contract_multiplier, created_at, last_updated, cost_basis_base, cost_basis_account)` — relational sibling of `holdings_snapshots.positions`, unique `(snapshot_id, asset_id)`.
- `daily_account_valuation(id, account_id, valuation_date, account_currency, base_currency, fx_rate_to_base, cash_balance, investment_market_value, total_value, cost_basis, net_contribution, cash_balance_base, investment_market_value_base, total_value_base, cost_basis_base, net_contribution_base, external_inflow_base, external_outflow_base, external_flow_source, performance_eligible_value_base, value_status, basis_status, calculated_at)` — the derived daily read model that net worth and performance read. **Not device-synced** (derived).
- `lots(id, account_id, asset_id, open_date, open_activity_id, original_quantity, cost_per_unit, original_cost_basis, remaining_cost_basis, original_cost_basis_base, remaining_cost_basis_base, fee_allocated, fee_allocated_base, tax_allocated, tax_allocated_base, currency, base_currency, fx_rate_to_base, fx_rate_to_account, account_currency, cost_basis_method, remaining_quantity, split_ratio, is_closed, close_date, close_activity_id, created_at, updated_at)` — materialized tax-lot inventory (replaces in-memory FIFO replay); `split_ratio` is the cumulative post-acquisition split product.
- `lot_disposals(id, lot_id, account_id, asset_id, disposal_activity_id, disposal_date, quantity, proceeds, cost_basis, realized_pnl, proceeds_base, cost_basis_base, realized_pnl_base, currency, base_currency, fx_rate_to_base, cost_basis_method, created_at)` — realized-gain slices.

**Classification / taxonomies**

- `taxonomies(id, name, color, description, is_system, is_single_select, sort_order, created_at, updated_at, scope)` — `scope` = `asset` (allocation) or `activity` (spending/income).
- `taxonomy_categories(id, taxonomy_id, parent_id, name, key, color, description, sort_order, created_at, updated_at, icon)` — composite PK `(taxonomy_id,id)`, self-referencing hierarchy.
- `asset_taxonomy_assignments(id, asset_id, taxonomy_id, category_id, weight, source, created_at, updated_at)` — weights in bps (0–10000).
- `activity_taxonomy_assignments(id, activity_id, taxonomy_id, category_id, weight, source, created_at, updated_at)` — unique `(activity_id, taxonomy_id)`.

**Goals / planning / limits**

- `goals(id, title, description, target_amount, goal_type, status_lifecycle, status_health, priority, cover_image_key, currency, start_date, target_date, summary_current_value, summary_progress, projected_completion_date, projected_value_at_target_date, summary_target_amount, created_at, updated_at)`.
- `goal_plans(goal_id PK, plan_kind, planner_mode, settings_json, summary_json, version, created_at, updated_at)` — 1:1 extension for retirement/complex planners.
- `goals_allocation(id, goal_id, account_id, share_percent, tax_bucket, created_at, updated_at)` — unique `(goal_id, account_id)`.
- `contribution_limits(id, group_name, contribution_year, limit_amount, account_ids, created_at, updated_at, start_date, end_date)`.
- `portfolios(id, name, description, sort_order, created_at, updated_at)` + `portfolio_accounts(id, portfolio_id, account_id, sort_order, created_at)` (unique name, unique pair).
- `allocation_targets(id, name, scope_type, scope_id, taxonomy_id, trigger_type, drift_band_bps, rebalance_goal, min_trade_amount, whole_shares_only, allow_sells, created_at, updated_at, archived_at, band_type, relative_factor_bps, max_turnover_bps)` — `scope_type` `all|portfolio|account`.
- `allocation_target_weights(id, target_id, taxonomy_id, category_id, target_bps, is_locked, is_required, created_at, updated_at)`.
- `allocation_target_constraints(id, target_id, subject_type, subject_id, action, effect, reason, metadata_json, created_at, updated_at)`.

**Import / broker sync**

- `import_templates(id, name, scope, kind, source_system, config_version, config, created_at, updated_at)` — reusable CSV/broker mapping profiles (system-seeded + user).
- `import_account_templates(id, account_id, context_kind, source_system, template_id, created_at, updated_at)` — links an account to a template; unique `(account_id, context_kind, source_system)`.
- `import_runs(id, account_id, source_system, run_type, mode, status, started_at, finished_at, review_mode, applied_at, checkpoint_in, checkpoint_out, summary, warnings, error, created_at, updated_at)` — import/sync run ledger.
- `brokers_sync_state(account_id, provider, checkpoint_json, last_attempted_at, last_successful_at, last_error, last_run_id, sync_status, created_at, updated_at)` — PK `(account_id, provider)`; checkpoint is provider-shaped JSON.

**Spending / budgets**

- `spending_event_types(id, key, name, color, created_at, updated_at)`.
- `spending_events(id, name, description, event_type_id, start_date, end_date, created_at, updated_at)`.
- `spending_activity_events(activity_id PK, event_id, created_at, updated_at)` — 1:1 activity→event tag.
- `spending_categorization_rules(id, name, pattern, match_type, taxonomy_id, category_id, activity_type, priority, is_global, account_id, preset_id, preset_rule_key, preset_version, preset_modified, created_at, updated_at, amount_op, amount_value, amount_value2)`.
- `spending_preset_rule_deletions(preset_id, preset_rule_key, rule_id, deleted_at)` — PK `(preset_id,preset_rule_key)`.
- `spending_activity_splits(id, activity_id, taxonomy_id, category_id, amount, note, sort_order, created_at, updated_at)` — amount must be > 0.
- `budget_groups(id, name, key, color, icon, sort_order, is_system, created_at, updated_at)`.
- `budget_group_assignments(id, group_id, taxonomy_id, category_id, is_system, created_at, updated_at)`.
- `budget_targets(id, period_key, target_type, taxonomy_id, category_id, group_id, amount, created_at, updated_at)` — `period_key` is `default` or `YYYY-MM`.
- `budget_rollover_settings(id, target_type, taxonomy_id, category_id, group_id, enabled, start_month, starting_balance, created_at, updated_at)`.

**Settings / misc / agent**

- `app_settings(setting_key PK, setting_value)` — theme, font, base_currency, instance_id, `spending.enabled`, etc.
- `health_issue_dismissals(issue_id PK, dismissed_at, data_hash)`.
- `ai_threads(id, title, config_snapshot, is_pinned, created_at, updated_at)`, `ai_messages(id, thread_id, role, content_json, created_at)`, `ai_thread_tags(id, thread_id, tag, created_at)`.
- `personal_access_tokens(id, name, token_prefix, token_hash, scopes_json, expires_at, last_used_at, revoked_at, created_at)`; `mcp_audit_log(id, session_id, actor_kind, actor_fingerprint, tool, scopes_json, args_summary, outcome, error_message, created_at)` — both local-only.
- `addon_storage(addon_id, key, value)` — per-addon KV.
- `asset_logos(asset_id PK, mime_type, data, sha256, width, height, created_at, updated_at)`.

**Device sync (E2EE) — 7 tables**

- `sync_cursor(id=1, cursor, updated_at)`, `sync_outbox(event_id PK, entity, entity_id, op, client_timestamp, payload, payload_key_version, sent, status, retry_count, next_retry_at, last_error, last_error_code, device_id, created_at)`, `sync_entity_metadata(entity, entity_id, last_event_id, last_client_timestamp, last_seq, last_op)`, `sync_device_config(device_id PK, key_version, trust_state, last_bootstrap_at, min_snapshot_created_at)`, `sync_engine_state(id=1, lock_version, last_push_at, last_pull_at, last_error, consecutive_failures, next_retry_at, last_cycle_status, last_cycle_duration_ms)`, `sync_table_state(table_name PK, enabled, last_snapshot_restore_at, last_incremental_apply_at)`, `sync_applied_events(event_id PK, seq, entity, entity_id, applied_at)`.

### 2.3 Tables that existed and were dropped (do not model these downstream)

`settings` (→ `app_settings`), `portfolio_history` (→ `holdings_snapshots` + `daily_account_valuation`), `exchange_rates` (→ FX `assets` + `quotes`), `activity_import_profiles` (→ `import_templates` + `import_account_templates`), `assets_old`/`activities_old` (v2 rebuild scratch). Temporary tables used inside migrations: `legacy_asset_id_map`, `asset_id_mapping`, `asset_old_id_map`, `asset_dedup_resolution`, `quotes_temp`.

---

## 3. Activity types and account types in Rust

### 3.1 Activity types — `crates/core/src/activities/activities_constants.rs` + `activities_model.rs`

Canonical set is **14 strings**, also enforced by a SQL CHECK on `activities.activity_type`:

```
BUY, SELL, DIVIDEND, INTEREST, DEPOSIT, WITHDRAWAL, TRANSFER_IN, TRANSFER_OUT,
FEE, TAX, SPLIT, CREDIT, ADJUSTMENT, UNKNOWN
```

`pub enum ActivityType` (`activities_model.rs`, ~line 1548) variants: `Buy, Sell, Dividend, Interest, Deposit, Withdrawal, TransferIn, TransferOut, Fee, Tax, Split, Credit, Adjustment, Unknown` — `as_str()` maps to the constants above; `FromStr` rejects anything else.

Related constants in the same file: `TRADING_ACTIVITY_TYPES` (`BUY, SELL, SPLIT`), `INCOME_ACTIVITY_TYPES` (`DIVIDEND, INTEREST`), `PRICE_BEARING_ACTIVITY_TYPES` (`BUY, SELL` — only these `unit_price` values may be reused as fallback quotes), `SYMBOL_REQUIRED_TYPES` (`BUY, SELL, SPLIT, DIVIDEND, ADJUSTMENT`), `is_cash_symbol()` (matches `$CASH-USD`, `CASH:USD`, `CASH_USD`), `is_garbage_symbol()`.

`pub enum ActivityStatus` (`activities_model.rs`): `Posted, Pending, Draft, Void` (serde `SCREAMING_SNAKE_CASE`, default `Posted`). Only `POSTED` rows participate in calculations (`Activity::is_posted()`).

Also in `activities_model.rs`: `pub enum TemplateKind { CsvActivity, CsvHoldings, BrokerActivity }` (`as_str()` → `CSV_ACTIVITY`/`CSV_HOLDINGS`/`BROKER_ACTIVITY`), `pub enum ImportTemplateScope` (`User`/`System`), `pub enum BrokerProfileScope`, `pub enum FieldMappingValue`, `pub enum ImportAssetPreviewStatus`, plus request/response models (`Activity`, `NewActivity`, `ActivityUpdate`, `ActivityImport`, `ImportMappingData`, `ImportTemplate`, `ImportRun`, `BrokerActivityProfileConfig`, `BrokerSyncProfileData`, `ActivitySearchResponse`, …). Tolerant decimal parsing (`parse_decimal_string_tolerant`, `optional_decimal_format`) accepts strings, numbers, nulls and scientific notation — decimals travel as JSON strings.

### 3.2 Account types — `crates/core/src/accounts/accounts_constants.rs`

`account_types` module constants (the closed set; enforced by the spending migration's normalization):

```
SECURITIES, CASH, CREDIT_CARD, CRYPTOCURRENCY
```

`DEFAULT_ACCOUNT_TYPE = "SECURITIES"`. `pub enum AccountPurpose { Spending, Performance, Holdings, Income, GoalFunding, ContributionLimits, NetWorth }` and `AccountCapabilities { spending, performance, holdings, income, goal_funding, contribution_limits, net_worth, liability }`; policy functions `account_supports_purpose`, `account_capabilities`, `is_liability_account_type` (true only for `CREDIT_CARD`), `is_spending_account_type`, `is_report_account_type`, `is_retirement_eligible_account_type`, `default_group_for_account_type` (`Investments`/`Cash`/`Credit Cards`/`Crypto`).

`crates/core/src/accounts/accounts_model.rs` enums: `TrackingMode { Transactions, Holdings, NotSet }` (serde SCREAMING_SNAKE_CASE, default `NotSet`), `CostBasisMethod { Fifo, Lifo, Wac }`, `CostBasisProfile { Generic, CanadaAcb }`, `PoolingScope { Account, Portfolio }`, `LotSelectionStrategy { SpecificId, HighestCost, LowestCost }`, plus `AccountAccountingSettings`. Only FIFO + GENERIC + ACCOUNT pooling are currently accepted by the calculator (`ensure_supported_for_calculation` returns a validation error otherwise — i.e. LIFO/WAC/CANADA_ACB are modelled but not implemented).

`pub struct Account` fields: `id, name, account_type, group, currency, is_default, is_active, created_at, updated_at, platform_id, account_number, meta, provider, provider_account_id, is_archived, tracking_mode`.

Asset kinds (for net worth categorisation) — `crates/core/src/assets/assets_model.rs`: `pub enum AssetKind { Investment, Property, Vehicle, Collectible, PreciousMetal, PrivateEquity, Liability, Other, Fx }`; `pub enum InstrumentType { Equity, Crypto, Fx, Option, Metal, Bond }`; `pub enum QuoteMode { Market, Manual }`; `AssetKind::is_alternative()` covers Property, Vehicle, Collectible, PreciousMetal, Liability, Other. `crates/market-data/src/models/instrument.rs` has a *separate* `InstrumentKind { Equity, Crypto, Fx, Metal, Option, Bond }` and a legacy `AssetKind { Security, Crypto, Cash, FxRate, Option, Commodity, PrivateEquity, Property, Vehicle, Liability, Other }` used for provider capability filtering.

---

## 4. Net worth and portfolio valuation in Rust

### 4.1 Net worth — `crates/core/src/portfolio/net_worth/`

Files: `net_worth_service.rs` (1097 lines), `net_worth_model.rs` (175), `net_worth_traits.rs` (45), `net_worth_service_tests.rs` (2686). `NetWorthService` is constructed with repositories for accounts, assets, snapshots, quotes and daily valuations plus `FxService` and a shared `base_currency: Arc<RwLock<String>>`.

`get_net_worth(date)` algorithm (`net_worth_service.rs:347`):

1. `account_repository.list(None, Some(false), None)` — all accounts with `is_archived = false` (closed-but-not-archived accounts stay in historical net worth); empty → `NetWorthResponse::empty`.
2. Load latest snapshots as of `date` (`get_latest_snapshots_before_date`), all assets, and stored `DailyAccountValuation` rows for that exact date (`valuation_repository.get_valuations_on_date`).
3. Per account:
   - category from account type (`categorize_by_account_type`: SECURITIES/CRYPTOCURRENCY → `Investment`, CASH → `Cash`, CREDIT_CARD → `Liability`).
   - If a **stored valuation** exists (non-liability accounts), emit one `INVESTMENTS:<account_id>` item from `investment_market_value_base` and one `CASH:<account_id>` item from `cash_balance_base`, both rounded to `DECIMAL_PRECISION` before the zero check (activity replay leaves ~1e-15 dust). Positions are then skipped (`stored_account_valuation.is_some()` short-circuit).
   - Otherwise, per snapshot position: skip zero quantity, skip expired options (`is_expired_option_asset`, OCC symbol parsing), get latest quote ≤ date via `quote_service.get_historical_quotes(asset_id)` + `max_by_key(timestamp)`; if no quote, fall back to cost-basis-implied price (`total_cost_basis / quantity`) with the snapshot date as valuation date. Normalise minor units (`normalize_amount`, e.g. GBp→GBP, ZAc→ZAR) and compute `market_value_base = fx_service.convert_currency_for_date(quantity * price * contract_multiplier, quote_ccy, base_ccy, date)` (on FX error: keeps the unconverted local value and warns).
   - Category per item prefers `AssetKind` (`categorize_by_asset_kind`: Investment/PrivateEquity→Investment, Property→Property, Vehicle→Vehicle, Collectible→Collectible, PreciousMetal→PreciousMetal, Liability→Liability, Fx→Other).
   - **Liability accounts (credit cards)** ignore positions entirely (warn) and instead sum `snapshot.cash_balances` converted to base: a negative total becomes `AssetCategory::Liability` with id `CREDIT_CARD:<account_id>` and the absolute value; a positive total becomes a `Cash` item. `Liability` items are excluded from `build_assets_section`.
4. Standalone alternative assets: every `asset.kind.is_alternative()` asset not already represented, priced at quantity `1` from its latest quote (value-based model), converted to base — this is how **property, vehicles, collectibles, precious metals and standalone liabilities** enter net worth.
5. `assets.total` = sum of non-liability categories; `liabilities.total` = sum of liability items; **`net_worth = assets.total - liabilities.total`** (rounded to `DECIMAL_PRECISION`).
6. Staleness: `STALENESS_THRESHOLD_DAYS = 90`; cash-like items and $0 liabilities are excluded from staleness; `oldest_valuation_date` and `stale_assets` are returned.

`get_net_worth_history(start_date, end_date)` (`net_worth_service.rs:710`) walks `daily_account_valuation` per account (liability accounts excluded to avoid double counting), aggregates a `PortfolioState { value, net_contribution, cash, investments }` per date, adds alternative-asset quotes from `quote_service.get_quotes_in_range_filled` converted per date with `fx_service.convert_currency_for_date`, seeds forward-fill values from the latest quote ≤ first portfolio date (`get_latest_quote_as_of`), tracks credit-card assets/liabilities per date, emits points for every date ≥ first portfolio date, and returns `NetWorthHistoryPoint { date, portfolio_value, alternative_assets_value, total_liabilities, total_assets, net_worth, net_contribution, breakdown, currency }` with a `breakdown` map keyed by category (`cash`, `investments`, `properties`, `vehicles`, `collectibles`, `preciousMetals`, `otherAssets`) and per-liability ids (`CREDIT_CARD:<id>`). Category keys/display names come from `category_key`/`category_display_name`.

### 4.2 Per-account/daily valuation — `crates/core/src/portfolio/valuation/`

- `valuation_calculator.rs` (1198 lines): `calculate_valuation(holdings_snapshot, quotes_today, fx_rates_today, fx_rates_by_date, target_date, base_currency)` → `DailyAccountValuation`; `calculate_valuation_with_price_factors` adds per-asset split price factors. It computes investment market value in account currency, cash value, cost basis (account + base), `net_contribution`, then a single `fx_rate_to_base` from the pre-fetched `DailyFxRateMap` (`(from,to) -> Decimal`); a missing account→base rate is a hard error (`Error::Fx(FxError::RateNotFound)`), while missing local-currency rates degrade via `get_rate_from_map`.
- `valuation_service.rs` (6739 lines): batch recalculation orchestration, `ValuationRecalcMode`, `ValuationBatchOutcome`, failure reporting; writes `daily_account_valuation` including `external_flow_source`, `value_status`, `basis_status`.
- `current_account_valuation.rs` (745): current-value view over the latest snapshot/valuation.

### 4.3 Snapshots, holdings and lots

- `crates/core/src/portfolio/snapshot/`: `holdings_calculator/` (replays `activities` through handlers `trades.rs`, `cash_flows.rs`, `corporate_actions.rs`, `transfers.rs`, `fx.rs`, `economics.rs`, `lots.rs` to produce positions + cash balances), `snapshot_service.rs` (2000 lines, persistence/dirty-date planning), `positions_model.rs`, `snapshot_model.rs` (`AccountStateSnapshot`), `date_policy.rs`, `holdings_timeline.rs`, `manual_snapshot_service.rs`, `holdings_import_validation.rs`, `quote_sync_reconciliation.rs`, `shortability_policy.rs`.
- `crates/core/src/lots/mod.rs` and `portfolio/snapshot/holdings_calculator/lots.rs`: lot materialization (FIFO/`cost_basis_method`, `split_ratio`, `remaining_cost_basis`, base-currency columns, `tax_allocated`), disposals into `lot_disposals`.
- `crates/core/src/portfolio/economic_events.rs` (1214 lines) carries `BasisStatus` and the valuation status vocabulary.

### 4.4 FX — `crates/core/src/fx/`

`fx_service.rs` `FxServiceTrait`: `convert_currency` (latest rate), `convert_currency_for_date(amount, from, to, date)`, `get_exchange_rate_for_date`, `add_exchange_rate`, `get_historical_rates`, `register_currency_pair`, `initialize`.

- `get_exchange_rate_for_date` validates 3-letter alphabetic codes, normalises the pair (minor/major aliases carry a multiplier), then `get_rate_for_date_between_normalized` first asks an in-memory converter (`converter.get_rate_nearest(from, to, date)`) and only falls back to `load_latest_exchange_rate` (logging `"No exchange rate found for {}/{} on {}. Using fallback rate from {}"`).
- FX pairs are persisted as `assets` rows (`kind='FX'`, `display_code` `EUR/USD`, `quote_ccy` = quote currency, `instrument_key = FX:EUR/USD`, `provider_config.overrides.YAHOO = {type: "fx_symbol", symbol: "EURUSD=X"}`) with rates as normal `quotes` rows; `add_exchange_rate` uses `repository.create_fx_asset(...)` and only persists MANUAL sources (provider-backed rates are left to the quote sync — comment references issue #1143).
- Tests in `fx_service.rs` confirm nearest-date fallback for non-trading days (`get_exchange_rate_for_date_falls_back_to_nearest_when_no_exact_match`).

Performance/income/allocation sit alongside: `portfolio/performance/` (`flow_classifier.rs`, `performance_service.rs`), `portfolio/income/`, `portfolio/allocation/`, `portfolio/allocation_targets/` (`drift_service.rs`, `rebalance_service.rs`, `optimizer.rs`, `validation.rs`), `portfolio/fire/` (FIRE calculator), `crates/core/src/planning/`, `crates/core/src/goals/`.

---

## 5. market-data crate (`crates/market-data`)

### 5.1 Providers implemented

Registered provider modules under `src/provider/` (each exposing `const PROVIDER_ID`):

| provider | id | source |
|---|---|---|
| `yahoo/mod.rs` | `YAHOO` (via `fn id()` in the `MarketDataProvider` impl) | `src/provider/yahoo/models.rs` |
| `alpha_vantage/mod.rs` | `ALPHA_VANTAGE` | |
| `marketdata_app/mod.rs` | `MARKETDATA_APP` | |
| `finnhub/mod.rs` | `FINNHUB` | |
| `boerse_frankfurt/mod.rs` | `BOERSE_FRANKFURT` (bond pricing, with an in-memory `isin_cache: Arc<RwLock<HashMap<String,String>>>`) | |
| `us_treasury_calc/mod.rs` | `US_TREASURY_CALC` (computes bond prices from the US Treasury yield curve, `curve_cache: Arc<RwLock<HashMap<i32, YearCurves>>>` keyed by year) | |
| `metal_price_api/mod.rs` | `METAL_PRICE_API` (XAU/XAG/XPT/XPD spot) | |
| `openfigi/mod.rs` | `OPENFIGI` (identifier mapping: FIGI/ISIN/CUSIP/ticker) | |
| `fixture/mod.rs` | test fixture provider | |

Plus `DATA_SOURCE_CUSTOM_SCRAPER = "CUSTOM_SCRAPER"` (`provider/mod.rs`) — the runtime dispatch id for user-authored scrapers, implemented in core (`crates/core/src/quotes/custom_scraper_provider.rs`, 1660 lines) and stored in `market_data_custom_providers`. Provider catalog/priority/enabled state lives in the `market_data_providers` table (rows seeded by migrations; user toggles priority).

### 5.2 Registry, ordering and fallback — `src/registry/provider_registry.rs` (2226 lines) + `registry/mod.rs`

`ProviderRegistry { providers, resolver, rate_limiter, circuit_breaker, validator, custom_priorities }`. Construction configures per-provider rate limits from `provider.rate_limit()`. Selection order (`ordered_providers` / `ordered_profile_providers` / `filter_providers` / `sort_by_preference`):

1. filter by `ProviderCapabilities.instrument_kinds` and `Coverage` (`supports_instrument`);
2. sort by `preferred_provider` (from asset `provider_config`), else user `custom_priorities`, else the provider's default `priority()`;
3. skip providers whose circuit is open (`CircuitBreaker`, `CircuitState`);
4. resolve the provider-specific symbol via `SymbolResolver::resolve(provider_id, context)`;
5. `RateLimiter::acquire(provider_id)`;
6. fetch; `QuoteValidator::validate_for_instrument` each quote; empty history → `NoDataForRange` and continue to the next provider;
7. failure handling by `RetryClass` (`FailoverWithPenalty` / `CircuitOpen` record a circuit failure, `record_success` on success).

Public entry points: `fetch_quotes`, `fetch_latest_quote`, `fetch_splits`, `fetch_dividends` (tries dividend-capable providers in priority order), `fetch_quotes_for_reset` (an explicitly preferred provider is exclusive — no fallback), `search`, `get_profile`, `fetch_quotes_with_diagnostics`, `fetch_latest_quote_with_diagnostics`; diagnostics types `FetchDiagnostics`, `ProviderAttempt`, `SkipReason` (`registry/skip_reason.rs`). Other files: `circuit_breaker.rs` (516), `rate_limiter.rs` (386), `validator.rs` (461).

### 5.3 Instrument identification

`src/models/instrument.rs`: `pub enum InstrumentId { Equity { ticker, mic: Option<Mic> }, Crypto { base, quote }, Fx { base, quote }, Metal { code, quote }, Option { occ_symbol }, Bond { isin } }` with `kind()` → portfolio `AssetKind` and `instrument_kind()` → `InstrumentKind` used for capability filtering. `src/models/types.rs` defines `Currency`/`Mic` aliases.

Resolution (`src/resolver/`): `traits.rs` (`SymbolResolver`, `ProviderInstrument`), `rules_resolver.rs` (per-kind symbol rules: `resolve_equity`, `resolve_crypto` `BASE-QUOTE`, `resolve_fx` `BASEQUOTE=X`, `resolve_bond` by ISIN, `resolve_option` OCC 21-char, `resolve_metal`), `asset_resolver.rs`, `exchange_registry.rs` + `exchanges.json` + `exchange_suffixes.rs` + `exchange_metadata.rs` (Yahoo suffix ↔ ISO 10383 MIC), `chain.rs`, `profile_check.rs` (discards unconfirmed fallback profile matches).

On the portfolio side, identity lives on `assets`: `instrument_type`, `instrument_symbol`, `instrument_exchange_mic`, generated `instrument_key` (`EQUITY:AAPL@XNAS`, `EQUITY:VBU@NEOE`, `CRYPTO:BTC/USD`, `FX:EUR/USD`), unique index `idx_assets_instrument_key`; plus `provider_config` JSON with `preferred_provider` and per-provider `overrides` (`equity_symbol` / `fx_symbol` / `crypto_symbol`). ISIN appears only inside `assets.metadata.identifiers.isin` (carried over from the pre-v2 `isin` column) and as the `Bond` identity in the market-data crate; `import_templates.config.fieldMappings` can map an `isin` CSV column (e.g. Trading 212 template).

### 5.4 Quote fetching, storage, "caching"

- `crates/core/src/quotes/` is the integration layer: `client.rs` (1500, `MarketDataClient` facade over the registry), `sync.rs` (2886, `QuoteSyncService` — planning + fetch + store), `sync_state.rs` (1030, per-asset sync planning; comments stress that bounds are *computed*, not cached), `service.rs` (4748, unified service = CRUD + sync + providers), `store.rs` (532, `QuoteStore` trait), `import.rs` (1076, validation/import of quote rows), `custom_scraper_provider.rs`, `provider_settings.rs`, `scheduler.rs`.
- **Persistence is the cache**: quotes live in the `quotes` table, keyed `(asset_id, day, source)` with `source` = provider id or `MANUAL`; `upsert_quotes` batches; `delete_provider_quotes_for_asset` preserves `MANUAL` rows before a provider-history reset. There is **no separate quote-cache table** and no generic TTL cache in the quote path (only provider-local memory caches: Boerse Frankfurt ISIN map, US Treasury per-year curve). `docs/architecture/market-data-quotes.md` mentions an in-memory cache as design intent (line ~1072), but the shipped code path stores in SQLite.
- Sync modes: `SyncMode` in `sync_state.rs` (incremental, backfill/history), `SyncResult { synced, skipped, failed }`; `refresh_sync_state()` ensures `quote_sync_state` rows; `handle_activity_created/deleted` widen/narrow the required range to cover activity dates and holding-snapshot bounds (`get_activity_bounds_for_assets`, `get_holdings_snapshot_bounds_for_assets`). `quotes/scheduler.rs::run_periodic_sync(quote_service, initial_delay, interval)` loops `sync(SyncMode::Incremental, None)` on a fixed interval, logging errors and never panicking.
- FX rates are normal quotes on `kind='FX'` assets, so the same sync/store path covers currencies.

---

## 6. Addon system

### 6.1 Manifest

TS type: `packages/addon-sdk/src/manifest.ts` (`AddonManifest`); Rust mirror: `crates/core/src/addons/models.rs` (`AddonManifest`, serde camelCase, with `#[serde(rename = "sdkVersion")]`, `#[serde(rename = "minWealthfolioVersion")]`, `#[serde(rename = "hostDependencies")]`).

Fields: `id, name, version, description?, author?, sdkVersion?, main?, enabled?, permissions?, homepage?, repository?, license?, minWealthfolioVersion?, keywords?, icon?, network?, hostDependencies?, contributes?` plus runtime-only `installedAt?, updatedAt?, source?: 'local'|'store'|'sideload', size?`. `to_installed()` in Rust rejects a manifest without `main` and stamps install metadata. `validate_addon_id` (lowercase) guards paths; `get_addon_path`/`validated_addon_archive_path` sandbox archive extraction.

`contributes` (`AddonContributes { routes: AddonContributedRoute[], links: Record<slot, AddonContributedLink[]> }`) declares durable pages (id + optional relative `path` below the host-owned `/addons/<addon-id>` mount) and placements in host slots (only `"sidebar"` is consumed today); routes are ingested at boot *without executing addon code*.

### 6.2 Permissions, consent and runtime enforcement

`packages/addon-sdk/src/permissions.ts` defines `PERMISSION_CATEGORIES` with per-category function allowlists and `riskLevel` (`low|medium|high`):

`accounts` (high), `alternative-assets` (high, read-only), `portfolio` (high), `activities` (high, incl. import/save), `market-data` (low), `assets` (medium), `quotes` (low), `performance` (medium), `currency` (low), `spending` (medium), `financial-planning` (medium), `contribution-limits` (medium), `settings` (medium, incl. `backupDatabase`), `files` (medium), `secrets` (high), `snapshots` (high), `events` (low), `network` (high, `request`).

`BASELINE_PERMISSION_CATEGORIES = ['ui','query','toast','logger','storage']` — implicit capabilities that never appear in consent UI, are never guarded at runtime, and never count as an escalation on update (`isBaselineCategory`).

Three enforcement stages (`docs/addons/addon-architecture.md`): manifest declaration → static analysis detection at install (`detect_addon_permissions(&[AddonFile]) -> Vec<AddonPermission>`, `service.rs:215`, recording `FunctionPermission { name, is_declared, is_detected, detected_at }`) → user approval → runtime validation of each host-API call. Permission state is additive on update (declared+detected stored on the installed manifest).

### 6.3 Sandbox model

- Each addon module runs inside an **isolated iframe with `sandbox="allow-scripts"` and an opaque origin**, loaded from `apps/frontend/addon-sandbox.html` via `iframe.srcdoc` (`apps/frontend/src/addons/iframe/addon-iframe-manager.ts`, line 489/556), not in the host document. The channel is `wealthfolio:addon-sandbox:v1` and messages are versioned (`ADDON_SANDBOX_RUNTIME_PROTOCOL_VERSION`, mismatch = hard load failure).
- Host→sandbox runtime assets are fetched and rewritten (`addon-module-rewriter.ts`, `addon-sandbox-assets.ts`); theme, i18n, styles, ticker avatars and host dependencies are injected (`addon-sandbox-theme.ts`, `addon-sandbox-i18n`, `addon-sandbox-styles.ts`, `sandbox-ticker-avatar.tsx`, `host-dependencies.ts`).
- The sandbox has no direct DOM/`window` access to the host app; `localStorage`/`sessionStorage` are unavailable and the loader classifies that failure with the hint "use the storage API" (addon-iframe-manager.ts ~line 254).
- Host API surface the addon may call: `packages/addon-sdk/src/host-api.ts` interfaces `AccountsAPI, PortfolioAPI, ActivitiesAPI, MarketDataAPI, AssetsAPI, AlternativeAssetsAPI, QuotesAPI, PerformanceAPI, ExchangeRatesAPI, SpendingAPI, FinancialPlanningAPI (goals), ContributionLimitsAPI, SettingsAPI, FilesAPI, SecretsAPI, SnapshotsAPI, EventsAPI, NetworkAPI` plus baseline `ui/query/toast/logger/storage`. Addons also register routes/components through the SDK (React re-exported from the packaged host dependency set).
- Lifecycle/contributions: `apps/frontend/src/addons/addons-core.ts`, `addons-loader.ts`, `activation-coordinator.ts`, `contribution-registry.ts`, `addons-runtime-context.ts`, dev mode `addons-dev-mode.ts`.

### 6.4 Network, secrets and storage

- Network is brokered by the host, never direct: `crates/core/src/addons/network.rs::perform_addon_network_request(addon_id, allowed_hosts, request)` — HTTPS-only, enforces the manifest `network.allowedHosts` (+ `approvedHosts`) allowlist, caps request body 1 MiB / response body 2 MiB, default timeout 10 s (max 120 s), supports per-request `auth: { type, secretKey }` where the **host injects the `Authorization` header from `SecretStore`** (`injected_authorization`, never exposed to the addon). Exposed over Tauri (`apps/tauri/src/commands/addon_network.rs`) and Axum (`apps/server/src/api/addon_network.rs`).
- Secrets: keys per addon via `addon_secret_service_id` / `legacy_addon_secret_service_id` (`crates/core/src/secrets/mod.rs`), `normalize_addon_secret_key` (max 128 chars), stored in the platform `SecretStore` — native credential store on Tauri, file-backed encrypted store on the server. Never exposed as plaintext to addon JS beyond explicit `secrets.use`/`get`.
- Storage: `addon_storage(addon_id, key, value)` via `AddonStorageRepositoryTrait` (`crates/core/src/addons/storage_repository.rs`, `crates/storage-sqlite/src/addons`), local-only today.
- Distribution: `addons/service.rs` handles zip extraction (`extract_addon_zip_internal`), manifest parsing (`parse_manifest_json_metadata`), recursive file reads (`read_addon_files_recursive`), store listing/rating/update (`check_addon_update_from_api`, `download_addon_from_store`, `fetch_addon_store_listings`, `submit_addon_rating`, `verify_addon_package_sha256`, staging functions).

**What an addon cannot do:** run outside the iframe sandbox; touch host DOM/globals or browser storage; make network calls except through the host broker to allowlisted HTTPS hosts; read or write data in a category it has not been granted; reach the filesystem beyond the explicit file-dialog API (`openCsvDialog`, `openSaveDialog`); persist secrets in plaintext; place trades (there is no order API anywhere, policy or Rust).

---

## 7. connect crate (`crates/connect`, 10 935 lines)

### 7.1 Architecture and existing broker integrations

`crates/connect/src/lib.rs`: `broker` (feature `broker`), `broker_ingest`, `client`, `platform`, `post_login_bootstrap`, `token_lifecycle`, `request_metadata`. Wealthfolio's broker connectivity is **mediated by the hosted "Wealthfolio Connect" cloud API** (`client.rs`, `DEFAULT_CLOUD_API_URL`, endpoints `/connect/*` in `apps/server/src/api/connect.rs`: `post-login-bootstrap`, `session`, `session/status`, `session/restore`, `connections`, `accounts`, `sync`, `sync/connections`, `sync/accounts`, `sync/activities`, `synced-accounts`, `platforms`, `sync-states`, `import-runs`, `plans`, `user`). Local code does not talk to brokers directly.

Concretely, in the code the upstream aggregator is **SnapTrade** (`crates/connect/src/broker/service.rs:45`: `const DEFAULT_BROKERAGE_PROVIDER: &str = "snaptrade"`; `provider: Some("SNAPTRADE")`; `broker/mapping.rs:644`). The checkpoint vocabulary also names **Plaid** (`broker_ingest/models.rs`: `SnapTradeCheckpoint { last_synced_date, lookback_days }`, `PlaidSyncCheckpoint { cursor }`, `PlaidInvestmentsCheckpoint { last_synced_date, lookback_days }`), and `crates/core/src/accounts/accounts_model.rs` documents `provider` as `'SNAPTRADE', 'PLAID', 'MANUAL'`. Brokerage *names* (Questrade, Interactive Brokers, Fidelity, Wealthsimple…) appear only as `platforms` rows / test fixtures — the set of supported institutions is server-side, not enumerated in this repo.

There is **no dedicated broker-connection table**: connection/account data is fetched from the Connect API at runtime; local persistence is `platforms` (`id` slug, `external_id`, `kind`), `accounts.provider` + `accounts.provider_account_id` + `accounts.meta`, `brokers_sync_state`, and `import_runs`.

### 7.2 Auth, tokens, SecretStore

- `token_lifecycle.rs`: `TokenLifecycleConfig { auth_url, publishable_key, expiry_buffer_secs (default 60), refresh_timeout_secs (default 10) }`, `TokenLifecycleState`, `ensure_valid_access_token`, `is_configured()`; `CLOUD_ACCESS_TOKEN_KEY = "sync_access_token"`, `CLOUD_REFRESH_TOKEN_KEY = "sync_refresh_token"` (`crates/core/src/secrets/mod.rs`), plus `SYNC_IDENTITY_KEY = "sync_identity"` and legacy `sync_device_id`.
- All secrets go through `SecretStore` (`crates/core/src/secrets/mod.rs`, service prefix `wealthfolio_`, `format_service_id` lowercases; documented in `docs/architecture/credential-storage.md`): native keyring on Tauri (`apps/tauri/src/secret_store.rs`), file-backed encrypted store on the server (`apps/server/src/secrets/`, key from `WF_SECRET_KEY`/`WF_SECRET_KEY_FILE`). Credential clearing is explicit: `clear_restored_sync_identity` (keeps provider credentials, blocks cloud access until re-login) vs `clear_connect_binding_credentials` (removes access/refresh/identity) — and it verifies deletion or errors.
- `post_login_bootstrap.rs`: `acquire_broker_sync_guard` / `BrokerSyncRunGuard` (single-flight sync), `prepare_post_login_broker_bootstrap`, `PostLoginBootstrapStatus`/`Reason`, `is_active_broker_connection`.
- `request_metadata.rs`: per-request id propagation (`CLIENT_REQUEST_ID_HEADER`, `server_request_id`) and failed-request logging.

### 7.3 `broker_ingest` — what it does

`crates/connect/src/broker_ingest/mod.rs` + `models.rs` + `core_adapter.rs` define the connect-owned ingest contracts over core's import machinery:

- `SyncStatus { Idle, Running, NeedsReview, Failed }` (SCREAMING_SNAKE_CASE).
- `BrokerSyncState { account_id, provider, checkpoint_json, last_attempted_at, last_successful_at, last_error, last_run_id, sync_status, created_at, updated_at }` with `get_checkpoint<T>`/`set_checkpoint<T>`, `start_sync`, `complete_sync`, `fail_sync` — persisted in `brokers_sync_state`.
- `ImportRun { …, ImportRunType { Sync, Import }, ImportRunMode, ImportRunStatus, ReviewMode, ImportRunSummary }` persisted in `import_runs` through `CoreImportRunRepositoryAdapter`/`ImportRunRepositoryTrait` — i.e. broker pulls land in the *same* run/review pipeline as CSV imports.
- Checkpoints: `SnapTradeCheckpoint { last_synced_date, lookback_days }`, `PlaidSyncCheckpoint { cursor }`, `PlaidInvestmentsCheckpoint { last_synced_date, lookback_days }`.

### 7.4 Is there an existing read-only sync pattern to imitate?

Yes, and it is the only pattern present. `broker/orchestrator.rs` (`SyncOrchestrator`, `SyncConfig`, `sync_all`, `sync_activities_only`) runs an `activity_phase` then a `holdings_phase` (`orchestrator/activity_phase.rs`, `holdings_phase.rs`, `activity_pagination.rs`), with `progress.rs` (`SyncProgressPayload`, `SyncStatus`, `NoOpProgressReporter`) and `sync_readiness.rs` (`ProviderReadiness { Ready(date), NotReady(reason) }` derived from `initial_sync_completed` / `last_successful_sync`, plus `should_advance_activity_cursor` and `provider_waterline_precedes_local_cursor` gates). Data flows one way: broker → Connect API → `BrokerSyncService` → activities/positions in SQLite. There is **no order submission, no write-back to brokers** (`grep` for `place_order|submit_order` in `crates/connect`: no matches). Mapping/canonicalisation lives in `broker/mapping.rs` (`normalize_source_system`, SnapTrade symbol-type → `InstrumentType`, `source_system`/`provider_type` metadata, deterministic ids per activity).

---

## 8. Import / CSV machinery that already exists

- Parsing: `crates/core/src/activities/csv_parser.rs` (598 lines) — `ParseConfig { delimiter, dateFormat, decimalSeparator, thousandsSeparator, hasHeaderRow, skipTopRows, skipBottomRows, … }` with `effective_delimiter()`, `header_index()`, `top_skip()`, `bottom_skip()`, `quote_byte()`, and `parse_csv(content: &[u8], config: &ParseConfig) -> ParsedCsvResult`; wired into `activities_service.rs` through `parse_csv_stream`-style helpers (`activities_service.rs:2210`, `:6212`).
- Mapping config (`activities_model.rs`): `ImportMapping` (`fieldMappings` where `FieldMappingValue` is either a string or a list of candidate columns, `activityMappings` raw-label → canonical type, `symbolMappings`, `accountMappings`, `symbolMappingMeta`, `parseConfig`), `ImportTemplateData { fieldMappings, activityMappings, symbolMappings, accountMappings, symbolMappingMeta, parseConfig, name? }`, `ImportMappingConfig`, `BrokerActivityProfileConfig`, `BrokerSyncProfileData`, `ImportAssetCandidate`, `ImportAssetPreviewItem/Status`.
- Persistence: `import_templates` (system + user, `kind` discriminates CSV_ACTIVITY / CSV_HOLDINGS / BROKER_ACTIVITY) and `import_account_templates` (`context_kind` + `source_system`), replacing the old per-account `activity_import_profiles`. Four system CSV templates ship in migration `2026-03-19-000001_import_templates`: **Charles Schwab**, **TD WebBroker**, **Trading 212**, **Wealthsimple** — each with real column/action mappings and parse config (e.g. Schwab `skipTopRows: 1, skipBottomRows: 1`, TD `dd MMM yyyy`, Wealthsimple ISO8601).
- Import execution: `activities_service.rs` — `import_activities` (5464), `check_import`-style validation, `prepare_new_activity` (2553), `prepare_update_activity` (3019), `prepare_activities_for_save/import/sync` (6283–6301), `prepare_activities_internal` (6445); idempotency via `activities/idempotency.rs` and `activities.idempotency_key` (unique partial index) + `source_system/source_record_id` (index `ix_activities_source_identity`); review flags `needs_review`, `status`, `is_user_modified`; run bookkeeping in `import_runs`; transfer pairing in `activities/transfer_pairs.rs` (`getTransferPair`, `findTransferMatchCandidates`, `linkTransfer`/`unlinkTransfer` host APIs).
- Holdings-mode imports: snapshot CSV/bulk path (`SnapshotHoldingInput`, `checkImport`, `importSnapshots` in the addon API; `portfolio/snapshot/holdings_import_validation.rs`, `manual_snapshot_service.rs`).
- Quote imports: `crates/core/src/quotes/import.rs` (1076) — `QuoteImport`-style records with `is_importable/is_duplicate/is_invalid`, `parse_date`, `parse_day`, OHLCV helpers, duplicate detection; `import.rs` also supports addon/API-driven `quotes.update`.
- Frontend: `apps/frontend/src/pages/activity/import/` (mapping hooks `use-import-mapping.ts`, `use-activity-import-mutations.ts`, utils `activity-type-mapping.ts`, `default-activity-template.ts`, `import-flow-utils.ts`, `idempotency.ts`, `validation-utils.ts`, `asset-review-utils.ts`, `holdings-import-utils.ts`, `date-format-options.ts`, `sample-csv.ts`).
- E2E coverage: `e2e/04-csv-import.spec.ts`, `15-csv-import-currency-resolution.spec.ts`, `13-multi-exchange-import.spec.ts`, `10-symbol-mapping-validation.spec.ts`, `09-bulk-holdings.spec.ts`, `16-final-cash-policy.spec.ts`, with fixtures in `e2e/fixtures/*.csv`.

---

## 9. Test and CI infrastructure

Commands (root `package.json`, `AGENTS.md`):

| task | command |
|---|---|
| TS unit tests | `pnpm --filter frontend exec vitest run` (`pnpm test`); config in `apps/frontend/vite.config.ts` → Vitest `globals: true`, `environment: "jsdom"`, `setupFiles: ./src/test/setup.ts`, `include: src/**/*.{test,spec}.*` |
| TS format/lint/types | `pnpm check` = `pnpm format:check && pnpm lint:quiet && pnpm type-check`; `pnpm lint` = frontend ESLint + `pnpm -r lint`; `pnpm build:types` builds package declarations |
| Web build | `pnpm build` (BUILD_TARGET=web) |
| Tauri frontend build | `pnpm build:tauri` |
| Rust focused tests | `cargo test --locked -p <crate> <filter>` |
| Rust compile gate | `cargo check --locked -p wealthfolio-app -p wealthfolio-server` |
| E2E | `pnpm test:e2e` (`scripts/run-e2e.mjs`), `pnpm test:e2e:net-worth`, `pnpm test:e2e:addon-sandbox` (`scripts/run-addon-sandbox-e2e.mjs`), `pnpm test:e2e:ui` |

Scale: **3583** `#[test]`/`#[tokio::test]` attributes across **298** Rust files; **313** TS `*.test.ts(x)` files under `apps/frontend/src` and `packages/`; **23** Playwright specs under `e2e/` (top-level specs plus `e2e/addon-sandbox/`, `e2e/net-worth/`, `e2e/profiles/`, ignored per-directory by `playwright.config.ts` and re-enabled by the dedicated configs `playwright.addon-sandbox.config.ts`, `playwright.net-worth.config.ts`, `playwright.profiles.config.ts`; chromium only, `workers: 1` to preserve onboarding-first ordering).

CI: `.github/workflows/pr-check.yml` — change classification (`python3 .github/scripts/ci_changes.py` + unit tests), `formatting` (`pnpm format:check`), frontend job (install → `build:types` → `pnpm lint` → package `type-check` → `pnpm test` → `pnpm build` → Playwright browsers → net-worth + addon-sandbox E2E), Rust job (`rustfmt`, `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`, `cargo test --locked --workspace`, `cargo test --locked -p wealthfolio-ai --features test-utils`, `cargo check --locked -p wealthfolio-server --release`), plus Android/iOS cross-checks and translation parity (`node apps/frontend/scripts/check-translations.mjs`). Other workflows: `build-linux/windows/android/mobile.yml`, `docker-publish.yml`, `release.yml`, `cache-warm.yml`, `http-client-policy.yml`, `native-secret-store.yml`, `server-secret-store.yml`.

---

## 10. Reuse / Extend / Replace (for a TypeScript/Node reimplementation reusing this vocabulary)

| capability | verdict | note |
|---|---|---|
| Table/entity vocabulary (`accounts`, `assets`, `activities`, `quotes`, `holdings_snapshots`, `daily_account_valuation`, `lots`, `snapshot_positions`, `taxonomies`, `import_*`, `budget_*`) | **Reuse as-is** | 56-table shape and the 14 activity types / 4 account types are self-consistent and machine-checked here; copy names and column semantics including TEXT decimals. |
| `activities.activity_type` closed set + `activity_type_override`/`source_type`/`subtype` layering | **Reuse as-is** | The override/raw-label split is what makes broker + CSV ingestion survivable. |
| `assets` v2 identity (`kind` / `instrument_type` / `symbol` / `exchange_mic` / generated `instrument_key` / `provider_config`) | **Reuse, must reimplement** | Concept is right; the generated STORED column and Yahoo-suffix→MIC table (`.TO`→`XTSE` …) must be re-coded in TS (SQLite generated columns or app-side normalisation). |
| Holdings JSON + relational dual-write (`holdings_snapshots.positions` + `snapshot_positions`) | **Extend** | The dual-write is transitional here (comments say a later PR switches reads); a fresh implementation should go relational-only and skip the JSON blob. |
| `daily_account_valuation` as derived read model with `value_status`/`basis_status`/`*_base` columns | **Reuse as-is** | Clear contract, rebuildable, deliberately excluded from sync. |
| Net worth algorithm (account valuations + alternative assets + credit-card sign split) | **Reuse the concept; reimplement** | ~1100 lines of Rust with subtle rounding/expiry/dust rules; port the ordering and the rounding-before-zero-check detail, not the class structure. |
| FX handling (FX as `assets`, rates as `quotes`, nearest-date fallback, minor-unit multipliers) | **Reuse as-is** | The "FX is just an asset with quotes" decision is the key simplification; keep `convert_currency_for_date`. |
| Lot/disposal engine (FIFO, split_ratio, base + account currency, `tax_allocated`) | **Reuse the data model; replace the engine** | Schema is good; only FIFO is actually implemented here (`ensure_supported_for_calculation` rejects LIFO/WAC), so a TS engine starts from the same contract with no behavioural debt. |
| market-data registry (priorities, capabilities/coverage, circuit breaker, rate limiter, validator, per-request fallback) | **Reuse the concept; reimplement** | Provider list is small (Yahoo, Alpha Vantage, MarketData.app, Finnhub, Boerse Frankfurt, US Treasury calc, Metal Price API, OpenFIGI, custom scraper) and each provider is separate code; the registry/`RetryClass`/`SkipReason` diagnostics pattern is worth copying. |
| Resolver (Yahoo suffix ↔ ISO MIC, symbol rules per instrument kind) | **Extend** | `exchanges.json` + suffix logic is portable data; the rules do not cover every venue (see `XNEO`→`NEOE` fix). |
| Addon system (manifest, permission categories, static detection, iframe sandbox, host-brokered network/secrets/storage) | **Reuse the concept; reimplement** | The permission taxonomy and the `allow-scripts`-only iframe + postMessage host API are directly portable to a browser/Node host; the install/store/zip/verify plumbing is substantial and would need re-writing. |
| Connect/broker sync (`import_runs`, `brokers_sync_state` checkpoints, readiness gates, read-only direction) | **Extend** | Reuse the run/checkpoint/review vocabulary; the actual broker access is a hosted service (SnapTrade/Plaid upstream), so a TS project needs its own aggregator or must build per-broker connectors. |
| Import templates + CSV machinery (field/activity/symbol/account mappings, `parseConfig`, system templates) | **Reuse as-is** | Well-specified JSON config; the four system templates (Schwab, TD, Trading 212, Wealthsimple) are copy-ready fixtures. |
| Spending/budget tables + `scope='activity'` taxonomies + categorization rules | **Reuse as-is** | The "spending is a taxonomy scope, not a parallel category table" decision is the main thing to keep. |
| Device sync (E2EE outbox/entity-metadata/applied-events + `sync_table_state` allowlist) | **Replace** | Deeply tied to this project's encryption/key-versioning and CRDT-ish metadata; only the *shape* (outbox + per-entity last-op metadata + derived tables excluded) is worth borrowing. |
| Test/CI layout (Vitest jsdom unit tests, 3.5k Rust tests, Playwright with separate addon-sandbox/net-worth/profiles configs, `pnpm check`) | **Reuse as-is (structure)** | The multi-config Playwright split and the "derived read models rebuild instead of migrate" discipline are portable practices. |

## 11. Searched for and NOT found (do not invent these)

- **No `property`, `liability`, `vehicle` or `collectible` tables.** Real estate, vehicles, collectibles, precious metals and debts are `assets.kind` values (`PROPERTY, VEHICLE, COLLECTIBLE, PRECIOUS_METAL, LIABILITY, OTHER`); there is no separate property/liability entity anywhere in `crates/storage-sqlite/migrations/*/up.sql`.
- **No `valuations` table** other than `daily_account_valuation`; no `asset_valuations`/`manual_valuations` table.
- **No `exchange_rates` table** after migration `2025-01-27-000001_migrate_fx_to_quotes` (dropped; FX lives in `assets` + `quotes`).
- **No `settings` table** (dropped 2024-09-21 in favour of `app_settings`) and **no `portfolio_history` table** (dropped 2025-04-21).
- **No `activity_import_profiles` table** after `2026-03-19-000001` (replaced by `import_templates` + `import_account_templates`).
- **No quote-cache table** (`grep -i 'quote_cache|market_data_cache'` over all migrations: no matches). Quote "caching" is plain persistence in `quotes` plus provider-local in-memory caches.
- **No `broker_connections` / `broker_accounts` / `brokerage_authorizations` table.** Broker connection and account objects come from the Connect API; only `platforms`, `accounts.provider*`, `brokers_sync_state` and `import_runs` are local. No Plaid/SnapTrade-specific tables.
- **No addon secret table** (`addon_storage` holds non-secret KV; secrets go to `SecretStore`), and no addon *marketplace* tables in SQLite (store listings are fetched over HTTP).
- **No order/trade-execution surface**: no `place_order`/`submit_order` anywhere in `crates/connect`; the integration is read-only ingestion.
- **No `data_source`/provider table for FX beyond `assets.provider_config`** and the `market_data_providers` / `market_data_custom_providers` catalog.
- **No TypeScript/Node valuation implementation** to port from — the net-worth, valuation, lot and FX logic exists only in Rust (`crates/core/src/portfolio/**`, `crates/core/src/fx/**`); the TS side only consumes it through adapters (`apps/frontend/src/adapters/{shared,tauri,web}`).

# Feasibility audit — five external data sources for a read-only wealth dashboard (TypeScript/Node)

Audit date: **2026-09-21** (all "last commit / last release" dates and all live HTTP probes are as of this date).
Method: shallow clones of the real repos into `/opt/data/work/thirdparty/` (`degiro-connector`, `pytr`, `rotki`, `woob`, `degiro-api`, `trade-republic-sdk`, `libdegiro`, `libtraderepublic`), read of source/README/models, plus live `curl` probes of RPC/indexer endpoints and PyPI/npm/GitHub APIs. Nothing below is invented; anything not checked is marked **unverified**.

Probe results quoted inline are real responses I obtained today (HTTP code + body prefix).

---

## 0. Bottom line per source

| Source | Read-only pulls feasible today? | Auth | Write ops in the candidate lib? | Realistic fallback |
|---|---|---|---|---|
| DEGIRO | Yes (unofficial private API, Python lib mature) | username+password (+ TOTP secret or in-app approval), captcha possible | **Yes** (order check/confirm/update/delete) | `Account.csv` export (header confirmed) |
| Trade Republic | Yes (unofficial private API; TS SDK read-only) | phone + PIN + 4-digit code **or** app push approval; AWS WAF for v1 | **Yes** in pytr (`*_order`); **no** in trade-republic-sdk | Official transaction CSV export (23-col schema confirmed) |
| Crédit Agricole / CA Bourse | Accounts + transactions yes; **positions/ISINs no** | 11-digit login + 6-digit code via scrambled keypad, OAuth client flow, captcha possible | No (cragr); linebourse reads orders only | Bank statement/operation export (format **unverified**) |
| Revolut (personal) | **No — blocked without regulated TPP status** | PSD2 requires eIDAS/OBIE cert + AISP registration | n/a | In-app statement export (PDF/Excel per currency) or a licensed aggregator |
| MetaMask / EVM | Yes, free, no auth | none (public addresses) | n/a (read-only provider only) | n/a |

**Cannot be done today without authorized third-party status:** Revolut personal account data via PSD2 (eIDAS/OBIE transport certificate + AISP registration with a national regulator); GoCardless Bank Account Data signups (disabled); Covalent GoldRush free tier (trial only); Etherscan V2 free tier on BNB Chain / Base / OP Mainnet / Avalanche / Gnosis (paid tier only); Crédit Agricole investment positions (no verified open-source module).

---

## 1. DEGIRO

### (a) Candidate projects and real state
| Project | Lang | Licence | Version / last release | Last commit (repo HEAD) | Usable as |
|---|---|---|---|---|---|
| `Chavithra/degiro-connector` | Python (≥3.10) | BSD-3-Clause | 3.0.36 @ 2026-05-26 (PyPI) | 2026-05-26 (`22691b5e…` "Update pyproject.toml") | library + examples; 293★, 22 open issues, active but slow cadence (3.0.35 2025-11-29 → 3.0.36 2026-05-26) |
| `icastillejogomez/degiro-api` (npm `degiro-api`) | TypeScript/JS | MIT | 1.0.6 @ 2026-05-14 (npm) | 2026-05-14 "v1.0.6 — cosmetic re-publish" | library (backend only, CORS-blocked in browsers); older codebase (2020) with `es6-promise`, `node-fetch`, `isomorphic-fetch` |
| `nyg/libdegiro` (npm) | TypeScript | MIT | 1.0.1 @ 2026-09-05 | 2026-09-06 | library — CSV parser only (`parseDegiroCsv`) |

`degiro-connector` internals verified: `degiro_connector/trading/api.py` (`class API`, `build_action_list()`, `load(action, init_args)`, `setup_all_actions()`, `TRADING_TIMEOUT = 1800`), `core/constants/urls.py` (all endpoint URLs), 43 action modules under `trading/actions/`.

### (b) Authentication model
Single REST login, three variants selected by which credential is present (`trading/actions/action_connect.py::ActionConnect.get_session_id`):
- `POST https://trader.degiro.nl/login/secure/login` — username/password only (works only if the account has no 2FA and no in-app approval).
- `…/login/secure/login/totp` — with `one_time_password` (6 digits, 30 s validity). If you store the **32-character base32 `totp_secret_key`** the library generates the code itself via `pyotp.TOTP(secret).now()`.
- `…/login/secure/login/in-app` — with `in_app_token` (token issued by DEGIRO after a password login; in-app approval flow).

Request model is `Login` in `trading/models/login.py`; response is `LoginSuccess` (carries `session_id`) or `LoginError` (`login_failures`, `captcha_required`, `status`). Credentials model `Credentials` (`trading/models/credentials.py`): `username`, `password`, `int_account`, `totp_secret_key`, `one_time_password`, `in_app_token`; built by `build_credentials(location, override)` from a JSON file or the `DEGIRO_ACCOUNT` env var.

Secrets to store: username, password, `int_account` (integer account id, optional for login), either the TOTP secret (long-lived, enables silent logins → treat as a high-value secret) or the in-app token. Session = `sessionId` reused as `?sessionId=` / `;jsessionid=`.

Unavoidable human / MFA steps (verified error handling in `action_connect.py`):
- `status == 6` → `DeGiroConnectionError('2FA is enabled, please provide the "totp_secret"')`.
- `status == 12` → `DeGiroConnectionError("Open the DEGIRO app … tap 'Yes' to approve it")` — **human required**.
- `login_error.captcha_required` → `CaptchaRequiredError("Login to DEGIRO via the browser and solve the captcha")` — **human required** (one-time browser login to clear it).
With a stored TOTP secret and no captcha, login is fully unattended.

### (c) Read-only data obtainable (verified entry points)
Read actions (of the 43 in `trading/actions/`):
- Accounts/balances/cash: `ActionGetAccountInfo.get_account_info()` (→ `clientId`, currencies; URL `…/trading/secure/v5/account/info/{intAccount};jsessionid={sid}`), `ActionGetClientDetails` (`…/pa/secure/client` → `clientId`, `intAccount`), `ActionGetAccountOverview.get_account_overview(OverviewRequest(from_date, to_date))` (`…/portfolio-reports/secure/v6/accountoverview` → model `AccountOverview.cash_movements: list[CashMovements]` with `balance`, `change`, `currency`, `date`, `description`, `id`, `product_id`, `type`, `value_date`).
- Portfolio / positions / totals: `ActionGetUpdate` with `UpdateRequest(option=UpdateOption.PORTFOLIO | TOTAL_PORTFOLIO | TRANSACTIONS | ORDERS | CASH_FUNDS | HISTORICAL_ORDERS | ALERTS, last_updated)` (`…/trading/secure/v5/update`). Model `AccountUpdate` has `portfolio`, `total_portfolio`, `transactions`, `orders`, `cash_funds`, `historical_orders`. Portfolio rows carry `productId` only → resolve to names/ISINs with `ActionGetProductsInfo` (`…/product_search/secure/v5/products/info`, POST).
- Positions with ISINs as a file: `ActionGetPositionReport.get_position_report(ReportRequest(country, lang, format=Format.CSV|HTML|PDF|XLS, from_date, to_date))` (`…/portfolio-reports/secure/v3/positionReport/{format}` → `Report.content` is the raw CSV/XLS text).
- Cash movements as a file: `ActionGetAccountReport.get_account_report(ReportRequest(...))` (`…/portfolio-reports/secure/v3/cashAccountReport`).
- Transactions: `ActionGetTransactionsHistory.get_transactions_history(HistoryRequest(from_date, to_date, group_transactions_by_order))` (`…/portfolio-reports/secure/v4/transactions`); `HistoryItem` fields include `buysell`, `date`, `quantity`, `price`, `total`, `fee_in_base_currency`, `fx_rate`, `auto_fx_fee_in_base_currency`, `total_fees_in_base_currency`, `product_id`, `transaction_type_id`, `order_type_id`, `trading_venue`, `counter_party`, `transfered`.
- Dividends/income: `ActionGetUpcomingPayments.get_upcoming_payements()` (`…/portfolio-reports/secure/v3/ca/{intAccount}` → `UpcomingPayments(ca_id, product, description, currency, amount, pay_date)`; note the typo'd method name is real); `ActionGetAgenda` (Dividend/Economic/Earnings/Holiday/IPO/Split events); securities-lending income: `ActionGetSecuritiesLending`, `ActionGetSecuritiesLendingReportDate`, `ActionGetSecuritiesLendingReportSnapshot`.
- Orders history: `ActionGetOrdersHistory.get_orders_history(HistoryRequest(...))` (`…/portfolio-reports/secure/v4/order-history`).
- Reference data: product search/lookup/info, `ActionGetCompanyProfile/Ratios/FinancialStatements`, news actions, `ActionGetConfig`.
- Quotes (separate subsystem): `degiro_connector/quotecast/api.py` + `quotecast/tools/chart_fetcher.py|ticker_fetcher.py|ticker_to_df.py` (`ChartFetcher`, `TickerFetcher`; needs the `user_token` = `clientId`).

`degiro-api` (TS) read surface: `getAccountConfig`, `getAccountData`, `getAccountState`, `getAccountReports`, `getAccountInfo`, `getPortfolioRequest`, `getTransactionsRequest`, `getOrdersRequest`, `getHistoricalOrders`, `getCashFunds`, `getProductsByIds`, `searchProduct`, `getNews` (file names in `src/api/`).

### (d) Write capability exposed
Yes, in both libs.
- `degiro-connector`: `ActionCheckOrder`, `ActionConfirmOrder`, `ActionUpdateOrder`, `ActionDeleteOrder` (+ notes/favourites CRUD, `ActionLogout`). There is **no read-only mode**: `API.__init__(preload=True)` instantiates every action via `setup_all_actions()`; instantiation is harmless but the capabilities exist. Avoid by calling only the read action names and never `check_order/confirm_order/update_order/delete_order`; if you want a hard guarantee, wrap the `API` behind an allow-list of method names (e.g. reject anything not in `{get_update, get_account_overview, get_position_report, get_account_report, get_transactions_history, get_orders_history, get_products_info, get_upcoming_payements, …}`), or subclass `API` with `build_action_list()` filtered to read actions.
- `degiro-api`: `createOrderRequest`, `executeOrderRequest`, `deleteOrderRequest` (functions in `src/api/`) — never import them.
- The README carries the author's own warning: “Be careful, DeGiro could block your account if they catch you using automation scripts.”

### (e) Licence
BSD-3-Clause (`degiro-connector`), MIT (`degiro-api`, `libdegiro`). Permissive: vendoring, patching, closed-source reuse all fine; only attribution/no-endorsement obligations. Practical implication: the risk is not legal but operational (private API, ToS).

### (f) Breakage risk + file-import fallback
Risk: **high**. Private API, no official docs, single maintainer, no compatibility promise; DEGIRO changes versions in the URL path (`v3/v4/v5/v6` endpoints) and can add captcha/approval steps. Mitigation: pin a working library version, keep the session alive, alert on login failures.
Fallback: **realistic and documentable.** DEGIRO’s web UI exports `Account.csv`, localised by interface language — verified header strings (from `libdegiro` README):
- FR: `Date,Heure,Date de,Produit,Code ISIN,Description,FX,Mouvements,,Solde,,ID Ordre`
- EN: `Date,Time,Value date,Product,ISIN,Description,FX,Change,,Balance,,Order Id`

Plus Portfolio and Transactions exports (CSV/XLS/PDF), and the API itself can emit Position/Cash CSV/XLS/PDF (`Format.CSV|HTML|PDF|XLS`). `libdegiro` (`parseDegiroCsv`, `parseDegiroFile`, `parseDegiroStream`) turns Account.csv into typed `movements`/`transactions` (fields `side`, `quantity`, `product`, `isin`) with balance reconciliation and portfolio roll-up — i.e. the TS fallback path already exists.

---

## 2. Trade Republic

### (a) Candidate projects and real state
| Project | Lang | Licence | Version / last release | Last commit | Usable as |
|---|---|---|---|---|---|
| `pytr-org/pytr` (repo `marzzzello/pytr`) | Python (≥3.10) | MIT | repo version **0.4.11** (unreleased); PyPI 0.4.10 @ 2026-08-06 | 2026-09-16 `e7f3ba37` "Ignore pending savings plans" | library (`TradeRepublicApi`) + CLI (798★, 34 open issues, commits weekly → actively maintained) |
| `Nils-Fischer/trade-republic-sdk` (npm) | TypeScript | MIT | 0.2.4 @ 2026-09-08 | 2026-09-08 "chore: release v0.2.4" | library — `TRClient` (REST + WebSocket) and `TRAccount` (**read-only projection, "It never writes"**) |
| `aritzmmartinez/libtraderepublic` (npm) | TypeScript | MIT | 0.2.0 @ 2026-09-10 | 2026-09-09 | library — parser of the official CSV export (`parseTransactions` / `parseTransactionsFile` via `libtraderepublic/node`) |
| `nurtrade` (npm) | TypeScript | MIT | 0.1.0 @ 2026-06-24 | — | SDK+CLI "read & trade"; no repository URL on npm → supply-chain caution |
| `milesstoetzner/stoetzms-ghostfolio-importer` | TS | Apache-2.0 | 0.0.1 @ 2024-07-24 | — | PDF-text based importer, stale |

### (b) Authentication model
pytr (`pytr/api.py::TradeRepublicApi`): credentials are **phone number + 4-digit PIN**, read from `~/.pytr/credentials` (line 1 phone, line 2 PIN) or passed explicitly; cookies cached at `~/.pytr/cookies.<phone>.txt` when `save_cookies=True` (`COOKIES_FILE`, `save_websession()`/`resume_websession()`).
- **v1 (default)**: `POST https://api.traderepublic.com/api/v1/auth/web/login` → `processId`, then `…/api/v1/auth/web/login/{processId}/{verify_code}` with the **four-digit code the user receives in the TR app (or SMS)**. v1 requires an **AWS WAF token**, obtained by default through **Playwright** (`_fetch_waf_token_playwright`, optional extra `playwright` + Chromium download) or via the pure-Python `--waf-token awswaf` path, which the README states “has been reported to no longer work reliably”. The README also states TR **removed the SMS resend endpoint** together with the v1 web login, so no SMS fallback under v2.
- **v2 (opt-in `--v2`)**: `POST /api/v2/auth/web/login` → `processId`; poll `…/api/v2/auth/web/login/processes/{processId}`. `requiredAction` distinguishes `AUTHENTICATOR_VERIFICATION` (code from the user's authenticator app) from **push approval in the TR app** (`_await_weblogin_confirmation` polls until CONFIRMED, default 120 s deadline). No WAF token needed.
- Headers pinned in source: `APP_VERSION = "2.2631.13"` (`X-TR-App-Version`), `WEB_PLATFORM = "web-pro"`, a desktop Chrome UA, `_stable_device_id()`, `_timezone_name()`.
- Error map verified: `LOGIN_ERRORS` for `PROCESS_GONE`, `ALREADY_PROCESSED`, `NOT_FOUND`, `TOO_MANY_REQUESTS`, `VALIDATION_CODE_INVALID`, `VALIDATION_CODE_ALREADY_USED`.

trade-republic-sdk: `client.login("+49…", "1234")` then “approve in the Trade Republic app”; the session is **cookies** (`tr_session` JWT) and is exportable/restorable as an opaque string (`client.exportSession()`, `new TRClient({ session })`, `await restored.refresh()`) so subsequent runs need no PIN and no human. Same `/api/v2/auth/web/login` + `processes/{processId}` polling (`status === "CONFIRMED"`) and a device-info header.

Secrets: phone number, PIN, session cookie/JWT. Human steps technically unavoidable: **(1)** the first login of each session/device — 4-digit code typed by the human (v1) or a push/authenticator approval (v2); **(2)** any re-authentication after session expiry. Everything after that can be unattended via the saved cookie/session string. There is no TOTP secret in pytr’s model — the authenticator code path always needs the human.

### (c) Read-only data obtainable
pytr (`TradeRepublicApi` async methods, each a WebSocket subscription topic — names verified in `api.py`):
- `portfolio()` (topic `portfolio`), `compact_portfolio()` (`compactPortfolioByType`, response grouped in `categories[].positions`, each with `isin`/`instrumentId`, quantity, avg cost, net value — fields read in `portfolio.py`), `portfolio_status()`, `portfolio_history(timeframe)` (`portfolioAggregateHistory`, range param), `watchlist()`.
- `cash()` (`cash`), `available_cash_for_payout()`, `cash_available_for_order()` (`availableCash`).
- `timeline()` (`timeline`, `after` cursor), `timeline_transactions()`, `timeline_activity_log()`, `timeline_detail(timeline_id)`, `timeline_detail_v2(timeline_id)`, `timeline_detail_order(order_id)`, `timeline_detail_savings_plan(savings_plan_id)`.
- `order_overview()` (`orders`), `savings_plan_overview()` (`savingsPlans`), `instrument_details(isin)`, `stock_details(isin)`, `instrument_suitability`, `ticker(isin, exchange)`, `performance`, `performance_history`, `search*`, `experience`, `motd`, `neon_cards`.
- Event/transaction typing: `pytr/event.py` — `PPEventType` {`BUY`, `SELL`, `DIVIDEND`, `DEPOSIT`, `REMOVAL`, `INTEREST`, `INTEREST_CHARGE`, `FEES`, `FEES_REFUND`, `TAXES`, `TAX_REFUND`, `TRANSFER_IN`, `TRANSFER_OUT`, `SPINOFF`, `SPLIT`, `SWAP`}, `ConditionalEventType` {`PRIVATE_MARKETS_ORDER`, `SAVEBACK`, `TRADE_INVOICE`}, plus `tr_event_type_mapping` (e.g. `CREDIT → DIVIDEND`, `INTEREST_PAYOUT → INTEREST`, `PAYMENT_INBOUND* → DEPOSIT`, `BANK_TRANSACTION_OUTGOING → REMOVAL`).
- CSV writer: `pytr/transactions.py` — `CSVCOLUMN_TO_TRANSLATION_KEY` = `date, type, value, note, isin, shares, fees, taxes, isin2, shares2`, delimiter `";"` (`csv_delimiter` default), plus JSON export; `pytr/dl.py` writes `account_transactions.csv`, `events_with_documents.json`, `other_events.json` and downloads the PDF documents from the timeline (`dl_doc`).

trade-republic-sdk: `TRClient` topic accessors named after the wire topics — `ticker`, `cash`, `availableCash`, `timelineTransactions`, `orders`, `portfolioStatus`, `savingsPlans`, `watchlists` (registry in `src/topics.ts`, each with a `secured:` flag; secured topics need the session). REST: `client.accountInfo.get()`. `TRAccount` keeps a materialised window: `account.cash.getSnapshot()`, `account.transactions.getSnapshot()` / `.read({from,to})`, `account.documents.getSnapshot()`, `account.sync()`, `account.stop()`; money normalised to integer minor units.

### (d) Write capability exposed
- **pytr: yes.** `limit_order(isin, exchange, order_type, size, limit, expiry, …)`, `market_order(isin, exchange, order_type, size, expiry, sell_fractions, …)`, `stop_market_order(…)` — all send `{"type": "simpleCreateOrder", …}` over the subscription socket; also `add_watchlist`/`remove_watchlist` and the `set_price_alarms` CLI command. Avoid: never call those methods; only use the read methods. There is no built-in read-only flag.
- **trade-republic-sdk: no order topic found.** Grepping `src/` for `simpleCreateOrder`/`createOrder` returns nothing, and the README states `TRAccount` “never writes”. This is the safer read-only base for a TS dashboard.

### (e) Licence
MIT for pytr, trade-republic-sdk, libtraderepublic (PyPI metadata + repo LICENSE). Permissive; attribute and don’t imply endorsement. TR’s own ToS/private-API terms are the real constraint, not the code licence.

### (f) Breakage risk + file-import fallback
Risk: **high and structural** — private API + AWS WAF + app-approval + a pinned `APP_VERSION` that must be bumped when TR rejects stale frontend versions; pytr’s own README warns you “may need to re-authenticate every so often”. Mitigated by pytr’s weekly commit cadence and by the TS SDK’s session-export design.
Fallback: **strong — TR now ships an official CSV export** (“Transaction export” under Statements; launched April 2026; also rolled out as a documented app feature). The file format is documented in `libtraderepublic/SCHEMA.md` from real exports: comma separator, quoted fields, `.` decimal separator (not localised), ISO-8601 **UTC** dates, one header row, **23 columns**: `datetime, date, account_type, category (CASH|TRADING, also seen CORPORATE_ACTION), type, asset_class (FUND|STOCK|CRYPTO|SYNTHETIC), name, symbol (=ISIN, TRADING only), shares, price, amount, fee, tax, currency, original_amount, original_currency, fx_rate, description, transaction_id (UUIDv7), counterparty_name, counterparty_iban, payment_reference, mcc_code`. Verified `type` values: `BUY, SELL, CARD_TRANSACTION, CARD_TRANSACTION_INTERNATIONAL, TRANSFER_INSTANT_INBOUND, TRANSFER_INSTANT_OUTBOUND, TRANSFER_DIRECT_DEBIT_INBOUND, INTEREST_PAYMENT, DIVIDEND, BENEFITS_SAVEBACK`. Sign convention: money out negative; `CARD_TRANSACTION` can be positive (refund) and `DIVIDEND` can be negative (non-EUR rounding). Caveat: the file is not stable (“launched April 2026 and may still change”); amounts are written with inconsistent precision (6 decimals on CASH, 2 on TRADING) → parse as decimal strings, never JS `number`.

---

## 3. Crédit Agricole / CA Bourse

### (a) Candidate projects and real state
| Project | Lang | Licence | Version / last commit | Notes |
|---|---|---|---|---|
| `woob/woob` (gitlab, GitLab-hosted; GitHub mirror `rbignon/woob`) | Python (≥3.9 per pyproject) | repo COPYING = GPLv3, COPYING.LESSER = LGPLv3; PyPI `LGPL-3.0-or-later`; individual modules declare `LGPLv3+` | repo HEAD 2026-09-13 `3bc0f159`; **PyPI 3.7 released 2024-10-29** | 294 modules; library + CLI; module `cragr` is the Crédit Agricole backend |
| `modules/cragr` (`CreditAgricoleModule`, `CreditAgricoleBrowser`) | Python | LGPLv3+ | in-tree, updated for the new API (comments reference 2026) | `CapBank` only: `iter_accounts`, `iter_history`, `iter_coming` |
| `modules/linebourse` (`LinebourseModule`, `LinebourseAPIBrowser`) | Python | LGPLv3+ | in-tree | the CA/BP/CE brokerage space (`offrebourse.com`): `iter_investments`, `iter_history`, `iter_market_orders`; **not wired into cragr** |

### (b) Authentication model (cragr, verified in `browser.py`)
Two-stage, all cookies/XSRF + OAuth-client emulation:
1. `GET https://espace-client.credit-agricole.fr/assets/configuration/app-config.json` → `client_id`; `…/bff/api/security/user` → `state`/`csid` (must be reused — a fabricated state yields “Identifiants de session invalides”); then `…/bff/api/context/sso/v1`.
2. OAuth “authorize” against `https://client.ca-connect.credit-agricole.fr`: `/authorize` → `/bff/api/context` → `/bff/api/authentication/username` (JSON `{username}`) → `/bff/api/authentication/keypad` → `/bff/api/authentication/login` with `{identifiant, liste_touches}` where `liste_touches` is the **6-digit code re-encoded through the scrambled keypad** (`KeypadPage.build_password`). Every request needs the `x-xsrf-token` header (read from the `XSRF-TOKEN` cookie) plus `x-auth-login` and a `corr_id` UUID on ca-connect hosts.
3. `POST /bff/api/security/login` with the returned `code`/`state` to open the client session; per-account details need a **second** OAuth flow via `…/bff/api/context/sso/v1` → `detail-dav.<region>` (`/bff/security/login`, `/bff/context`, then `/bff/operations/imputees` and `/bff/operations/a-venir/detail`).

Config (module `CONFIG`): `website` (must be one of 39 regional `www.ca-<region>.fr` hosts), `login` = „Identifiant à 11 chiffres“ (regex `\d{11}`), `password` = „Code personnel à 6 chiffres“ (regex `\d{6}`). Secrets in practice: the two credentials (note the login ID is stored in the *password* config slot), the regional host, and the session cookies/XSRF token.

Unavoidable human step: a **“Friendly captcha” may appear** — the code raises `ActionNeeded("Friendly captcha detected, please authenticate manually on the website once to disable it")`. There is no TOTP/app-approval factor in the module.

### (c) Read-only data obtainable — and the hard gap
Available (verified):
- `iter_accounts()` — iterates families `COMPTES`, `EPARGNE`, `CREDITS`, `PLACEMENTS` via `/bff/api/synthesis/contract/data?code_grande_famille=…`; `AccountsPage.iter_accounts` builds woob `Account` objects (label via `Coalesce`, `obj__id_element_contrat`, balance, currency, type). ASSURANCES is deliberately skipped (id collision with the deposit account).
- `iter_history(account)` — only for `Account.TYPE_CHECKING` and `Account.TYPE_SAVINGS`; drives the detail-dav flow and repeatedly calls `/bff/operations/imputees` (cumulative, ~90 operations per call, `MAX_HISTORY_CALLS = 50`), yielding `TransactionItem`s: `obj_amount` (`montant`), `obj_label` (operation label, date suffix stripped), `obj_category` (extra reference, feeds OFX MEMO), `obj_type` (from `libelleTypeOperation`), `obj_date` (`dateOperationAffichee`, French long dates), `obj_rdate` (`dateValeurAffichee`).
- `iter_coming(account)` — pending operations (`/bff/operations/a-venir/detail`).

**Gap:** `iter_investment(account)` returns `[]` with the comment “Non porté : nécessite un compte d’investissement (AV/PER) pour être implémenté et testé sur la nouvelle API”. `grep` confirms `modules/cragr` never imports `LinebourseAPIBrowser`, and `CreditAgricoleModule` implements only `CapBank` (no `CapBankWealth`). By contrast `modules/bp` and `modules/caissedepargne` do implement `CapBankWealth` and delegate to `LinebourseAPIBrowser` — so the capability exists in-tree, it is simply **not implemented for Crédit Agricole**. Practical answer: **CA Bourse / CA securities positions with ISINs are not obtainable from any verified open-source project today**; the two paths are (i) build the linebourse delegation for cragr yourself (the bp module is the working reference), or (ii) parse bank-issued statements (see (f)).

`linebourse` (if you build the wiring) gives exactly what a wealth view needs: `iter_investments(account_id)` → woob `Investment` (`code` + `code_type` `ISIN`/`AMF`, `label`, `quantity`, `unitprice`, `unitvalue`, `valuation`, `vdate`, `diff`, `diff_ratio`, `portfolio_share`, `srri`, `original_currency`, …), `iter_history` (12-month window, ms timestamps in the URL path), `iter_market_orders` (the order book, `/rest/carnetOrdre/...`). Endpoints: `https://www.offrebourse.com/rest/premiereConnexion`, `/rest/compte/liste/vide/0`, `/rest/portefeuille/{CRY…}/vide/true/false`, `/rest/historiqueOperations/rwd2/{code}/{start}/{end}/7/1`, `/rest/carnetOrdre/{code}/segmentation/{index}/2/1`.

### (d) Write capability exposed
`cragr` exposes no write capability (no `CapTransfer`, no payment methods). `linebourse` contains only read URLs; `/rest/carnetOrdre…` is read of orders (“carnet d’ordres”), not order placement. No signing/transfer code found in either module.

### (e) Licence
Woob core: GPLv3 / LGPLv3 (PyPI reports `LGPL-3.0-or-later`); modules declare `LGPLv3+`. Practical implication: **copyleft**. You may call it as a library under LGPL (dynamic linking / separate process is the safe pattern) but you may not copy module code into a proprietary closed-source artifact without complying with LGPL (and the core modules that are GPL allow even less). Recommendation for a TS/Node dashboard: run woob as a **separate Python sidecar process** invoked over CLI/JSON (a clean process boundary), or re-implement the HTTP flow from scratch after reading the module for protocol knowledge (protocol facts are not copyrightable, code is).

### (f) Breakage risk + file-import fallback
Risk: **medium-high**. The bank’s BFF API changed recently (the module was rewritten for it) and the login flow is multi-stage OAuth with CSRF tokens; captchas intermittently block automation. Woob releases are rare (3.7 in Oct 2024) but the repo itself is active, so unless you pin/patch from git you may be using an old snapshot.
Fallback: **partially verifiable.** Crédit Agricole’s web space offers account operation downloads and relevés (PDF) per account, and the woob module’s own OFX/CSV exporters exist in `woob/applications/bank`. The exact CA export columns (CSV) are **unverified** in this audit — treat “download operations as CSV from the CA web space and import” as likely but requiring a 10-minute manual confirmation in the user’s own account. Note the OFX/CSV exporter in woob reads `obj.category` for the MEMO field, which is the shape the module already produces, so a CSV importer in the dashboard maps cleanly onto the same fields (date, rdate, label, amount, category, type).
PSD2 alternative (see §4): an AISP gives balances + transactions for the CA current/savings accounts (verified today by querying the public Algolia index that backs `enablebanking.com/open-banking-apis`, index `banks`, country FR: 48 hits matching “Agricole”, of which **40 carry `open_banking.status.production == "available"`** — e.g. “Crédit Agricole Alpes Provence”, “…Champagne-Bourgogne”, “…Nord de France”, “…Sud Rhône-Alpes”, almost all with `scopes: ["aisp","pisp"]`; cragr itself lists 39 regional hosts). But **AIS is payment-account data: no positions, no ISINs**.

---

## 4. Revolut

### (a) Candidate projects and real state
There is **no usable read-only personal-account library**. What exists:
| Project | Lang | Licence | Last activity | Applicability |
|---|---|---|---|---|
| `Trevypants/pyrevolut` (PyPI `pyrevolut` 0.9.1) | Python | MIT | released 2024-06-10 | **Revolut *Business* API** only (`Client`, `AsyncClient`, `client.Accounts.get_all_accounts()`); cert + JWT creds; effectively unmaintained |
| `moraki-finance/revolut-connect` | PHP | not checked | last commit 2024-08-12 | Business API (added `Transfer`); Business-only |
| `ShufflePerson/RevolutInternalAPI` | Python | not checked | — | unofficial internal API via phone+pin; scraping, unsupported; **not verified further** |
| `@revolut/revolut-x-api`, `@revolut/revolut-x-cli` | TS | Revolut-issued | 2026-09-04 | Official **Revolut X (crypto exchange)** API/CLI — “credentials authorize real trades”; irrelevant to personal wealth and dangerous if misused |
| `@revolut/checkout`, `@revolut/revolut-payments-core`, `revolutcardapi` | JS/TS | mixed | — | Payments/cards, not account aggregation |
| Merchants/business REST + CSV reports | — | ToS | current | Business accounts only |

### (b) Authentication model
Three real options, two of which are closed to individuals:
1. **Revolut Open Banking API (PSD2)** — official, and the only sanctioned read route. Production access requires a **valid eIDAS or OBIE transport certificate** and registration as a **regulated TPP (AISP/PISP)**: “To access our Open Banking API, you must use a valid eIDAS certificate or Open Banking (OBIE) certificate to register your application for production.” Token endpoint: `POST https://oba-auth.revolut.com/token` (`grant_type=client_credentials`, `scope=accounts`, mTLS with `transport.pem` + private key); sandbox equivalent at `sandbox-oba-auth.revolut.com` with test certs. Then DCR (`/register` with a pre-built JWT), `/distinguished-name`, and a consent/authorisation-code flow with SCA. **Not achievable for a personal dashboard.**
2. **Aggregators** (licensed AISPs that already hold the certificates): Enable Banking (self-serve, “Restricted Production” lets you link **your own** accounts without a contract/KYB — verified in their FAQ), GoCardless Bank Account Data (**no longer an option**: `https://bankaccountdata.gocardless.com/new-signups-disabled` returns “New signups for Bank Account Data are currently disabled.”), Plaid/Teller/Yapily (sandbox or US-focused).
3. **Manual app export** — no API key at all: Statements are generated in-app per currency as **PDF or Excel** (help page: tap Accounts → currency → More (…) → Statement → timeframe → “PDF or Excel” → Generate).

Secrets if you take route 2: aggregator application ID + your own **RSA private key** (Enable Banking builds a JWT signed with it — `openssl genrsa -out private.key 4096`, upload a self-signed cert, then `Authorization: Bearer <JWT>`); plus the per-bank consent. Human steps: unavoidable — the bank consent/SCA redirect must be performed by the user in their app/browser, and PSD2 consents expire (Revolut/aggregator typically ~90 days), so periodic re-consent by the human is structural.

### (c) Read-only data obtainable
Via an aggregator (Enable Banking endpoint surface verified from their API reference): `GET /aspsps` (bank list + auth methods), `POST /auth` (returns redirect URL), `POST /sessions`, then `GET /accounts/{account_id}/details`, `/accounts/{account_id}/balances`, `/accounts/{account_id}/transactions`, `/accounts/{account_id}/transactions/{transaction_id}`. Data = account holder name, IBANs, **current and available balances**, transactions with date, counterparty/merchant, description, amount. GoCardless’s own coverage sheet lists Revolut entities `REVOLUT_REVOLT21` (countries incl. FR), `REVOLUT_REVOGB21`, `REVOLUT_REVODEB2XXX`, each with 730-day maximum transaction history. Enable Banking’s public catalogue lists Revolut in 30 EEA countries including FR with AISP+PISP `production: available` (queried today).
**Not obtainable via PSD2 AIS:** Revolut stock/crypto/commodity positions, ISINs, holdings valuations — PSD2 account information covers payment accounts, not investment portfolios, and neither aggregator exposes an investments endpoint (Enable Banking’s reference has no such path).
Business-only extra (not applicable to personal): `GET /accounts`, `/accounts/{id}`, bank details, counterparties, FX rates, payment drafts, payouts — via OAuth JWT + certificate (`pyrevolut` shows the credential shape: `certificate.public/private`, `client_assert_jwt`, `tokens.access_token/refresh_token`).

### (d) Write capability exposed
Not applicable to any read path. The Revolut **X** CLI/SDK does place real trades, and the Open Banking API includes PIS (payment initiation) plus a Business `Transfer` capability — if you ever touch those SDKs, restrict to read scopes (`scope=accounts`).

### (e) Licence
`pyrevolut` MIT (PyPI). Aggregator SDK terms are commercial (Enable Banking: volume-based pricing, quote via sales; restricted production for own accounts). Licence is not the blocker for Revolut — regulation is.

### (f) Breakage risk + file-import fallback
Risk: **regulatory, not technical**. A personal project cannot hold the certificates; aggregator routes can change pricing/eligibility (the Nordigen shutdown is the precedent) and consent expiry forces recurring human action. Rate limits for AIS aggregators can be as low as **4 API calls/day per account** (GoCardless docs; GoCardless also announced its own 10/day per access scope cap) — fine for a daily-refresh dashboard, fatal for intraday polling.
Fallback: **realistic** — the in-app per-currency statement export (PDF/Excel). It is manual and per currency, and the exact column layout of the Excel/CSV file is **unverified** in this audit (Revolut’s help page documents only PDF or Excel, generated per currency account, containing holder details, BIC/IBAN, balance summary, pending/completed/reverted transactions, pocket transactions). Business accounts additionally offer CSV, CAMT.053 and MT940 — personal accounts: PDF/Excel only per the public help documentation.

---

## 5. MetaMask / EVM wallets (read-only on-chain)

### (a) Recommended approaches and real state (probed 2026-09-21)
**Public JSON-RPC nodes** (no key, `eth_blockNumber` results in brackets):
- Working: `https://mainnet.base.org` (`0x313612f`), `https://arb1.arbitrum.io/rpc` (`0x1e3ee359`), `https://mainnet.optimism.io` (`0x95ea2c4`), `https://bsc-dataseed.binance.org` (`0x7579084`), `https://api.avax.network/ext/bc/C/rpc` (`0x5b6437c`), `https://ethereum-rpc.publicnode.com`, `https://polygon-bor-rpc.publicnode.com`, `https://base-rpc.publicnode.com`, `https://arbitrum-one-rpc.publicnode.com`, `https://optimism-rpc.publicnode.com`, `https://bsc-rpc.publicnode.com`, `https://avalanche-c-chain-rpc.publicnode.com`, `https://rpc.flashbots.net` (Ethereum).
- **Not working today**: `https://eth.llamarpc.com` (HTTP 525), `https://rpc.ankr.com/eth` (“Unauthorized: You must authenticate your request with an API key”), `https://polygon-rpc.com` (403 “API key disabled”), `https://cloudflare-eth.com` (refused both `eth_blockNumber` and `eth_getBalance` with -32046/-32603). Note rotki’s shipped `rotkehlchen/data/nodes.json` still defaults to `cloudflare-eth.com`, `rpc.ankr.com/eth`, `nodes.mewapi.io/rpc/eth` — i.e. its default node list is partly stale. Do not copy node lists; probe at build time.

**Blockscout (free, keyless, Etherscan-compatible)** — verified live:
- `GET https://eth.blockscout.com/api/v2/addresses/{addr}` → 200 `{"block_number_balance_updated_at":…,"coin_balance":"…","ens_domain_name":"vitalik.eth",…}`
- `GET https://eth.blockscout.com/api/v2/addresses/{addr}/token-balances` → 200 array of tokens with `address_hash`, `decimals`, `exchange_rate`, `holders_count`, `icon_url`, name/symbol.
- Etherscan-compatible v1: `GET https://eth.blockscout.com/api?module=account&action=txlist&address=…&page=1&offset=2&sort=desc` → 200 `{"message":"OK","result":[{"blockHash":…,"gas":…,"gasPrice":…}]}`; `action=tokentx` → 200 with `value`, `contractAddress`, `tokenDecimal`, etc.
- Instances confirmed: `eth.`, `base.`, `arbitrum.`, `polygon.` blockscout.com → 200 directly; `optimism.` and `gnosis.` return 301 (follow redirects → 200). No `bnb.`/`bsc.`/`avalanche.` Blockscout host exists (404).
- **Blockscout PRO** (`https://api.blockscout.com/{chainId}/api`, plus `/json-rpc`) **requires an API key** — 401/402 without one (so rotki skips it: `RemoteError('Blockscout has no API key configured…')`). rotki supports Blockscout on ETH, OP, POLYGON_POS, ARBITRUM_ONE, BASE, HYPERLIQUID, GNOSIS, SCROLL, ROBINHOOD, INK (`BLOCKSCOUT_SUPPORTED_CHAINS` in `types.py`), pagination limit 10 000, self-imposed 10 rps.
- Rate limits: no documented hard cap on the free public instances; rotki conservatively assumes 10 rps / burst 20.

**Etherscan V2** — `https://api.etherscan.io/v2/api` with `chainid=…`. Verified today: **no key → 200 with `{"status":"0","message":"NOTOK","result":"Missing/Invalid API Key"}`** (so a key is mandatory; rotki ships its own `ROTKI_PACKAGED_KEY` which you must not reuse). Free tier per docs: **3 calls/second, 100 000 calls/day, selected chains only**. Critically, the chain table states **BNB Smart Chain (56), Base (8453), OP Mainnet (10), Avalanche C-Chain (43114), Gnosis (100) are Paid Tier Only**, while Ethereum (1), Polygon (137), Arbitrum One (42161) are Free Tier. Endpoints used: `module=account&action=txlist|txlistinternal|tokentx|balance`, `module=proxy&action=<method>`, `module=block&action=getblocknobytime`, `tokenbalance`, `getlogs`. Pagination limit 1000.

**Routescan** — `https://api.routescan.io/v2/network/mainnet/evm/{chainId}/etherscan/api`, free tier accepts **any placeholder key** (`apikey=placeholder`) or none (verified: chainid 1 → `{"status":"1","message":"OK","result":"6712603153701629485"}`; 43114 → OK). Deviancy found today: **chainid 10, 56, 8453, 42161 and 137 all returned `{"status":"0","message":"chain not supported"}`** on this public endpoint — i.e. only Ethereum and Avalanche C-Chain worked, which contradicts rotki’s in-code comment that Optimism is supported. Pagination ceiling 10 000 (`PageNo × Offset` window error); rotki assumes 10 rps / burst 20.

**Alchemy** — key required. Free plan: 30 M Compute Units/month (Alchemy FAQ). Token API: `alchemy_getTokenBalances` (“returns ERC-20 token balances for all tokens the given address has ever…”). rotki uses the Prices API: `https://api.g.alchemy.com/prices/v1/{api_key}/tokens/{endpoint}` with network slugs `eth-mainnet, arb-mainnet, base-mainnet, polygon-mainnet, bnb-mainnet, avax-mainnet, zksync-mainnet, scroll-mainnet, gnosis-mainnet, fantom-mainnet, arbnova-mainnet, polygonzkevm-mainnet` (`rotkehlchen/externalapis/alchemy.py`).

**Infura** — key required; free tier **3 000 000 daily credits, 500 credits/second** (Infura docs / MetaMask help).

**Covalent GoldRush** — **not free**: 14-day trial (25k credits), then $10/mo or $250/mo; an x402 pay-per-call path exists. Licences/keys aside, it is a paid dependency today.

**The Graph** — hosted-gateway queries need an API key (`https://gateway-arbitrum.network.thegraph.com/api/<key>/subgraphs/id/<id>`, the URL shape rotki builds in `externalapis/graph.py`); Subgraph Studio Free Plan = 100 000 queries/month for the testing environment. Useful only for specific protocol subgraphs, not for generic wallet balances/history.

**Dune** — free plan API: 40 requests/minute (docs table also lists 15 rpm “low limit”); result exports consume credits (20 credits/MB on Free). Good for ad-hoc queries, not for a live dashboard.

### (b) Authentication model
None needed for addresses (they are public). The only secret is a provider API key (Etherscan/Alchemy/Infura/The Graph/Covalent). Human steps: none. **Never** load a private key or seed phrase: use the address only (rotki’s model is watch-only addresses — `BlockchainAccounts` holds address tuples per chain, no key material anywhere).

### (c) Concrete read-only data
- Native balances: `eth_getBalance` on any working RPC; Blockscout `coin_balance`; Etherscan `action=balance`.
- ERC-20 balances: Blockscout `/api/v2/addresses/{a}/token-balances` (keyless, verified) or Etherscan `tokenbalance` / Alchemy `alchemy_getTokenBalances`; symbol/decimals resolution needs a token registry (CoinGecko free demo tier 30 calls/min ≈ 0.5 rps — verified in rotki’s `coingecko.py` comment — or a local list).
- Transaction history: `txlist` (normal), `txlistinternal` (internal), `tokentx` (ERC-20 transfers) from Etherscan V2 (key, chain limits above) or Blockscout v1 (keyless). Do **not** rely on ERC-20 `Transfer` events alone: internal transfers and contract-generated transfers only appear via these indexers (this is exactly why rotki classifies the first activity it finds as TRANSACTIONS/TOKENS/BALANCE — `HasChainActivity` in `etherscan_like.py`).
- Gas: `gas`, `gasPrice`, `gasUsed` are in the tx rows / receipts; rotki turns the transaction fee into its own FEE event.
- Logs/decoding input: `eth_getLogs` (RPC) or `module=logs&action=getLogs`; approval/swap/DeFi interpretation requires your own decoder layer (rotki’s protocol decoders are the reference).
- Multi-chain coverage summary for the six requested chains: Ethereum ✔ (Blockscout keyless + Etherscan free + Routescan free + RPC), Arbitrum One ✔ (Blockscout keyless + Etherscan free + RPC), Optimism ✔ (Blockscout keyless with redirect + RPC; Etherscan paid; Routescan public endpoint refused today), Base ✔ (Blockscout keyless + RPC; Etherscan paid), Polygon ✔ (Blockscout keyless + Etherscan free + RPC), BNB Chain partial (RPC only keyless; Blockscout host absent; Etherscan paid; Routescan refused), Avalanche C-Chain partial (RPC keyless; Routescan free works; no Blockscout host; Etherscan paid).

### (d) Write/signing capability
None required and none should exist in the dashboard. If you use `viem`/`ethers`, restrict to `PublicClient`/`JsonRpcProvider` reads; never construct a wallet from a private key, never call `sendTransaction`/`signMessage`. rotki itself only ever signs locally for optional features (`user DB`, wallet connection via WalletConnect) — not part of the data path.

### (e) Licences
Indexers/providers: Etherscan, Alchemy, Infura, The Graph, Covalent, Dune are commercial services governed by ToS (rate limits, no resale, attribution rules) — not code licences. Blockscout’s software is open source (AGPL-family) but the hosted API is a service with its own terms; PRO requires a key. **rotki is AGPL-3.0** (verified: `LICENSE.md`), so its code may **not** be copied into a proprietary TS/Node app — use it as a conceptual reference only, which is what this audit recommends.

### (f) Rate limits and breakage
Etherscan free 3 rps / 100k per day; Infura 3 M credits/day; Alchemy 30 M CU/month; CoinGecko demo 30/min; Dune free 40 rpm; Blockscout/Routescan unofficial (~10 rps assumed, shrink on 429 — the pattern in `etherscan_like.py::_maybe_paginate` and `TokenBucket.shrink_after_429`). Breakage risk: **medium** — free tiers tighten (Etherscan moved BNB/Base/OP/Avax to paid, Covalent’s free tier disappeared, public nodes rot), so make the provider layer pluggable with per-chain fallbacks ordered keyless-first (Blockscout → Routescan → public RPC → keyed provider), and cache aggressively.
Fallback: none needed (public chains are always reachable via *some* RPC), but keep a local CSV/JSON snapshot of decoded events so a provider outage doesn’t blank the dashboard.

### (g) How rotki structures on-chain accounting (conceptual model to imitate — do not copy code)
Verified class/field names in the rotki tree:
- **Assets**: a canonical `Asset` identified by a string `identifier`; EVM tokens are `EvmToken` with a parent `chain_id` and address (identifier built by `evm_address_to_identifier` in `rotkehlchen/assets/utils.py`); resolution through an `AssetResolver` backed by a global DB; per-chain address→identifier mapping is the join key everywhere.
- **Events** (the core abstraction): `HistoryBaseEntry` = `group_identifier`, `sequence_index`, `timestamp` (ms), `location`, `event_type`, `event_subtype`, `asset`, `amount` (`FVal` decimal), `location_label` (account), `notes`, `identifier`, `extra_data`. One on-chain transaction becomes **one group** (the tx hash) containing several sequenced events.
- **Event taxonomy**: `HistoryEventType` = TRADE, STAKING, DEPOSIT, WITHDRAWAL, TRANSFER, SPEND, RECEIVE, ADJUSTMENT, INFORMATIONAL, MIGRATE, RENEW, DEPLOY, FAIL, LOSS, MINT, BURN, MULTI_TRADE, MARGIN, TRANSACTION_TO_SELF, EXCHANGE_ADJUSTMENT, EXCHANGE_TRANSFER; `HistoryEventSubType` = REWARD, DEPOSIT_ASSET, REMOVE_ASSET, FEE, SPEND, RECEIVE, APPROVE, AIRDROP, BRIDGE, GOVERNANCE, NONE, GENERATE_DEBT, PAYBACK_DEBT, RECEIVE_WRAPPED, RETURN_WRAPPED, DONATE, NFT, PLACE_ORDER, LIQUIDATE, INTEREST_PAYMENT, CANCEL_ORDER, REFUND, BLOCK_PRODUCTION, MEV_REWARD, APPLY, UPDATE, CREATE, ATTEST, PAYMENT, GRANT, INTEREST, CASHBACK, HACK, CLAWBACK, DEPOSIT_FOR_WRAPPED, REDEEM_WRAPPED.
- **Decoding** happens in `EVMTransactionDecoder` (with per-protocol decoders and a `counterparties()` concept), turning raw txs/receipts/logs into those events; gas is emitted as its own event with `event_subtype=HistoryEventSubType.FEE` (see `chain/evm/decoding/decoder.py`).
- **Swaps** are first-class: `SwapEvent` / `evm_swap.py` with typed `extra_data`, and the accounting layer treats a swap as a `MULTI_TRADE`/`TRADE` across two asset legs.
- **Accounting**: `Accountant` feeds a per-rule-bucket `AccountingPot`; the accounting vocabulary is `AccountingEventType` = TRADE, FEE, ASSET_MOVEMENT, MARGIN_POSITION, LOAN, PREFORK_ACQUISITION, STAKING, HISTORY_EVENT, TRANSACTION_EVENT. Cost basis lives in `accounting/cost_basis`: `BaseCostBasisMethod` (ABC) with `AssetAcquisitionEvent`/`AssetSpendEvent`, `add_in_event()`, `calculate_spend_cost_basis()`, and concrete `FIFOCostBasisMethod`, `LIFOCostBasisMethod`, `HIFOCostBasisMethod`, `AverageCostBasisMethod`; the method is selected by `CostBasisMethod {FIFO, LIFO, HIFO, ACB}` (default **FIFO**). Relevant settings: `include_crypto2crypto` (default True), `taxfree_after_period` (default one year), plus a `rules.py` engine that re-labels events per exchange/protocol.
- **Fees/gas**: separate events, never folded silently into an amount; PNL is tracked per asset and totalled (`accounting/pnl.py` — `PNL`, `PnlTotals`), and reports are exported by `accounting/export/csv.py::CSVExporter` (fields include `timestamp`, free/taxable amounts).
- **Prices**: a separate oracle layer — `PriceHistorian` (historical, at event timestamp) + `Inquirer` (current), backed by Coingecko (free demo tier), Defillama, Cryptocompare, and key-gated Alchemy/Moralis price APIs; missing prices are surfaced as `MissingPrice` rather than guessed.
Imitation plan for the dashboard: (1) store a normalised `events` table keyed by `(chain, tx_hash, sequence_index)` with `(type, subtype, asset, amount:string, timestamp, account, counterparty)`, never raw balances alone; (2) emit gas/fees as their own FEE events; (3) keep prices in a separate `prices` store with historical lookups at event timestamps and explicit “missing price” state; (4) compute cost basis per asset with a pluggable method (start FIFO) over acquisition/spend events, with swaps decomposed into their two legs; (5) keep the asset registry (chain+address → symbol/decimals) as a first-class table, since every join depends on it.

---

## 6. Cross-cutting notes for the TypeScript/Node target

- The TS ecosystem has **no equivalent of woob**; the DEGIRO and TR CSV parsers (`libdegiro`, `libtraderepublic`) are the only first-class TS-side building blocks for banking/brokerage data and they are file-import based. Mixing a Python sidecar (pytr/degiro-connector/woob) with a TS dashboard is the pragmatic architecture: sidecar emits JSON, TS consumes it.
- Licence risk concentrates in **woob (LGPL/GPL)** and **rotki (AGPL-3.0)** — both must be used across a process/service boundary or re-implemented, not copied.
- ToS/regulatory risk concentrates in **Revolut (impossible for a private individual)** and in the *unofficial* broker APIs (DEGIRO/TR), where the libraries themselves warn about account blocking and where MFA/approval steps keep the human in the loop.
- MFA/approval steps that remain human no matter what: DEGIRO in-app approval or captcha (unless the TOTP secret is stored); TR 4-digit code / push approval / authenticator code on every re-login; CA “Friendly captcha” and possibly keypad re-auth; Revolut aggregator consent + SCA and periodic re-consent.
- Recommended reliability ordering per source: CSV/statement import as the always-available baseline; unofficial APIs as an enhancement where they work; licensed aggregator only where it adds real value (CA/Revolut balances and transactions) and never as the only path.

## 7. Explicitly unverified in this audit
- Crédit Agricole’s CSV/statement export column layout (only inferred from the woob module’s transaction fields).
- Revolut personal statement file column layout (help documentation confirms PDF/Excel per currency, not columns).
- Whether Enable Banking coverage of the exact user’s CA regional entity and Revolut entity includes every account type they hold (the catalogue says FR CA entities and Revolut(FR among 30 countries) are in production, but per-account behaviour — e.g. investment sub-accounts — was not testable without credentials).
- Whether Enable Banking’s “Restricted Production” (linking your own accounts) is free of charge — their FAQ says pricing is volume-based with a minimum invoice and does not state that restricted mode is free.
- Whether `linebourse` wiring for cragr can be done without an eligible Linebourse/investment space per account (bp module handles a `LinebourseNoSpace` condition, so some accounts have none).
- Alchemy/Infura token-balance endpoint behaviour on the specific chains required (keys were not available to test); only their documented limits and endpoint names were checked.
- Degiro `ActionGetUpdate` portfolio payload field names (only the wrapper model and productId→ISIN resolution path were verified; the raw payload is `dict`).
- Whether DEGIRO/TR actively rate-limit or block automated logins (only the DEGIRO README’s own warning exists; no first-hand evidence).
- `nurtrade` and `ShufflePerson/RevolutInternalAPI` internals (no repository URL / not cloned).

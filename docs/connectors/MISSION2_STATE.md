# Mission 2 — état des lieux partagé (à lire avant de coder)

Document de coordination : il évite que plusieurs intervenants refassent la même recherche ou
modifient les mêmes fichiers. Les faits ci-dessous sont **vérifiés** (audit du 2026-09-21 sur les
dépôts réels) ; ne pas les redécouvrir, les corriger ici si besoin.

## 1. Faits déjà établis (ne pas refaire)

| Source | Lecture automatique | Authentification | Piège principal |
| --- | --- | --- | --- |
| **DEGIRO** | Oui, API privée non officielle (`degiro-connector`, Python, BSD-3) | identifiant + mot de passe ; TOTP (secret base32) **ou** validation dans l'app ; captcha possible | la bibliothèque expose `ActionConfirmOrder`/`ActionUpdateOrder`/`ActionDeleteOrder` : **aucun mode lecture seule** → liste blanche obligatoire |
| **Trade Republic** | Oui, API privée (`pytr`, Python, MIT) | téléphone + PIN + code 4 chiffres **ou** approbation dans l'app ; WAF AWS | `pytr` expose `market_order`/`limit_order` → ne jamais appeler ; le SDK TS `trade-republic-sdk` n'a **aucun** topic d'ordre |
| **Crédit Agricole** | Comptes + opérations oui ; **positions/ISIN non** | identifiant 11 chiffres + code 6 chiffres via pavé chiffré, flux OAuth | `woob.cragr` : `iter_investment()` renvoie `[]` (non porté) ; LGPL/GPL → sidecar séparé uniquement |
| **Revolut** | **Non** (PSD2 exige certificat eIDAS + agrément AISP) | consentement SCA humain + re-consentement | aucun stockage d'information de paiement ; pas de scraping |
| **EVM** | Oui, sans clé | aucune | `cloudflare-eth.com`, `eth.llamarpc.com`, `rpc.ankr.com`, `polygon-rpc.com` sont **hors service** ou exigent une clé (vérifié) |

## 2. Points d'entrée vérifiés (EVM, vérifiés le 2026-09-21)

- Blockscout **sans clé** : `eth.blockscout.com`, `base.blockscout.com`, `arbitrum.blockscout.com`,
  `polygon.blockscout.com` (200) ; `optimism.blockscout.com` (301 → 200 avec redirection).
- RPC **sans clé** : `mainnet.base.org`, `arb1.arbitrum.io/rpc`, `mainnet.optimism.io`,
  `bsc-dataseed.binance.org`, `api.avax.network/ext/bc/C/rpc`, `*.publicnode.com`, `rpc.flashbots.net`.
- Etherscan V2 palier **gratuit** : Ethereum, Arbitrum, Polygon uniquement (3 req/s, 100 000 appels/jour).
  **Base, BNB Chain, Optimism, Avalanche = palier payant** → Blockscout est la seule voie gratuite.
- Routescan gratuit : Avalanche vérifié ; les autres chaînes refusent sur le chemin documenté.

## 3. Conventions à respecter (non négociables)

1. **Read-only absolu** : aucune méthode d'achat/vente/ordre/virement/signature, nulle part.
2. **Aucune seed, aucune clé privée** : ni en base, ni en configuration, ni en test.
3. **Aucune donnée mockée présentée comme réelle** : les mocks servent aux tests ; l'interface doit
   dire « non configuré », « validation requise », « jamais testé contre le service » quand c'est le cas.
4. **Rien n'écrit en base hors de `IngestService`** : un connecteur produit des objets normalisés.
5. **Pas de doublon** : identifiant externe prioritaire, empreinte déterministe en repli.
6. **Aucun secret dans les logs** : passer par `redact()` et `scrub()`.
7. **Statuts d'erreur** : utiliser `ConnectorError` avec un `kind` ∈ {`AUTH_REQUIRED`,
   `MFA_REQUIRED`, `SESSION_EXPIRED`, `RATE_LIMITED`, `PROVIDER_BROKEN`, `PROVIDER_DOWN`,
   `SYNC_ERROR`, `NETWORK`, `DATA`, `NOT_SUPPORTED`} — l'interface en dérive un message propre.

## 4. Répartition des fichiers (éviter les collisions)

| Périmètre | Propriétaire |
| --- | --- |
| `apps/api/src/db/migrations.ts`, `app.ts`, `routes/{auth,wealth,admin}.ts`, `services/{ingest,sync,portfolio,imports,backup}.ts`, `packages/api-contract/**`, `packages/connectors/src/connector.ts` | **agent principal** (intégration) |
| `packages/connectors/src/evm/**`, `packages/connectors/src/providers/metamask.ts`, `apps/api/src/services/evm*.ts`, `apps/api/src/routes/wallets.ts` | agent « EVM / MetaMask » |
| `sidecar/**`, `apps/api/src/services/sidecar.ts`, `packages/connectors/src/providers/{degiro,trade-republic}.ts` | agent « sidecars DEGIRO + Trade Republic » |
| `packages/connectors/src/providers/credit-agricole.ts`, `docs/connectors/credit-agricole-research.md`, `apps/api/src/routes/manual.ts` | agent « Crédit Agricole » |
| `packages/connectors/src/providers/revolut.ts`, `docs/connectors/revolut-research.md`, `apps/api/src/services/revolut*.ts` | agent « Revolut » |
| `apps/web/**`, `e2e/**`, `playwright.config.ts` | agent « interface + E2E » |

Règle : **ne pas modifier un fichier dont on n'est pas propriétaire**. Si un changement est
nécessaire ailleurs, l'agent exporte une fonction d'enregistrement (ex. `registerWalletRoutes`)
et l'agent principal la branche dans `app.ts`.

## 5. Clés d'API et secrets

- Les clés de fournisseurs (Etherscan, Alchemy, Blockscout PRO...) se placent dans `.env`
  sous la forme `SUIVIINVEST_KEY_<NOM>` (ex. `SUIVIINVEST_KEY_ETHERSCAN_API_KEY=...`).
- Un connecteur les lit via `ctx.secrets.get('<nom>')` : la résolution cherche d'abord un secret
  saisi dans l'interface (chiffré en base), puis la variable d'environnement. Jamais de clé en Git.
- Les identifiants des fournisseurs financiers (DEGIRO, TR, CA) se saisissent dans l'interface et
  sont chiffrés (AES-256-GCM) : ils ne passent **jamais** par `.env`.

## 6. Environnement de test

- `node --test` avec le runtime Node : le TypeScript est exécuté directement (type stripping).
  **Pas d'`enum`, pas de `namespace`, pas de propriétés de constructeur.**
- Aucun test ne doit toucher Internet : utiliser `FakeHttpClient` (connecteurs) ou les fixtures
  locales. Pour les sidecars, fournir un faux exécutable scripté.
- Lancer les tests du paquet concerné, puis `npm test` à la racine pour vérifier l'absence de régression.
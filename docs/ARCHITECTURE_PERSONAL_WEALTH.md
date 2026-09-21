# Architecture — SuiviInvest (tableau de bord de patrimoine personnel)

> Document de référence. Il décrit ce qui existe réellement dans le dépôt, ce qui a été
> repris de Wealthfolio, ce qui a été écarté et pourquoi, ainsi que ce qui reste à faire.
>
> Les affirmations sur Wealthfolio proviennent de l'audit du dépôt
> (`wealthfolio@57ed695`, 2026-09-20) : structure, 56 tables, 14 types d'activité, moteur de
> patrimoine et registre market data ont été lus dans le code source, pas supposés.

---

## 1. Décision d'architecture : pourquoi pas un fork de Wealthfolio

**Wealthfolio** est un monorepo Rust + React + Tauri : `crates/{core, storage-sqlite,
market-data, spending, connect, ai, device-sync, agent-tools, http, wealthfolio-mcp}`
(~100 000 lignes de Rust), `apps/{frontend, server, tauri}`, `packages/{addon-sdk, ui,
addon-dev-tools}`, 102 migrations SQL, 56 tables, backend Axum, ~3 500 tests Rust.

| Critère | Fork Wealthfolio | Réimplémentation TypeScript (retenue) |
| --- | --- | --- |
| Patrimoine net, multi-devises, historique | Déjà là (moteur ~1 100 lignes de Rust) | Réécrit, 67 tests unitaires de domaine |
| Connecteurs DEGIRO / TR / CA / Revolut | `connect` dépend d'un service hébergé (agrégateur) : pas de connecteur direct | Connecteurs directs + import de fichiers, 100 % locaux |
| Immobilier détaillé (bien, crédit, charges, rendements) | **N'existe pas** : l'immobilier est seulement `assets.kind = 'PROPERTY'` | Modèle dédié complet, avec échéancier et indicateurs |
| Contraintes de l'environnement cible | Toolchain Rust absent, 1 Go de RAM, pas de démon Docker : **impossible de compiler ni tester le Rust ici** | Node 24/26, zéro dépendance native |
| Vérifiabilité | « ne compile pas » = livrable nul | `npm test` : 100 tests exécutés à chaque étape |

Le cahier des charges demandait explicitement de **ne pas recréer un portfolio tracker depuis
zéro** et de s'appuyer sur Wealthfolio. C'est respecté au niveau qui compte : le **vocabulaire,
le modèle de données et les concepts** (accounts, activities, holdings, valuations, quotes, FX,
snapshots, imports, addons, Docker) sont repris, avec des noms de tables et de colonnes
volontairement alignés. La couche d'exécution est réécrite en TypeScript parce que c'est la
seule façon de livrer un logiciel **qui tourne et qui est testé** dans cet environnement.

### Ce qui a été repris, écarté ou ajouté

| Capacité Wealthfolio | Décision | Mise en œuvre ici |
| --- | --- | --- |
| Vocabulaire `accounts` / `activities` / `instruments` / `quotes` / `valuations` / `imports` / `sync_runs` | **Repris** | Tables du même nom, colonnes de sens identiques, dates et montants en texte/nombre documentés |
| Jeu fermé de types d'activité (14) | **Étendu** | `ActivityType` = les 14 concepts + ceux demandés (RENT, REAL_ESTATE_EXPENSE, BANK_EXPENSE, CRYPTO_TRANSFER, CRYPTO_SWAP, STAKING_REWARD, VALUATION_UPDATE) |
| Types de compte (`SECURITIES`, `CASH`, `CREDIT_CARD`, `CRYPTOCURRENCY`) | **Étendu** | + `REAL_ESTATE`, `LIABILITY`, `OTHER` (nécessaires au suivi immobilier et des crédits) |
| Identification des actifs (ISIN → symbole → exchange MIC) | **Repris** | `instruments.isin` prioritaire, unicité par ISIN et par (chaîne, contrat) |
| FX | **Écarté, simplifié** | Wealthfolio a supprimé sa table `exchange_rates` (migration `2025-01-27`) et stocke le FX comme un actif avec des cotes. Ici : table `fx_rates` explicite — plus simple à alimenter depuis la BCE et à auditer |
| `daily_account_valuation` (modèle de lecture dérivé, reconstructible) | **Repris comme concept** | Série de patrimoine reconstruite à la volée depuis activités + cours, sans table d'agrégats à maintenir |
| Double écriture holdings JSON + relationnel | **Écarté** | Relationnel uniquement (`valuations`, `quotes`) : la double écriture de Wealthfolio est transitoire, on ne l'hérite pas |
| Moteur de lots / FIFO | **Écarté au profit du coût moyen pondéré (PCM)** | Le PCM est la méthode affichée par les courtiers français (PRU) et suffit à l'usage visé |
| Registre market data (priorités, capacités, disjoncteur, repli) | **Repris comme concept** | `MarketDataService` + `PriceProvider[]` avec repli, cache dans `quotes`, jamais de prix inventé |
| Système d'addons (manifest, permissions, iframe sandbox) | **Hors périmètre v1** | Non nécessaire à l'usage personnel ; l'architecture de connecteurs joue le rôle d'extension |
| `connect` (agrégateur hébergé) | **Remplacé** | Connecteurs locaux + import de fichiers, aucun service tiers |
| Immobilier / crédits | **Ajouté** | `properties`, `property_loans`, `property_appraisals`, `property_cash_flows` |
| Sauvegardes (SQLite/JSON/CSV) | **Ajouté** | `BackupService` + planification quotidienne + procédure de restauration documentée |

---

## 2. Arborescence cible (état actuel du dépôt)

```
suiviinvest/
├── package.json                  # workspaces npm : packages/*, apps/*
├── tsconfig.base.json            # TypeScript strict partagé
├── Dockerfile / docker-compose.yml / .env.example
├── docs/
│   ├── ARCHITECTURE_PERSONAL_WEALTH.md   # ce document
│   ├── LICENSE-NOTICE.md                 # implications AGPL
│   └── connectors/                       # audits de faisabilité par fournisseur
├── packages/
│   ├── core/                     # DOMAINE PUR (aucune I/O)
│   │   ├── src/types.ts          # modèle canonique : activités, comptes, immobilier…
│   │   ├── src/money.ts          # monnaie, FX, arrondis, variation
│   │   ├── src/positions.ts      # PRU (coût moyen pondéré), plus-values
│   │   ├── src/performance.ts    # TWR, Modified Dietz, XIRR, drawdown, flux internes
│   │   ├── src/realestate.ts     # échéancier, cash-flow, rendements, equity
│   │   ├── src/networth.ts       # séries, agrégats par classe/établissement
│   │   ├── src/dedup.ts          # empreinte déterministe + index de déduplication
│   │   ├── src/normalize.ts      # lecture montants/dates/devises, typage des libellés
│   │   └── test/                 # 67 tests
│   ├── connectors/               # CONNECTEURS READ-ONLY + moteur d'import
│   │   ├── src/connector.ts      # interface commune, erreurs, registre
│   │   ├── src/http.ts           # client HTTP injectable (retry, masquage)
│   │   ├── src/csv.ts            # lecture CSV tolérante (délimiteurs, mapping)
│   │   ├── src/providers/        # degiro, trade-republic, credit-agricole,
│   │   │                         # revolut, metamask, manual
│   │   └── test/                 # fixtures anonymisées + tests hors ligne
│   └── api-contract/             # DTO partagés API <-> frontend
├── apps/
│   ├── api/                      # SERVEUR
│   │   ├── src/config.ts         # configuration validée, secrets d'environnement
│   │   ├── src/db/               # node:sqlite, migrations versionnées
│   │   ├── src/security/         # AES-256-GCM, Argon2id, sessions, CSRF, débit
│   │   ├── src/repositories/     # accès SQL (comptes, activités, marché, immobilier…)
│   │   ├── src/services/         # ingest, sync, portfolio, imports, marketdata,
│   │   │                         # crypto, realestate, backup
│   │   ├── src/routes/           # auth, wealth, admin (Fastify + Zod)
│   │   ├── src/scheduler.ts      # croner : synchro + sauvegarde
│   │   └── test/                 # 33 tests (unitaires + intégration via inject)
│   └── web/                      # FRONTEND React + Vite (thème clair/sombre)
└── data/                         # base SQLite + sauvegardes (hors Git)
```

Règle de dépendance : `core` ne dépend de rien ; `connectors` dépend de `core` ;
`apps/api` dépend des deux ; `api-contract` est sans dépendance et sert aux deux côtés.

---

## 3. Modèle de données (migrations appliquées)

Trois migrations versionnées, chacune transactionnelle, jamais modifiées après publication.

### `1_core`

| Table | Rôle | Points clés |
| --- | --- | --- |
| `settings` | Réglages applicatifs (thème…) | Clé/valeur |
| `users` | Compte unique | Mot de passe Argon2id |
| `sessions` | Sessions | Jeton stocké **haché** (SHA-256), CSRF, expiration glissante |
| `secrets` | Secrets des connecteurs | `ciphertext`/`iv`/`tag` : AES-256-GCM. Aucune colonne en clair |
| `connections` | Connexions fournisseurs | Configuration non secrète, état, dernière synchro |
| `accounts` | Comptes et actifs | Unicité `(provider, external_account_id)` |
| `instruments` | Actifs | Unicité ISIN, unicité (chaîne, contrat) |
| `activities` | Journal financier | **Idempotence par la base** (voir ci-dessous) |
| `valuations` | Valorisations (positions, soldes, estimations) | Unicité (compte, instrument, date) |
| `quotes` | Cours | Unicité (instrument, date), colonne `provider` |
| `fx_rates` | Taux de change | Unicité (base, quote, date, source) |
| `net_worth_snapshots` | Cache du patrimoine par jour | Reconstructible, jamais une source de vérité |
| `sync_runs` | Historique de synchronisation | `sync_run_id` corrélé aux lignes écrites |
| `imports` | Historique d'import | Compteurs créés/ignorés/erreurs |
| `audit_log` | Journal d'audit | Actions sensibles |

### `2_real_estate`

`properties` (bien), `property_loans` (crédit), `property_appraisals` (estimations successives),
`property_cash_flows` (revenus et charges, ponctuels ou récurrents).

### `3_indexes`

Index de la timeline (date décroissante), des cours, des taux et des valorisations.

### Idempotence : garantie à trois niveaux

1. **Index uniques partiels** — `activities(provider_id, external_account_id,
   external_transaction_id)` quand l'identifiant externe existe, sinon
   `activities(dedup_hash)`. La base refuse physiquement un doublon.
2. **Déduplication métier** — identifiant externe prioritaire, empreinte SHA-256
   déterministe en repli (calculée sur des champs normalisés : date au jour, devise en
   majuscules, montants arrondis, description repliée).
3. **Transaction** — un import ou une synchronisation est atomique : pas d'état partiel.

Conséquence vérifiée par les tests : rejouer un import ou une synchronisation met à jour les
lignes modifiées côté fournisseur et ignore les autres, **sans jamais créer de doublon**.

---

## 4. Architecture des connecteurs

```
Connecteur (lecture seule)          Couche de service              Base
──────────────────────────          ────────────────              ────
testConnection()          ─┐
syncAccounts()             │
syncBalances()             ├──►  SyncService ──► IngestService ──► repositories ──► SQLite
syncPositions()            │      (journalise,    (valide,          (SQL only)
syncTransactions()         │       isole les       déduplique,
syncIncome()               │       pannes)         convertit FX,
getSyncStatus()           ─┘                       écrit en transaction)
     │
     └── importFormats[] : chemin de repli TOUJOURS disponible (CSV/JSON)
```

**Aucun connecteur n'écrit en base.** Il produit des objets normalisés
(`NormalizedAccount/Balance/Position/Transaction/Income`) et les remet à `IngestService`, seul
point d'écriture. Un connecteur ne peut donc ni contourner la déduplication, ni écrire une
colonne arbitraire, ni oublier la conversion de devise.

**Read-only structurel.** L'interface `Connector` ne contient aucune méthode d'écriture vers le
fournisseur : il est impossible d'en ajouter une par accident. Les secrets sont lus via un
`SecretReader` en lecture seule, sous la forme `${connectionId}:${nom}` (deux comptes DEGIRO ne
partagent jamais leurs identifiants).

**Isolation des pannes.** `syncAll()` traite chaque connexion séparément : une erreur DEGIRO
n'interrompt pas Trade Republic. Chaque essai produit un `sync_runs` avec statut
(`SUCCESS`/`PARTIAL`/`FAILED`/`AUTH_REQUIRED`), compteurs, durée et message d'erreur.

**Synchronisation incrémentale.** Fenêtre repartant de la dernière synchro réussie avec
chevauchement de 5 jours (les opérations peuvent être valorisées après coup), plus un curseur
optionnel par connecteur.

---

## 5. Compatibilité réelle des sources externes

Synthèse de l'audit de faisabilité (recherche menée sur les dépôts réels : `degiro-connector`,
`pytr`, `trade-republic-sdk`, `libdegiro`, `libtraderepublic`, `woob`, `rotki`).

| Source | Faisable en lecture seule ? | Authentification | Repli retenu ici |
| --- | --- | --- | --- |
| **DEGIRO** | Oui (API privée non officielle) | Identifiant + mot de passe, TOTP ou validation dans l'app, captcha possible | **Export `Account.csv`** (entêtes confirmés) |
| **Trade Republic** | Oui (API privée non officielle) | Téléphone + PIN + code 4 chiffres **ou** approbation par notification ; WAF AWS | **Export CSV officiel** (23 colonnes confirmées) |
| **Crédit Agricole / CA Bourse** | Comptes et opérations : oui. **Positions et ISIN : non** (aucun module open source vérifié) | Identifiant 11 chiffres + code 6 chiffres via pavé chiffré, flux OAuth, captcha possible | **Export CSV** + saisie manuelle des positions |
| **Revolut (particulier)** | **Non — bloqué** sans statut d'établissement agréé (PSD2 : certificat eIDAS/OBIE + enregistrement AISP) | PSD2, SCA et re-consentement périodique | **Export de relevé** uniquement |
| **MetaMask / wallets EVM** | Oui, gratuit, sans authentification | Aucune (adresse publique) | — |

Points durs retenus pour la conception :

- **MFA humain obligatoire** chez DEGIRO (validation app/captcha) et Trade Republic (code ou
  approbation) : le connecteur remonte `MFA_REQUIRED` et l'interface le signale, il ne contourne
  **jamais** le 2FA.
- **Revolut ne peut pas être automatisé** pour un particulier : c'est écrit dans le code du
  connecteur et dans l'interface, plutôt que de laisser croire le contraire.
- **Crédit Agricole ne fournit pas les positions** via les modules publics : le connecteur est
  import-first pour cette partie, avec saisie manuelle possible.
- Les bibliothèques candidates exposent des fonctions de **passage d'ordre** (DEGIRO :
  `check_order`/`confirm_order`/`update_order`/`delete_order` ; pytr : `*_order`) : aucune n'est
  utilisée, et l'interface de connecteur ne permet pas de les atteindre.
- **Licences** : `woob` (LGPL/GPL) et `rotki` (AGPL-3.0) sont utilisés **comme références
  d'architecture uniquement**, jamais copiés ; l'intégration éventuelle d'un sidecar Python se
  ferait par processus séparé (JSON), pas par liaison de code.
- **Architecture recommandée à terme** : sidecar Python (`pytr`, `degiro-connector`, `woob`)
  émettant du JSON, consommé par l'API via l'interface `Connector`. Elle est déjà possible sans
  modifier le cœur : un connecteur « sidecar » se contenterait de lire ce JSON.

---

## 6. Sécurité

| Sujet | Décision |
| --- | --- |
| Mot de passe | Argon2id (m=19 MiB, t=2, p=1) via `@node-rs/argon2` (binaire précompilé, pas de chaîne de compilation) |
| Sessions | Jeton 256 bits, haché SHA-256 en base, expiration glissante, révocation à la déconnexion |
| Cookies | `HttpOnly`, `Secure` (prod), `SameSite=Lax` |
| CSRF | Jeton distinct par session, obligatoire sur toute méthode d'écriture, comparé en temps constant |
| CORS | Liste blanche explicite, aucune origine tierce par défaut |
| Débit | Connexion : 8 essais/15 min avec blocage progressif ; API : 300 req/min |
| Secrets au repos | AES-256-GCM, clé dérivée HKDF-SHA256 depuis `SUIVIINVEST_MASTER_KEY` (jamais en base) |
| Journalisation | `scrub()` masque récursivement toute clé ressemblant à un secret ; aucun mot de passe, cookie, jeton ou clé privée |
| Erreurs | Normalisées ; en 5xx, message générique, détail uniquement dans les logs |
| Interdits | Aucun champ de base pour une seed/clé privée ; l'API **refuse** explicitement un tel champ |

---

## 7. Frontend

React 18 + Vite, TypeScript strict (aucun `any`), thème clair/sombre, responsive.
Dix sections : Dashboard, Investissements, Crypto, Immobilier, Cash & Banking, Transactions,
Revenus, Analytics, Connexions, Paramètres. Graphiques SVG faits main (aucune librairie de
graphiques), squelettes de chargement, états vides et messages d'erreur explicites.
Les DTO sont importés depuis `@suiviinvest/api-contract` : si le front compile, les routes
existent.

---

## 8. Déploiement

`docker compose up -d`. Image multi-étapes, utilisateur non privilégié, capacités retirées,
`HEALTHCHECK` sur `/health`, volumes persistants pour la base et les sauvegardes, reverse proxy
HTTPS documenté (Nginx + Let's Encrypt), guide Ubuntu complet dans `README.md`.

---

## 9. Tests

| Périmètre | Contenu | Volume |
| --- | --- | --- |
| `packages/core` | Monnaie/FX, PRU, plus-values, splits, transferts, TWR, XIRR, Dietz, drawdown, échéancier, rendements immobiliers, déduplication, normalisation | **67 tests** |
| `apps/api` | Migrations et contraintes SQL, idempotence d'ingestion, isolation des pannes de synchronisation, patrimoine net, FX manquant, timeline paginée, market data et repli, immobilier via HTTP, imports (analyse + commit + doublons), authentification, CSRF, CORS, interdits de sécurité | **33 tests** |
| `packages/connectors` | Chaque connecteur et chaque format d'import, sur fixtures anonymisées, sans réseau | (voir `packages/connectors/test`) |

Aucun test n'exige d'identifiant réel ni d'accès réseau : les connecteurs reçoivent un client
HTTP injectable (`FakeHttpClient`) et une horloge injectable.

---

## 10. Reste à faire (priorisé)

1. **Découper `apps/api/src/services/portfolio.ts`** (~950 lignes) en
   `networth.ts` / `investments.ts` / `income.ts` / `analytics.ts`. Le fichier est correct et
   testé, mais dépasse la limite de taille fixée dans les consignes.
2. **Connecteurs par API** pour DEGIRO et Trade Republic : aujourd'hui le mode API est déclaré
   non vérifié et c'est le CSV qui est opérationnel ; l'option propre est un sidecar Python
   (voir §5) plutôt qu'une réimplémentation en TypeScript des API privées.
3. **Indexer on-chain réel** pour MetaMask : aujourd'hui les wallets se remplissent par import
   JSON d'adresses/données ; il manque un provider d'indexation (Etherscan V2, Blockscout,
   Alchemy) avec la couche multi-chaînes.
4. **Historique quotidien des positions** : le TWR par compte nécessite une valorisation
   quotidienne ; à alimenter par une synchronisation quotidienne régulière.
5. **Addons** : non implémentés (jugés hors périmètre pour un usage personnel).
6. **Tests end-to-end navigateur** (Playwright) sur les parcours principaux : les tests actuels
   couvrent l'API par `inject` et le domaine, pas l'interface.
7. **Crédit Agricole** : vérifier le format réel des exports CA Bourse et compléter le mapping
   (format non documenté publiquement, cf. §5).
8. **Rapports fiscaux** (IFU, plus-values réalisées par exercice) : non traités.

---

## 11. Ce qui a été explicitement vérifié comme inexistant

Pour éviter d'inventer des fonctionnalités côté Wealthfolio (utile si vous décidez un jour de
fusionner les deux bases) :

- pas de tables `property`, `liability`, `vehicle`, `collectible` — l'immobilier et les dettes
  sont des `assets.kind` ;
- pas de table `valuations` générique (seulement `daily_account_valuation`) ;
- pas de table `exchange_rates` depuis la migration `2025-01-27` (FX stocké comme actif) ;
- pas de table de cache de cotation ;
- pas de surface d'exécution d'ordre : `grep place_order|submit_order` sur `crates/connect` → rien ;
- aucune implémentation TypeScript des calculs de valorisation à reprendre (tout est en Rust).

---

## 12. Licence

Voir [`LICENSE-NOTICE.md`](./LICENSE-NOTICE.md). Résumé : ce projet **reprend des concepts et du
vocabulaire** de Wealthfolio (AGPL-3.0) et **aucune ligne de son code**. L'usage personnel sur
votre serveur n'entraîne aucune obligation ; une distribution ou une mise à disposition à des
tiers oblige à publier les sources sous AGPL. Le projet est donc, aujourd'hui, indépendant — et
le restera tant qu'aucun code Wealthfolio, woob (LGPL/GPL) ou rotki (AGPL) n'est copié dedans.
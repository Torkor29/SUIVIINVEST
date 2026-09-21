# Protocole des sidecars

Document de référence pour les connecteurs qui s'appuient sur une bibliothèque
écrite dans un autre langage (aujourd'hui : **DEGIRO** via `degiro-connector` et
**Trade Republic** via `pytr`, tous deux en Python).

Raison d'être : lier directement ces bibliothèques imposerait leur runtime et leur
licence à toute l'application Node. Le sidecar est donc un **processus séparé** qui
reçoit du JSON et en renvoie. Côté TypeScript, tout passe par l'interface
`SidecarTransport` (`packages/connectors/src/connector.ts`), implémentée par
`apps/api/src/services/sidecar.ts` et fabriquée par
`apps/api/src/services/sidecar-registry.ts`.

Sommaire : [1. Transport](#1-transport) · [2. Requête](#2-requête) ·
[3. Réponse](#3-réponse) · [4. Codes d'erreur](#4-codes-derreur) ·
[5. Opérations](#5-opérations) · [6. Mode HTTP](#6-mode-http) ·
[7. Configuration](#7-configuration) · [8. Secrets](#8-secrets) ·
[9. Lancement et paquets](#9-lancement-et-paquets) · [10. Limites](#10-limites)

---

## 1. Transport

Deux modes, choisis par la configuration :

| Mode | Sélection | Description |
| --- | --- | --- |
| **stdin/stdout** (défaut) | `SUIVIINVEST_SIDECAR_<PROVIDER>_COMMAND` | Un processus est lancé par appel. La requête JSON est écrite sur son entrée standard ; la réponse est lue sur sa sortie standard. |
| **HTTP local** (optionnel) | `SUIVIINVEST_SIDECAR_<PROVIDER>_URL` | `POST` de la même requête JSON ; corps de la réponse = même réponse JSON. Prioritaire sur `_COMMAND`. |

`<PROVIDER>` est le nom du sidecar en majuscules, tout caractère non
alphanumérique remplacé par `_` : `degiro` → `DEGIRO`, `trade-republic` →
`TRADE_REPUBLIC`.

Le transport applique un **délai maximal** (`timeoutMs` de la requête, sinon
`SUIVIINVEST_SIDECAR_<PROVIDER>_TIMEOUT_MS`, sinon 120 s) : le processus est tué
au dépassement. Une réponse vide, non JSON, ou dont la forme est incohérente est
rejetée — aucune donnée n'est devinée.

## 2. Requête

Un objet JSON, écrit en une fois sur stdin (aucun saut de ligne requis) :

```json
{
  "operation": "positions",
  "params": { "intAccount": "12345678", "since": "2026-01-01" },
  "secrets": { "username": "…", "password": "…" },
  "timeoutMs": 120000
}
```

| Champ | Type | Rôle |
| --- | --- | --- |
| `operation` | chaîne | Opération demandée (voir §5). |
| `params` | objet | Paramètres **non secrets** (compte, fenêtre temporelle…). |
| `secrets` | objet | Identifiants nécessaires à l'opération, fournis à la demande. |
| `timeoutMs` | nombre | Délai maximal côté transport, en millisecondes (facultatif). |

## 3. Réponse

Un objet JSON, écrit en une fois sur stdout, terminé par un saut de ligne.

**Succès :**

```json
{ "ok": true, "data": { "positions": [] }, "warnings": ["Prix de marché non récupéré"] }
```

* `data` : **obligatoire**. Objet propre à l'opération (voir §5).
* `warnings` : facultatif, tableau de chaînes ; affiché à l'utilisateur sans faire
  échouer la synchronisation.

**Échec :**

```json
{
  "ok": false,
  "code": "MFA_REQUIRED",
  "message": "Validation Trade Republic requise",
  "requiresUserAction": true
}
```

* `code` : **obligatoire**, l'un des codes du §4.
* `message` : **obligatoire**, phrase compréhensible (pas de trace technique).
* `requiresUserAction` : `true` si réessayer après une action de l'utilisateur a du
  sens (validation mobile, captcha).

Toute réponse ne respectant pas cette forme (champ `ok` absent/non booléen,
`data` manquant malgré `ok:true`, `code` inconnu, JSON illisible) devient
`PROVIDER_BROKEN` côté transport.

## 4. Codes d'erreur

Les codes sont **exactement** les `kind` de `ConnectorError` (voir
`packages/connectors/src/connector.ts`), ce qui garantit la même traduction en
consigne utilisateur dans toute l'application (`SyncService.userActionFor`).

| `code` | Sens | `requiresUserAction` | Exemples de déclencheurs |
| --- | --- | --- | --- |
| `AUTH_REQUIRED` | Identifiants absents ou refusés. | `true` | champs vides, mot de passe rejeté, PIN invalide |
| `MFA_REQUIRED` | Validation humaine nécessaire. | `true` | approbation dans l'app, code TOTP/captcha |
| `SESSION_EXPIRED` | Session/token expiré. | `false` | cookie rejeté (401), session DEGIRO invalide |
| `RATE_LIMITED` | Débit limité par le fournisseur. | `false` | HTTP 429, `TOO_MANY_REQUESTS` |
| `PROVIDER_BROKEN` | Le fournisseur répond mais a changé. | `false` | réponse illisible, champ renommé |
| `PROVIDER_DOWN` | Service injoignable. | `false` | DNS/timeout, délai dépassé |
| `NETWORK` | Problème réseau côté client. | `false` | erreur de socket locale |
| `DATA` | Données inexploitables. | `false` | requête JSON illisible, champ attendu absent |
| `SYNC_ERROR` | Erreur de la synchronisation elle-même. | `false` | réserve |
| `NOT_SUPPORTED` | Opération non supportée par conception. | `false` | bibliothèque absente, opération inconnue |

Un `code` hors de cette liste est refusé par le transport et converti en
`PROVIDER_BROKEN`.

## 5. Opérations

### DEGIRO (`sidecar/degiro/sidecar.py`)

| Opération | `params` utilisés | `data` renvoyé |
| --- | --- | --- |
| `test` | — | `{ "library": "degiro-connector", "readOnly": true }` |
| `accounts` | `intAccount` | `{ "accounts": [{ id, name, currency, type, balance }] }` |
| `balances` | `intAccount`, `since` | `{ "balances": [{ accountId, date, cash, currency }] }` |
| `positions` | `intAccount` | `{ "positions": [{ accountId, productId, isin, symbol, name, quantity, price, currency, kind }] }` |
| `transactions` | `intAccount`, `since`, `cursor` | `{ "transactions": [{ accountId, id, date, type, description, product, isin, quantity, price, amount, currency, fees, taxes }], "cursor": null }` |
| `income` | `intAccount`, `since` | `{ "income": [{ accountId, id, date, type, description, amount, currency, withholdingTax }] }` |

### Trade Republic (`sidecar/trade-republic/sidecar.py`)

| Opération | `params` utilisés | `data` renvoyé |
| --- | --- | --- |
| `test` | — | `{ "library": "pytr", "readOnly": true }` |
| `portfolio` | — | `{ "accounts": [...], "positions": [...] }` |
| `cash` | — | `{ "balances": [{ accountId, date, cash, currency }] }` |
| `positions` | — | `{ "positions": [{ accountId, isin, name, quantity, price, currency, kind }] }` |
| `transactions` | `since` | `{ "transactions": [{ accountId, id, date, category, type, description, name, isin, quantity, price, amount, currency, fees, taxes }], "cursor": null }` |
| `income` | `since` | `{ "income": [{ accountId, id, date, type, description, amount, currency, withholdingTax }] }` |
| `savingsplans` | — | `{ "savingsPlans": [{ id, isin, name, amount, interval, currency, active }] }` |

Les connecteurs normalisent ces objets vers `NormalizedAccount`, `NormalizedBalance`,
`NormalizedPosition`, `NormalizedTransaction` et `NormalizedIncome`, exactement
comme le fait l'import CSV. Le repli CSV reste inchangé.

## 6. Mode HTTP

Si une URL est configurée, le transport n'exécute plus de processus : il envoie la
requête en `POST` (`content-type: application/json`) et lit le corps de la réponse
comme une réponse de sidecar (§3). Le service HTTP doit exposer un endpoint
acceptant ce corps et renvoyant la même enveloppe JSON. Un service qui répondrait
en HTML (page d'erreur d'un reverse-proxy, par exemple) est vu comme
`PROVIDER_BROKEN`.

## 7. Configuration

Variables lues par `createSidecarTransports` (aucun secret ici) :

| Variable | Effet |
| --- | --- |
| `SUIVIINVEST_SIDECAR_<PROVIDER>_URL` | mode HTTP local (prioritaire). |
| `SUIVIINVEST_SIDECAR_<PROVIDER>_COMMAND` | exécutable à lancer. |
| `SUIVIINVEST_SIDECAR_<PROVIDER>_ARGS` | arguments de la commande, tableau JSON (`["sidecar/degiro/sidecar.py"]`). |
| `SUIVIINVEST_SIDECAR_<PROVIDER>_TIMEOUT_MS` | délai maximal par appel. |

`isAvailable()` vaut `true` si l'URL est renseignée ou si le binaire existe
(chemin absolu/relatif vérifié via `fs.existsSync` ; un nom nu comme `python3` est
supposé résolvable dans le `PATH`).

Un sidecar non configuré reste présent dans le dictionnaire retourné : son
`isAvailable()` est `false` et ses appels renvoient `NOT_SUPPORTED` avec un message
expliquant comment l'activer — le démarrage de l'application n'échoue jamais à
cause d'un sidecar manquant.

Quand un sidecar est disponible, la fabrique appelle `configureSidecar()` sur le
connecteur concerné : `capabilities.api` devient `true` (et `positions` aussi, car
l'API fournit des positions absentes des exports CSV). Sans sidecar, ces capacités
restent `false`.

## 8. Secrets

* Les identifiants sont **saisis dans l'interface** et stockés **chiffrés**
  (AES-256-GCM) ; ils sont résolus par le connecteur via `ctx.secrets.get(...)` et
  placés dans le champ `secrets` de la requête.
* Ils **ne passent jamais** par des variables d'environnement, **ne sont jamais
  écrits sur disque** par le transport, et **ne sont jamais journalisés** : le
  transport ne logge que le nom du sidecar et l'opération, et masque toute valeur
  secrète (`scrubSecrets`) dans les messages d'erreur ou les `warnings`.
* Noms logiques lus par les connecteurs (préfixés de l'identifiant de connexion
  côté `SyncService`) :
  * DEGIRO : `degiro_username`, `degiro_password`, `degiro_totp_secret_key`,
    `degiro_one_time_password`, `degiro_in_app_token` ; paramètre non secret
    `degiro_int_account` (dans `config`).
  * Trade Republic : `trade_republic_phone`, `trade_republic_pin`,
    `trade_republic_session`, `trade_republic_verify_code`,
    `trade_republic_two_factor_code`.

### Reprise après validation Trade Republic

Le sidecar `pytr` ouvre la session avec `save_cookies=True` : `pytr` écrit **lui-même**
un fichier de cookies (`~/.pytr/cookies.<téléphone>.txt`). C'est le **seul** état de
session persisté ; **aucun mot de passe n'y figure**. Déroulé :

1. **Premier appel** : si aucune session valide n'existe, `pytr` lance le flux de
   connexion. Quand l'approbation dans l'application mobile est requise et pas
   encore donnée, le sidecar renvoie
   `{ "ok": false, "code": "MFA_REQUIRED", "message": "Validation Trade Republic requise", "requiresUserAction": true }`.
   L'utilisateur approuve la connexion dans l'application.
2. **Appel suivant** : `resume_websession()` rouvre la session à partir du cookie,
   **sans PIN ni validation** ; la synchronisation reprend normalement.

L'approbation est attendue de façon bornée (`params.approvalTimeoutSeconds`, défaut
100 s) : au-delà, le sidecar renvoie de nouveau `MFA_REQUIRED` plutôt que de bloquer
indéfiniment. Prévoir un `timeoutMs` de transport supérieur (`SUIVIINVEST_SIDECAR_TRADE_REPUBLIC_TIMEOUT_MS`).

### Secret TOTP DEGIRO

Une clé TOTP (base32) peut être fournie pour un login sans interaction. Elle est
traitée comme un secret de haute valeur (elle permet des connexions silencieuses) :
elle n'est jamais écrite sur disque par le sidecar et ne doit être stockée que
chiffrée. Aucune MFA n'est contournée : sans clé valide ni validation, le sidecar
renvoie `MFA_REQUIRED`.

## 9. Lancement et paquets

Voir `sidecar/README.md` pour l'installation (`uv venv` + `uv pip install`, ou
`uv pip install --system`) et les exemples de lancement. En résumé :

```
sidecar/requirements.txt      # degiro-connector>=3.0.36 ; pytr>=0.4.10
sidecar/degiro/sidecar.py
sidecar/trade-republic/sidecar.py
```

Sans les bibliothèques, les scripts restent importables et répondent
`NOT_SUPPORTED` en expliquant l'installation à faire.

## 10. Limites et non-vérifié

* Les deux bibliothèques tapent des **API privées non officielles** : elles peuvent
  casser, et leur usage relève des conditions d'utilisation des fournisseurs.
* **Les appels réels à DEGIRO et Trade Republic n'ont pas pu être testés** faute
  d'identifiants : seule la mécanique hors ligne (protocole, erreurs, MFA,
  reprise, normalisation) est couverte par les tests, à l'aide d'un faux sidecar.
  La forme exacte des réponses `get_update` / `compact_portfolio` / timeline reste
  à confirmer sur un compte réel.

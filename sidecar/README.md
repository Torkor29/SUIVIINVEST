# Sidecars DEGIRO & Trade Republic

Les connecteurs **DEGIRO** et **Trade Republic** s'appuient sur des bibliothèques
Python non officielles (`degiro-connector`, `pytr`). Pour ne pas imposer leur
runtime ni leur licence à l'application Node, elles sont appelées dans des
**processus séparés** (« sidecars ») qui échangent du JSON sur stdin/stdout.

Le contrat complet (protocole, codes d'erreur, mode HTTP, variables
d'environnement) est décrit dans [`docs/connectors/sidecars.md`](../docs/connectors/sidecars.md).
Ce fichier-ci ne couvre que l'installation et l'exploitation.

> ## ⚠️ Avertissement
>
> * Ces bibliothèques utilisent des **API privées, non officielles**, sans contrat
>   de stabilité : elles **peuvent casser à tout moment** (endpoint renommé, WAF,
>   version d'application épinglée côté Trade Republic, captcha côté DEGIRO).
> * Leur utilisation relève des **conditions d'utilisation de DEGIRO et Trade
>   Republic**, **à la charge de l'utilisateur**. Un usage automatisé peut
>   entraîner un blocage de compte ; l'auteur de `degiro-connector` le signale
>   lui-même.
> * SuiviInvest reste en **lecture seule** : aucune fonction d'ordre, d'achat, de
>   vente, de virement ou de signature n'est exposée ni appelée.
> * L'import CSV (relevé `Account.csv` DEGIRO, export de transactions Trade
>   Republic) reste **toujours disponible** comme repli, sans Python.

## 1. Installation (uv recommandé)

`pip` n'est pas toujours disponible ; `uv` l'est :

```bash
cd /opt/data/work/suiviinvest

# Environnement virtuel local dédié aux sidecars
uv venv .venv-sidecar
uv pip install --python .venv-sidecar/bin/python -r sidecar/requirements.txt

# (variante « système », CI jetable)
# uv pip install --system -r sidecar/requirements.txt
```

Vérification rapide — sans les bibliothèques le sidecar reste utilisable et
répond proprement `NOT_SUPPORTED` :

```bash
echo '{"operation":"test","params":{},"secrets":{},"timeoutMs":5000}' \
  | .venv-sidecar/bin/python sidecar/degiro/sidecar.py
```

## 2. Lancement manuel

Le sidecar lit **une** requête JSON sur stdin et écrit **une** réponse JSON sur
stdout. Il n'écoute aucun port par défaut.

```bash
# DEGIRO : la liste des opérations est test, accounts, balances, positions, transactions, income
printf '%s' '{"operation":"positions","params":{"intAccount":"12345678"},"secrets":{"username":"u","password":"p"}}' \
  | .venv-sidecar/bin/python sidecar/degiro/sidecar.py

# Trade Republic : test, portfolio, cash, positions, transactions, income, savingsplans
printf '%s' '{"operation":"cash","params":{},"secrets":{"phone":"+33000000000","pin":"0000"}}' \
  | .venv-sidecar/bin/python sidecar/trade-republic/sidecar.py
```

`params.intAccount` (DEGIRO) et `params.approvalTimeoutSeconds` (Trade Republic,
attente de l'approbation mobile, défaut 100 s) sont optionnels.

## 3. Branchement dans SuiviInvest

L'application construit les transports et les injecte au moteur de synchronisation
(`apps/api/src/services/sidecar-registry.ts`) :

| Variable d'environnement | Rôle |
| --- | --- |
| `SUIVIINVEST_SIDECAR_DEGIRO_COMMAND` | exécutable du sidecar DEGIRO (ex. `.venv-sidecar/bin/python`) |
| `SUIVIINVEST_SIDECAR_DEGIRO_ARGS` | arguments JSON, ex. `["sidecar/degiro/sidecar.py"]` |
| `SUIVIINVEST_SIDECAR_DEGIRO_URL` | mode HTTP local (prioritaire sur `_COMMAND`) |
| `SUIVIINVEST_SIDECAR_TRADE_REPUBLIC_COMMAND` / `_ARGS` / `_URL` | idem pour Trade Republic |
| `SUIVIINVEST_SIDECAR_<PROVIDER>_TIMEOUT_MS` | délai maximal par appel |

Exemple :

```bash
export SUIVIINVEST_SIDECAR_DEGIRO_COMMAND="$PWD/.venv-sidecar/bin/python"
export SUIVIINVEST_SIDECAR_DEGIRO_ARGS='["sidecar/degiro/sidecar.py"]'
export SUIVIINVEST_SIDECAR_TRADE_REPUBLIC_COMMAND="$PWD/.venv-sidecar/bin/python"
export SUIVIINVEST_SIDECAR_TRADE_REPUBLIC_ARGS='["sidecar/trade-republic/sidecar.py"]'
```

Dès qu'un sidecar est disponible, `capabilities.api` passe à `true` pour le
connecteur concerné ; sinon il reste `false` et l'interface propose l'import de
fichier.

## 4. Identifiants et sessions

* Les identifiants sont **saisis dans l'interface** de SuiviInvest (chiffrés en
  base, AES-256-GCM) et transmis **dans la requête** au sidecar. Ils ne passent
  **jamais** par `.env`, ne sont **jamais écrits sur disque** par le sidecar et ne
  sont **jamais journalisés**.
* **DEGIRO** : aucun fichier de session n'est conservé ; chaque appel
  réauthentifie. Si DEGIRO demande une validation dans l'application ou un
  captcha, le sidecar renvoie `MFA_REQUIRED` (`requiresUserAction: true`) : il faut
  approuver la connexion (ou résoudre le captcha dans le navigateur), puis relancer.
  Une clé TOTP peut être fournie pour un login sans interaction.
* **Trade Republic** : `pytr` écrit **uniquement** un fichier de cookies
  (`~/.pytr/cookies.<téléphone>.txt`, `save_cookies=True`). Le mot de passe (PIN)
  n'est **jamais conservé en clair** : il n'est utilisé qu'à la première connexion.
  Après une validation dans l'application mobile, la session est reprise
  automatiquement (`resume_websession`) — voir la section « reprise » de
  `docs/connectors/sidecars.md`.

## 5. Fichiers

```
sidecar/
├── requirements.txt
├── README.md
├── degiro/sidecar.py            # opérations test, accounts, balances, positions, transactions, income
└── trade-republic/sidecar.py    # opérations test, portfolio, cash, positions, transactions, income, savingsplans
```

## 6. Ce qui n'a PAS été vérifié

Faute d'identifiants réels, **aucun appel réel à DEGIRO ni à Trade Republic n'a
été exécuté** pendant le développement. Les points suivants sont implémentés
d'après la lecture des bibliothèques mais restent **à confirmer sur un compte
réel** :

* la forme exacte des réponses `get_update` / `compact_portfolio` / timeline et le
  nom des champs normalisés ;
* la pagination et l'enrichissement des mouvements de timeline Trade Republic ;
* le comportement exact du flux d'approbation mobile (`AUTHENTICATOR_VERIFICATION`
  vs approbation « push ») ;
* les seuils de limitation de débit réels des deux fournisseurs.

# SuiviInvest

Tableau de bord de patrimoine personnel, **auto-hébergé** et **strictement en lecture seule** :
actions, ETF, crypto, comptes bancaires, immobilier, crédits, revenus, dépenses, dividendes
et liquidités, réunis dans une seule vue.

> **Lecture seule, par conception.** L'application ne peut ni acheter, ni vendre, ni passer
> un ordre, ni virer des fonds, ni signer une transaction blockchain. Elle ne stocke **aucune**
> seed phrase et **aucune** clé privée — le schéma de base ne prévoit même pas de champ pour
> cela. Un wallet se suit par **adresse publique**.

---

## Sommaire

- [Ce que fait l'application](#ce-que-fait-lapplication)
- [Déploiement sur Ubuntu (pas à pas)](#déploiement-sur-ubuntu-pas-à-pas)
- [Reverse proxy HTTPS (Nginx)](#reverse-proxy-https-nginx)
- [Sécurité](#sécurité)
- [Sauvegarde et restauration](#sauvegarde-et-restauration)
- [Utilisation quotidienne](#utilisation-quotidienne)
- [Développement](#développement)
- [Licence et implications](#licence-et-implications)

---

## Ce que fait l'application

| Domaine | Contenu |
| --- | --- |
| **Dashboard** | Patrimoine net, variations (jour, 1 mois, YTD, 1 an, depuis le début), graphique 1D→MAX, répartition par classe et par établissement |
| **Investissements** | Positions, PRU (coût moyen pondéré), plus-values latentes/réalisées, dividendes, frais, TWR, XIRR, allocation |
| **Crypto** | Wallets par adresse publique, multi-chaînes (Ethereum, Arbitrum, Optimism, Base, Polygon, BNB Chain, Avalanche), tokens ERC-20, gas, staking |
| **Immobilier** | Fiche complète (bien, crédit, revenus, charges), échéancier, rendements brut/net/sur apport, cash-flow, equity |
| **Cash & Banking** | Comptes bancaires, soldes, devise d'origine |
| **Transactions** | Timeline globale filtrable (date, provider, compte, type, devise, montant, recherche), pagination par curseur |
| **Revenus** | Dividendes, intérêts, loyers, staking : par type, par mois, par compte, annualisation |
| **Analytics** | Performance par période et par compte, allocation, risque (drawdown, volatilité, part crypto/immobilier, levier) |
| **Connexions** | État par fournisseur (Connected / Syncing / Synced / Auth requise / Erreur), dernière synchro, historique détaillé, « Synchroniser tout » |
| **Imports** | Assistant complet : détection du format, aperçu, mapping des colonnes, détection des doublons, import idempotent |
| **Paramètres** | Devise de base, thème, fournisseurs de prix, sauvegardes, informations de sécurité |

### Sources de données

| Source | Mode | Statut |
| --- | --- | --- |
| **DEGIRO** | Import de fichier (export `Account.csv`) | Fiable. Entêtes FR et EN gérés (`Date,Heure,Date de,Produit,Code ISIN,…,ID Ordre`) et l'`ID Ordre` sert d'identifiant d'idempotence. L'API privée n'est utilisée que si vous la configurez, et elle est isolée |
| **Trade Republic** | Import de fichier (export CSV officiel) | Fiable. Format officiel à 23 colonnes (`transaction_id` en UUID utilisé pour l'idempotence). L'API non officielle est isolée ; l'authentification exige un code ou une approbation dans l'application |
| **Crédit Agricole / CA Bourse** | Import de fichier + connecteur web | Export du site recommandé (robuste aux refontes). **Les positions et ISIN ne sont pas récupérables** par les modules publics : saisie manuelle ou import de positions |
| **Revolut** | Import du relevé (PDF ou Excel selon la devise) | L'API Open Banking/PSD2 exige un certificat eIDAS et un agrément AISP : **impossible pour un particulier**, donc non contournée. Le connecteur sait aussi ingérer un CSV si vous convertissez le relevé |
| **MetaMask / wallets EVM** | Adresse publique | Aucune connexion permanente requise, aucun secret demandé. 7 chaînes fonctionnent sans clé (nœuds RPC et Blockscout vérifiés) ; Etherscan palier gratuit seulement sur Ethereum, Arbitrum et Polygon |

Chaque connecteur déclare honnêtement ses capacités : l'interface indique « Import de fichiers
uniquement » quand aucune API exploitable n'existe, plutôt que de laisser croire le contraire.


---

## Synchronisation : ce qui remonte tout seul, et ce qui ne peut pas

L'application distingue trois niveaux, et l'interface l'affiche sans détour :

| Niveau | Signification |
| --- | --- |
| **Automatique** | La source est interrogée par l'application et les données remontent seules. |
| **Automatique sous condition** | Une action humaine est nécessaire à chaque session (validation dans l'app du fournisseur, code à usage unique). L'interface affiche « Validation requise » et la synchronisation **reprend après validation**. |
| **Import seul** | Aucun accès automatique légitime n'existe : l'import de fichier est la voie normale, pas un pis-aller. |

### Statuts affichés par source

- **Connecté** — identifiants valides, dernière synchronisation réussie.
- **En cours** — synchronisation en cours, avec progression et compteurs en direct.
- **Synchronisé** — terminé : « 37 transactions récupérées, 12 positions mises à jour, 0 doublon créé ».
- **Validation requise** — une action de votre part est attendue (validation dans l'app, code, captcha). Le message dit précisément quoi faire.
- **Erreur** — message compréhensible ; le détail technique est disponible dans un bloc repliable, jamais affiché brut.
- **Non configuré** — aucun accès enregistré pour cette source.

### Une panne n'empêche pas les autres

« Synchroniser tout » lance chaque source **indépendamment**. Une source en échec, en attente de
validation ou non configurée n'empêche jamais les autres de remonter. Le résumé final liste le
résultat de chacune. Chaque exécution est conservée avec : source, début, fin, statut, éléments
créés, mis à jour, ignorés, code d'erreur et message.

### Positions crypto : la source fait foi

Un portefeuille est observé **par adresse publique**, jamais par clé privée. Or un jeton natif
(ETH, POL…) n'a pas d'adresse de contrat : rejouer l'historique des transactions ne suffit pas à
savoir combien vous détenez, et une transaction entrante seule ne dit pas à quel jeton elle
correspond. L'application applique donc cette règle :

1. la **dernière position communiquée par la source** fait foi (jeton, chaîne, quantité, prix) —
   c'est ce que la vue Crypto et le patrimoine net utilisent ;
2. à défaut seulement, les positions sont **reconstituées depuis l'historique**, valorisées au
   dernier cours connu.

Conséquence assumée : une position sans cours connu est valorisée à la dernière valeur
communiquée par la source, et l'avertissement correspondant est affiché — jamais un zéro silencieux
ni un jeton « — ».

### Relevés et historique : ne pas confondre

- **Historique reconstruit** : recalculé depuis vos opérations et les cours historiques. Utile,
  mais c'est une reconstitution.
- **Relevés enregistrés** : la valeur réellement observée par l'application, un point par jour
  (valeur totale, par compte, par classe d'actif, par établissement, dettes, patrimoine net).

L'interface indique toujours de quoi il s'agit. Aucun relevé n'est inventé : si l'historique
antérieur n'est pas disponible, il est marqué comme reconstruit et rien n'est extrapolé.

### Transfers internes

Un virement entre deux de vos comptes (Revolut → DEGIRO, par exemple) n'est **ni un revenu ni une
performance** : le patrimoine total est inchangé, et seule la répartition par établissement bouge.
C'est vérifié par test de bout en bout.

### Clés d'API et sidecars

Aucune clé n'est obligatoire pour les wallets EVM : les nœuds publics et les explorateurs
Blockscout répondent sans clé. Une clé (Etherscan, Alchemy) améliore la fiabilité de l'historique.

Les sources qui dépendent de bibliothèques non officielles (DEGIRO, Trade Republic) passent par un
**sidecar** : un processus séparé, isolé, qui n'expose que des opérations de lecture. Le détail est
dans `docs/connectors/sidecars.md`, l'activation dans `.env`.

---

## Ce qui n'a pas été vérifié contre un service réel

Par honnêteté, et parce qu'il vaut mieux le savoir avant de compter sur une source :

- Les accès **réels** à DEGIRO, Trade Republic, Crédit Agricole et Revolut n'ont pas pu être
  testés (aucun identifiant personnel disponible). Le code, les interfaces, les formats et les
  cas d'erreur sont couverts par des tests **hors ligne** sur fixtures ; les appels aux services
  eux-mêmes restent à valider lors de votre première connexion.
- Les formats d'export Crédit Agricole et Revolut ne sont pas documentés publiquement : les
  lecteurs sont tolérants et signalent explicitement les colonnes non reconnues, mais un ajustement
  peut être nécessaire au premier import.
- Les fournisseurs d'indexation EVM gratuits limitent l'historique (Etherscan palier gratuit :
  Ethereum, Arbitrum, Polygon uniquement) : sur les autres chaînes, Blockscout est utilisé.

Ces limites sont aussi écrites dans le code, aux endroits concernés.

---

## Déploiement sur Ubuntu (pas à pas)

Testé sur Ubuntu 22.04 / 24.04. Comptez 10 minutes.

### 1. Prérequis

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
# Docker Engine + plugin compose (dépôt officiel)
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo tee /etc/apt/keyrings/docker.asc >/dev/null
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"   # puis reconnectez-vous
```

### 2. Récupérer le code

```bash
sudo mkdir -p /opt/suiviinvest && sudo chown "$USER" /opt/suiviinvest
git clone <URL_DE_VOTRE_DEPOT> /opt/suiviinvest
cd /opt/suiviinvest
```

### 3. Configuration

```bash
cp .env.example .env
# Clé maîtresse : à sauvegarder ailleurs (gestionnaire de mots de passe).
# Sans elle, les identifiants des connecteurs sont irrécupérables.
echo "SUIVIINVEST_MASTER_KEY=$(openssl rand -base64 48)" >> .env
chmod 600 .env
```

Vérifiez dans `.env` : `SUIVIINVEST_COOKIE_SECURE=true` et `SUIVIINVEST_TRUST_PROXY=true`
si vous mettez l'application derrière HTTPS.

### 4. Démarrer

```bash
docker compose up -d
docker compose ps          # le service doit être « healthy »
docker compose logs -f     # logs JSON structurés
```

Ouvrez `http://<IP_DU_SERVEUR>:9123` : la première visite demande de **créer le mot de passe**
de l'application (10 caractères minimum, haché en Argon2id).

### 5. Mise à jour

```bash
cd /opt/suiviinvest
git pull
docker compose build && docker compose up -d
# Les migrations de base s'appliquent automatiquement au démarrage.
```

### 6. Sauvegarde avant mise à jour (recommandé)

```bash
docker compose exec suiviinvest node -e "console.log('voir /backups')"
curl -X POST http://127.0.0.1:9123/api/backup/export   # via l'interface : Paramètres → Sauvegardes
```

---

## Reverse proxy HTTPS (Nginx)

```nginx
server {
    listen 80;
    server_name patrimoine.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name patrimoine.example.com;

    ssl_certificate     /etc/letsencrypt/live/patrimoine.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/patrimoine.example.com/privkey.pem;

    # En-têtes de sécurité
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "same-origin" always;

    client_max_body_size 32m;   # imports CSV volumineux

    location / {
        proxy_pass http://127.0.0.1:9123;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Avec ce montage, exposez le port en local uniquement dans `docker-compose.yml` :
`- "127.0.0.1:9123:9123"`.

Certificat : `sudo certbot --nginx -d patrimoine.example.com`.

---

## Sécurité

| Mesure | Mise en œuvre |
| --- | --- |
| Mot de passe application | Argon2id (m = 19 MiB, t = 2, p = 1) |
| Code de récupération | 100 bits, alphabet sans caractères ambigus, stocké en SHA-256 uniquement |
| Sessions | Jeton aléatoire 256 bits, stocké **haché** (SHA-256) en base |
| Cookies | `HttpOnly`, `Secure` (prod), `SameSite=Lax`, expiration glissante |
| CSRF | Jeton dédié obligatoire sur toute écriture (`x-csrf-token`) |
| CORS | Liste blanche explicite ; aucune origine tierce par défaut |
| Limitation de débit | 8 tentatives de connexion / 15 min avec blocage progressif |
| Secrets des connecteurs | AES-256-GCM, clé dérivée (HKDF-SHA256) de `SUIVIINVEST_MASTER_KEY` |
| Clé maîtresse | Uniquement en variable d'environnement / secret Docker, **jamais en base** |
| Journalisation | Aucun mot de passe, PIN, cookie, jeton ou clé privée ; valeurs sensibles masquées |
| Erreurs | Normalisées, nettoyées : aucun détail interne ni secret dans une réponse |
| Conteneur | Utilisateur non privilégié, `no-new-privileges`, toutes capacités retirées |

### Aucun mot de passe n'est lisible dans la base

C'est vérifié par un test automatique, pas seulement affirmé : `npm run test:api` compare le
contenu réel du fichier SQLite (et de son journal WAL) aux mots de passe et codes utilisés pendant
le test — aucun n'y apparaît. Ce qui est stocké :

| Donnée | Ce qui est écrit en base | Peut-on remonter au secret ? |
| --- | --- | --- |
| Mot de passe | Empreinte **Argon2id** (`$argon2id$v=19$m=19456,t=2,p=1$…`) | Non |
| Code de récupération | **SHA-256** hexadécimal | Non |
| Jeton de session | **SHA-256** du jeton | Non |

Conséquence assumée : **un mot de passe ne peut jamais être relu ni retrouvé**, seulement remplacé
(voir la section suivante). Et une session ou un code volé dans la base ne peut pas être rejoué.

**Interdits structurels.** Aucun champ de base ne peut contenir une seed phrase ou une clé
privée ; l'API refuse explicitement une connexion qui en fournirait une. Aucune méthode
d'achat/vente/ordre/virement n'existe dans le code des connecteurs.

### Bonnes pratiques côté serveur

```bash
sudo ufw allow OpenSSH && sudo ufw allow 443 && sudo ufw enable
sudo apt install -y unattended-upgrades   # mises à jour de sécurité automatiques
```

---

## Sauvegarde et restauration

### Ce qui est sauvegardé

- **SQLite** (`VACUUM INTO`) : copie cohérente, restaurable telle quelle, sans arrêt du service ;
- **JSON** : export complet et versionné, idéal pour migrer ou archiver ;
- **CSV** : un fichier par table, exploitable dans un tableur.

Tables **exclues** volontairement : `secrets`, `sessions`, `users`, `audit_log`.
Une sauvegarde ne contient donc jamais vos identifiants chiffrés — après restauration,
vous re-saisissez les mots de passe des connecteurs (le mot de passe de l'application,
lui, reste dans `users`, qui est… exclu : relisez la ligne suivante).

> ⚠️ **Important.** `users` étant exclu du JSON/CSV, une restauration depuis JSON vous
> demande de recréer le mot de passe de l'application. La sauvegarde **SQLite** (`.db`)
> conserve tout, y compris le compte et les sessions.

### Sauvegarde automatique

Activée par défaut : tous les jours à 3 h 30 (`SUIVIINVEST_BACKUP_CRON`), dans le volume
`suiviinvest-backups`, avec rétention de 30 jours. Pour récupérer les fichiers :

```bash
docker cp suiviinvest:/backups ./sauvegardes-locales
```

### Restauration (procédure complète)

```bash
cd /opt/suiviinvest

# 1. Arrêter l'application
docker compose down

# 2. Vérifier l'intégrité de la sauvegarde choisie AVANT de la restaurer
docker run --rm -v suiviinvest-backups:/backups -v "$PWD":/work node:24-bookworm-slim \
  node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/backups/suiviinvest-AAAAMMJJ.db');console.log(d.prepare('PRAGMA integrity_check').get())"

# 3. Copier la sauvegarde par-dessus la base courante
docker run --rm -v suiviinvest-data:/data -v suiviinvest-backups:/backups alpine \
  sh -c "cp /backups/suiviinvest-AAAAMMJJ.db /data/suiviinvest.db && rm -f /data/suiviinvest.db-wal /data/suiviinvest.db-shm"

# 4. Redémarrer (les migrations éventuelles s'appliquent)
docker compose up -d
docker compose logs -f suiviinvest | head -20
curl -s http://127.0.0.1:9123/health
```

Si `SUIVIINVEST_MASTER_KEY` a changé, les secrets chiffrés deviennent illisibles : l'interface
les signale comme en erreur et vous les ressaisissez. **Conservez la clé maîtresse hors du
serveur** (gestionnaire de mots de passe) : c'est la seule donnée irremplaçable.

### Test de restauration

À faire une fois par trimestre. Une sauvegarde jamais restaurée n'est pas une sauvegarde :

```bash
docker run --rm -v suiviinvest-backups:/backups node:24-bookworm-slim \
  node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/backups/<fichier>.db');for (const t of ['accounts','activities','quotes','properties']) console.log(t, d.prepare('SELECT COUNT(*) c FROM '+t).get().c)"
```

---

## Utilisation quotidienne

1. **Première mise en place** — Paramètres : devise de base, thème.
2. **Connexions** — Ajoutez chaque fournisseur. Pour les sources instables (Crédit Agricole,
   Trade Republic), privilégiez l'import de fichiers : c'est robuste face aux changements
   d'interface ou d'API.
3. **Imports** — « Imports » → déposez l'export → vérifiez l'aperçu et les doublons →
   validez. Importer deux fois le même fichier ne crée aucun doublon.
4. **Immobilier** — Ajoutez chaque bien avec son crédit : l'échéancier, l'equity et les
   rendements sont calculés automatiquement ; les loyers et charges peuvent être récurrents.
5. **Synchronisation** — « Synchroniser tout » déclenche chaque source séparément : une panne
   chez l'un n'empêche pas les autres. L'historique indique pour chacun les éléments créés,
   mis à jour, ignorés et les erreurs.
6. **Prix** — Le rafraîchissement des cours se fait à la demande (Paramètres) ou lors des
   synchronisations ; les prix sont mis en cache par jour (un prix déjà connu le même jour
   n'est pas redemandé). Aucun prix n'est jamais inventé : un cours manquant est signalé dans
   l'interface plutôt que remplacé par une valeur approchée.

---

## Développement

```bash
npm install
npm test          # 255 tests (domaine + connecteurs + API), aucun réseau, aucun identifiant
npm run typecheck # TypeScript strict, aucun `any`
npm run dev:api   # API sur :9123 (rechargement automatique)
npm run dev:web   # frontend Vite sur :5173
```

### Structure

```
packages/core          Domaine pur : monnaie/FX, PRU, performance (TWR, XIRR), immobilier,
                       patrimoine, déduplication, normalisation
packages/connectors    Connecteurs read-only + moteur d'import CSV (frameworks + providers)
packages/api-contract  Types DTO partagés API <-> frontend (source de vérité des échanges)
apps/api               Serveur Fastify : SQLite, sécurité, services, routes, ordonnanceur
apps/web               Frontend React + Vite (thème clair/sombre, responsive)
docs/                  Architecture, notes de conception, veille sur les connecteurs
```

### Tests

```bash
npm test                                  # tout le domaine + connecteurs + API (255 tests)
npm run test:core                         # domaine pur
npm run test:api                          # API + intégration (comptes, récupération, CLI)
node --test apps/api/test/api.test.ts     # un fichier précis
node --test apps/web/test/*.test.ts       # aides d'affichage du front (64 tests)
npm run test:e2e                          # parcours complets Playwright (19 tests)
```

Les connecteurs sont **entièrement mockables** : aucun test n'essaie de vos identifiants
ni d'un accès réseau.

#### Tests de bout en bout (Playwright)

```bash
npx playwright install chromium           # une seule fois
npm run test:e2e
```

Le harnais démarre **seul** l'API et sert le front construit, sur un port libre et avec une base
SQLite temporaire détruite en fin d'exécution : rien n'est écrit dans votre base réelle. Les
connecteurs sont des doublures déterministes (`SUIVIINVEST_E2E_CONNECTORS=1`), refusées en
production. Le front est reconstruit automatiquement s'il est absent **ou périmé** : les parcours
testés sont donc toujours ceux du dépôt.

#### Limites connues de l'outillage (à traiter dans une mission dédiée)

- `npm run lint` ne peut pas fonctionner : le dépôt n'a pas de fichier de configuration ESLint
  (ESLint 9 exige un `eslint.config.js`). `npm run check` échoue donc sur cette étape.
- `npm run format:check` signale ~170 fichiers : le style du code (types union éclatés ligne à
  ligne, listes alignées) diffère volontairement de la sortie Prettier par défaut, et le dépôt
  n'a jamais été passé au formateur. Un `.prettierrc.json` fixe désormais la largeur (120),
  les guillemets simples et les virgules finales ; une passe complète reste à décider avec l'auteur.

Ces deux points sont **antérieurs** à la mission 2 et n'affectent ni le comportement de
l'application ni la suite de tests.

---

## Comptes et récupération d'accès

### Se déconnecter

Le bouton **« Se déconnecter »** de la barre supérieure ferme la session côté serveur (le jeton est
supprimé, pas seulement le cookie) : le lien rejoué depuis un autre onglet ne fonctionne plus.

### Créer un compte

- **Premier compte** : à la première visite, l'application propose de créer le compte. Il devient
  **propriétaire** de l'application.
- **Comptes suivants** : Paramètres → **Comptes** → « Ajouter un compte ». Seul un propriétaire
  connecté peut le faire — il n'existe aucune inscription publique : l'application est exposée sur
  Internet, une page d'inscription ouverte donnerait accès à votre patrimoine à n'importe qui.

> ⚠️ **Les données ne sont pas cloisonnées par utilisateur.** Un compte supplémentaire voit le
> même patrimoine, les mêmes comptes et les mêmes connexions que vous. Créez-en un pour une
> personne de confiance, pas pour « quelqu'un qui peut regarder ».

Dès qu'un compte porte un identifiant, l'identifiant devient obligatoire à la connexion (sinon
l'application ne saurait pas distinguer les comptes). Une installation d'origine — un seul compte
sans identifiant — garde l'écran « mot de passe seul ».

### Mot de passe oublié

Trois chemins, du plus simple au dernier recours :

1. **Code de récupération** (écran de connexion → « Mot de passe oublié ? »). Un code de la forme
   `ABCD-EFGH-JKLM-NPQR-STUV` est remis **une seule fois** à la création du compte, puis à chaque
   changement de mot de passe. Rangez-le dans votre gestionnaire de mots de passe : le serveur n'en
   conserve qu'une empreinte, il est donc impossible de vous le réafficher. Il fonctionne sans
   e-mail, sans téléphone et sans accès au serveur — et il tourne à chaque utilisation.
2. **Depuis l'application** (Paramètres → **Mon mot de passe** → **Nouveau code**), si vous êtes
   encore connecté.
3. **Depuis le serveur**, si le mot de passe ET le code sont perdus :

```bash
docker compose exec suiviinvest node apps/api/src/cli/reset-password.ts --list
docker compose exec suiviinvest node apps/api/src/cli/reset-password.ts --username proprietaire --generate
```

Le mot de passe généré et le nouveau code de récupération sont affichés **dans votre terminal** :
notez-les immédiatement. Sans `--generate`, le CLI demande le mot de passe en saisie masquée (il
n'apparaît ni à l'écran ni dans l'historique du shell).

Tout changement de mot de passe — par l'un des trois chemins — **révoque toutes les sessions** du
compte : un jeton volé ne survit pas à la reprise en main.

---

## Licence et implications

Ce projet s'inspire des concepts et du vocabulaire de
[Wealthfolio](https://github.com/wealthfolio/wealthfolio), distribué sous **AGPL-3.0**.
Voir [`docs/LICENSE-NOTICE.md`](docs/LICENSE-NOTICE.md).

**En résumé :**

- usage **personnel**, sur votre propre serveur, sans distribution → aucune obligation de
  publication ne pèse sur vos modifications ;
- **distribution** de l'application (binaire, image Docker, dépôt public) ou mise à disposition
  comme **service en ligne à des tiers** → l'AGPL vous oblige à fournir le code source complet
  correspondant, y compris les modifications, aux utilisateurs du service ;
- ce projet est une **réimplémentation indépendante** (TypeScript) : il n'embarque pas de code
  Wealthfolio, mais reprend des choix de modélisation. Si vous réutilisez du code Wealthfolio,
  repassez le projet sous AGPL et publiez les sources.
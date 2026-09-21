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
| **DEGIRO** | Import de fichier (CSV officiel) | Fiable. L'API privée n'est utilisée que si vous la configurez explicitement ; elle est isolée et peut casser sans impacter le reste |
| **Trade Republic** | Import de fichier (CSV) | Fiable. L'API non officielle est isolée ; l'authentification peut exiger une validation sur l'application mobile |
| **Crédit Agricole / CA Bourse** | Import de fichier (CSV) + connecteur web | Export CSV recommandé (robuste aux changements de site) ; le connecteur web est marqué comme fragile |
| **Revolut** | Import de fichier (CSV) | Recommandé. L'API Open Banking/PSD2 exige le statut de fournisseur agréé : elle n'est pas contournée |
| **MetaMask / wallets EVM** | Adresse publique | Aucune connexion permanente requise, aucun secret demandé |

Chaque connecteur déclare honnêtement ses capacités : l'interface indique « Import de fichiers
uniquement » quand aucune API exploitable n'existe, plutôt que de laisser croire le contraire.

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
   synchronisations ; les prix sont mis en cache par jour.

---

## Développement

```bash
npm install
npm test          # 100 tests (domaine + API), aucun réseau, aucun identifiant
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
npm test                                  # tout
npm run test:core                         # domaine : 67 tests
npm run test:api                          # API + intégration : 33 tests
node --test apps/api/test/api.test.ts     # un fichier précis
```

Les connecteurs sont **entièrement mockables** : aucun test n'a besoin de vos identifiants
ni d'un accès réseau.

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
# SuiviInvest

Application de suivi de patrimoine, **auto-hébergée** et **strictement en lecture seule**, au
design épuré d'une appli de courtage (clair / sombre, pensée pour le téléphone) :
actions, ETF, crypto, comptes bancaires, immobilier, crédits, revenus, dépenses, dividendes
et liquidités, réunis dans une seule vue.

> **Lecture seule, par conception.** L'application ne peut ni acheter, ni vendre, ni passer
> un ordre, ni virer des fonds, ni signer une transaction blockchain. Elle ne stocke **aucune**
> seed phrase et **aucune** clé privée — le schéma de base ne prévoit même pas de champ pour
> cela. Un wallet se suit par **adresse publique**.

---

## Sommaire

- [Ce que fait l'application](#ce-que-fait-lapplication)
- [Installer ou mettre à jour depuis GitHub](#installer-ou-mettre-à-jour-depuis-github-le-plus-simple)
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
| **Accueil** | Patrimoine net, variations (jour, 1 mois, YTD, 1 an, depuis le début), graphique 1D→MAX, répartition par classe et par établissement |
| **Investissements** | Positions, PRU (coût moyen pondéré), plus-values latentes/réalisées, dividendes, frais, TWR, XIRR, allocation |
| **Crypto** | Wallets par adresse publique, multi-chaînes (Ethereum, Arbitrum, Optimism, Base, Polygon, BNB Chain, Avalanche), tokens ERC-20, gas, staking |
| **Immobilier** | Fiche complète (bien, crédit, revenus, charges), échéancier, rendements brut/net/sur apport, cash-flow, equity |
| **Banque** | Comptes bancaires, soldes, devise d'origine |
| **Activité** | Timeline globale filtrable (date, provider, compte, type, devise, montant, recherche), pagination par curseur |
| **Revenus** | Dividendes, intérêts, loyers, staking : par type, par mois, par compte, annualisation |
| **Analyses** | Performance par période et par compte, allocation, risque (drawdown, volatilité, part crypto/immobilier, levier) |
| **Connexions** | Saisie chiffrée des identifiants, état par source (connecté, en cours, validation requise, erreur), dernière synchro, historique, « Synchroniser tout » |
| **Imports** | Assistant complet : détection du format, aperçu, mapping des colonnes, détection des doublons, import idempotent |
| **Profil** | Nom, identifiant, e-mail chiffré, mot de passe, code de secours, appareils connectés, membres |
| **Paramètres** | Thème, cours de bourse, sauvegardes chiffrées, état de la sécurité et du serveur |

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

### Identifiants, clés d'API et sidecars

Les identifiants DEGIRO (identifiant, mot de passe, clé TOTP facultative) et Trade Republic
(téléphone, PIN) se saisissent dans **Connexions → Connecter** (ou « Modifier les
identifiants » plus tard). Ils sont **chiffrés** (AES-256-GCM) sur votre serveur et ne sont
jamais réaffichés ni renvoyés par l'API.

Ces deux sources passent par un **sidecar** Python (bibliothèques non officielles
`degiro-connector` et `pytr`), un processus séparé qui n'expose que des lectures. **L'image
Docker les embarque et les branche automatiquement** : rien à régler. Trade Republic demande
une validation dans son application mobile à la première synchronisation ; la session
validée est conservée dans le volume de données (`/data/home`) et survit aux mises à jour.
Détails : `docs/connectors/sidecars.md`.

Aucune clé n'est obligatoire pour les wallets EVM : les nœuds publics et les explorateurs
Blockscout répondent sans clé. Une clé (Etherscan, Alchemy) améliore la fiabilité de l'historique.

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

## Installer ou mettre à jour depuis GitHub (le plus simple)

Le serveur suit toujours la branche `main` de GitHub. En SSH (Termius par exemple) :

```bash
curl -fsSL https://raw.githubusercontent.com/Torkor29/SUIVIINVEST/main/scripts/bootstrap.sh | bash -s -- https://VOTRE-ADRESSE
```

- première fois : clone dans `/opt/suiviinvest`, crée `.env` et sa clé maîtresse ;
- dossier copié à la main auparavant : il est relié à GitHub, le `.env` est repris et
  l'ancien dossier conservé en `/opt/suiviinvest.old-<date>` ;
- les données (volumes Docker) ne sont jamais touchées.

Ensuite, à chaque nouvelle version poussée sur GitHub :

```bash
/opt/suiviinvest/scripts/update.sh                 # mise à jour immédiate
/opt/suiviinvest/scripts/update.sh --auto          # ou : automatique, toutes les 15 min
```

### Adresse Cloudflare (tunnel permanent)

Pour une adresse HTTPS publique sans ouvrir de port :

```bash
/opt/suiviinvest/scripts/tunnel.sh
```

Le tunnel tourne dans un conteneur `suiviinvest-tunnel` qui redémarre tout seul (y compris
après un redémarrage du serveur) ; le script affiche l'adresse et la règle dans `.env`.
Une adresse **temporaire** `trycloudflare.com` change quand ce conteneur redémarre :
`./scripts/tunnel.sh --url` l'affiche ; relancer `./scripts/tunnel.sh` ne la change pas si le
tunnel tourne déjà. Si l'adresse ne répond plus (erreur « HTTP 530 » ou site introuvable),
`./scripts/tunnel.sh --new` en crée une nouvelle. L'application
accepte n'importe quelle adresse ; pour une adresse fixe, créez un tunnel nommé rattaché à
votre domaine. Désactivation : `./scripts/tunnel.sh --off`.

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

### 3. Installer et démarrer (une commande)

Depuis votre session SSH (Termius par exemple), dans `/opt/suiviinvest` :

```bash
./scripts/install-server.sh https://patrimoine.mondomaine.fr
```

Le script crée `.env` avec une **clé maîtresse aléatoire** (affichée une seule fois :
copiez-la dans votre gestionnaire de mots de passe), restreint ses droits (`chmod 600`),
construit l'image puis démarre le conteneur et vérifie qu'il répond. Relancé plus tard, il
**conserve** votre `.env` et sa clé : il sert aussi de commande de mise à jour.

L'adresse publique est facultative ; elle est nécessaire pour les liens « mot de passe
oublié » envoyés par e-mail (voir plus bas). Vérifiez dans `.env` :
`SUIVIINVEST_COOKIE_SECURE=true` et `SUIVIINVEST_TRUST_PROXY=true` derrière HTTPS
(mettez `false` si vous accédez temporairement en HTTP par l'IP, sinon la connexion échoue).

### 4. Premier accès

Ouvrez l'adresse de l'application : l'écran **« Créez votre compte »** demande un nom, un
identifiant, un e-mail (facultatif) et un mot de passe (10 caractères minimum). Un **code de
secours** est ensuite affiché une seule fois : rangez-le, il permet de reprendre la main sans
e-mail ni accès au serveur.

Vérifications utiles :

```bash
docker compose ps          # le service doit être « healthy »
docker compose logs -f     # logs JSON structurés
```

### 5. Mise à jour

```bash
cd /opt/suiviinvest
git pull
./scripts/install-server.sh
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
| Adresses e-mail | AES-256-GCM + index aveugle HMAC-SHA256 (recherche sans stocker l'adresse en clair) |
| Liens « mot de passe oublié » | Jeton 256 bits stocké en SHA-256, usage unique, 30 min, aucune énumération de comptes |
| Sauvegardes | Chiffrées sur le disque (AES-256-GCM, fichiers `.enc`) par défaut |
| Appareils connectés | Liste des sessions, fermeture à distance, « déconnecter les autres appareils » |
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
| Adresse e-mail | **AES-256-GCM** (clé hors base) + HMAC | Seulement avec la clé maîtresse |
| Lien de réinitialisation | **SHA-256** du jeton | Non |
| Jeton de session | **SHA-256** du jeton | Non |

Conséquence assumée : **un mot de passe ne peut jamais être relu ni retrouvé**, seulement remplacé
(voir la section suivante). Et une session ou un code volé dans la base ne peut pas être rejoué.

**Interdits structurels.** Aucun champ de base ne peut contenir une seed phrase ou une clé
privée ; l'API refuse explicitement une connexion qui en fournirait une. Aucune méthode
d'achat/vente/ordre/virement n'existe dans le code des connecteurs.

### Ce qui n'est pas chiffré, et comment le couvrir

La base SQLite elle-même (montants, positions, historique) n'est **pas** chiffrée fichier par
fichier : `node:sqlite` ne propose pas SQLCipher. Tout ce qui permettrait d'**accéder** à vos
comptes (mots de passe, identifiants bancaires, e-mails, sessions) l'est, ainsi que les
sauvegardes. Pour chiffrer aussi le reste au repos, activez le chiffrement du disque du
serveur (LUKS à l'installation d'Ubuntu, ou le « chiffrement du volume » de votre hébergeur).

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

### Chiffrement des sauvegardes

Par défaut (`SUIVIINVEST_BACKUP_ENCRYPTION=true`), chaque fichier est chiffré avant d'être
écrit (`suiviinvest-….db.enc`, `.json.enc`, `csv-…/*.csv.enc`) : une sauvegarde copiée hors
du serveur est illisible sans la clé maîtresse. Pour en lire une :

```bash
docker compose exec suiviinvest node apps/api/src/cli/decrypt-backup.ts \
  /backups/suiviinvest-AAAA….db.enc /backups/restauration.db
```

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

# 3. (Sauvegarde chiffrée) la déchiffrer d'abord avec decrypt-backup.ts (voir plus haut),
#    puis copier le fichier .db obtenu par-dessus la base courante
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
npm test          # 263 tests (domaine + connecteurs + API), aucun réseau, aucun identifiant
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
npm test                                  # tout le domaine + connecteurs + API (263 tests)
npm run test:core                         # domaine pur
npm run test:api                          # API + intégration (comptes, récupération, CLI)
node --test apps/api/test/api.test.ts     # un fichier précis
node --test apps/web/test/*.test.ts       # aides d'affichage du front (67 tests)
npm run test:e2e                          # parcours complets Playwright (22 tests)
```

Les connecteurs sont **entièrement mockables** : aucun test n'essaie de vos identifiants
ni d'un accès réseau.

#### Tests de bout en bout (Playwright)

```bash
npx playwright install chromium           # une seule fois
npm run test:e2e
# Chromium déjà installé ailleurs : PLAYWRIGHT_CHROMIUM_EXECUTABLE=/chemin/chrome npm run test:e2e
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

Bouton **« Se déconnecter »** en bas du menu (sur téléphone : onglet **Plus**), dans la barre
du haut, et dans **Profil**. La session est fermée côté serveur (le jeton est supprimé, pas
seulement le cookie). **Profil → Appareils connectés** liste vos sessions et permet d'en
fermer une à distance ou de **déconnecter tous les autres appareils**.

### Le compte

- **Premier compte** : à la première visite, « Créez votre compte » (nom, identifiant, e-mail
  facultatif, mot de passe). Il devient **propriétaire** de l'application.
- **Profil** : nom, identifiant, e-mail (stocké chiffré), mot de passe, code de secours,
  appareils connectés.
- **Connexion** par identifiant **ou** par e-mail.
- **Membres** (Profil, propriétaire uniquement) : il n'existe aucune inscription publique —
  l'application est exposée sur Internet.

> ⚠️ **Les données ne sont pas cloisonnées par utilisateur.** Un membre voit le même
> patrimoine, les mêmes comptes et les mêmes connexions que vous.

Une installation d'origine (un seul compte sans identifiant) continue de fonctionner au mot de
passe seul ; donnez-vous un identifiant dans **Profil** pour passer au fonctionnement normal.

### Mot de passe oublié

1. **Lien par e-mail** — si l'envoi d'e-mails est configuré (`SUIVIINVEST_SMTP_URL`,
   `SUIVIINVEST_MAIL_FROM`, `SUIVIINVEST_PUBLIC_URL` dans `.env`) et qu'une adresse figure sur
   le compte. Le lien est valable 30 minutes, une seule fois, et le message affiché est le
   même que le compte existe ou non.
2. **Code de secours** (écran de connexion → « Mot de passe oublié ? » → « J'ai un code de
   secours »). Remis une seule fois à la création du compte et à chaque changement de mot de
   passe ; réémettable depuis **Profil**. Fonctionne sans e-mail ni accès au serveur.
3. **Depuis le serveur**, si tout est perdu :

```bash
docker compose exec suiviinvest node apps/api/src/cli/reset-password.ts --list
docker compose exec suiviinvest node apps/api/src/cli/reset-password.ts --username proprietaire --generate
```

Tout changement de mot de passe — par l'un des trois chemins — **révoque toutes les sessions**
du compte et invalide les liens de réinitialisation en cours.

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
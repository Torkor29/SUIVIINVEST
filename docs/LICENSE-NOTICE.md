# Licences et implications légales

## 1. Statut de ce dépôt

SuiviInvest est une **réimplémentation indépendante** en TypeScript. Il reprend de Wealthfolio :

- des **concepts** (comptes, activités, positions, valorisations, cotes, FX, snapshots, imports) ;
- du **vocabulaire** (noms de tables et de champs alignés, types d'activité et de compte) ;
- des **décisions d'architecture** documentées dans `ARCHITECTURE_PERSONAL_WEALTH.md`.

Il **n'embarque aucune ligne de code** de Wealthfolio, ni de ses dépendances, ni de ses assets.

## 2. Wealthfolio est sous AGPL-3.0

Wealthfolio est distribué sous **GNU Affero General Public License v3.0**. L'AGPL est une
licence copyleft **avec clause réseau** : l'obligation de publier le code source se déclenche
non seulement à la distribution, mais aussi à la **mise à disposition par réseau**.

### Ce que cela implique concrètement

| Situation | Obligation |
| --- | --- |
| Usage strictement personnel, sur votre serveur, sans y donner accès à autrui | **Aucune obligation de publication.** Vous modifiez, vous gardez. |
| Vous partagez le code (dépôt public, PR upstream) | Vous devez respecter la licence du projet auquel vous contribuez (ici : dépôt public → publication sous AGPL si du code Wealthfolio est présent). |
| Vous distribuez un binaire, une image Docker ou une archive contenant du code Wealthfolio | Fournir le code source complet correspondant sous AGPL, avec les modifications. |
| **Vous donnez accès à l'application sur le réseau** (famille, amis, clients), et elle contient du code Wealthfolio modifié | **Vous devez offrir le code source complet** (y compris vos modifications) aux utilisateurs du service. C'est la clause spécifique de l'AGPL. |
| Vous voulez un jour commercialiser ce tableau de bord | Publier les sources sous AGPL, ou repartir d'une base sans code AGPL. |

### Où en est ce projet aujourd'hui

Ce dépôt ne contient pas de code Wealthfolio : il est donc aujourd'hui **librement modifiable
et utilisable sans obligation de publication**. Deux règles maintiennent cette situation :

1. **Ne pas copier** de code de `wealthfolio/wealthfolio`, ni de ses `crates/` ou `packages/`.
   Reprendre un schéma SQL ou un nom de colonne est une question de modèle de données ; copier
   une fonction Rust ou un composant React en est une autre.
2. **Consigner** toute réutilisation future dans ce fichier avant de la committer.

Si vous décidez de réutiliser du code Wealthfolio (par exemple en forkant le dépôt plutôt qu'en
maintenant cette réimplémentation) : passez le projet sous AGPL-3.0, ajoutez le fichier
`LICENSE` correspondant, conservez les mentions de copyright, et publiez les sources — y
compris pour un usage purement familial en réseau.

## 3. Autres projets étudiés

| Projet | Licence | Usage fait ici | Précautions |
| --- | --- | --- | --- |
| `Chavithra/degiro-connector` | MIT (à revérifier à l'intégration) | Référence pour comprendre les données DEGIRO disponibles | Utilisé via un sidecar en processus séparé si intégré ; jamais copié dans le code TypeScript |
| `pytr-org/pytr` | MIT (à revérifier) | Référence pour Trade Republic | Idem : processus séparé, communication JSON |
| `woob/woob` (module `cragr`) | GPL/LGPL (à revérifier) | Référence pour les capacités Crédit Agricole | Copyleft fort : **ne pas lier** au code applicatif ; sidecar séparé uniquement |
| `rotki/rotki` | AGPL-3.0 | Référence d'architecture pour la comptabilité on-chain | Aucun code copié ; concepts seulement |
| `libdegiro`, `libtraderepublic`, `trade-republic-sdk` | Vérifier par dépôt | Référence pour la lecture des exports CSV | Citation des formats uniquement |

Ces projets sont mentionnés comme **sources d'information**, pas comme dépendances. Aucun n'est
installé, importé ni embarqué par ce dépôt à ce stade.

## 4. Interdits produits (indépendants des licences)

Ces règles sont des contraintes de conception, pas des questions juridiques :

- **Aucune opération financière** : pas d'achat, de vente, d'ordre, de virement, de retrait, de
  signature de transaction. Les bibliothèques qui exposent ces fonctions sont utilisées en
  lecture seule, et l'interface de connecteur du projet ne permet pas de les atteindre.
- **Aucune seed phrase, aucune clé privée** : ces valeurs sont refusées par l'API, absentes du
  schéma de base, et un wallet ne se suit que par **adresse publique**.
- **Aucun contournement de MFA/2FA** : les étapes qui exigent une action humaine (validation
  dans l'application DEGIRO, code Trade Republic, captcha Crédit Agricole) sont remontées à
  l'utilisateur, jamais automatisées.
- **Aucune violation des conditions d'utilisation** des fournisseurs, et aucun contournement des
  limitations d'une API officielle (Revolut/PSD2 en particulier).

## 5. Données personnelles

L'application est conçue pour être auto-hébergée : les données financières ne quittent pas votre
serveur, sauf appels sortants vers les fournisseurs de cours et les sources que vous configurez.
Les sauvegardes excluent volontairement les tables `secrets`, `sessions` et `audit_log`.
Conservez `SUIVIINVEST_MASTER_KEY` hors du serveur : sans elle, les identifiants chiffrés des
connecteurs sont irrécupérables.
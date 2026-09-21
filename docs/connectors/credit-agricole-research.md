# Crédit Agricole / CA Bourse — recherche technique ciblée (Mission 2)

> Recherche demandée explicitement par l'utilisateur, qui ne voulait pas d'un « impossible » trop
> rapide. Ce document distingue **ce qui est vérifié** de **ce qui reste à confirmer**, et donne la
> conclusion opérationnelle : ce qui est implémenté, et ce que l'utilisateur doit faire.

## 1. Ce qui est récupérable aujourd'hui, module par module

### `woob` — module `cragr` (lecture, LGPL/GPL)

| Capacité | État | Détail vérifié |
| --- | --- | --- |
| Comptes et soldes | **Fonctionne** | `iter_accounts()` parcourt les familles `COMPTES`, `EPARGNE`, `CREDITS`, `PLACEMENTS` via `/bff/api/synthesis/contract/data` |
| Opérations | **Fonctionne** | `iter_history()` sur comptes courants et épargne via `/bff/operations/imputees` (~90 opérations par appel) |
| Opérations à venir | **Fonctionne** | `iter_coming()` via `/bff/operations/a-venir/detail` |
| **Positions titres / ISIN** | **Ne fonctionne pas** | `iter_investment()` retourne `[]` : le module ne câble pas le backend d'investissement `linebourse`, contrairement à `bp` et `caissedepargne` |
| Authentification | Complexe mais stable | identifiant 11 chiffres (regex `\d{11}`) + code personnel 6 chiffres (regex `\d{6}`) **réencodé via le pavé chiffré** du site ; flux OAuth `client.ca-connect.credit-agricole.fr` ; en-têtes `x-xsrf-token`, `x-auth-login` et un `corr_id` obligatoires ; un second flux OAuth (`/bff/api/context/sso/v1`) est nécessaire pour le détail d'un compte |
| Captcha | **Barrage humain possible** | le module lève `ActionNeeded('Friendly captcha detected…')` : une intervention manuelle sur le site est requise une fois |
| Licence | GPLv3 (cœur) / LGPLv3 (modules) | copyleft : utilisation **par processus séparé** ou réimplémentation, jamais par liaison au code applicatif |

Le journal de version de `woob` mentionne « CrAgr backend fix: support of another version of Credit
Agricole » ainsi qu'un espace `linebourse` avec « better 2FA handling » : la bibliothèque est
maintenue, mais **le câblage des positions pour `cragr` n'est pas fait**. C'est la conclusion
centrale : les positions ne sont pas « impossibles », elles sont **non implémentées dans les outils
publics**, et les modules qui savent les lire (`bp`, `caissedepargne`) montrent que le chemin
technique existe.

### Recherche d'alternatives open source

- Rien de maintenu n'existe spécifiquement pour **CA Bourse / positions titre** côté open source.
- Les projets français existants traitent d'autres banques (`bourso-api` pour BoursoBank) : non
  transposables directement, mais ils confirment que le schéma « OAuth + endpoints JSON internes »
  est la voie habituelle pour ce type de banque.
- Les agrégateurs commerciaux (Bankin, Powens, Bridge) ne sont pas open source et exigent un
  contrat.

### Alternative réglementaire : PSD2 / agrégateur

Un agrégateur PSD2 (Enable Banking, Powens…) permet des **soldes et des opérations** avec le
consentement du titulaire. Deux limites structurelles :

1. **Les positions titres et les ISIN ne sont pas exposés** par les API de comptes de paiement.
   PSD2 couvre les comptes de paiement, pas les portefeuilles-titres.
2. Ces services exigent en pratique un statut de fournisseur agréé (AISP) ou une « production
   restreinte » commerciale, dont les conditions tarifaires ne sont pas garanties pour un
   particulier.

Conclusion : PSD2 apporterait les **opérations et soldes** du compte courant, jamais les positions
du PEA / compte-titres.

## 2. Formats d'export — vérifié

Le site public du Crédit Agricole documente l'export de l'historique des opérations **aux formats
Excel, CSV et OFX** (FAQ officielle : « Pour télécharger l'historique de vos opérations aux formats
Excel, CSV, OFX »). Le **format colonne par colonne n'est pas documenté publiquement** et n'a pas pu
être vérifié sur un fichier réel : il varie selon la caisse régionale, l'ancienneté de l'espace
client et la langue.

Côté titres, l'espace CA Bourse permet la consultation des positions ; l'existence d'un export
structuré n'est **pas confirmée**.

## 3. Ce qui a été implémenté (et pourquoi)

Le connecteur Crédit Agricole fonctionne **par import de fichiers**, avec deux formats :

1. **Opérations** (`credit-agricole-operations-csv`) : lecture tolérante — délimiteur automatique
   (`,`, `;`, tabulation), colonnes reconnues par synonymes français (`Date`, `Libellé`, `Montant`,
   ou `Débit`/`Crédit` séparés), dates et montants au format français (`01/03/2024`, `1 234,56`).
   Types reconnus : achats, ventes, dividendes, frais, dépôts, retraits, prélèvements.
2. **Titres** (`credit-agricole-titres-csv`) : positions avec `Code ISIN`, `Valeur`, `Quantité`,
   `Cours`, `Devise` — pour reconstruire un portefeuille et son prix de revient.

Garanties : import **idempotent** (aucun doublon même en réimportant le même fichier), et **aucune
valeur inventée** — une quantité ou un prix illisible produit un **avertissement explicite** au lieu
d'un zéro silencieux.

Complément indispensable : la **saisie manuelle de position** (`POST /api/manual/positions`), qui
enregistre une position existante (quantité + prix de revient) sous forme de transfert, sans créer
d'achat fictif, et sans casser le calcul du PRU. C'est aujourd'hui le seul moyen fiable de faire
apparaître un PEA / compte-titres CA dans le patrimoine.

## 4. Réponse honnête à la question posée

| Question | Réponse |
| --- | --- |
| Peut-on récupérer le PEA / compte-titres automatiquement ? | **Pas aujourd'hui** : le backend d'investissement existe côté banque, mais aucun outil public ne le câble pour `cragr`. Le faire supposerait de reproduire un flux OAuth interne, avec un captcha et une maintenance à chaque changement du site. |
| Peut-on récupérer le cash et les opérations automatiquement ? | **Techniquement oui** via `woob` (sidecar), avec captcha humain possible. Non implémenté dans cette version : cela imposerait d'embarquer Python + une bibliothèque LGPL/GPL et de gérer un flux OAuth à deux niveaux. |
| Peut-on récupérer les positions avec l'export ? | **Oui si la banque expose un export de titres** ; sinon saisie manuelle (implémentée). |
| Que faire pour l'utiliser ? | 1. Exporter les opérations (Excel/CSV/OFX) depuis l'espace client → *Imports*. 2. Saisir les positions du PEA/compte-titres via *Positions manuelles*. 3. Pour un connecteur automatique complet : sidecar Python `woob` (hors périmètre actuel, réalisable). |

## 5. Ce qui n'est pas vérifié

- Le format colonne par colonne des exports CA (opérations et titres) : aucune source publique.
- L'existence d'un export structuré de positions côté CA Bourse.
- Le comportement réel du flux OAuth CA (captcha, deux niveaux) : décrit d'après le code de `woob`,
  jamais exécuté ici, faute d'identifiants.

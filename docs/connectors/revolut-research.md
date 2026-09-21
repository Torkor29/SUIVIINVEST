# Revolut — recherche et solution retenue (Mission 2)

> Réponse honnête pour un particulier, avec la correction d'une erreur de l'audit initial.

## 1. Correction importante par rapport au premier audit

L'audit de faisabilité concluait que Revolut ne produit que des relevés **PDF ou Excel**. C'est
inexact : l'application Revolut permet bien un **export CSV** des transactions
(*Accounts → Statements*). Vérification faite sur une source technique externe (ReconcileIQ,
page « Convert Revolut PDF Bank Statement to CSV ») qui décrit précisément cet export et ses
particularités.

Conséquence directe : **le CSV Revolut est un chemin exploitable**, et il contient des
**colonnes multi-devises avec les taux de change** — ce qui a justifié l'ajout du taux fourni par la
source dans notre modèle (voir §3).

Ce qui reste vrai : l'API Open Banking **officielle** n'est pas utilisable par un particulier.

## 2. Les options, dans l'ordre de préférence demandé

| Option | Verdict pour un particulier | Raison |
| --- | --- | --- |
| **API Open Banking officielle Revolut** | **Non utilisable** | Exige un certificat de transport eIDAS/OBIE **et** un enregistrement AISP auprès d'un régulateur national. Le bac à sable existe, mais avec des données fictives et des certificats de test. |
| **Agrégateur PSD2** (Enable Banking, Powens, Bridge…) | **Possible mais contraignant** | Nécessite de s'inscrire chez un prestataire, d'accepter des conditions commerciales (tarification au volume, « production restreinte » pour ses propres comptes), puis un **consentement SCA de l'utilisateur** avec **re-consentement périodique** (ordre de 90 jours). Le débit autorisé peut être aussi bas que **quelques appels par jour et par compte** — suffisant pour un rafraîchissement quotidien, pas pour du temps réel. |
| **Import semi-automatique du relevé** | **Recommandé** | Export CSV depuis l'app (ou PDF si l'on préfère l'archivage), puis import. Fonctionne aujourd'hui, sans dépendance ni autorisation. |
| **CSV comme repli** | **C'est le chemin principal** | Voir ci-dessus : le CSV existe et est exploitable. |

**Ce que PSD2 ne donnera jamais**, même avec un agrégateur : les **positions titres, les ISIN et les
valorisations** (Revolut titre/crypto). PSD2 couvre les comptes de paiement. Les avoirs
d'investissement devront passer par les relevés de trading — que notre connecteur sait lire.

**Ce qui n'est pas fait, volontairement** : aucun scraping de l'application mobile, aucun stockage
d'information permettant un paiement (pas de PAN, pas de CVV, pas de jeton de paiement), aucun
contournement de protection.

## 3. Ce qui est implémenté

### Import multi-devises (opérationnel)

Deux formats reconnus automatiquement :

1. **Relevé de compte** (`revolut-account-statement-csv`) — colonnes `Type, Product, Started Date,
   Completed Date, Description, Amount, Fee, Currency, State, Balance` :
   - **opérations non finalisées écartées** : tout état autre que `COMPLETED` (PENDING, REVERTED,
     FAILED) est ignoré **avec un avertissement**, jamais importé comme réalisé ;
   - classification : paiement carte, virement entrant/sortant, retrait DAB, change de devise,
     cashback, intérêts, frais, revenu, salaire, remboursement, prélèvement ;
   - **cashback classé en revenu bancaire**, pas en reward de staking : un cashback de carte n'a rien
     à faire dans les rapports crypto ;
   - devise d'origine conservée, montant inchangé, conversion en euros effectuée séparément.
2. **Relevé de trading** (`revolut-trading-statement-csv`) — `Date, Ticker, Type, Quantity, Price per
   share, Total Amount, Currency, FX Rate` : achats, ventes, dividendes, frais de garde, avec le
   **taux de change fourni par le relevé**.

### Taux de change fourni par la source (nouveau)

Le modèle `NormalizedTransaction` accepte désormais un `fxRate` optionnel, **prioritaire sur le taux
reconstitué** depuis la table des taux : quand Revolut indique le taux réellement appliqué à
l'opération, c'est cette valeur qui est utilisée. C'est exact, pas approché — et cela vaut aussi pour
les autres sources qui communiquent un taux.

### Agrégateur PSD2 — **NON implémenté dans cette version** (et pourquoi)

Aucune adaptation Enable Banking n'a été écrite. Ce n'est pas un oubli :

1. elle exigerait une inscription chez le prestataire, une clé privée de signature et un
   consentement SCA humain — rien de tout cela n'est disponible ici ;
2. le code ne pourrait donc **jamais** être testé, même contre le bac à sable de l'utilisateur ;
3. surtout, elle **n'apporterait aucune donnée que l'import ne donne pas déjà**, et **jamais les
   positions titres/crypto** (PSD2 = comptes de paiement).

Le chemin retenu est donc l'import de relevés, qui fonctionne aujourd'hui. Une adaptation PSD2
garderait un intérêt limité : rafraîchir automatiquement les soldes et opérations du compte courant.
Elle est listée dans les prochaines étapes, à condition que l'utilisateur obtienne des accès.

## 4. Ce que l'utilisateur doit faire

1. Dans l'application Revolut : **Comptes → Relevés**, choisir le compte et la période, exporter en
   **CSV** (par devise si vous détenez plusieurs soldes — chaque devise produit son relevé).
2. Dans SuiviInvest : **Connexions → Revolut → Importer un fichier**, puis valider l'aperçu.
   Réimporter le même fichier ne crée **aucun doublon**.
3. Pour les titres/crypto : importer le **relevé de trading** en plus du relevé de compte.
4. Ignorer volontairement les opérations en attente : elles seront reprises au prochain import une
   fois finalisées.

## 5. Ce qui n'est pas vérifié

- Le format colonne par colonne du CSV Revolut tel que produit par l'application **aujourd'hui** :
  les lecteurs sont tolérants et signalent les colonnes non reconnues, mais un ajustement peut être
  nécessaire au premier import réel.
- Toute exécution réelle contre Revolut (PSD2 ou non) : aucune clé, aucun consentement, aucun test
  en ligne.
- Les tarifs et conditions exacts des agrégateurs en « production restreinte ».

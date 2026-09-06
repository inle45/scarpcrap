# Fichiers de configuration

Ces deux fichiers sont le point d'extension du projet. Les modifier ne demande
aucune recompilation : ils sont relus au demarrage du process.

## `hunts.json` — les recherches recurrentes

Une « chasse » decrit une recherche lancee a chaque cycle. **Ajouter un domaine
produit ne demande pas de code**, seulement une entree ici.

| Champ | Role |
|---|---|
| `id` | Identifiant libre, unique. Sert dans les logs. |
| `source` | Identifiant du connecteur (`ebay` aujourd'hui). |
| `domain` | Domaine produit. Determine quels fournisseurs de comparaison seront interroges et dans quelle categorie le deal est range. Valeurs : `electronics`, `fashion`, `sneakers`, `watches`, `collectibles`, `videogames`, `music`, `lego`, `furniture`, `books`, `toys`, `art`, `perfume`, `other`. |
| `enabled` | Mets `false` pour desactiver sans supprimer. |
| `query` | La recherche envoyee a la source. |
| `categoryIds` | Identifiants de categorie cote source. Pour eBay, voir la liste des category IDs du site concerne. Laisse `[]` pour chercher partout. |
| `minPriceEur` / `maxPriceEur` | Bornes de prix a l'achat. `null` pour ne pas borner. |
| `conditions` | `new`, `like_new`, `good`, `fair`, `poor`. eBay ne distingue que neuf/occasion au filtrage. |
| `limit` | Nombre d'annonces ramenees par cycle (1-200). |
| `note` | Commentaire libre, affiche dans l'onglet Systeme. |

Une chasse consomme **un** appel API par cycle. Avec le quota gratuit d'eBay
(~5000 appels/jour), une trentaine de chasses toutes les 3 heures reste tres
confortable.

## `fees.json` — le bareme de frais

C'est **le fichier le plus important a verifier**. Une commission fausse fausse
tous les ROI affiches, et donc toutes les decisions d'achat.

| Champ | Role |
|---|---|
| `commissionPct` | Commission de la marketplace sur le prix de vente. |
| `commissionIncludesShipping` | `true` si la commission porte aussi sur le port encaisse (cas d'eBay et Discogs). |
| `fixedCents` | Frais fixes par commande. |
| `paymentPct` / `paymentFixedCents` | Frais d'encaissement du prestataire de paiement. |
| `shipOutCents` | Ce que coute l'expedition a la revente. |
| `packagingCents` | Carton, bulle, etiquette. |
| `defaultDaysToSell` | Delai de revente retenu quand la comparaison n'en fournit pas. |

### A verifier en priorite

**eBay France ne facture plus de commission aux vendeurs particuliers** depuis
fin 2024. Le defaut livre ici (12,8 % + 0,35 EUR) est celui d'un vendeur
**professionnel**, parce qu'une activite d'arbitrage reguliere finit par etre
requalifiee. Si tu vends bien en tant que particulier, mets `commissionPct` a
`0` — sinon tu ecartes des deals qui sont en realite rentables.

Dans l'autre sens : ne descends jamais ces valeurs « pour voir plus de deals ».
Un bareme optimiste ne cree pas de marge, il cree des achats perdants.

# scarpcrap

Outil personnel d'aide a l'arbitrage : il cherche des annonces sous-evaluees,
estime ce qu'elles valent a la revente ailleurs, calcule le profit net apres
frais reels et le **ROI par jour**, note la fiabilite de l'annonce, et pousse
les meilleures opportunites sur ta montre.

**Il ne fait aucun achat.** Il ne fait pas d'encheres, ne contacte aucun
vendeur, n'envoie aucun message. Il propose, tu decides, tu agis toi-meme sur
la plateforme concernee.

---

## Sommaire

- [Ce que fait l'outil](#ce-que-fait-loutil)
- [Sources : ce qui marche, et ce qui ne marche pas](#sources--ce-qui-marche-et-ce-qui-ne-marche-pas)
- [Architecture](#architecture)
- [Demarrage rapide](#demarrage-rapide)
- [Obtenir les cles API](#obtenir-les-cles-api)
- [Alertes sur la Pixel Watch](#alertes-sur-la-pixel-watch)
- [Deploiement](#deploiement)
- [Ajouter des domaines et des sources](#ajouter-des-domaines-et-des-sources)
- [Comment le ROI est calcule](#comment-le-roi-est-calcule)
- [Comment le score de confiance est calcule](#comment-le-score-de-confiance-est-calcule)
- [Limites assumees](#limites-assumees)
- [Commandes](#commandes)

---

## Ce que fait l'outil

1. **Collecte** des annonces sur les sources configurees, a intervalle regulier
   (cron interne, defaut toutes les 3 h).
2. **Estime le prix de revente** en interrogeant d'autres plateformes du meme
   domaine produit.
3. **Calcule l'economie reelle** du deal : prix d'achat + port, commission de
   la marketplace de revente, encaissement, port sortant, emballage. Puis
   profit net, ROI, delais de reception et de revente, et **ROI/jour** —
   la metrique de tri par defaut.
4. **Note la fiabilite** de l'annonce sur 100 (reputation vendeur, anciennete
   du compte, coherence du prix, photos, description, signaux d'arnaque).
   Seuil d'affichage par defaut : 70.
5. **Affiche** tout dans un dashboard mono-utilisateur avec boutons Acheter /
   Skip, graphiques de synthese et suivi du capital.
6. **Alerte** sur la montre quand un deal depasse des seuils plus stricts.

---

## Sources : ce qui marche, et ce qui ne marche pas

C'est le point le plus important du projet, et celui qui a le plus d'impact sur
ce qu'on peut reellement construire. Voici l'etat des lieux, verifie avant
d'ecrire la moindre ligne.

### Sources integrees

| Source | Statut CGU | Role | Pourquoi |
|---|---|---|---|
| **eBay** (Browse API) | ✅ API officielle | Decouverte + comparaison | Gratuite, ~5000 appels/jour, tous domaines produits, marketplaces FR/DE/GB/US. C'est la seule source de **decouverte** viable sous les contraintes de budget et de maintenance. |
| **Discogs** | ✅ API officielle | Comparaison (musique) | Gratuite, 60 req/min. Son endpoint `price_suggestions` s'appuie sur des **ventes reellement conclues** : la meilleure donnee de prix gratuite qui existe. |
| **BrickLink** | ✅ API officielle | Comparaison (LEGO) | Gratuite. Le guide de prix `sold` couvre les transactions reelles des 6 derniers mois. |

### Le point qui change la conception

**Discogs et BrickLink ne peuvent pas etre des sources d'achat.** Leurs API ne
permettent pas de parcourir les annonces des autres vendeurs — elles sont
concues pour gerer sa propre boutique. Elles restent d'excellents
**fournisseurs de prix**.

Le connecteur distingue donc explicitement deux capacites : `discover()`
(trouver des annonces a acheter) et `comps()` (estimer un prix de revente).
Une source peut implementer l'une, l'autre, ou les deux.

L'arbitrage reel que ca permet aujourd'hui :

- **eBay → Discogs** : acheter un lot de vinyles mal titre sur eBay, revendre a
  la piece sur Discogs. Classique, et les deux bouts sont mesurables.
- **eBay → BrickLink** : acheter un set LEGO sous-cote, revendre au prix du
  guide `sold`.
- **eBay FR → eBay DE** : ecart de prix entre marketplaces sur le meme objet.

### Sources ecartees, et pourquoi

Tu les avais citees en priorite. Voici ce que j'ai trouve, pour que tu decides
en connaissance de cause :

| Source | Verdict | Detail |
|---|---|---|
| **Vinted** | ❌ Incompatible avec tes contraintes | Pas d'API publique (la Pro API est fermee). Protection Datadome + Cloudflare avec fingerprinting TLS. **Toute IP datacenter** — Railway, Render, n'importe quel VPS — est detectee en 1-2 requetes. Il faut des proxies **residentiels** : 15-50 €/mois minimum, soit plus que ton budget d'infra total. Plus ~2-4 h/mois de maintenance, Vinted durcissant Datadome par vagues. Et c'est contraire aux CGU. |
| **Leboncoin** | ❌ Meme probleme | Datadome egalement. Meme cout, meme fragilite, memes CGU. |
| **Facebook Marketplace** | ❌ A eviter absolument | Scraping explicitement interdit par les CGU Meta, detection agressive, et le risque n'est pas seulement un blocage : c'est le **bannissement de ton compte Facebook personnel**. Le rapport risque/benefice est mauvais. |
| **Amazon** | ⚠️ Bloque au demarrage | L'API Product Advertising exige d'avoir deja realise 3 ventes qualifiantes via le programme d'affiliation. Inaccessible tant que tu n'as rien vendu. |
| **StockX / GOAT** | ⚠️ Sur dossier | Une API officielle existe mais l'acces passe par un partenariat commercial. Pas ouvert a un usage personnel. |
| **Vestiaire Collective, Chrono24, Mercari, Grailed** | ⚠️ Pas d'API publique | Scraping HTML uniquement, avec protections variables. Meme arbitrage a faire que pour Vinted. |

**Si tu veux quand meme Vinted plus tard**, l'architecture est prete : ecris
`src/connectors/vinted.ts`, inscris-le dans `src/connectors/registry.ts`, et
declare son `compliance.level` a `'against-tos'` — le dashboard affichera le
badge rouge. Le reste du projet ne changera pas d'une ligne. Il te faudra un
abonnement proxy residentiel, et accepter le cout et la maintenance.

---

## Architecture

```
scarpcrap/
├── config/
│   ├── hunts.json          Les recherches recurrentes. Editable sans recompiler.
│   ├── fees.json           Le bareme de frais par marketplace. A VERIFIER.
│   └── README.md           Documentation de ces deux fichiers.
├── public/                 Dashboard : HTML/CSS/JS nus, aucune etape de build.
├── src/
│   ├── config.ts           Lecture de l'environnement.
│   ├── types.ts            Types partages (RawListing, CompResult, Economics…).
│   ├── connectors/         Un fichier par source. Point d'extension principal.
│   │   ├── types.ts        L'interface Connector : discover() et/ou comps().
│   │   ├── registry.ts     Inscription des connecteurs.
│   │   ├── hunts.ts        Chargement de config/hunts.json.
│   │   ├── ebay.ts         Browse API : decouverte + comparaison.
│   │   ├── discogs.ts      Comparaison musique (ventes reelles).
│   │   ├── bricklink.ts    Comparaison LEGO (ventes reelles, OAuth 1.0a).
│   │   └── demo.ts         Donnees fictives, pour voir le dashboard sans cle.
│   ├── pipeline/
│   │   ├── run.ts          Orchestration d'un cycle complet.
│   │   ├── comps.ts        Collecte des comparaisons de prix.
│   │   ├── fees.ts         Bareme de frais.
│   │   ├── economics.ts    Profit net, ROI, ROI/jour, choix de la marketplace.
│   │   └── trust.ts        Score de confiance 0-100.
│   ├── db/                 SQLite : schema, migrations, requetes.
│   ├── http/               API REST Fastify + authentification par jeton.
│   ├── alerts/ntfy.ts      Notifications push.
│   └── index.ts            Serveur + planificateur cron.
└── test/                   Tests unitaires (node:test).
```

**Stack** : Node.js 22 + TypeScript, Fastify, SQLite (`better-sqlite3`),
`node-cron`. Frontend en HTML/CSS/JS servis directement, sans bundler. Quatre
dependances de production au total.

**Pourquoi SQLite** : un seul process ecrit, les volumes sont petits (quelques
dizaines de milliers de lignes), et une base fichier se sauvegarde avec un
`cp`. Un Postgres manage couterait plus cher que le reste de l'infra.

---

## Demarrage rapide

### Voir le dashboard tout de suite, sans aucune cle

```bash
npm install
npm run build
cp .env.example .env

# Genere un jeton d'acces
sed -i "s|^AUTH_TOKEN=.*|AUTH_TOKEN=$(openssl rand -hex 32)|" .env
sed -i "s|^DEMO_MODE=.*|DEMO_MODE=true|" .env

npm run seed:demo      # insere des annonces fictives
npm start
```

Ouvre http://localhost:8080, colle le jeton de `AUTH_TOKEN`. Tu verras six
deals fictifs, les graphiques, le suivi du capital. **Les donnees sont
fabriquees** : elles servent uniquement a valider l'interface.

### Passer en donnees reelles

1. Cree tes cles eBay (5 minutes, gratuit — voir ci-dessous), renseigne-les
   dans `.env`.
2. Mets `DEMO_MODE=false`.
3. Supprime la base de demo : `rm data/scarpcrap.db*`.
4. Relance, puis clique sur « Lancer un cycle ».

---

## Obtenir les cles API

### eBay — indispensable

1. Cree un compte sur [developer.ebay.com](https://developer.ebay.com/) (gratuit).
2. **My Account → Application Keys**, onglet **Production**.
3. Copie le *App ID (Client ID)* et le *Cert ID (Client Secret)*.

```bash
EBAY_CLIENT_ID=TonNom-scarpcra-PRD-xxxxxxxxx-xxxxxxxx
EBAY_CLIENT_SECRET=PRD-xxxxxxxxxxxx-xxxx-xxxx-xxxx-xxxx
```

Le quota gratuit est de ~5000 appels/jour, toutes API confondues. Avec les 10
chasses livrees par defaut et un cycle toutes les 3 heures, tu consommes de
l'ordre de 300 a 800 appels par jour : large marge. `EBAY_MAX_CALLS_PER_RUN`
plafonne malgre tout la consommation d'un cycle, pour qu'une configuration
trop gourmande ne puisse pas vider le quota d'un coup.

### Discogs — recommande si tu touches a la musique

1. [discogs.com/settings/developers](https://www.discogs.com/settings/developers)
2. **Generate token** → `DISCOGS_TOKEN=`.

> Les prix suggeres par Discogs sont libelles **dans la devise par defaut de ton
> compte Discogs**. Regle-la sur EUR, sinon le connecteur refuse la comparaison
> plutot que de convertir a l'aveugle et de produire des ROI faux.

### BrickLink — recommande si tu touches aux LEGO

1. [bricklink.com/v2/api/register_consumer.page](https://www.bricklink.com/v2/api/register_consumer.page)
2. Genere les 4 valeurs : `BRICKLINK_CONSUMER_KEY`, `BRICKLINK_CONSUMER_SECRET`,
   `BRICKLINK_TOKEN`, `BRICKLINK_TOKEN_SECRET`.
3. BrickLink filtre par adresse IP : declare celle de ton serveur au moment de
   generer le jeton.

---

## Alertes sur la Pixel Watch

**Le choix retenu : ntfy.sh.** Gratuit, open source, auto-hebergeable, et son
application Android officielle est distribuee en `.apk`. Une notification
Android standard remonte **automatiquement** sur une Pixel Watch appairee : pas
besoin de developper une application Wear OS dediee, ni meme une application
compagnon.

### Installation

1. Installe l'application ntfy sur ton telephone :
   - [F-Droid](https://f-droid.org/packages/io.heckel.ntfy/) (recommande)
   - [APK direct, GitHub releases](https://github.com/binwiederhier/ntfy-android/releases)
   - [Google Play](https://play.google.com/store/apps/details?id=io.heckel.ntfy)
2. Choisis un nom de topic **long et imprevisible**, par exemple
   `scarpcrap-9f2a7c1b4e8d`. Sur l'instance publique ntfy.sh, **le nom du topic
   est le seul secret** : quiconque le devine lit tes alertes.
3. Renseigne-le dans `.env` : `NTFY_TOPIC=scarpcrap-9f2a7c1b4e8d`
4. Abonne-toi a ce topic dans l'application.
5. Sur ta montre : verifie que les notifications de l'application ntfy sont bien
   autorisees a etre mirrored (Paramètres Wear OS → Notifications).
6. Depuis le dashboard, onglet **Systeme** → **Tester l'alerte montre**.

### Quand une alerte part

Deux seuils, plus stricts que ceux de l'affichage, reglables dans l'onglet
Systeme :

- confiance ≥ `ALERT_MIN_TRUST_SCORE` (defaut 80)
- ROI/jour ≥ `ALERT_MIN_ROI_PER_DAY_EUR` (defaut 1,50 €)
- au maximum `ALERT_MAX_PER_RUN` alertes par cycle (defaut 5)

Un deal n'est alerte qu'une seule fois, meme si le cycle suivant le reevalue.

### Si tu veux vraiment un APK maison

C'est faisable mais ca n'apporte rien : l'application ntfy fait deja exactement
ca, en mieux, et se met a jour toute seule. Une application maison serait a
maintenir a chaque montee de version d'Android. Si tu y tiens quand meme,
dis-le-moi et je la construirai — mais commence par tester ntfy.

---

## Deploiement

### Docker (recommande)

```bash
cp .env.example .env    # remplis-le
docker compose up -d --build
```

Le compose n'expose que `127.0.0.1:8080`. Pour y acceder depuis l'exterieur,
mets un reverse proxy avec TLS devant (Caddy fait ca en trois lignes). Le
dashboard n'a pas vocation a etre joignable directement depuis Internet.

### Cout

| Poste | Cout mensuel |
|---|---|
| VPS Hetzner CX22 (2 vCPU, 4 Go) | ~4 € |
| eBay Browse API | 0 € |
| Discogs API | 0 € |
| BrickLink API | 0 € |
| ntfy.sh (instance publique) | 0 € |
| **Total** | **~4 €** |

Largement sous les 20 €/mois vises. Un Raspberry Pi a la maison ramenerait ca a
zero, au prix de la disponibilite.

### Sauvegarde

Toute la base est dans un fichier :

```bash
sqlite3 data/scarpcrap.db ".backup '/chemin/sauvegarde.db'"
```

### Cron systeme plutot que cron interne

Si tu preferes que le process ne tourne pas en continu :

```bash
SCHEDULE_ENABLED=false          # dans .env
# puis, dans crontab -e :
17 */3 * * * cd /opt/scarpcrap && /usr/bin/node dist/src/cli/runOnce.js >> /var/log/scarpcrap.log 2>&1
```

---

## Ajouter des domaines et des sources

### Un nouveau domaine produit : aucune ligne de code

Ajoute une entree dans `config/hunts.json` :

```json
{
  "id": "ebay-parfums-niche",
  "source": "ebay",
  "domain": "perfume",
  "enabled": true,
  "query": "parfum niche flacon 100ml",
  "categoryIds": ["11848"],
  "minPriceEur": 30,
  "maxPriceEur": 250,
  "conditions": ["like_new", "new"],
  "limit": 50,
  "note": "Parfums de niche : marges bonnes, verifier le niveau de remplissage."
}
```

Les domaines disponibles et le detail de chaque champ sont dans
[`config/README.md`](config/README.md).

### Une nouvelle source : un fichier

```ts
// src/connectors/maSource.ts
import type { Connector } from './types.js';

export const maSourceConnector: Connector = {
  id: 'masource',
  label: 'Ma Source',
  domains: ['watches'],           // ou ['*'] pour tous les domaines
  compliance: {
    level: 'official-api',        // ou 'tolerated' | 'against-tos'
    summary: "Ce que je dois savoir avant de l'activer.",
    reference: 'https://…/docs',
  },
  isConfigured: () => Boolean(process.env['MASOURCE_KEY']),
  missingConfig: () => 'MASOURCE_KEY manquant.',
  async discover(ctx) { /* … */ return []; },   // optionnel
  async comps(listing, ctx) { /* … */ return []; }, // optionnel
};
```

Puis inscris-le dans le tableau `ALL` de `src/connectors/registry.ts`. Rien
d'autre dans le projet ne connait les sources par leur nom : le moteur, l'API et
le dashboard travaillent tous sur ce registre.

`ctx.budget` plafonne les appels du cycle, `ctx.limiter` espace les requetes.
Utilise-les : ils existent pour ne pas se faire bloquer.

---

## Comment le ROI est calcule

```
achat total      = prix annonce + port a l'achat

revente estimee  = mediane des comparaisons
                   × 0,85 si la comparaison porte sur des annonces ACTIVES

frais            = commission marketplace (+ port encaisse si applicable)
                 + frais fixes
                 + frais d'encaissement
                 + port sortant
                 + emballage

profit net       = revente estimee − achat total − frais
ROI %            = profit net / achat total
duree totale     = delai de reception + 2 j de mise en vente + delai de revente
ROI / jour       = profit net / duree totale        ← metrique de tri
```

**Le choix de la marketplace de revente se fait sur le profit net, pas sur le
prix affiche.** Une plateforme qui paie 10 % de plus mais preleve 12 % de
commission perd contre une plateforme moins chere a 3 %.

**La decote de 15 % sur les comparaisons actives** vient du fait qu'une mediane
de prix *demandes* est structurellement au-dessus des prix reellement payes :
les annonces cheres restent en ligne, les moins cheres partent. eBay Browse ne
donne que des annonces actives ; Discogs et BrickLink donnent de vraies ventes
et ne sont pas decotes. Le dashboard affiche cette difference sous forme d'un
badge « estimation solide / moyenne / fragile ».

**L'indice de revente par categorie** est la marge mediane observee par domaine.
Il se calcule d'abord sur tes **ventes reelles** (celles que tu saisis dans
l'onglet Capital) ; faute d'historique suffisant, il retombe sur les marges
estimees. En dessous de 5 observations, il est considere comme non
significatif et n'est pas affiche. Le badge « +X pts vs categorie » sur chaque
deal compare sa marge a la normale de son domaine.

---

## Comment le score de confiance est calcule

Sur 100 points :

| Composant | Points | Ce qui est regarde |
|---|---|---|
| Reputation du vendeur | 25 | Taux d'avis positifs (inutile sous 90 %) croise au volume d'evaluations (sature vers 1000). |
| Anciennete du compte | 10 | Moins de 30 jours = 0. Plus de 2 ans = 10. |
| Coherence du prix | 25 | Rapport entre le prix demande et le prix de marche. Un objet a 15 % du marche n'est pas une affaire, c'est un appat. |
| Photos | 15 | Nombre de photos, moins une penalite si la **meme image apparait chez d'autres vendeurs** de la base. |
| Description | 15 | Longueur et presence de mentions concretes (facture, notice, teste, dimensions…). |
| Signaux d'alerte | 10 | WhatsApp/Telegram, paiement hors plateforme, urgence appuyee, rarete artificielle, vocabulaire de contrefacon. |

**Principe directeur : une information absente vaut un score neutre, jamais un
bonus.** Une annonce dont on ne sait rien plafonne autour de 55-60 et ne
franchit donc pas le seuil par defaut de 70.

**Sur la recherche d'image inversee** : les API payantes ont ete ecartees
(budget). Le substitut implemente detecte la reutilisation d'une meme image
entre plusieurs vendeurs **a l'interieur de ta propre base**. C'est gratuit, ca
ne detecte pas une photo volee ailleurs sur le web, mais ca attrape les
campagnes multi-comptes — le cas le plus frequent. Le point d'extension est
dans `src/pipeline/trust.ts`, fonction `photosComponent`.

---

## Limites assumees

Elles sont listees ici parce qu'un outil qui promet plus qu'il ne tient fait
perdre de l'argent.

1. **Les comparaisons eBay sont des prix demandes, pas des prix vendus.**
   L'API Browse ne donne pas les ventes realisees ; ca demande l'API Marketplace
   Insights, dont l'acces est soumis a validation eBay. D'ou la decote de 15 %
   et le badge de qualite. Si tu obtiens l'acces a Marketplace Insights, c'est
   une vingtaine de lignes a ajouter dans `ebay.ts` et la qualite des
   estimations change de nature.

2. **Une seule source de decouverte.** Tant que le systeme ne lit qu'eBay, il ne
   voit que les inefficacites d'eBay. C'est reel mais plus etroit que du
   multi-plateforme.

3. **Les delais de revente sont des heuristiques.** Nombre d'annonces
   concurrentes pour eBay, rapport recherches/possedes pour Discogs, frequence
   des ventes pour BrickLink. Ils se calibrent sur tes vraies ventes : saisis
   systematiquement tes prix de vente dans l'onglet Capital.

4. **Le bareme de frais doit etre verifie.** Le defaut eBay livre ici est celui
   d'un vendeur professionnel (12,8 %). Les particuliers en France ne paient
   plus de commission depuis fin 2024. Voir [`config/README.md`](config/README.md).

5. **Aucune detection de contrefacon par l'image.** Le score textuel attrape les
   annonces qui s'annoncent comme des repliques, pas celles qui mentent. Sur les
   montres et les sneakers, monte le seuil de confiance a 85 et regarde les
   photos toi-meme.

6. **Le mode demo produit des donnees fabriquees.** Ne prends jamais une
   decision d'achat sur cette base.

Enfin : les revenus d'achat-revente reguliers sont **imposables en France** et
peuvent relever du statut de vendeur professionnel. Ce n'est pas un conseil
fiscal, mais ca vaut le coup de te renseigner avant de monter en volume.

---

## Commandes

| Commande | Effet |
|---|---|
| `npm install` | Installe les dependances. |
| `npm run build` | Compile TypeScript vers `dist/`. |
| `npm start` | Lance le serveur et le planificateur. |
| `npm test` | Compile et execute les tests unitaires. |
| `npm run typecheck` | Verifie les types sans emettre de fichiers. |
| `npm run run:once` | Execute un seul cycle de collecte puis sort. |
| `npm run seed:demo` | Insere des donnees fictives dans la base. |

### API

Toutes les routes `/api/*` sauf `/api/health` exigent
`Authorization: Bearer <AUTH_TOKEN>`.

| Methode | Route | Effet |
|---|---|---|
| `GET` | `/api/health` | Sonde de vie (sans authentification). |
| `GET` | `/api/status` | Connecteurs, chasses, frais, seuils, dernier cycle. |
| `GET` | `/api/deals` | Deals filtres et tries. |
| `GET` | `/api/deals/:id` | Un deal avec le detail de ses comparaisons. |
| `POST` | `/api/deals/:id/buy` | Marque comme achete. **N'achete rien.** |
| `POST` | `/api/deals/:id/skip` | Ecarte definitivement. |
| `POST` | `/api/deals/:id/sold` | Enregistre le prix de vente reel. |
| `POST` | `/api/deals/:id/reset` | Remet un deal dans la liste. |
| `GET` | `/api/stats/{categories,domains,risk,capital,decisions}` | Donnees des graphiques. |
| `GET`/`PUT` | `/api/settings` | Lit / modifie les seuils. |
| `POST` | `/api/run` | Declenche un cycle immediatement. |
| `POST` | `/api/alerts/test` | Envoie une notification de test. |

# 🎵 Blind Test Party — site multi-rooms

Blind test multijoueur en ligne : **n'importe quel PC** ouvre le site, crée une partie (écran de jeu + musique), et les joueurs rejoignent depuis leur téléphone via QR code ou code à 4 lettres. Plusieurs parties peuvent tourner en même temps. Musique via l'**API iTunes** (extraits 30 s, aucune clé requise).

## Comment ça marche

- `https://ton-site.com/host` → **crée une room** (écran PC/TV : QR code, timer, musique, révélations, podium)
- `https://ton-site.com/?room=ABCD` → **rejoint la room** (manette mobile) — c'est ce que contient le QR code
- `https://ton-site.com/` → page joueur avec champ code (+ lien pour créer une partie)

Le son est joué sur le **PC qui a créé la room**. Case à cocher dans le lobby : « Jouer aussi la musique sur les téléphones » si les joueurs ne sont pas dans la même pièce.

## Lancer en local

```bash
npm install
npm start        # http://localhost:3000/host
```
Node ≥ 18 requis.

## 🌍 Déployer en vrai site (recommandé : Render, gratuit)

1. Pousser ce dossier sur un repo **GitHub**.
2. Sur [render.com](https://render.com) → **New → Web Service** → connecter le repo.
3. Réglages : Runtime **Node**, Build `npm install`, Start `npm start`. C'est tout (le serveur écoute déjà `process.env.PORT`).
4. Ton site est en ligne : `https://ton-app.onrender.com/host` pour créer une partie depuis n'importe quel PC.

Le QR code s'adapte tout seul : il pointe vers l'adresse du site (`location.origin`), aucune variable à configurer. **Railway**, **Fly.io** ou un VPS (`node server.js` derrière nginx/caddy) fonctionnent pareil — il faut juste que l'hébergeur supporte les **WebSockets** (c'est le cas des trois).

> ⚠️ Plan gratuit Render : le service s'endort après ~15 min d'inactivité, le premier chargement peut prendre 30 s.

## Règles de score

| Trouvaille | Points |
|---|---|
| Titre | 100 + bonus vitesse (jusqu'à +50) |
| Film / série / Disney 🎬 | 75 + bonus vitesse (jusqu'à +37) |
| Artiste | 50 + bonus vitesse (jusqu'à +25) |

Le film/la série n'est à deviner que si l'extrait vient d'une **bande originale**, détecté depuis le titre du morceau ou le nom de l'album iTunes : « Réflexion (De "Mulan") » → Mulan, « Vaiana (Bande Originale du Film) » → Vaiana. Une 3ᵉ pastille apparaît alors sur les téléphones.

- Réponses **tolérantes aux fautes** (normalisation accents/ponctuation/« feat. » + distance de Levenshtein). Manche écourtée si tout le monde a tout trouvé.
- **Artistes multiples** : sur « David Guetta & Sia », citer un seul des deux suffit.
- **Bonus de série** : +15 % de points par manche consécutive avec au moins une trouvaille (plafonné à +60 %).
- **Presque !** : une réponse proche affiche « tu chauffes » sur le téléphone.
- **Litiges** : sur l'écran de révélation, l'hôte peut accorder un point refusé par le matching.

## ⚔️ Mode battle royale

Choisi dans le lobby, à la place du mode classique. **3 chansons par thème**, puis le **dernier au score est éliminé**. On enchaîne jusqu'à ce qu'il ne reste qu'une personne — la partie s'arrête à ce moment-là, même s'il restait des extraits.

- L'écran affiche « 💀 élimination après cet extrait ! » sur la 3ᵉ chanson de chaque bloc, puis un écran de verdict avec les survivants et leurs scores.
- Les éliminés **restent connectés en spectateurs** : ils voient les extraits et les réponses sur leur téléphone, mais ne peuvent plus marquer.
- **Égalité au fond du classement** : si tous les derniers ex æquo représentent l'ensemble des survivants, personne ne saute et la manche suivante démarre.
- Le classement final suit l'**ordre d'élimination** (le survivant gagne, puis le dernier éliminé, etc.), le score ne départage qu'en cas d'égalité.
- Le nombre d'extraits par catégorie est verrouillé à 3 dans ce mode ; l'hôte peut toujours arbitrer les litiges avant le verdict.

## Réglages depuis le lobby (par partie)

- **Mode de jeu** : 🎉 classique ou ⚔️ battle royale (voir ci-dessus).
- **Extraits par catégorie** (2 à 5, forcé à 3 en battle royale). La durée d'une manche est tirée au sort entre **30 et 45 s** à chaque extrait (les previews iTunes durent 30 s : si le chrono va au-delà, on continue de répondre après la fin de la musique).
- **Difficulté** : 😌 facile (les gros tubes), 🎚️ moyen (points ×1,25) ou 🔥 difficile (pépites méconnues, points ×1,5). iTunes ne publie pas les nombres d'écoutes mais classe ses résultats par popularité : le niveau détermine si les extraits sont piochés en haut, au milieu ou au fond de ce classement. Les reprises karaoké/tribute sont filtrées.
- **Mode réponses** : essais illimités, ou **un seul essai** (points ×2).
- **Mode playlist** : chacun sa catégorie, ou **thèmes imposés** par l'écran (séparés par des virgules).
- Indice automatique à mi-manche sur le grand écran (pochette floutée + initiales du titre) — niveaux moyen et difficile uniquement, pas d'indice en facile.
- Sons d'ambiance sur l'écran (désactivables via 🔊), podium animé avec confettis, historique de la playlist en fin de partie.
- Les téléphones **se reconnectent tout seuls** (page rechargée, réseau qui saute) sans perdre leur score.

Valeurs par défaut dans `CONFIG` (server.js) : `TRACKS_PER_CATEGORY` (3), `ROUND_SECONDS_MIN`/`ROUND_SECONDS_MAX` (30–45), `COUNTRY` (`FR`), barème de points, durée de vie des rooms (3 h), délai de reconnexion de l'hôte (2 min). La cadence des éliminations en battle royale est dans `BATTLE_EVERY` (3).

## Détails techniques

- **Rooms en mémoire** : code à 4 lettres unique, nettoyage auto (room vide ou > 3 h).
- **Hôte qui rafraîchit sa page** : il récupère sa room et la partie reprend où elle en était.
- **Anti-triche** : l'URL audio n'est envoyée aux téléphones que si l'option « à distance » est cochée.
- « **Rejouer** » garde le même code de room, les téléphones n'ont qu'à re-rentrer un pseudo.

## Structure

```
blind-test/
├── server.js            # Express + Socket.io + rooms + iTunes + logique de jeu
├── package.json
└── public/
    ├── host.html        # Écran de jeu (crée une room)
    ├── player.html      # Manette mobile (rejoint une room)
    ├── css/style.css
    └── js/host.js, js/player.js
```

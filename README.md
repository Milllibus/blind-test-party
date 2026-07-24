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
| Artiste | 50 + bonus vitesse (jusqu'à +25) |

- Réponses **tolérantes aux fautes** (normalisation accents/ponctuation/« feat. » + distance de Levenshtein). Manche écourtée si tout le monde a tout trouvé.
- **Artistes multiples** : sur « David Guetta & Sia », citer un seul des deux suffit.
- **Bonus de série** : +15 % de points par manche consécutive avec au moins une trouvaille (plafonné à +60 %).
- **Presque !** : une réponse proche affiche « tu chauffes » sur le téléphone.
- **Litiges** : sur l'écran de révélation, l'hôte peut accorder un point refusé par le matching.

## Réglages depuis le lobby (par partie)

- **Extraits par catégorie** (2 à 5) et **durée par extrait** (15 à 45 s).
- **Mode réponses** : essais illimités, ou **un seul essai** (points ×2).
- **Mode playlist** : chacun sa catégorie, ou **thèmes imposés** par l'écran (séparés par des virgules).
- Indice automatique à mi-manche sur le grand écran (pochette floutée + initiales du titre).
- Sons d'ambiance sur l'écran (désactivables via 🔊), podium animé avec confettis, historique de la playlist en fin de partie.
- Les téléphones **se reconnectent tout seuls** (page rechargée, réseau qui saute) sans perdre leur score.

Valeurs par défaut dans `CONFIG` (server.js) : `TRACKS_PER_CATEGORY` (3), `ROUND_SECONDS` (25), `COUNTRY` (`FR`), barème de points, durée de vie des rooms (3 h), délai de reconnexion de l'hôte (2 min).

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

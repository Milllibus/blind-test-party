/* ============================================================
   BLIND TEST PARTY — serveur multi-rooms
   Un vrai site : N'IMPORTE QUEL PC ouvre /host et crée sa partie.
   Chaque room a son code, son écran hôte (qui joue la musique)
   et ses joueurs. Plusieurs parties peuvent tourner en même temps.

   Fonctionnalités : réglages par room (durée, nb d'extraits, modes),
   playlist par joueurs OU thèmes imposés par l'hôte, mode "un seul
   essai", bonus de série, indice à mi-manche, "tu chauffes",
   reconnexion des joueurs, litiges validés par l'hôte, historique.

   Express + Socket.io + API iTunes — Node >= 18
   ============================================================ */

const os = require("os");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

/* ---------- Réglages du jeu (valeurs par défaut d'une room) ---------- */
const CONFIG = {
  TRACKS_PER_CATEGORY: 3,   // musiques par catégorie
  ROUND_SECONDS: 25,        // temps de réponse par extrait
  POINTS_TITLE: 100,
  POINTS_ARTIST: 50,
  SPEED_BONUS_MAX: 50,
  ONESHOT_MULT: 2,          // multiplicateur du mode "un seul essai"
  STREAK_STEP: 0.15,        // +15 % de points par manche de série…
  STREAK_MAX: 4,            // …plafonné à +60 %
  MIN_PLAYERS: 1,
  COUNTRY: "FR",            // catalogue iTunes
  ROOM_TTL_MS: 3 * 60 * 60 * 1000,   // durée de vie max d'une room (3 h)
  HOST_GRACE_MS: 2 * 60 * 1000,      // délai pour qu'un hôte déconnecté revienne
};

/* ---------- IP locale (affichage console + fallback QR en LAN) ---------- */
function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}
const LAN_URL = `http://${getLocalIp()}:${PORT}`;

/* ---------- Fichiers statiques + routes ---------- */
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "player.html")));
app.get("/host", (_req, res) => res.sendFile(path.join(__dirname, "public", "host.html")));

/* ============================================================
   ROOMS
   ============================================================ */
const rooms = new Map(); // code -> game

function makeCode() {
  const letters = "ABCDEFGHJKMNPQRSTUVWXYZ";
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function defaultOpts() {
  return {
    tracksPerCat: CONFIG.TRACKS_PER_CATEGORY,
    roundSeconds: CONFIG.ROUND_SECONDS,
    answerMode: "libre",      // "libre" | "oneshot" (un seul essai, points ×2)
    playlistMode: "players",  // "players" (chacun sa catégorie) | "host" (thèmes imposés)
    themes: [],
  };
}

function createGame() {
  const game = {
    code: makeCode(),
    createdAt: Date.now(),
    state: "LOBBY", // LOBBY -> CATEGORIES -> GENERATING -> PLAYING -> REVEAL -> PODIUM
    hostId: null,
    remoteAudio: false, // true = les téléphones jouent aussi l'extrait
    opts: defaultOpts(),
    players: new Map(), // playerKey -> { key, sid, name, score, streak, category, categoryOk, connected }
    tracks: [],
    current: -1,
    round: null,
  };
  rooms.set(game.code, game);
  console.log(`🎧 Room créée : ${game.code} (${rooms.size} active·s)`);
  return game;
}

function clearRoundTimers(round) {
  if (!round) return;
  clearTimeout(round.timer);
  clearTimeout(round.hintTimer);
}

function destroyGame(game) {
  clearRoundTimers(game.round);
  rooms.delete(game.code);
  console.log(`🧹 Room supprimée : ${game.code} (${rooms.size} restante·s)`);
}

/** Retrouve la room d'un socket (host ou joueur) */
function gameOf(socket) {
  return rooms.get(socket.data.code) || null;
}

/* Nettoyage : rooms sans hôte ni joueur connecté, ou trop vieilles */
setInterval(() => {
  const now = Date.now();
  for (const game of rooms.values()) {
    const hostAlive = game.hostId && io.sockets.sockets.get(game.hostId);
    const anyPlayer = [...game.players.values()].some((p) => p.connected);
    const hostGone = !hostAlive && (now - (game.hostLeftAt || game.createdAt)) > CONFIG.HOST_GRACE_MS;
    const tooOld = now - game.createdAt > CONFIG.ROOM_TTL_MS;
    if (tooOld || (hostGone && !anyPlayer)) destroyGame(game);
  }
}, 60 * 1000);

/* ---------- Diffusion ---------- */
function playersPublic(game) {
  return [...game.players.values()].map((p) => ({
    id: p.key, name: p.name, score: p.score, streak: p.streak,
    categoryOk: !!p.categoryOk, connected: p.connected,
  }));
}
function broadcastLobby(game) {
  io.to(game.code).emit("lobby:update", {
    code: game.code, players: playersPublic(game), state: game.state,
  });
}
function leaderboard(game) {
  return playersPublic(game)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, ...p }));
}
function emitToPlayers(game, event, payload) {
  for (const p of game.players.values()) {
    if (p.sid) io.to(p.sid).emit(event, payload);
  }
}

/* ============================================================
   NORMALISATION + MATCHING PERMISSIF (fautes d'orthographe)
   ============================================================ */
function normalize(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\b(feat|ft|featuring|remaster(ed)?|version|edit|radio|live|single|deluxe)\b.*$/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

/* "David Guetta & Sia" / "Orelsan feat. Stromae" → chaque artiste
   accepté seul. Le nom complet reste candidat (Simon & Garfunkel). */
function splitArtists(artistRaw) {
  const raw = String(artistRaw || "");
  const parts = raw
    .split(/\s*(?:,|&|\/|\+|\bfeat\b\.?|\bft\b\.?|\bfeaturing\b|\bvs\b\.?|\bx\b|\band\b|\bet\b)\s*/gi)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  return [...new Set([raw, ...parts])];
}

function matchArtist(guessRaw, artistRaw) {
  return splitArtists(artistRaw).some((a) => fuzzyMatch(guessRaw, a));
}

function fuzzyMatch(guessRaw, targetRaw) {
  const guess = normalize(guessRaw);
  const target = normalize(targetRaw);
  if (!guess || !target) return false;
  if (guess === target) return true;

  const tol = Math.max(1, Math.floor(target.length * 0.25));
  if (levenshtein(guess, target) <= tol) return true;

  if (target.length >= 4 && guess.length >= 4) {
    if (target.includes(guess) && guess.length >= target.length * 0.6) return true;
    if (guess.includes(target)) return true;
  }

  const tw = target.split(" ").filter((w) => w.length > 2);
  const gw = guess.split(" ");
  if (tw.length >= 2) {
    const hits = tw.filter((w) => gw.some((g) => levenshtein(g, w) <= Math.max(1, Math.floor(w.length * 0.3))));
    if (hits.length / tw.length >= 0.7) return true;
  }
  return false;
}

/* Réponse refusée mais proche → "tu chauffes !" */
function isNearOne(guessRaw, targetRaw) {
  const guess = normalize(guessRaw);
  const target = normalize(targetRaw);
  if (!guess || !target) return false;
  if (levenshtein(guess, target) <= Math.max(2, Math.floor(target.length * 0.45))) return true;
  const tw = target.split(" ").filter((w) => w.length > 3);
  const gw = guess.split(" ");
  return tw.some((w) => gw.some((g) => levenshtein(g, w) <= 1));
}

function isNear(guessRaw, track, entry) {
  if (!entry.title && isNearOne(guessRaw, track.title)) return true;
  if (!entry.artist && splitArtists(track.artist).some((a) => isNearOne(guessRaw, a))) return true;
  return false;
}

/* Indice affiché sur le grand écran : initiales du titre */
function titleMask(title) {
  return String(title)
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => (w.length > 1 ? w[0].toUpperCase() + " ·".repeat(w.length - 1).trim() : w.toUpperCase()))
    .map((w) => w.replace(/ /g, ""))
    .join("   ");
}

/* ============================================================
   API iTunes
   ============================================================ */
async function searchItunes(term) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=60&country=${CONFIG.COUNTRY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`iTunes HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).filter((t) => t.previewUrl && t.trackName && t.artistName);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickTracks(results, n, category) {
  const shuffled = shuffle(results);
  const picked = [];
  const seenArtists = new Set();
  const seenTitles = new Set();
  for (const t of shuffled) {
    const artistKey = normalize(t.artistName);
    const titleKey = normalize(t.trackName);
    if (seenTitles.has(titleKey)) continue;
    if (seenArtists.has(artistKey) && picked.length < n) {
      const remaining = shuffled.filter((x) => !seenArtists.has(normalize(x.artistName))).length;
      if (remaining > n - picked.length) continue;
    }
    seenArtists.add(artistKey);
    seenTitles.add(titleKey);
    picked.push({
      title: t.trackName,
      artist: t.artistName,
      previewUrl: t.previewUrl,
      artwork: (t.artworkUrl100 || "").replace("100x100", "400x400"),
      category,
    });
    if (picked.length === n) break;
  }
  return picked;
}

/* ============================================================
   DÉROULÉ D'UNE MANCHE
   ============================================================ */
function startRound(game) {
  game.current++;
  if (game.current >= game.tracks.length) return endGame(game);

  const track = game.tracks[game.current];
  game.state = "PLAYING";
  const durationMs = game.opts.roundSeconds * 1000;
  game.round = {
    startsAt: Date.now(),
    endsAt: Date.now() + durationMs,
    found: new Map(),      // playerKey -> { title, artist, points }
    attempts: new Map(),   // playerKey -> texte (mode "un seul essai")
    refused: new Map(),    // playerKey -> [textes refusés] (litiges)
    revealed: false,
    streaksApplied: false,
    timer: setTimeout(() => endRound(game), durationMs),
    hintTimer: setTimeout(() => sendHint(game), Math.round(durationMs / 2)),
  };

  const base = {
    index: game.current,
    total: game.tracks.length,
    category: track.category,
    endsAt: game.round.endsAt,
    seconds: game.opts.roundSeconds,
    mode: game.opts.answerMode,
  };
  // L'écran hôte de CETTE room joue le son
  io.to(game.hostId).emit("round:start", { ...base, previewUrl: track.previewUrl });
  // Les téléphones aussi, si l'option "à distance" est activée
  emitToPlayers(game, "round:start", game.remoteAudio ? { ...base, previewUrl: track.previewUrl } : base);
}

/* Indice de mi-manche (grand écran uniquement) : pochette floutée + initiales */
function sendHint(game) {
  if (game.state !== "PLAYING" || !game.round || game.round.revealed) return;
  const track = game.tracks[game.current];
  io.to(game.hostId).emit("round:hint", {
    artwork: track.artwork,
    titleMask: titleMask(track.title),
  });
}

function buildFinders(game) {
  return [...game.round.found.entries()].map(([key, f]) => {
    const p = game.players.get(key);
    return { name: p ? p.name : "?", title: f.title, artist: f.artist, points: f.points };
  }).sort((a, b) => b.points - a.points);
}

function endRound(game) {
  if (!game.round || game.round.revealed) return;
  clearRoundTimers(game.round);
  game.round.revealed = true;
  game.state = "REVEAL";

  // Séries : une manche avec au moins une trouvaille prolonge la série
  if (!game.round.streaksApplied) {
    game.round.streaksApplied = true;
    for (const p of game.players.values()) {
      const f = game.round.found.get(p.key);
      if (f && (f.title || f.artist)) p.streak = (p.streak || 0) + 1;
      else if (p.connected) p.streak = 0;
    }
  }

  // Litiges : réponses refusées de joueurs à qui il manque encore des points
  const refused = [...game.round.refused.entries()].map(([key, guesses]) => {
    const p = game.players.get(key);
    const f = game.round.found.get(key) || {};
    return { id: key, name: p ? p.name : "?", guesses, titleDone: !!f.title, artistDone: !!f.artist };
  }).filter((r) => !(r.titleDone && r.artistDone));

  const track = game.tracks[game.current];
  io.to(game.code).emit("round:reveal", {
    index: game.current,
    total: game.tracks.length,
    title: track.title,
    artist: track.artist,
    artwork: track.artwork,
    category: track.category,
    finders: buildFinders(game),
    leaderboard: leaderboard(game),
    isLast: game.current === game.tracks.length - 1,
    refused,
  });
}

function podiumTracks(game) {
  return game.tracks.slice(0, game.current + 1).map((t) => ({
    title: t.title, artist: t.artist, artwork: t.artwork, category: t.category,
  }));
}

function endGame(game) {
  game.state = "PODIUM";
  io.to(game.code).emit("game:podium", { leaderboard: leaderboard(game), tracks: podiumTracks(game) });
}

/* Playlist "chacun sa catégorie" */
function buildPlaylistAndStart(game) {
  const all = [...game.players.values()];
  let tracks = [];
  for (const p of all) {
    tracks = tracks.concat(pickTracks(p._results, game.opts.tracksPerCat, p.category));
    delete p._results;
  }
  game.tracks = shuffle(tracks);
  io.to(game.code).emit("game:generated", {
    total: game.tracks.length,
    categories: all.map((p) => ({ name: p.name, category: p.category })),
  });
  setTimeout(() => startRound(game), 3500);
}

/* Playlist "thèmes imposés par l'hôte" */
async function buildHostPlaylist(game) {
  let tracks = [];
  const cats = [];
  for (const theme of game.opts.themes) {
    const results = await searchItunes(theme);
    const picked = pickTracks(results, game.opts.tracksPerCat, theme);
    if (picked.length < 2) throw new Error(`Pas assez de résultats pour « ${theme} »`);
    tracks = tracks.concat(picked);
    cats.push({ name: null, category: theme });
  }
  game.tracks = shuffle(tracks);
  io.to(game.code).emit("game:generated", { total: game.tracks.length, categories: cats });
  setTimeout(() => startRound(game), 3500);
}

/* Photo de l'état courant envoyée à un joueur qui (re)vient en cours de partie */
function sendSnapshot(game, socket, p) {
  if (game.state === "CATEGORIES") {
    socket.emit("categories:start");
  } else if (game.state === "PLAYING" && game.round && !game.round.revealed) {
    const track = game.tracks[game.current];
    const payload = {
      index: game.current, total: game.tracks.length, category: track.category,
      endsAt: game.round.endsAt, seconds: game.opts.roundSeconds, mode: game.opts.answerMode,
    };
    if (game.remoteAudio) payload.previewUrl = track.previewUrl;
    socket.emit("round:start", payload);
    const f = game.round.found.get(p.key) || {};
    socket.emit("answer:state", {
      titleDone: !!f.title, artistDone: !!f.artist,
      locked: game.opts.answerMode === "oneshot" && game.round.attempts.has(p.key),
      score: p.score,
    });
  } else if (game.state === "REVEAL" && game.round) {
    const track = game.tracks[game.current];
    socket.emit("round:reveal", {
      index: game.current, total: game.tracks.length,
      title: track.title, artist: track.artist, artwork: track.artwork, category: track.category,
      finders: buildFinders(game), leaderboard: leaderboard(game),
      isLast: game.current === game.tracks.length - 1, refused: [],
    });
  } else if (game.state === "PODIUM") {
    socket.emit("game:podium", { leaderboard: leaderboard(game), tracks: podiumTracks(game) });
  }
}

/* ============================================================
   SOCKET.IO
   ============================================================ */
io.on("connection", (socket) => {

  /* ----- Écran hôte : créer (ou récupérer) une partie ----- */
  socket.on("host:create", ({ reclaim } = {}) => {
    // Si l'hôte a rafraîchi sa page, il récupère sa room encore vivante
    let game = reclaim ? rooms.get(String(reclaim).toUpperCase()) : null;
    if (game && game.hostId && io.sockets.sockets.get(game.hostId)) game = null; // déjà un hôte actif
    if (!game) game = createGame();

    game.hostId = socket.id;
    game.hostLeftAt = null;
    socket.data.code = game.code;
    socket.data.role = "host";
    socket.join(game.code);

    socket.emit("host:init", {
      code: game.code,
      lanUrl: LAN_URL, // fallback si l'hôte a ouvert la page via localhost
      remoteAudio: game.remoteAudio,
      opts: game.opts,
      resume: game.state !== "LOBBY", // partie déjà en cours (après refresh)
    });
    broadcastLobby(game);

    // Resynchronisation d'un hôte qui a rafraîchi sa page en pleine partie
    if (game.state === "PLAYING" && game.round && !game.round.revealed) {
      const track = game.tracks[game.current];
      socket.emit("round:start", {
        index: game.current,
        total: game.tracks.length,
        category: track.category,
        endsAt: game.round.endsAt,
        seconds: game.opts.roundSeconds,
        mode: game.opts.answerMode,
        previewUrl: track.previewUrl,
      });
      // L'indice était déjà passé ? On le renvoie.
      if (Date.now() >= game.round.startsAt + (game.opts.roundSeconds * 1000) / 2) sendHint(game);
    } else if (game.state === "REVEAL") {
      game.round.revealed = false; // ré-émettre la révélation à toute la room
      endRound(game);
    } else if (game.state === "PODIUM") {
      socket.emit("game:podium", { leaderboard: leaderboard(game), tracks: podiumTracks(game) });
    }
  });

  socket.on("host:setRemoteAudio", (on) => {
    const game = gameOf(socket);
    if (!game || socket.id !== game.hostId) return;
    game.remoteAudio = !!on;
  });

  /* ----- Réglages de la partie (lobby uniquement) ----- */
  socket.on("host:setOptions", (o = {}) => {
    const game = gameOf(socket);
    if (!game || socket.id !== game.hostId || game.state !== "LOBBY") return;
    const opts = game.opts;
    if ([2, 3, 4, 5].includes(+o.tracksPerCat)) opts.tracksPerCat = +o.tracksPerCat;
    if ([15, 25, 35, 45].includes(+o.roundSeconds)) opts.roundSeconds = +o.roundSeconds;
    if (["libre", "oneshot"].includes(o.answerMode)) opts.answerMode = o.answerMode;
    if (["players", "host"].includes(o.playlistMode)) opts.playlistMode = o.playlistMode;
    if (Array.isArray(o.themes)) {
      opts.themes = o.themes.map((t) => String(t).trim().slice(0, 40)).filter((t) => t.length >= 2).slice(0, 6);
    }
  });

  socket.on("host:start", async () => {
    const game = gameOf(socket);
    if (!game || socket.id !== game.hostId || game.state !== "LOBBY") return;
    if (game.players.size < CONFIG.MIN_PLAYERS) return;

    if (game.opts.playlistMode === "host") {
      if (!game.opts.themes.length) {
        return socket.emit("host:error", { message: "Ajoute au moins un thème (séparés par des virgules)." });
      }
      game.state = "GENERATING";
      io.to(game.code).emit("game:generating");
      try {
        await buildHostPlaylist(game);
      } catch (e) {
        game.state = "LOBBY";
        socket.emit("host:error", { message: `${e.message} — essaie un autre thème.` });
        broadcastLobby(game);
      }
    } else {
      game.state = "CATEGORIES";
      io.to(game.code).emit("categories:start");
      broadcastLobby(game);
    }
  });

  socket.on("host:next", () => {
    const game = gameOf(socket);
    if (!game || socket.id !== game.hostId || game.state !== "REVEAL") return;
    startRound(game);
  });

  socket.on("host:skip", () => {
    const game = gameOf(socket);
    if (!game || socket.id !== game.hostId || game.state !== "PLAYING") return;
    endRound(game);
  });

  /* ----- Litige : l'hôte accorde un point refusé par le matching ----- */
  socket.on("host:grant", ({ id, what } = {}) => {
    const game = gameOf(socket);
    if (!game || socket.id !== game.hostId || game.state !== "REVEAL" || !game.round) return;
    const p = game.players.get(String(id || ""));
    if (!p || !["title", "artist"].includes(what)) return;
    const entry = game.round.found.get(p.key) || { title: false, artist: false, points: 0 };
    if (entry[what]) return;
    entry[what] = true;
    const gained = what === "title" ? CONFIG.POINTS_TITLE : CONFIG.POINTS_ARTIST;
    entry.points += gained;
    p.score += gained;
    game.round.found.set(p.key, entry);
    io.to(game.code).emit("reveal:update", { finders: buildFinders(game), leaderboard: leaderboard(game) });
    if (p.sid) io.to(p.sid).emit("score:sync", { score: p.score, gained, what });
  });

  /* Rejouer : on garde le même code de room (les téléphones sont déjà dessus) */
  socket.on("host:replay", () => {
    const game = gameOf(socket);
    if (!game || socket.id !== game.hostId) return;
    clearRoundTimers(game.round);
    game.state = "LOBBY";
    game.players = new Map();
    game.tracks = [];
    game.current = -1;
    game.round = null;
    socket.emit("host:init", { code: game.code, lanUrl: LAN_URL, remoteAudio: game.remoteAudio, opts: game.opts, resume: false });
    io.to(game.code).emit("game:reset", { code: game.code });
    broadcastLobby(game);
  });

  /* ----- Joueurs (mobiles) : rejoindre une room par son code ----- */
  socket.on("player:join", ({ code, name, key } = {}, ack) => {
    code = String(code || "").trim().toUpperCase();
    name = String(name || "").trim().slice(0, 16);
    key = String(key || "").slice(0, 64);
    const game = rooms.get(code);

    if (!game) return ack && ack({ ok: false, error: `Aucune partie avec le code ${code || "…"}.` });

    // Reconnexion : la clé du téléphone est déjà connue → on reprend la partie
    const existing = key && game.players.get(key);
    if (existing) {
      existing.sid = socket.id;
      existing.connected = true;
      if (game.state === "LOBBY" && name) existing.name = name;
      socket.data.code = game.code;
      socket.data.key = key;
      socket.data.role = "player";
      socket.join(game.code);
      ack && ack({
        ok: true, rejoined: true, name: existing.name, code: game.code, key,
        score: existing.score, state: game.state, category: existing.category,
      });
      broadcastLobby(game);
      sendSnapshot(game, socket, existing);
      return;
    }

    if (!name) return ack && ack({ ok: false, error: "Entre un pseudo." });
    if (game.state !== "LOBBY") return ack && ack({ ok: false, error: "Cette partie a déjà commencé." });
    const taken = [...game.players.values()].some((p) => normalize(p.name) === normalize(name));
    if (taken) return ack && ack({ ok: false, error: "Ce pseudo est déjà pris dans cette partie." });

    const pkey = key || crypto.randomUUID();
    socket.data.code = game.code;
    socket.data.key = pkey;
    socket.data.role = "player";
    socket.join(game.code);
    game.players.set(pkey, {
      key: pkey, sid: socket.id, name, score: 0, streak: 0,
      category: null, categoryOk: false, connected: true,
    });
    ack && ack({ ok: true, name, code: game.code, key: pkey });
    broadcastLobby(game);
  });

  socket.on("player:category", async ({ category }, ack) => {
    const game = gameOf(socket);
    const p = game && game.players.get(socket.data.key);
    if (!p || game.state !== "CATEGORIES") return;
    category = String(category || "").trim().slice(0, 40);
    if (category.length < 2) return ack && ack({ ok: false, error: "Catégorie trop courte." });

    try {
      const results = await searchItunes(category);
      if (results.length < game.opts.tracksPerCat) {
        return ack && ack({ ok: false, error: `Pas assez de résultats pour « ${category} ». Essaie autre chose !` });
      }
      p.category = category;
      p.categoryOk = true;
      p._results = results;
      ack && ack({ ok: true, category });
      broadcastLobby(game);
      io.to(game.hostId).emit("categories:progress", { players: playersPublic(game) });

      const all = [...game.players.values()];
      if (all.length > 0 && all.every((x) => x.categoryOk) && game.state === "CATEGORIES") {
        game.state = "GENERATING";
        buildPlaylistAndStart(game);
      }
    } catch (e) {
      console.error("Recherche iTunes :", e.message);
      ack && ack({ ok: false, error: "Recherche impossible côté serveur. Réessaie." });
    }
  });

  socket.on("player:answer", ({ text }, ack) => {
    const game = gameOf(socket);
    const p = game && game.players.get(socket.data.key);
    if (!p || game.state !== "PLAYING" || !game.round || game.round.revealed) return;
    text = String(text || "").trim();
    if (!text) return;

    const round = game.round;
    const track = game.tracks[game.current];
    const oneshot = game.opts.answerMode === "oneshot";
    const already = round.found.get(p.key) || { title: false, artist: false, points: 0 };

    if (oneshot && round.attempts.has(p.key)) {
      return ack && ack({
        found: null, gained: 0, locked: true,
        titleDone: already.title, artistDone: already.artist, score: p.score,
      });
    }
    if (oneshot) round.attempts.set(p.key, text);

    const remaining = Math.max(0, round.endsAt - Date.now());
    const ratio = remaining / (game.opts.roundSeconds * 1000);
    // Multiplicateur : mode "un seul essai" ×2, série +15 %/manche (plafonnée)
    const mult = (oneshot ? CONFIG.ONESHOT_MULT : 1)
      * (1 + CONFIG.STREAK_STEP * Math.min(p.streak || 0, CONFIG.STREAK_MAX));
    let gained = 0;
    let found = null;

    if (!already.title && fuzzyMatch(text, track.title)) {
      gained = Math.round((CONFIG.POINTS_TITLE + CONFIG.SPEED_BONUS_MAX * ratio) * mult);
      already.title = true;
      found = "title";
    } else if (!already.artist && matchArtist(text, track.artist)) {
      gained = Math.round((CONFIG.POINTS_ARTIST + (CONFIG.SPEED_BONUS_MAX / 2) * ratio) * mult);
      already.artist = true;
      found = "artist";
    }

    let near = false;
    if (gained > 0) {
      already.points += gained;
      p.score += gained;
      round.found.set(p.key, already);
      io.to(game.hostId).emit("round:someoneFound", {
        name: p.name, what: found, foundCount: round.found.size,
      });
    } else {
      near = isNear(text, track, already);
      const list = round.refused.get(p.key) || [];
      if (!list.includes(text) && list.length < 3) list.push(text);
      round.refused.set(p.key, list);
    }

    ack && ack({
      found, gained, near,
      locked: oneshot, // en mode "un seul essai", l'essai est consommé
      streak: p.streak || 0,
      titleDone: already.title,
      artistDone: already.artist,
      score: p.score,
    });

    const connected = [...game.players.values()].filter((x) => x.connected);
    const everyoneDone = connected.length > 0 && connected.every((x) => {
      if (oneshot) return round.attempts.has(x.key);
      const f = round.found.get(x.key);
      return f && f.title && f.artist;
    });
    if (everyoneDone) endRound(game);
  });

  socket.on("disconnect", () => {
    const game = gameOf(socket);
    if (!game) return;
    if (socket.id === game.hostId) {
      game.hostId = null;
      game.hostLeftAt = Date.now();
      return;
    }
    const p = game.players.get(socket.data.key);
    if (!p || p.sid !== socket.id) return; // une reconnexion a déjà repris la main
    p.connected = false;
    if (game.state === "LOBBY") game.players.delete(socket.data.key);
    broadcastLobby(game);
  });
});

/* ---------- Go ---------- */
server.listen(PORT, () => {
  console.log("=====================================");
  console.log("  🎵 BLIND TEST PARTY — multi-rooms");
  console.log(`  En local : ${LAN_URL}/host (créer une partie)`);
  console.log("  En ligne : déployez, puis n'importe quel PC ouvre /host");
  console.log("=====================================");
});

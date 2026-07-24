/* ============================================================
   BLIND TEST PARTY — serveur multi-rooms
   Un vrai site : N'IMPORTE QUEL PC ouvre /host et crée sa partie.
   Chaque room a son code, son écran hôte (qui joue la musique)
   et ses joueurs. Plusieurs parties peuvent tourner en même temps.
   Express + Socket.io + API iTunes — Node >= 18
   ============================================================ */

const os = require("os");
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

/* ---------- Réglages du jeu ---------- */
const CONFIG = {
  TRACKS_PER_CATEGORY: 3,   // musiques par catégorie (3 ou 4)
  ROUND_SECONDS: 25,        // temps de réponse par extrait
  POINTS_TITLE: 100,
  POINTS_ARTIST: 50,
  SPEED_BONUS_MAX: 50,
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

function createGame() {
  const game = {
    code: makeCode(),
    createdAt: Date.now(),
    state: "LOBBY", // LOBBY -> CATEGORIES -> PLAYING -> REVEAL -> PODIUM
    hostId: null,
    remoteAudio: false, // true = les téléphones jouent aussi l'extrait
    players: new Map(), // socketId -> { id, name, score, category, categoryOk, connected }
    tracks: [],
    current: -1,
    round: null,
  };
  rooms.set(game.code, game);
  console.log(`🎧 Room créée : ${game.code} (${rooms.size} active·s)`);
  return game;
}

function destroyGame(game) {
  if (game.round) clearTimeout(game.round.timer);
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
    id: p.id, name: p.name, score: p.score,
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
  for (const [sid] of game.players) io.to(sid).emit(event, payload);
}

/* ============================================================
   NORMALISATION + MATCHING PERMISSIF (fautes d'orthographe)
   ============================================================ */
function normalize(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
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
  const durationMs = CONFIG.ROUND_SECONDS * 1000;
  game.round = {
    startsAt: Date.now(),
    endsAt: Date.now() + durationMs,
    found: new Map(),
    revealed: false,
    timer: setTimeout(() => endRound(game), durationMs),
  };

  const base = {
    index: game.current,
    total: game.tracks.length,
    category: track.category,
    endsAt: game.round.endsAt,
    seconds: CONFIG.ROUND_SECONDS,
  };
  // L'écran hôte de CETTE room joue le son
  io.to(game.hostId).emit("round:start", { ...base, previewUrl: track.previewUrl });
  // Les téléphones aussi, si l'option "à distance" est activée
  emitToPlayers(game, "round:start", game.remoteAudio ? { ...base, previewUrl: track.previewUrl } : base);
}

function endRound(game) {
  if (!game.round || game.round.revealed) return;
  clearTimeout(game.round.timer);
  game.round.revealed = true;
  game.state = "REVEAL";

  const track = game.tracks[game.current];
  const finders = [...game.round.found.entries()].map(([pid, f]) => {
    const p = game.players.get(pid);
    return { name: p ? p.name : "?", title: f.title, artist: f.artist, points: f.points };
  }).sort((a, b) => b.points - a.points);

  io.to(game.code).emit("round:reveal", {
    index: game.current,
    total: game.tracks.length,
    title: track.title,
    artist: track.artist,
    artwork: track.artwork,
    category: track.category,
    finders,
    leaderboard: leaderboard(game),
    isLast: game.current === game.tracks.length - 1,
  });
}

function endGame(game) {
  game.state = "PODIUM";
  io.to(game.code).emit("game:podium", { leaderboard: leaderboard(game) });
}

function buildPlaylistAndStart(game) {
  const all = [...game.players.values()];
  let tracks = [];
  for (const p of all) {
    tracks = tracks.concat(pickTracks(p._results, CONFIG.TRACKS_PER_CATEGORY, p.category));
    delete p._results;
  }
  game.tracks = shuffle(tracks);
  io.to(game.code).emit("game:generated", {
    total: game.tracks.length,
    categories: all.map((p) => ({ name: p.name, category: p.category })),
  });
  setTimeout(() => startRound(game), 3500);
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
        seconds: CONFIG.ROUND_SECONDS,
        previewUrl: track.previewUrl,
      });
    } else if (game.state === "REVEAL") {
      game.round.revealed = false; // ré-émettre la révélation à toute la room
      endRound(game);
    } else if (game.state === "PODIUM") {
      socket.emit("game:podium", { leaderboard: leaderboard(game) });
    }
  });

  socket.on("host:setRemoteAudio", (on) => {
    const game = gameOf(socket);
    if (!game || socket.id !== game.hostId) return;
    game.remoteAudio = !!on;
  });

  socket.on("host:start", () => {
    const game = gameOf(socket);
    if (!game || socket.id !== game.hostId || game.state !== "LOBBY") return;
    if (game.players.size < CONFIG.MIN_PLAYERS) return;
    game.state = "CATEGORIES";
    io.to(game.code).emit("categories:start");
    broadcastLobby(game);
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

  /* Rejouer : on garde le même code de room (les téléphones sont déjà dessus) */
  socket.on("host:replay", () => {
    const game = gameOf(socket);
    if (!game || socket.id !== game.hostId) return;
    if (game.round) clearTimeout(game.round.timer);
    game.state = "LOBBY";
    game.players = new Map();
    game.tracks = [];
    game.current = -1;
    game.round = null;
    socket.emit("host:init", { code: game.code, lanUrl: LAN_URL, remoteAudio: game.remoteAudio, resume: false });
    io.to(game.code).emit("game:reset", { code: game.code });
    broadcastLobby(game);
  });

  /* ----- Joueurs (mobiles) : rejoindre une room par son code ----- */
  socket.on("player:join", ({ code, name }, ack) => {
    code = String(code || "").trim().toUpperCase();
    name = String(name || "").trim().slice(0, 16);
    const game = rooms.get(code);

    if (!game) return ack && ack({ ok: false, error: `Aucune partie avec le code ${code || "…"}.` });
    if (!name) return ack && ack({ ok: false, error: "Entre un pseudo." });
    if (game.state !== "LOBBY") return ack && ack({ ok: false, error: "Cette partie a déjà commencé." });
    const taken = [...game.players.values()].some((p) => normalize(p.name) === normalize(name));
    if (taken) return ack && ack({ ok: false, error: "Ce pseudo est déjà pris dans cette partie." });

    socket.data.code = game.code;
    socket.data.role = "player";
    socket.join(game.code);
    game.players.set(socket.id, {
      id: socket.id, name, score: 0,
      category: null, categoryOk: false, connected: true,
    });
    ack && ack({ ok: true, name, code: game.code });
    broadcastLobby(game);
  });

  socket.on("player:category", async ({ category }, ack) => {
    const game = gameOf(socket);
    const p = game && game.players.get(socket.id);
    if (!p || game.state !== "CATEGORIES") return;
    category = String(category || "").trim().slice(0, 40);
    if (category.length < 2) return ack && ack({ ok: false, error: "Catégorie trop courte." });

    try {
      const results = await searchItunes(category);
      if (results.length < CONFIG.TRACKS_PER_CATEGORY) {
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
    const p = game && game.players.get(socket.id);
    if (!p || game.state !== "PLAYING" || !game.round || game.round.revealed) return;
    text = String(text || "").trim();
    if (!text) return;

    const track = game.tracks[game.current];
    const already = game.round.found.get(socket.id) || { title: false, artist: false, points: 0 };

    const remaining = Math.max(0, game.round.endsAt - Date.now());
    const ratio = remaining / (CONFIG.ROUND_SECONDS * 1000);
    let gained = 0;
    let found = null;

    if (!already.title && fuzzyMatch(text, track.title)) {
      gained = CONFIG.POINTS_TITLE + Math.round(CONFIG.SPEED_BONUS_MAX * ratio);
      already.title = true;
      found = "title";
    } else if (!already.artist && fuzzyMatch(text, track.artist)) {
      gained = CONFIG.POINTS_ARTIST + Math.round((CONFIG.SPEED_BONUS_MAX / 2) * ratio);
      already.artist = true;
      found = "artist";
    }

    if (gained > 0) {
      already.points += gained;
      p.score += gained;
      game.round.found.set(socket.id, already);
      io.to(game.hostId).emit("round:someoneFound", {
        name: p.name, what: found, foundCount: game.round.found.size,
      });
    }
    ack && ack({
      found, gained,
      titleDone: already.title,
      artistDone: already.artist,
      score: p.score,
    });

    const everyoneDone = [...game.players.values()]
      .filter((x) => x.connected)
      .every((x) => {
        const f = game.round.found.get(x.id);
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
    const p = game.players.get(socket.id);
    if (!p) return;
    if (game.state === "LOBBY") game.players.delete(socket.id);
    else p.connected = false;
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

/* ================= ÉCRAN PC (HOST) ================= */
const socket = io();
const $ = (id) => document.getElementById(id);

const screens = ["screen-lobby", "screen-categories", "screen-generating", "screen-play", "screen-reveal", "screen-podium"];
function show(id) {
  screens.forEach((s) => $(s).classList.toggle("active", s === id));
}

/* ---------- Égaliseur (barres générées) ---------- */
const eq = $("equalizer");
for (let i = 0; i < 24; i++) {
  const bar = document.createElement("span");
  bar.style.animationDelay = `${(Math.random() * 0.9).toFixed(2)}s`;
  bar.style.animationDuration = `${(0.5 + Math.random() * 0.7).toFixed(2)}s`;
  eq.appendChild(bar);
}

/* ---------- Sons d'ambiance (synthétisés, aucun fichier) ---------- */
let audioCtx = null;
let soundsOn = localStorage.getItem("btSounds") !== "0";
$("btnSound").textContent = soundsOn ? "🔊" : "🔇";
function ctx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
function blip(freq, when = 0, dur = 0.12, type = "triangle", vol = 0.18) {
  if (!soundsOn) return;
  try {
    const c = ctx();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, c.currentTime + when);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + when + dur);
    o.connect(g).connect(c.destination);
    o.start(c.currentTime + when);
    o.stop(c.currentTime + when + dur + 0.05);
  } catch (_) {}
}
const sfx = {
  found: () => { blip(880, 0, 0.1); blip(1318, 0.09, 0.16); },
  tick: () => blip(1200, 0, 0.05, "square", 0.07),
  reveal: () => { blip(659, 0, 0.12); blip(523, 0.1, 0.2); },
  drum: () => { for (let i = 0; i < 16; i++) blip(150 + Math.random() * 70, i * 0.07, 0.05, "square", 0.09); },
  fanfare: () => {
    [523, 659, 784, 1047].forEach((f, i) => blip(f, i * 0.14, 0.22, "triangle", 0.22));
    blip(1319, 0.62, 0.55, "triangle", 0.2);
  },
};
$("btnSound").addEventListener("click", () => {
  soundsOn = !soundsOn;
  localStorage.setItem("btSounds", soundsOn ? "1" : "0");
  $("btnSound").textContent = soundsOn ? "🔊" : "🔇";
  if (soundsOn) sfx.found();
});

/* ---------- Confettis (canvas maison) ---------- */
function confettiBurst(duration = 3200) {
  const cv = $("confetti");
  const c2 = cv.getContext("2d");
  cv.width = innerWidth;
  cv.height = innerHeight;
  cv.classList.add("on");
  const colors = ["#ff8c3b", "#3ddc97", "#b18cff", "#f4f0ff", "#ffc53d"];
  const parts = Array.from({ length: 170 }, () => ({
    x: Math.random() * cv.width,
    y: -30 - Math.random() * cv.height * 0.6,
    w: 6 + Math.random() * 6,
    h: 8 + Math.random() * 9,
    vy: 2 + Math.random() * 3.5,
    vx: -1.5 + Math.random() * 3,
    rot: Math.random() * Math.PI,
    vr: -0.12 + Math.random() * 0.24,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const t0 = performance.now();
  (function tick(now) {
    c2.clearRect(0, 0, cv.width, cv.height);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      c2.save();
      c2.translate(p.x, p.y);
      c2.rotate(p.rot);
      c2.fillStyle = p.color;
      c2.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      c2.restore();
    }
    if (now - t0 < duration) requestAnimationFrame(tick);
    else { c2.clearRect(0, 0, cv.width, cv.height); cv.classList.remove("on"); }
  })(t0);
}

/* ---------- Audio (extraits) ---------- */
const audio = $("audio");
audio.volume = 1;
audio.addEventListener("error", () => {
  // Extrait injouable : on propose de passer
  $("btnSkip").classList.remove("hidden");
  eq.classList.add("idle");
});
audio.addEventListener("playing", () => {
  eq.classList.remove("idle");
  $("vinyl").classList.remove("paused");
});

/* ---------- Timer (anneau + chiffres + bips de fin) ---------- */
const RING_LEN = 754; // 2πr avec r = 120
let timerInt = null;
function runTimer(endsAt, totalSeconds, serverNow) {
  clearInterval(timerInt);
  // endsAt est une heure SERVEUR : si l'horloge du PC est décalée, on corrige
  const skew = serverNow ? serverNow - Date.now() : 0;
  const localEnd = endsAt - skew;
  const ring = $("ringFg");
  const digits = $("timerDigits");
  const totalMs = totalSeconds * 1000;
  let lastShown = null;
  function frame() {
    const left = Math.max(0, localEnd - Date.now());
    const ratio = left / totalMs;
    ring.style.strokeDashoffset = String(RING_LEN * (1 - ratio));
    const secs = Math.ceil(left / 1000);
    digits.textContent = String(secs);
    const warn = left <= 5000;
    ring.classList.toggle("warning", warn);
    digits.classList.toggle("warning", warn);
    if (warn && secs !== lastShown && secs > 0) sfx.tick();
    lastShown = secs;
    if (left <= 0) clearInterval(timerInt);
  }
  frame();
  // setInterval et pas requestAnimationFrame : le chrono continue même
  // si la fenêtre passe en arrière-plan (rAF est gelé par le navigateur)
  timerInt = setInterval(frame, 100);
}

/* ---------- Connexion : créer (ou récupérer) une partie ---------- */
socket.on("connect", () => {
  socket.emit("host:create", { reclaim: sessionStorage.getItem("btRoom") });
});

socket.on("host:init", ({ code, lanUrl, remoteAudio, opts }) => {
  sessionStorage.setItem("btRoom", code);
  $("roomChip").textContent = `ROOM ${code}`;
  $("chkRemoteAudio").checked = !!remoteAudio;

  if (opts) {
    $("optTracks").value = String(opts.tracksPerCat);
    $("optDifficulty").value = opts.difficulty || "facile";
    $("optAnswerMode").value = opts.answerMode;
    $("optPlaylistMode").value = opts.playlistMode;
    $("optThemes").value = (opts.themes || []).join(", ");
    $("optThemes").classList.toggle("hidden", opts.playlistMode !== "host");
  }

  // Adresse à scanner : l'URL du site lui-même.
  // Si l'hôte a ouvert localhost, on retombe sur l'IP LAN fournie par le serveur.
  const origin = /^https?:\/\/(localhost|127\.)/.test(location.origin) ? lanUrl : location.origin;
  const joinUrl = `${origin}/?room=${code}`;

  $("joinUrl").textContent = joinUrl.replace(/^https?:\/\//, "");
  $("qrcode").innerHTML = "";
  new QRCode($("qrcode"), { text: joinUrl, width: 220, height: 220, colorDark: "#171028", colorLight: "#f4f0ff" });
});

$("chkRemoteAudio").addEventListener("change", (e) => {
  socket.emit("host:setRemoteAudio", e.target.checked);
});

/* ---------- Réglages de la partie ---------- */
function sendOptions() {
  $("lobbyError").textContent = "";
  $("optThemes").classList.toggle("hidden", $("optPlaylistMode").value !== "host");
  socket.emit("host:setOptions", {
    tracksPerCat: +$("optTracks").value,
    difficulty: $("optDifficulty").value,
    answerMode: $("optAnswerMode").value,
    playlistMode: $("optPlaylistMode").value,
    themes: $("optThemes").value.split(",").map((s) => s.trim()).filter(Boolean),
  });
}
["optTracks", "optDifficulty", "optAnswerMode", "optPlaylistMode"].forEach((id) =>
  $(id).addEventListener("change", sendOptions)
);
let themesTimer = null;
$("optThemes").addEventListener("input", () => {
  clearTimeout(themesTimer);
  themesTimer = setTimeout(sendOptions, 400);
});

socket.on("host:error", ({ message }) => {
  show("screen-lobby");
  $("lobbyError").textContent = message;
});

/* ---------- Lobby ---------- */
socket.on("lobby:update", ({ players, state }) => {
  if (state !== "LOBBY") return;
  const list = $("playerList");
  list.innerHTML = "";
  if (players.length === 0) {
    list.innerHTML = `<li class="player-empty">Personne pour l’instant… scannez le QR code !</li>`;
  } else {
    for (const p of players) {
      const li = document.createElement("li");
      li.textContent = p.name;
      if (!p.connected) li.classList.add("off");
      list.appendChild(li);
    }
  }
  $("playerCount").textContent = `(${players.length})`;
  $("btnStart").disabled = players.length < 1;
});

$("btnStart").addEventListener("click", () => {
  // Le clic débloque aussi l'autoplay audio + le contexte des sons
  audio.play().catch(() => {});
  audio.pause();
  if (soundsOn) ctx();
  socket.emit("host:start");
});

/* ---------- Catégories ---------- */
socket.on("categories:start", () => {
  show("screen-categories");
  $("catProgress").innerHTML = "";
});

socket.on("categories:progress", ({ players }) => {
  const ul = $("catProgress");
  ul.innerHTML = "";
  for (const p of players) {
    const li = document.createElement("li");
    li.textContent = p.name;
    if (p.categoryOk) li.classList.add("ok");
    ul.appendChild(li);
  }
});

/* ---------- Génération ---------- */
socket.on("game:generating", () => show("screen-generating"));

socket.on("game:generated", ({ total, categories }) => {
  show("screen-generating");
  const ul = $("genCats");
  ul.innerHTML = "";
  for (const c of categories) {
    const li = document.createElement("li");
    li.innerHTML = `<b>${escapeHtml(c.category)}</b>${c.name ? ` · par ${escapeHtml(c.name)}` : ""}`;
    ul.appendChild(li);
  }
});

/* ---------- Manche ---------- */
socket.on("round:start", ({ index, total, category, previewUrl, endsAt, now, seconds, mode, difficulty, hasWork }) => {
  show("screen-play");
  const modeTag = mode === "oneshot" ? " · ⚡ un seul essai" : "";
  const diffTag = difficulty === "moyen" ? " · 🎚️ niveau moyen"
    : difficulty === "difficile" ? " · 🔥 niveau difficile" : "";
  const workTag = hasWork ? " · 🎬 film/série à deviner !" : "";
  $("roundInfo").textContent = `Extrait ${index + 1} / ${total} · Catégorie : ${category}${modeTag}${diffTag}${workTag}`;
  $("foundTicker").innerHTML = "Écoutez bien… répondez sur vos téléphones !";
  $("btnSkip").classList.add("hidden");
  $("hintBox").classList.add("hidden");
  eq.classList.add("idle");
  audio.src = previewUrl;
  audio.currentTime = 0;
  audio.play().catch(() => $("btnSkip").classList.remove("hidden"));
  runTimer(endsAt, seconds, now);
});

/* Indice de mi-manche : pochette floutée + initiales du titre */
socket.on("round:hint", ({ artwork, titleMask }) => {
  $("hintArt").src = artwork || "";
  $("hintMask").textContent = titleMask;
  $("hintBox").classList.remove("hidden");
});

socket.on("round:someoneFound", ({ name, what, foundCount }) => {
  const label = what === "title" ? "le titre" : what === "work" ? "le film/la série" : "l’artiste";
  $("foundTicker").innerHTML = `🔥 <b>${escapeHtml(name)}</b> a trouvé ${label} ! (${foundCount} joueur·euse·s sur le coup)`;
  sfx.found();
});

$("btnSkip").addEventListener("click", () => socket.emit("host:skip"));

/* ---------- Révélation ---------- */
function renderFinders(finders) {
  const ul = $("finders");
  ul.innerHTML = "";
  if (finders.length === 0) {
    ul.innerHTML = `<li class="nobody">Personne n’a trouvé… 😅</li>`;
  } else {
    for (const f of finders) {
      const li = document.createElement("li");
      const what = [f.title ? "titre" : null, f.artist ? "artiste" : null, f.work ? "film" : null].filter(Boolean).join(" + ");
      li.innerHTML = `<b>${escapeHtml(f.name)}</b> · ${what} · +${f.points} pts`;
      ul.appendChild(li);
    }
  }
}

function renderMiniBoard(leaderboard) {
  $("miniBoard").innerHTML = leaderboard
    .slice(0, 6)
    .map((p) => `<span>${p.rank}. <b>${escapeHtml(p.name)}</b> ${p.score}</span>`)
    .join("");
}

/* Litiges : réponses refusées que l'hôte peut accepter quand même */
function renderGrant(refused = [], hasWork = false) {
  const panel = $("grantPanel");
  const ul = $("grantList");
  ul.innerHTML = "";
  const rows = refused.filter((r) => r.guesses && r.guesses.length);
  if (!rows.length) { panel.classList.add("hidden"); return; }
  panel.classList.remove("hidden");
  for (const r of rows) {
    const li = document.createElement("li");
    const btns = [];
    if (!r.titleDone) btns.push(`<button class="btn-grant" data-id="${escapeHtml(r.id)}" data-what="title">✔ Accorder le titre</button>`);
    if (!r.artistDone) btns.push(`<button class="btn-grant" data-id="${escapeHtml(r.id)}" data-what="artist">✔ Accorder l’artiste</button>`);
    if (hasWork && !r.workDone) btns.push(`<button class="btn-grant" data-id="${escapeHtml(r.id)}" data-what="work">✔ Accorder le film</button>`);
    li.innerHTML = `<b>${escapeHtml(r.name)}</b> a proposé ${r.guesses.map((g) => `« ${escapeHtml(g)} »`).join(", ")} ${btns.join(" ")}`;
    ul.appendChild(li);
  }
}
$("grantList").addEventListener("click", (e) => {
  const b = e.target.closest(".btn-grant");
  if (!b) return;
  socket.emit("host:grant", { id: b.dataset.id, what: b.dataset.what });
  b.remove();
});

socket.on("round:reveal", ({ title, artist, work, artwork, category, finders, leaderboard, isLast, refused }) => {
  audio.pause();
  clearInterval(timerInt);
  show("screen-reveal");
  sfx.reveal();

  $("revealArt").src = artwork || "";
  $("revealTitle").textContent = title;
  $("revealArtist").textContent = artist;
  $("revealWork").textContent = work ? `🎬 ${work}` : "";
  $("revealWork").classList.toggle("hidden", !work);
  $("revealCat").textContent = `Catégorie : ${category}`;

  renderFinders(finders);
  renderMiniBoard(leaderboard);
  renderGrant(refused, !!work);

  $("btnNext").textContent = isLast ? "Voir le classement" : "Extrait suivant";
});

/* L'hôte a accordé un point : mise à jour sans changer d'écran */
socket.on("reveal:update", ({ finders, leaderboard }) => {
  renderFinders(finders);
  renderMiniBoard(leaderboard);
  sfx.found();
});

$("btnNext").addEventListener("click", () => socket.emit("host:next"));

/* ---------- Podium (révélation 3·2·1 + confettis) ---------- */
socket.on("game:podium", ({ leaderboard, tracks }) => {
  audio.pause();
  show("screen-podium");
  const ol = $("podium");
  ol.innerHTML = "";
  const medals = ["🏆", "🥈", "🥉"];
  const items = leaderboard.map((p, i) => {
    const li = document.createElement("li");
    li.classList.add("veiled");
    li.innerHTML = `
      <span class="rank">${medals[i] || p.rank}</span>
      <span class="pname">${escapeHtml(p.name)}</span>
      <span class="pscore">${p.score} pts</span>`;
    ol.appendChild(li);
    return li;
  });

  // Le fond du classement apparaît d'abord, puis 3ᵉ, 2ᵉ… et le vainqueur
  const revealAt = (i, delay) => setTimeout(() => items[i] && items[i].classList.remove("veiled"), delay);
  let delay = 400;
  for (let i = items.length - 1; i >= 3; i--) {
    revealAt(i, delay);
    delay += 220;
  }
  setTimeout(() => sfx.drum(), delay);
  for (const i of [2, 1, 0]) {
    if (!items[i]) continue;
    delay += 1100;
    revealAt(i, delay);
    if (i === 0) {
      setTimeout(() => { sfx.fanfare(); confettiBurst(); }, delay);
    } else {
      setTimeout(() => sfx.reveal(), delay);
    }
  }

  renderHistory(tracks);
});

/* Historique : la playlist de la soirée */
function renderHistory(tracks = []) {
  const box = $("history");
  const grid = $("historyGrid");
  grid.innerHTML = "";
  if (!tracks.length) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  for (const t of tracks) {
    const d = document.createElement("div");
    d.className = "history-card";
    d.innerHTML = `
      <img src="${escapeHtml(t.artwork || "")}" alt="" loading="lazy" />
      <b>${escapeHtml(t.title)}</b>
      <span>${escapeHtml(t.artist)}</span>${t.work ? `<span>🎬 ${escapeHtml(t.work)}</span>` : ""}`;
    grid.appendChild(d);
  }
}

$("btnReplay").addEventListener("click", () => socket.emit("host:replay"));
socket.on("game:reset", () => {
  audio.pause();
  show("screen-lobby");
});

/* ---------- Utils ---------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

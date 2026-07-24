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

/* ---------- Audio ---------- */
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

/* ---------- Timer (anneau + chiffres) ---------- */
const RING_LEN = 754; // 2πr avec r = 120
let rafId = null;
function runTimer(endsAt, totalSeconds) {
  cancelAnimationFrame(rafId);
  const ring = $("ringFg");
  const digits = $("timerDigits");
  const totalMs = totalSeconds * 1000;
  function frame() {
    const left = Math.max(0, endsAt - Date.now());
    const ratio = left / totalMs;
    ring.style.strokeDashoffset = String(RING_LEN * (1 - ratio));
    digits.textContent = String(Math.ceil(left / 1000));
    const warn = left <= 5000;
    ring.classList.toggle("warning", warn);
    digits.classList.toggle("warning", warn);
    if (left > 0) rafId = requestAnimationFrame(frame);
  }
  frame();
}

/* ---------- Connexion : créer (ou récupérer) une partie ---------- */
socket.on("connect", () => {
  socket.emit("host:create", { reclaim: sessionStorage.getItem("btRoom") });
});

socket.on("host:init", ({ code, lanUrl, remoteAudio }) => {
  sessionStorage.setItem("btRoom", code);
  $("roomChip").textContent = `ROOM ${code}`;
  $("chkRemoteAudio").checked = !!remoteAudio;

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
  // Le clic débloque aussi l'autoplay audio du navigateur
  audio.play().catch(() => {});
  audio.pause();
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
socket.on("game:generated", ({ total, categories }) => {
  show("screen-generating");
  const ul = $("genCats");
  ul.innerHTML = "";
  for (const c of categories) {
    const li = document.createElement("li");
    li.innerHTML = `<b>${escapeHtml(c.category)}</b> · par ${escapeHtml(c.name)}`;
    ul.appendChild(li);
  }
});

/* ---------- Manche ---------- */
socket.on("round:start", ({ index, total, category, previewUrl, endsAt, seconds }) => {
  show("screen-play");
  $("roundInfo").textContent = `Extrait ${index + 1} / ${total} · Catégorie : ${category}`;
  $("foundTicker").innerHTML = "Écoutez bien… répondez sur vos téléphones !";
  $("btnSkip").classList.add("hidden");
  eq.classList.add("idle");
  audio.src = previewUrl;
  audio.currentTime = 0;
  audio.play().catch(() => $("btnSkip").classList.remove("hidden"));
  runTimer(endsAt, seconds);
});

socket.on("round:someoneFound", ({ name, what, foundCount }) => {
  const label = what === "title" ? "le titre" : "l’artiste";
  $("foundTicker").innerHTML = `🔥 <b>${escapeHtml(name)}</b> a trouvé ${label} ! (${foundCount} joueur·euse·s sur le coup)`;
});

$("btnSkip").addEventListener("click", () => socket.emit("host:skip"));

/* ---------- Révélation ---------- */
socket.on("round:reveal", ({ title, artist, artwork, category, finders, leaderboard, isLast }) => {
  audio.pause();
  cancelAnimationFrame(rafId);
  show("screen-reveal");

  $("revealArt").src = artwork || "";
  $("revealTitle").textContent = title;
  $("revealArtist").textContent = artist;
  $("revealCat").textContent = `Catégorie : ${category}`;

  const ul = $("finders");
  ul.innerHTML = "";
  if (finders.length === 0) {
    ul.innerHTML = `<li class="nobody">Personne n’a trouvé… 😅</li>`;
  } else {
    for (const f of finders) {
      const li = document.createElement("li");
      const what = [f.title ? "titre" : null, f.artist ? "artiste" : null].filter(Boolean).join(" + ");
      li.innerHTML = `<b>${escapeHtml(f.name)}</b> · ${what} · +${f.points} pts`;
      ul.appendChild(li);
    }
  }

  $("miniBoard").innerHTML = leaderboard
    .slice(0, 6)
    .map((p) => `<span>${p.rank}. <b>${escapeHtml(p.name)}</b> ${p.score}</span>`)
    .join("");

  $("btnNext").textContent = isLast ? "Voir le classement" : "Extrait suivant";
});

$("btnNext").addEventListener("click", () => socket.emit("host:next"));

/* ---------- Podium ---------- */
socket.on("game:podium", ({ leaderboard }) => {
  audio.pause();
  show("screen-podium");
  const ol = $("podium");
  ol.innerHTML = "";
  const medals = ["🏆", "🥈", "🥉"];
  leaderboard.forEach((p, i) => {
    const li = document.createElement("li");
    li.style.animationDelay = `${i * 0.12}s`;
    li.innerHTML = `
      <span class="rank">${medals[i] || p.rank}</span>
      <span class="pname">${escapeHtml(p.name)}</span>
      <span class="pscore">${p.score} pts</span>`;
    ol.appendChild(li);
  });
});

$("btnReplay").addEventListener("click", () => socket.emit("host:replay"));
socket.on("game:reset", () => {
  audio.pause();
  show("screen-lobby");
});

/* ---------- Utils ---------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

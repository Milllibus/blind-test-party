/* ================= MANETTE MOBILE (JOUEUR) ================= */
const socket = io();
const $ = (id) => document.getElementById(id);

const screens = ["p-join", "p-wait", "p-category", "p-category-ok", "p-round", "p-reveal", "p-podium"];
function show(id) {
  screens.forEach((s) => $(s).classList.toggle("active", s === id));
}

let myName = "";
let myScore = 0;
let lastGain = 0;
let roundMode = "libre";
let roundHasWork = false;

/* Clé persistante : permet de retrouver sa place après un rechargement */
function makeKey() {
  if (window.crypto && crypto.randomUUID) {
    try { return crypto.randomUUID(); } catch (_) {}
  }
  return "k" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
let myKey = localStorage.getItem("btKey");
if (!myKey) {
  myKey = makeKey();
  localStorage.setItem("btKey", myKey);
}

/* Audio local (mode distance : le serveur envoie previewUrl aux joueurs) */
const remoteAudio = new Audio();
remoteAudio.preload = "auto";
function unlockAudio() {
  // Un geste utilisateur est requis pour autoriser l'autoplay mobile
  remoteAudio.play().catch(() => {});
  remoteAudio.pause();
}

function setScore(score) {
  myScore = score;
  $("myScoreChip").textContent = `${score} pts`;
}

function setPills(titleDone, artistDone, workDone) {
  $("pillTitle").classList.toggle("done", !!titleDone);
  $("pillTitle").textContent = titleDone ? "Titre ✓" : "Titre ?";
  $("pillArtist").classList.toggle("done", !!artistDone);
  $("pillArtist").textContent = artistDone ? "Artiste ✓" : "Artiste ?";
  $("pillWork").classList.toggle("hidden", !roundHasWork);
  $("pillWork").classList.toggle("done", !!workDone);
  $("pillWork").textContent = workDone ? "Film/Série ✓" : "Film/Série ?";
}

function allFound(res) {
  return res.titleDone && res.artistDone && (!roundHasWork || res.workDone);
}

function lockAnswers(msg) {
  $("answerInput").disabled = true;
  $("btnAnswer").disabled = true;
  if (msg) {
    const fb = $("answerFeedback");
    fb.className = "answer-feedback good";
    fb.textContent = msg;
  }
}

/* ---------- 1. Rejoindre (code room + pseudo) ---------- */
// Code pré-rempli si on arrive via le QR code (/?room=ABCD)
const urlRoom = (new URLSearchParams(location.search).get("room") || "").toUpperCase();
if (urlRoom) {
  $("codeInput").value = urlRoom;
  $("nameInput").focus();
}
// Pseudo pré-rempli si on a déjà joué sur ce téléphone
const storedName = localStorage.getItem("btName");
if (storedName) $("nameInput").value = storedName;

function applyJoin(res) {
  myName = res.name;
  localStorage.setItem("btRoom", res.code);
  localStorage.setItem("btName", res.name);
  if (res.key) { myKey = res.key; localStorage.setItem("btKey", res.key); }
  $("myName").textContent = myName;
  history.replaceState(null, "", `/?room=${res.code}`);
  setScore(res.score || 0);

  if (res.rejoined && res.state === "CATEGORIES") {
    if (res.category) {
      $("myCat").textContent = `« ${res.category} »`;
      show("p-category-ok");
    } else {
      show("p-category");
    }
  } else {
    // PLAYING / REVEAL / PODIUM : le serveur renvoie l'état juste après
    show("p-wait");
  }
}

function join() {
  unlockAudio();
  const code = $("codeInput").value.trim().toUpperCase();
  const name = $("nameInput").value.trim();
  $("joinError").textContent = "";
  socket.emit("player:join", { code, name, key: myKey }, (res) => {
    if (!res || !res.ok) { $("joinError").textContent = res ? res.error : "Erreur, réessaie."; return; }
    applyJoin(res);
  });
}
$("btnJoin").addEventListener("click", join);
$("nameInput").addEventListener("keydown", (e) => e.key === "Enter" && join());

/* Reconnexion automatique : téléphone rechargé ou réseau qui a sauté */
socket.on("connect", () => {
  const code = localStorage.getItem("btRoom");
  const name = localStorage.getItem("btName");
  if (!code || !name) return;
  if (urlRoom && urlRoom !== code) return; // on arrive avec un QR d'une autre room
  socket.emit("player:join", { code, name, key: myKey }, (res) => {
    if (res && res.ok) applyJoin(res);
    // Échec silencieux : la room n'existe plus, on reste sur l'écran de connexion
  });
});

/* ---------- 2. Catégorie ---------- */
socket.on("categories:start", () => show("p-category"));

document.querySelectorAll(".chip").forEach((chip) =>
  chip.addEventListener("click", () => {
    $("catInput").value = chip.dataset.cat;
    sendCategory();
  })
);

function sendCategory() {
  const category = $("catInput").value.trim();
  $("catError").textContent = "";
  $("btnCat").disabled = true;
  $("btnCat").textContent = "Vérification…";
  socket.emit("player:category", { category }, (res) => {
    $("btnCat").disabled = false;
    $("btnCat").textContent = "Valider";
    if (!res || !res.ok) {
      $("catError").textContent = res ? res.error : "Erreur, réessaie.";
      return;
    }
    $("myCat").textContent = `« ${res.category} »`;
    show("p-category-ok");
  });
}
$("btnCat").addEventListener("click", sendCategory);
$("catInput").addEventListener("keydown", (e) => e.key === "Enter" && sendCategory());

/* ---------- 3. Manche ---------- */
socket.on("round:start", ({ index, total, category, previewUrl, mode, hasWork }) => {
  lastGain = 0;
  roundMode = mode || "libre";
  roundHasWork = !!hasWork;
  show("p-round");
  if (previewUrl) {
    remoteAudio.src = previewUrl;
    remoteAudio.currentTime = 0;
    remoteAudio.play().catch(() => {});
  }
  $("pRoundInfo").textContent = `Extrait ${index + 1} / ${total} · ${category}`;
  setPills(false, false, false);
  const fb = $("answerFeedback");
  fb.className = "answer-feedback";
  const targets = roundHasWork ? "titre, artiste ou <b>film/série</b>" : "le titre <b>ou</b> l’artiste";
  fb.innerHTML = roundMode === "oneshot"
    ? `⚡ <b>UN SEUL essai</b> (${roundHasWork ? "titre, artiste ou film/série" : "titre ou artiste"}), choisis bien ! (points ×2)`
    : `Tape ${targets}. Les fautes sont pardonnées !`;
  $("answerInput").value = "";
  $("answerInput").disabled = false;
  $("btnAnswer").disabled = false;
  $("answerInput").focus();
});

/* État renvoyé après une reconnexion en pleine manche */
socket.on("answer:state", ({ titleDone, artistDone, workDone, locked, score }) => {
  setScore(score);
  setPills(titleDone, artistDone, workDone);
  if (locked || allFound({ titleDone, artistDone, workDone })) {
    lockAnswers("Réponses enregistrées — attends la fin du chrono…");
  }
});

function sendAnswer() {
  const text = $("answerInput").value.trim();
  if (!text) return;
  $("answerInput").value = "";
  $("answerInput").focus();

  socket.emit("player:answer", { text }, (res) => {
    if (!res) return;
    const fb = $("answerFeedback");
    setScore(res.score);
    setPills(res.titleDone, res.artistDone, res.workDone);

    const streakTag = res.streak >= 1 ? ` · 🔥 bonus série !` : "";
    if (res.found === "title") {
      lastGain += res.gained;
      fb.className = "answer-feedback good";
      fb.textContent = `🎯 Titre trouvé ! +${res.gained} pts${streakTag}`;
    } else if (res.found === "artist") {
      lastGain += res.gained;
      fb.className = "answer-feedback good";
      fb.textContent = `🎤 Artiste trouvé ! +${res.gained} pts${streakTag}`;
    } else if (res.found === "work") {
      lastGain += res.gained;
      fb.className = "answer-feedback good";
      fb.textContent = `🎬 Film/Série trouvé ! +${res.gained} pts${streakTag}`;
    } else if (res.near) {
      fb.className = "answer-feedback near";
      fb.textContent = `🔥 « ${text} » … tu chauffes, c’est tout proche !`;
    } else {
      fb.className = "answer-feedback bad";
      fb.textContent = `« ${text} » … non, ${roundMode === "oneshot" ? "c’était ta seule chance 😬" : "essaie encore !"}`;
    }

    if (roundMode === "oneshot" && res.locked) {
      // L'essai est consommé, trouvé ou pas
      $("answerInput").disabled = true;
      $("btnAnswer").disabled = true;
    } else if (allFound(res)) {
      lockAnswers("💯 Carton plein ! Attends la fin du chrono…");
    }
  });
}
$("btnAnswer").addEventListener("click", sendAnswer);
$("answerInput").addEventListener("keydown", (e) => e.key === "Enter" && sendAnswer());

/* L'hôte a accordé un point en litige */
socket.on("score:sync", ({ score, gained, what }) => {
  setScore(score);
  lastGain += gained;
  $("myGain").textContent = `+${lastGain} pts pour toi 🎉 (dont ${gained} accordés par l’écran)`;
});

/* ---------- 4. Révélation ---------- */
socket.on("round:reveal", ({ title, artist, work }) => {
  remoteAudio.pause();
  show("p-reveal");
  $("pRevealTitle").textContent = title;
  $("pRevealArtist").textContent = artist + (work ? ` · 🎬 ${work}` : "");
  $("myGain").textContent = lastGain > 0 ? `+${lastGain} pts pour toi 🎉` : "0 pt cette fois… 😬";
});

/* ---------- 5. Podium ---------- */
socket.on("game:podium", ({ leaderboard }) => {
  show("p-podium");
  const me = leaderboard.find((p) => p.id === myKey) || leaderboard.find((p) => p.name === myName);
  if (me) {
    const label = me.rank === 1 ? "🏆 1ᵉʳ !" : `${me.rank}ᵉ place`;
    $("myRank").textContent = label;
    $("myFinalScore").textContent = `${me.score} points — bien joué ${myName} !`;
  }
});

socket.on("game:reset", ({ code } = {}) => {
  remoteAudio.pause();
  setScore(0);
  myName = "";
  localStorage.removeItem("btRoom"); // repartir proprement : re-choisir un pseudo
  $("nameInput").value = localStorage.getItem("btName") || "";
  if (code) $("codeInput").value = code;
  show("p-join");
});

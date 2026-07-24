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

/* ---------- 1. Rejoindre (code room + pseudo) ---------- */
// Code pré-rempli si on arrive via le QR code (/?room=ABCD)
const urlRoom = new URLSearchParams(location.search).get("room");
if (urlRoom) {
  $("codeInput").value = urlRoom.toUpperCase();
  $("nameInput").focus();
}

function join() {
  unlockAudio();
  const code = $("codeInput").value.trim().toUpperCase();
  const name = $("nameInput").value.trim();
  $("joinError").textContent = "";
  socket.emit("player:join", { code, name }, (res) => {
    if (!res.ok) { $("joinError").textContent = res.error; return; }
    myName = res.name;
    $("myName").textContent = myName;
    history.replaceState(null, "", `/?room=${res.code}`);
    show("p-wait");
  });
}
$("btnJoin").addEventListener("click", join);
$("nameInput").addEventListener("keydown", (e) => e.key === "Enter" && join());

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
socket.on("round:start", ({ index, total, category, previewUrl }) => {
  lastGain = 0;
  show("p-round");
  if (previewUrl) {
    remoteAudio.src = previewUrl;
    remoteAudio.currentTime = 0;
    remoteAudio.play().catch(() => {});
  }
  $("pRoundInfo").textContent = `Extrait ${index + 1} / ${total} · ${category}`;
  $("pillTitle").classList.remove("done");
  $("pillTitle").textContent = "Titre ?";
  $("pillArtist").classList.remove("done");
  $("pillArtist").textContent = "Artiste ?";
  const fb = $("answerFeedback");
  fb.className = "answer-feedback";
  fb.innerHTML = "Tape le titre <b>ou</b> l’artiste. Les fautes sont pardonnées !";
  $("answerInput").value = "";
  $("answerInput").disabled = false;
  $("btnAnswer").disabled = false;
  $("answerInput").focus();
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

    if (res.found === "title") {
      lastGain += res.gained;
      fb.className = "answer-feedback good";
      fb.textContent = `🎯 Titre trouvé ! +${res.gained} pts`;
    } else if (res.found === "artist") {
      lastGain += res.gained;
      fb.className = "answer-feedback good";
      fb.textContent = `🎤 Artiste trouvé ! +${res.gained} pts`;
    } else {
      fb.className = "answer-feedback bad";
      fb.textContent = `« ${text} » … non, essaie encore !`;
    }

    $("pillTitle").classList.toggle("done", res.titleDone);
    if (res.titleDone) $("pillTitle").textContent = "Titre ✓";
    $("pillArtist").classList.toggle("done", res.artistDone);
    if (res.artistDone) $("pillArtist").textContent = "Artiste ✓";

    if (res.titleDone && res.artistDone) {
      $("answerInput").disabled = true;
      $("btnAnswer").disabled = true;
      fb.className = "answer-feedback good";
      fb.textContent = "💯 Carton plein ! Attends la fin du chrono…";
    }
  });
}
$("btnAnswer").addEventListener("click", sendAnswer);
$("answerInput").addEventListener("keydown", (e) => e.key === "Enter" && sendAnswer());

/* ---------- 4. Révélation ---------- */
socket.on("round:reveal", ({ title, artist }) => {
  remoteAudio.pause();
  show("p-reveal");
  $("pRevealTitle").textContent = title;
  $("pRevealArtist").textContent = artist;
  $("myGain").textContent = lastGain > 0 ? `+${lastGain} pts pour toi 🎉` : "0 pt cette fois… 😬";
});

/* ---------- 5. Podium ---------- */
socket.on("game:podium", ({ leaderboard }) => {
  show("p-podium");
  const me = leaderboard.find((p) => p.name === myName);
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
  $("nameInput").value = "";
  if (code) $("codeInput").value = code;
  show("p-join");
});

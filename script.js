const COLORS = [
  { name: "Água", color: "#2196f3" },
  { name: "Fogo", color: "#d32f2f" },
  { name: "Terra", color: "#795548" },
  { name: "Trevas", color: "#111318" },
  { name: "Vento", color: "#43a047" },
  { name: "Luz", color: "#ececec", text: "#111" }
];

const MACROS_KEY = "tracker-element-macros";
const SHOW_MACROS_KEY = "tracker-show-macro-labels";
const PREFS_KEY = "tracker-game-settings";
const MAX_TIME_SECONDS = 99 * 60 + 99;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const setupScreen = $("#setup-screen");
const gameScreen = $("#game-screen");
const setupForm = $("#setup-form");
const playersRoot = $("#players");
const timerEnabled = $("#timer-enabled");
const timerSettings = $("#timer-settings");
const optionsModal = $("#options-modal");
const counterModal = $("#counter-modal");
const turnButton = $("#turn-button");
const captureOverlay = $("#macro-capture");
const isTabletop = detectTabletopDevice();

let config = null;
let players = [];
let currentPlayer = 0;
let gameStarted = false;
let modalWasRunning = false;
let timerInterval = null;
let lastTick = 0;
let totalTime = 0;
let currentCounter = null;
let captureAction = null;
let holdTimer = null;
let longPressTriggered = false;
let savedMacros = loadJson(MACROS_KEY, {});

document.body.classList.add(isTabletop ? "tabletop" : "wall");
restorePreferences();
renderColorOptions();
applyMacroVisibility(localStorage.getItem(SHOW_MACROS_KEY) !== "false");

timerEnabled.addEventListener("change", () => { timerSettings.hidden = !timerEnabled.checked; });
setupForm.addEventListener("submit", event => {
  event.preventDefault();
  const minutes = clampNumber($("#minutes").value, 0, 99);
  const seconds = clampNumber($("#seconds").value, 0, 99);
  const turnBonusMinutes = clampNumber($("#turn-bonus-minutes").value, 0, 99);
  const turnBonusSeconds = clampNumber($("#turn-bonus-seconds").value, 0, 99);
  config = {
    count: Number($("#player-count").value),
    direction: $("input[name='direction']:checked").value,
    timerEnabled: timerEnabled.checked,
    timerMode: $("input[name='timer-mode']:checked").value,
    minutes,
    seconds,
    turnBonusMinutes,
    turnBonusSeconds,
    turnTimeBonusSeconds: turnBonusMinutes * 60 + turnBonusSeconds,
    initialSeconds: Math.min(MAX_TIME_SECONDS, minutes * 60 + seconds)
  };
  if (config.timerEnabled && config.initialSeconds <= 0) {
    alert("Defina um tempo maior que zero.");
    return;
  }
  localStorage.setItem(PREFS_KEY, JSON.stringify(config));
  buildGame();
});

function buildGame() {
  stopTimer();
  playersRoot.innerHTML = "";
  playersRoot.className = `players count-${config.count}`;
  gameScreen.className = `screen game-screen count-${config.count}`;
  players = [];
  currentPlayer = 0;
  gameStarted = false;
  totalTime = config.initialSeconds;

  for (let index = 0; index < config.count; index += 1) {
    const fragment = $("#player-template").content.cloneNode(true);
    const player = $(".player", fragment);
    player.dataset.player = index;
    $(".player-name", player).value = `Jogador ${index + 1}`;
    setOrientation(player, getOrientation(config.count, index));
    initializeCounters(player, index);
    const timer = $(".player-timer", player);
    timer.hidden = !config.timerEnabled;
    playersRoot.appendChild(fragment);
    players.push({ element: playersRoot.lastElementChild, remaining: config.initialSeconds });
  }

  setupScreen.hidden = true;
  gameScreen.hidden = false;
  refreshCurrentPlayer();
  refreshTimers();
  requestAnimationFrame(fitRotatedFaces);
}

function initializeCounters(player, playerIndex) {
  $$(".counter", player).forEach((counter, counterIndex) => {
    counter.dataset.counterId = `player${playerIndex + 1}-${counter.dataset.kind}-${counter.dataset.slot || "life"}`;
    counter.deltaState = { value: 0, timeout: null };
    bindPlusButton(counter);
    $(".minus", counter).addEventListener("click", () => changeCounter(counter, -1));
    if (counterIndex > 0) applyResourceColor(counter, COLORS[(playerIndex * 2 + counterIndex - 1) % COLORS.length]);
  });
  applyMacroLabels();
}

function bindPlusButton(counter) {
  const plus = $(".plus", counter);
  let settingsTimer = null;

  plus.addEventListener("click", () => {
    if (plus.dataset.suppressClick === "true") {
      delete plus.dataset.suppressClick;
      return;
    }
    changeCounter(counter, 1);
  });

  plus.addEventListener("pointerdown", event => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    plus.setPointerCapture?.(event.pointerId);
    plus.classList.add("holding");
    settingsTimer = setTimeout(() => {
      plus.dataset.suppressClick = "true";
      setTimeout(() => delete plus.dataset.suppressClick, 1000);
      plus.classList.remove("holding");
      navigator.vibrate?.(35);
      openCounterSettings(counter);
    }, 650);
  });

  const cancelSettingsHold = () => {
    clearTimeout(settingsTimer);
    plus.classList.remove("holding");
  };

  plus.addEventListener("pointerup", cancelSettingsHold);
  plus.addEventListener("pointercancel", cancelSettingsHold);
  plus.addEventListener("contextmenu", event => event.preventDefault());
}

function changeCounter(counter, delta) {
  const life = counter.dataset.kind === "life";
  const min = life ? -999 : 0;
  const max = life ? 999 : 20;
  const previous = Number(counter.dataset.value);
  const next = Math.max(min, Math.min(max, previous + delta));
  const appliedDelta = next - previous;
  if (appliedDelta === 0) return;
  counter.dataset.value = next;
  $(".value", counter).textContent = next;
  updateDelta(counter, appliedDelta);
}

function updateDelta(counter, change) {
  const delta = $(".delta", counter);
  const state = counter.deltaState;
  state.value += change;
  clearTimeout(state.timeout);
  delta.textContent = state.value > 0 ? `+${state.value}` : String(state.value);
  delta.className = `delta show ${state.value < 0 ? "negative" : "positive"}`;
  state.timeout = setTimeout(() => clearDelta(counter), 3000);
}

function clearDelta(counter) {
  if (!counter.deltaState) return;
  clearTimeout(counter.deltaState.timeout);
  counter.deltaState.value = 0;
  $(".delta", counter).textContent = "";
  $(".delta", counter).className = "delta";
}

function passTurn() {
  if (!players.length) return;
  if (!gameStarted) {
    startGame();
    return;
  }
  const order = getTurnOrder(config.count, config.direction);
  const position = order.indexOf(currentPlayer);
  currentPlayer = order[(position + 1) % order.length];
  refreshCurrentPlayer();
  grantTurnResources(currentPlayer);
  addTurnTime(currentPlayer);
  refreshTimers();
  startTimer();
}

function startGame() {
  if (!gameStarted) {
    grantTurnResources(currentPlayer);
    gameStarted = true;
  }
  startTimer();
}

function grantTurnResources(playerIndex) {
  $$(".resource.counter", players[playerIndex].element).forEach(counter => {
    changeCounter(counter, 2);
  });
}

function addTurnTime(playerIndex) {
  if (!config.timerEnabled || config.turnTimeBonusSeconds <= 0) return;
  if (config.timerMode === "total") {
    totalTime = Math.min(MAX_TIME_SECONDS, totalTime + config.turnTimeBonusSeconds);
  } else {
    players[playerIndex].remaining = Math.min(
      MAX_TIME_SECONDS,
      players[playerIndex].remaining + config.turnTimeBonusSeconds
    );
  }
}

function getTurnOrder(count, direction) {
  const clockwise = {
    2: [0, 1],
    3: [0, 1, 2],
    4: [0, 1, 3, 2],
    5: [0, 1, 3, 4, 2],
    6: [0, 1, 3, 5, 4, 2]
  }[count];
  if (direction === "clockwise") return clockwise;
  return [clockwise[0], ...clockwise.slice(1).reverse()];
}

function refreshCurrentPlayer() {
  players.forEach((player, index) => player.element.classList.toggle("current", index === currentPlayer));
}

turnButton.addEventListener("pointerdown", event => {
  event.preventDefault();
  longPressTriggered = false;
  turnButton.setPointerCapture?.(event.pointerId);
  holdTimer = setTimeout(() => {
    longPressTriggered = true;
    turnButton.classList.add("holding");
    navigator.vibrate?.(35);
    openModal(optionsModal);
  }, 650);
});
turnButton.addEventListener("pointerup", () => {
  clearTimeout(holdTimer);
  turnButton.classList.remove("holding");
  if (!longPressTriggered) passTurn();
});
turnButton.addEventListener("pointercancel", cancelHold);
turnButton.addEventListener("contextmenu", event => event.preventDefault());
turnButton.addEventListener("keydown", event => {
  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); passTurn(); }
});

function cancelHold() {
  clearTimeout(holdTimer);
  turnButton.classList.remove("holding");
}

function openModal(modal) {
  modalWasRunning = gameStarted;
  stopTimer();
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
}

function closeModal(modal, resume = true) {
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  if (resume && modalWasRunning) startTimer();
  modalWasRunning = false;
  currentCounter = null;
}

$$('[data-close-modal]').forEach(button => button.addEventListener("click", () => closeModal(button.closest(".modal"))));

$("#start-game").addEventListener("click", () => {
  startGame();
  closeModal(optionsModal, false);
});

$("#restart-game").addEventListener("click", () => {
  restartGame();
  closeModal(optionsModal, false);
});

$("#back-to-settings").addEventListener("click", () => {
  stopTimer();
  gameStarted = false;
  closeModal(optionsModal, false);
  gameScreen.hidden = true;
  setupScreen.hidden = false;
});

function restartGame() {
  stopTimer();
  gameStarted = false;
  currentPlayer = 0;
  totalTime = config.initialSeconds;
  players.forEach(player => {
    player.remaining = config.initialSeconds;
    $$(".counter", player.element).forEach(counter => {
      const value = counter.dataset.kind === "life" ? 7 : 0;
      counter.dataset.value = value;
      $(".value", counter).textContent = value;
      clearDelta(counter);
    });
  });
  refreshCurrentPlayer();
  refreshTimers();
}

function startTimer() {
  if (!gameStarted || !config?.timerEnabled || timerInterval) return;
  lastTick = performance.now();
  timerInterval = setInterval(tickTimer, 250);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function tickTimer() {
  const now = performance.now();
  const elapsed = Math.floor((now - lastTick) / 1000);
  if (elapsed < 1) return;
  lastTick += elapsed * 1000;
  if (config.timerMode === "total") {
    totalTime = Math.max(0, totalTime - elapsed);
    if (totalTime === 0) stopTimer();
  } else {
    players[currentPlayer].remaining = Math.max(0, players[currentPlayer].remaining - elapsed);
    if (players[currentPlayer].remaining === 0) stopTimer();
  }
  refreshTimers();
}

function refreshTimers() {
  players.forEach(player => {
    const remaining = config.timerMode === "total" ? totalTime : player.remaining;
    $(".player-timer strong", player.element).textContent = formatTime(remaining);
    player.element.classList.toggle("time-low", remaining > 0 && remaining <= 60);
  });
}

function formatTime(totalSeconds) {
  if (totalSeconds > 99 * 60 + 59) {
    return `99:${String(totalSeconds - 99 * 60).padStart(2, "0")}`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function renderColorOptions() {
  const root = $("#color-options");
  COLORS.forEach(colorData => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "color-option";
    button.textContent = colorData.name;
    button.dataset.colorName = colorData.name;
    button.style.background = colorData.color;
    button.style.color = colorData.text || "white";
    button.addEventListener("click", () => {
      if (!currentCounter || currentCounter.dataset.kind === "life") return;
      applyResourceColor(currentCounter, colorData);
      updateSelectedColor();
    });
    root.appendChild(button);
  });
}

function applyResourceColor(counter, colorData) {
  counter.dataset.selectedColor = colorData.name;
  counter.style.background = colorData.color;
  counter.style.color = colorData.text || "white";
  $(".counter-label", counter).textContent = colorData.name;
}

function openCounterSettings(counter) {
  currentCounter = counter;
  const isLife = counter.dataset.kind === "life";
  $("#counter-title").textContent = isLife ? "Configurar cordas" : "Configurar recurso";
  $("#color-options").hidden = isLife;
  updateSelectedColor();
  updateMacroFields();
  openModal(counterModal);
}

function updateSelectedColor() {
  $$(".color-option").forEach(button => button.classList.toggle("selected", button.dataset.colorName === currentCounter?.dataset.selectedColor));
}

function updateMacroFields() {
  const macros = savedMacros[currentCounter?.dataset.counterId] || {};
  $("#macro-plus").textContent = `Atalho para aumentar: ${macros.plus?.label || "não definido"}`;
  $("#macro-minus").textContent = `Atalho para diminuir: ${macros.minus?.label || "não definido"}`;
}

$("#macro-plus").addEventListener("click", () => beginMacroCapture("plus"));
$("#macro-minus").addEventListener("click", () => beginMacroCapture("minus"));
$("#show-macro-labels").addEventListener("change", event => {
  localStorage.setItem(SHOW_MACROS_KEY, String(event.target.checked));
  applyMacroVisibility(event.target.checked);
});

function beginMacroCapture(action) {
  if (isTabletop || !currentCounter) return;
  captureAction = action;
  captureOverlay.hidden = false;
}

document.addEventListener("keydown", event => {
  if (captureAction) {
    event.preventDefault();
    if (event.key === "Escape") { captureAction = null; captureOverlay.hidden = true; return; }
    if (["Control", "Shift", "Alt", "Meta"].includes(event.key) || event.repeat) return;
    const id = currentCounter.dataset.counterId;
    savedMacros[id] ||= {};
    savedMacros[id][captureAction] = createMacro(event);
    localStorage.setItem(MACROS_KEY, JSON.stringify(savedMacros));
    captureAction = null;
    captureOverlay.hidden = true;
    updateMacroFields();
    applyMacroLabels();
    return;
  }
  if (isTabletop || $$(".modal.open").length || event.repeat || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  $$(".counter").forEach(counter => {
    const macros = savedMacros[counter.dataset.counterId] || {};
    if (macroMatches(macros.plus, event)) $(".plus", counter).click();
    if (macroMatches(macros.minus, event)) $(".minus", counter).click();
  });
});

function createMacro(event) {
  const label = [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Meta", readableKey(event.key)].filter(Boolean).join(" + ");
  return { code: event.code, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey, label };
}

function macroMatches(macro, event) {
  return macro && macro.code === event.code && !!macro.ctrl === event.ctrlKey && !!macro.alt === event.altKey && !!macro.shift === event.shiftKey && !!macro.meta === event.metaKey;
}

function readableKey(key) {
  return ({ " ": "Espaço", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" })[key] || (key.length === 1 ? key.toUpperCase() : key);
}

function applyMacroLabels() {
  $$(".counter").forEach(counter => {
    const macros = savedMacros[counter.dataset.counterId] || {};
    $(".plus", counter).dataset.macro = macros.plus?.label || "";
    $(".minus", counter).dataset.macro = macros.minus?.label || "";
  });
}

function applyMacroVisibility(show) {
  document.body.classList.toggle("show-macro-labels", show);
  $("#show-macro-labels").checked = show;
}

$("#fullscreen-toggle").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      const exit = document.exitFullscreen?.bind(document) || document.webkitExitFullscreen?.bind(document);
      if (!exit) throw new Error("Fullscreen indisponível");
      await exit();
    } else {
      const enter = document.documentElement.requestFullscreen?.bind(document.documentElement) || document.documentElement.webkitRequestFullscreen?.bind(document.documentElement);
      if (!enter) throw new Error("Fullscreen indisponível");
      await enter({ navigationUI: "hide" });
    }
  } catch (error) {
    alert("Este navegador não permitiu ativar a tela cheia.");
  }
  updateFullscreenButton();
});
document.addEventListener("fullscreenchange", updateFullscreenButton);
document.addEventListener("webkitfullscreenchange", updateFullscreenButton);

function updateFullscreenButton() {
  const active = !!(document.fullscreenElement || document.webkitFullscreenElement);
  $("#fullscreen-toggle").textContent = active ? "Sair da tela cheia" : "Entrar em tela cheia";
}

function getOrientation(count, index) {
  if (!isTabletop) return "front";
  const orientations = {
    2: ["left", "right"],
    3: ["right", "left", "front"],
    4: ["right", "left", "right", "left"],
    5: ["right", "left", "right", "left", "front"],
    6: ["right", "left", "right", "left", "right", "left"]
  };
  return orientations[count][index];
}

function setOrientation(player, orientation) { player.dataset.orientation = orientation; }

function fitRotatedFaces() {
  players.forEach(({ element }) => {
    const face = $(".player-face", element);
    const orientation = element.dataset.orientation;
    if (!isTabletop || orientation === "front") {
      Object.assign(face.style, { width: "100%", height: "100%", left: "0", top: "0", transform: "none" });
    } else if (orientation === "opposite") {
      Object.assign(face.style, { width: "100%", height: "100%", left: "0", top: "0", transform: "rotate(180deg)" });
    } else {
      const angle = orientation === "left" ? -90 : 90;
      Object.assign(face.style, { width: `${element.clientHeight}px`, height: `${element.clientWidth}px`, left: "50%", top: "50%", transform: `translate(-50%, -50%) rotate(${angle}deg)` });
    }
  });
}
window.addEventListener("resize", () => requestAnimationFrame(fitRotatedFaces));

function detectTabletopDevice() {
  const ua = navigator.userAgent;
  return /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function restorePreferences() {
  const saved = loadJson(PREFS_KEY, null);
  if (!saved) return;
  $("#player-count").value = saved.count || 2;
  const direction = $(`input[name='direction'][value='${saved.direction}']`);
  if (direction) direction.checked = true;
  timerEnabled.checked = !!saved.timerEnabled;
  timerSettings.hidden = !timerEnabled.checked;
  const mode = $(`input[name='timer-mode'][value='${saved.timerMode}']`);
  if (mode) mode.checked = true;
  $("#minutes").value = saved.minutes ?? 50;
  $("#seconds").value = saved.seconds ?? 0;
  const previousBonus = saved.turnTimeBonus ?? saved.turnTimeBonusSeconds ?? 0;
  $("#turn-bonus-minutes").value = saved.turnBonusMinutes ?? Math.floor(previousBonus / 60);
  $("#turn-bonus-seconds").value = saved.turnBonusSeconds ?? previousBonus % 60;
}

function clampNumber(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }
function loadJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }

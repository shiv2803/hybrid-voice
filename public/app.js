// Hybrid Voice — push-to-talk assistant that answers on-device first and falls
// back to Gemini in the cloud through Firebase AI Logic.
//
// Pipeline: mic -> Web Speech API (STT) -> routing -> Firebase AI Logic
// (Gemini Nano / Gemini in the cloud) -> speechSynthesis (TTS).

import { initializeApp } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-ai.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider, getToken as getAppCheckToken } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-app-check.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js";
import { getFirestore, collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js";
import { getRemoteConfig, fetchAndActivate, getValue } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-remote-config.js";

import { decideRoute, DEFAULT_POLICY } from "./routing.js";

const firebaseConfig = {
  apiKey: "AIzaSyA-RdIwbxVwgtmp1expmsbw16c7VVg8a9Q",
  authDomain: "hybrid-voice.firebaseapp.com",
  projectId: "hybrid-voice",
  storageBucket: "hybrid-voice.firebasestorage.app",
  messagingSenderId: "444047759229",
  appId: "1:444047759229:web:4fb3a89f8294e9dc395e14",
  measurementId: "G-3HHZT5Z9LL",
};

const RECAPTCHA_SITE_KEY = "6LcGeCIuAAAAAJ-l5Om6w1Y3DkAwLDu1EvpVuW3T";

const SYSTEM_PROMPT =
  "You are Hybrid Voice, a hands-free voice assistant. Answer in at most three short spoken sentences. " +
  "Be direct and conversational. No markdown, no bullet lists, no code blocks unless the user asks for code.";

const state = {
  online: navigator.onLine,
  busy: false,
  muted: localStorage.getItem("hv:muted") === "1",
  listening: false,
  deviceAvailability: "unknown", // available | downloadable | downloading | unavailable | unknown
  deviceInitStarted: false,
  downloadProgress: null,
  policy: { ...DEFAULT_POLICY },
  cloudModel: DEFAULT_POLICY.cloudModel,
  uid: null,
  authStatus: "starting",
  appCheckStatus: "starting",
  configStatus: "starting",
  firestoreStatus: "starting",
  history: [], // [{ q, a }] last exchanges, for follow-up questions
  sttSupported: Boolean(self.SpeechRecognition || self.webkitSpeechRecognition),
};

const models = { hybrid: null, cloud: null };
let db = null;
let configPromise = Promise.resolve();

// ---------------------------------------------------------------- DOM -------

const $ = (id) => document.getElementById(id);
const el = {
  talk: $("talk"),
  hint: $("hint"),
  typed: $("typed"),
  input: $("text"),
  send: $("send"),
  log: $("log"),
  chipDevice: $("chipDevice"),
  chipNet: $("chipNet"),
  mute: $("mute"),
  clear: $("clear"),
  diagList: $("diagList"),
  sttNote: $("sttNote"),
};

// ------------------------------------------------------------- helpers -----

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function setHint(text, tone) {
  el.hint.textContent = text;
  if (tone) el.hint.dataset.tone = tone;
  else delete el.hint.dataset.tone;
}

function setChip(node, text, tone) {
  node.textContent = text;
  if (tone) node.dataset.tone = tone;
  else delete node.dataset.tone;
}

function deviceLabel() {
  switch (state.deviceAvailability) {
    case "available":
      return "On-device: ready";
    case "downloadable":
      return "On-device: needs download";
    case "downloading":
      return `On-device: downloading${state.downloadProgress != null ? ` ${Math.round(state.downloadProgress * 100)}%` : "…"}`;
    case "unavailable":
      return "On-device: unavailable";
    default:
      return "On-device: checking…";
  }
}

function renderChips() {
  const tone =
    state.deviceAvailability === "available"
      ? "good"
      : state.deviceAvailability === "unavailable"
        ? "bad"
        : undefined;
  setChip(el.chipDevice, deviceLabel(), tone);
  setChip(
    el.chipNet,
    state.online ? "Online" : "Offline",
    state.online ? "cloud" : "bad",
  );
}

function renderDiag() {
  const rows = [
    ["On-device model", `${state.deviceAvailability}${state.downloadProgress != null ? ` (${Math.round(state.downloadProgress * 100)}% downloaded)` : ""}`],
    ["Cloud model", state.cloudModel],
    ["Routing limits", `${state.policy.maxOnDeviceChars} chars / ${state.policy.maxOnDeviceWords} words`],
    ["Network", state.online ? "online" : "offline"],
    ["App Check", state.appCheckStatus],
    ["Auth", state.authStatus + (state.uid ? ` (${state.uid.slice(0, 8)}…)` : "")],
    ["Remote Config", state.configStatus],
    ["Firestore", state.firestoreStatus],
    ["Speech-to-text", state.sttSupported ? "Web Speech API" : "not supported in this browser"],
  ];
  el.diagList.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      return [dt, dd];
    }),
  );
}

// --------------------------------------------------------------- log ------

function renderTurn(role, text) {
  const article = document.createElement("article");
  article.className = `turn ${role}`;
  const body = document.createElement("div");
  body.className = "turn-body";
  body.textContent = text;
  article.append(body);
  el.log.append(article);
  article.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return article;
}

function renderPending(route) {
  const article = document.createElement("article");
  article.className = "turn assistant";
  const head = document.createElement("div");
  head.className = "turn-head";
  const name = document.createElement("span");
  name.textContent = route.target === "cloud" ? "Asking the cloud model" : "Thinking on this device";
  const dots = document.createElement("span");
  dots.className = "dots";
  dots.innerHTML = "<span></span><span></span><span></span>";
  head.append(name, dots);
  const body = document.createElement("div");
  body.className = "turn-body";
  body.textContent = "…";
  article.append(head, body);
  el.log.append(article);
  article.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return article;
}

function sourceFromResponse(response, route) {
  const raw = response?.inferenceSource;
  if (raw === "ON_DEVICE") return { kind: "on-device", estimated: false };
  if (raw === "IN_CLOUD") return { kind: "cloud", estimated: false };
  // Older SDKs / unusual paths don't report it. Fall back to what we asked for.
  if (route.mode === "only_in_cloud") return { kind: "cloud", estimated: true };
  if (!state.deviceAvailability || state.deviceAvailability !== "available") {
    return { kind: "cloud", estimated: true };
  }
  return { kind: "on-device", estimated: true };
}

function renderAnswer(article, { answer, source, route, ms }) {
  article.replaceChildren();
  const head = document.createElement("div");
  head.className = "turn-head";

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.dataset.kind = source.kind;
  badge.textContent = source.kind === "on-device" ? "On-device" : "Cloud";
  if (source.estimated) {
    badge.title = "The SDK didn't report the inference source, so this reflects the route we requested.";
  }

  const model = document.createElement("span");
  model.textContent = source.kind === "on-device" ? "Gemini Nano" : state.cloudModel;

  const time = document.createElement("span");
  time.textContent = `${(ms / 1000).toFixed(2)}s`;

  head.append(badge, model, time);

  const body = document.createElement("div");
  body.className = "turn-body";
  body.textContent = answer;

  const note = document.createElement("div");
  note.className = "turn-note";
  note.textContent = route.reason;

  article.append(head, body, note);
  article.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function renderError(message, detail) {
  const article = renderTurn("error", message);
  if (detail) {
    const note = document.createElement("div");
    note.className = "turn-note";
    note.textContent = detail;
    article.append(note);
  }
  return article;
}

function explainError(err) {
  const raw = String(err?.message || err || "Unknown error");
  const code = String(err?.code || "");
  if (/App Check token|appCheck|401/i.test(raw + code)) {
    return {
      message: "App Check rejected this request.",
      detail:
        "The reCAPTCHA Enterprise site key isn't registered for this web app yet. Register it in Firebase Console → App Check → Apps → the web app → reCAPTCHA Enterprise, then reload.",
    };
  }
  if (/unavailable|not enabled|CONSUMER|permission|403|failed-precondition/i.test(raw + code)) {
    return {
      message: "The cloud model didn't answer.",
      detail: "Check that AI Logic is enabled for the project and App Check allows this domain. " + raw.slice(0, 220),
    };
  }
  if (/quota|429|resource-exhausted/i.test(raw + code)) {
    return { message: "Rate limited by the Gemini API.", detail: "Wait a moment and try again." };
  }
  if (/network|offline|Failed to fetch/i.test(raw)) {
    return {
      message: "No connection to the cloud model.",
      detail:
        state.deviceAvailability === "available"
          ? "The on-device model can still answer — try a short question."
          : "The on-device model isn't ready on this device yet.",
    };
  }
  return { message: "That request failed.", detail: raw.slice(0, 300) };
}

// ------------------------------------------------------------ prompting ----

const REFERENTIAL = /\b(it|its|that|this|those|these|them|they|there|more|again|why|how about|what about|explain)\b/i;

function buildPrompt(question) {
  const parts = [SYSTEM_PROMPT];
  const last = state.history.at(-1);
  if (last && question.length < 80 && REFERENTIAL.test(question)) {
    parts.push(`Earlier turn:\nUser: ${last.q}\nAssistant: ${last.a}`);
  }
  parts.push(`User: ${question}\nAssistant:`);
  return parts.join("\n\n");
}

function historyChars(question) {
  const last = state.history.at(-1);
  if (!last || question.length >= 80 || !REFERENTIAL.test(question)) return 0;
  return Math.min(420, last.q.length + last.a.length);
}

// --------------------------------------------------------------- speech ----

let voice = null;

function pickVoice() {
  if (!("speechSynthesis" in self)) return;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;
  const score = (v) =>
    (/en-GB|en-US|en-AU|en-IN/i.test(v.lang) ? 2 : 0) +
    (/Google|Natural|Premium|Enhanced/i.test(v.name) ? 1 : 0);
  voice = voices.slice().sort((a, b) => score(b) - score(a))[0] || null;
}

function speak(text) {
  if (state.muted || !("speechSynthesis" in self)) return;
  speechSynthesis.cancel();
  const clean = text
    .replace(/```[\s\S]*?```/g, " (code omitted) ")
    .replace(/[*_#`>]/g, "")
    .replace(/https?:\/\/\S+/g, " link ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return;
  const utterance = new SpeechSynthesisUtterance(clean.slice(0, 600));
  if (voice) utterance.voice = voice;
  utterance.rate = 1.03;
  utterance.pitch = 1;
  speechSynthesis.speak(utterance);
}

function stopSpeaking() {
  if ("speechSynthesis" in self) speechSynthesis.cancel();
}

// ------------------------------------------------------------- requests ----

async function ask(question) {
  const text = String(question || "").trim();
  if (!text) return;
  if (state.busy) {
    setHint("One question at a time — waiting for the current answer.", "bad");
    return;
  }

  const route = decideRoute(text, {
    online: state.online,
    deviceReady: state.deviceAvailability === "available",
    historyChars: historyChars(text),
    policy: state.policy,
  });

  if (route.target === "none") {
    renderError(route.reason);
    setHint(route.reason, "bad");
    return;
  }

  stopSpeaking();
  state.busy = true;
  el.talk.disabled = true;
  el.send.disabled = true;
  setHint(route.target === "cloud" ? "Asking Gemini in the cloud…" : "Asking Gemini Nano on this device…");

  renderTurn("user", text);
  const article = renderPending(route);
  const started = performance.now();

  try {
    if (!models.hybrid || !models.cloud) {
      throw new Error("The AI service is still starting — try again in a second.");
    }
    const model = route.mode === "only_in_cloud" ? models.cloud : models.hybrid;
    const result = await model.generateContent(buildPrompt(text));
    const ms = Math.max(1, Math.round(performance.now() - started));
    const answer = (result.response.text() || "").trim() || "(empty response)";
    const source = sourceFromResponse(result.response, route);

    renderAnswer(article, { answer, source, route, ms });
    state.history.push({ q: text, a: answer });
    if (state.history.length > 4) state.history.shift();
    speak(answer);
    setHint(
      source.kind === "on-device"
        ? "Answered on this device."
        : "Answered in the cloud.",
    );
    saveTurn({ question: text, answer, source: source.kind, ms, route: route.reason });
  } catch (err) {
    console.error(err);
    const { message, detail } = explainError(err);
    article.remove();
    renderError(message, detail);
    setHint(message, "bad");
  } finally {
    state.busy = false;
    el.talk.disabled = false;
    el.send.disabled = false;
  }
}

async function saveTurn(payload) {
  if (!db || !state.uid) {
    state.firestoreStatus = "not saved (no auth)";
    renderDiag();
    return;
  }
  try {
    await addDoc(collection(db, "users", state.uid, "turns"), {
      ...payload,
      createdAt: serverTimestamp(),
    });
    state.firestoreStatus = "saving turns";
  } catch (err) {
    state.firestoreStatus = "write blocked: " + String(err?.code || err?.message || err).slice(0, 60);
  }
  renderDiag();
}

// ------------------------------------------------------------------ mic ----

const SpeechRecognitionCtor = self.SpeechRecognition || self.webkitSpeechRecognition;

function startListening() {
  if (!SpeechRecognitionCtor) {
    setHint("This browser has no speech recognition — type instead.", "bad");
    el.input.focus();
    return;
  }
  if (state.busy || state.listening) return;

  startDeviceModelInit();

  const rec = new SpeechRecognitionCtor();
  rec.lang = navigator.language || "en-US";
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  let finalText = "";
  let interim = "";

  rec.onstart = () => {
    state.listening = true;
    el.talk.setAttribute("aria-pressed", "true");
    setHint("Listening… release to send.");
  };

  rec.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) finalText += result[0].transcript + " ";
      else interim += result[0].transcript;
    }
    const live = (finalText + interim).trim();
    if (live) setHint(`“${live}”`);
  };

  rec.onerror = (event) => {
    const map = {
      "not-allowed": "Microphone permission was blocked.",
      "service-not-allowed": "Speech recognition was blocked by the browser.",
      "audio-capture": "No microphone was found.",
      "no-speech": "I didn't hear anything.",
      network: "Speech recognition needs a connection.",
      aborted: "Stopped.",
    };
    const message = map[event.error] || `Speech recognition error: ${event.error}`;
    if (event.error !== "aborted") setHint(message, "bad");
    state.listening = false;
    el.talk.setAttribute("aria-pressed", "false");
  };

  rec.onend = () => {
    state.listening = false;
    el.talk.setAttribute("aria-pressed", "false");
    const said = (finalText + interim).trim();
    if (said) {
      ask(said);
    } else if (!el.hint.dataset.tone) {
      setHint("Hold the mic (or hold Space) and speak.");
    }
  };

  state.rec = rec;
  try {
    rec.start();
  } catch {
    setHint("Couldn't start the microphone — try again.", "bad");
  }
}

function stopListening() {
  if (!state.rec) return;
  try {
    state.rec.stop();
  } catch {
    /* already stopped */
  }
}

// ------------------------------------------------------------- Firebase ----

async function probeDevice() {
  const api = self.LanguageModel || self.ai?.languageModel;
  if (!api?.availability) {
    state.deviceAvailability = "unavailable";
    renderChips();
    renderDiag();
    return;
  }
  try {
    state.deviceAvailability = await api.availability();
  } catch {
    state.deviceAvailability = "unknown";
  }
  renderChips();
  renderDiag();
}

function startDeviceModelInit() {
  if (state.deviceInitStarted || !models.hybrid?.initializeDeviceModel) return;
  state.deviceInitStarted = true;
  try {
    const pending = models.hybrid.initializeDeviceModel((progress) => {
      state.downloadProgress = progress;
      state.deviceAvailability = progress >= 1 ? "available" : "downloading";
      renderChips();
      renderDiag();
    });
    Promise.resolve(pending).then(
      () => {
        state.deviceAvailability = "available";
        renderChips();
        renderDiag();
      },
      (err) => {
        console.warn("on-device model init failed", err);
        state.deviceAvailability = "unavailable";
        renderChips();
        renderDiag();
      },
    );
  } catch (err) {
    console.warn("initializeDeviceModel threw", err);
  }
}

function buildModels(ai) {
  const cloudName = state.cloudModel;
  const inCloudParams = {
    model: cloudName,
    generationConfig: { maxOutputTokens: 512, temperature: 0.4 },
  };
  try {
    models.hybrid = getGenerativeModel(ai, {
      mode: InferenceMode.PREFER_ON_DEVICE,
      inCloudParams,
      onDeviceParams: {
        createOptions: {
          expectedInputs: [{ type: "text", languages: ["en"] }],
          expectedOutputs: [{ type: "text", languages: ["en"] }],
          initialPrompts: [
            { role: "system", content: [{ type: "text", value: SYSTEM_PROMPT }] },
          ],
        },
      },
    });
  } catch (err) {
    console.warn("hybrid model options rejected, using defaults", err);
    models.hybrid = getGenerativeModel(ai, {
      mode: InferenceMode.PREFER_ON_DEVICE,
      inCloudParams,
    });
  }
  models.cloud = getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams,
  });
}

async function initFirebase() {
  const app = initializeApp(firebaseConfig);

  // App Check: reCAPTCHA Enterprise in production. A debug token is only used
  // when explicitly asked for with ?appcheckDebug=1.
  try {
    if (new URLSearchParams(location.search).get("appcheckDebug") === "1") {
      self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    }
    const appCheck = initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
    state.appCheckStatus = "reCAPTCHA Enterprise";
    // Probe immediately so the status panel tells the truth about attestation.
    getAppCheckToken(appCheck, false).then(
      () => {
        state.appCheckStatus = "reCAPTCHA Enterprise (token ok)";
        renderDiag();
      },
      (err) => {
        state.appCheckStatus =
          "token rejected: " + String(err?.code || err?.message || err).slice(0, 44);
        renderDiag();
      },
    );
  } catch (err) {
    state.appCheckStatus = "failed: " + String(err?.message || err).slice(0, 60);
  }

  const ai = getAI(app, { backend: new GoogleAIBackend() });
  buildModels(ai);

  // Auth (anonymous) — optional: the app still answers without it.
  try {
    const auth = getAuth(app);
    let tried = false;
    onAuthStateChanged(auth, (user) => {
      if (user) {
        state.uid = user.uid;
        state.authStatus = user.isAnonymous ? "anonymous" : "signed in";
        renderDiag();
      } else if (!tried) {
        tried = true;
        signInAnonymously(auth).catch((err) => {
          state.authStatus = "off: " + String(err?.code || err?.message || err).slice(0, 40);
          renderDiag();
        });
      }
    });
  } catch (err) {
    state.authStatus = "off: " + String(err?.message || err).slice(0, 40);
  }

  // Firestore — conversation history per user.
  try {
    db = getFirestore(app);
    state.firestoreStatus = "connected";
  } catch (err) {
    state.firestoreStatus = "off: " + String(err?.message || err).slice(0, 40);
  }

  // Remote Config — routing limits and the cloud model, tunable without a deploy.
  configPromise = withTimeout(
    (async () => {
      const rc = getRemoteConfig(app);
      rc.settings = { minimumFetchIntervalMillis: 60_000 };
      const activated = await fetchAndActivate(rc);
      const readString = (key) => getValue(rc, key).asString();
      const readNumber = (key, fallback) => {
        const n = Number(readString(key));
        return Number.isFinite(n) && n > 0 ? n : fallback;
      };
      state.policy.maxOnDeviceChars = readNumber("maxOnDeviceChars", state.policy.maxOnDeviceChars);
      state.policy.maxOnDeviceWords = readNumber("maxOnDeviceWords", state.policy.maxOnDeviceWords);
      const remoteModel = readString("cloudModel").trim();
      const changed = Boolean(remoteModel) && remoteModel !== state.cloudModel;
      if (remoteModel) state.cloudModel = remoteModel;
      state.configStatus = activated ? "fetched" : "using defaults";
      if (changed) buildModels(ai);
      renderDiag();
    })(),
    4000,
    () => {
      state.configStatus = "unreachable — defaults";
      renderDiag();
    },
  );

  await probeDevice();
  renderChips();
  renderDiag();
}

// ----------------------------------------------------------------- UI ------

function wireUi() {
  // Push-to-talk: pointer (mouse, pen, touch) and keyboard.
  el.talk.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    el.talk.setPointerCapture?.(event.pointerId);
    startListening();
  });
  const release = () => {
    if (state.listening) stopListening();
  };
  el.talk.addEventListener("pointerup", release);
  el.talk.addEventListener("pointercancel", release);
  el.talk.addEventListener("pointerleave", release);

  el.talk.addEventListener("keydown", (event) => {
    if ((event.key === " " || event.key === "Enter") && !event.repeat) {
      event.preventDefault();
      startListening();
    }
  });
  el.talk.addEventListener("keyup", (event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      release();
    }
  });

  // Hold Space anywhere on the page (except while typing).
  document.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement === el.talk) return;
    event.preventDefault();
    startListening();
  });
  document.addEventListener("keyup", (event) => {
    if (event.code !== "Space") return;
    if (document.activeElement === el.talk) return;
    release();
  });

  el.typed.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = el.input.value.trim();
    if (!text) return;
    el.input.value = "";
    ask(text);
  });

  el.mute.addEventListener("click", () => {
    state.muted = !state.muted;
    localStorage.setItem("hv:muted", state.muted ? "1" : "0");
    el.mute.setAttribute("aria-pressed", String(state.muted));
    el.mute.textContent = `Sound: ${state.muted ? "off" : "on"}`;
    if (state.muted) stopSpeaking();
  });
  el.mute.setAttribute("aria-pressed", String(state.muted));
  el.mute.textContent = `Sound: ${state.muted ? "off" : "on"}`;

  el.clear.addEventListener("click", () => {
    el.log.replaceChildren();
    state.history = [];
    setHint("Cleared.");
  });

  const netUpdate = () => {
    state.online = navigator.onLine;
    renderChips();
    renderDiag();
  };
  addEventListener("online", netUpdate);
  addEventListener("offline", netUpdate);

  if (!state.sttSupported) {
    el.sttNote.textContent =
      "This browser doesn't support the Web Speech API — type your question instead.";
  }
}

// ---------------------------------------------------------------- boot -----

wireUi();
renderChips();
renderDiag();

if ("speechSynthesis" in self) {
  pickVoice();
  speechSynthesis.addEventListener?.("voiceschanged", pickVoice);
}

initFirebase().catch((err) => {
  console.error(err);
  state.configStatus = "init failed";
  renderDiag();
  renderError("Firebase didn't initialize.", String(err?.message || err).slice(0, 240));
});

// Handy for the reviewer and for manual testing from the console.
self.hybridVoice = {
  ask,
  state,
  models,
  decideRoute,
};

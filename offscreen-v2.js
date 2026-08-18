// DubWave v2 realtime offscreen engine.
// Streaming capture -> Gemini Live -> adaptive PCM buffering.

const WS_BASE = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=";
const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;
const DEFAULT_MODEL = "gemini-3.5-live-translate-preview";
const DEFAULT_VOICE = "Gacrux";
const MIN_AUDIO_BYTES = 320;
const INPUT_PEAK_LIMIT = 260;
const OUTPUT_PEAK_LIMIT = 160;
const MAX_RECONNECTS = 5;
const TARGET_BUFFER_MS = 140;
const MAX_BUFFER_MS = 3000;

let ctx = null, ws = null, workletNode = null, playerNode = null;
let mediaStream = null, sourceNode = null;
let stopped = false, setupDone = false, everConnected = false;
let mode = "gemini", model = DEFAULT_MODEL, apiKey = "", targetLang = "fa", voice = DEFAULT_VOICE;
let startedAt = 0, lagSent = false, turnText = "", reconnectAttempts = 0;
let ducked = false, hideTimer = null;
let outputBufferedBytes = 0;
let lastAudioAt = 0;
let subtitleBuffer = "";
let metricsTimer = null;

const report = (msg) => chrome.runtime.sendMessage({ type: "engine_status", ...msg }).catch(() => {});
const sendToTab = (type, payload = {}) => chrome.runtime.sendMessage({ type: "OFFSCREEN_TO_TAB", payload: { type, ...payload } }).catch(() => {});

function isSilentInt16(pcm, limit) {
  if (!pcm || !pcm.length) return true;
  let peak = 0;
  const step = Math.max(1, Math.floor(pcm.length / 256));
  for (let i = 0; i < pcm.length; i += step) peak = Math.max(peak, Math.abs(pcm[i]));
  return peak < limit;
}

function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data.slice(0);
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return null;
}

function arrayBufferToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function base64ToArrayBuffer(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function main(init) {
  apiKey = ((init?.apiKey) || "").trim();
  if (!apiKey) return fail("No Gemini API key. Open DubWave settings and add one.");
  if (!init?.streamId) return fail("No capture stream id received. Restart DubWave.");

  mode = init.voiceMode === "chrome" ? "chrome" : "gemini";
  model = (init.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  targetLang = (init.targetLang || "fa").trim() || "fa";
  voice = (init.voice || DEFAULT_VOICE).trim() || DEFAULT_VOICE;

  try {
    ctx = new AudioContext({ latencyHint: "interactive" });
    await ctx.audioWorklet.addModule("processor.js");
    await ctx.audioWorklet.addModule("audio-player.js");
    await ctx.resume();
    playerNode = new AudioWorkletNode(ctx, "realtime-pcm-player", { outputChannelCount: [1] });
    playerNode.connect(ctx.destination);
    await startCapture(init.streamId);
    startMetrics();
    openSocket();
  } catch (error) {
    fail("Setup error: " + error.message);
  }
}

async function startCapture(streamId) {
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } } });
  sourceNode = ctx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(ctx, "pcm-capture");
  const mute = ctx.createGain();
  mute.gain.value = 0;
  sourceNode.connect(workletNode);
  workletNode.connect(mute);
  mute.connect(ctx.destination);

  workletNode.port.onmessage = (event) => {
    if (stopped || !ws || ws.readyState !== WebSocket.OPEN) return;
    const arrayBuffer = toArrayBuffer(event.data);
    if (!arrayBuffer || arrayBuffer.byteLength < MIN_AUDIO_BYTES || arrayBuffer.byteLength % 2) return;
    const pcm = new Int16Array(arrayBuffer);
    if (isSilentInt16(pcm, INPUT_PEAK_LIMIT)) return;
    if (!startedAt) startedAt = Date.now();
    ws.send(JSON.stringify({ realtimeInput: { audio: { data: arrayBufferToBase64(new Uint8Array(arrayBuffer)), mimeType: "audio/pcm;rate=16000" } } }));
  };
}

function setupMessage() {
  const setup = {
    setup: {
      model: model.includes("/") ? model : "models/" + model,
      generationConfig: {
        responseModalities: ["AUDIO"],
        translationConfig: { targetLanguageCode: targetLang, echoTargetLanguage: true }
      }
    }
  };

  if (mode === "gemini") {
    setup.setup.generationConfig.speechConfig = {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } }
    };
  }

  return setup;
}

function openSocket() {
  ws = new WebSocket(WS_BASE + encodeURIComponent(apiKey));
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    everConnected = true;
    reconnectAttempts = 0;
    setupDone = false;
    ws.send(JSON.stringify(setupMessage()));
    report({ text: "Connected. Translating..." });
  };
  ws.onmessage = (event) => {
    if (typeof event.data === "string") return handleServerContent(event.data);
    if (!event.data?.byteLength) return;
    const bytes = new Uint8Array(event.data);
    if (bytes[0] === 123 || bytes[0] === 91) {
      try { return handleServerContent(new TextDecoder("utf-8", { fatal: true }).decode(event.data)); } catch (_) {}
    }
    playPCM16(event.data);
  };
  ws.onerror = () => { if (!everConnected) fail("Connection failed. Check your network/proxy and Gemini API key."); };
  ws.onclose = () => {
    if (stopped || !everConnected) return;
    if (!setupDone) return fail("Server closed the connection before session start. Check model name and API key.");
    if (reconnectAttempts < MAX_RECONNECTS) {
      reconnectAttempts++;
      setTimeout(openSocket, Math.min(1000 * reconnectAttempts, 5000));
    } else fail("Connection lost after retries. Stop, then start DubWave again.");
  };
}

function handleServerContent(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }
  if (msg.error) return fail("API error: " + (msg.error.message || JSON.stringify(msg.error)));
  if (msg.setupComplete) {
    if (msg.setupComplete.error) return fail("Setup rejected: " + (msg.setupComplete.error.message || JSON.stringify(msg.setupComplete.error)));
    setupDone = true;
    report({ text: "Connected. Translating..." });
    return;
  }

  const content = msg.serverContent;
  if (!content) return;
  if (content.interrupted) {
    playerNode?.port.postMessage({ type: "reset" });
    outputBufferedBytes = 0;
    turnText = "";
    subtitleBuffer = "";
    sendToTab("HIDE_SUBTITLE");
    duckOff();
  }

  for (const part of content.modelTurn?.parts || []) {
    if (part.text) {
      turnText += part.text;
      subtitleBuffer += part.text;
      emitSubtitle(false);
    }
    if (part.inlineData?.data) playPCM16(base64ToArrayBuffer(part.inlineData.data));
  }

  if (!lagSent && startedAt && content.modelTurn) {
    lagSent = true;
    report({ text: "Playing translated audio...", lag: ((Date.now() - startedAt) / 1000).toFixed(2) });
  }

  if (content.turnComplete) {
    emitSubtitle(true);
    if (mode === "chrome" && turnText.trim()) speak(turnText.trim());
    scheduleHide();
    turnText = "";
    subtitleBuffer = "";
    lagSent = false;
    startedAt = 0;
  }
}

function emitSubtitle(final) {
  let text = subtitleBuffer.replace(/\s+/g, " ").trim();
  if (!text) return;

  if (!final && text.length > 180) {
    const boundary = Math.max(text.lastIndexOf(". "), text.lastIndexOf("! "), text.lastIndexOf("? "), text.lastIndexOf("، "), text.lastIndexOf(".\n"));
    if (boundary > 40) text = text.slice(boundary + 1).trim();
    else text = text.slice(-180).trim();
  }
  sendToTab("SHOW_SUBTITLE", { text: formatSubtitle(text) });
}

function formatSubtitle(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function playPCM16(arrayBuffer) {
  if (!playerNode || !arrayBuffer || arrayBuffer.byteLength < MIN_AUDIO_BYTES || arrayBuffer.byteLength % 2) return;
  const pcm = new Int16Array(arrayBuffer);
  if (isSilentInt16(pcm, OUTPUT_PEAK_LIMIT)) return;
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
  duckOn();
  const copy = new Int16Array(pcm.length);
  copy.set(pcm);
  outputBufferedBytes = Math.min(outputBufferedBytes + copy.byteLength, OUTPUT_RATE * 2 * MAX_BUFFER_MS / 1000);
  lastAudioAt = performance.now();
  playerNode.port.postMessage({ type: "pcm", buffer: copy.buffer }, [copy.buffer]);
}

function duckOn() { if (!ducked) { ducked = true; sendToTab("DUCK_AUDIO"); } }
function duckOff() { if (ducked) { ducked = false; sendToTab("UNDUCK_AUDIO"); } }
function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { sendToTab("HIDE_SUBTITLE"); duckOff(); hideTimer = null; }, 800);
}
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = targetLang;
  const voice = speechSynthesis.getVoices().find(v => v.lang.toLowerCase().startsWith(targetLang.toLowerCase()));
  if (voice) utterance.voice = voice;
  speechSynthesis.speak(utterance);
}
function startMetrics() {
  if (metricsTimer) clearInterval(metricsTimer);
  metricsTimer = setInterval(() => {
    if (stopped) return;
    const bufferedMs = outputBufferedBytes / (OUTPUT_RATE * 2) * 1000;
    report({ metrics: { bufferedMs: Number(bufferedMs.toFixed(1)), targetBufferMs: TARGET_BUFFER_MS, reconnects: reconnectAttempts, audioAgeMs: lastAudioAt ? Math.max(0, performance.now() - lastAudioAt) : null } });
  }, 1000);
}
function fail(message) { report({ error: message }); cleanup(); }
function cleanup() {
  stopped = true;
  if (metricsTimer) clearInterval(metricsTimer);
  if (hideTimer) clearTimeout(hideTimer);
  try { playerNode?.port.postMessage({ type: "reset" }); } catch (_) {}
  try { duckOff(); sendToTab("HIDE_SUBTITLE"); } catch (_) {}
  try { ws?.close(); } catch (_) {}
  try { workletNode?.disconnect(); sourceNode?.disconnect(); playerNode?.disconnect(); } catch (_) {}
  try { mediaStream?.getTracks().forEach(track => track.stop()); } catch (_) {}
  try { ctx?.close(); } catch (_) {}
  outputBufferedBytes = 0;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "offscreen_stop") cleanup();
  if (msg?.type === "offscreen_start") {
    stopped = false;
    main(msg);
  }
});
chrome.runtime.sendMessage({ type: "offscreen_ready" }).catch(() => {});

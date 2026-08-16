
// DubWave offscreen audio engine.
// Captures tab audio, sends it to Gemini Live, receives translated speech,
// plays it back, and sends subtitle/ducking events to the page.

const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=";

const OUTPUT_RATE = 24000;
const MIN_AUDIO_BYTES = 320;
const DEFAULT_MODEL = "gemini-3.5-live-translate-preview";
const VOICE = "Kore";
const MAX_RECONNECTS = 5;

// Noise gates. Adjust if too aggressive or too weak.
const INPUT_PEAK_LIMIT = 260;
const OUTPUT_PEAK_LIMIT = 160;

let ctx = null;
let ws = null;
let workletNode = null;
let mediaStream = null;
let sourceNode = null;

let stopped = false;
let setupDone = false;
let everConnected = false;

let mode = "gemini";
let model = DEFAULT_MODEL;
let apiKey = "";
let targetLang = "fa";

let startedAt = 0;
let lagSent = false;

let nextPlayTime = 0;
let turnText = "";
let reconnectAttempts = 0;

let ducked = false;
let hideTimer = null;

const report = (msg) =>
  chrome.runtime.sendMessage(Object.assign({ type: "engine_status" }, msg)).catch(() => {});

function sendToTab(type, payload) {
  chrome.runtime.sendMessage({
    type: "OFFSCREEN_TO_TAB",
    payload: Object.assign({ type: type }, payload || {}),
  }).catch(() => {});
}

function duckOn() {
  if (!ducked) {
    ducked = true;
    sendToTab("DUCK_AUDIO");
  }
}

function duckOff() {
  if (ducked) {
    ducked = false;
    sendToTab("UNDUCK_AUDIO");
  }
}

function showSubtitle(text) {
  if (text) {
    sendToTab("SHOW_SUBTITLE", { text: text });
  }
}

function hideSubtitleSoon() {
  if (hideTimer) clearTimeout(hideTimer);

  hideTimer = setTimeout(() => {
    sendToTab("HIDE_SUBTITLE");
    duckOff();
    hideTimer = null;
  }, 800);
}

function isSilentInt16(int16, peakLimit) {
  if (!int16 || !int16.length) return true;

  let peak = 0;
  const step = Math.max(1, Math.floor(int16.length / 256));

  for (let i = 0; i < int16.length; i += step) {
    const value = int16[i] < 0 ? -int16[i] : int16[i];
    if (value > peak) peak = value;
  }

  return peak < peakLimit;
}

function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) {
    return data.slice(0);
  }

  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }

  return data;
}

async function main(init) {
  const streamId = init && init.streamId;

  apiKey = ((init && init.apiKey) || "").trim();
  if (!apiKey) {
    fail("No Gemini API key. Open DubWave settings and add one.");
    return;
  }

  if (!streamId) {
    fail("No capture stream id received. Restart DubWave.");
    return;
  }

  mode = init && init.voiceMode === "chrome" ? "chrome" : "gemini";
  model = (((init && init.model) || DEFAULT_MODEL).trim() || DEFAULT_MODEL);
  targetLang = (((init && init.targetLang) || "fa").trim() || "fa");

  try {
    ctx = new AudioContext();
    await ctx.audioWorklet.addModule("processor.js");
    await ctx.resume();

    await startCapture(streamId);
    openSocket();
  } catch (e) {
    fail("Setup error: " + e.message);
  }
}

async function startCapture(streamId) {
  if (!streamId) {
    throw new Error("No capture stream id passed to offscreen engine.");
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
  });

  sourceNode = ctx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(ctx, "pcm-capture");

  const mute = ctx.createGain();
  mute.gain.value = 0;

  sourceNode.connect(workletNode);
  workletNode.connect(mute);
  mute.connect(ctx.destination);

  workletNode.port.onmessage = (e) => {
    if (stopped) return;

    if (e.data && e.data.type === "stats") return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    let payload = e.data;

    if (
      payload &&
      typeof payload === "object" &&
      !(payload instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(payload)
    ) {
      payload = payload.audio || payload.buffer || payload.pcm || payload;
    }

    const arrayBuffer = toArrayBuffer(payload);

    if (
      !arrayBuffer ||
      typeof arrayBuffer.byteLength !== "number" ||
      arrayBuffer.byteLength < MIN_AUDIO_BYTES ||
      arrayBuffer.byteLength % 2 !== 0
    ) {
      return;
    }

    const pcm = new Int16Array(arrayBuffer);

    // Do not send silence/noise floor to Gemini.
    if (isSilentInt16(pcm, INPUT_PEAK_LIMIT)) return;

    if (!startedAt) startedAt = Date.now();

    const b64 = arrayBufferToBase64(new Uint8Array(arrayBuffer));

    ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            data: b64,
            mimeType: "audio/pcm;rate=16000",
          },
        },
      })
    );
  };
}

function setupMessage() {
  const modelName = model.includes("/") ? model : "models/" + model;

  const msg = {
    setup: {
      model: modelName,
      generationConfig: {
        responseModalities: ["AUDIO"],
        translationConfig: {
          targetLanguageCode: targetLang,
          echoTargetLanguage: true,
        },
      },
    },
  };

  if (mode === "gemini") {
    msg.setup.generationConfig.speechConfig = {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: VOICE,
        },
      },
    };
  }

  return msg;
}

function openSocket() {
  const url = WS_BASE + encodeURIComponent(apiKey);

  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    everConnected = true;
    reconnectAttempts = 0;

    ws.send(JSON.stringify(setupMessage()));
    report({ text: "Connected. Translating..." });
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      handleServerContent(ev.data);
      return;
    }

    if (!ev.data || ev.data.byteLength === 0) return;

    const firstByte = new Uint8Array(ev.data, 0, 1)[0];

    // Some server messages can arrive as binary JSON.
    if (firstByte === 123 || firstByte === 91) {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(ev.data);
        handleServerContent(text);
        return;
      } catch (e) {}
    }

    if (!setupDone) {
      setupDone = true;
    }

    playPCM16(ev.data);
  };

  ws.onerror = () => {
    if (!everConnected) {
      fail(
        "Connection failed. Check your VPN/proxy, internet connection, and Gemini API key."
      );
    }
  };

  ws.onclose = () => {
    if (stopped) return;

    if (!everConnected) return;

    if (!setupDone) {
      fail(
        "Server closed the connection before session start. Check model name and API key."
      );
      return;
    }

    if (reconnectAttempts < MAX_RECONNECTS) {
      reconnectAttempts++;
      setTimeout(openSocket, Math.min(1000 * reconnectAttempts, 5000));
    } else {
      fail("Connection lost after retries. Stop, then start DubWave again.");
    }
  };
}

function handleServerContent(raw) {
  let msg;

  try {
    msg = JSON.parse(raw);
  } catch (e) {
    return;
  }

  if (msg.error) {
    fail("API error: " + (msg.error.message || JSON.stringify(msg.error)));
    return;
  }

  const ack = msg.setupComplete;

  if (ack) {
    if (ack.error) {
      fail("Setup rejected: " + (ack.error.message || JSON.stringify(ack.error)));
    } else {
      setupDone = true;
      report({ text: "Connected. Translating..." });
    }

    return;
  }

  const sc = msg.serverContent;
  if (!sc) return;

  if (sc.interrupted) {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;

    nextPlayTime = ctx.currentTime;
    turnText = "";

    duckOff();
    sendToTab("HIDE_SUBTITLE");
  }

  if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
    for (const part of sc.modelTurn.parts) {
      if (part.text) {
        turnText += part.text;
        showSubtitle(turnText.trim());
      }

      if (part.inlineData && part.inlineData.data) {
        playPCM16(base64ToArrayBuffer(part.inlineData.data));
      }
    }

    if (!lagSent && startedAt) {
      lagSent = true;
      report({
        text: "Playing translated audio...",
        lag: ((Date.now() - startedAt) / 1000).toFixed(1),
      });
    }
  }

  if (sc.turnComplete) {
    const finalText = turnText.trim();

    if (mode === "chrome" && finalText) {
      speak(finalText);
    }

    hideSubtitleSoon();
    turnText = "";
  }
}

function playPCM16(arrayBuffer) {
  if (!ctx || stopped) return;

  if (
    !arrayBuffer ||
    arrayBuffer.byteLength < MIN_AUDIO_BYTES ||
    arrayBuffer.byteLength % 2 !== 0
  ) {
    return;
  }

  const int16 = new Int16Array(arrayBuffer);
  if (!int16.length) return;

  // Suppress silent/hissy output frames.
  if (isSilentInt16(int16, OUTPUT_PEAK_LIMIT)) return;

  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  duckOn();

  const float = new Float32Array(int16.length);

  for (let i = 0; i < int16.length; i++) {
    float[i] = int16[i] / 32768;
  }

  const audioBuffer = ctx.createBuffer(1, float.length, OUTPUT_RATE);
  audioBuffer.copyToChannel(float, 0);

  const src = ctx.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(ctx.destination);

  const now = ctx.currentTime;

  // Low-latency playback buffer.
  if (nextPlayTime < now + 0.02) {
    nextPlayTime = now + 0.02;
  }

  src.start(nextPlayTime);
  nextPlayTime += audioBuffer.duration;
}

function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

function arrayBufferToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;

  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = targetLang;

  const voices = speechSynthesis.getVoices();
  const match = voices.find((v) =>
    v.lang.toLowerCase().startsWith(targetLang.toLowerCase())
  );

  if (match) utterance.voice = match;

  speechSynthesis.speak(utterance);
}

function fail(message) {
  report({ error: message });
  cleanup();
}

function cleanup() {
  stopped = true;

  if (hideTimer) clearTimeout(hideTimer);

  try {
    duckOff();
    sendToTab("HIDE_SUBTITLE");
  } catch (e) {}

  try {
    if (ws) ws.close();
  } catch (e) {}

  try {
    if (workletNode) workletNode.disconnect();
  } catch (e) {}

  try {
    if (sourceNode) sourceNode.disconnect();
  } catch (e) {}

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
  }

  try {
    if (ctx) ctx.close();
  } catch (e) {}
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "offscreen_stop") {
    stopped = true;
    cleanup();
  }
});

chrome.runtime.onMessage.addListener(function bootListener(msg) {
  if (msg && msg.type === "offscreen_start") {
    chrome.runtime.onMessage.removeListener(bootListener);
    main(msg);
  }
});

chrome.runtime.sendMessage({ type: "offscreen_ready" }).catch(() => {});

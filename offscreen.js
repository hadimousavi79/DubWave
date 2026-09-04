
// DubWave offscreen audio engine.
// Captures tab audio, sends it to the selected realtime LLM provider,
// receives translated speech, plays it back, and sends subtitle/ducking events to the page.

let CTX = null;
let WS = null;
let WORKLET_NODE = null;
let PLAYER_NODE = null;
let MEDIA_STREAM = null;
let SOURCE_NODE = null;

let STOPPED = false;
let SETUP_DONE = false;
let EVER_CONNECTED = false;

let PROVIDER = "gemini";
let BASE_URL = "";
let API_KEY = "";
let MODEL = "";
let TARGET_LANG = "fa";
let VOICE = "";

let STARTED_AT = 0;
let LAG_SENT = false;

let NEXT_PLAY_TIME = 0;
let TURN_TEXT = "";
let RECONNECT_ATTEMPTS = 0;

let DUCKED = false;
let HIDE_TIMER = null;

const OUTPUT_RATE = 24000;
const MIN_AUDIO_BYTES = 320;
const DEFAULT_GEMINI_MODEL = "gemini-3.5-live-translate-preview";
const DEFAULT_OPENAI_MODEL = "gpt-4o-realtime-preview";
const GEMINI_VOICE = "Kore";
const OPENAI_VOICE = "alloy";
const MAX_RECONNECTS = 5;

// Noise gates. Adjust if too aggressive or too weak.
const INPUT_PEAK_LIMIT = 260;
const OUTPUT_PEAK_LIMIT = 160;

const report = (msg) =>
  chrome.runtime.sendMessage(Object.assign({ type: "engine_status" }, msg)).catch(() => {});

function sendToTab(type, payload) {
  chrome.runtime.sendMessage({
    type: "OFFSCREEN_TO_TAB",
    payload: Object.assign({ type: type }, payload || {}),
  }).catch(() => {});
}

function duckOn() {
  if (!DUCKED) {
    DUCKED = true;
    sendToTab("DUCK_AUDIO");
  }
}

function duckOff() {
  if (DUCKED) {
    DUCKED = false;
    sendToTab("UNDUCK_AUDIO");
  }
}

function showSubtitle(text) {
  if (text) {
    sendToTab("SHOW_SUBTITLE", { text: text });
  }
}

function hideSubtitleSoon() {
  if (HIDE_TIMER) clearTimeout(HIDE_TIMER);

  HIDE_TIMER = setTimeout(() => {
    sendToTab("HIDE_SUBTITLE");
    duckOff();
    HIDE_TIMER = null;
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

  PROVIDER = (init && init.provider) || "gemini";
  BASE_URL = ((init && init.baseUrl) || "").trim();
  API_KEY = ((init && init.apiKey) || "").trim();
  MODEL = ((init && init.model) || "").trim();
  TARGET_LANG = ((init && init.targetLang) || "fa").trim();
  VOICE = ((init && init.voice) || "").trim();

  // Set defaults based on provider
  if (!MODEL) {
    if (PROVIDER === "gemini") MODEL = DEFAULT_GEMINI_MODEL;
    else if (PROVIDER === "openai") MODEL = DEFAULT_OPENAI_MODEL;
  }

  if (!VOICE) {
    if (PROVIDER === "gemini") VOICE = GEMINI_VOICE;
    else if (PROVIDER === "openai") VOICE = OPENAI_VOICE;
  }

  if (!API_KEY) {
    fail("No API key. Open DubWave settings and add one.");
    return;
  }

  if (!streamId) {
    fail("No capture stream id received. Restart DubWave.");
    return;
  }

  try {
    CTX = new AudioContext({ latencyHint: "interactive" });
    await CTX.audioWorklet.addModule("processor.js");
    await CTX.audioWorklet.addModule("audio-player.js");
    await CTX.resume();

    // Create output player node for resampled playback
    PLAYER_NODE = new AudioWorkletNode(CTX, "realtime-pcm-player", { outputChannelCount: [1] });
    PLAYER_NODE.connect(CTX.destination);

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

  MEDIA_STREAM = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
  });

  SOURCE_NODE = CTX.createMediaStreamSource(MEDIA_STREAM);
  WORKLET_NODE = new AudioWorkletNode(CTX, "pcm-capture");

  const mute = CTX.createGain();
  mute.gain.value = 0;

  SOURCE_NODE.connect(WORKLET_NODE);
  WORKLET_NODE.connect(mute);
  mute.connect(CTX.destination);

  WORKLET_NODE.port.onmessage = (e) => {
    if (STOPPED) return;

    if (e.data && e.data.type === "stats") return;
    if (!WS || WS.readyState !== WebSocket.OPEN) return;

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

    // Do not send silence/noise floor to the AI provider.
    if (isSilentInt16(pcm, INPUT_PEAK_LIMIT)) return;

    if (!STARTED_AT) STARTED_AT = Date.now();

    const b64 = arrayBufferToBase64(new Uint8Array(arrayBuffer));

    // Send audio based on provider protocol
    if (PROVIDER === "gemini") {
      WS.send(
        JSON.stringify({
          realtimeInput: {
            audio: {
              data: b64,
              mimeType: "audio/pcm;rate=16000",
            },
          },
        })
      );
    } else if (PROVIDER === "openai" || PROVIDER === "custom") {
      // OpenAI Realtime API format (and compatible providers like Ollama, 9router, Omniroute)
      WS.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: b64,
        })
      );
    }
  };
}

function setupMessage() {
  let msg = {};

  if (PROVIDER === "gemini") {
    const modelName = MODEL.includes("/") ? MODEL : "models/" + MODEL;
    msg = {
      setup: {
        model: modelName,
        generationConfig: {
          responseModalities: ["AUDIO"],
          translationConfig: {
            targetLanguageCode: TARGET_LANG,
            echoTargetLanguage: true,
          },
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: VOICE,
              },
            },
          },
        },
      },
    };
  } else if (PROVIDER === "openai" || PROVIDER === "custom") {
    // OpenAI Realtime API session configuration (for Ollama, 9router, Omniroute, etc.)
    msg = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `You are a real-time translator. Translate all audio to ${TARGET_LANG}.`,
        voice: VOICE || OPENAI_VOICE,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { type: "server_vad" },
      },
    };
  }

  return msg;
}

function normalizeWsUrl(url, fallback) {
  if (!url) return fallback;
  if (url.startsWith("https://")) return "wss://" + url.slice(8);
  if (url.startsWith("http://")) return "ws://" + url.slice(7);
  return url;
}

function openSocket() {
  let url = normalizeWsUrl(BASE_URL, "");

  if (PROVIDER === "gemini") {
    if (!url) {
      url = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=";
    }
    if (!url.includes("key=")) {
      url = url + (url.includes("?") ? "&" : "?") + "key=" + API_KEY;
    }
  } else if (PROVIDER === "openai" || PROVIDER === "custom") {
    if (!url) {
      url = "wss://api.openai.com/v1/realtime";
    }
    // Add model and api_key for OpenAI-compatible endpoints
    if (!/[?&]model=/.test(url) && MODEL) {
      url += (url.includes("?") ? "&" : "?") + "model=" + encodeURIComponent(MODEL);
    }
    if (!/[?&]api_key=/.test(url)) {
      url += (url.includes("?") ? "&" : "?") + "api_key=" + encodeURIComponent(API_KEY);
    }
  }

  WS = new WebSocket(url);
  WS.binaryType = "arraybuffer";

  WS.onopen = () => {
    EVER_CONNECTED = true;
    RECONNECT_ATTEMPTS = 0;

    WS.send(JSON.stringify(setupMessage()));
    report({ text: `Connected to ${PROVIDER}. Translating...` });
  };

  WS.onmessage = (ev) => {
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

    if (!SETUP_DONE) {
      SETUP_DONE = true;
    }

    playPCM16(ev.data);
  };

  WS.onerror = () => {
    if (!EVER_CONNECTED) {
      fail(
        `Connection failed. Check your VPN/proxy, internet connection, and ${PROVIDER} API key.`
      );
    }
  };

  WS.onclose = () => {
    if (STOPPED) return;

    if (!EVER_CONNECTED) return;

    if (!SETUP_DONE) {
      fail(
        `Server closed the connection before session start. Check model name and API key for ${PROVIDER}.`
      );
      return;
    }

    if (RECONNECT_ATTEMPTS < MAX_RECONNECTS) {
      RECONNECT_ATTEMPTS++;
      setTimeout(openSocket, Math.min(1000 * RECONNECT_ATTEMPTS, 5000));
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

  // Handle OpenAI Realtime API responses (and compatible providers)
  if (PROVIDER === "openai" || PROVIDER === "custom") {
    handleOpenAIResponse(msg);
    return;
  }

  // Handle Gemini API responses
  if (msg.error) {
    fail("API error: " + (msg.error.message || JSON.stringify(msg.error)));
    return;
  }

  const ack = msg.setupComplete;

  if (ack) {
    if (ack.error) {
      fail("Setup rejected: " + (ack.error.message || JSON.stringify(ack.error)));
    } else {
      SETUP_DONE = true;
      report({ text: "Connected. Translating..." });
    }

    return;
  }

  const sc = msg.serverContent;
  if (!sc) return;

  if (sc.interrupted) {
    if (HIDE_TIMER) clearTimeout(HIDE_TIMER);
    HIDE_TIMER = null;

    if (PLAYER_NODE) {
      PLAYER_NODE.port.postMessage({ type: "reset" });
    }
    TURN_TEXT = "";

    duckOff();
    sendToTab("HIDE_SUBTITLE");
  }

  if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
    for (const part of sc.modelTurn.parts) {
      if (part.text) {
        TURN_TEXT += part.text;
        showSubtitle(TURN_TEXT.trim());
      }

      if (part.inlineData && part.inlineData.data) {
        playPCM16(base64ToArrayBuffer(part.inlineData.data));
      }
    }

    if (!LAG_SENT && STARTED_AT) {
      LAG_SENT = true;
      report({
        text: "Playing translated audio...",
        lag: ((Date.now() - STARTED_AT) / 1000).toFixed(1),
      });
    }
  }

  if (sc.turnComplete) {
    const finalText = TURN_TEXT.trim();

    if (finalText) {
      speak(finalText);
    }

    hideSubtitleSoon();
    TURN_TEXT = "";
  }
}

function handleOpenAIResponse(msg) {
  const type = msg.type;

  if (type === "error") {
    fail("API error: " + (msg.error?.message || JSON.stringify(msg.error)));
    return;
  }

  if (type === "session.created" || type === "session.updated") {
    SETUP_DONE = true;
    report({ text: `Connected to ${PROVIDER}. Translating...` });
    return;
  }

  if (type === "response.audio.delta" && msg.delta) {
    const audioData = msg.delta;
    if (audioData) {
      playPCM16(base64ToArrayBuffer(audioData));
    }
    return;
  }

  if (type === "response.audio_transcript.delta" && msg.delta) {
    TURN_TEXT += msg.delta;
    showSubtitle(TURN_TEXT.trim());

    if (!LAG_SENT && STARTED_AT) {
      LAG_SENT = true;
      report({
        text: "Playing translated audio...",
        lag: ((Date.now() - STARTED_AT) / 1000).toFixed(1),
      });
    }
    return;
  }

  if (type === "response.done") {
    const finalText = TURN_TEXT.trim();
    if (finalText) {
      speak(finalText);
    }
    hideSubtitleSoon();
    TURN_TEXT = "";
    return;
  }
}

function playPCM16(arrayBuffer) {
  if (!PLAYER_NODE || STOPPED) return;

  if (
    !arrayBuffer ||
    arrayBuffer.byteLength < MIN_AUDIO_BYTES ||
    arrayBuffer.byteLength % 2 !== 0
  ) {
    return;
  }

  const pcm = new Int16Array(arrayBuffer);
  if (!pcm.length) return;

  // Suppress silent/hissy output frames.
  if (isSilentInt16(pcm, OUTPUT_PEAK_LIMIT)) return;

  if (HIDE_TIMER) {
    clearTimeout(HIDE_TIMER);
    HIDE_TIMER = null;
  }

  duckOn();

  // Send PCM to the player worklet for proper resampling
  PLAYER_NODE.port.postMessage({ type: "pcm", buffer: pcm.buffer }, [pcm.buffer]);
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
  utterance.lang = TARGET_LANG;

  const voices = speechSynthesis.getVoices();
  const match = voices.find((v) =>
    v.lang.toLowerCase().startsWith(TARGET_LANG.toLowerCase())
  );

  if (match) utterance.voice = match;

  speechSynthesis.speak(utterance);
}

function fail(message) {
  report({ error: message });
  cleanup();
}

function cleanup() {
  STOPPED = true;

  if (HIDE_TIMER) clearTimeout(HIDE_TIMER);

  try {
    if (PLAYER_NODE) {
      PLAYER_NODE.port.postMessage({ type: "reset" });
    }
    duckOff();
    sendToTab("HIDE_SUBTITLE");
  } catch (e) {}

  try {
    if (WS) WS.close();
  } catch (e) {}

  try {
    if (WORKLET_NODE) WORKLET_NODE.disconnect();
    if (PLAYER_NODE) PLAYER_NODE.disconnect();
    if (SOURCE_NODE) SOURCE_NODE.disconnect();
  } catch (e) {}

  if (MEDIA_STREAM) {
    MEDIA_STREAM.getTracks().forEach((track) => track.stop());
  }

  try {
    if (CTX) CTX.close();
  } catch (e) {}
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "offscreen_stop") {
    STOPPED = true;
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

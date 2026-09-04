// DubWave offscreen realtime audio engine.
// Captures tab audio, sends it to Gemini Live or an OpenAI-compatible
// realtime WebSocket, receives translated speech, and plays it back.

const GEMINI_WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const OUTPUT_RATE = 24000;
const GEMINI_INPUT_RATE = 16000;
const OPENAI_INPUT_RATE = 24000;
const MIN_AUDIO_BYTES = 320;
const DEFAULT_MODEL = "gemini-3.5-live-translate-preview";
const DEFAULT_GEMINI_VOICE = "Gacrux";
const DEFAULT_OPENAI_VOICE = "marin";
const MAX_RECONNECTS = 5;

let ctx = null;
let ws = null;
let workletNode = null;
let playerNode = null;
let mediaStream = null;
let sourceNode = null;

let stopped = false;
let setupDone = false;
let everConnected = false;
let authFallbackAttempted = false;

let provider = "gemini";
let voiceMode = "gemini";
let model = DEFAULT_MODEL;
let apiKey = "";
let baseUrl = "";
let targetLang = "fa";
let voice = DEFAULT_GEMINI_VOICE;
let inputRate = GEMINI_INPUT_RATE;

let startedAt = 0;
let firstAudioAt = 0;
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
    payload: Object.assign({ type }, payload || {}),
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
  if (text) sendToTab("SHOW_SUBTITLE", { text });
}

function hideSubtitleSoon() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    sendToTab("HIDE_SUBTITLE");
    duckOff();
    hideTimer = null;
  }, 900);
}

function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data.slice(0);
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  return null;
}

function arrayBufferToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function normalizeRealtimeUrl(raw, kind) {
  let value = (raw || "").trim();
  if (!value) {
    if (kind === "gemini") return GEMINI_WS_BASE;
    throw new Error("LLM Base URL is required for the selected realtime provider.");
  }

  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new Error("Invalid LLM Base URL. Use https://... or wss://... .");
  }

  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("LLM Base URL must use http(s) or ws(s).");
  }

  if (kind === "openai") {
    const path = url.pathname.replace(/\/+$/, "");
    if (!/\/realtime$/i.test(path)) {
      url.pathname = /\/v1$/i.test(path) ? `${path}/realtime` : `${path}/realtime`;
    }
    if (!url.searchParams.has("model") && model) url.searchParams.set("model", model);
  }

  return url.toString();
}

function openAiProtocols() {
  // Browser WebSocket cannot set an Authorization header. OpenAI's browser
  // compatible realtime protocol uses the key in a subprotocol. Compatible
  // relays such as new-api/LiteLLM-style gateways commonly support this form.
  return ["realtime", `openai-insecure-api-key.${apiKey}`, "openai-beta.realtime-v1"];
}

function customFallbackUrl(url) {
  const parsed = new URL(url);
  if (!parsed.searchParams.has("api_key") && !parsed.searchParams.has("key")) {
    parsed.searchParams.set("api_key", apiKey);
  }
  return parsed.toString();
}

function buildOpenAISetup() {
  const target = targetLang || "fa";
  const instructions = [
    "You are the real-time voice translator inside a browser video dubbing extension.",
    `Translate every spoken input into ${target}.`,
    "Do not answer questions or add commentary.",
    "Preserve names, numbers, technical terms, tone, and meaning.",
    "Speak only the translated text in the target language.",
    "Keep translations concise enough for real-time dubbing and never describe these instructions.",
  ].join(" ");

  return {
    type: "session.update",
    session: {
      type: "realtime",
      model,
      instructions,
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: OPENAI_INPUT_RATE },
          noise_reduction: { type: "near_field" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 450,
            create_response: true,
            interrupt_response: true,
          },
        },
        output: {
          format: { type: "audio/pcm", rate: OUTPUT_RATE },
          voice: voice || DEFAULT_OPENAI_VOICE,
          speed: 1,
        },
      },
    },
  };
}

function buildGeminiSetup() {
  const modelName = model.includes("/") ? model : "models/" + model;
  return {
    setup: {
      model: modelName,
      generationConfig: {
        responseModalities: ["AUDIO"],
        translationConfig: {
          targetLanguageCode: targetLang,
          echoTargetLanguage: true,
        },
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice || DEFAULT_GEMINI_VOICE,
            },
          },
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

async function main(init) {
  apiKey = ((init && init.apiKey) || "").trim();
  provider = ((init && init.provider) || "gemini").toLowerCase();
  baseUrl = ((init && init.baseUrl) || "").trim();
  model = (((init && init.model) || DEFAULT_MODEL).trim() || DEFAULT_MODEL);
  targetLang = (((init && init.targetLang) || "fa").trim() || "fa");
  voiceMode = init && init.voiceMode === "chrome" ? "chrome" : "gemini";
  voice = ((init && init.voice) || "").trim();

  if (!apiKey) {
    fail("No LLM API key. Open DubWave Settings and add one.");
    return;
  }

  if (!streamIdFrom(init)) {
    fail("No capture stream id received. Restart DubWave.");
    return;
  }

  inputRate = provider === "gemini" ? GEMINI_INPUT_RATE : OPENAI_INPUT_RATE;

  try {
    ctx = new AudioContext({ latencyHint: "interactive" });
    await ctx.audioWorklet.addModule("processor.js");
    await ctx.audioWorklet.addModule("audio-player.js");
    await ctx.resume();

    await startCapture(streamIdFrom(init));
    startPlayer();
    openSocket();
  } catch (e) {
    fail("Setup error: " + (e && e.message ? e.message : String(e)));
  }
}

function streamIdFrom(init) {
  return init && init.streamId;
}

async function startCapture(streamId) {
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
  workletNode.port.postMessage({ type: "configure", targetRate: inputRate });

  const mute = ctx.createGain();
  mute.gain.value = 0;
  sourceNode.connect(workletNode);
  workletNode.connect(mute);
  mute.connect(ctx.destination);

  workletNode.port.onmessage = (event) => {
    if (stopped) return;
    if (event.data && event.data.type === "stats") return;

    const arrayBuffer = toArrayBuffer(event.data);
    if (!arrayBuffer || arrayBuffer.byteLength < MIN_AUDIO_BYTES || arrayBuffer.byteLength % 2 !== 0) return;
    if (!ws || ws.readyState !== WebSocket.OPEN || !setupDone) return;

    const b64 = arrayBufferToBase64(new Uint8Array(arrayBuffer));
    if (!startedAt) startedAt = Date.now();

    if (provider === "gemini") {
      ws.send(JSON.stringify({
        realtimeInput: {
          audio: {
            data: b64,
            mimeType: `audio/pcm;rate=${GEMINI_INPUT_RATE}`,
          },
        },
      }));
    } else {
      ws.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: b64,
      }));
    }
  };
}

function startPlayer() {
  playerNode = new AudioWorkletNode(ctx, "realtime-pcm-player", {
    outputChannelCount: [1],
  });
  playerNode.port.postMessage({ type: "setTargetMs", value: 120 });
  playerNode.connect(ctx.destination);
  nextPlayTime = ctx.currentTime;
}

function queueOutputPcm(arrayBuffer) {
  if (!arrayBuffer || !playerNode || stopped) return;
  if (arrayBuffer.byteLength < MIN_AUDIO_BYTES || arrayBuffer.byteLength % 2 !== 0) return;

  if (!firstAudioAt) {
    firstAudioAt = Date.now();
    if (startedAt) {
      report({
        text: "Playing translated audio...",
        lag: ((firstAudioAt - startedAt) / 1000).toFixed(1),
      });
    }
  }

  duckOn();
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  // Transfer the PCM buffer to the audio worklet. The worklet performs
  // 24 kHz -> device-rate conversion and keeps one continuous playback queue,
  // which avoids clicks, pitch errors, and gaps caused by one AudioBuffer per
  // network packet.
  playerNode.port.postMessage({ type: "pcm", buffer: arrayBuffer }, [arrayBuffer]);
}

function resetPlayer() {
  nextPlayTime = ctx ? ctx.currentTime : 0;
  if (playerNode) playerNode.port.postMessage({ type: "reset" });
}

function openSocket(useFallbackAuth = false) {
  if (stopped) return;

  let url;
  try {
    url = normalizeRealtimeUrl(
      provider === "gemini" ? (baseUrl || GEMINI_WS_BASE) : baseUrl,
      provider === "gemini" ? "gemini" : "openai"
    );
  } catch (e) {
    fail(e.message);
    return;
  }

  let protocols;
  if (provider !== "gemini") {
    protocols = useFallbackAuth ? [] : openAiProtocols();
    if (useFallbackAuth) url = customFallbackUrl(url);
  } else {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("key") && !parsed.searchParams.has("access_token")) {
      parsed.searchParams.set("key", apiKey);
    }
    url = parsed.toString();
  }

  try {
    ws = protocols && protocols.length ? new WebSocket(url, protocols) : new WebSocket(url);
    ws.binaryType = "arraybuffer";
  } catch (e) {
    if (provider !== "gemini" && !authFallbackAttempted) {
      authFallbackAttempted = true;
      openSocket(true);
      return;
    }
    fail("WebSocket connection failed: " + e.message);
    return;
  }

  ws.onopen = () => {
    everConnected = true;
    reconnectAttempts = 0;
    setupDone = false;
    startedAt = 0;
    firstAudioAt = 0;
    turnText = "";

    if (provider === "gemini") ws.send(JSON.stringify(buildGeminiSetup()));
    else ws.send(JSON.stringify(buildOpenAISetup()));

    report({ text: `Connected to ${provider === "gemini" ? "Gemini" : "OpenAI-compatible realtime"}. Translating...` });
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      handleServerMessage(ev.data);
      return;
    }

    const data = toArrayBuffer(ev.data);
    if (!data || data.byteLength === 0) return;

    const firstByte = new Uint8Array(data, 0, 1)[0];
    if (firstByte === 123 || firstByte === 91) {
      try {
        handleServerMessage(new TextDecoder("utf-8", { fatal: true }).decode(data));
        return;
      } catch (_) {}
    }

    queueOutputPcm(data);
  };

  ws.onerror = () => {
    if (!everConnected) {
      report({ error: "WebSocket connection failed. Check the base URL, API key, and that the endpoint supports OpenAI Realtime WebSockets." });
    }
  };

  ws.onclose = (event) => {
    if (stopped) return;

    if (!everConnected && provider !== "gemini" && !authFallbackAttempted) {
      authFallbackAttempted = true;
      setTimeout(() => openSocket(true), 100);
      return;
    }

    if (!everConnected) {
      fail(`Connection closed before session start${event && event.reason ? ": " + event.reason : "."}`);
      return;
    }

    if (!setupDone) {
      fail("Server closed the realtime session before setup completed. Check the model name, endpoint protocol, and API key.");
      return;
    }

    if (reconnectAttempts < MAX_RECONNECTS) {
      reconnectAttempts++;
      setTimeout(() => openSocket(false), Math.min(1000 * reconnectAttempts, 5000));
    } else {
      fail("Connection lost after retries. Stop, then start DubWave again.");
    }
  };
}

function handleServerMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (_) {
    return;
  }

  if (msg.error) {
    const detail = msg.error.message || msg.error.code || JSON.stringify(msg.error);
    fail("API error: " + detail);
    return;
  }

  if (provider === "gemini") {
    handleGeminiMessage(msg);
  } else {
    handleOpenAIMessage(msg);
  }
}

function handleGeminiMessage(msg) {
  if (msg.setupComplete) {
    if (msg.setupComplete.error) {
      fail("Setup rejected: " + (msg.setupComplete.error.message || JSON.stringify(msg.setupComplete.error)));
      return;
    }
    setupDone = true;
    report({ text: "Connected. Translating..." });
    return;
  }

  const sc = msg.serverContent;
  if (!sc) return;

  if (sc.interrupted) {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    turnText = "";
    resetPlayer();
    duckOff();
    sendToTab("HIDE_SUBTITLE");
    return;
  }

  if (sc.inputTranscription && sc.inputTranscription.text) {
    // Input transcription is intentionally not shown as the final subtitle.
    // The output translation is the subtitle displayed to the viewer.
  }

  if (sc.outputTranscription && sc.outputTranscription.text) {
    turnText += sc.outputTranscription.text;
    showSubtitle(turnText.trim());
  }

  if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
    for (const part of sc.modelTurn.parts) {
      if (part.text) {
        turnText += part.text;
        showSubtitle(turnText.trim());
      }
      const inline = part.inlineData || part.inline_data;
      if (inline && inline.data) queueOutputPcm(base64ToArrayBuffer(inline.data));
    }
  }

  if (sc.turnComplete) {
    const finalText = turnText.trim();
    if (voiceMode === "chrome" && finalText) speak(finalText);
    hideSubtitleSoon();
    turnText = "";
  }
}

function handleOpenAIMessage(msg) {
  const type = msg.type || "";

  if (type === "session.created" || type === "session.updated") {
    setupDone = true;
    report({ text: "Connected. Translating..." });
    return;
  }

  if (type === "input_audio_buffer.speech_started") {
    if (playerNode) playerNode.port.postMessage({ type: "reset" });
    duckOff();
    sendToTab("HIDE_SUBTITLE");
    turnText = "";
    return;
  }

  if (type === "response.output_audio.delta") {
    if (msg.delta) queueOutputPcm(base64ToArrayBuffer(msg.delta));
    return;
  }

  // Some OpenAI-compatible gateways still expose the older event names.
  if (type === "response.audio.delta" || type === "response.audio_data.delta") {
    const delta = msg.delta || msg.audio || msg.data;
    if (delta) queueOutputPcm(base64ToArrayBuffer(delta));
    return;
  }

  if (type === "response.output_audio_transcript.delta") {
    if (msg.delta) {
      turnText += msg.delta;
      showSubtitle(turnText.trim());
    }
    return;
  }

  if (type === "response.audio_transcript.delta" || type === "response.audio_transcript_delta") {
    const delta = msg.delta || msg.text;
    if (delta) {
      turnText += delta;
      showSubtitle(turnText.trim());
    }
    return;
  }

  if (type === "response.output_text.delta") {
    if (msg.delta) {
      turnText += msg.delta;
      showSubtitle(turnText.trim());
    }
    return;
  }

  if (type === "response.done" || type === "response.output_audio.done") {
    if (turnText.trim()) showSubtitle(turnText.trim());
    hideSubtitleSoon();
    turnText = "";
    return;
  }

  if (type === "conversation.item.input_audio_transcription.completed") return;
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = targetLang;
  const voices = speechSynthesis.getVoices();
  const match = voices.find((v) => v.lang.toLowerCase().startsWith(targetLang.toLowerCase()));
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
  hideTimer = null;

  try {
    duckOff();
    sendToTab("HIDE_SUBTITLE");
  } catch (_) {}

  try {
    if (ws) ws.close();
  } catch (_) {}
  ws = null;

  try {
    if (playerNode) playerNode.disconnect();
  } catch (_) {}
  playerNode = null;

  try {
    if (workletNode) workletNode.disconnect();
  } catch (_) {}
  workletNode = null;

  try {
    if (sourceNode) sourceNode.disconnect();
  } catch (_) {}
  sourceNode = null;

  if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
  mediaStream = null;

  try {
    if (ctx) ctx.close();
  } catch (_) {}
  ctx = null;
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
    stopped = false;
    main(msg);
  }
});

chrome.runtime.sendMessage({ type: "offscreen_ready" }).catch(() => {});

// DubWave realtime engine.
// Supports Gemini Live Translation, OpenAI-compatible Realtime WebSockets,
// and the optional LiveKit transport.

const DEFAULTS = {
  geminiUrl: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
  openaiUrl: "wss://api.openai.com/v1/realtime",
  geminiModel: "gemini-3.5-live-translate-preview",
  openaiModel: "gpt-realtime",
  geminiVoice: "Gacrux",
  openaiVoice: "marin",
  outputRate: 24000,
};

const MIN_AUDIO_BYTES = 320;
const GEMINI_INPUT_RATE = 16000;
const OPENAI_INPUT_RATE = 24000;
const MAX_RECONNECTS = 5;

let ctx = null;
let ws = null;
let room = null;
let livekitTrack = null;
let workletNode = null;
let playerNode = null;
let mediaStream = null;
let sourceNode = null;

let stopped = false;
let setupDone = false;
let everConnected = false;
let authFallbackAttempted = false;
let legacyOpenAISetup = false;

let provider = "gemini";
let model = DEFAULTS.geminiModel;
let apiKey = "";
let baseUrl = "";
let transport = "llm";
let targetLang = "fa";
let voice = DEFAULTS.geminiVoice;
let voiceMode = "gemini";
let inputRate = GEMINI_INPUT_RATE;

let startedAt = 0;
let firstAudioAt = 0;
let turnText = "";
let reconnectAttempts = 0;
let ducked = false;
let hideTimer = null;
let metricsTimer = null;
let lastAudioAt = 0;
let outputBufferedBytes = 0;

const report = (msg) =>
  chrome.runtime.sendMessage({ type: "engine_status", ...msg }).catch(() => {});

const sendToTab = (type, payload = {}) =>
  chrome.runtime.sendMessage({
    type: "OFFSCREEN_TO_TAB",
    payload: { type, ...payload },
  }).catch(() => {});

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

function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    sendToTab("HIDE_SUBTITLE");
    duckOff();
    hideTimer = null;
  }, 900);
}

function showSubtitle(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean) sendToTab("SHOW_SUBTITLE", { text: clean.slice(-400) });
}

function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data.slice(0);
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  return null;
}

function b64(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function fromB64(value) {
  const s = atob(value);
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a.buffer;
}

function normalizeWsUrl(raw, fallback, providerName) {
  let value = (raw || "").trim() || fallback;
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

  if (providerName !== "gemini") {
    const path = url.pathname.replace(/\/+$/, "");
    if (!/\/realtime$/i.test(path)) url.pathname = `${path}/realtime`;
    if (!url.searchParams.has("model") && model) url.searchParams.set("model", model);
  }

  return url.toString();
}

function openAIProtocols() {
  return [
    "realtime",
    `openai-insecure-api-key.${apiKey}`,
    "openai-beta.realtime-v1",
  ];
}

function fallbackAuthUrl(url) {
  const parsed = new URL(url);
  if (!parsed.searchParams.has("api_key") && !parsed.searchParams.has("key")) {
    parsed.searchParams.set("api_key", apiKey);
  }
  return parsed.toString();
}

function geminiSetup() {
  return {
    setup: {
      model: model.includes("/") ? model : `models/${model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        translationConfig: {
          targetLanguageCode: targetLang,
          // Echo is useful for dubbing clips that already use the target
          // language. Gemini documents this as the intended behavior.
          echoTargetLanguage: true,
        },
      },
    },
  };
}

function openAISetupModern() {
  const instructions = [
    "You are a real-time video dubbing translator.",
    `Translate every spoken input into ${targetLang}.`,
    "Do not answer, explain, summarize, or add commentary.",
    "Preserve names, numbers, technical terms, tone, and meaning.",
    "Speak only the translated text.",
    "Keep output concise and synchronized for real-time dubbing.",
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
          format: { type: "audio/pcm", rate: DEFAULTS.outputRate },
          voice: voice || DEFAULTS.openaiVoice,
          speed: 1,
        },
      },
    },
  };
}

function openAISetupLegacy() {
  return {
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      voice: voice || DEFAULTS.openaiVoice,
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 450,
      },
      instructions: [
        "You are a real-time video dubbing translator.",
        `Translate every spoken input into ${targetLang}.`,
        "Do not answer or add commentary. Speak only the translation.",
        "Preserve names, numbers, technical terms, tone, and meaning.",
      ].join(" "),
    },
  };
}

async function main(init) {
  provider = String(init?.provider || "gemini").toLowerCase();
  transport = String(init?.transport || "llm").toLowerCase();
  apiKey = String(init?.apiKey || "").trim();
  baseUrl = String(init?.baseUrl || "").trim();
  model = String(init?.model || "").trim();
  targetLang = String(init?.targetLang || "fa").trim() || "fa";
  voice = String(init?.voice || "").trim();
  voiceMode = init?.voiceMode === "chrome" ? "chrome" : "gemini";

  if (transport === "livekit") {
    return startLiveKit(init);
  }

  if (!apiKey) return fail("No LLM API key. Open DubWave Settings and add one.");
  if (!init?.streamId) return fail("No capture stream id received. Restart DubWave.");

  if (!model) model = provider === "openai" || provider === "custom" ? DEFAULTS.openaiModel : DEFAULTS.geminiModel;
  inputRate = provider === "gemini" ? GEMINI_INPUT_RATE : OPENAI_INPUT_RATE;

  try {
    ctx = new AudioContext({ latencyHint: "interactive" });
    await ctx.audioWorklet.addModule("processor.js");
    await ctx.audioWorklet.addModule("audio-player.js");
    await ctx.resume();

    playerNode = new AudioWorkletNode(ctx, "realtime-pcm-player", { outputChannelCount: [1] });
    playerNode.port.postMessage({ type: "setTargetMs", value: 120 });
    playerNode.connect(ctx.destination);

    await startCapture(init.streamId);
    startMetrics();
    openLLMSocket();
  } catch (e) {
    fail("Setup error: " + (e?.message || String(e)));
  }
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
    if (stopped || !ws || ws.readyState !== WebSocket.OPEN || !setupDone) return;

    const ab = toArrayBuffer(event.data);
    if (!ab || ab.byteLength < MIN_AUDIO_BYTES || ab.byteLength % 2 !== 0) return;

    // Do not apply a hard peak gate here. Server VAD/noise reduction is much
    // better at deciding whether speech is present and a client gate can clip
    // quiet consonants and make the translation model miss words.
    if (!startedAt) startedAt = Date.now();
    const data = b64(new Uint8Array(ab));

    try {
      if (provider === "gemini") {
        ws.send(JSON.stringify({
          realtimeInput: {
            audio: {
              data,
              mimeType: `audio/pcm;rate=${GEMINI_INPUT_RATE}`,
            },
          },
        }));
      } else {
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: data }));
      }
    } catch (e) {
      report({ error: "Audio send failed: " + e.message });
    }
  };
}

function queueOutputPcm(ab) {
  if (!playerNode || !ab || stopped || voiceMode === "chrome") return;
  if (ab.byteLength < MIN_AUDIO_BYTES || ab.byteLength % 2 !== 0) return;

  if (!firstAudioAt) {
    firstAudioAt = Date.now();
    if (startedAt) {
      report({
        text: "Playing translated audio...",
        lag: ((firstAudioAt - startedAt) / 1000).toFixed(2),
      });
    }
  }

  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
  duckOn();
  lastAudioAt = performance.now();
  outputBufferedBytes = Math.min(
    outputBufferedBytes + ab.byteLength,
    DEFAULTS.outputRate * 2 * 3
  );

  // The worklet owns one continuous PCM queue and resamples 24 kHz to the
  // device rate. This removes packet-boundary clicks and the pitch/time error
  // caused by playing 24 kHz PCM at a 48 kHz device rate.
  const copy = new Uint8Array(ab.slice(0));
  playerNode.port.postMessage({ type: "pcm", buffer: copy.buffer }, [copy.buffer]);
}

function resetPlayer() {
  if (playerNode) playerNode.port.postMessage({ type: "reset" });
}

function openLLMSocket(useFallbackAuth = false) {
  if (stopped) return;

  let url;
  try {
    url = normalizeWsUrl(
      provider === "gemini" ? baseUrl : baseUrl,
      provider === "gemini" ? DEFAULTS.geminiUrl : DEFAULTS.openaiUrl,
      provider
    );
  } catch (e) {
    fail(e.message);
    return;
  }

  let protocols = [];
  if (provider !== "gemini") {
    if (useFallbackAuth) url = fallbackAuthUrl(url);
    else protocols = openAIProtocols();
  } else {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("key") && !parsed.searchParams.has("access_token")) {
      parsed.searchParams.set("key", apiKey);
    }
    url = parsed.toString();
  }

  try {
    ws = protocols.length ? new WebSocket(url, protocols) : new WebSocket(url);
    ws.binaryType = "arraybuffer";
  } catch (e) {
    if (provider !== "gemini" && !authFallbackAttempted) {
      authFallbackAttempted = true;
      return openLLMSocket(true);
    }
    fail("WebSocket connection failed: " + e.message);
    return;
  }

  ws.onopen = () => {
    everConnected = true;
    reconnectAttempts = 0;
    setupDone = false;
    legacyOpenAISetup = false;
    startedAt = 0;
    firstAudioAt = 0;
    turnText = "";
    resetPlayer();

    ws.send(JSON.stringify(
      provider === "gemini"
        ? geminiSetup()
        : openAISetupModern()
    ));

    report({
      text: `Connected to ${provider === "gemini" ? "Gemini" : "OpenAI-compatible realtime"}. Translating...`,
    });
  };

  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      handleMessage(event.data);
      return;
    }

    const data = toArrayBuffer(event.data);
    if (!data || !data.byteLength) return;

    const first = new Uint8Array(data, 0, 1)[0];
    if (first === 123 || first === 91) {
      try {
        handleMessage(new TextDecoder("utf-8", { fatal: true }).decode(data));
        return;
      } catch (_) {}
    }

    queueOutputPcm(data);
  };

  ws.onerror = () => {
    // The close handler supplies the actionable error/retry path.
  };

  ws.onclose = (event) => {
    if (stopped || !ws) return;

    if (!everConnected && provider !== "gemini" && !authFallbackAttempted) {
      authFallbackAttempted = true;
      setTimeout(() => openLLMSocket(true), 100);
      return;
    }

    if (!everConnected) {
      fail(`Connection closed before session start${event?.reason ? ": " + event.reason : "."}`);
      return;
    }

    if (!setupDone) {
      if (provider !== "gemini" && !authFallbackAttempted) {
        authFallbackAttempted = true;
        setTimeout(() => openLLMSocket(true), 100);
        return;
      }
      fail("Server closed the realtime session before setup completed. Check the model name, endpoint protocol, and API key.");
      return;
    }

    if (reconnectAttempts < MAX_RECONNECTS) {
      reconnectAttempts++;
      setTimeout(() => openLLMSocket(false), Math.min(1000 * reconnectAttempts, 5000));
    } else {
      fail("Connection lost after retries. Stop, then start DubWave again.");
    }
  };
}

function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (_) {
    return;
  }

  if (msg.error) {
    // Some older OpenAI-compatible gateways reject the modern nested audio
    // session schema but still implement the legacy Realtime event contract.
    if (provider !== "gemini" && !legacyOpenAISetup) {
      legacyOpenAISetup = true;
      try {
        ws.send(JSON.stringify(openAISetupLegacy()));
        return;
      } catch (_) {}
    }

    const detail = msg.error.message || msg.error.code || JSON.stringify(msg.error);
    fail("API error: " + detail);
    return;
  }

  if (provider === "gemini") handleGemini(msg);
  else handleOpenAI(msg);
}

function handleGemini(msg) {
  if (msg.setupComplete) {
    if (msg.setupComplete.error) {
      return fail("Setup rejected: " + (msg.setupComplete.error.message || JSON.stringify(msg.setupComplete.error)));
    }
    setupDone = true;
    report({ text: "Connected. Translating..." });
    return;
  }

  const content = msg.serverContent;
  if (!content) return;

  if (content.interrupted) {
    resetPlayer();
    turnText = "";
    sendToTab("HIDE_SUBTITLE");
    duckOff();
    return;
  }

  if (content.outputTranscription?.text) {
    turnText += content.outputTranscription.text;
    showSubtitle(turnText);
  }

  for (const part of content.modelTurn?.parts || []) {
    if (part.text) {
      turnText += part.text;
      showSubtitle(turnText);
    }
    const inline = part.inlineData || part.inline_data;
    if (inline?.data) queueOutputPcm(fromB64(inline.data));
  }

  if (content.turnComplete) {
    const text = turnText.trim();
    showSubtitle(text);
    if (voiceMode === "chrome" && text) speak(text);
    scheduleHide();
    turnText = "";
  }
}

function handleOpenAI(msg) {
  const type = msg.type || "";

  if (type === "session.created" || type === "session.updated") {
    setupDone = true;
    report({ text: "Connected. Translating..." });
    return;
  }

  if (type === "input_audio_buffer.speech_started") {
    resetPlayer();
    duckOff();
    sendToTab("HIDE_SUBTITLE");
    turnText = "";
    return;
  }

  if (type === "response.output_audio.delta" || type === "response.audio.delta") {
    if (msg.delta) queueOutputPcm(fromB64(msg.delta));
    return;
  }

  if (type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") {
    if (msg.delta) {
      turnText += msg.delta;
      showSubtitle(turnText);
    }
    return;
  }

  if (type === "response.output_text.delta") {
    if (msg.delta) {
      turnText += msg.delta;
      showSubtitle(turnText);
    }
    return;
  }

  if (type === "response.done" || type === "response.output_audio.done") {
    const text = turnText.trim();
    if (text) showSubtitle(text);
    if (voiceMode === "chrome" && text) speak(text);
    scheduleHide();
    turnText = "";
  }
}

async function startLiveKit(init) {
  if (!init?.streamId) return fail("No capture stream id received. Restart DubWave.");
  if (!init.livekitUrl || !init.livekitToken) return fail("LiveKit server URL and participant token are required.");
  if (!globalThis.LivekitClient) return fail("LiveKit client is not bundled. Run npm install && npm run build, then load dist/extension.");

  try {
    ctx = new AudioContext({ latencyHint: "interactive" });
    await ctx.resume();

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: init.streamId,
        },
      },
    });

    const track = mediaStream.getAudioTracks()[0];
    room = new LivekitClient.Room();
    room.on(LivekitClient.RoomEvent.TrackSubscribed, (remoteTrack) => {
      if (remoteTrack.kind !== LivekitClient.Track.Kind.Audio) return;
      const element = remoteTrack.attach();
      element.autoplay = true;
      element.controls = false;
      element.style.display = "none";
      document.body.appendChild(element);
    });

    await room.connect(init.livekitUrl, init.livekitToken);
    livekitTrack = new LivekitClient.LocalAudioTrack(track);
    await room.localParticipant.publishTrack(livekitTrack);
    setupDone = true;
    report({ text: "Connected to LiveKit. Waiting for dubbing agent..." });
  } catch (e) {
    fail("LiveKit error: " + (e?.message || String(e)));
  }
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = targetLang;
  const match = speechSynthesis.getVoices().find((v) =>
    v.lang.toLowerCase().startsWith(targetLang.toLowerCase())
  );
  if (match) utterance.voice = match;
  speechSynthesis.speak(utterance);
}

function startMetrics() {
  if (metricsTimer) clearInterval(metricsTimer);
  metricsTimer = setInterval(() => {
    if (stopped) return;
    report({
      metrics: {
        bufferedMs: Number((outputBufferedBytes / (DEFAULTS.outputRate * 2) * 1000).toFixed(1)),
        reconnects: reconnectAttempts,
        audioAgeMs: lastAudioAt ? Math.max(0, performance.now() - lastAudioAt) : null,
      },
    });
    outputBufferedBytes = 0;
  }, 1000);
}

function fail(message) {
  report({ error: message });
  cleanup();
}

function cleanup() {
  stopped = true;
  if (metricsTimer) clearInterval(metricsTimer);
  if (hideTimer) clearTimeout(hideTimer);
  metricsTimer = null;
  hideTimer = null;

  try { resetPlayer(); } catch (_) {}
  try { duckOff(); sendToTab("HIDE_SUBTITLE"); } catch (_) {}
  try { ws?.close(); } catch (_) {}
  try { livekitTrack?.stop(); room?.disconnect(); } catch (_) {}
  try { workletNode?.disconnect(); sourceNode?.disconnect(); playerNode?.disconnect(); } catch (_) {}
  try { mediaStream?.getTracks().forEach((track) => track.stop()); } catch (_) {}
  try { ctx?.close(); } catch (_) {}

  ws = null;
  room = null;
  livekitTrack = null;
  workletNode = null;
  sourceNode = null;
  playerNode = null;
  mediaStream = null;
  ctx = null;
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

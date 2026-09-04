const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  provider: "gemini",
  baseUrl: "",
  apiKey: "",
  targetLang: "fa",
  voiceMode: "gemini",
  voice: "Gacrux",
  model: "gemini-3.5-live-translate-preview",
  transport: "llm",
  livekitUrl: "",
  livekitToken: "",
};

const PROVIDER_DEFAULTS = {
  gemini: {
    baseUrl: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
    model: "gemini-3.5-live-translate-preview",
  },
  openai: {
    baseUrl: "wss://api.openai.com/v1/realtime",
    model: "gpt-realtime",
  },
  custom: { baseUrl: "", model: "" },
};

let lastProvider = DEFAULTS.provider;

function isKnownDefaultUrl(value) {
  return Object.values(PROVIDER_DEFAULTS).some((v) => v.baseUrl && v.baseUrl === value);
}

function isKnownDefaultModel(value) {
  return Object.values(PROVIDER_DEFAULTS).some((v) => v.model && v.model === value);
}

function providerChanged() {
  const provider = $("provider").value;
  const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.custom;
  const currentUrl = $("baseUrl").value.trim();
  const currentModel = $("model").value.trim();
  const oldDefaults = PROVIDER_DEFAULTS[lastProvider] || PROVIDER_DEFAULTS.custom;

  // Preserve a genuinely custom URL/model, but replace the previous provider's
  // built-in defaults when switching providers.
  if (!currentUrl || currentUrl === oldDefaults.baseUrl || isKnownDefaultUrl(currentUrl)) {
    $("baseUrl").value = defaults.baseUrl;
  }
  if (!currentModel || currentModel === oldDefaults.model || isKnownDefaultModel(currentModel)) {
    $("model").value = defaults.model;
  }

  lastProvider = provider;
}

function transportChanged() {
  $("livekitFields").style.display = $("transport").value === "livekit" ? "block" : "none";
}

async function load() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  Object.keys(DEFAULTS).forEach((key) => {
    if ($(key)) $(key).value = stored[key] ?? DEFAULTS[key];
  });
  lastProvider = $("provider").value || DEFAULTS.provider;
  providerChanged();
  transportChanged();
}

function showStatus(message, isError) {
  const el = $("status");
  el.textContent = message;
  el.className = isError ? "error" : "success";
  clearTimeout(showStatus.timer);
  showStatus.timer = setTimeout(() => {
    el.textContent = "";
    el.className = "";
  }, 4500);
}

function validateUrl(provider, value) {
  if (provider === "custom" && !value) return "Custom LLM Base URL is required.";
  if (!value) return "LLM Base URL is required.";

  try {
    const url = new URL(value);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
      return "Base URL must use http(s) or ws(s).";
    }
  } catch (_) {
    return "Invalid LLM Base URL.";
  }
  return "";
}

$("provider").addEventListener("change", providerChanged);
$("transport").addEventListener("change", transportChanged);

$("save").addEventListener("click", async () => {
  const provider = $("provider").value;
  const apiKey = $("apiKey").value.trim();
  const baseUrl = $("baseUrl").value.trim();
  const model = $("model").value.trim();
  const transport = $("transport").value;

  if (!apiKey && transport !== "livekit") {
    showStatus("LLM API key is required for direct LLM mode.", true);
    return;
  }
  if (transport === "livekit" && !$("livekitUrl").value.trim()) {
    showStatus("LiveKit server URL is required.", true);
    return;
  }
  if (transport === "llm") {
    const urlError = validateUrl(provider, baseUrl);
    if (urlError) {
      showStatus(urlError, true);
      return;
    }
    if (!model) {
      showStatus("LLM model is required for direct realtime mode.", true);
      return;
    }
  }

  await chrome.storage.local.set({
    provider,
    baseUrl,
    apiKey,
    targetLang: $("targetLang").value,
    voiceMode: $("voiceMode").value,
    voice: $("voice").value,
    model,
    transport,
    livekitUrl: $("livekitUrl").value.trim(),
    livekitToken: $("livekitToken").value.trim(),
  });
  showStatus("Saved. DubWave is ready.", false);
});

load();

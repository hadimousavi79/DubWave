const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  provider: "gemini",
  baseUrl: "",
  apiKey: "",
  targetLang: "fa",
  voiceMode: "gemini",
  voice: "Gacrux",
  model: "gemini-3.5-live-translate-preview",
};

const PROVIDER_DEFAULTS = {
  gemini: { baseUrl: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent", model: "gemini-3.5-live-translate-preview" },
  openai: { baseUrl: "wss://api.openai.com/v1/realtime", model: "gpt-4o-realtime-preview" },
  custom: { baseUrl: "", model: "" },
};

function providerChanged() {
  const provider = $("provider").value;
  const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.custom;
  if (!$("baseUrl").value.trim() || Object.values(PROVIDER_DEFAULTS).some(v => v.baseUrl === $("baseUrl").value.trim())) $("baseUrl").value = defaults.baseUrl;
  if (!$("model").value.trim() || Object.values(PROVIDER_DEFAULTS).some(v => v.model === $("model").value.trim())) $("model").value = defaults.model;
}

async function load() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  Object.keys(DEFAULTS).forEach(key => { if ($(key)) $(key).value = stored[key] ?? DEFAULTS[key]; });
  providerChanged();
}

function showStatus(message, isError) {
  const el = $("status"); el.textContent = message; el.className = isError ? "error" : "success";
  clearTimeout(showStatus.timer); showStatus.timer = setTimeout(() => { el.textContent = ""; el.className = ""; }, 3500);
}

$("provider").addEventListener("change", providerChanged);
$("save").addEventListener("click", async () => {
  const apiKey = $("apiKey").value.trim();
  if (!apiKey) { showStatus("LLM API key is required.", true); return; }

  await chrome.storage.local.set({
    provider: $("provider").value,
    baseUrl: $("baseUrl").value.trim(),
    apiKey,
    targetLang: $("targetLang").value,
    voiceMode: $("voiceMode").value,
    voice: $("voice").value,
    model: $("model").value.trim(),
  });
  showStatus("Saved. DubWave is ready.", false);
});

load();

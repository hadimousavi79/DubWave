
const $ = (id) => document.getElementById(id);

const DEFAULT_MODEL = "gemini-3.5-live-translate-preview";

const DEFAULTS = {
  apiKey: "",
  targetLang: "fa",
  voiceMode: "gemini",
  model: DEFAULT_MODEL,
};

async function load() {
  const stored = await chrome.storage.local.get(DEFAULTS);

  $("apiKey").value = stored.apiKey || "";
  $("targetLang").value = stored.targetLang || "fa";
  $("voiceMode").value = stored.voiceMode || "gemini";
  $("model").value = (stored.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

function showStatus(message, isError) {
  const el = $("status");

  el.textContent = message;
  el.className = isError ? "error" : "success";

  clearTimeout(showStatus.timer);

  showStatus.timer = setTimeout(() => {
    el.textContent = "";
    el.className = "";
  }, 3000);
}

$("save").addEventListener("click", async () => {
  const apiKey = $("apiKey").value.trim();

  if (!apiKey) {
    showStatus("API key is required.", true);
    return;
  }

  await chrome.storage.local.set({
    apiKey: apiKey,
    targetLang: $("targetLang").value,
    voiceMode: $("voiceMode").value,
    model: $("model").value.trim() || DEFAULT_MODEL,
  });

  showStatus("Saved. DubWave is ready.", false);
});

load();

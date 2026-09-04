const $ = (id) => document.getElementById(id);

const btn = $("toggle");
const settingsBtn = $("settings");
const statusText = $("statusText");
const dot = $("dot");
const lagEl = $("lag");

const LANG_NAMES = {
  fa: "Persian",
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  ru: "Russian",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  ar: "Arabic",
  hi: "Hindi",
  tr: "Turkish",
  nl: "Dutch",
  pl: "Polish",
  sv: "Swedish",
  da: "Danish",
  no: "Norwegian",
  fi: "Finnish",
};

let state = {
  running: false,
  hasKey: false,
  targetLang: "fa",
};

function render() {
  btn.disabled = false;

  const lang = LANG_NAMES[state.targetLang] || state.targetLang;

  if (state.running) {
    btn.textContent = "Stop dubbing (" + lang + ")";
    dot.className = "dot on";
    statusText.textContent = "Listening and translating to " + lang + "...";
  } else {
    btn.textContent = "Start dubbing → " + lang;
    dot.className = state.hasKey ? "dot" : "dot err";
    statusText.textContent = state.hasKey
      ? "Ready. Click Start on a tab with audio."
      : "Add your LLM API key in Settings first.";
  }
}

function showError(message) {
  statusText.textContent = message;
  dot.className = "dot err";
  btn.disabled = false;
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: "getState" }).catch(() => null);

  const stored = await chrome.storage.local.get({
    apiKey: "",
    targetLang: "fa",
  });

  state = {
    running: !!(res && res.running),
    hasKey: !!(stored.apiKey || "").trim(),
    targetLang: stored.targetLang || "fa",
  };

  render();
}

btn.addEventListener("click", async () => {
  btn.disabled = true;

  if (!state.hasKey) {
    showError("No API key. Open Settings and add one.");
    chrome.runtime.openOptionsPage();
    window.close();
    return;
  }

  try {
    if (!state.running) {
      const [tab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });

      if (!tab || !tab.id) throw new Error("No active tab found.");

      const streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: tab.id,
      });

      const res = await chrome.runtime.sendMessage({
        type: "start",
        streamId,
        tabId: tab.id,
      }).catch(() => null);

      if (res && res.ok) {
        state.running = true;
        render();
      } else {
        showError((res && res.error) || "Could not start DubWave.");
      }
    } else {
      await chrome.runtime.sendMessage({ type: "stop" }).catch(() => {});
      state.running = false;
      render();
    }
  } catch (e) {
    showError("Start failed: " + e.message);
  }
});

settingsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "popupStatus") return;

  if (msg.error) {
    state.running = false;
    render();
    showError(msg.error);
    return;
  }

  if (msg.lag) lagEl.textContent = "▼ " + msg.lag + "s";
  if (msg.text && state.running) statusText.textContent = msg.text;
});

refresh();

// DubWave service worker.
// Orchestrates tab capture and the selected realtime LLM.

let running = false;
let currentTabId = null;

function keepAlive() {
  const timer = setInterval(() => {
    if (!running) clearInterval(timer);
    else chrome.runtime.getPlatformInfo(() => {});
  }, 20000);
}

async function ensureOffscreen() {
  const hasDocument = await chrome.offscreen.hasDocument();
  if (hasDocument) return;
  const ready = new Promise((resolve) => {
    const timeout = setTimeout(resolve, 3000);
    const listener = (msg) => {
      if (msg?.type === "offscreen_ready") {
        clearTimeout(timeout); chrome.runtime.onMessage.removeListener(listener); resolve();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
  });
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Capture tab audio and route it through the selected realtime AI service.",
  });
  await ready;
}

async function start({ streamId, tabId }) {
  if (running) return { ok: false, error: "Already running." };
  if (!streamId) return { ok: false, error: "No audio stream." };
  currentTabId = tabId;
  try { await chrome.tabs.update(tabId, { muted: true }); } catch (_) {}
  try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] }); } catch (e) { console.warn("DubWave injection failed:", e); }
  await ensureOffscreen();

  const cfg = await chrome.storage.local.get({
    provider: "gemini", baseUrl: "", apiKey: "", model: "gemini-3.5-live-translate-preview",
    voiceMode: "gemini", voice: "Gacrux", targetLang: "fa"
  });

  try {
    await chrome.runtime.sendMessage({ type: "offscreen_start", streamId, ...cfg });
  } catch (e) { console.error("DubWave failed sending offscreen_start:", e); }
  running = true; keepAlive();
  notify({ text: `Connecting to ${cfg.provider}...` });
  return { ok: true };
}

async function stop() {
  running = false;
  if (currentTabId != null) {
    try { await chrome.tabs.sendMessage(currentTabId, { type: "CLEANUP" }); } catch (_) {}
    try { await chrome.tabs.update(currentTabId, { muted: false }); } catch (_) {}
    currentTabId = null;
  }
  try {
    if (await chrome.offscreen.hasDocument()) {
      try { await chrome.runtime.sendMessage({ type: "offscreen_stop" }); } catch (_) {}
      await chrome.offscreen.closeDocument();
    }
  } catch (_) {}
  return { ok: true };
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (running && tabId === currentTabId) { await stop(); notify({ text: "Tab closed. DubWave stopped." }); }
});
function notify(msg) { chrome.runtime.sendMessage(Object.assign({ type: "popupStatus" }, msg)).catch(() => {}); }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "getState") { sendResponse({ running }); return; }
  if (msg.type === "engine_status") { if (msg.error) { stop(); notify(msg); } else notify({ text: msg.text, lag: msg.lag }); return; }
  if (msg.type === "OFFSCREEN_TO_TAB") { if (currentTabId != null) chrome.tabs.sendMessage(currentTabId, msg.payload).catch(() => {}); return; }
  if (msg.type === "start" || msg.type === "stop") {
    (async () => { const result = msg.type === "start" ? await start(msg) : await stop(); sendResponse(result); })();
    return true;
  }
});

// DubWave content script.
// Realtime subtitles + smooth adaptive ducking for the source video.

let activeVideo = null;
let subtitleEl = null;
let originalVolume = 1;
let ducked = false;
let duckTimer = null;
let duckGeneration = 0;
let lastSubtitle = "";

const DUCK_TARGET = 0.18;
const DUCK_STEP_MS = 20;
const DUCK_FADE_MS = 120;
const UNDuck_FADE_MS = 180;

function findBestVideo() {
  const videos = Array.from(document.querySelectorAll("video"));
  if (!videos.length) return null;
  return videos.reduce((best, video) => {
    const bestArea = best.clientWidth * best.clientHeight;
    const area = video.clientWidth * video.clientHeight;
    return area > bestArea ? video : best;
  }, videos[0]);
}

function ensureSubtitleElement() {
  if (subtitleEl && document.documentElement.contains(subtitleEl)) return subtitleEl;

  subtitleEl = document.createElement("div");
  subtitleEl.id = "dubwave-subtitle";
  subtitleEl.style.cssText = [
    "position:fixed", "left:50%", "bottom:10%", "transform:translateX(-50%)",
    "max-width:min(80vw,1000px)", "z-index:2147483647", "pointer-events:none",
    "color:#ffffff", "font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif",
    "font-size:26px", "font-weight:700", "line-height:1.4", "text-align:center",
    "text-shadow:0 2px 6px rgba(0,0,0,0.95)", "background:rgba(0,0,0,0.55)",
    "padding:12px 22px", "border-radius:12px", "display:none", "backdrop-filter:blur(4px)",
    "unicode-bidi:plaintext", "white-space:pre-wrap"
  ].join(";");
  document.documentElement.appendChild(subtitleEl);
  return subtitleEl;
}

function ensureUI() {
  activeVideo = findBestVideo();
  ensureSubtitleElement();
}

function animateVolume(video, from, to, duration, generation) {
  if (!video) return;
  if (duckTimer) clearInterval(duckTimer);
  const start = performance.now();
  const delta = to - from;
  duckTimer = setInterval(() => {
    if (generation !== duckGeneration || !video.isConnected) {
      clearInterval(duckTimer);
      duckTimer = null;
      return;
    }
    const progress = Math.min(1, (performance.now() - start) / duration);
    const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    video.volume = Math.max(0, Math.min(1, from + delta * eased));
    if (progress >= 1) {
      clearInterval(duckTimer);
      duckTimer = null;
    }
  }, DUCK_STEP_MS);
}

function duckAudio() {
  ensureUI();
  if (!activeVideo) return;
  duckGeneration++;
  const generation = duckGeneration;
  if (!ducked) {
    originalVolume = activeVideo.volume;
    ducked = true;
  }
  animateVolume(activeVideo, activeVideo.volume, originalVolume * DUCK_TARGET, DUCK_FADE_MS, generation);
}

function unduckAudio() {
  ensureUI();
  if (!activeVideo || !ducked) return;
  duckGeneration++;
  const generation = duckGeneration;
  animateVolume(activeVideo, activeVideo.volume, originalVolume, UNDuck_FADE_MS, generation);
  ducked = false;
}

function normalizeSubtitle(text) {
  return String(text || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isRtl(text) {
  const rtl = (text.match(/[\u0590-\u08ff]/g) || []).length;
  const ltr = (text.match(/[A-Za-z]/g) || []).length;
  return rtl > ltr;
}

function showSubtitle(text) {
  const normalized = normalizeSubtitle(text);
  if (!normalized) return;
  const el = ensureSubtitleElement();
  lastSubtitle = normalized;
  el.textContent = normalized;
  el.dir = isRtl(normalized) ? "rtl" : "ltr";
  el.style.display = "block";
}

function hideSubtitle() {
  if (!subtitleEl) return;
  subtitleEl.style.display = "none";
  subtitleEl.textContent = "";
  lastSubtitle = "";
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  ensureUI();

  if (msg.type === "DUCK_AUDIO") duckAudio();
  if (msg.type === "UNDUCK_AUDIO") unduckAudio();
  if (msg.type === "SHOW_SUBTITLE") showSubtitle(msg.text);
  if (msg.type === "HIDE_SUBTITLE") hideSubtitle();

  if (msg.type === "CLEANUP") {
    duckGeneration++;
    if (duckTimer) clearInterval(duckTimer);
    duckTimer = null;
    if (activeVideo) activeVideo.volume = originalVolume;
    ducked = false;
    hideSubtitle();
    if (subtitleEl) {
      subtitleEl.remove();
      subtitleEl = null;
    }
  }
});

setInterval(ensureUI, 1500);
ensureUI();

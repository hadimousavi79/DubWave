
// DubWave content script.
// Shows subtitles and ducks the original video audio while AI speech plays.

let activeVideo = null;
let subtitleEl = null;
let originalVolume = 1;
let isDucked = false;

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
  if (subtitleEl && document.documentElement.contains(subtitleEl)) {
    return subtitleEl;
  }

  subtitleEl = document.createElement("div");
  subtitleEl.id = "dubwave-subtitle";

  subtitleEl.style.cssText = [
    "position:fixed",
    "left:50%",
    "bottom:10%",
    "transform:translateX(-50%)",
    "max-width:80vw",
    "z-index:2147483647",
    "pointer-events:none",
    "color:#ffffff",
    "font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif",
    "font-size:26px",
    "font-weight:700",
    "line-height:1.35",
    "text-align:center",
    "text-shadow:0 2px 6px rgba(0,0,0,0.9)",
    "background:rgba(0,0,0,0.55)",
    "padding:12px 22px",
    "border-radius:12px",
    "display:none",
    "backdrop-filter:blur(4px)",
  ].join(";");

  document.documentElement.appendChild(subtitleEl);

  return subtitleEl;
}

function ensureUI() {
  activeVideo = findBestVideo();
  ensureSubtitleElement();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;

  ensureUI();

  if (msg.type === "DUCK_AUDIO") {
    if (activeVideo && !isDucked) {
      originalVolume = activeVideo.volume;
      activeVideo.volume = originalVolume * 0.15;
      isDucked = true;
    }
  }

  if (msg.type === "UNDUCK_AUDIO") {
    if (activeVideo && isDucked) {
      activeVideo.volume = originalVolume;
      isDucked = false;
    }
  }

  if (msg.type === "SHOW_SUBTITLE") {
    const el = ensureSubtitleElement();

    if (el && msg.text) {
      el.textContent = msg.text;
      el.style.display = "block";
    }
  }

  if (msg.type === "HIDE_SUBTITLE") {
    if (subtitleEl) {
      subtitleEl.style.display = "none";
      subtitleEl.textContent = "";
    }
  }

  if (msg.type === "CLEANUP") {
    if (activeVideo) {
      activeVideo.volume = originalVolume;
    }

    if (subtitleEl) {
      subtitleEl.remove();
      subtitleEl = null;
    }

    isDucked = false;
  }
});

// Some websites are SPAs. Re-check for video elements periodically.
setInterval(ensureUI, 1500);
ensureUI();

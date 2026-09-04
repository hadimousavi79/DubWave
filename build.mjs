import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Convert the module URL to a native filesystem path. This automatically
// handles Windows drive letters, spaces, URL encoding, and POSIX/Linux paths.
const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const extension = path.join(dist, "extension");

await rm(dist, { recursive: true, force: true });
await mkdir(extension, { recursive: true });

const files = [
  "README.md",
  "LICENSE",
  "NOTICE",
  "manifest.json",
  "background.js",
  "content.js",
  "popup.html",
  "popup.js",
  "options.html",
  "options.js",
  "offscreen.html",
  "offscreen-v2.js",
  "offscreen.js",
  "processor.js",
  "audio-player.js",
];

for (const file of files) {
  try {
    // Keep the root copy for backwards compatibility and create a complete
    // dist/extension folder that can be selected directly in chrome://extensions.
    await cp(path.join(root, file), path.join(dist, file));
    await cp(path.join(root, file), path.join(extension, file));
  } catch (_) {
    // Optional files should not make the extension build fail.
  }
}

await cp(path.join(root, "icons"), path.join(dist, "icons"), { recursive: true });
await cp(path.join(root, "icons"), path.join(extension, "icons"), { recursive: true });

const livekit = path.join(root, "node_modules", "livekit-client", "dist", "livekit-client.umd.js");
await cp(livekit, path.join(dist, "livekit-client.js"));
await cp(livekit, path.join(extension, "livekit-client.js"));

console.log("DubWave build complete: dist/");
console.log("Chrome load folder: dist/extension/");

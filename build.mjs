import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Convert the module URL to a native filesystem path. This automatically
// handles Windows drive letters, spaces, URL encoding, and POSIX/Linux paths.
const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const file of [
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
  "audio-player.js"
]) {
  try {
    await cp(path.join(root, file), path.join(dist, file));
  } catch (_) {}
}

await cp(path.join(root, "icons"), path.join(dist, "icons"), {
  recursive: true
});

await cp(
  path.join(root, "node_modules", "livekit-client", "dist", "livekit-client.umd.js"),
  path.join(dist, "livekit-client.js")
);

console.log("DubWave build complete: dist/");

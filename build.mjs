import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const root = new URL(".", import.meta.url).pathname;
const dist = `${root}dist/`;
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const file of ["README.md","LICENSE","NOTICE","manifest.json","background.js","content.js","popup.html","popup.js","options.html","options.js","offscreen.html","offscreen-v2.js","offscreen.js","processor.js","audio-player.js"]) {
  try { await cp(`${root}${file}`, `${dist}${file}`); } catch (_) {}
}
for (const dir of ["icons"]) await cp(`${root}${dir}`, `${dist}${dir}`, { recursive: true });
await build({ entryPoints: ["node_modules/livekit-client/dist/livekit-client.umd.js"], bundle: false, format: "iife", outfile: `${dist}livekit-client.js`, minify: false });
console.log("DubWave build complete: dist/");

/**
 * Renders the real injection payload against a ZCode-shaped layout, so the
 * per-region blur/dim can be judged visually instead of only asserted.
 *
 * It runs the actual buildPayload / buildBootstrapScript / buildPanelScript
 * code — not a re-implementation — so what the browser shows is what the plugin
 * injects. Writes out.html next to this file; serve it with serve.mjs and open
 * it in a browser (or drive it with the browser tooling).
 *
 *   npx tsx test/region-harness/render.ts            # theme only
 *   npx tsx test/region-harness/render.ts --panel    # + the settings panel
 *
 * Env:
 *   ZCB_HARNESS_WALLPAPER  image to render (default: the plugin's stored one)
 *   ZCB_HARNESS_PORT       port serve.mjs listens on (default 18999)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPayload, DEFAULT_CONFIG, type BeautifyConfig } from "../../src/core/inject.js";
import { buildBootstrapScript } from "../../src/core/cdp.js";
import { buildPanelScript } from "../../src/panel/panelScript.js";
import { loadWallpaper } from "../../src/core/monet.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ZCB_HARNESS_PORT ?? 18999);
const API_PORT = 9223;

const wallpaperPath =
  process.env.ZCB_HARNESS_WALLPAPER ??
  path.join(os.homedir(), ".zcode", "cli", "plugins", "data", "zcode-beautify", "wallpaper.png");
if (!fs.existsSync(wallpaperPath)) {
  console.error(`No wallpaper to render. Set ZCB_HARNESS_WALLPAPER, or install one via the panel first.\nLooked at: ${wallpaperPath}`);
  process.exit(1);
}

/** One distinct value per region, so a mix-up is visible rather than plausible. */
const REGIONS = {
  sidebar: { blur: 0, dim: 45 },
  main: { blur: 6, dim: 20 },
  terminal: { blur: 26, dim: 8 },
  sidepanel: { blur: 0, dim: 60 },
};

const config: BeautifyConfig = { ...DEFAULT_CONFIG, blur: 18, dim: 25, fit: "cover", regions: REGIONS };

// A real Monet theme, but the wallpaper is served over HTTP: embedding a
// multi-megabyte data URI would make the page unwieldy and proves nothing extra.
const assets = await loadWallpaper(wallpaperPath);
const payload = buildPayload(config, { ...assets, dataUri: `http://127.0.0.1:${PORT}/wallpaper.png` });
const bootstrap = buildBootstrapScript({
  css: payload.css,
  wallpaperDataUri: payload.wallpaperDataUri,
  videoSrc: payload.videoSrc,
  fit: payload.fit,
  regionIds: payload.regionIds,
  activeRegions: payload.activeRegions,
  live: payload.live,
});

const legend = [
  `global: ${config.blur}px / ${config.dim}%   fit=${payload.fit}`,
  ...Object.entries(REGIONS).map(([id, r]) => `${id}: ${r.blur}px / ${r.dim}%`),
].join("\\n");

const scripts = [
  `<script>${bootstrap}</script>`,
  process.argv.includes("--panel") ? `<script>${buildPanelScript(API_PORT)}</script>` : "",
  `<script>document.getElementById('legend').textContent = "${legend}";</script>`,
].join("\n");

const template = fs.readFileSync(path.join(DIR, "layout.html"), "utf8");
fs.writeFileSync(path.join(DIR, "out.html"), template.replace("<!--INJECT-->", scripts));

console.log(`out.html written (css ${payload.css.length} B, bootstrap ${bootstrap.length} B)`);
console.log(`active regions: ${payload.activeRegions.map((r) => r.id).join(", ")}`);
console.log(`\nnext:\n  node test/region-harness/serve.mjs\n  open http://127.0.0.1:${PORT}/out.html`);

/**
 * T11 verification: per-region blur/dim.
 *
 * Covers the payload contract the injected runtime relies on — the wallpaper
 * layer no longer carries the blur/dim itself, every region gets a layer plus
 * the custom properties that keep a self-healed stylesheet correct, and only
 * overridden regions are handed to the runtime — plus the config merge rules
 * the panel, CLI and MCP tool all go through.
 */
import vm from "node:vm";
import { buildPayload, DEFAULT_CONFIG, type BeautifyConfig } from "../src/core/inject.js";
import { buildBootstrapScript, buildResetScript } from "../src/core/cdp.js";
import { buildPanelScript } from "../src/panel/panelScript.js";
import {
  DEFAULT_REGION_SELECTORS,
  effectiveRegions,
  mergeRegionSettings,
  sanitizeRegionPatch,
} from "../src/core/regions.js";

let failed = 0;
function check(label: string, cond: boolean, extra = "") {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` (${extra})` : ""}`);
}

function payloadOf(overrides: Partial<BeautifyConfig>) {
  return buildPayload({ ...DEFAULT_CONFIG, ...overrides });
}

function bootstrapOf(overrides: Partial<BeautifyConfig>) {
  const payload = payloadOf(overrides);
  return buildBootstrapScript({
    css: payload.css,
    wallpaperDataUri: payload.wallpaperDataUri,
    videoSrc: payload.videoSrc,
    fit: payload.fit,
    regionIds: payload.regionIds,
    regionSelectors: payload.regionSelectors,
    activeRegions: payload.activeRegions,
    live: payload.live,
  });
}

// --- the wallpaper layer itself is no longer blurred or dimmed --------------
const plain = payloadOf({ blur: 18, dim: 40 });
const wallpaperRule = plain.css.slice(plain.css.indexOf("#zcode-beautify-wallpaper {"), plain.css.indexOf("#zcode-beautify-backdrop {"));
check("wallpaper layer keeps no blur filter", !wallpaperRule.includes("filter:"));
check("wallpaper layer keeps no dim overlay", !plain.css.includes("-wallpaper::after"));
check("global layer exists", plain.css.includes("#zcode-beautify-global {"));
check("global blur emitted as a variable", plain.css.includes("--zcb-global-filter:blur(18px)"));
check("global dim emitted as a variable", plain.css.includes("--zcb-global-dim:0.4"));
check("global layer reads the variables", plain.css.includes("backdrop-filter: var(--zcb-global-filter, none)"));
check("blur still zooms the wallpaper against edge fade", wallpaperRule.includes("scale(1.04)"));
check("no blur means no zoom", payloadOf({ blur: 0 }).css.includes("scale(1)"));

// --- region layers ----------------------------------------------------------
const withRegion = payloadOf({ blur: 6, dim: 20, regions: { sidebar: { blur: 0, dim: 45 } } });
check("region layer rule emitted", withRegion.css.includes("#zcode-beautify-region-sidebar {"));
check("region layer hidden until measured", withRegion.css.includes("display: none"));
check("region blur variable", withRegion.css.includes("--zcb-sidebar-filter:none"));
check("region dim variable", withRegion.css.includes("--zcb-sidebar-dim:0.45"));
check("only the overridden region is active", withRegion.activeRegions.length === 1 && withRegion.activeRegions[0].id === "sidebar");
check("active region uses the ZCode layout hook", withRegion.activeRegions[0].selector === DEFAULT_REGION_SELECTORS.sidebar);
check("every region id is passed to the runtime", withRegion.regionIds.length === 4);
check("every region carries a selector for observation", Object.keys(withRegion.regionSelectors).length === 4);

// A region that only overrides one field inherits the other from the global.
const halfRegion = payloadOf({ blur: 6, dim: 20, regions: { main: { blur: 24 } } });
check("blur-only region keeps the global dim", halfRegion.css.includes("--zcb-main-dim:0.2"));
check("blur-only region takes its own blur", halfRegion.css.includes("--zcb-main-filter:blur(24px)"));

// A selector-only override changes no values, so the region still follows the
// global look and needs no layer.
const selectorOnly = payloadOf({ regions: { terminal: { selector: "#my-terminal" } } });
check("selector-only override adds no layer", selectorOnly.activeRegions.length === 0);
const customSelector = payloadOf({ regions: { terminal: { blur: 4, selector: "#my-terminal" } } });
check("custom selector reaches the runtime", customSelector.activeRegions[0].selector === "#my-terminal");

// live config mirrors the CSS so the panel can preview without a round trip
check("live config carries the global filter", withRegion.live.global.filter === "blur(6px)");
check("live config carries the region filter", withRegion.live.regions.sidebar.filter === "none");
check("live config carries the region selector", withRegion.live.regions.sidebar.selector === DEFAULT_REGION_SELECTORS.sidebar);
check("live config omits untouched regions", Object.keys(withRegion.live.regions).length === 1);

// --- no wallpaper, no layers ------------------------------------------------
const hidden = payloadOf({ wallpaperVisible: false, blur: 12, dim: 40, regions: { sidebar: { blur: 0 } } });
check("hidden wallpaper emits no global layer", !hidden.css.includes("#zcode-beautify-global"));
check("hidden wallpaper emits no region layers", !hidden.css.includes("-region-sidebar"));
check("hidden wallpaper has no active regions", hidden.activeRegions.length === 0);

// --- scripts must be valid JavaScript ---------------------------------------
// Both are large template literals, where a stray backtick or an unescaped
// interpolation compiles fine in TypeScript but produces a broken script.
function compiles(label: string, source: string) {
  try {
    new vm.Script(source);
    check(label, true);
  } catch (err) {
    check(label, false, (err as Error).message);
  }
}
compiles("bootstrap script is valid JavaScript", bootstrapOf({ regions: { sidebar: { blur: 2, dim: 30 } } }));
compiles("bootstrap script is valid without regions", bootstrapOf({}));
compiles("panel script is valid JavaScript", buildPanelScript(9223));

const bootstrap = bootstrapOf({ regions: { sidebar: { blur: 2, dim: 30 } } });
check("bootstrap creates a layer per region id", bootstrap.includes("-region-' + id"));
check("bootstrap resolves the region selector at runtime", bootstrap.includes("document.querySelector(selector)"));
// polygon() would join the holes with real edges and cut a bowtie (an X) into
// the layer as soon as two regions are active.
check("bootstrap clips the global layer with separate subpaths", bootstrap.includes('clip-path:path("'));
check("bootstrap does not use a multi-hole polygon", !bootstrap.includes("polygon(evenodd"));
// A stale script's timer cannot be cleared (its id was never stored), so the
// clip is an important stylesheet declaration that its inline write cannot beat.
check("bootstrap clip outranks stale inline writes", bootstrap.includes('") !important;}'));
check("bootstrap observes region resize", bootstrap.includes("new ResizeObserver(function"));
// An observer left over from an older script keeps the old callback, which is
// how layer positions kept following while the clip-path stopped.
check("bootstrap re-creates observers when the node changes", bootstrap.includes("prev.ro.disconnect()"));
check("bootstrap forces an observer takeover on inject", bootstrap.includes("track(true)"));
// The side pane slides by moving only, which no ResizeObserver reports.
check("bootstrap tracks position-only motion", bootstrap.includes("attributeFilter: ['style', 'class']"));
check("bootstrap watches structural changes", bootstrap.includes("childList: true, subtree: true"));
check("bootstrap probe is idle-gated", bootstrap.includes("if (!R.dirty) return;"));
check("bootstrap watches the region's wrappers", bootstrap.includes("wrappersOf(target)"));
check("bootstrap parks the motion loop when idle", bootstrap.includes("motionIdle < 30"));
check("bootstrap skips writes when nothing moved", bootstrap.includes("m.sig === RT.appliedSig"));
check("bootstrap replaces the previous ticker", bootstrap.includes("clearInterval(RT.trackTimer)"));
check("bootstrap routes ticks through the runtime object", bootstrap.includes("R.track(false);"));
check("bootstrap probe runs at a fraction of a second", bootstrap.includes("}, 80);"));
// A rAF-driven follow is always one frame behind; a resize arrives after
// layout, in the same frame.
check("bootstrap writes from the resize observer", bootstrap.includes("onResizeObserved()"));
check("bootstrap observes regions without overrides too", bootstrap.includes("(window.__zcodeBeautify.selectors || {})[id]"));
check("bootstrap skips collapsed regions", bootstrap.includes("r.width < 2 || r.height < 2"));
check("bootstrap exposes the live entry point", bootstrap.includes("__zcodeBeautify.applyLive ="));
check("bootstrap guard includes the region set", bootstrap.includes("regionsKey === JSON.stringify(ACTIVE)"));
check("bootstrap guard includes the script version", bootstrap.includes("scriptVersion === VERSION"));

const reset = buildResetScript();
check("reset removes the global layer", reset.includes("'-global')?.remove()"));
check("reset removes region layers", reset.includes("'-region-'"));
check("reset removes the clip stylesheet", reset.includes("'-clip')?.remove()"));

// --- config merging ---------------------------------------------------------
const patch = sanitizeRegionPatch({ sidebar: { blur: 8, dim: 30, selector: "#s" } });
check("patch keeps a valid region", patch?.sidebar?.blur === 8 && patch.sidebar.selector === "#s");
check("patch drops unknown region ids", sanitizeRegionPatch({ nope: { blur: 1 } }) === undefined);
check("patch drops out-of-range values", sanitizeRegionPatch({ main: { blur: 500, dim: -1 } }) === undefined);
check("patch keeps explicit nulls", sanitizeRegionPatch({ main: { blur: null } })?.main?.blur === null);
check("patch ignores malformed bodies", sanitizeRegionPatch("sidebar") === undefined);

const merged = mergeRegionSettings({ sidebar: { blur: 8, dim: 30 }, main: { dim: 10 } }, { sidebar: { blur: 0 }, main: { dim: null } });
check("merge overrides one field", merged.sidebar?.blur === 0 && merged.sidebar?.dim === 30);
check("merge clears on null and drops the emptied region", merged.main === undefined);
check("merge keeps untouched regions", merged.sidebar !== undefined);

// --- resolution -------------------------------------------------------------
const effective = effectiveRegions({ ...DEFAULT_CONFIG, blur: 5, dim: 15, regions: { sidebar: { dim: 50 } } });
const sidebar = effective.find((r) => r.id === "sidebar")!;
const main = effective.find((r) => r.id === "main")!;
check("region inherits the global blur", sidebar.blur === 5);
check("region keeps its own dim", sidebar.dim === 50);
check("region reports itself as overridden", sidebar.overridden);
check("region reports only the field it owns", sidebar.own.dim === 50 && sidebar.own.blur === undefined);
check("untouched region follows the global values", main.blur === 5 && main.dim === 15 && !main.overridden);
check("untouched region owns no field", Object.keys(main.own).length === 0);
check("untouched region falls back to the built-in selector", main.selector === DEFAULT_REGION_SELECTORS.main);

if (failed > 0) {
  console.error(`T11 FAIL (${failed})`);
  process.exit(1);
}
console.log("T11 PASS");

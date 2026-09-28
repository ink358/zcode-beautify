/**
 * Assembles the full injected payload: wallpaper layer CSS + variable
 * overrides, plus helpers to apply a theme to a running ZCode instance.
 */

import { CdpConnection, injectIntoTarget, listTargets, pickRendererTargets, buildBootstrapScript, buildResetScript } from "./cdp.js";
import { loadWallpaper, type WallpaperAssets } from "./monet.js";
import { buildVariableOverrides, buildTransparencyOverrides } from "./tokens.js";
import { effectiveRegions, REGION_IDS, type RegionSettings, type EffectiveRegion } from "./regions.js";

export type WallpaperFit = "cover" | "contain" | "smart";

export interface BeautifyConfig {
  port: number;
  wallpaperPath?: string;
  blur: number;
  dim: number;
  monet: boolean;
  wallpaperVisible: boolean;
  fit: WallpaperFit;
  /** Per-region blur/dim overrides; a missing region follows the global values. */
  regions?: RegionSettings;
  /**
   * Scene wallpapers: URL of the cached loop video (serve media endpoint).
   * When set, the wallpaper layer renders a <video> instead of an image.
   */
  sceneVideoUrl?: string;
  /** "video" when the current wallpaper is an imported scene wallpaper. */
  mediaType?: "image" | "video";
  /** Cache hash of the imported scene (loop at scenes/<hash>/loop.mp4). */
  sceneHash?: string;
  /** Serve API port used to derive sceneVideoUrl (default 9223). */
  apiPort?: number;
}

export const DEFAULT_CONFIG: BeautifyConfig = {
  port: 9222,
  blur: 0,
  dim: 25,
  monet: true,
  wallpaperVisible: true,
  fit: "cover",
};

/** One region's resolved appearance, as the injected runtime consumes it. */
export interface LiveRegion {
  /** A CSS filter value: `blur(Npx)` or `none`. */
  filter: string;
  /** Dim as an alpha 0-1, applied as a black scrim over the blurred backdrop. */
  dim: number;
  selector: string;
}

export interface LiveConfig {
  global: { filter: string; dim: number };
  /** Only the regions that carry an override; the rest follow the global layer. */
  regions: Record<string, LiveRegion>;
}

export interface BuiltPayload {
  css: string;
  wallpaperDataUri?: string;
  /** Set for scene wallpapers: the loop video URL for the <video> layer. */
  videoSrc?: string;
  /** How the wallpaper layer is framed; "contain" adds a blurred backdrop. */
  fit: "cover" | "contain";
  /** Normalized focus point for background-position. */
  focusX: number;
  focusY: number;
  /** Every tunable region id, in panel order. */
  regionIds: string[];
  /** Effective selector per region id, whether or not it carries an override. */
  regionSelectors: Record<string, string>;
  /** Region ids carrying an override, with their resolved selectors. */
  activeRegions: Array<{ id: string; selector: string }>;
  /** Resolved values for the injected runtime. */
  live: LiveConfig;
}

function filterOf(blur: number): string {
  return blur > 0 ? `blur(${blur}px)` : "none";
}

/**
 * The wallpaper layer itself stays sharp and undimmed; the blur and the scrim
 * live in their own backdrop layers so a single region can replace them
 * exactly. A region layer re-creates the effect inside its rect and the global
 * layer is clipped around it (the runtime writes the clip-path), which is what
 * makes a region able to be sharper *or* blurrier than the rest of the window.
 *
 * The same values are also emitted as custom properties so a stylesheet
 * restored from localStorage — where the runtime is absent and no region can be
 * measured — still renders the global blur and dim correctly.
 */
function buildLayerCss(config: BeautifyConfig, regions: EffectiveRegion[]): string {
  const vars: string[] = [
    `--zcb-global-filter:${filterOf(config.blur)};`,
    `--zcb-global-dim:${config.dim / 100};`,
  ];
  const rules: string[] = [
    `#zcode-beautify-global {
  position: fixed;
  inset: 0;
  z-index: -2147483645;
  pointer-events: none;
  backdrop-filter: var(--zcb-global-filter, none);
  background: rgb(0 0 0 / var(--zcb-global-dim, 0));
}`,
  ];
  for (const region of regions) {
    vars.push(`--zcb-${region.id}-filter:${filterOf(region.blur)};`);
    vars.push(`--zcb-${region.id}-dim:${region.dim / 100};`);
    // display:none until the runtime measures a real rect for the region.
    rules.push(`#zcode-beautify-region-${region.id} {
  position: fixed;
  display: none;
  z-index: -2147483644;
  pointer-events: none;
  backdrop-filter: var(--zcb-${region.id}-filter, none);
  background: rgb(0 0 0 / var(--zcb-${region.id}-dim, 0));
}`);
  }
  return `:root,:host{${vars.join("")}}\n${rules.join("\n")}`;
}

export function buildPayload(config: BeautifyConfig, assets?: WallpaperAssets): BuiltPayload {
  const parts: string[] = [];

  // "smart" resolves to the analyzed suggestion at build time, so the injected
  // CSS only ever deals with cover or contain.
  const resolved: "cover" | "contain" =
    config.fit === "smart" ? (assets?.focus.fit ?? "cover") : config.fit === "contain" ? "contain" : "cover";
  const focusX = config.fit === "smart" ? (assets?.focus.x ?? 0.5) : 0.5;
  const focusY = config.fit === "smart" ? (assets?.focus.y ?? 0.5) : 0.5;
  const position = `${Math.round(focusX * 100)}% ${Math.round(focusY * 100)}%`;

  const regions = effectiveRegions(config);

  parts.push(`
html, body { background: transparent !important; }
#zcode-beautify-wallpaper {
  position: fixed;
  inset: 0;
  z-index: -2147483646;
  background-size: ${resolved};
  background-position: ${resolved === "contain" ? "center" : position};
  background-repeat: no-repeat;
  pointer-events: none;
  transform: scale(${config.blur > 0 ? 1.04 : 1});
}
#zcode-beautify-backdrop {
  position: fixed;
  inset: 0;
  z-index: -2147483647;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  pointer-events: none;
  filter: blur(28px) saturate(1.15) brightness(0.85);
  transform: scale(1.12);
  display: none;
}
#zcode-beautify-backdrop[data-on="1"] { display: block; }`);
  // Without a wallpaper there is nothing to blur or dim, and a bare scrim would
  // darken the translucent UI itself — so the layers only exist with a picture.
  if (config.wallpaperVisible) {
    parts.push(buildLayerCss(config, regions));
  }

  if (assets) {
    // Monet recolors the UI from the wallpaper; the wallpaper toggle only
    // decides whether the picture is visible at all. With Monet off we still
    // need transparency, otherwise the opaque UI hides the wallpaper.
    if (config.monet) {
      parts.push(buildVariableOverrides(assets.theme, {
        dim: config.dim,
        wallpaperVisible: config.wallpaperVisible,
      }));
    } else if (config.wallpaperVisible) {
      parts.push(buildTransparencyOverrides({ dim: config.dim }));
    }
  }
  const wallpaperDataUri =
    config.sceneVideoUrl || !config.wallpaperVisible ? undefined : assets?.dataUri;
  const videoSrc = config.wallpaperVisible ? config.sceneVideoUrl : undefined;

  // Without a wallpaper there is no backdrop to cut up, so no region is live
  // even when overrides are stored — they take effect again once it is shown.
  const liveRegions = config.wallpaperVisible ? regions.filter((region) => region.overridden) : [];
  const activeRegions = liveRegions.map((region) => ({ id: region.id, selector: region.selector }));
  const live: LiveConfig = {
    global: { filter: filterOf(config.blur), dim: config.dim / 100 },
    regions: Object.fromEntries(
      liveRegions.map((region) => [region.id, { filter: filterOf(region.blur), dim: region.dim / 100, selector: region.selector }]),
    ),
  };

  return {
    css: parts.join("\n"),
    wallpaperDataUri,
    videoSrc,
    fit: config.wallpaperVisible ? resolved : "cover",
    focusX,
    focusY,
    regionIds: [...REGION_IDS],
    regionSelectors: Object.fromEntries(regions.map((region) => [region.id, region.selector])),
    activeRegions,
    live,
  };
}

export interface InjectScriptInput {
  mediaType: "image" | "video";
  /** Image file path / data URI, or the loop video URL for video type. */
  path: string;
  blur: number;
  dim: number;
  fit?: "cover" | "contain";
}

/**
 * Thin convenience wrapper that builds a standalone injection script from a
 * minimal input — used by tests and quick one-off injections. Full theming
 * flows through buildPayload().
 */
export function buildInjectScript(input: InjectScriptInput): string {
  let css = `
html, body { background: transparent !important; }
#zcode-beautify-wallpaper {
  position: fixed;
  inset: 0;
  z-index: -2147483646;
  pointer-events: none;
  filter: blur(${input.blur}px);
  transform: scale(${input.blur > 0 ? 1.04 : 1});
}
#zcode-beautify-wallpaper > video,
#zcode-beautify-wallpaper {
  width: 100%;
  height: 100%;
  object-fit: cover;
}`;
  if (input.dim > 0) {
    css += `
#zcode-beautify-wallpaper::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgb(0 0 0 / ${input.dim / 100});
}`;
  }

  if (input.mediaType === "video") {
    return buildBootstrapScript({ css, videoSrc: input.path, fit: input.fit ?? "cover" });
  }
  const src = /^(data:|https?:|file:)/i.test(input.path)
    ? input.path
    : `file:///${input.path.replace(/\\/g, "/").replace(/^\/+/, "")}`;
  return buildBootstrapScript({ css, wallpaperDataUri: src, fit: input.fit ?? "cover" });
}

/** Apply config to a running ZCode instance. Returns how many windows got it. */
export async function applyToZCode(config: BeautifyConfig, payload: BuiltPayload): Promise<number> {
  const targets = pickRendererTargets(await listTargets(config.port));
  if (targets.length === 0) {
    throw new Error("No ZCode renderer target found on the CDP endpoint.");
  }
  let count = 0;
  for (const target of targets) {
    try {
      await injectIntoTarget(target, payload);
      count++;
    } catch (err) {
      console.warn(`Injection into "${target.title}" failed: ${(err as Error).message}`);
    }
  }
  return count;
}

export async function resetZCode(port: number): Promise<number> {
  const targets = pickRendererTargets(await listTargets(port));
  let count = 0;
  for (const target of targets) {
    try {
      const conn = await CdpConnection.connect(target.webSocketDebuggerUrl!);
      await conn.send("Runtime.evaluate", { expression: buildResetScript() });
      conn.close();
      count++;
    } catch (err) {
      console.warn(`Reset of "${target.title}" failed: ${(err as Error).message}`);
    }
  }
  return count;
}

/** Re-export so CLI/MCP can load wallpapers without touching monet internals. */
export { loadWallpaper };

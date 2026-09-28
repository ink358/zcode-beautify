/**
 * Per-region wallpaper tuning.
 *
 * The wallpaper layer sits behind the whole window, so blur/dim used to be
 * global by nature. ZCode's shell exposes stable semantic hooks for its four
 * layout regions, which lets each one get its own blur and dim: the region
 * layer re-creates the backdrop effect inside its rect and the global layer is
 * clipped around it, so a region can be sharper *or* blurrier than the rest.
 *
 * Region selectors are deliberately ZCode's own `data-workspace-*` attributes
 * rather than generated class names: they are the app's intentional layout
 * contract, so they survive styling churn. A user-picked selector overrides
 * them when the layout changes anyway.
 */

import type { BeautifyConfig } from "./inject.js";

export const REGION_IDS = ["sidebar", "main", "terminal", "sidepanel"] as const;
export type RegionId = (typeof REGION_IDS)[number];

export interface RegionSetting {
  /** CSS selector resolved inside the renderer; absent → the default hook. */
  selector?: string;
  /** Wallpaper blur in px for this region; absent → inherit the global blur. */
  blur?: number;
  /** Wallpaper dim 0-100 for this region; absent → inherit the global dim. */
  dim?: number;
}

export type RegionSettings = Partial<Record<RegionId, RegionSetting>>;

/** A patch value of null clears the field; undefined leaves it alone. */
export interface RegionSettingPatch {
  selector?: string | null;
  blur?: number | null;
  dim?: number | null;
}

export type RegionPatches = Partial<Record<RegionId, RegionSettingPatch>>;

export const DEFAULT_REGION_SELECTORS: Record<RegionId, string> = {
  sidebar: "[data-workspace-sidebar-panel]",
  main: "[data-workspace-conversation-frame]",
  terminal: "[data-workspace-terminal-frame]",
  sidepanel: "[data-workspace-side-frame]",
};

export const REGION_LABELS: Record<RegionId, string> = {
  sidebar: "侧边栏",
  main: "主区域",
  terminal: "终端",
  sidepanel: "右侧面板",
};

/** Two-character labels for the panel's target chips. */
export const REGION_SHORT_LABELS: Record<RegionId, string> = {
  sidebar: "侧栏",
  main: "主区",
  terminal: "终端",
  sidepanel: "右栏",
};

export interface EffectiveRegion {
  id: RegionId;
  selector: string;
  /** Resolved blur in px (own value or the global one). */
  blur: number;
  /** Resolved dim 0-100 (own value or the global one). */
  dim: number;
  /** True when the region carries a blur or dim of its own and needs a layer. */
  overridden: boolean;
  /** The fields this region owns; every other field follows the global value. */
  own: { blur?: number; dim?: number };
}

export function isRegionId(value: unknown): value is RegionId {
  return typeof value === "string" && (REGION_IDS as readonly string[]).includes(value);
}

/** Resolves every region against the global blur/dim. */
export function effectiveRegions(config: BeautifyConfig): EffectiveRegion[] {
  return REGION_IDS.map((id) => {
    const set = config.regions?.[id];
    return {
      id,
      selector: set?.selector?.trim() || DEFAULT_REGION_SELECTORS[id],
      blur: set?.blur ?? config.blur,
      dim: set?.dim ?? config.dim,
      overridden: set?.blur !== undefined || set?.dim !== undefined,
      own: { ...(set?.blur !== undefined ? { blur: set.blur } : {}), ...(set?.dim !== undefined ? { dim: set.dim } : {}) },
    };
  });
}

/** The regions that actually need their own layer, i.e. carry an override. */
export function overriddenRegions(config: BeautifyConfig): EffectiveRegion[] {
  return effectiveRegions(config).filter((r) => r.overridden);
}

/**
 * Drops unknown regions and out-of-range values. A field is kept only when the
 * caller actually sent it: a number sets it, an explicit null clears it, and
 * anything else is ignored — so a malformed body cannot silently wipe the
 * stored regions. Returns undefined when the patch holds nothing usable.
 */
export function sanitizeRegionPatch(input: unknown): RegionPatches | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: RegionPatches = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!isRegionId(key)) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const body = raw as Record<string, unknown>;
    const patch: RegionSettingPatch = {};
    if (body.selector === null) patch.selector = null;
    else if (typeof body.selector === "string") {
      const selector = body.selector.trim();
      if (selector && selector.length <= 200) patch.selector = selector;
    }
    for (const field of ["blur", "dim"] as const) {
      const value = body[field];
      if (value === null) patch[field] = null;
      else if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100) patch[field] = value;
    }
    if (Object.keys(patch).length > 0) out[key] = patch;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Applies a patch over the stored regions. A null clears that field, which is
 * how the panel, the CLI and the agent all put a region back on the global
 * value; a region left with no fields is dropped entirely.
 */
export function mergeRegionSettings(current: RegionSettings | undefined, patch: RegionPatches | undefined): RegionSettings {
  const out: RegionSettings = { ...(current ?? {}) };
  if (!patch) return out;
  for (const [id, fields] of Object.entries(patch) as Array<[RegionId, RegionSettingPatch]>) {
    const setting: RegionSetting = { ...(out[id] ?? {}) };
    for (const [field, value] of Object.entries(fields) as Array<[keyof RegionSetting, string | number | null]>) {
      if (value === null) delete setting[field];
      else (setting as Record<string, string | number>)[field] = value;
    }
    if (Object.keys(setting).length === 0) delete out[id];
    else out[id] = setting;
  }
  return out;
}

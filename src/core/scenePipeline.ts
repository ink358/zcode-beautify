/**
 * End-to-end scene wallpaper import pipeline:
 *
 *   detect -> check deps -> cache lookup -> open WE window -> record (ddagrab)
 *   -> close window -> seamless loop -> poster frame -> cache -> enforce LRU
 *
 * Every stage reports progress via onProgress. Rendering happens on the
 * machine itself, so the panel just passes the local wallpaper path — no
 * upload — and the result is served over the serve-mode media endpoint.
 */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { detectWallpaperType } from "./wallpaperType.js";
import { checkWallpaperEngine, checkFfmpeg } from "./dependencyCheck.js";
import { openSceneWindow, closeSceneWindow } from "./weLauncher.js";
import { recordSceneWindow, analyzeBlackness } from "./recorder.js";
import { makeSeamless, probeDuration } from "./loopProcessor.js";
import { computeHash, getCachePath, hasCache, touchCache, enforceLimit } from "./cacheManager.js";

export interface SceneImportOptions {
  width?: number;
  height?: number;
  fps?: number;
  /** Raw capture length in seconds; the loop ends up duration - fade. */
  duration?: number;
  fadeSec?: number;
  /** Video imports longer than this are truncated to a middle segment. */
  maxSeconds?: number;
  /** Window title for the temporary WE render window. */
  title?: string;
  maxCacheBytes?: number;
}

export interface SceneImportResult {
  /** Cached seamless loop video, ready to serve. */
  loopPath: string;
  /** Extracted poster frame (for Monet theming), next to the loop. */
  posterPath: string;
  hash: string;
  /** Advisory footage check: dark wallpapers legitimately score low. */
  blackness: { blackFraction: number; meanLuma: number; durationSec: number };
  /** True when an existing cache entry was reused (no rendering happened). */
  fromCache: boolean;
}

export class MissingDependencyError extends Error {
  constructor(public readonly missing: Array<"we" | "ffmpeg">) {
    super(`Missing dependencies: ${missing.join(", ")}`);
  }
}

export class SceneImportError extends Error {}

/** First .mp4/.webm in the directory root, then its files/ subfolder. */
function findVideoInDir(dir: string): string | undefined {
  for (const subdir of ["", "files"]) {
    const base = path.join(dir, subdir);
    let entries: string[];
    try {
      entries = fs.readdirSync(base);
    } catch {
      continue;
    }
    const hit = entries.find((e) => /\.(mp4|webm)$/i.test(e));
    if (hit) return path.join(base, hit);
  }
  return undefined;
}

/**
 * Accepts the many ways a user can point at a scene wallpaper: a `.pkg`
 * file, the wallpaper directory, or ANY file inside it (file dialogs make
 * users pick something concrete like preview.gif) — walks up to the nearest
 * enclosing `project.json` in that case.
 */
export function resolveSceneInput(input: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(input);
  } catch {
    return input; // nonexistent: let detectWallpaperType report it
  }
  if (stat.isDirectory()) return input;
  if (input.toLowerCase().endsWith(".pkg")) return input;
  let dir = path.dirname(path.resolve(input));
  for (let hop = 0; hop < 4; hop++) {
    if (fs.existsSync(path.join(dir, "project.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return input;
}

export const DEFAULT_SCENE_OPTIONS: Required<Pick<SceneImportOptions, "width" | "height" | "fps" | "duration" | "fadeSec" | "title" | "maxCacheBytes" | "maxSeconds">> = {
  width: 1920,
  height: 1080,
  fps: 30,
  duration: 15,
  fadeSec: 1,
  title: "WE_Render",
  maxCacheBytes: 10 * 1024 ** 3,
  maxSeconds: 60,
};

export async function importScene(
  pkgPath: string,
  onProgress: (stage: string, detail?: string) => void = () => undefined,
  options: SceneImportOptions = {},
  ffmpegPath?: string,
): Promise<SceneImportResult> {
  const opts = { ...DEFAULT_SCENE_OPTIONS, ...options };

  onProgress("detect", pkgPath);
  let type = detectWallpaperType(pkgPath);

  // A video input stays a file (the footage itself); a video-type DIRECTORY
  // (WE video wallpapers have project.json too) resolves to the video inside.
  // Everything else may point at any file inside the wallpaper directory.
  try {
    if (type === "video" && fs.statSync(pkgPath).isDirectory()) {
      const videoFile = findVideoInDir(pkgPath);
      if (!videoFile) throw new SceneImportError(`No .mp4/.webm inside video wallpaper directory: ${pkgPath}`);
      pkgPath = videoFile;
    } else if (type !== "video") {
      pkgPath = resolveSceneInput(pkgPath);
      type = detectWallpaperType(pkgPath);
    }
  } catch (err) {
    if (err instanceof SceneImportError) throw err;
    /* stat failed on a nonexistent path — detect below reports it */
  }
  if (type !== "scene" && type !== "video") {
    throw new SceneImportError(`Not a scene or video wallpaper (${type}): ${pkgPath}`);
  }
  const isVideo = type === "video";

  onProgress("deps");
  // Video imports need no Wallpaper Engine — ffmpeg alone suffices.
  const missing: Array<"we" | "ffmpeg"> = [];
  if (!isVideo && !(await checkWallpaperEngine()).ok) missing.push("we");
  if (!(await checkFfmpeg()).ok) missing.push("ffmpeg");
  if (missing.length > 0) throw new MissingDependencyError(missing);

  // User property overrides from WE's own profile config: the render window
  // reads project.json defaults only, so toggles the user flipped in WE
  // (prompt box, audio bars, component switches) stay invisible unless merged.
  const weDir = isVideo
    ? undefined
    : await checkWallpaperEngine().then((we) => (we.ok && we.path ? path.dirname(we.path) : undefined));
  const overrides = !isVideo && weDir ? collectUserPropertyOverrides(weDir, pkgPath) : {};
  const overridesDigest =
    Object.keys(overrides).length > 0
      ? crypto.createHash("md5").update(JSON.stringify(overrides)).digest("hex").slice(0, 12)
      : "none";

  const hash = isVideo
    ? computeHash(pkgPath, { kind: "video", maxWidth: 1920, maxSeconds: opts.maxSeconds, fadeSec: opts.fadeSec })
    : computeHash(pkgPath, {
        width: opts.width,
        height: opts.height,
        fps: opts.fps,
        duration: opts.duration,
        fadeSec: opts.fadeSec,
        overrides: overridesDigest,
      });
  const loopPath = getCachePath(hash);
  const posterPath = path.join(path.dirname(loopPath), "poster.jpg");

  if (hasCache(hash)) {
    onProgress("cache-hit", hash);
    touchCache(hash);
    enforceLimit(opts.maxCacheBytes);
    return { loopPath, posterPath, hash, blackness: { blackFraction: -1, meanLuma: -1, durationSec: -1 }, fromCache: true };
  }

  if (isVideo) {
    // Direct video wallpaper: no WE window, no recording — the source IS the
    // footage. Normalize (truncate long clips, cap width), loop, poster, cache.
    onProgress("analyzing", pkgPath);
    const sourceDuration = await probeDuration(pkgPath, ffmpegPath ?? (await checkFfmpeg()).path!);
    const trim =
      sourceDuration > opts.maxSeconds
        ? { startAt: (sourceDuration - opts.maxSeconds) / 2, seconds: opts.maxSeconds }
        : undefined;
    if (trim) onProgress("truncating", `${sourceDuration.toFixed(1)}s -> ${opts.maxSeconds}s`);

    onProgress("processing", `crossfade ${opts.fadeSec}s`);
    const tmpLoop = `${loopPath}.tmp.mp4`;
    await makeSeamless(pkgPath, tmpLoop, opts.fadeSec, ffmpegPath, {
      startAt: trim?.startAt,
      seconds: trim?.seconds,
      maxWidth: 1920,
    });

    onProgress("poster");
    await extractPoster(tmpLoop, posterPath, ffmpegPath);

    onProgress("saving", hash);
    fs.mkdirSync(path.dirname(loopPath), { recursive: true });
    fs.renameSync(tmpLoop, loopPath);

    const blackness = await analyzeBlackness(loopPath, ffmpegPath);
    enforceLimit(opts.maxCacheBytes);

    onProgress("done", loopPath);
    return { loopPath, posterPath, hash, blackness, fromCache: false };
  }

  onProgress("opening", `window "${opts.title}"`);
  // WE's security model only executes scene scripts from trusted locations
  // (workshop, Documents\Wallpaper Engine\...); from %TEMP% the headless trust
  // prompt can't be answered and the window renders plain black. Render the
  // staged trusted copy with the user's overrides spliced in, never the original.
  const renderDir = stageTrustedRenderCopy(pkgPath, hash, overrides, onProgress);
  const handle = await openSceneWindow(renderDir, { width: opts.width, height: opts.height, title: opts.title });
  try {
    onProgress("render-ready", JSON.stringify(handle.client));
    await new Promise((r) => setTimeout(r, 10_000)); // big scene pkgs + shader compilation need longer than a cold start

    onProgress("recording", `${opts.duration}s @ ${opts.fps}fps`);
    const rawPath = path.join(path.dirname(loopPath), `raw-${Date.now()}.mp4`);
    fs.mkdirSync(path.dirname(rawPath), { recursive: true });
    try {
      await recordSceneWindow(handle, rawPath, { duration: opts.duration, fps: opts.fps, outWidth: opts.width, outHeight: opts.height }, ffmpegPath);
    } finally {
      onProgress("closing");
      await closeSceneWindow(handle).catch(() => undefined);
    }

    onProgress("processing", `crossfade ${opts.fadeSec}s`);
    const tmpLoop = `${loopPath}.tmp.mp4`;
    await makeSeamless(rawPath, tmpLoop, opts.fadeSec, ffmpegPath);

    onProgress("poster");
    await extractPoster(tmpLoop, posterPath, ffmpegPath);

    onProgress("saving", hash);
    fs.mkdirSync(path.dirname(loopPath), { recursive: true });
    fs.renameSync(tmpLoop, loopPath);
    fs.rmSync(rawPath, { force: true });

    const blackness = await analyzeBlackness(loopPath, ffmpegPath);
    enforceLimit(opts.maxCacheBytes);

    onProgress("done", loopPath);
    return { loopPath, posterPath, hash, blackness, fromCache: false };
  } finally {
    // If anything above threw, make sure the WE window never lingers.
    await closeSceneWindow(handle).catch(() => undefined);
  }
}

// --- trusted staging + Wallpaper Engine property overrides -------------------

/**
 * WE only executes scene scripts from trusted locations (the Steam workshop,
 * Documents\Wallpaper Engine\...); from anywhere else the play window stays
 * plain black because the trust prompt cannot be answered headlessly. So the
 * render always runs from a full copy under
 * Documents\Wallpaper Engine\projects\zcode-beautify\<hash>, with the user's
 * property overrides spliced into its project.json.
 */
function stageTrustedRenderCopy(
  sourceDir: string,
  hash: string,
  overrides: Record<string, unknown>,
  onProgress: (stage: string, detail?: string) => void,
): string {
  const staged = path.join(os.homedir(), "Documents", "Wallpaper Engine", "projects", "zcode-beautify", hash);
  if (fs.existsSync(path.join(staged, "project.json"))) return staged; // already staged for this hash
  onProgress("staging", staged);
  fs.rmSync(staged, { recursive: true, force: true });
  fs.mkdirSync(staged, { recursive: true });
  fs.cpSync(sourceDir, staged, { recursive: true });
  const applied = splicePropertyOverrides(path.join(staged, "project.json"), overrides);
  if (applied > 0) onProgress("staged", `${applied} property overrides merged`);
  return staged;
}

/**
 * Collects the property values the user last set in Wallpaper Engine's UI.
 * WE stores them per profile in config.json (next to wallpaper32/64.exe):
 * profiles.<profile>.wproperties.<wallpaper path>.<monitor>, where the
 * wallpaper path keys use forward slashes. Only keys that exist in the
 * wallpaper's project.json AND differ from its default are returned.
 */
export function collectUserPropertyOverrides(weDir: string, sourceDir: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let defaults: Record<string, { value?: unknown }> = {};
  try {
    const raw = fs.readFileSync(path.join(sourceDir, "project.json"), "utf8");
    defaults = (JSON.parse(raw) as { general?: { properties?: Record<string, { value?: unknown }> } }).general?.properties ?? {};
  } catch {
    return out;
  }
  let cfg: any;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(weDir, "config.json"), "utf8"));
  } catch {
    return out;
  }
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  const wanted = new Set([
    norm(path.join(sourceDir, "scene.pkg")),
    norm(path.join(sourceDir, "project.json")),
    norm(sourceDir),
  ]);
  for (const data of Object.values<any>(cfg)) {
    const wprops = data?.wproperties;
    if (!wprops || typeof wprops !== "object") continue;
    for (const [wpKey, monitors] of Object.entries<any>(wprops)) {
      if (!wanted.has(norm(wpKey))) continue;
      for (const monitor of Object.values<any>(monitors ?? {})) {
        if (!monitor || typeof monitor !== "object") continue;
        for (const [key, value] of Object.entries(monitor)) {
          if (defaults[key] && !deepEqual(defaults[key].value, value)) out[key] = value;
        }
      }
    }
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Splices override values into the raw project.json bytes — no JSON
 * re-serialization, so the file keeps its exact original shape. Each property
 * object is located by key; combo properties carry an options array before
 * their own "value", so every candidate match is verified by re-parsing and
 * only committed when the property value actually equals the override.
 */
function splicePropertyOverrides(projectJsonPath: string, overrides: Record<string, unknown>): number {
  const original = fs.readFileSync(projectJsonPath, "utf8");
  const escKey = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const propsOf = (text: string): Record<string, { value?: unknown }> =>
    (JSON.parse(text) as { general?: { properties?: Record<string, { value?: unknown }> } }).general?.properties ?? {};
  let raw = original;
  let applied = 0;
  for (const [key, value] of Object.entries(overrides)) {
    const literal = JSON.stringify(value);
    const patterns = [
      new RegExp(`("${escKey(key)}"\\s*:\\s*\\{[^{}]*?"value"\\s*:\\s*)[^,}\\n]+`),
      new RegExp(`("${escKey(key)}"\\s*:\\s*\\{[\\s\\S]*?"type"\\s*:\\s*"[^"]*"[^{}]*?"value"\\s*:\\s*)[^,}\\n]+`),
    ];
    for (const re of patterns) {
      if (!re.test(raw)) continue;
      const candidate = raw.replace(re, `$1${literal}`);
      if (propsOf(candidate)[key]?.value === value) {
        raw = candidate;
        applied++;
        break;
      }
      // matched an option's "value" inside a combo — try the anchored pattern
    }
  }
  if (raw !== original) fs.writeFileSync(projectJsonPath, raw);
  return applied;
}

/** Grabs a representative frame for Monet color extraction. */
export async function extractPoster(loopFile: string, posterPath: string, ffmpegPath?: string): Promise<void> {
  const ffmpeg = ffmpegPath ?? (await checkFfmpeg()).path;
  if (!ffmpeg) throw new SceneImportError("ffmpeg not found");
  fs.mkdirSync(path.dirname(path.resolve(posterPath)), { recursive: true });
  await execFileP(ffmpeg, [
    "-y", "-loglevel", "error",
    "-ss", "1", // skip the crossfade's darkest opening moment
    "-i", loopFile,
    "-frames:v", "1", "-update", "1",
    "-q:v", "2",
    posterPath,
  ], { timeout: 60_000 });
}

function execFileP(
  cmd: string,
  args: string[],
  opts: { timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  return promisify(execFile)(cmd, args, { windowsHide: true, ...opts });
}

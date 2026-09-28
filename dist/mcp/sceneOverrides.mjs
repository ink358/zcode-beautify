/**
 * Scene render preparation: replay the user's saved Wallpaper Engine property
 * overrides (and hide author prompt boxes) in the temporary render copy.
 *
 * Why: a fresh `-playInWindow` render uses project.json property DEFAULTS.
 * Properties the user turned off in WE (author message popups, clocks, ...)
 * are stored in WE's config.json under <profile>.wproperties.<wallpaper path>
 * .<MonitorN>.<property> and are NOT picked up by the render window — so the
 * imported loop showed popups the user had disabled.
 *
 * Mechanism (deterministic, no IPC): build a temp copy of the wallpaper dir
 * where every asset is a hardlink and project.json has the user's override
 * values merged into the property defaults. WE reads the patched defaults and
 * renders exactly what the user sees on their desktop.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Bool properties whose label/key smells like an author message box. */
const PROMPT_BOX_RE = /提示框|弹窗|公告|弹幕|popup|prompt|notice|announcement|disclaimer/i;

const TMP_PREFIX = "we-render-";

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const normPath = (s) => String(s).toLowerCase().replace(/\\/g, "/");

/**
 * Collects the user's property overrides for a wallpaper across config.json
 * profiles. Monitor0's values win over later monitors (primary display is
 * what a render represents).
 */
export function collectUserOverrides(weDir, dir, inputPath) {
  const cfgPath = path.join(weDir, "config.json");
  const cfg = readJsonSafe(cfgPath);
  if (!cfg) return {};

  const wanted = [inputPath, path.join(dir, "project.json"), path.join(dir, "scene.pkg")].map(normPath);
  const wantedStem = normPath(path.join(dir, ""));

  const perProfile = [];
  for (const [profileName, profile] of Object.entries(cfg)) {
    const table = profile && typeof profile === "object" ? profile.wproperties : null;
    if (!table || typeof table !== "object") continue;
    const merged = {};
    for (const [wpPath, monitors] of Object.entries(table)) {
      const n = normPath(wpPath);
      if (!wanted.includes(n) && !n.startsWith(wantedStem)) continue;
      if (!monitors || typeof monitors !== "object") continue;
      const monNames = Object.keys(monitors).sort((a, b) => {
        const ma = /^Monitor(\d+)$/i.exec(a)?.[1];
        const mb = /^Monitor(\d+)$/i.exec(b)?.[1];
        if (ma !== undefined && mb !== undefined) return Number(ma) - Number(mb);
        if (ma !== undefined) return -1;
        if (mb !== undefined) return 1;
        return a.localeCompare(b);
      });
      for (const mon of monNames) {
        const o = monitors[mon];
        if (!o || typeof o !== "object") continue;
        for (const [k, v] of Object.entries(o)) {
          if (!(k in merged)) merged[k] = v; // earlier monitor wins
        }
      }
    }
    if (Object.keys(merged).length > 0) perProfile.push({ profileName, merged });
  }

  // Prefer the profile of the logged-in user; fall back to first profile with hits.
  let user = "";
  try {
    user = os.userInfo().username.toLowerCase();
  } catch {}
  const hit =
    perProfile.find((p) => p.profileName.toLowerCase() === user) ?? perProfile[0];
  return hit ? hit.merged : {};
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyTree(s, d);
    } else if (entry.isFile()) {
      try {
        fs.linkSync(s, d);
      } catch {
        fs.copyFileSync(s, d); // cross-volume or link unsupported
      }
    }
  }
}

/**
 * Builds (or reuses) the patched render copy. Returns
 * `{ path, tmpDir }` with the patched project.json path, or
 * `{ path: inputPath, tmpDir: null }` when nothing needs overriding.
 */
export function prepareSceneRenderInput(inputPath, weExePath) {
  const weDir = path.dirname(weExePath);
  const stat = fs.statSync(inputPath);
  const dir = stat.isDirectory() ? inputPath : path.dirname(path.resolve(inputPath));
  const projectFile = path.join(dir, "project.json");
  const project = readJsonSafe(projectFile);
  const props = project && project.general && project.general.properties;
  if (!project || !props || typeof props !== "object") {
    return { path: inputPath, tmpDir: null };
  }

  const overrides = collectUserOverrides(weDir, dir, inputPath);
  const applied = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (props[k] && typeof props[k] === "object" && props[k].type !== "text") {
      props[k].value = v;
      applied[k] = v;
    }
  }
  // Wallpapers the user never configured: still hide obvious author prompt
  // boxes (bools only, default-on) so they don't block the render.
  for (const [k, def] of Object.entries(props)) {
    if (applied[k] !== undefined || !def || typeof def !== "object") continue;
    if (def.type === "bool" && def.value === true && PROMPT_BOX_RE.test(`${def.text ?? ""} ${k}`)) {
      props[k].value = false;
      applied[k] = false;
    }
  }
  if (Object.keys(applied).length === 0) {
    return { path: inputPath, tmpDir: null };
  }

  const key = crypto.createHash("md5").update(`${dir}\n${JSON.stringify(applied)}`).digest("hex").slice(0, 16);
  const tmpDir = path.join(os.tmpdir(), `${TMP_PREFIX}${key}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  copyTree(dir, tmpDir);
  fs.writeFileSync(path.join(tmpDir, "project.json"), JSON.stringify(project));
  fs.writeFileSync(path.join(tmpDir, ".we-render-source"), dir);
  return { path: path.join(tmpDir, "project.json"), tmpDir };
}

/** Removes a render copy created by prepareSceneRenderInput. Idempotent. */
export function cleanupSceneRender(tmpDir) {
  if (!tmpDir) return;
  const resolved = path.resolve(tmpDir);
  if (path.dirname(resolved) !== os.tmpdir() || !path.basename(resolved).startsWith(TMP_PREFIX)) {
    return; // refuse to delete anything that is not our temp copy
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

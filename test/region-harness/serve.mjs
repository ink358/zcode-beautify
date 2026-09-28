/**
 * Static server for the region harness. Serves this directory and maps
 * /wallpaper.png onto the plugin's stored wallpaper, so the rendered page can
 * use an ordinary URL instead of a multi-megabyte data URI.
 *
 *   node test/region-harness/serve.mjs
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ZCB_HARNESS_PORT ?? 18999);
const WALLPAPER =
  process.env.ZCB_HARNESS_WALLPAPER ??
  path.join(os.homedir(), ".zcode", "cli", "plugins", "data", "zcode-beautify", "wallpaper.png");

const TYPES = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".js": "text/javascript" };

http
  .createServer((req, res) => {
    const route = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const file = route === "/wallpaper.png" ? WALLPAPER : path.join(DIR, route.replace(/^\/+/, "") || "out.html");
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end(`not found: ${route}`);
        return;
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`region harness on http://127.0.0.1:${PORT}/out.html`));

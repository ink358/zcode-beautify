# Region harness

Per-region blur/dim is a rendering feature: `test/t11-verify.ts` locks the
payload contract, but only a browser can show that a region really is sharper
than the rest and that the wallpaper stays seamless across the boundaries. This
harness renders the **real** injected payload against a page shaped like ZCode's
shell (same `data-workspace-*` layout nodes, same translucent `--color-*`
surfaces), so what you see is what the plugin injects.

```bash
npx tsx test/region-harness/render.ts            # theme only
npx tsx test/region-harness/render.ts --panel    # + the settings panel
node test/region-harness/serve.mjs               # then open the printed URL
```

`render.ts` writes `out.html` here and `serve.mjs` serves it, mapping
`/wallpaper.png` onto the plugin's stored wallpaper (override with
`ZCB_HARNESS_WALLPAPER`, port with `ZCB_HARNESS_PORT`).

What to check in the rendered page:

| Region | Expected |
|---|---|
| sidebar | sharp, 45% dim |
| main | 6px blur, 20% dim |
| terminal | 26px blur, 8% dim |
| side panel | sharp, 60% dim |
| title bar strip | 18px blur, 25% dim (the global layer) |

The wallpaper must line up exactly across every boundary, and the top-right
legend lists the values being rendered.

With `--panel` the settings panel is injected too. It talks to a running
`serve` on port 9223, so its 调节目标 chips and sliders exercise the full path
(panel → local preview → `/api/config` → re-injection). Two more cases worth
driving from the console:

```js
// A collapsed panel must not leave a slab of blur behind.
document.querySelector('[data-workspace-terminal-frame]').style.height = '0px';
// Then restore it and confirm the region comes back.
document.querySelector('[data-workspace-terminal-frame]').style.height = '190px';
```

Note that a `serve` instance keeps its own stored config, so driving the panel
here also changes the user's real settings — put them back afterwards.

# Hexa AI — Portfolio Site

Static portfolio for showcasing AI-generated brand content. Plain HTML/CSS/JS — no build step.

## Run locally

Open `index.html` directly, or for best results (so `fetch` of `videos.json` works in all browsers) run a tiny static server:

```bash
npx serve .
# or
python3 -m http.server 8000
```

Then visit http://localhost:3000 (or :8000).

## Edit the gallery

All video data lives in `videos.json`. Each entry:

```json
{ "url": "https://...mp4", "category": "UGC" }
```

- **Add a video** — append a new object to the array.
- **Re-tag** — change `"category"` (e.g. `"UGC"`, `"Unboxing"`, `"Hyper Motion"`, `"TV Spot"`, `"Virtual Try On"`, `"Tutorial"`, `"Pro Virtual Try On"`).
- **Reorder** — they shuffle on each load; remove the `shuffle()` call in `script.js` if you want a fixed order.

No code changes needed — just edit the JSON.

## Edit copy / brand

- Hero headline, sub, CTA: `index.html` → `.hero` block.
- Brand name + contact email: search-replace `Hexa AI` and `hello@hexaaiagency.com`.
- Colors: top of `styles.css` → `:root` variables (`--accent`, `--crimson`, etc.).

## Deploy

- **Netlify Drop** — drag the folder onto https://app.netlify.com/drop
- **Vercel** — `npx vercel` from this directory
- **GitHub Pages** — push to a repo, enable Pages on the main branch

## Notes

- Hover-to-play on desktop, tap-to-play on mobile.
- Videos preload only when near viewport — keeps the page light with many tiles.
- Respects `prefers-reduced-motion`.

# maple-videos UI

Plain HTML + vanilla JS, no framework and no bundler. Every page shares [style.css](../public/style.css) and talks to the server only through the JSON API documented in [endpoints.md](endpoints.md) — none of this is server-rendered beyond the homepage's video list.

| Page | File | Script | Purpose |
| --- | --- | --- | --- |
| `/` | [index.html](../public/index.html) | [js/index.js](../public/js/index.js) | Homepage: lists finished videos |
| `/upload` | [upload.html](../public/upload.html) | [js/upload.js](../public/js/upload.js) | Upload form with upload + processing progress |
| `/watch/:id` | [watch.html](../public/watch.html) | [js/watch.js](../public/js/watch.js) | Player page for one video |

All three share the same `<header>` (logo linking to `/`, nav link to the upload page) and are styled by [style.css](../public/style.css), which also sets up light/dark colors via `prefers-color-scheme`.

---

## Homepage (`/`)

[index.html](../public/index.html) ships an empty `<ul id="list">` and a `<p id="status">Loading...</p>`; [js/index.js](../public/js/index.js) fills them in:

1. `GET /api/videos`, then filters to `status === 'ready'` (videos still processing or failed are not shown).
2. If there are none, `#status` becomes "No videos yet."; on fetch failure it becomes "Could not load videos."
3. Otherwise, for each video it builds one `<li>` containing:
   - a thumbnail `<img class="thumb">` (lazy-loaded; left as an empty grey box via CSS if `video.thumbnail` is `null`)
   - the title (set via `textContent`, not HTML, so a title can't inject markup)
   - both wrapped in an `<a href="/watch/:id">`
   - a duration `<span class="muted">`, formatted `h:mm:ss` / `m:ss` by a local `formatDuration` helper

No polling here — the list is fetched once on page load.

---

## Upload page (`/upload`)

[upload.html](../public/upload.html) is a form with a file input (`accept="video/*"`), an optional title (`maxlength="100"`, matching the server's `MAX_TITLE`), an optional description `<textarea>`, a submit button, two `<progress>` bars (upload / processing), and a status line. [js/upload.js](../public/js/upload.js) drives it in two phases:

**1. Upload phase** — on submit, it builds a `FormData` with `file`, `title`, `description` and POSTs it to `/api/upload` via `XMLHttpRequest` (not `fetch`, specifically so it gets `xhr.upload.onprogress` events for a real upload progress bar — `fetch` can't report upload progress). The submit button is disabled while this runs.

- `onprogress`: updates the upload `<progress>` bar from `e.loaded / e.total`; once it hits 100% the status line switches to "Verifying video..." (ffprobe validation happens server-side before the response comes back).
- `onload` with a non-200 status: shows the server's error text (e.g. "File is too large...", "Unsupported video format") and re-enables the button.
- `onload` with 200: parses `{ id, status }` from the response and starts polling.
- `onerror`: network failure — shows "Upload failed. Check your connection." and re-enables the button.

**2. Processing phase** (`poll(id)`) — polls `GET /api/videos/:id` every 1s:

- `status === 'ready'`: sets the processing bar to 100% and redirects to `/watch/:id`.
- `status === 'failed'`: shows "Processing failed." and re-enables the button.
- otherwise: updates the processing bar from `video.progress` (0-99 while transcoding) and polls again in 1s.
- on a fetch error (network hiccup), it just retries in 2s rather than giving up.

---

## Watch page (`/watch/:id`)

[watch.html](../public/watch.html) is mostly empty placeholders (`#title`, `#status`, a hidden `<video id="player">`, `#meta`, `#description`) plus an [hls.js](https://github.com/video-dev/hls.js) `<script>` tag from jsdelivr. The server always returns this same static page for any `:id` — [js/watch.js](../public/js/watch.js) reads the id from the URL path and does the real work:

1. `GET /api/videos/:id`.
   - Not OK: `#title` becomes "Video not found" (404) or "Invalid video" (400, bad UUID).
   - OK: fills in title (as `document.title` too), description, and `#meta` (duration + upload date, via the same `formatDuration` helper as the homepage) — all via `textContent` so a title/description can never inject markup.
2. Branches on `video.status`:
   - `'ready'`: clears `#status`, sets the `<video>` poster to `video.thumbnail` if present, and calls `play(video)`.
   - `'failed'`: `#status` becomes "Something went wrong while processing this video."
   - otherwise (processing): `#status` becomes `"Processing... N%"` from `video.progress`, and it polls again in 2s.
3. `play(video)` picks the playlist based on `video.qualities`: multi-quality videos use `/videos/:id/master.m3u8`; older, pre-multi-quality uploads (no `qualities` field) fall back to `/videos/:id/index.m3u8`. If `Hls.isSupported()` it loads the source via hls.js; otherwise (Safari) it sets `player.src` directly, since Safari plays HLS natively.

---

## Styling ([style.css](../public/style.css))

A single stylesheet. Notable pieces:

- CSS variables for colors (`--bg`, `--text`, `--muted`, `--border`, `--accent`), redefined under `@media (prefers-color-scheme: dark)` for automatic dark mode.
- `.video-list` / `.thumb` for the homepage grid-like list (fixed 160px-wide thumbnails, 16:9, grey box fallback).
- Form styles (`form`, `label`, `input`/`textarea`/`button`, `button:disabled`) shared by the upload page.
- `.progress-group` / `progress` for the two upload-page progress bars.
- `video` is forced to `width: 100%` with a black background for the watch page.

## Known rough edges

- `upload.html` and `index.html`'s nav links point to `/upload.html` rather than the real `/upload` route — harmless since static serving still resolves `upload.html`, but inconsistent with the route the server actually registers (`app.get('/upload', ...)`).
- `watch.js`'s `master.m3u8` vs `index.m3u8` fallback exists only to support videos transcoded before multi-quality HLS was added — new uploads always get `qualities` and `master.m3u8`.

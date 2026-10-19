# maple-videos Endpoints

All examples assume the server is running locally on port 3000:

```bash
bun dev
```

Tip: pipe JSON responses through [`jq`](https://jqlang.github.io/jq/) for readable output, for example `curl -s <url> | jq`.

## Overview

| Method | Route | Type | Description |
| --- | --- | --- | --- |
| `GET` | `/health` | API | Check that the server is running |
| `POST` | `/api/upload` | API | Upload a video |
| `GET` | `/api/videos` | API | List all videos with metadata |
| `GET` | `/api/videos/:id` | API | Get one video's metadata and status |
| `GET` | `/` | Page | Homepage listing finished videos |
| `GET` | `/upload` | Page | Upload form |
| `GET` | `/watch/:id` | Page | Player page for one video |
| `GET` | `/videos/:id/master.m3u8` | Static | HLS master playlist (multi-quality videos) |
| `GET` | `/videos/:id/index.m3u8` | Static | HLS playlist (older, single-quality videos only) |
| `GET` | `/videos/:id/<height>p/index.m3u8` | Static | Per-quality HLS playlist, e.g. `720p/index.m3u8` |
| `GET` | `/videos/:id/<height>p/seg_XXX.ts` | Static | HLS video segments for one quality |
| `GET` | `/videos/:id/thumbnail.jpg` | Static | Thumbnail image for a video |

---

## `GET /health`

Returns a simple response to confirm the server is up.

**Test:**

```bash
curl http://localhost:3000/health
```

**Response:**

```json
{ "ok": true }
```

---

## `POST /api/upload`

Uploads a video, validates it, saves its metadata, and starts transcoding to HLS in the background. The response comes back right away while transcoding continues.

**Form fields (multipart):**

| Field | Required | Description |
| --- | --- | --- |
| `file` | Yes | The video file |
| `title` | No | Video title, up to 100 characters. Defaults to the file name without its extension |
| `description` | No | Video description, up to `MAX_DESCRIPTION` characters |

**Supported formats:** MP4, MOV, WebM, MKV

**Test (file only):**

```bash
curl -F "file=@$HOME/Downloads/test.mp4;type=video/mp4" \
     http://localhost:3000/api/upload
```

**Test (with title and description):**

```bash
curl -F "file=@$HOME/Downloads/test.mp4;type=video/mp4" \
     -F "title=My first video" \
     -F "description=Testing maple-videos" \
     http://localhost:3000/api/upload
```

Behind the scenes, `ffprobe` picks the video's resolution, which determines the quality ladder used for transcoding (`pickRenditions`): videos are transcoded down to every rung at or below their own height, from 1080p, 720p, 480p, down to 360p (tiny videos still get at least 360p). A thumbnail is also grabbed around 10% into the video (capped at 30s).

**Success response (`200`):**

```json
{ "id": "1c2f3542-271a-4901-b463-21e7c16fac05", "status": "processing" }
```

**Error responses:**

| Status | Meaning |
| --- | --- |
| `400` | No file sent, title or description too long, or the file is not a valid video |
| `413` | File is larger than `MAX_UPLOAD_SIZE` |
| `415` | Unsupported format |

**Test the error cases:**

```bash
# 400: no file
curl -X POST http://localhost:3000/api/upload

# 400: fake video (text file renamed to .mp4)
echo "not a video" > fake.mp4
curl -F "file=@fake.mp4;type=video/mp4" http://localhost:3000/api/upload

# 415: unsupported format
echo "hello" > notes.txt
curl -F "file=@notes.txt;type=text/plain" http://localhost:3000/api/upload
```

Note: the `;type=video/mp4` part tells curl which MIME type to send. Browsers set this automatically.

---

## `GET /api/videos`

Returns metadata for every video (any status), newest first.

**Test:**

```bash
curl http://localhost:3000/api/videos
```

**Response:**

```json
[
  {
    "id": "1c2f3542-271a-4901-b463-21e7c16fac05",
    "title": "My first video",
    "description": "Testing maple-videos",
    "originalName": "test.mp4",
    "size": 48213504,
    "duration": 12.4,
    "thumbnail": "/videos/1c2f3542-271a-4901-b463-21e7c16fac05/thumbnail.jpg",
    "width": 1920,
    "height": 1080,
    "status": "ready",
    "createdAt": "2026-10-18T17:20:00.000Z",
    "hasAudio": true,
    "qualities": ["1080p", "720p", "480p", "360p"]
  }
]
```

---

## `GET /api/videos/:id`

Returns one video's metadata plus a live `progress` field. Also works as the status check while a video is transcoding.

**Status values:**

| Status | Meaning |
| --- | --- |
| `Processing` | Uploaded and transcoding |
| `ready` | Transcoding finished, video can be played |
| `failed` | Transcoding failed |

**Test:**

```bash
curl http://localhost:3000/api/videos/<id>
```

**Response:** same shape as one item from `GET /api/videos`, plus a `progress` field (0-100, estimated from `ffmpeg`'s progress output; always `100` once `status` is `ready`). `progress` is tracked in memory only, so it resets to `0` if the server restarts mid-transcode — the final `status` in `meta.json` is unaffected.

**Error responses:**

| Status | Meaning |
| --- | --- |
| `400` | ID is not a valid UUID |
| `404` | No video with that ID |

**Watch the status change during transcoding:**

```bash
watch -n 1 "curl -s http://localhost:3000/api/videos/<id>"
```

(On macOS, install `watch` with `brew install watch`, or just rerun the curl command.)

---

## `GET /`

HTML homepage listing all videos with status `ready`, showing each title and duration, newest first.

**Test:** open [http://localhost:3000](http://localhost:3000) in a browser, or:

```bash
curl http://localhost:3000/
```

---

## `GET /upload`

Serves the upload form page (`public/upload.html`), always `200` regardless of path params. See [public.md](public.md) for what the page does.

**Test:** open `http://localhost:3000/upload` in a browser.

---

## `GET /watch/:id`

Always serves the player page (`public/watch.html`) with `200`, for any `:id` — the page itself does the real work client-side by calling `GET /api/videos/:id` and rendering based on the result:

- Invalid ID or video not found: shows "Video not found" / "Invalid video"
- Still transcoding: shows a "Processing... N%" message and polls every 2s
- Failed: shows an error message
- Ready: plays the video (via `master.m3u8`, falling back to `index.m3u8` for older single-quality uploads) and sets the poster to the thumbnail, if any

**Test:** open `http://localhost:3000/watch/<id>` in a browser.

---

## `GET /videos/:id/master.m3u8` and segments

Static HLS files served straight from the `videos/` folder. Each video directory contains:

```
videos/<id>/
  original          # the uploaded file
  meta.json
  thumbnail.jpg
  master.m3u8        # master playlist, references each quality folder
  1080p/index.m3u8
  1080p/seg_000.ts, seg_001.ts, ...
  720p/index.m3u8
  720p/seg_000.ts, ...
  480p/...
  360p/...
```

(Only the qualities at or below the source video's own resolution are generated — see `qualities` in the metadata. Videos transcoded by older versions of the app may instead have a single `index.m3u8` + `seg_XXX.ts` directly in the video's directory, with no `master.m3u8`.)

**Test (check the master playlist):**

```bash
curl http://localhost:3000/videos/<id>/master.m3u8
```

**Test (play it in an external player):**

```bash
mpv http://localhost:3000/videos/<id>/master.m3u8
vlc http://localhost:3000/videos/<id>/master.m3u8
```

Browsers other than Safari will download the `.m3u8` file instead of playing it. Use `/watch/:id` to play it in the browser.

---

## Full Test Flow

```bash
# 1. Server is up
curl http://localhost:3000/health

# 2. Upload a video and note the id
curl -F "file=@$HOME/Downloads/test.mp4;type=video/mp4" \
     -F "title=My first video" \
     http://localhost:3000/api/upload

# 3. Check status until it says "ready"
curl http://localhost:3000/api/videos/<id>

# 4. Watch it
open http://localhost:3000/watch/<id>
```

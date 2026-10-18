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
| `GET` | `/watch/:id` | Page | Player page for one video |
| `GET` | `/videos/:id/index.m3u8` | Static | HLS playlist for a video |
| `GET` | `/videos/:id/seg_XXX.ts` | Static | HLS video segments |

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
    "width": 1920,
    "height": 1080,
    "status": "ready",
    "createdAt": "2026-10-18T17:20:00.000Z"
  }
]
```

---

## `GET /api/videos/:id`

Returns one video's metadata. Also works as the status check while a video is transcoding.

**Status values:**

| Status | Meaning |
| --- | --- |
| `processing` | Uploaded and transcoding |
| `ready` | Transcoding finished, video can be played |
| `failed` | Transcoding failed |

**Test:**

```bash
curl http://localhost:3000/api/videos/<id>
```

**Response:** same shape as one item from `GET /api/videos`.

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

## `GET /watch/:id`

HTML player page for one video, showing the title, player, and description.

- If the video is still transcoding, it shows a "still processing" message
- If transcoding failed, it shows an error message

**Test:** open `http://localhost:3000/watch/<id>` in a browser.

**Error responses:**

| Status | Meaning |
| --- | --- |
| `400` | ID is not a valid UUID |
| `404` | No video with that ID |

---

## `GET /videos/:id/index.m3u8` and segments

Static HLS files served straight from the `videos/` folder. The playlist points to the `seg_XXX.ts` segment files.

**Test (check the playlist):**

```bash
curl http://localhost:3000/videos/<id>/index.m3u8
```

**Test (play it in an external player):**

```bash
mpv http://localhost:3000/videos/<id>/index.m3u8
vlc http://localhost:3000/videos/<id>/index.m3u8
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

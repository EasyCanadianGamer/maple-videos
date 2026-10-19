# maple-videos 

A lightweight, open source, self-hosted video platform. Upload your videos, and maple-videos transcodes them to HLS and serves them with a built-in player, so you can put videos on your own website without YouTube, Vimeo, or any corporate platform.

> **Status:** Early development. The core upload, transcode, and playback pipeline works. Expect breaking changes.


## Showcase

https://github.com/user-attachments/assets/cd86f118-c457-4c5a-b5b5-399ab3e3dec9




## Features

- **Uploads** with size limits and format checks
- **Real video validation** using `ffprobe`, so renamed or fake files are rejected and cleaned up
- **Background transcoding** to HLS with FFmpeg, so uploads return immediately
- **Built-in player** powered by [hls.js](https://github.com/video-dev/hls.js), with native HLS on Safari
- **Video list** on the homepage showing every finished video
- **No tracking, no accounts, no third parties.** Your videos stay on your server.

## Requirements

- [Bun](https://bun.sh)
- [FFmpeg](https://ffmpeg.org) (includes `ffprobe`), available on your `PATH`

Check that FFmpeg is installed:

```bash
ffmpeg -version
```

## Dependencies

| Package | Version | Purpose |
| --- | --- | --- |
| [hono](https://hono.dev) | ^4.13.13 | Web framework for the API and pages |
| [@hono/node-server](https://github.com/honojs/node-server) | ^2.1.5 | Adapter for running on Node.js (planned) |

## Getting Started

```bash
git clone https://github.com/EasyCanadianGamer/maple-videos.git
cd maple-videos
bun install
bun src/bun.ts
```

Then open [http://localhost:3000](http://localhost:3000).

Run the server from the project root, since videos are stored in `./videos` relative to where it starts.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `MAX_UPLOAD_SIZE` | `1073741824` (1 GB) | Maximum upload size in bytes |

Example:

```bash
MAX_UPLOAD_SIZE=5368709120 bun src/bun.ts   # 5 GB
```

Bun also has its own request size limit (128 MB by default). Raise `maxRequestBodySize` in `src/bun.ts` to match `MAX_UPLOAD_SIZE`.

**Note:** uploads are currently read into memory, so very large limits need a matching amount of RAM. Streaming uploads are on the roadmap.

## Usage

### Upload a video

From the terminal:

```bash
curl -F "file=@/path/to/video.mp4;type=video/mp4" http://localhost:3000/api/upload
```

The response contains the new video's ID:

```json
{ "id": "3f2a1c9e-..." }
```

Transcoding runs in the background. The server logs `<id> ready` when it finishes.

### Watch a video

- **Homepage:** `http://localhost:3000` lists all finished videos
- **Player:** `http://localhost:3000/watch/<id>`
- **Raw HLS playlist:** `http://localhost:3000/videos/<id>/index.m3u8` (works in mpv, VLC, and other HLS players)

## API

| Method | Route | Description |
| --- | --- | --- |
| `POST` | `/api/upload` | Upload a video (multipart form, field name `file`) |
| `GET` | `/` | List of finished videos |
| `GET` | `/watch/:id` | Player page for a video |
| `GET` | `/videos/:id/index.m3u8` | HLS playlist and segments |

### Upload responses

| Status | Meaning |
| --- | --- |
| `200` | Upload accepted, returns `{ id }` |
| `400` | No file sent, or the file is not a valid video |
| `413` | File is larger than `MAX_UPLOAD_SIZE` |
| `415` | Unsupported format |

### Supported formats

MP4, MOV (QuickTime), WebM, and MKV (Matroska).

## Project Structure

```
maple-videos/
├── public/
│   ├── index.html   # /home
│   ├── upload.html  # /upload
│   └── watch.html   # /watch
│   └── style.css    # style sheet
│   └── js/
│     ├── index.js   
│     └── upload.ts 
│     └── watch.ts 
├── src/
│   ├── app.ts      # Routes and app logic
│   ├── bun.ts      # Bun entry point
│   └── node.ts     # Node.js entry point (planned)
├── videos/         # Uploaded and transcoded videos (gitignored)
│   └── <id>/
│       ├── original
│       ├── index.m3u8
│       └── seg_000.ts ...
└── package.json
```

## Roadmap

- [x] Video metadata (titles, descriptions)
- [x] Status endpoint (`processing` / `ready` / `failed`)
- [x] Upload progress bar and transcoding progress
- [x] Web UI
- [x] Thumbnails
- [x] Multiple quality levels (adaptive bitrate)
- [ ] Embeddable player for other websites
- [ ] CLI with admin access and terminal playback through mpv and VLC
- [ ] Streaming and resumable uploads for large files
- [ ] Node.js support
- [ ] Docker image

## License

   [AGPL-3.0](LICENSE)

import { Hono } from 'hono'
import {serveStatic} from '@hono/bun'
import { rm, readdir } from 'node:fs/promises'



const app = new Hono()
const MAX_SIZE = Number(process.env.MAX_UPLOAD_SIZE ?? 1024 * 1024 * 1024) // 1 GB default
const ALLOWED = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska']
const MAX_TITLE = 100
const MAX_DESCRIPTION = 50000
const UUID_RE = /^[0-9a-f-]{36}$/

// meta data
type Status = 'Processing' | 'ready' | 'failed'

// Quality ladder: [height, video bitrate in kbps]
const LADDER: [number, number][] = [
  [1080, 5000],
  [720, 2800],
  [480, 1400],
  [360, 800],
]

//size in bytes
//createdAt is the ISO date
//duration is in seconds
type VideoMeta = {
  id:string
  title:string
  description:string
  originalName:string
  size:number
  duration: number | null
  thumbnail: string | null
  width: number | null
  height: number | null
  status: Status
  createdAt: string 
  hasAudio: boolean
  qualities: string[]
}

type ProbeResult = {
  streams?: { codec_type?: string; width?: number; height?: number }[]
  format?: { duration?: string }
}

const metaPath = (id: string) => `videos/${id}/meta.json`


// helpers


function pickRenditions(width: number | null, height: number | null) {
  const shortSide = Math.min(width ?? 0, height ?? 0) || 360
  const picked = LADDER.filter(([h]) => h <= shortSide)
  return picked.length ? picked : [LADDER[LADDER.length - 1]] // tiny videos still get 360p
}   
//thumbnails
// Grabs a frame 10% into the video, which skips black intro frames
async function generateThumbnail(dir: string, duration: number | null): Promise<boolean> {
  const seek = duration ? Math.min(duration * 0.1, 30) : 0

  const proc = Bun.spawn([
    'ffmpeg', '-nostdin', '-loglevel', 'error',
    '-ss', seek.toFixed(2),
    '-i', `${dir}/original`,
    '-frames:v', '1',
    '-vf', 'scale=640:-2',
    '-q:v', '3',
    '-y', // overwrite if it already exists
    `${dir}/thumbnail.jpg`,
  ])

  return (await proc.exited) === 0
}

async function readMeta(id: string): Promise<VideoMeta | null> {
  const file = Bun.file(metaPath(id))
  if (!(await file.exists())) return null
  try {
    return (await file.json()) as VideoMeta
  } catch {
    return null
  }
}
 
async function writeMeta(meta: VideoMeta) {
  await Bun.write(metaPath(meta.id), JSON.stringify(meta, null, 2))
}
 
async function listVideos(): Promise<VideoMeta[]> {
  const entries = await readdir('videos', { withFileTypes: true }).catch(() => [])
  const metas = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && UUID_RE.test(e.name))
      .map((e) => readMeta(e.name))
  )
  return metas
    .filter((m): m is VideoMeta => m !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) // newest first
}

 const progress = new Map<string, number>()
async function trackProgress(id: string, stream: ReadableStream<Uint8Array>, duration: number | null) {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? '' // keep any half-finished line for the next chunk

    for (const line of lines) {
      const [key, value] = line.trim().split('=')
      if (key === 'out_time_us' && duration) {
        const microseconds = Number(value) // can be "N/A" at the start, which becomes NaN
        if (Number.isFinite(microseconds)) {
          const percent = Math.floor((microseconds / (duration * 1_000_000)) * 100)
          progress.set(id, Math.min(99, Math.max(0, percent))) // 100 only once it's actually done
        }
      }
    }
  }
}

// Builds the ffmpeg command for multi-quality HLS
function buildFfmpegArgs(meta: VideoMeta) {
  const dir = `videos/${meta.id}`
  const renditions = pickRenditions(meta.width, meta.height)
  const portrait = (meta.height ?? 0) > (meta.width ?? 0)
  const n = renditions.length

  // split the video into n copies and scale each one
  const scales = renditions
    .map(([h], i) => `[v${i}]scale=${portrait ? `${h}:-2` : `-2:${h}`}[o${i}]`)
    .join(';')
  const filter = `[0:v]split=${n}${renditions.map((_, i) => `[v${i}]`).join('')};${scales}`

  const args = ['ffmpeg', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats',
    '-i', `${dir}/original`, '-filter_complex', filter]

  // map each scaled video (plus audio if there is any)
  renditions.forEach((_, i) => {
    args.push('-map', `[o${i}]`)
    if (meta.hasAudio) args.push('-map', '0:a:0')
  })

  // video settings, with keyframes every 6s so every quality switches cleanly on segment boundaries
  args.push('-c:v', 'libx264', '-preset', 'veryfast',
    '-force_key_frames', 'expr:gte(t,n_forced*6)', '-sc_threshold', '0')

  renditions.forEach(([, kbps], i) => {
    args.push(`-b:v:${i}`, `${kbps}k`,
      `-maxrate:v:${i}`, `${Math.round(kbps * 1.07)}k`,
      `-bufsize:v:${i}`, `${Math.round(kbps * 1.5)}k`)
  })

  if (meta.hasAudio) args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2')

  // tells ffmpeg which video and audio belong to which quality folder
  const streamMap = renditions
    .map(([h], i) => (meta.hasAudio ? `v:${i},a:${i},name:${h}p` : `v:${i},name:${h}p`))
    .join(' ')

  args.push('-f', 'hls', '-hls_time', '6', '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments',
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', streamMap,
    '-hls_segment_filename', `${dir}/%v/seg_%03d.ts`,
    `${dir}/%v/index.m3u8`)

  return args
}

// Runs the transcode in the background and updates status when it finishes
function startTranscode(meta: VideoMeta) {
  const { id } = meta
  progress.set(id, 0)

  const ffmpeg = Bun.spawn(buildFfmpegArgs(meta), { stdout: 'pipe' })
  trackProgress(id, ffmpeg.stdout, meta.duration)

  ffmpeg.exited.then(async (code) => {
    progress.delete(id)
    const current = await readMeta(id)
    if (current) {
      current.status = code === 0 ? 'ready' : 'failed'
      await writeMeta(current)
    }
    console.log(code === 0 ? `${id} ready` : `${id} failed`)
  })
}

// Deletes half-written HLS files from an interrupted transcode
async function clearPartialOutput(dir: string) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter((e) =>
        (e.isDirectory() && /^\d+p$/.test(e.name)) || // quality folders
        e.name === 'master.m3u8' || e.name === 'index.m3u8' || e.name.startsWith('seg_')
      )
      .map((e) => rm(`${dir}/${e.name}`, { recursive: true, force: true }))
  )
}

// Restarts any transcodes that were cut off by a server restart
export async function recoverStuckVideos() {
  // with bun --hot, the module re-runs on every save, so only do this once per process
  const g = globalThis as { __mapleRecovered?: boolean }
  if (g.__mapleRecovered) return
  g.__mapleRecovered = true

  const stuck = (await listVideos()).filter((v) => v.status === 'Processing')

  for (const meta of stuck) {
    const dir = `videos/${meta.id}`
    if (await Bun.file(`${dir}/original`).exists()) {
      await clearPartialOutput(dir)
      console.log(`${meta.id} resuming transcode`)
      startTranscode(meta)
    } else {
      meta.status = 'failed'
      await writeMeta(meta)
      console.log(`${meta.id} marked failed (original file missing)`)
    }
  }
}


function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
 
function formatDuration(seconds: number | null) {
  if (seconds === null) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60).toString().padStart(2, '0')
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`
}

app.use('/videos/*', serveStatic({ root: './' }))
app.use('/*', serveStatic({ root: './public' }))


app.post('/api/upload', async (c) => {
  const body = await c.req.parseBody()
  const file = body['file']

  // file is sent
  if (!(file instanceof File)) {
    return c.text('A file is required', 400)
  }

  // how big is it
  if (file.size > MAX_SIZE) {
    return c.text(`File is too large. Please stay below ${MAX_SIZE / 1024 ** 3} GB`, 413)
  }

  // is it an mp4, etc
  if (!ALLOWED.includes(file.type)) {
    return c.text('Unsupported video format', 415)
  }

    // title and description (title falls back to the file name)
  const rawTitle = typeof body['title'] === 'string' ? body['title'].trim() : ''
  const description = typeof body['description'] === 'string' ? body['description'].trim() : ''
  const title = rawTitle || file.name.replace(/\.[^.]+$/, '') || 'Untitled'
 
  if (title.length > MAX_TITLE) {
    return c.text(`Title must be ${MAX_TITLE} characters or less`, 400)
  }
  if (description.length > MAX_DESCRIPTION) {
    return c.text(`Description must be ${MAX_DESCRIPTION} characters or less`, 400)
  }

  // save it
  const id = crypto.randomUUID()
  const dir = `videos/${id}`
  const path = `${dir}/original`
  await Bun.write(path, file)

  // verify with ffprobe
    const proc = Bun.spawn(
    [
      'ffprobe', '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type,width,height',
      '-of', 'json',
      path,
    ],
    { stdout: 'pipe' }
  )
  const output = await new Response(proc.stdout).text()
  const exitCode = await proc.exited



  let info: ProbeResult | null = null
  if (exitCode === 0) {
    try {
      info = JSON.parse(output) as ProbeResult
    } catch {
      info = null
    }
  }


  const videoStream = info?.streams?.find((s) => s.codec_type === 'video')
  if (!videoStream) {
    await rm(dir, { recursive: true, force: true })
    return c.text('File is not a valid video', 400)
  }
  const hasAudio = info?.streams?.some((s) => s.codec_type === 'audio') ?? false
 
  const duration = Number(info?.format?.duration)
  const safeDuration = Number.isFinite(duration) ? duration : null
  const hasThumb = await generateThumbnail(dir, safeDuration)
  // write metadata
  const meta: VideoMeta = {
    id,
    title,
    description,
    originalName: file.name,
    size: file.size,
    duration: Number.isFinite(duration) ? duration : null,
    thumbnail: hasThumb ? `/videos/${id}/thumbnail.jpg` : null,
    width: videoStream.width ?? null,
    height: videoStream.height ?? null,
    status: 'Processing',
    createdAt: new Date().toISOString(),
    hasAudio,
    qualities: pickRenditions(videoStream.width ?? null, videoStream.height ?? null).map(([h]) => `${h}p`),
  }
  await writeMeta(meta)
  startTranscode(meta)
  return c.json({ id, status: 'processing' })
})

 
// list all videos
app.get('/api/videos', async (c) => {
  return c.json(await listVideos())
})
 
// one video's metadata (also works as the status check)
app.get('/api/videos/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return c.json({ error: 'Invalid video ID' }, 400)
  }
  const meta = await readMeta(id)
  if (!meta) {
    return c.json({ error: 'Video not found' }, 404)
  }
  return c.json({
    ...meta,
    progress: meta.status === 'ready' ? 100 : progress.get(id) ?? 0,
  }) 
})
 app.get('/upload', serveStatic({ path: './public/upload.html' }))

app.get('/', async (c) => {
  const ready = (await listVideos()).filter((v) => v.status === 'ready')
 
  const items = ready
    .map(
      (v) => `
        <li>
          <a href="/watch/${v.id}">${escapeHtml(v.title)}</a>
          <small>${formatDuration(v.duration)}</small>
        </li>`
    )
    .join('')
 
  return c.html(`
    <h1>maple-videos</h1>
    <p><a href="/upload">Upload a video</a></p>
    ${ready.length ? `<ul>${items}</ul>` : '<p>No videos yet.</p>'}
  `)
})
 
app.get('/watch/:id', serveStatic({ path: './public/watch.html' }))



app.get('/health',(c) => c.json({ok:true}))
export default app

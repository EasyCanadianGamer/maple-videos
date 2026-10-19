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
  width: number | null
  height: number | null
  status: Status
  createdAt: string 
}

type ProbeResult = {
  streams?: { codec_type?: string; width?: number; height?: number }[]
  format?: { duration?: string }
}

const metaPath = (id: string) => `videos/${id}/meta.json`

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

function startTranscode(meta: VideoMeta) {
  const { id } = meta
  const dir = `videos/${id}`
  const path = `${dir}/original`

  progress.set(id, 0)

  const ffmpeg = Bun.spawn(
    [
      'ffmpeg', '-nostdin', '-loglevel', 'error',
      '-progress', 'pipe:1', '-nostats',
      '-i', path,
      '-c:v', 'libx264', '-c:a', 'aac',
      '-hls_time', '6', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', `${dir}/seg_%03d.ts`,
      `${dir}/index.m3u8`,
    ],
    { stdout: 'pipe' }
  )

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
  const files = await readdir(dir).catch(() => [])
  await Promise.all(
    files
      .filter((f) => f === 'index.m3u8' || f.startsWith('seg_'))
      .map((f) => rm(`${dir}/${f}`, { force: true }))
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
 
  const duration = Number(info?.format?.duration)
 
  // write metadata
  const meta: VideoMeta = {
    id,
    title,
    description,
    originalName: file.name,
    size: file.size,
    duration: Number.isFinite(duration) ? duration : null,
    width: videoStream.width ?? null,
    height: videoStream.height ?? null,
    status: 'Processing',
    createdAt: new Date().toISOString(),
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

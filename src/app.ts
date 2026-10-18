import { Hono } from 'hono'
import {serveStatic} from 'hono/bun'
import { rm } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'



const app = new Hono()
const MAX_SIZE = Number(process.env.MAX_UPLOAD_SIZE ?? 1024 * 1024 * 1024) // 1 GB default
const ALLOWED = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska']

app.use('/videos/*', serveStatic({root: './'}))

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

  // save it
  const id = crypto.randomUUID()
  const dir = `videos/${id}`
  const path = `${dir}/original`
  await Bun.write(path, file)

  // verify with ffprobe
  const proc = Bun.spawn(
    ['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', path],
    { stdout: 'pipe' }
  )
  const output = await new Response(proc.stdout).text()
  const exitCode = await proc.exited

  let hasVideo = false
  if (exitCode === 0) {
    try {
      const info = JSON.parse(output)
      hasVideo = info.streams?.some((s: { codec_type: string }) => s.codec_type === 'video') ?? false
    } catch {
      hasVideo = false
    }
  }

  if (!hasVideo) {
    await rm(dir, { recursive: true, force: true })
    return c.text('File is not a valid video', 400)
  }

  const ffmpeg = Bun.spawn([
  'ffmpeg', '-i', `${dir}/original`,
  '-c:v', 'libx264', '-c:a', 'aac',
  '-hls_time', '6', '-hls_playlist_type', 'vod',
  '-hls_segment_filename', `${dir}/seg_%03d.ts`,
  `${dir}/index.m3u8`,
])

  ffmpeg.exited.then((code) => {
  console.log(code === 0 ? `${id} ready` : `${id} failed`)
})

  return c.json({ id })
})

app.get('/watch/:id', (c) => {
  const id = c.req.param('id')

  // only allow real UUIDs, so nobody can inject weird stuff into the page
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    return c.text('Invalid video ID', 400)
  }

  return c.html(`
    <video id="v" controls width="640"></video>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
    <script>
      const v = document.getElementById('v')
      const src = '/videos/${id}/index.m3u8'
      if (Hls.isSupported()) {
        const hls = new Hls(); hls.loadSource(src); hls.attachMedia(v)
      } else {
        v.src = src
      }
    </script>
  `)
})

app.get('/', async (c) => {
  const entries = await readdir('videos', { withFileTypes: true }).catch(() => [])

  const ready: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // only show videos that finished transcoding
    if (await Bun.file(`videos/${entry.name}/index.m3u8`).exists()) {
      ready.push(entry.name)
    }
  }

  const links = ready.map((id) => `<li><a href="/watch/${id}">${id}</a></li>`).join('')

  return c.html(`
    <h1>maple-videos</h1>
    ${ready.length ? `<ul>${links}</ul>` : '<p>No videos yet.</p>'}
  `)
})



app.get('/health',(c) => c.json({ok:true}))

export default app

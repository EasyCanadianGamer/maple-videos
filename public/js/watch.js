// Watch page: reads the id from /watch/<id> and plays the video

const $ = (id) => document.getElementById(id)
const id = location.pathname.split('/').pop()

function formatDuration(seconds) {
  if (seconds == null) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60).toString().padStart(2, '0')
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`
}

function play() {
  const player = $('player')
  const src = '/videos/' + id + '/index.m3u8'

  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls()
    hls.loadSource(src)
    hls.attachMedia(player)
  } else {
    player.src = src // Safari plays HLS natively
  }

  player.hidden = false
}

async function load() {
  const res = await fetch('/api/videos/' + id)

  if (!res.ok) {
    $('title').textContent = res.status === 404 ? 'Video not found' : 'Invalid video'
    return
  }

  const video = await res.json()

  // textContent keeps user input from running as HTML
  $('title').textContent = video.title
  document.title = video.title + ' | maple-videos'
  $('description').textContent = video.description

  const date = new Date(video.createdAt).toLocaleDateString()
  $('meta').textContent = [formatDuration(video.duration), date].filter(Boolean).join(' · ')

  if (video.status === 'ready') {
    $('status').textContent = ''
    play()
  } else if (video.status === 'failed') {
    $('status').textContent = 'Something went wrong while processing this video.'
  } else {
    // still processing: show progress and check again
    $('status').textContent = `Processing... ${video.progress ?? 0}%`
    setTimeout(load, 2000)
  }
}

load()

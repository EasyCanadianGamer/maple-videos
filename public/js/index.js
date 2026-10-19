// Homepage: lists every video that's finished transcoding

function formatDuration(seconds) {
  if (seconds == null) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60).toString().padStart(2, '0')
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`
}

async function load() {
  const status = document.getElementById('status')
  const list = document.getElementById('list')

  try {
    const videos = await fetch('/api/videos').then((r) => r.json())
    const ready = videos.filter((v) => v.status === 'ready')

    if (ready.length === 0) {
      status.textContent = 'No videos yet.'
      return
    }

    status.textContent = ''

    for (const video of ready) {
      const li = document.createElement('li')

      const link = document.createElement('a')
      link.href = '/watch/' + video.id
      link.textContent = video.title // textContent keeps user input from running as HTML

      const duration = document.createElement('span')
      duration.className = 'muted'
      duration.textContent = formatDuration(video.duration)

      li.append(link, duration)
      list.append(li)
    }
  } catch {
    status.textContent = 'Could not load videos.'
  }
}

load()

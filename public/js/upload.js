// Upload page: upload progress (browser) + processing progress (server)

const $ = (id) => document.getElementById(id)

function setBar(bar, label, pct) {
  $(bar).value = pct
  $(label).textContent = Math.round(pct) + '%'
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault()

  const file = $('file').files[0]
  if (!file) {
    $('status').textContent = 'Pick a video first.'
    return
  }

  const form = new FormData()
  form.append('file', file)
  form.append('title', $('title').value)
  form.append('description', $('description').value)

  $('go').disabled = true
  $('status').textContent = 'Uploading...'
  setBar('uploadBar', 'uploadPct', 0)
  setBar('processBar', 'processPct', 0)

  const xhr = new XMLHttpRequest()
  xhr.open('POST', '/api/upload')

  // 1. upload progress
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return
    const pct = (e.loaded / e.total) * 100
    setBar('uploadBar', 'uploadPct', pct)
    if (pct >= 100) $('status').textContent = 'Verifying video...'
  }

  xhr.onload = () => {
    if (xhr.status !== 200) {
      $('status').textContent = xhr.responseText || 'Upload failed.'
      $('go').disabled = false
      return
    }
    const { id } = JSON.parse(xhr.responseText)
    $('status').textContent = 'Processing...'
    poll(id)
  }

  xhr.onerror = () => {
    $('status').textContent = 'Upload failed. Check your connection.'
    $('go').disabled = false
  }

  xhr.send(form)
})

// 2. processing progress
async function poll(id) {
  try {
    const video = await fetch('/api/videos/' + id).then((r) => r.json())

    if (video.status === 'ready') {
      setBar('processBar', 'processPct', 100)
      location.href = '/watch/' + id
    } else if (video.status === 'failed') {
      $('status').textContent = 'Processing failed.'
      $('go').disabled = false
    } else {
      setBar('processBar', 'processPct', video.progress ?? 0)
      setTimeout(() => poll(id), 1000)
    }
  } catch {
    // network hiccup, try again shortly
    setTimeout(() => poll(id), 2000)
  }
}

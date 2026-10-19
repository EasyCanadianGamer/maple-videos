// src/bun.ts
import app from './app'
import { recoverStuckVideos } from './app'

recoverStuckVideos()


export default {
  port: 3000,
  fetch: app.fetch,
  maxRequestBodySize: 10 * 1024 * 1024 * 1024, // 10 GB, keep this >= MAX_UPLOAD_SIZE
}

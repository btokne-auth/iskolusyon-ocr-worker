// Iskolusyon OCR worker.
//
// GET  /health  -> "ok" (Render's health check; also a handy way to wake it)
// POST /wake    -> needs the x-ocr-worker-secret header. Replies right away,
//                  then processes every document still in 'processing'.
//
// A sweep also runs once on startup, so anything uploaded while the worker
// was asleep or down gets picked up as soon as it comes back.

require('dotenv').config()

const crypto = require('crypto')
const express = require('express')

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OCR_WORKER_SECRET']
const missing = REQUIRED_ENV.filter((name) => !process.env[name])
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}. See .env.example.`)
  process.exit(1)
}

const { runSweep } = require('./sweep')

const PORT = process.env.PORT || 3001
const SECRET = process.env.OCR_WORKER_SECRET

// Only one sweep at a time. A wake that arrives mid-sweep sets a flag so one
// more sweep runs afterward and catches the new upload.
let sweeping = false
let sweepAgain = false

async function startSweep(reason) {
  if (sweeping) {
    sweepAgain = true
    return
  }
  sweeping = true
  try {
    do {
      sweepAgain = false
      console.log(`[sweep] Starting (${reason})`)
      const count = await runSweep()
      console.log(`[sweep] Finished, ${count} document(s) processed`)
    } while (sweepAgain)
  } catch (err) {
    console.error('[sweep] Stopped with an error:', err.message)
  } finally {
    sweeping = false
  }
}

function secretMatches(provided) {
  if (typeof provided !== 'string') return false
  const a = Buffer.from(provided)
  const b = Buffer.from(SECRET)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const app = express()

app.get('/health', (req, res) => {
  res.type('text').send('ok')
})

app.post('/wake', (req, res) => {
  if (!secretMatches(req.get('x-ocr-worker-secret'))) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  res.status(202).json({ accepted: true, alreadyRunning: sweeping })
  startSweep('wake request')
})

app.listen(PORT, () => {
  console.log(`OCR worker listening on port ${PORT}`)
  startSweep('startup')
})

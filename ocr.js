// OCR pipeline, moved here from iskolusyon-backend's app/api/upload/route.js
// (Sept 2026). Same steps as before: orientation fix, preprocess, Tesseract.
//
// Differences from the Vercel version, on purpose:
// - Default (LSTM) Tesseract engine and the original 2000px resize. The
//   legacy-engine / 1200px experiment on the ocr-perf-fix branch crashed on
//   Vercel and isn't needed here: this worker has no 60-second ceiling.
// - Deskew stays OFF. It was disabled on Sept 25 after the coarser search
//   broke Princess Aragon's OCR, then accidentally switched back on by the
//   tessdata commit (39d766b). Leaving it off until it's re-tuned.
// - One Tesseract worker is created per sweep and reused for every document
//   in it, instead of one per upload, to save startup time on a slow CPU.

const path = require('path')
const sharp = require('sharp')

// Local copy of Tesseract's English model (copied from iskolusyon-backend's
// tessdata/), so nothing is downloaded per job.
const TESSDATA_PATH = path.join(__dirname, 'tessdata')

// Below this many characters of embedded PDF text, treat the PDF as a scan
// and OCR its pages instead.
const MIN_DIGITAL_TEXT_LENGTH = 40

// pdf-parse adds "-- 1 of 3 --" separators even to empty scanned PDFs; strip
// them before measuring how much real text there is.
const PDF_PAGE_SEPARATOR = /--\s*\d+\s+of\s+\d+\s*--/g

function stripPdfPageSeparators(text) {
  return text.replace(PDF_PAGE_SEPARATOR, '').trim()
}

async function createOcrWorker() {
  const { createWorker } = require('tesseract.js')
  return createWorker('eng', undefined, {
    langPath: TESSDATA_PATH,
    gzip: true,
    cacheMethod: 'none',
  })
}

// Fixes 90/180/270-degree misorientation (sideways or upside-down photos).
// Does not fix slight tilt; see the deskew note at the top of this file.
async function correctOrientation(worker, buffer) {
  try {
    const { data } = await worker.detect(buffer)
    const degrees = data?.orientation_degrees ?? 0
    const confidence = data?.orientation_confidence ?? 0

    // Only act on a confident, cardinal reading.
    if (confidence > 5 && [90, 180, 270].includes(degrees)) {
      return await sharp(buffer).rotate(360 - degrees).toBuffer()
    }
  } catch (e) {
    // Best-effort only; OCR the image as-is if detection fails.
    console.error('Orientation detection failed (non-blocking):', e.message)
  }
  return buffer
}

async function preprocessForOCR(buffer) {
  return sharp(buffer)
    .resize({ width: 2000, withoutEnlargement: false }) // upscale small/low-res photos
    .grayscale()
    .median(3) // removes camera speckle before contrast stretching
    .normalize()
    .sharpen()
    .toBuffer()
  // no .threshold(): Tesseract binarizes better on its own
}

// SINGLE_COLUMN (PSM 4) reads the page row by row. With AUTO, a form laid
// out as "LABEL:   value" columns (the birth certificate) was read as every
// label first and every value after, so auto-fill couldn't pair them.
// Tested Sept 29 on all 9 mock documents: same confidence and speed, and
// identical text on the documents that already read correctly.
async function recognize(worker, buffer) {
  const { PSM } = require('tesseract.js')
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_COLUMN })
  const { data } = await worker.recognize(buffer)
  return { text: data.text, confidence: data.confidence }
}

async function ocrImageBuffer(worker, buffer) {
  const t0 = Date.now()
  const oriented = await correctOrientation(worker, buffer)
  const t1 = Date.now()
  const cleaned = await preprocessForOCR(oriented)
  const t2 = Date.now()
  const { text, confidence } = await recognize(worker, cleaned)
  const t3 = Date.now()
  console.log(`[OCR timing] orientation=${t1 - t0}ms preprocess=${t2 - t1}ms recognize=${t3 - t2}ms total=${t3 - t0}ms`)
  return { text: text.trim(), confidence }
}

// Images go straight to OCR. PDFs use their embedded text layer if they have
// one; scanned PDFs get each page rendered to an image and OCR'd.
async function extractText(worker, buffer, mimeType) {
  if (mimeType.startsWith('image/')) {
    const { text, confidence } = await ocrImageBuffer(worker, buffer)
    return { text, method: 'ocr-image', confidence }
  }

  if (mimeType === 'application/pdf') {
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: buffer })
    try {
      const result = await parser.getText()
      const digitalText = stripPdfPageSeparators((result.text || '').trim())

      if (digitalText.length >= MIN_DIGITAL_TEXT_LENGTH) {
        return { text: digitalText, method: 'pdf-embedded-text', confidence: 100 }
      }

      const screenshot = await parser.getScreenshot({ scale: 2 })
      let ocrText = ''
      let confidenceSum = 0
      for (const page of screenshot.pages) {
        const pageResult = await ocrImageBuffer(worker, Buffer.from(page.data))
        ocrText += pageResult.text + '\n'
        confidenceSum += pageResult.confidence
      }
      return {
        text: ocrText.trim(),
        method: 'ocr-scanned-pdf',
        confidence: screenshot.pages.length ? confidenceSum / screenshot.pages.length : 0,
      }
    } finally {
      await parser.destroy()
    }
  }

  return { text: '', method: 'unsupported', confidence: 0 }
}

module.exports = { createOcrWorker, extractText }

// Finds every document the main app left in review_status = 'processing' and
// fills in its OCR results, one document at a time (the free Render instance
// only has 512 MB of RAM, so no parallel OCR).
//
// The database writes below are the same ones iskolusyon-backend's
// /api/upload after() block used to do: documents row, extracted_fields for
// auto-fill, and the audit_log entry. No schema changes.

const { createClient } = require('@supabase/supabase-js')
const { createOcrWorker, extractText } = require('./ocr')
const { extractPSAFields, extractGradesFields } = require('./textExtraction')

const BUCKET = 'scholarship-documents'

// Same thresholds as the main app.
const LOW_CONFIDENCE_THRESHOLD = 60
const MIN_OCR_TEXT_LENGTH = 3
const AUTOFILL_SCOPED_TYPES = ['birthcert', 'form138']

// How many pending rows to fetch per query. Rows are still processed one by one.
const BATCH_SIZE = 10

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

function mimeTypeFor(filePath) {
  const ext = filePath.split('.').pop().toLowerCase()
  if (ext === 'pdf') return 'application/pdf'
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  return 'application/octet-stream'
}

async function fetchPending(skipPaths) {
  const { data, error } = await supabase
    .from('documents')
    .select('file_path, document_type, applicant_name, created_at')
    .eq('review_status', 'processing')
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE + skipPaths.size)

  if (error) throw new Error(`Could not read pending documents: ${error.message}`)

  // profilepic never gets OCR (the main app saves it as verified), but skip it
  // here too in case one is ever left in 'processing'.
  return (data || []).filter(
    (row) => !skipPaths.has(row.file_path) && row.document_type !== 'profilepic'
  )
}

async function processDocument(worker, row) {
  const { file_path: filePath, document_type: documentType, applicant_name: applicantName } = row
  console.log(`[sweep] Processing ${filePath} (${documentType || 'no type'})`)

  let extractedText = ''
  let extractionMethod = 'failed'
  let extractionConfidence = 0

  try {
    const { data: blob, error: downloadError } = await supabase.storage.from(BUCKET).download(filePath)
    if (downloadError) throw new Error(`Download failed: ${downloadError.message}`)
    const buffer = Buffer.from(await blob.arrayBuffer())

    const result = await extractText(worker, buffer, mimeTypeFor(filePath))
    extractedText = result.text
    extractionMethod = result.method
    extractionConfidence = result.confidence
  } catch (err) {
    // Unlike the old Vercel code (which marked a failed OCR as 'verified' with
    // no text), a failure here is flagged so an admin sees it.
    console.error(`[sweep] OCR failed for ${filePath}:`, err.message)
  }

  const ocrFailed = extractionMethod === 'failed' || extractionMethod === 'unsupported'
  const ocrFoundNothing = extractionMethod !== 'pdf-embedded-text'
    && extractedText.trim().length < MIN_OCR_TEXT_LENGTH

  if (ocrFoundNothing) extractionConfidence = 0

  const needsReview = extractionMethod !== 'pdf-embedded-text'
    && (ocrFailed || ocrFoundNothing || extractionConfidence < LOW_CONFIDENCE_THRESHOLD)

  const { error: updateError } = await supabase
    .from('documents')
    .update({
      extracted_text: extractedText,
      ocr_confidence: extractionConfidence,
      needs_review: needsReview,
      review_status: needsReview ? 'flagged' : 'verified',
    })
    .eq('file_path', filePath)

  if (updateError) {
    console.error(`[sweep] Could not save OCR result for ${filePath}:`, updateError.message)
    return
  }

  // Auto-fill fields for the document types that support it.
  try {
    let extraction = null
    if (AUTOFILL_SCOPED_TYPES.includes(documentType) && extractedText) {
      if (documentType === 'birthcert') extraction = extractPSAFields(extractedText)
      else if (documentType === 'form138') extraction = extractGradesFields(extractedText)
    }

    if (extraction) {
      for (const [fieldName, value] of Object.entries(extraction.fields)) {
        await supabase.from('extracted_fields').upsert({
          file_path: filePath,
          document_type: documentType,
          field_name: fieldName,
          extracted_value: value,
          needs_review: extraction.needsReview,
        })
      }
    }
  } catch (err) {
    console.error(`[sweep] Auto-fill extraction failed for ${filePath} (non-blocking):`, err.message)
  }

  try {
    await supabase.from('audit_log').insert([
      {
        actor: 'System',
        action: needsReview
          ? `Document flagged for review — ${applicantName} · ${documentType} (${Math.round(extractionConfidence)}% confidence)`
          : `Document auto-verified — ${applicantName} · ${documentType} (${Math.round(extractionConfidence)}% confidence)`,
        kind: needsReview ? 'warn' : 'done',
        category: 'Documents',
      },
    ])
  } catch (err) {
    console.error('[sweep] Audit log insert failed (non-blocking):', err.message)
  }

  console.log(`[sweep] Done ${filePath}: ${needsReview ? 'flagged' : 'verified'}, ${Math.round(extractionConfidence)}% confidence, ${extractedText.length} chars`)
}

// Processes everything pending, then returns. Rows that fail to save are
// skipped for the rest of this sweep so one bad row can't loop forever.
async function runSweep() {
  const skipPaths = new Set()
  let worker = null
  let processed = 0

  try {
    while (true) {
      const pending = await fetchPending(skipPaths)
      if (pending.length === 0) break

      if (!worker) worker = await createOcrWorker()

      for (const row of pending) {
        skipPaths.add(row.file_path)
        await processDocument(worker, row)
        processed++
      }
    }
  } finally {
    if (worker) await worker.terminate()
  }

  return processed
}

module.exports = { runSweep }

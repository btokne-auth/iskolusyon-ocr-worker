// Auto-fill field extraction for the documents the applicant portal fills
// in from (Sept 29 rewrite).
//
// The OCR pass now reads pages row by row (see ocr.js, PSM SINGLE_COLUMN),
// so a "LABEL:   value" form comes out as one line per field. Instead of one
// regex per field, every "Label: value" line is collected into a lookup
// first, then each field is picked out of it by label and cleaned into the
// exact shape the portal's inputs expect (ISO dates, "Male"/"Female",
// Title Case names). Anything that can't be read cleanly is left null, and
// the portal simply leaves that input for the applicant to type.
//
// Tuned against the mock documents used for testing (generated, since no
// blank government templates are available), plus the older Sept 7 PSA
// sample text. Real documents vary; a miss only means an empty field.

const MONTHS = {
  JAN: 1, JANUARY: 1, FEB: 2, FEBRUARY: 2, MAR: 3, MARCH: 3, APR: 4, APRIL: 4,
  MAY: 5, JUN: 6, JUNE: 6, JUL: 7, JULY: 7, AUG: 8, AUGUST: 8,
  SEP: 9, SEPT: 9, SEPTEMBER: 9, OCT: 10, OCTOBER: 10, NOV: 11, NOVEMBER: 11,
  DEC: 12, DECEMBER: 12,
}

// Words that belong to the surname that follows them ("DELA CRUZ",
// "DE LOS SANTOS", "SAN JUAN", "STA. MARIA").
const SURNAME_PARTICLES = new Set(['DE', 'DEL', 'DELA', 'DELOS', 'DELAS', 'LA', 'LAS', 'LOS', 'SAN', 'STA', 'STA.', 'STO', 'STO.', 'SANTA', 'SANTO', 'VON', 'VAN', 'DI', 'DA'])
const NAME_SUFFIXES = new Set(['JR', 'JR.', 'SR', 'SR.', 'II', 'III', 'IV', 'V'])

function normalizeLabel(label) {
  return label
    .toUpperCase()
    .replace(/[’`]/g, "'")
    .replace(/'S\b/g, 'S')
    .replace(/[^A-Z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanValue(value) {
  return value
    // Noisy scans put two fields on one line ("ROMAN CATHOLIC [10 OCCUPATION:
    // TEACHER", "FILIPINO | 15. RELIGION: ..."): stop at the next field.
    .split(/\s[|\[]\s*|\s+\[?\d{1,2}\s*[.)]\s*[A-Za-z]/)[0]
    .replace(/^[\s_.:;,|-]+/, '') // leading underscores/punctuation from form lines
    .replace(/\s+/g, ' ')
    .replace(/\s+[a-z]$/, '') // a stray lowercase OCR speck at the end ("SANTOS x")
    .replace(/[\s_|]+$/, '')
    .trim()
}

// "1. NAME:   PRINCESS SANTOS ARAGON" -> { 'NAME': 'PRINCESS SANTOS ARAGON' }
// First occurrence of a label wins (the child's CITIZENSHIP comes before the
// father's on a birth certificate).
function collectLabeledLines(ocrText) {
  const map = {}
  const lines = ocrText.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:\d{1,2}\s*[.)]?\s+)?([A-Za-z][A-Za-z'’ ./()&-]{0,48}?)\s*[:;]\s*(.*)$/)
    if (!m) continue
    const label = normalizeLabel(m[1])
    if (!label) continue
    let value = cleanValue(m[2])
    // Label on its own line with the value on the next one.
    if (!value && lines[i + 1] && !/[:;]/.test(lines[i + 1])) value = cleanValue(lines[i + 1])
    if (!(label in map)) map[label] = value
  }
  return map
}

function pick(map, ...labels) {
  for (const label of labels) {
    if (map[label]) return map[label]
  }
  return null
}

// For noisy scans where the colon after a numbered label was lost
// ("1 NAME MARIA DELA CRUZ"). Only used for a few key labels.
function pickLoose(ocrText, label) {
  const re = new RegExp(`^\\W*\\d{1,2}\\s*[.)]?\\s*${label.replace(/ /g, '\\s+')}\\b[\\s:;._-]*(.+)$`, 'im')
  const m = ocrText.match(re)
  return m ? cleanValue(m[1]) || null : null
}

// One wrong letter is a common OCR slip ("MARGH" for MARCH).
function fuzzyMonth(word) {
  if (MONTHS[word]) return MONTHS[word]
  if (word.length < 4) return null
  for (const [name, num] of Object.entries(MONTHS)) {
    if (name.length !== word.length) continue
    let diff = 0
    for (let i = 0; i < name.length && diff < 2; i++) if (name[i] !== word[i]) diff++
    if (diff === 1) return num
  }
  return null
}

function titleCase(text) {
  if (!text) return null
  return text
    .toLowerCase()
    .replace(/(^|[\s,(/-])([a-zñ])/g, (_, sep, ch) => sep + ch.toUpperCase())
    .replace(/\b(Ii|Iii|Iv)\b/g, (s) => s.toUpperCase())
}

// "03 MARCH 2003", "March 3, 2003", "03/03/2003" (month first, as on PH
// forms) -> "2003-03-03". Returns null for anything that isn't a real date.
function toIsoDate(text) {
  if (!text) return null
  const t = text.toUpperCase().replace(/[,._]/g, ' ').replace(/\s+/g, ' ').trim()
  let day, month, year

  let m = t.match(/\b(\d{1,2}) ([A-Z]{3,9}) (\d{4})\b/)
  if (m && fuzzyMonth(m[2])) { day = +m[1]; month = fuzzyMonth(m[2]); year = +m[3] }

  if (!month) {
    m = t.match(/\b([A-Z]{3,9}) (\d{1,2}) (\d{4})\b/)
    if (m && fuzzyMonth(m[1])) { month = fuzzyMonth(m[1]); day = +m[2]; year = +m[3] }
  }
  if (!month) {
    m = t.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/)
    if (m) { month = +m[1]; day = +m[2]; year = +m[3] }
  }
  if (!month) {
    m = t.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/)
    if (m) { year = +m[1]; month = +m[2]; day = +m[3] }
  }
  if (!month) return null

  const d = new Date(Date.UTC(year, month - 1, day))
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null
  if (year < 1900 || year > new Date().getUTCFullYear()) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function toSex(text) {
  if (!text) return null
  const t = text.toUpperCase()
  if (/\bFEMALE\b/.test(t) || /^F\b/.test(t)) return 'Female'
  if (/\bMALE\b/.test(t) || /^M\b/.test(t)) return 'Male'
  return null
}

function takeSurname(tokens, end) {
  // Returns the start index of the surname that ends at `end` (inclusive),
  // pulling in any particles in front of it.
  let start = end
  while (start - 1 > 0 && SURNAME_PARTICLES.has(tokens[start - 1])) start--
  return start
}

// Filipino naming: First (may be two words) + Middle (mother's maiden
// surname) + Last. When the mother's name is on the same document, its
// surnames are used to find where the middle name sits; otherwise the last
// surname is Last and the one before it is Middle.
function splitFullName(fullName, motherName) {
  const result = { first_name: null, middle_name: null, last_name: null, suffix: null }
  if (!fullName) return result
  let tokens = fullName.toUpperCase().replace(/[^A-ZÑ.\s-]/g, ' ').split(/\s+/).filter(Boolean)
  if (tokens.length && NAME_SUFFIXES.has(tokens[tokens.length - 1])) {
    result.suffix = titleCase(tokens.pop()).replace(/^(Jr|Sr)$/, '$1.')
  }
  if (tokens.length < 2) return result

  const lastStart = takeSurname(tokens, tokens.length - 1)
  const last = tokens.slice(lastStart)
  let rest = tokens.slice(0, lastStart)
  if (rest.length === 0) return result

  let middle = []
  if (rest.length >= 2) {
    const motherTokens = motherName
      ? motherName.toUpperCase().replace(/[^A-ZÑ.\s-]/g, ' ').split(/\s+/).filter(Boolean).slice(1)
      : []
    const idx = rest.findIndex((tok, i) => i > 0 && motherTokens.includes(tok))
    if (idx > 0) {
      const midStart = takeSurname(rest, idx)
      middle = rest.slice(midStart, idx + 1)
      rest = rest.slice(0, midStart)
    } else {
      const midStart = takeSurname(rest, rest.length - 1)
      middle = rest.slice(midStart)
      rest = rest.slice(0, midStart)
    }
  }
  if (rest.length === 0) return result

  result.first_name = titleCase(rest.join(' '))
  result.middle_name = middle.length ? titleCase(middle.join(' ')) : null
  result.last_name = titleCase(last.join(' '))
  return result
}

function extractPSAFields(ocrText) {
  const map = collectLabeledLines(ocrText)

  const fullName = pick(map, 'NAME', 'NAME OF CHILD', 'CHILD S NAME', 'CHILDS NAME') || pickLoose(ocrText, 'NAME')
  const motherName = pick(map, 'MOTHERS NAME', 'MAIDEN NAME', 'MOTHERS MAIDEN NAME', 'MOTHER')

  // Fallbacks for older, noisier scans where several labels share a line
  // ("2 SEX MALE : 3. DATE OF BIRTH: _14 MARCH 2008").
  const dobText = pick(map, 'DATE OF BIRTH', 'BIRTH DATE', 'BIRTHDATE')
    || (ocrText.match(/DATE OF BIRTH[:\s_.-]*([0-9A-Z ,/-]{6,25})/i) || [])[1]
  const sexText = pick(map, 'SEX', 'GENDER')
    || (ocrText.match(/\bSEX\b[:\s_.-]*(FEMALE|MALE)\b/i) || [])[1]

  const fields = {
    full_name: fullName ? titleCase(fullName) : null,
    ...splitFullName(fullName, motherName),
    sex: toSex(sexText),
    date_of_birth: toIsoDate(dobText),
    place_of_birth: titleCase(pick(map, 'PLACE OF BIRTH', 'BIRTHPLACE', 'BIRTH PLACE')),
    citizenship: titleCase(pick(map, 'CITIZENSHIP', 'NATIONALITY')),
    religion: titleCase(pick(map, 'RELIGION')),
  }

  const core = ['first_name', 'last_name', 'sex', 'date_of_birth', 'place_of_birth']
  const foundCore = core.filter((k) => fields[k]).length
  return { fields, needsReview: foundCore < 4 }
}

function extractVoterFields(ocrText) {
  const map = collectLabeledLines(ocrText)

  const precinctRaw = pick(map, 'PRECINCT NO', 'PRECINCT NUMBER', 'PRECINCT')
  const precinct = precinctRaw ? precinctRaw.toUpperCase().replace(/[^0-9A-Z]/g, '') : null

  // A full "Address:" line wins. Otherwise build it from the barangay line
  // (the applicant can add the house number and street).
  let address = pick(map, 'ADDRESS', 'RESIDENCE', 'HOME ADDRESS', 'PRESENT ADDRESS')
  if (!address) {
    const barangay = pick(map, 'BARANGAY', 'BRGY')
    if (barangay) address = /^(BRGY|BARANGAY)\b/i.test(barangay) ? barangay : `Brgy. ${barangay}`
  }

  const fields = {
    full_name: titleCase(pick(map, 'NAME', 'VOTERS NAME', 'NAME OF VOTER')),
    address: address ? titleCase(address).replace(/\bBrgy\b\.?/i, 'Brgy.') : null,
    voter_precinct: precinct && /^\d{3,5}[A-Z]{0,2}$/.test(precinct) ? precinct : null,
  }

  return { fields, needsReview: !fields.address || !fields.voter_precinct }
}

function extractGradesFields(ocrText) {
  const fields = {}

  const hasKeyword = /DepEd|General Average|Learner Reference Number|LRN/i.test(ocrText)
  const avgMatch =
    ocrText.match(/General Average[\s\S]{0,120}?Semester\]?\s*(\d{2,3}(?:\.\d{1,3})?)/i) ||
    ocrText.match(/General Average[^\d]{0,20}(\d{2,3}(?:\.\d{1,3})?)/i)

  fields.general_average = avgMatch ? avgMatch[1] : null

  return { fields, needsReview: !hasKeyword || !fields.general_average }
}

module.exports = {
  extractPSAFields,
  extractVoterFields,
  extractGradesFields,
  // exported for tests
  splitFullName,
  toIsoDate,
}

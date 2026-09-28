function extractPSAFields(ocrText) {
  const fields = {};

  const nameMatch = ocrText.match(/(?<!MAIDEN\s)NAME[:\s_.-]*([A-Z][A-Z\s.,ñÑ]+?)(?:\n|SEX)/i);
  const dobMatch = ocrText.match(/DATE OF BIRTH[:\s_.-]*([0-9A-Z\s]+?)(?:\n|PLACE)/i);

  fields.full_name = nameMatch ? nameMatch[1].trim() : null;
  fields.date_of_birth = dobMatch ? dobMatch[1].trim() : null;

  // Place of Birth: don't rely on the "PLACE OF BIRTH" label surviving OCR —
  // it sometimes gets garbled or dropped entirely. Instead, anchor on the
  // DATE OF BIRTH line (reliable) and the TYPE OF BIRTH line (reliable),
  // and take whatever's between them, filtering out the instructional hint
  // line (which may itself be partially garbled).
  let pobBlock = null;
  if (dobMatch) {
    const afterDob = ocrText.slice(ocrText.indexOf(dobMatch[0]) + dobMatch[0].length);
    const endIdx = afterDob.search(/TYPE OF BIRTH/i);
    pobBlock = endIdx !== -1 ? afterDob.slice(0, endIdx) : afterDob;
  }

  if (pobBlock) {
    const lines = pobBlock.split('\n').map(l => l.trim()).filter(Boolean);
    const valueLines = lines.filter(l =>
      !/PLACE OF BIRTH/i.test(l) &&
      !/Barangay.*Province/i.test(l) &&
      !/^\(/.test(l) &&
      !/Triplet|Twin|Single/i.test(l) &&
      !/^[A-Z]?\d{5,}$/.test(l.replace(/\s/g, '')) &&
      l.length > 3
    );
    fields.place_of_birth = valueLines.length ? valueLines.join(' ').trim() : null;
  } else {
    fields.place_of_birth = null;
  }

  const foundCount = Object.values(fields).filter(Boolean).length;
  return { fields, needsReview: foundCount < 3 };
}

function extractGradesFields(ocrText) {
  const fields = {};

  const hasKeyword = /DepEd|General Average|Learner Reference Number/i.test(ocrText);
  const avgMatch =
    ocrText.match(/General Average[\s\S]{0,120}?Semester\]?\s*(\d{2,3})/i) ||
    ocrText.match(/General Average[^\d]{0,20}(\d{2,3})/i);

  fields.general_average = avgMatch ? avgMatch[1] : null;

  return { fields, needsReview: !hasKeyword || !fields.general_average };
}

module.exports = { extractPSAFields, extractGradesFields };
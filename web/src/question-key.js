// Normalized fingerprint for a question, used to detect duplicates —
// both when merging uploaded files and when drawing a simulation, so the
// same question can never appear twice even if two near-identical copies
// (e.g. an exam file and its matching solutions file) slipped past upload
// dedup with slightly different wording/whitespace.
export function questionKey(q) {
  return q.text.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
}

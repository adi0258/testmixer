// Parsing of extracted lines into multiple-choice questions.
// Supports Hebrew (א. ב. ג. ד.) and Latin (a. / A) ) option markers,
// question starts like "1.", "3)", "שאלה 2:", and correct-answer marking
// via a leading "*", a bold line, or a "תשובה נכונה: ב" line.

const QUESTION_RE = /^(?:שאלה\s*)?(\d{1,3})\s*[.):־-]\s*(.*)$/;
const OPTION_RE = /^(\*?)\s*([אבגדהוזa-fA-F])\s*[.):]\s+(.*)$/;
const ANSWER_LINE_RE =
  /^ה?תשובה(?:\s+ה?נכונה)?\s*[:\-]\s*([אבגדהוזa-fA-F])\b/;

const HEB_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז'];
const LAT_LETTERS = ['a', 'b', 'c', 'd', 'e', 'f'];

function letterIndex(letter) {
  const heb = HEB_LETTERS.indexOf(letter);
  if (heb !== -1) return heb;
  return LAT_LETTERS.indexOf(letter.toLowerCase());
}

export function parseQuestions(lines) {
  const questions = [];
  let current = null;
  let inOptions = false;
  // Images seen before any question opens attach to the next question,
  // so a diagram above its question stays glued to it as one unit.
  let pendingImages = [];

  const pushCurrent = () => {
    if (current && current.options.length >= 2) questions.push(current);
    current = null;
    inOptions = false;
  };

  for (const line of lines) {
    const text = line.text.trim();
    const images = line.images || [];
    if (images.length > 0) {
      if (current) current.images.push(...images);
      else pendingImages.push(...images);
    }
    if (!text) continue;

    // "תשובה נכונה: ב" line — applies to the current question.
    const ansMatch = text.match(ANSWER_LINE_RE);
    if (ansMatch && current) {
      const idx = letterIndex(ansMatch[1]);
      if (idx >= 0 && idx < current.options.length) {
        current.options.forEach((o, i) => (o.correct = i === idx));
      }
      continue;
    }

    const optMatch = text.match(OPTION_RE);
    if (optMatch && current) {
      const [, star, letter, body] = optMatch;
      const expected = current.options.length;
      // Accept the option only if its letter is the next expected one —
      // otherwise "ב. כהן היה ראשון" mid-sentence would be swallowed.
      if (letterIndex(letter) === expected) {
        // A single physical line may hold several options: "א. כן ב. לא ג. אולי"
        for (const piece of splitInlineOptions(letter, star === '*', body, line.bold)) {
          if (letterIndex(piece.letter) === current.options.length) {
            current.options.push({ text: piece.text, correct: piece.correct });
          }
        }
        inOptions = true;
        continue;
      }
    }

    const qMatch = text.match(QUESTION_RE);
    // A new numbered line starts a new question once we've seen options,
    // or when nothing is open yet.
    if (qMatch && (!current || inOptions || current.options.length === 0)) {
      const [, , body] = qMatch;
      if (current && current.options.length >= 2) pushCurrent();
      if (!current || inOptions) {
        current = { text: body.trim(), options: [], images: pendingImages };
        pendingImages = [];
        inOptions = false;
        continue;
      }
    }

    // Continuation line: append to the open option or question text.
    if (current) {
      if (inOptions && current.options.length > 0) {
        const last = current.options[current.options.length - 1];
        last.text = `${last.text} ${text}`.trim();
        if (line.bold) last.correct = true;
      } else {
        current.text = `${current.text} ${text}`.trim();
      }
    }
  }
  pushCurrent();

  // Ensure at most one correct option per question.
  for (const q of questions) {
    let seen = false;
    for (const o of q.options) {
      if (o.correct && seen) o.correct = false;
      if (o.correct) seen = true;
    }
  }
  return questions;
}

function splitInlineOptions(firstLetter, firstCorrect, body, bold) {
  // Split "כן ב. לא ג. אולי" into further options.
  const inlineRe = /\s(\*?)([אבגדהוזa-fA-F])\s*[.)]\s+/g;
  const found = [];
  let match;
  while ((match = inlineRe.exec(body)) !== null) {
    found.push({ index: match.index, len: match[0].length, letter: match[2], star: match[1] === '*' });
  }
  if (found.length === 0) {
    return [{ letter: firstLetter, correct: firstCorrect || bold, text: body }];
  }
  const result = [];
  let start = 0;
  let meta = { letter: firstLetter, correct: firstCorrect || bold };
  for (const f of found) {
    result.push({ ...meta, text: body.slice(start, f.index).trim() });
    meta = { letter: f.letter, correct: f.star || bold };
    start = f.index + f.len;
  }
  result.push({ ...meta, text: body.slice(start).trim() });
  return result.filter((p) => p.text);
}

export const SPECIAL_OPTION_RE =
  /כל\s+התשובות|אף\s+תשובה|אף\s+אחת|תשובות\s+[אבגד]\s*(?:ו|\+)|all\s+of\s+the\s+above|none\s+of\s+the\s+above|both\s+[a-d]\s+and/i;

// Parsing of extracted lines into multiple-choice questions.
//
// Real-world exam documents come in several shapes, all supported here:
//  - Explicit text markers:      "1. שאלה"  /  "א. תשובה"  /  "a) answer"
//  - Word auto-numbered lists:   the numbers/letters are NOT in the text;
//    structure arrives as {list: {depth, ordered, group}} metadata.
//  - Merged paragraphs:          question + options glued into one physical
//    line (soft line breaks / copy-paste), split by inline marker scanning.
//
// Correct-answer detection: leading "*", a fully-bold option line, or a
// "תשובה נכונה: ב" line after the question.

const HEB_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז'];
const LAT_LETTERS = ['a', 'b', 'c', 'd', 'e', 'f'];

const LINE_QUESTION_WORD_RE =
  /^שאלה\s+(?:מס(?:פר)?['׳.]?\s*)?(\d{1,3})\s*[:.)־–-]?\s*(.*)$/;
// A table cell holding just the option letter ("א" without a dot); the
// option text arrives in the following cell/line.
const BARE_LETTER_RE = /^([אבגדהוז])['׳]?$/;
const LINE_OPTION_RE = /^(\*?)\s*([אבגדהוז]|[a-fA-F])\s*['׳]?\s*[.):]\s+(.*)$/;
const LATIN_OPTION_RE = /^(\*?)\s*([a-fA-F])\s*[.):]\s+(.*)$/;
// Note: uses a Unicode lookahead instead of \b — \b is defined via \w, which
// does not include Hebrew letters, so it silently fails to match a boundary
// between two Hebrew/punctuation characters (e.g. "תשובה נכונה: ב.").
const ANSWER_LINE_RE =
  /^ה?תשובה(?:\s+ה?נכונה)?\s*[:\-]\s*([אבגדהוזa-fA-F])(?![\p{L}\p{N}])/u;
// Inline markers that may appear mid-line in merged paragraphs:
// Hebrew option letters ("א." "ב)") or question numbers ("3.").
const MID_MARKER_RE = /(?:^|\s)(?:(\*?)([אבגדהוז])['׳]?|(\d{1,3}))[.)](?=\s|$)/g;

// An administrative note about exam structure (e.g. "questions 8-9 are a
// block, don't shuffle them apart") that sometimes gets swallowed as if it
// were a trailing answer option — it never is one and must be dropped.
const BLOCK_NOTE_RE =
  /^שאל(?:ה|ות)\s+\d+(?:\s*[,ו]\s*\d+)*\s+(?:הן|הינן|הוא|הינה|היא)\s+בלוק/;

function letterIndex(letter) {
  const heb = HEB_LETTERS.indexOf(letter);
  if (heb !== -1) return heb;
  return LAT_LETTERS.indexOf(letter.toLowerCase());
}

export function parseQuestions(lines) {
  const questions = [];
  let current = null;
  let inOptions = false;
  let lastQNum = null;
  // Images are buffered and flushed to whichever question turns out to own
  // them: the open question, or the next one if the current one is done.
  let bufferedImages = [];
  const groupRoles = new Map();

  const flushImagesTo = (target) => {
    if (bufferedImages.length && target) {
      target.images.push(...bufferedImages);
      bufferedImages = [];
    }
  };

  // Note: buffered images are NOT flushed here — an image arriving after a
  // question's options belongs to the NEXT question (a diagram above it).
  const closeCurrent = () => {
    if (current && current.options.length >= 2) questions.push(current);
    current = null;
    inOptions = false;
  };

  const startQuestion = (text, num) => {
    closeCurrent();
    current = { text: (text || '').trim(), options: [], images: [] };
    flushImagesTo(current);
    if (num != null) lastQNum = num;
    inOptions = false;
  };

  const startOption = (text, correct) => {
    if (!current) return null;
    flushImagesTo(current);
    const opt = { text: (text || '').trim(), correct: !!correct };
    current.options.push(opt);
    inOptions = true;
    return opt;
  };

  const appendText = (text, bold) => {
    if (!current || !text) return;
    if (inOptions && current.options.length) {
      const last = current.options[current.options.length - 1];
      last.text = `${last.text} ${text}`.trim();
      if (bold) last.correct = true;
    } else {
      current.text = `${current.text} ${text}`.trim();
    }
  };

  // Some RTL documents store option markers AFTER their text (visual order):
  // "שאלה? setup, loop א. Serial.begin ב. ... ד." — the text before each
  // marker is that marker's answer. Detect the signature (text between the
  // question mark and "א.", empty text after the last marker) and rewrite
  // the line into normal marker-before form.
  const fixTrailingMarkerLayout = (text) => {
    const re = /\s(\*?)([אבגדהוז])['׳]?[.)](?=\s|$)/g;
    const marks = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      marks.push({ i: m.index, end: m.index + m[0].length, letter: m[2] });
    }
    if (marks.length < 2) return text;
    for (let k = 0; k < marks.length; k++) {
      if (letterIndex(marks[k].letter) !== k) return text;
    }
    const afterLast = text.slice(marks[marks.length - 1].end).trim();
    if (afterLast && !/^\d{1,3}[.)](\s|$)/.test(afterLast)) return text;
    const head = text.slice(0, marks[0].i);
    const qEnd = Math.max(head.lastIndexOf('?'), head.lastIndexOf(':'));
    if (qEnd === -1) return text;
    const firstBody = head.slice(qEnd + 1).trim();
    if (!firstBody) return text; // normal marker-before layout
    const bodies = [firstBody];
    for (let k = 0; k < marks.length - 1; k++) {
      bodies.push(text.slice(marks[k].end, marks[k + 1].i).trim());
    }
    let out = head.slice(0, qEnd + 1);
    marks.forEach((mk, k) => {
      out += ` ${mk.letter}. ${bodies[k]}`;
    });
    if (afterLast) out += ` ${afterLast}`;
    return out;
  };

  // Scans a plain text line, splitting it on inline question/option markers.
  // Merged paragraphs like "2. שאלה? א. כן ב. לא 3. שאלה הבאה" are handled
  // by processing each accepted marker incrementally against live state.
  const processTextChunk = (rawText, bold) => {
    let text = rawText;

    // Bare option letter (a table cell such as "א") — the option text
    // follows on the next line(s).
    const bare = text.match(BARE_LETTER_RE);
    if (bare && current && letterIndex(bare[1]) === current.options.length) {
      startOption('', false);
      return;
    }

    // "שאלה 2: גוף" → normalize to "2. גוף" so the number scanner sees it.
    const qWord = text.match(LINE_QUESTION_WORD_RE);
    if (qWord) {
      // Drop a points annotation like "(10 נק')" from the question head.
      const body = qWord[2].replace(/^\([^)]*נק[^)]*\)\s*/, '');
      text = `${qWord[1]}. ${body}`;
    }

    text = fixTrailingMarkerLayout(text);

    // Latin option at line start (a. / B) ...) — not scanned mid-line to
    // avoid false positives inside English sentences.
    const latin = text.match(LATIN_OPTION_RE);
    if (latin && current && letterIndex(latin[2]) === current.options.length) {
      startOption(latin[3], latin[1] === '*' || bold);
      return;
    }

    const optionsThisChunk = [];
    let pos = 0;
    MID_MARKER_RE.lastIndex = 0;
    let m;
    while ((m = MID_MARKER_RE.exec(text)) !== null) {
      const head = text.slice(pos, m.index).trim();
      const atLineStart = text.slice(0, m.index).trim() === '';

      if (m[2] !== undefined) {
        // Hebrew option letter
        const idx = letterIndex(m[2]);
        const expected = current ? current.options.length : -1;
        if (current && idx === expected) {
          if (head) appendText(head, false);
          const opt = startOption('', m[1] === '*');
          if (opt) optionsThisChunk.push(opt);
          pos = m.index + m[0].length;
        }
      } else {
        // question number
        const num = parseInt(m[3], 10);
        // At line start a numbered marker starts a new question even when a
        // stale question with no options is open (e.g. a swallowed preamble
        // list item) — closeCurrent() drops such invalid questions anyway.
        const acceptable = atLineStart
          ? !current || inOptions || current.options.length === 0
          : lastQNum !== null && num === lastQNum + 1 && inOptions;
        if (acceptable) {
          if (head) appendText(head, false);
          startQuestion('', num);
          pos = m.index + m[0].length;
        }
      }
    }

    const tail = text.slice(pos).trim();
    if (tail) appendText(tail, bold && optionsThisChunk.length === 0);

    // A fully-bold physical line that produced exactly one option marks it
    // as the correct answer (common teacher convention in Word).
    if (bold && optionsThisChunk.length === 1) optionsThisChunk[0].correct = true;
  };

  // Word auto-numbered list items: the numbering is structural, not textual.
  const handleListLine = (line, text) => {
    const { depth, ordered, group } = line.list;

    // Explicit marker inside a list item wins over structure.
    const opt = text.match(LINE_OPTION_RE);
    if (opt && current && letterIndex(opt[2]) === current.options.length) {
      startOption(opt[3], opt[1] === '*' || line.bold);
      return;
    }

    if (depth >= 1) {
      // Nested list item — an option of the open question.
      if (current) startOption(text, line.bold);
      return;
    }

    // Top-level list item: decide once per list whether its items are
    // options (a question is open and waiting) or questions themselves.
    if (!groupRoles.has(group)) {
      const awaitingOptions = current && !inOptions && current.options.length === 0;
      groupRoles.set(group, awaitingOptions ? 'options' : ordered ? 'questions' : 'text');
    }
    const role = groupRoles.get(group);

    if (role === 'options' && current) {
      startOption(text, line.bold);
    } else if (role === 'questions') {
      const qNum = text.match(/^(\d{1,3})\s*[.)]\s*(.*)$/);
      if (qNum) startQuestion(qNum[2], parseInt(qNum[1], 10));
      else startQuestion(text, lastQNum !== null ? lastQNum + 1 : null);
    } else {
      processTextChunk(text, line.bold);
    }
  };

  for (const line of lines) {
    if (line.images && line.images.length) bufferedImages.push(...line.images);
    const text = (line.text || '').trim();
    if (!text) continue;

    // "תשובה נכונה: ב" — applies to the open question.
    const ansMatch = text.match(ANSWER_LINE_RE);
    if (ansMatch && current && current.options.length) {
      const idx = letterIndex(ansMatch[1]);
      if (idx >= 0 && idx < current.options.length) {
        current.options.forEach((o, i) => (o.correct = i === idx));
      }
      continue;
    }

    if (line.list) handleListLine(line, text);
    else processTextChunk(text, line.bold);
  }
  // Trailing images at end of document belong to the last question.
  flushImagesTo(current);
  closeCurrent();

  // Drop empty options, ensure at most one correct option per question.
  const clean = [];
  for (const q of questions) {
    q.options = q.options.filter((o) => o.text && !BLOCK_NOTE_RE.test(o.text));
    // Strip a leftover points annotation ("10 נק'") from the question head.
    q.text = q.text.replace(/^[\s()]*\d{0,3}\s*נק['׳]?[\s()]*/, '').trim();
    if (!q.text || q.options.length < 2) continue;
    let seen = false;
    for (const o of q.options) {
      if (o.correct && seen) o.correct = false;
      if (o.correct) seen = true;
    }
    clean.push(q);
  }
  return clean;
}

// Options that must keep their position when shuffling.
export const SPECIAL_OPTION_RE =
  /כל\s+התשובות|אף\s+תשובה|אף\s+אחת|תשובות\s+[אבגד]\s*(?:ו|\+)|all\s+of\s+the\s+above|none\s+of\s+the\s+above|both\s+[a-d]\s+and/i;

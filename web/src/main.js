import { extractLines } from './extract.js';
import { parseQuestions } from './parse.js';
import { generateVersions } from './shuffle.js';
import { exportAll } from './export.js';
import { initSimulator, startSimulation } from './simulator.js';
import { imageStrip } from './lightbox.js';
import { questionKey } from './question-key.js';
import { renderWithCode } from './code-format.js';

// A valid multiple-choice question in this app always has at least 4
// options; fewer means the extraction lost or misplaced an answer.
const MIN_OPTIONS = 4;

const HEB_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז'];

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const parseStatus = document.getElementById('parse-status');
const editor = document.getElementById('editor');
const questionList = document.getElementById('question-list');
const qCount = document.getElementById('q-count');
const generateBtn = document.getElementById('generate-btn');
const resetBtn = document.getElementById('reset-btn');
const generateStatus = document.getElementById('generate-status');

let questions = [];
const seenKeys = new Set();

// --- file intake -----------------------------------------------------------

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  handleFiles([...e.dataTransfer.files]);
});
fileInput.addEventListener('change', () => {
  handleFiles([...fileInput.files]);
  fileInput.value = '';
});

async function handleFiles(files) {
  if (!files.length) return;
  showStatus('⏳ קורא את הקבצים…', false);
  let added = 0;
  let duplicates = 0;
  const skipped = [];
  const errors = [];

  for (const file of files) {
    try {
      const lines = await extractLines(file);
      const parsed = parseQuestions(lines);
      if (parsed.length === 0) {
        skipped.push(file.name);
        continue;
      }
      for (const q of parsed) {
        const key = questionKey(q);
        if (seenKeys.has(key)) {
          duplicates++;
          continue;
        }
        seenKeys.add(key);
        questions.push(q);
        added++;
      }
    } catch (err) {
      console.error(err);
      errors.push(`${file.name}: ${err.message}`);
    }
  }

  render();

  const parts = [];
  if (added) parts.push(`✅ נוספו ${added} שאלות למאגר (סה"כ ${questions.length})`);
  if (duplicates) parts.push(`${duplicates} שאלות כפולות דולגו`);
  if (skipped.length) {
    parts.push(
      `לא זוהו שאלות ב־${skipped.length} קבצים (ייתכן שאלו קובצי תשובות/פתרון): ${skipped.join(', ')}`,
    );
  }
  if (errors.length) parts.push(`שגיאות: ${errors.join(' | ')}`);
  showStatus(parts.join(' · '), added === 0);

  if (added) validateNewQuestions(parts);
}

// Asks ChatGPT to sanity-check freshly added questions: do the options
// logically belong to their question, and is anything missing/misplaced
// (e.g. an answer that got glued onto the question text)? When ChatGPT can
// confidently reconstruct a broken question it returns a fix, which is
// applied automatically; otherwise the question is flagged for the user to
// review. Anything that still has fewer than MIN_OPTIONS afterwards is
// removed — this app's exams never have fewer than 4 real answers.
async function validateNewQuestions(statusParts) {
  const pending = questions.filter((q) => q.checked === undefined);
  if (!pending.length) return;
  pending.forEach((q) => (q.checked = false));

  const BATCH = 8;
  let fixed = 0;
  let flagged = 0;
  let failed = false;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    showStatus(
      `${statusParts.join(' · ')} · 🔍 ChatGPT בודק התאמה בין שאלות לתשובות… (${Math.min(i + BATCH, pending.length)}/${pending.length})`,
      false,
    );

    // Retry once before giving up — a transient failure must not silently
    // strand these questions forever: anything not marked checked=true below
    // is reset to undefined so a future upload picks it up again instead of
    // permanently skipping validation.
    let batchOk = false;
    for (let attempt = 0; attempt < 2 && !batchOk; attempt++) {
      try {
        const res = await fetch('/api/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            questions: batch.map((q, bi) => ({
              id: bi + 1,
              text: q.text,
              options: q.options.map((o) => o.text),
            })),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        for (const check of data.checks) {
          const q = batch[check.id - 1];
          if (!q) continue;
          q.checked = true;
          if (check.ok === false) {
            const fix = check.fix;
            const fixOptions = Array.isArray(fix?.options)
              ? fix.options.map((t) => String(t).trim()).filter(Boolean)
              : [];
            if (fix?.text && fixOptions.length >= MIN_OPTIONS) {
              // Reused option text keeps whatever correct-marking it already
              // had (e.g. detected from bold text in the source document);
              // only genuinely new/reconstructed text starts unmarked.
              const wasCorrect = new Set(
                q.options.filter((o) => o.correct).map((o) => o.text.trim()),
              );
              seenKeys.delete(questionKey(q));
              q.text = String(fix.text).trim();
              q.options = fixOptions.map((text) => ({
                text,
                correct: wasCorrect.has(text.trim()),
              }));
              seenKeys.add(questionKey(q));
              q.flag = null;
              q.autoFixed = true;
              fixed++;
            } else {
              q.flag = check.issue || 'ייתכן שהשאלה חולצה לא נכון';
              flagged++;
            }
          }
        }
        batchOk = true;
      } catch (err) {
        console.error(`validate failed (attempt ${attempt + 1}):`, err);
      }
    }

    if (!batchOk) {
      failed = true;
      // This batch and anything after it stay unvalidated for now — mark
      // them retryable rather than leaving them stuck at checked=false.
      for (const q of pending.slice(i)) {
        if (q.checked !== true) q.checked = undefined;
      }
      break;
    }
  }

  // Hard rule enforced after validation (and any auto-fix attempt): drop
  // anything that still has fewer than MIN_OPTIONS real answers.
  let removed = 0;
  questions = questions.filter((q) => {
    if (q.checked && q.options.length < MIN_OPTIONS) {
      seenKeys.delete(questionKey(q));
      removed++;
      return false;
    }
    return true;
  });

  render();
  const bits = [];
  if (fixed) bits.push(`🛠️ ChatGPT שיחזר אוטומטית ${fixed} שאלות עם תשובה חסרה/מוזזת`);
  if (removed) {
    bits.push(`🗑️ ${removed} שאלות הוסרו כי נותרו עם פחות מ-${MIN_OPTIONS} תשובות תקינות`);
  }
  if (flagged) bits.push(`⚠️ ${flagged} שאלות עדיין מסומנות כחשודות — כדאי לבדוק ולמחוק ידנית`);
  if (failed) {
    bits.push('בדיקת האיכות לא הושלמה לכל השאלות (שגיאת רשת/API) — הבדיקה תושלם אוטומטית בהעלאה הבאה');
  }
  if (!fixed && !removed && !flagged && !failed) bits.push('✅ ChatGPT אישר: כל השאלות נראות תקינות');
  showStatus(`${statusParts.join(' · ')} · ${bits.join(' · ')}`, false);
}

function showStatus(msg, isError) {
  parseStatus.hidden = false;
  parseStatus.textContent = msg;
  parseStatus.classList.toggle('error', isError);
}

// --- question pool rendering (read-only) ------------------------------------

function render() {
  editor.hidden = questions.length === 0;
  qCount.textContent = questions.length;
  questionList.replaceChildren(
    ...questions.map((q, qi) => renderQuestion(q, qi)),
  );
}

function renderQuestion(q, qi) {
  const card = document.createElement('div');
  card.className = 'card q-card' + (q.flag ? ' q-card-flagged' : '');

  const head = document.createElement('div');
  head.className = 'q-head';

  const num = document.createElement('div');
  num.className = 'q-num';
  num.textContent = qi + 1;

  const qText = document.createElement('div');
  qText.className = 'q-text';
  renderWithCode(qText, q.text);

  const del = document.createElement('button');
  del.className = 'q-delete';
  del.title = 'מחיקת שאלה מהמאגר';
  del.textContent = '🗑️';
  del.addEventListener('click', () => {
    seenKeys.delete(questionKey(q));
    questions.splice(qi, 1);
    render();
  });

  head.append(num, qText, del);
  card.append(head);

  if (q.autoFixed) {
    const fixedNote = document.createElement('div');
    fixedNote.className = 'q-fixed';
    fixedNote.textContent = '🛠️ ChatGPT שיחזר כאן תשובה שהייתה חסרה או מודבקת לשאלה';
    card.append(fixedNote);
  }

  if (q.flag) {
    const flag = document.createElement('div');
    flag.className = 'q-flag';
    flag.textContent = `⚠️ ChatGPT: ${q.flag}`;
    card.append(flag);
  }

  if (q.images && q.images.length) card.append(imageStrip(q.images));

  q.options.forEach((opt, oi) => {
    const row = document.createElement('div');
    row.className = 'opt-row';

    const correct = document.createElement('button');
    correct.className = 'opt-correct' + (opt.correct ? ' checked' : '');
    correct.title = 'סימון כתשובה נכונה (לתשובון של המבחן המעורבב)';
    correct.addEventListener('click', () => {
      const wasCorrect = opt.correct;
      q.options.forEach((o) => (o.correct = false));
      opt.correct = !wasCorrect;
      render();
    });

    const letter = document.createElement('span');
    letter.className = 'opt-letter';
    letter.textContent = `${HEB_LETTERS[oi] ?? oi + 1}.`;

    const optText = document.createElement('div');
    optText.className = 'opt-text';
    renderWithCode(optText, opt.text);

    row.append(correct, letter, optText);
    card.append(row);
  });

  return card;
}

// --- shuffled exam download --------------------------------------------------

generateBtn.addEventListener('click', async () => {
  if (questions.length === 0) return;
  const title = document.getElementById('exam-title').value.trim() || 'מבחן';

  generateBtn.disabled = true;
  generateStatus.textContent = '⏳ יוצר קבצים…';
  try {
    const versions = generateVersions(questions, {
      numVersions: 1,
      shuffleQuestions: true,
      shuffleOptions: true,
      pinSpecial: true,
    });
    await exportAll(title, versions);
    generateStatus.textContent = '✅ הורדו מבחן מעורבב + תשובון';
  } catch (err) {
    console.error(err);
    generateStatus.textContent = `שגיאה ביצירת הקבצים: ${err.message}`;
  } finally {
    generateBtn.disabled = false;
  }
});

// --- simulator ---------------------------------------------------------------

initSimulator({
  onExit: () => {
    editor.hidden = questions.length === 0;
    dropZone.hidden = false;
  },
  getPool: simulationPool,
});

// Prefer questions ChatGPT didn't flag as mismatched; fall back to the full
// pool if too few clean questions are available yet.
function simulationPool() {
  const clean = questions.filter((q) => !q.flag);
  return clean.length >= 4 ? clean : questions;
}

document.getElementById('simulate-btn').addEventListener('click', () => {
  if (questions.length === 0) return;
  editor.hidden = true;
  dropZone.hidden = true;
  parseStatus.hidden = true;
  startSimulation(simulationPool());
});

resetBtn.addEventListener('click', () => {
  questions = [];
  seenKeys.clear();
  parseStatus.hidden = true;
  generateStatus.textContent = '';
  render();
});

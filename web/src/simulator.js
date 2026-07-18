// Exam simulator: 10 random questions from the pool, answers are revealed
// only at the end, graded by ChatGPT through the /api/grade endpoint
// (the model determines correct answers itself — the source document's
// marking is never trusted).

import { imageStrip } from './lightbox.js';
import { questionKey } from './question-key.js';
import { renderWithCode } from './code-format.js';
import { rewriteComboRefs } from './shuffle.js';

const SIM_SIZE = 10;
const HEB_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז'];

const els = {};
let simQuestions = [];
let onExit = null;
let getPool = null;

function $(id) {
  return document.getElementById(id);
}

function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function initSimulator({ onExit: exitCb, getPool: poolCb }) {
  onExit = exitCb;
  getPool = poolCb;
  els.section = $('simulator');
  els.questions = $('sim-questions');
  els.results = $('sim-results');
  els.finish = $('sim-finish');
  els.exit = $('sim-exit');
  els.actions = $('sim-actions');
  els.status = $('sim-status');

  els.exit.addEventListener('click', exitSimulator);
  els.finish.addEventListener('click', finishSimulation);
}

// Drops questions whose normalized text collides with one already kept, so
// two near-duplicate entries (e.g. from an exam file and its matching
// solutions file) can never both be drawn into the same simulation.
function dedupeByKey(pool) {
  const seen = new Set();
  const unique = [];
  for (const q of pool) {
    const key = questionKey(q);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(q);
  }
  return unique;
}

// Groups questions into draw-atomic units: a declared block ("questions 8,
// 9 are a block") only makes sense together — one shares its diagram/code
// with the other, or the text says "as described above" — so drawing one
// without the other into a simulation must never happen. Standalone
// questions are singleton units.
function buildUnits(pool) {
  const unitByBlock = new Map();
  const units = [];
  for (const q of pool) {
    if (q.blockId) {
      let unit = unitByBlock.get(q.blockId);
      if (!unit) {
        unit = [];
        unitByBlock.set(q.blockId, unit);
        units.push(unit);
      }
      unit.push(q);
    } else {
      units.push([q]);
    }
  }
  return units;
}

export function startSimulation(pool) {
  // Each simulation: up to 10 random UNIQUE questions, drawn whole unit at a
  // time so a block never gets split across the "in" / "not drawn" line —
  // this can slightly overshoot SIM_SIZE when a multi-question block
  // completes the set, which is preferable to showing a question stripped
  // of the context it depends on. Options are reshuffled so the original
  // order gives nothing away; images travel with their question.
  const units = shuffle(buildUnits(dedupeByKey(pool)));
  const picked = [];
  for (const unit of units) {
    if (picked.length >= SIM_SIZE) break;
    picked.push(...unit);
  }
  simQuestions = picked.map((q, i) => {
    // Track origIndex through the shuffle so a "תשובות ב, ג נכונות"-style
    // option can be rewritten to name the new letters of whatever it
    // actually referenced — otherwise the reference silently breaks once
    // the options are reordered.
    const withOrig = q.options.map((o, oi) => ({ ...o, origIndex: oi }));
    const options = rewriteComboRefs(shuffle(withOrig)).map((o) => o.text);
    return {
      id: i + 1,
      text: q.text,
      images: q.images || [],
      options,
      selected: null,
    };
  });

  els.section.hidden = false;
  els.results.hidden = true;
  els.results.replaceChildren();
  els.actions.hidden = false;
  els.status.textContent = '';
  renderQuestions();
  els.section.scrollIntoView({ behavior: 'instant' });
}

function exitSimulator() {
  els.section.hidden = true;
  simQuestions = [];
  onExit?.();
}

function renderQuestions() {
  els.questions.replaceChildren(
    ...simQuestions.map((q) => {
      const card = document.createElement('div');
      card.className = 'card sim-q';

      const head = document.createElement('div');
      head.className = 'q-head';
      const num = document.createElement('div');
      num.className = 'q-num';
      num.textContent = q.id;
      const text = document.createElement('div');
      text.className = 'sim-q-text';
      renderWithCode(text, q.text);
      head.append(num, text);
      card.append(head);

      if (q.images.length) card.append(imageStrip(q.images));

      q.options.forEach((opt, oi) => {
        const row = document.createElement('label');
        row.className = 'sim-opt';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = `sim-q-${q.id}`;
        radio.addEventListener('change', () => {
          q.selected = oi;
          updateProgress();
        });
        const letter = document.createElement('span');
        letter.className = 'opt-letter';
        letter.textContent = `${HEB_LETTERS[oi] ?? oi + 1}.`;
        const txt = document.createElement('span');
        txt.className = 'opt-body';
        renderWithCode(txt, opt);
        row.append(radio, letter, txt);
        card.append(row);
      });

      return card;
    }),
  );
  updateProgress();
}

function updateProgress() {
  const answered = simQuestions.filter((q) => q.selected !== null).length;
  els.status.textContent = `נענו ${answered} מתוך ${simQuestions.length} שאלות`;
}

async function finishSimulation() {
  const unanswered = simQuestions.filter((q) => q.selected === null).length;
  if (
    unanswered > 0 &&
    !confirm(`נותרו ${unanswered} שאלות ללא מענה — הן ייחשבו כשגויות. לסיים בכל זאת?`)
  ) {
    return;
  }

  els.finish.disabled = true;
  els.status.textContent = '⏳ בודק את התשובות מול ChatGPT…';
  try {
    const res = await fetch('/api/grade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questions: simQuestions.map((q) => ({
          id: q.id,
          text: q.text,
          options: q.options,
          images: q.images,
        })),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showResults(data.answers);
  } catch (err) {
    console.error(err);
    els.status.textContent = `שגיאה בבדיקה: ${err.message}`;
  } finally {
    els.finish.disabled = false;
  }
}

function showResults(answers) {
  const byId = new Map(answers.map((a) => [a.id, a]));
  let correctCount = 0;
  const breakdown = [];

  for (const q of simQuestions) {
    const ans = byId.get(q.id);
    const correctIdx =
      ans && ans.correct >= 0 && ans.correct < q.options.length ? ans.correct : null;
    const isCorrect = correctIdx !== null && q.selected === correctIdx;
    if (isCorrect) correctCount++;
    breakdown.push({ q, correctIdx, isCorrect, lowConfidence: ans?.confidence === 'low' });
  }

  const percent = Math.round((correctCount / simQuestions.length) * 100);

  const score = document.createElement('div');
  score.className = 'sim-score card';
  score.innerHTML = `
    <div class="sim-percent">${percent}%</div>
    <div>ענית נכון על ${correctCount} מתוך ${simQuestions.length} שאלות</div>
    <p class="hint">הבדיקה בוצעה על ידי ChatGPT באופן עצמאי, ללא הסתמכות על סימוני קובץ המקור.</p>
  `;

  const list = document.createElement('div');
  list.className = 'sim-breakdown';
  for (const { q, correctIdx, isCorrect, lowConfidence } of breakdown) {
    const item = document.createElement('div');
    item.className = `card sim-result ${isCorrect ? 'right' : 'wrong'}`;
    const yourAnswer =
      q.selected !== null
        ? `${HEB_LETTERS[q.selected]}. ${q.options[q.selected]}`
        : 'לא נענתה';
    const correctAnswer =
      correctIdx !== null
        ? `${HEB_LETTERS[correctIdx]}. ${q.options[correctIdx]}`
        : 'לא נקבעה';
    const badge = isCorrect ? '✔' : '✘';
    item.innerHTML = `
      <div class="sim-result-head"><span class="sim-badge">${badge}</span> <strong></strong></div>
    `;
    renderWithCode(item.querySelector('strong'), `${q.id}. ${q.text}`);
    if (q.images.length) item.append(imageStrip(q.images));
    const details = document.createElement('div');
    details.innerHTML = `
      <div class="sim-result-detail">התשובה שלך: <span></span></div>
      <div class="sim-result-detail">התשובה הנכונה: <span></span>${lowConfidence ? ' <em>(המודל לא בטוח)</em>' : ''}</div>
    `;
    const spans = details.querySelectorAll('.sim-result-detail span');
    renderWithCode(spans[0], yourAnswer);
    renderWithCode(spans[1], correctAnswer);
    item.append(...details.children);
    list.append(item);
  }

  const again = document.createElement('div');
  again.className = 'actions';
  const againBtn = document.createElement('button');
  againBtn.className = 'primary';
  againBtn.textContent = '🎓 סימולציה חדשה';
  againBtn.addEventListener('click', () => startSimulation(getPool?.() || []));
  const backBtn = document.createElement('button');
  backBtn.className = 'ghost';
  backBtn.textContent = 'חזרה לעריכה';
  backBtn.addEventListener('click', exitSimulator);
  again.append(againBtn, backBtn);

  els.questions.replaceChildren();
  els.actions.hidden = true;
  els.status.textContent = '';
  els.results.hidden = false;
  els.results.replaceChildren(score, list, again);
  els.results.scrollIntoView({ behavior: 'instant' });
}

import { extractLines } from './extract.js';
import { parseQuestions } from './parse.js';
import { generateVersions } from './shuffle.js';
import { exportAll } from './export.js';
import { initSimulator, startSimulation } from './simulator.js';

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
  const added = [];
  const errors = [];
  for (const file of files) {
    try {
      const lines = await extractLines(file);
      const parsed = parseQuestions(lines);
      if (parsed.length === 0) {
        errors.push(`${file.name}: לא זוהו שאלות אמריקאיות בקובץ`);
      } else {
        added.push(...parsed);
      }
    } catch (err) {
      console.error(err);
      errors.push(`${file.name}: ${err.message}`);
    }
  }
  questions.push(...added);
  render();
  if (errors.length) {
    showStatus(`⚠️ ${errors.join(' | ')}`, true);
  } else {
    showStatus(`✅ זוהו ${added.length} שאלות מ־${files.length} קבצים`, false);
  }
}

function showStatus(msg, isError) {
  parseStatus.hidden = false;
  parseStatus.textContent = msg;
  parseStatus.classList.toggle('error', isError);
}

// --- editor rendering ------------------------------------------------------

function render() {
  editor.hidden = questions.length === 0;
  qCount.textContent = questions.length;
  questionList.replaceChildren(
    ...questions.map((q, qi) => renderQuestion(q, qi)),
  );
}

function renderQuestion(q, qi) {
  const card = document.createElement('div');
  card.className = 'card q-card';

  const head = document.createElement('div');
  head.className = 'q-head';

  const num = document.createElement('div');
  num.className = 'q-num';
  num.textContent = qi + 1;

  const qText = document.createElement('textarea');
  qText.className = 'q-text';
  qText.rows = 1;
  qText.value = q.text;
  qText.addEventListener('input', () => (q.text = qText.value));

  const del = document.createElement('button');
  del.className = 'q-delete';
  del.title = 'מחיקת שאלה';
  del.textContent = '🗑️';
  del.addEventListener('click', () => {
    questions.splice(qi, 1);
    render();
  });

  head.append(num, qText, del);
  card.append(head);

  if (q.images && q.images.length) {
    const imgWrap = document.createElement('div');
    imgWrap.className = 'q-images';
    for (const src of q.images) {
      const img = document.createElement('img');
      img.src = src;
      imgWrap.append(img);
    }
    card.append(imgWrap);
  }

  q.options.forEach((opt, oi) => {
    const row = document.createElement('div');
    row.className = 'opt-row';

    const correct = document.createElement('button');
    correct.className = 'opt-correct' + (opt.correct ? ' checked' : '');
    correct.title = 'סימון כתשובה נכונה';
    correct.addEventListener('click', () => {
      const wasCorrect = opt.correct;
      q.options.forEach((o) => (o.correct = false));
      opt.correct = !wasCorrect;
      render();
    });

    const letter = document.createElement('span');
    letter.className = 'opt-letter';
    letter.textContent = `${HEB_LETTERS[oi] ?? oi + 1}.`;

    const optText = document.createElement('input');
    optText.className = 'opt-text';
    optText.value = opt.text;
    optText.addEventListener('input', () => (opt.text = optText.value));

    row.append(correct, letter, optText);
    card.append(row);
  });

  return card;
}

// --- generation ------------------------------------------------------------

generateBtn.addEventListener('click', async () => {
  if (questions.length === 0) return;
  const settings = {
    numVersions: Math.min(
      26,
      Math.max(1, parseInt(document.getElementById('num-versions').value, 10) || 1),
    ),
    shuffleQuestions: document.getElementById('shuffle-questions').checked,
    shuffleOptions: document.getElementById('shuffle-options').checked,
    pinSpecial: document.getElementById('pin-special').checked,
  };
  const title = document.getElementById('exam-title').value.trim() || 'מבחן';

  generateBtn.disabled = true;
  generateStatus.textContent = '⏳ יוצר קבצים…';
  try {
    const versions = generateVersions(questions, settings);
    await exportAll(title, versions);
    generateStatus.textContent = `✅ הורדו ${versions.length} גרסאות + תשובון`;
  } catch (err) {
    console.error(err);
    generateStatus.textContent = `שגיאה ביצירת הקבצים: ${err.message}`;
  } finally {
    generateBtn.disabled = false;
  }
});

// --- simulator -------------------------------------------------------------

initSimulator({
  onExit: () => {
    editor.hidden = questions.length === 0;
    dropZone.hidden = false;
  },
  getPool: () => questions,
});

document.getElementById('simulate-btn').addEventListener('click', () => {
  if (questions.length === 0) return;
  editor.hidden = true;
  dropZone.hidden = true;
  parseStatus.hidden = true;
  startSimulation(questions);
});

resetBtn.addEventListener('click', () => {
  questions = [];
  parseStatus.hidden = true;
  generateStatus.textContent = '';
  render();
});

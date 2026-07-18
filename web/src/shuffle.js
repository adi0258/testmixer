// Version generation: seeded shuffling of questions and options,
// keeping "all of the above"-style options pinned in place when asked.

import { SPECIAL_OPTION_RE, extractComboRef, HEB_LETTERS } from './parse.js';

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(array, rand) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// An option like "תשובות ב, ג נכונות" references OTHER options by letter.
// Pinning its own position isn't enough — whatever ends up sitting at
// letters ב/ג after the shuffle is different content, so the reference
// itself would be silently wrong. Rewrite it to name the NEW letters of
// whichever original options (by origIndex) it actually pointed to.
export function rewriteComboRefs(options) {
  const origIndexToNewPos = new Map(options.map((o, pos) => [o.origIndex, pos]));
  return options.map((o) => {
    const ref = extractComboRef(o.text);
    if (!ref) return o;
    const newPositions = ref.letters
      .map((l) => origIndexToNewPos.get(HEB_LETTERS.indexOf(l)))
      .filter((p) => p != null)
      .sort((a, b) => a - b);
    if (newPositions.length < 2) return o;
    const newLetters = newPositions.map((p) => HEB_LETTERS[p]);
    // The captured letters span may or may not include its own trailing
    // space (depends on whether a "," or "ו" followed the last letter) —
    // strip any leftover leading whitespace from the tail and always join
    // with exactly one space, rather than risking a doubled-up gap.
    const tail = o.text.slice(ref.matchEnd).replace(/^\s+/, '');
    const text = o.text.slice(0, ref.matchStart) + newLetters.join(', ') + ' ' + tail;
    return { ...o, text };
  });
}

// Groups question indices into shuffle-atomic units: a declared block
// ("questions 8, 9 are a block") becomes one unit whose members always stay
// adjacent and in their original relative order — a question that only
// makes sense together with its predecessor (shares a diagram/code, or says
// "as described above") must never be shuffled apart from it. Standalone
// questions are singleton units.
function buildUnits(questions) {
  const unitByBlock = new Map();
  const units = [];
  questions.forEach((q, i) => {
    if (q.blockId) {
      let unit = unitByBlock.get(q.blockId);
      if (!unit) {
        unit = [];
        unitByBlock.set(q.blockId, unit);
        units.push(unit);
      }
      unit.push(i);
    } else {
      units.push([i]);
    }
  });
  return units;
}

/**
 * @param questions [{text, options:[{text, correct}]}]
 * @param settings  {numVersions, shuffleQuestions, shuffleOptions, pinSpecial}
 * @returns versions: [{label, questions:[{origNum, text, options:[{text, correct, origIndex}]}]}]
 */
export function generateVersions(questions, settings) {
  const versions = [];
  const baseSeed = Date.now() & 0x7fffffff;

  for (let v = 0; v < settings.numVersions; v++) {
    const rand = mulberry32(baseSeed + v * 7919);

    let qOrder = questions.map((_, i) => i);
    if (settings.shuffleQuestions) {
      qOrder = shuffled(buildUnits(questions), rand).flat();
    }

    const vQuestions = qOrder.map((qi) => {
      const q = questions[qi];
      let options = q.options.map((o, i) => ({ ...o, origIndex: i }));
      if (settings.shuffleOptions) {
        const pinned = new Map();
        let movable = options;
        if (settings.pinSpecial) {
          movable = [];
          options.forEach((o, i) => {
            if (SPECIAL_OPTION_RE.test(o.text)) pinned.set(i, o);
            else movable.push(o);
          });
        }
        const mixed = shuffled(movable, rand);
        options = [];
        for (let i = 0; i < q.options.length; i++) {
          options.push(pinned.has(i) ? pinned.get(i) : mixed.shift());
        }
        options = rewriteComboRefs(options);
      }
      // Images stay glued to their question — the whole unit moves together.
      return { origNum: qi + 1, text: q.text, images: q.images || [], options };
    });

    versions.push({ label: String(v + 1), questions: vQuestions });
  }
  return versions;
}

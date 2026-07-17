// Detects inline source-code fragments (Arduino/C-like) within otherwise
// plain question/option text and renders them in a distinct monospace,
// LTR style — so a snippet like "analogWrite(9, 255);" reads clearly
// instead of blending into the surrounding Hebrew RTL prose. Short snippets
// render as an inline chip; longer multi-statement blocks render as their
// own left-aligned, lightly pretty-printed code block so a whole program
// doesn't get squeezed into one dense inline run.

// Restricts "expression content" matches (declaration values, assignment
// right-hand sides, call arguments) to code-plausible characters. This is
// deliberately an allow-list, not "anything except ;{}": an earlier version
// used a negated class, which happily matched Hebrew prose too and let a
// pattern greedily span across an entire unrelated Hebrew sentence to reach
// a distant ';' or ')' — e.g. "time = millis() Parameters None <hebrew
// paragraph> const int ledPin = 13;" collapsed into one bogus match.
const EXPR_CHAR = String.raw`[A-Za-z0-9_.,+\-*/%<>=!&|~^:\s'"]`;

// Function-call arguments, allowing one level of nested calls (e.g.
// Serial.println(digitalRead(2))) — common in this app's Arduino/C exams.
// Not a full recursive balanced-paren matcher (regex can't do unbounded
// nesting), but one level covers realistic exam code.
const CALL_ARGS = String.raw`${EXPR_CHAR}*(?:\(${EXPR_CHAR}*\)${EXPR_CHAR}*)*`;
const KEYWORD_TOKEN = String.raw`\b(?:void|int|float|double|bool|boolean|char|String|const|unsigned|signed|long|short|byte|word|static|volatile|else|do|return|break|continue|default)\b`;
const CALL_TOKEN = String.raw`[A-Za-z_][\w.]*\s*\(${CALL_ARGS}\)`;
// A full variable declaration ("unsigned long previousMillis = 0;") is
// matched as one atomic token — this app only marks landmark tokens rather
// than fully tokenizing C, so without this a bare identifier/expression
// like "previousMillis = 0" between the type keyword and ";" would be left
// as plain text, fragmenting every declaration line into several chips
// interspersed with stray un-highlighted assignments.
// The declaration/assignment value may itself contain a call (e.g.
// "currentMillis = millis();"), so it reuses CALL_ARGS' one-level-of-nesting
// allowance rather than plain EXPR_CHAR alone.
const DECL_TOKEN = String.raw`(?:${KEYWORD_TOKEN}\s+)+[A-Za-z_]\w*(?:\s*=\s*${CALL_ARGS})?;`;
// A plain reassignment with no type keyword ("previousMillis = currentMillis;").
const ASSIGN_TOKEN = String.raw`[A-Za-z_]\w*\s*[-+*/]?=\s*${CALL_ARGS};`;
// Each alternative is matched separately (not as one combined run) so a
// lone function-call-shaped token can be individually rejected when its
// "arguments" read like English prose rather than real code arguments —
// e.g. "overflow (go back to zero)" looks identical in shape to a call.
const TOKEN_RE = new RegExp(
  `${DECL_TOKEN}|${ASSIGN_TOKEN}|${KEYWORD_TOKEN}|[{}]|;|(${CALL_TOKEN})`,
  'g',
);

// True when a call's parenthesized content looks like a natural-language
// aside rather than code arguments: 3+ purely-lowercase alphabetic words
// (real arguments are typically numbers, ALL_CAPS constants, camelCase
// identifiers, or short comma-separated lists — not lowercase sentences).
function looksLikeProseArgs(callText) {
  const args = callText.slice(callText.indexOf('(') + 1, callText.lastIndexOf(')'));
  // Comparison/logical/compound-assignment operators are a strong "this is
  // real code" signal that overrides the word-count heuristic below — plain
  // English parentheticals essentially never contain "!=", "&&", etc., even
  // when (like "if((val != prev_val) && (val))") they also happen to
  // contain 3+ lowercase identifier words such as "val" and "prev_val".
  if (/[!=<>]=|&&|\|\||[+\-*/%]=|\+\+|--/.test(args)) return false;
  const words = args.match(/[A-Za-z]+/g) || [];
  const proseWords = words.filter((w) => w.length >= 2 && w === w.toLowerCase());
  return proseWords.length >= 3;
}

// Splits text into an array of {text, code:boolean} segments.
export function splitCodeRuns(text) {
  const spans = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const isCall = m[1] !== undefined;
    if (isCall && looksLikeProseArgs(m[0])) continue;
    spans.push({ start: m.index, end: TOKEN_RE.lastIndex });
  }

  // Merge spans separated only by whitespace into one contiguous run.
  const runs = [];
  for (const span of spans) {
    const prev = runs[runs.length - 1];
    if (prev && text.slice(prev.end, span.start).trim() === '') {
      prev.end = span.end;
    } else {
      runs.push({ ...span });
    }
  }

  const segments = [];
  let last = 0;
  for (const run of runs) {
    if (run.start > last) segments.push({ text: text.slice(last, run.start), code: false });
    segments.push({ text: text.slice(run.start, run.end), code: true });
    last = run.end;
  }
  if (last < text.length) segments.push({ text: text.slice(last), code: false });
  return segments.length ? segments : [{ text, code: false }];
}

// A run counts as a "block" (own line, pretty-printed) rather than a short
// inline chip once it has more than one statement/brace — a single call
// like "analogWrite(9, 255);" still reads fine inline.
function isCodeBlock(text) {
  return text.length > 40 || (text.match(/[;{}]/g) || []).length > 1;
}

// Crude pretty-printer: since extraction already collapses all whitespace
// to single spaces, there is no original line structure left to preserve —
// this reintroduces one line per statement/brace level so a whole program
// isn't shown as a single dense run. Not a real formatter (no nested
// indentation, doesn't special-case for-loop semicolons), but it's a large
// legibility win over one unbroken line for typical exam-sized snippets.
function prettifyBlock(text) {
  return text
    .replace(/\{\s*/g, '{\n  ')
    .replace(/\s*\}/g, '\n}')
    .replace(/;\s*/g, ';\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

// Renders text into a container element, wrapping detected code runs in
// <code class="inline-code"> (short) or <pre class="code-block"> (long).
// Replaces any existing children.
export function renderWithCode(container, text) {
  container.replaceChildren();
  for (const seg of splitCodeRuns(text)) {
    if (!seg.text) continue;
    if (seg.code && isCodeBlock(seg.text)) {
      const pre = document.createElement('pre');
      pre.className = 'code-block';
      const code = document.createElement('code');
      code.textContent = prettifyBlock(seg.text);
      pre.append(code);
      container.append(pre);
    } else if (seg.code) {
      const code = document.createElement('code');
      code.className = 'inline-code';
      code.textContent = seg.text;
      container.append(code);
    } else {
      container.append(document.createTextNode(seg.text));
    }
  }
}

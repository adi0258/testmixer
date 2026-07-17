// Detects inline source-code fragments (Arduino/C-like) within otherwise
// plain question/option text and renders them in a distinct monospace,
// LTR style — so a snippet like "analogWrite(9, 255);" reads clearly
// instead of blending into the surrounding Hebrew RTL prose.

// Function-call arguments, allowing one level of nested calls (e.g.
// Serial.println(digitalRead(2))) — common in this app's Arduino/C exams.
// Not a full recursive balanced-paren matcher (regex can't do unbounded
// nesting), but one level covers realistic exam code.
const CALL_ARGS = String.raw`[^()]*(?:\([^()]*\)[^()]*)*`;
const CODE_TOKEN = String.raw`(?:\b(?:void|int|float|double|bool|char|String|const)\b|[{}]|;|[A-Za-z_][\w.]*\s*\(${CALL_ARGS}\))`;
const CODE_RUN_RE = new RegExp(`${CODE_TOKEN}(?:\\s*${CODE_TOKEN})*`, 'g');

// Splits text into an array of {text, code:boolean} segments.
export function splitCodeRuns(text) {
  const segments = [];
  let last = 0;
  CODE_RUN_RE.lastIndex = 0;
  let m;
  while ((m = CODE_RUN_RE.exec(text)) !== null) {
    if (m.index > last) segments.push({ text: text.slice(last, m.index), code: false });
    segments.push({ text: m[0], code: true });
    last = CODE_RUN_RE.lastIndex;
  }
  if (last < text.length) segments.push({ text: text.slice(last), code: false });
  return segments.length ? segments : [{ text, code: false }];
}

// Renders text into a container element, wrapping detected code runs in
// <code class="inline-code">. Replaces any existing children.
export function renderWithCode(container, text) {
  container.replaceChildren();
  for (const seg of splitCodeRuns(text)) {
    if (!seg.text) continue;
    if (seg.code) {
      const code = document.createElement('code');
      code.className = 'inline-code';
      code.textContent = seg.text;
      container.append(code);
    } else {
      container.append(document.createTextNode(seg.text));
    }
  }
}

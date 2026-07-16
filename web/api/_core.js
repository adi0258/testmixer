// Shared grading logic: asks ChatGPT to independently determine the correct
// answer for each question (never trusting the source document's marking).
// Used by both the Vercel serverless function and the Vite dev middleware.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';
// Validation needs more careful judgment than grading (it must avoid false
// positives on legitimate questions), so it uses the stronger model.
const VALIDATE_MODEL = 'gpt-4o';

const SYSTEM_PROMPT = `אתה בודק מבחנים מומחה. תקבל רשימת שאלות אמריקאיות (רב-ברירה), לעיתים עם תמונות.
לכל שאלה קבע בעצמך מהי התשובה הנכונה מבין האפשרויות, לפי ידע מקצועי בלבד.
אל תניח שאפשרות מסוימת נכונה לפי מיקומה — נתח כל שאלה לגופה.
החזר JSON בלבד במבנה: {"answers":[{"id":<מספר השאלה>,"correct":<אינדקס האפשרות הנכונה, מתחיל מ-0>,"confidence":"high"|"low"}]}
חובה להחזיר תשובה לכל שאלה שקיבלת.`;

/**
 * @param questions [{id, text, options: [string], images: [dataUri]}]
 * @param apiKey OpenAI API key
 * @returns {answers: [{id, correct, confidence}]}
 */
export async function gradeQuestions(questions, apiKey) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('no questions to grade');
  }
  if (questions.length > 50) throw new Error('too many questions');

  const content = [];
  for (const q of questions) {
    const opts = q.options.map((o, i) => `${i}) ${o}`).join('\n');
    content.push({ type: 'text', text: `שאלה ${q.id}:\n${q.text}\nאפשרויות:\n${opts}` });
    for (const img of q.images || []) {
      if (typeof img === 'string' && img.startsWith('data:image/')) {
        content.push({ type: 'image_url', image_url: { url: img, detail: 'low' } });
      }
    }
  }

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  if (!Array.isArray(parsed.answers)) throw new Error('unexpected model response');
  return { answers: parsed.answers };
}

const VALIDATE_PROMPT = `אתה בודק איכות של שאלות אמריקאיות שחולצו אוטומטית מתוך קובצי Word/PDF על ידי סקריפט —
לעיתים החילוץ האוטומטי פוגם במבנה. סמן שאלה כלא תקינה (ok:false) אם מתקיים אחד מאלה:
1. אחת או יותר מהתשובות אינן קשורות עניינית לנושא השאלה (לדוגמה שאלה על חיישן אחד ("הסמקה") אך התשובות
   מדברות על חיישן אחר ("כעס") — סימן שהתשובות נלקחו בטעות משאלה שכנה).
2. טקסט השאלה מסתיים בקטע קצר שנראה כמו תשובה שנדבקה אליו בטעות: השאלה מסתיימת ב"?" (סימן שאלה תקין וסביר
   מבחינה תחבירית), ומיד אחריו מופיע עוד ביטוי קצר (כמה מילים, קוד, רשימה) שאינו חלק מהשאלה עצמה אלא נשמע
   כמו אחת האפשרויות. דוגמה: השאלה "...כדי שהיא תיחשב תכנית תקינה? setup, loop" — כאן "setup, loop" הוא
   ביטוי טכני קצר שנדבק אחרי סימן השאלה ונראה כמו תשובה א' שאיבדה את הסימון שלה ולא כחלק מגוף השאלה. סמן
   מקרים כאלה כ-ok:false גם אם התשובות הקיימות סבירות בפני עצמן, כי חסרה תשובה.
3. יש פחות משתי תשובות תקינות, או שהתשובות קטועות/חסרות הקשר.
אל תבדוק אם התשובות נכונות עובדתית מבחינה מדעית/עובדתית — רק אם החילוץ הגיוני ותואם מבנית.
היה שמרן: סמן ok:false רק כאשר אתה בטוח ברמה גבוהה שיש בעיית חילוץ אמיתית. שאלה עם תשובות סבירות שכולן
שייכות לאותו נושא היא תקינה (ok:true) גם אם היא לא "מושלמת" מבחינה פדגוגית. כל שאלה נבדקת בפני עצמה בלבד —
אל תשווה או תערבב תשובות בין שאלות שונות ברשימה.
החזר JSON בלבד: {"checks":[{"id":<מספר>,"ok":true|false,"issue":"<תיאור קצר וממוקד בעברית של הבעיה, רק אם ok=false>"}]}
חובה להחזיר בדיקה לכל שאלה שקיבלת, עם אותו מספר id שניתן לה.`;

/**
 * Sanity-check extracted questions: do the options logically belong to the
 * question? Returns {checks: [{id, ok, issue}]}.
 */
export async function validateQuestions(questions, apiKey) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('no questions to validate');
  }
  if (questions.length > 40) throw new Error('too many questions');

  const text = questions
    .map(
      (q) =>
        `שאלה ${q.id}:\n${q.text}\nתשובות:\n${q.options
          .map((o, i) => `${i}) ${o}`)
          .join('\n')}`,
    )
    .join('\n\n');

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: VALIDATE_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: VALIDATE_PROMPT },
        { role: 'user', content: text },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  if (!Array.isArray(parsed.checks)) throw new Error('unexpected model response');
  return { checks: parsed.checks };
}

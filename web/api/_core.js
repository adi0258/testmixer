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

const VALIDATE_PROMPT = `אתה בודק ומתקן שאלות אמריקאיות (רב-ברירה) שחולצו אוטומטית מתוך קובצי Word/PDF על ידי
סקריפט — לעיתים החילוץ פוגם במבנה. לכל שאלה שקיבלת בדוק את הבעיות הבאות:

1. אחת או יותר מהתשובות אינן קשורות עניינית לנושא השאלה (לדוגמה שאלה על חיישן אחד ("הסמקה") אך התשובות
   מדברות על חיישן אחר ("כעס") — סימן שהתשובות נלקחו בטעות משאלה שכנה). אין דרך אמינה לתקן זאת — סמן
   ok:false בלי fix.
2. טקסט השאלה מסתיים בקטע קצר שנראה כמו תשובה שנדבקה אליו בטעות: השאלה מסתיימת ב"?" (סימן שאלה תקין וסביר
   מבחינה תחבירית), ומיד אחריו מופיע עוד ביטוי קצר (כמה מילים, קוד, מונח טכני) שאינו המשך טבעי של השאלה
   עצמה אלא נשמע כמו אחת האפשרויות. דוגמה: השאלה "...כדי שהיא תיחשב תכנית תקינה? setup, loop" — כאן
   "setup, loop" הוא ביטוי שנדבק אחרי סימן השאלה ולמעשה הוא תשובה א' שאיבדה את הסימון שלה. במקרה כזה תקן:
   הסר את הביטוי מסוף טקסט השאלה, והוסף אותו כתשובה ראשונה חדשה ברשימת ה-fix, לפני שאר התשובות הקיימות.
3. אחת מ"התשובות" היא בעצם הערה מנהלתית על מבנה הבחינה ולא אפשרות תשובה אמיתית — לדוגמה "שאלות 8, 9 הן
   בלוק, נא לא לערבל" או הערות דומות על סדר/קיבוץ שאלות. תקן על ידי הסרת אותה שורה מרשימת התשובות ב-fix
   (התשובות האמיתיות הנותרות בלבד).
4. שאלה אמריקאית תקינה במאגר הזה חייבת לכלול לפחות 4 תשובות אמיתיות. אם אחרי תיקון הבעיות 2-3 (שחזור תשובה
   שנדבקה, הסרת הערה מנהלתית) נותרות פחות מ-4 תשובות אמיתיות — סמן ok:false; ספק fix רק אם אתה בטוח שהוא
   משחזר את המבנה הנכון במלואו (כולל 4 תשובות ומעלה). אם לא בטוח, השאר fix ריק.

כאשר אתה מספק fix, כלול את כל התשובות התקינות (כולל תשובות שלא היה בהן שום פגם), בסדר המקורי, פלוס כל
תשובה ששוחזרה. טקסט השאלה ב-fix צריך להיות נקי משאריות של תשובות.
אל תבדוק אם התשובות נכונות עובדתית מבחינה מדעית — רק אם החילוץ הגיוני ותואם מבנית.
היה שמרן: סמן ok:false רק כאשר אתה בטוח ברמה גבוהה שיש בעיית חילוץ אמיתית, וספק fix רק כשאתה בטוח שהוא
מדויק. שאלה עם תשובות סבירות (4 ומעלה) שכולן שייכות לאותו נושא היא תקינה (ok:true) גם אם היא לא "מושלמת"
מבחינה פדגוגית. כל שאלה נבדקת בפני עצמה בלבד — אל תשווה או תערבב תשובות בין שאלות שונות ברשימה.
החזר JSON בלבד:
{"checks":[{"id":<מספר>,"ok":true|false,"issue":"<תיאור קצר בעברית, רק אם ok=false>","fix":{"text":"<טקסט שאלה מתוקן>","options":["<תשובה 1>","<תשובה 2>","..."]}}]}
שדה fix הוא אופציונלי — כללו אותו רק כשיש תיקון מהימן ומלא (4 תשובות ומעלה). חובה להחזיר בדיקה לכל שאלה
שקיבלת, עם אותו מספר id שניתן לה.`;

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

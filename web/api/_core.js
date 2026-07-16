// Shared grading logic: asks ChatGPT to independently determine the correct
// answer for each question (never trusting the source document's marking).
// Used by both the Vercel serverless function and the Vite dev middleware.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';

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

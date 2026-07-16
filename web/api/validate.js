// Vercel serverless function: POST /api/validate
// Body: {questions: [{id, text, options}]}
// Asks ChatGPT whether each extracted question's options logically match it.

import { validateQuestions } from './_core.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  try {
    const result = await validateQuestions(
      req.body?.questions,
      process.env.OPENAI_API_KEY,
    );
    res.status(200).json(result);
  } catch (err) {
    console.error('validate error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
}

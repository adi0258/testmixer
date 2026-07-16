// Vercel serverless function: POST /api/grade
// Body: {questions: [{id, text, options, images}]}
// The OpenAI key comes from the OPENAI_API_KEY environment variable
// (set it in Vercel: Project Settings → Environment Variables).

import { gradeQuestions } from './_core.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  try {
    const result = await gradeQuestions(
      req.body?.questions,
      process.env.OPENAI_API_KEY,
    );
    res.status(200).json(result);
  } catch (err) {
    console.error('grade error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
}

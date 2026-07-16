import { defineConfig, loadEnv } from 'vite';
import { gradeQuestions, validateQuestions } from './api/_core.js';

// Dev-only /api endpoints mirroring the Vercel serverless functions, so the
// simulator and question validation work locally with `npm run dev`. The key
// is read from web/.env.local (OPENAI_API_KEY) and never reaches the client.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, '');

  const jsonEndpoint = (handler) => (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      res.setHeader('Content-Type', 'application/json');
      try {
        const { questions } = JSON.parse(body);
        const result = await handler(questions, env.OPENAI_API_KEY);
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('api error:', err);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err.message || err) }));
      }
    });
  };

  return {
    plugins: [
      {
        name: 'dev-api',
        configureServer(server) {
          server.middlewares.use('/api/grade', jsonEndpoint(gradeQuestions));
          server.middlewares.use('/api/validate', jsonEndpoint(validateQuestions));
        },
      },
    ],
  };
});

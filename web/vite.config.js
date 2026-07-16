import { defineConfig, loadEnv } from 'vite';
import { gradeQuestions } from './api/_core.js';

// Dev-only /api/grade endpoint mirroring the Vercel serverless function,
// so the simulator works locally with `npm run dev`. The key is read from
// web/.env.local (OPENAI_API_KEY) and never reaches the client bundle.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, '');
  return {
    plugins: [
      {
        name: 'dev-grade-api',
        configureServer(server) {
          server.middlewares.use('/api/grade', (req, res) => {
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
                const result = await gradeQuestions(questions, env.OPENAI_API_KEY);
                res.end(JSON.stringify(result));
              } catch (err) {
                console.error('grade error:', err);
                res.statusCode = 500;
                res.end(JSON.stringify({ error: String(err.message || err) }));
              }
            });
          });
        },
      },
    ],
  };
});

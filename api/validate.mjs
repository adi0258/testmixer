// Vercel serverless function entry (repo-root api/ directory).
// The real implementation lives in web/api/validate.js so it also works
// when the Vercel project's Root Directory is set to "web".
export { default } from '../web/api/validate.js';

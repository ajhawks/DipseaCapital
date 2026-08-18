import { config } from 'dotenv';
config({ path: new URL('../../.env', import.meta.url).pathname });
import express from 'express';
import { authMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';
import healthRouter from './routes/health.js';
import parseRouter from './routes/parse.js';
import draftRouter from './routes/draft.js';

const app = express();
const PORT = process.env['PORT'] ? parseInt(process.env['PORT'], 10) : 3001;

// Global middleware
app.use(express.json());
app.use(requestLogger);

// Routes — health is public; parse and draft require auth
app.use('/api/health', healthRouter);
app.use('/api/parse', authMiddleware, parseRouter);
app.use('/api/draft', authMiddleware, draftRouter);

// Error handler must be registered last
app.use(errorHandler);

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ event: 'server_start', port: PORT }));
});

// Graceful shutdown on SIGTERM (container orchestrators send this before killing)
process.on('SIGTERM', () => {
  server.close(() => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ event: 'server_stop', reason: 'SIGTERM' }));
    process.exit(0);
  });
});

export { app };

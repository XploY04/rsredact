import { openaiProvider } from '../providers/openai.js';
import { createRedactServer } from './server.js';

const DEFAULT_MODEL = 'gpt-4.1';

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');

const model = process.env.RSREDACT_MODEL || DEFAULT_MODEL;
const port = positiveInt('PORT', 8080);

const server = createRedactServer({
  provider: openaiProvider({ model }),
  model,
  apiToken: process.env.RSREDACT_API_TOKEN || undefined,
  maxConcurrency: positiveInt('RSREDACT_MAX_CONCURRENCY', 2),
  maxQueue: positiveInt('RSREDACT_MAX_QUEUE', 20),
});

server.listen(port, () => {
  process.stdout.write(`${JSON.stringify({ level: 'info', msg: 'listening', port, model })}\n`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

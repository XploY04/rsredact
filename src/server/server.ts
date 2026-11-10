import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { redact } from '../pipeline.js';
import { ProviderError, RedactError } from '../errors.js';
import type { LLMProvider, RedactOptions, TargetInput } from '../types.js';
import { HANDLE } from './handle.js';
import { buildKnownTargets, KnownValuesError, parseKnown } from './known.js';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Room for the multipart boundaries and the `known` field on top of the file. */
const MAX_BODY_BYTES = MAX_FILE_BYTES + 1024 * 1024;

const BASE_TARGETS: TargetInput[] = ['email', 'phone', 'social', 'url', HANDLE];

const BASE_OPTIONS = {
  mode: 'text',
  opaqueContent: 'vision',
  style: 'box',
  linkText: 'redact-identifying',
  maxPages: 20,
  ocr: false,
} satisfies Omit<RedactOptions, 'targets'>;

/** pdf.js names for a file it cannot open: corrupt, truncated, or encrypted. */
const UNREADABLE_PDF = new Set([
  'InvalidPDFException',
  'MissingPDFException',
  'PasswordException',
  'FormatError',
  'UnknownErrorException',
]);

export interface ServerOptions {
  provider: LLMProvider;
  /** Model name, folded into the version header so a cached copy can tell it is stale. */
  model: string;
  /** When set, every redact call must send `Authorization: Bearer <token>`. */
  apiToken?: string;
  maxConcurrency: number;
  maxQueue: number;
  /** Deadline for a whole request, from arrival, including any wait in the queue. */
  requestTimeoutMs: number;
  log?: (line: string) => void;
}

export interface RequestLog {
  method: string;
  path: string;
  status: number;
  error?: string;
  duration_ms: number;
  pages?: number;
  detections?: Record<string, number>;
  llm_calls?: number;
  model_ms?: number;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

class QueueFullError extends Error {}

/** The client hung up. Nobody will read the answer, so the work stops. */
class ClientGoneError extends Error {}

/**
 * A fixed number of redactions in flight, a bounded line behind them, and 429
 * past that. A place is taken synchronously on arrival, before the body is
 * read, so the check and the reservation cannot race, and a queued request's
 * body stays in the socket instead of in memory.
 */
class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number, private readonly maxQueue: number) {}

  acquire(signal: AbortSignal): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.maxQueue) return Promise.reject(new QueueFullError());

    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiting.indexOf(grant);
        if (index !== -1) this.waiting.splice(index, 1);
        reject(signal.reason);
      };
      const grant = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(grant);
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}

export function serverVersion(model: string): string {
  const options = {
    ...BASE_OPTIONS,
    model,
    targets: BASE_TARGETS.map((t) => (typeof t === 'string' ? t : `${t.id}:${t.patterns?.map(String).join(',')}`)),
  };
  const hash = createHash('sha256').update(JSON.stringify(options)).digest('hex').slice(0, 12);
  return `${packageVersion()}+${hash}`;
}

export function createRedactServer(options: ServerOptions): Server {
  const limiter = new Limiter(options.maxConcurrency, options.maxQueue);
  const version = serverVersion(options.model);
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }

    const started = Date.now();
    const entry: RequestLog = { method: req.method ?? '', path, status: 0, duration_ms: 0 };

    const controller = new AbortController();
    const deadline = setTimeout(
      () =>
        controller.abort(
          new HttpError(500, 'timeout', `redaction did not finish within ${options.requestTimeoutMs} ms`),
        ),
      options.requestTimeoutMs,
    );
    const closed = new Promise<void>((resolve) =>
      res.once('close', () => {
        if (!res.writableFinished) controller.abort(new ClientGoneError());
        resolve();
      }),
    );

    const work = handle(req, res, entry, { options, limiter, version, started, signal: controller.signal })
      .catch((error: unknown) => {
        // Whatever the work threw after an abort, the abort is the reason it stopped.
        const cause = controller.signal.aborted ? controller.signal.reason : error;
        const failure = toHttpError(cause);
        entry.error = failure.code;
        if (failure.status === 500) {
          log(JSON.stringify({ level: 'error', path, error: errorSummary(error) }));
        }
        sendError(res, failure);
      })
      .finally(() => {
        clearTimeout(deadline);
        entry.duration_ms = Date.now() - started;
      });

    // Logged once the response is fully out or the client is gone, so the status is what happened.
    void Promise.all([work, closed]).then(() => {
      if (res.writableFinished) {
        entry.status = res.statusCode;
      } else {
        entry.status = 499;
        entry.error ??= 'client_closed';
      }
      log(JSON.stringify(entry));
    });
  });
  // Queued requests leave their body unread until a slot frees, so Node's own
  // request timeout must not fire before ours does.
  server.requestTimeout = options.requestTimeoutMs + 10_000;
  return server;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  entry: RequestLog,
  ctx: { options: ServerOptions; limiter: Limiter; version: string; started: number; signal: AbortSignal },
): Promise<void> {
  if (entry.path !== '/v1/redact') throw new HttpError(404, 'not_found', 'no such route');
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'use POST');
  if (ctx.options.apiToken && !authorised(req.headers.authorization, ctx.options.apiToken)) {
    throw new HttpError(401, 'unauthorized', 'missing or wrong bearer token');
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, 'too_large', `file is over ${MAX_FILE_BYTES} bytes`);
  }
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new HttpError(400, 'bad_request', 'send multipart/form-data with a file field');
  }

  await ctx.limiter.acquire(ctx.signal);
  try {
    ctx.signal.throwIfAborted();
    const body = await readBody(req, MAX_BODY_BYTES, ctx.signal);
    let form: FormData;
    try {
      form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
    } catch {
      throw new HttpError(400, 'bad_request', 'could not parse the multipart body');
    }

    const file = form.get('file');
    if (!(file instanceof Blob)) throw new HttpError(400, 'bad_request', 'file is required');
    if (file.size > MAX_FILE_BYTES) {
      throw new HttpError(413, 'too_large', `file is over ${MAX_FILE_BYTES} bytes`);
    }
    if (file.size === 0) throw new HttpError(400, 'bad_request', 'file is empty');

    const knownField = form.get('known');
    if (knownField !== null && typeof knownField !== 'string') {
      throw new HttpError(400, 'bad_request', 'known must be a text field');
    }
    const known = parseKnown(knownField);

    const pdf = Buffer.from(await file.arrayBuffer());
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new HttpError(422, 'unsupported', 'file is not a PDF');
    }

    let modelMs = 0;
    const timed: LLMProvider = {
      name: ctx.options.provider.name,
      supportsVision: ctx.options.provider.supportsVision,
      async generateJson<T>(request: Parameters<LLMProvider['generateJson']>[0]): Promise<T> {
        ctx.signal.throwIfAborted();
        const callStarted = Date.now();
        try {
          return await ctx.options.provider.generateJson<T>({ ...request, signal: ctx.signal });
        } finally {
          modelMs += Date.now() - callStarted;
        }
      },
    };

    const result = await redact(pdf, {
      ...BASE_OPTIONS,
      targets: [...BASE_TARGETS, ...buildKnownTargets(known)],
      provider: timed,
    });
    entry.pages = result.audit.pages;
    entry.detections = result.audit.detectionCounts;
    entry.llm_calls = result.audit.llmCalls;
    entry.model_ms = modelMs;

    // Text mode cannot read a page with no text layer, and would return it unredacted.
    if (result.audit.textSources.includes('none')) {
      throw new HttpError(422, 'scanned', 'a page has no text layer, so it cannot be redacted');
    }
    const output = result.pdf!;
    if (!(await isClean(output))) {
      throw new HttpError(422, 'verification_failed', 'redacted output still carries text or links');
    }
    ctx.signal.throwIfAborted();

    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': output.length,
      'X-Rsredact-Duration-Ms': String(Date.now() - ctx.started),
      'X-Rsredact-Model-Ms': String(modelMs),
      'X-Rsredact-Llm-Calls': String(result.audit.llmCalls),
      'X-Rsredact-Detections': JSON.stringify(result.audit.detectionCounts),
      'X-Rsredact-Version': ctx.version,
    });
    res.end(output);
  } finally {
    ctx.limiter.release();
  }
}

/** Every page must come back with no text items and no annotations at all. */
async function isClean(pdf: Buffer): Promise<boolean> {
  const doc = await getDocument({ data: new Uint8Array(pdf), isEvalSupported: false }).promise;
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      if ((await page.getTextContent()).items.length !== 0) return false;
      if ((await page.getAnnotations()).length !== 0) return false;
    }
    return true;
  } finally {
    await doc.destroy();
  }
}

function readBody(req: IncomingMessage, limit: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    const settle = () => signal.removeEventListener('abort', onAbort);

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners('data');
        req.resume();
        settle();
        reject(new HttpError(413, 'too_large', `file is over ${MAX_FILE_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      settle();
      resolve(Buffer.concat(chunks));
    });
    req.on('close', () => {
      if (req.complete) return;
      settle();
      reject(new ClientGoneError());
    });
    req.on('error', (error) => {
      settle();
      reject(error);
    });
  });
}

function authorised(header: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!match) return false;
  // Hashing first gives equal-length buffers, which timingSafeEqual requires.
  const given = createHash('sha256').update(match[1]!.trim()).digest();
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(given, expected);
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof KnownValuesError) return new HttpError(400, 'bad_request', error.message);
  if (error instanceof QueueFullError) {
    return new HttpError(429, 'queue_full', 'too many redactions in progress, retry later');
  }
  if (error instanceof ClientGoneError) {
    return new HttpError(499, 'client_closed', 'client went away');
  }
  const err = error as { code?: unknown; name?: unknown; message?: unknown };
  if (err?.code === 'UNSUPPORTED_INPUT') {
    return new HttpError(422, 'unsupported', String(err.message));
  }
  if (error instanceof RedactError && error.code === 'VISION_UNAVAILABLE') {
    return new HttpError(
      422,
      'unsupported',
      'a page has images, form fields, or annotations, and vision detection is unavailable',
    );
  }
  if (typeof err?.name === 'string' && UNREADABLE_PDF.has(err.name)) {
    return new HttpError(422, 'unsupported', 'the PDF could not be read');
  }
  if (error instanceof ProviderError) {
    return new HttpError(500, 'provider_error', 'the model call failed');
  }
  return new HttpError(500, 'internal', 'redaction failed');
}

/**
 * What went wrong, without what the document said. A provider error's message
 * and its causes' messages can quote the model's reply, which quotes the CV, so
 * for those only names and HTTP statuses are kept.
 */
function errorSummary(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error thrown';
  if (!(error instanceof ProviderError)) return `${error.name}: ${error.message}`;

  const chain = [`${error.name} from ${error.provider}`];
  let cause = error.cause;
  while (cause instanceof Error) {
    const status = (cause as { status?: unknown }).status;
    chain.push(typeof status === 'number' ? `${cause.name} (status ${status})` : cause.name);
    cause = cause.cause;
  }
  return chain.join(' <- ');
}

function sendError(res: ServerResponse, error: HttpError): void {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // The body may still be arriving; do not keep a connection open to drain it.
  if (error.status === 413 || error.status === 429 || error.status === 401) headers.Connection = 'close';
  res.writeHead(error.status, headers);
  res.end(JSON.stringify({ error: error.code, message: error.message }));
}

let cachedVersion: string | undefined;

function packageVersion(): string {
  if (cachedVersion) return cachedVersion;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === '@remotestar/rsredact' && pkg.version) {
        cachedVersion = pkg.version;
        return pkg.version;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('could not find the rsredact package.json');
    dir = parent;
  }
}

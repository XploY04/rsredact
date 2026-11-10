import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { customProvider } from '../src/providers/index.js';
import { openaiProvider } from '../src/providers/openai.js';
import { buildKnownTargets, KnownValuesError, parseKnown } from '../src/server/known.js';
import { createRedactServer, MAX_FILE_BYTES, type ServerOptions } from '../src/server/server.js';
import type { LLMProvider } from '../src/types.js';
import { buildSampleCv } from './fixture.js';

const EMPTY_REPLY = { redactions: [] };

function matchesAny(targets: ReturnType<typeof buildKnownTargets>, text: string): boolean {
  return targets.some((target) =>
    (target.patterns ?? []).some((pattern) => new RegExp(pattern.source, pattern.flags).test(text)),
  );
}

async function startServer(
  overrides: Partial<ServerOptions> = {},
): Promise<{ url: string; logs: string[]; close: () => Promise<void> }> {
  const logs: string[] = [];
  const server = createRedactServer({
    provider: customProvider({ name: 'test', generate: async () => EMPTY_REPLY }),
    model: 'test-model',
    maxConcurrency: 2,
    maxQueue: 20,
    log: (line) => logs.push(line),
    ...overrides,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    logs,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function redactCall(
  url: string,
  pdf: Buffer | Blob,
  init: { known?: unknown; token?: string } = {},
): Promise<Response> {
  const form = new FormData();
  form.set('file', pdf instanceof Blob ? pdf : new Blob([pdf], { type: 'application/pdf' }), 'cv.pdf');
  if (init.known !== undefined) {
    form.set('known', typeof init.known === 'string' ? init.known : JSON.stringify(init.known));
  }
  const headers: Record<string, string> = {};
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  return fetch(`${url}/v1/redact`, { method: 'POST', body: form, headers });
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

async function textItemCount(pdf: Buffer): Promise<number> {
  const doc = await getDocument({ data: new Uint8Array(pdf) }).promise;
  let count = 0;
  for (let n = 1; n <= doc.numPages; n++) {
    count += (await (await doc.getPage(n)).getTextContent()).items.length;
  }
  await doc.destroy();
  return count;
}

test('known LinkedIn URL catches a wrapped slug tail but never the plain name', () => {
  const targets = buildKnownTargets(
    parseKnown(JSON.stringify({ urls: ['https://www.linkedin.com/in/yash-singh-gour/'] })),
  );

  assert.ok(matchesAny(targets, '-singh-gour'), 'wrapped tail was not matched');
  assert.ok(matchesAny(targets, 'linkedin.com/in/yash-singh-gour'), 'bare URL was not matched');
  assert.ok(matchesAny(targets, 'https://www.linkedin.com/in/yash-singh-gour'), 'full URL was not matched');
  assert.ok(!matchesAny(targets, 'Yash Singh Gour'), 'the name in the header was matched');
  assert.ok(!matchesAny(targets, 'Singh Gour'), 'the surname was matched');
  // "-gour" is under six characters, so it is left alone rather than risk a common word.
  assert.ok(!matchesAny(targets, '-gour'), 'a short suffix was matched');
  assert.ok(!matchesAny(targets, 'full-stack-singh-gourmet'), 'a suffix matched inside a longer word');
});

test('known GitHub URL yields slug suffixes too', () => {
  const targets = buildKnownTargets(parseKnown(JSON.stringify({ urls: ['github.com/priya-raghunathan-dev'] })));
  assert.ok(matchesAny(targets, '-raghunathan-dev'));
  assert.ok(matchesAny(targets, 'priya-raghunathan-dev'));
  assert.ok(!matchesAny(targets, 'Priya Raghunathan'));
});

test('known phone matches with or without +91, spaces, and dashes', () => {
  const targets = buildKnownTargets(parseKnown(JSON.stringify({ phones: ['+91 98765 43210'] })));
  for (const written of ['+91 98765 43210', '+91-98765-43210', '9876543210', '98765 43210', '+919876543210']) {
    assert.ok(matchesAny(targets, written), `${written} was not matched`);
  }
  assert.ok(!matchesAny(targets, '1987654321012'), 'matched inside a longer number');
});

test('known email matches regardless of case', () => {
  const targets = buildKnownTargets(parseKnown(JSON.stringify({ emails: ['Priya.R@Example.com'] })));
  assert.ok(matchesAny(targets, 'contact: priya.r@example.com'));
  assert.ok(!matchesAny(targets, 'priyaXr@example.com'), 'the dot was treated as a wildcard');
});

test('known rejects malformed input and accepts an absent field', () => {
  assert.deepEqual(parseKnown(null), { emails: [], phones: [], urls: [] });
  assert.throws(() => parseKnown('{not json'), KnownValuesError);
  assert.throws(() => parseKnown('[]'), KnownValuesError);
  assert.throws(() => parseKnown(JSON.stringify({ emails: 'a@b.com' })), KnownValuesError);
  assert.throws(() => parseKnown(JSON.stringify({ phones: [12345] })), KnownValuesError);
  assert.equal(buildKnownTargets(parseKnown(JSON.stringify({ phones: ['123'] }))).length, 0);
});

test('healthz answers without auth', async () => {
  const server = await startServer({ apiToken: 'secret' });
  try {
    const res = await fetch(`${server.url}/healthz`);
    assert.equal(res.status, 200);
  } finally {
    await server.close();
  }
});

test('a token, when configured, is required', async () => {
  const server = await startServer({ apiToken: 'secret' });
  const { bytes } = await buildSampleCv();
  try {
    const missing = await redactCall(server.url, bytes);
    assert.equal(missing.status, 401);
    assert.equal(await errorCode(missing), 'unauthorized');

    const wrong = await redactCall(server.url, bytes, { token: 'nope' });
    assert.equal(wrong.status, 401);

    const right = await redactCall(server.url, bytes, { token: 'secret' });
    assert.equal(right.status, 200);
    await right.arrayBuffer();
  } finally {
    await server.close();
  }
});

test('redacts the fixture CV, keeps the name, and reports what it did', async () => {
  const server = await startServer();
  // The tail of the LinkedIn slug, as it looks after a line wrap.
  const { bytes } = await buildSampleCv({ extraLine: '-raghunathan-2b' });
  try {
    const res = await redactCall(server.url, bytes, {
      known: {
        emails: ['priya.raghunathan@example.com'],
        phones: ['+919876543210'],
        urls: ['https://www.linkedin.com/in/priya-raghunathan-2b'],
      },
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('x-rsredact-version') ?? '', /^\d+\.\d+\.\d+\+[0-9a-f]{12}$/);
    assert.equal(res.headers.get('x-rsredact-llm-calls'), '1');
    assert.ok(Number(res.headers.get('x-rsredact-duration-ms')) >= 0);
    assert.ok(Number(res.headers.get('x-rsredact-model-ms')) >= 0);

    const counts = JSON.parse(res.headers.get('x-rsredact-detections') ?? '{}') as Record<string, number>;
    const labels = Object.keys(counts).join(' ');
    assert.match(labels, /email/);
    assert.match(labels, /phone/);
    assert.match(labels, /known_url/, 'the wrapped slug tail was not redacted');
    assert.doesNotMatch(labels, /\bname\b/);

    const pdf = Buffer.from(await res.arrayBuffer());
    assert.equal(await textItemCount(pdf), 0);

    // One line for the request, and none of it is a contact value.
    const line = JSON.parse(server.logs.at(-1)!) as Record<string, unknown>;
    assert.equal(line.status, 200);
    assert.equal(line.pages, 1);
    assert.equal(line.llm_calls, 1);
    for (const logged of server.logs) {
      assert.doesNotMatch(logged, /priya|98765|raghunathan/i);
    }
  } finally {
    await server.close();
  }
});

test('the name stays out of the model targets', async () => {
  const prompts: string[] = [];
  const server = await startServer({
    provider: customProvider({
      name: 'test',
      generate: async (request) => {
        prompts.push(request.prompt);
        return EMPTY_REPLY;
      },
    }),
  });
  const { bytes } = await buildSampleCv();
  try {
    const res = await redactCall(server.url, bytes);
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    assert.equal(prompts.length, 1);
    assert.doesNotMatch(prompts[0]!, /^- name:/m);
    assert.match(prompts[0]!, /^- handle:/m);
  } finally {
    await server.close();
  }
});

test('bad input is a 400, a non-PDF is a 422', async () => {
  const server = await startServer();
  const { bytes } = await buildSampleCv();
  try {
    const noFile = await fetch(`${server.url}/v1/redact`, { method: 'POST', body: new FormData() });
    assert.equal(noFile.status, 400);
    assert.equal(await errorCode(noFile), 'bad_request');

    const badKnown = await redactCall(server.url, bytes, { known: '{oops' });
    assert.equal(badKnown.status, 400);
    await badKnown.arrayBuffer();

    const notPdf = await redactCall(server.url, new Blob([Buffer.from('hello')]));
    assert.equal(notPdf.status, 422);
    assert.equal(await errorCode(notPdf), 'unsupported');
  } finally {
    await server.close();
  }
});

test('a page with no text layer is refused rather than returned unredacted', async () => {
  const server = await startServer();
  const canvas = createCanvas(600, 800);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, 600, 800);
  context.fillStyle = '#000000';
  context.font = '24px sans-serif';
  context.fillText('scanned.person@example.com', 40, 80);
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(canvas.toBuffer('image/png'));
  doc.addPage([600, 800]).drawImage(image, { x: 0, y: 0, width: 600, height: 800 });
  try {
    const res = await redactCall(server.url, Buffer.from(await doc.save()));
    assert.equal(res.status, 422);
    assert.equal(await errorCode(res), 'scanned');
  } finally {
    await server.close();
  }
});

test('a declared body over the limit is a 413 before it is read', async () => {
  const server = await startServer();
  try {
    const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(`${server.url}/v1/redact`, {
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=x',
          'Content-Length': String(MAX_FILE_BYTES * 2),
        },
      });
      req.on('response', (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: text });
          req.destroy();
        });
      });
      req.on('error', reject);
      req.flushHeaders();
    });
    assert.equal(status, 413);
    assert.equal(JSON.parse(body).error, 'too_large');
  } finally {
    await server.close();
  }
});

test('a file over 25 MiB inside a body under the limit is a 413', async () => {
  const server = await startServer();
  try {
    const big = new Blob([Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(MAX_FILE_BYTES)])]);
    const res = await redactCall(server.url, big);
    assert.equal(res.status, 413);
    assert.equal(await errorCode(res), 'too_large');
  } finally {
    await server.close();
  }
});

test('past the concurrency limit and the queue, callers get a 429', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const firstEntered = new Promise<void>((resolve) => (entered = resolve));

  const blocking: LLMProvider = customProvider({
    name: 'blocking',
    generate: async () => {
      entered();
      await gate;
      return EMPTY_REPLY;
    },
  });
  const server = await startServer({ provider: blocking, maxConcurrency: 1, maxQueue: 1 });
  const { bytes } = await buildSampleCv();
  try {
    const first = redactCall(server.url, bytes);
    await firstEntered;
    // One slot is busy and the queue holds one, so exactly one of these two is
    // turned away, and it is the only one that can answer before the gate opens.
    const second = redactCall(server.url, bytes);
    const third = redactCall(server.url, bytes);
    const rejected = await Promise.race([second, third]);
    assert.equal(rejected.status, 429);
    assert.equal(await errorCode(rejected), 'queue_full');

    release();
    const statuses = (await Promise.all([first, second, third])).map((res) => res.status).sort();
    assert.deepEqual(statuses, [200, 200, 429]);
  } finally {
    release();
    await server.close();
  }
});

test('a real OpenAI redaction, timed', { skip: !process.env.OPENAI_API_KEY && 'OPENAI_API_KEY not set' }, async () => {
  const model = process.env.RSREDACT_MODEL || 'gpt-4.1';
  const server = await startServer({ provider: openaiProvider({ model }), model });
  const { bytes } = await buildSampleCv();
  try {
    const res = await redactCall(server.url, bytes, {
      known: { urls: ['https://linkedin.com/in/priya-raghunathan'] },
    });
    assert.equal(res.status, 200, await res.clone().text());
    await res.arrayBuffer();
    console.log(
      `real redaction: total ${res.headers.get('x-rsredact-duration-ms')} ms, ` +
        `model ${res.headers.get('x-rsredact-model-ms')} ms, ` +
        `calls ${res.headers.get('x-rsredact-llm-calls')}, ` +
        `detections ${res.headers.get('x-rsredact-detections')}`,
    );
  } finally {
    await server.close();
  }
});

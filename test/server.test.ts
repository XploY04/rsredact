import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { redact } from '../src/index.js';
import { customProvider } from '../src/providers/index.js';
import { openaiProvider } from '../src/providers/openai.js';
import { ADDRESS } from '../src/server/address.js';
import { HANDLE } from '../src/server/handle.js';
import { buildKnownTargets, KnownValuesError, parseKnown } from '../src/server/known.js';
import { createRedactServer, MAX_FILE_BYTES, type ServerOptions } from '../src/server/server.js';
import type { LLMProvider, ProviderRequest } from '../src/types.js';
import { buildSampleCv } from './fixture.js';
import { buildPdf, splitProvider, textPng } from './pdfs.js';

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
    requestTimeoutMs: 30_000,
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
  init: { known?: unknown; token?: string; signal?: AbortSignal } = {},
): Promise<Response> {
  const form = new FormData();
  form.set('file', pdf instanceof Blob ? pdf : new Blob([pdf], { type: 'application/pdf' }), 'cv.pdf');
  if (init.known !== undefined) {
    form.set('known', typeof init.known === 'string' ? init.known : JSON.stringify(init.known));
  }
  const headers: Record<string, string> = {};
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  return fetch(`${url}/v1/redact`, { method: 'POST', body: form, headers, signal: init.signal });
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

function knownTargets(known: object) {
  return buildKnownTargets(parseKnown(JSON.stringify(known)));
}

test('known LinkedIn URL catches a wrapped slug on either side of the dash, never the name', () => {
  const targets = knownTargets({ urls: ['https://www.linkedin.com/in/yash-singh-gour/'] });

  // Wrapped before the dash, and after it, which is the usual place.
  assert.ok(matchesAny(targets, '-singh-gour'), 'tail with a leading dash was not matched');
  assert.ok(matchesAny(targets, 'singh-gour'), 'tail at the start of a line was not matched');
  assert.ok(matchesAny(targets, '• singh-gour | GitHub'), 'tail after a bullet was not matched');
  assert.ok(matchesAny(targets, 'linkedin.com/in/yash-singh-gour'), 'bare URL was not matched');
  assert.ok(matchesAny(targets, 'https://www.linkedin.com/in/yash-singh-gour'), 'full URL was not matched');
  assert.ok(matchesAny(targets, 'in/yash-singh-gour'), 'slug after a slash was not matched');

  assert.ok(!matchesAny(targets, 'Yash Singh Gour'), 'the name in the header was matched');
  assert.ok(!matchesAny(targets, 'Singh Gour'), 'the surname was matched');
  assert.ok(!matchesAny(targets, '-gour'), 'a short suffix was matched');
  assert.ok(!matchesAny(targets, 'full-stack-singh-gourmet'), 'a suffix matched inside a longer word');
});

test('hyphenated names stay readable next to a slug that contains them', () => {
  assert.ok(!matchesAny(knownTargets({ urls: ['linkedin.com/in/anne-marie-dupont'] }), 'Anne-Marie Dupont'));
  assert.ok(!matchesAny(knownTargets({ urls: ['linkedin.com/in/jean-pierre'] }), 'Jean-Pierre Martin'));
  assert.ok(!matchesAny(knownTargets({ urls: ['github.com/smith-jones'] }), 'Mary Smith-Jones'));
  assert.ok(!matchesAny(knownTargets({ urls: ['linkedin.com/in/mary-smith-jones'] }), 'Mary Smith-Jones'));
  // With a digit the whole slug cannot be a name, so it matches on its own.
  assert.ok(matchesAny(knownTargets({ urls: ['linkedin.com/in/jean-pierre-42'] }), 'jean-pierre-42'));
});

test('a one-word slug matches when it cannot be a name', () => {
  assert.ok(matchesAny(knownTargets({ urls: ['github.com/xploy04'] }), 'GitHub: xploy04'));
  assert.ok(matchesAny(knownTargets({ urls: ['github.com/jane_doe'] }), 'jane_doe'));
  assert.ok(matchesAny(knownTargets({ urls: ['github.com/janedoedev'] }), 'janedoedev'));
  assert.ok(!matchesAny(knownTargets({ urls: ['linkedin.com/in/priya'] }), 'Priya Raghunathan'));
  assert.ok(!matchesAny(knownTargets({ urls: ['github.com/xploy04'] }), 'xploy045'), 'matched inside a longer word');
});

test('a known profile URL does not match its own repositories', () => {
  const targets = knownTargets({ urls: ['https://github.com/xploy04'] });
  assert.ok(matchesAny(targets, 'https://github.com/xploy04/'));
  assert.ok(!new RegExp(targets[0]!.patterns![0]!.source, 'i').test('https://github.com/xploy04/pg-operator'));
});

test('known phone matches with or without +91, spaces, and dashes', () => {
  const targets = knownTargets({ phones: ['+91 98765 43210'] });
  for (const written of ['+91 98765 43210', '+91-98765-43210', '9876543210', '98765 43210', '+919876543210']) {
    assert.ok(matchesAny(targets, written), `${written} was not matched`);
  }
  assert.ok(!matchesAny(targets, '1987654321012'), 'matched inside a longer number');
});

test('known email matches regardless of case', () => {
  const targets = knownTargets({ emails: ['Priya.R@Example.com'] });
  assert.ok(matchesAny(targets, 'contact: priya.r@example.com'));
  assert.ok(!matchesAny(targets, 'priyaXr@example.com'), 'the dot was treated as a wildcard');
});

test('known values that cannot be what they claim are dropped', () => {
  const known = parseKnown(
    JSON.stringify({
      emails: ['na', 'someone@localhost', 'jane@example.com'],
      phones: ['-', '1234567', '+91 98765 43210'],
      urls: ['na', '-', 'linkedin', 'janedoe.dev'],
      names: ['-', 'Dr.', 'Jane Doe'],
    }),
  );
  assert.deepEqual(known, {
    emails: ['jane@example.com'],
    phones: ['+91 98765 43210'],
    urls: ['janedoe.dev'],
    names: ['Jane Doe'],
  });
});

test('known name matches the full name in any case and order, and its longer words written as a name', () => {
  const targets = knownTargets({ names: ['Dr. Yash Agarwal'] });
  for (const text of ['YASH AGARWAL', 'Yash Agarwal', 'yash agarwal', 'Agarwal, Yash', 'Resume of Yash', "Agarwal's portfolio", 'Y A S H'.replace(/ /g, '')]) {
    assert.ok(matchesAny(targets, text), `missed ${text}`);
  }
  // A lowercase word, part of a longer word, or the title alone is not the name.
  for (const text of ['agarwalla traders', 'Yashwant Rao', 'Dr. Mehta']) {
    assert.ok(!matchesAny(targets, text), `matched ${text}`);
  }
});

test('a short or ordinary name word is only matched inside the full name', () => {
  const targets = knownTargets({ names: ['Dev Mark'] });
  assert.ok(matchesAny(targets, 'DEV MARK'));
  assert.ok(matchesAny(targets, 'Mark, Dev'));
  assert.ok(!matchesAny(targets, 'Dev team lead for the dev tools group'), 'a three-letter word matched on its own');
  assert.ok(!matchesAny(targets, 'helped mark the release'), 'a lowercase word matched');
  assert.ok(matchesAny(targets, 'Reported to Mark'), 'the capitalised word is treated as the name');
});

test('handles are matched, annotations and package scopes are not', () => {
  const handle = (text: string) => [...text.matchAll(HANDLE.patterns![0]!)].map((m) => m[0]);
  assert.deepEqual(
    handle('Spring (@Transactional, @RestController), Angular (@ngrx/store, @types/node), Flask @app.route'),
    [],
  );
  assert.deepEqual(handle('Twitter: @priya_r, mail priya@example.com'), ['@priya_r']);
});

/** The text the address target redacts on a page with these lines under the name, top to bottom. */
async function addressHits(lines: string[]): Promise<string[]> {
  const pdf = await buildPdf((canvas) => {
    lines.forEach((text, i) => canvas.page.drawText(text, { x: 60, y: 700 - i * 14, size: 10, font: canvas.helvetica }));
  });
  const result = await redact(pdf, { targets: [ADDRESS], mode: 'patterns-only' });
  return result.detections.map((d) => d.text ?? '');
}

test('an address block loses its street, locality and PIN, and keeps the city', async () => {
  assert.deepEqual(
    await addressHits(['No. 42, 3rd Cross, 5th Main', 'HSR Layout, Sector 2', 'Bengaluru - 560102', 'Senior Backend Engineer']),
    ['No. 42, 3rd Cross, 5th Main', 'HSR Layout, Sector 2', '560102'],
  );
  assert.deepEqual(
    await addressHits(['#123, 4th Cross, 2nd Main', 'Koramangala 5th Block', 'Bengaluru, Karnataka 560095']),
    ['#123, 4th Cross, 2nd Main', 'Koramangala 5th Block', '560095'],
  );
  // A locality with no street word counts only between two lines of the address.
  assert.deepEqual(
    await addressHits(['Flat 302, Sunshine Apartments', 'Whitefield', 'Bengaluru 560066']),
    ['Flat 302, Sunshine Apartments', 'Whitefield', '560066'],
  );
});

test('an address on one line keeps its label, city, state and country', async () => {
  assert.deepEqual(
    await addressHits(['Address: H.No. 4-5-67, 12th Main Road, Indiranagar, Bengaluru, Karnataka 560038, India']),
    ['H.No. 4-5-67, 12th Main Road, Indiranagar', '560038'],
  );
  assert.deepEqual(await addressHits(['Mysuru, Karnataka | PIN: 570017']), ['570017']);
});

test('a city, an employer location and figures in the body are not an address', async () => {
  assert.deepEqual(
    await addressHits([
      'Bengaluru, India',
      'Senior Engineer, Acme Payments, Bengaluru, India 2019 - 2024',
      'Analyst, Main Street Capital, Mumbai, India',
      'Served 250000 users across 12 cities in India',
      'Ranked #1 in the Main track of a national hackathon',
      'Built the Main Block Storage layer with CSS Grid Layout',
      'Current CTC 950000',
      'Mobile: +91 987 654 3210',
    ]),
    [],
  );
});

test('known rejects malformed input and accepts an absent field', () => {
  assert.deepEqual(parseKnown(null), { emails: [], phones: [], urls: [], names: [] });
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

test('the name is one of the model targets', async () => {
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
    assert.match(prompts[0]!, /^- name:/m);
    assert.match(prompts[0]!, /^- handle:/m);
  } finally {
    await server.close();
  }
});

test('the server redacts the address and reports it', async () => {
  const server = await startServer();
  const { bytes } = await buildSampleCv({ extraLine: 'No. 42, 3rd Cross, HSR Layout, Bengaluru 560102' });
  try {
    const res = await redactCall(server.url, bytes);
    assert.equal(res.status, 200, await res.clone().text());
    await res.arrayBuffer();
    const counts = JSON.parse(res.headers.get('x-rsredact-detections') ?? '{}') as Record<string, number>;
    assert.equal(counts.address, 2, JSON.stringify(counts));
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

async function imageCv(): Promise<Buffer> {
  return buildPdf(async (canvas) => {
    canvas.page.drawText('Senior Engineer', { x: 60, y: 750, size: 12, font: canvas.helvetica });
    canvas.page.drawImage(await canvas.pdf.embedPng(textPng('img.person@example.com', 600, 60)), {
      x: 60, y: 500, width: 300, height: 30,
    });
  });
}

test('a page with an image is also checked by vision, and refused without it', async () => {
  const provider = splitProvider([{ target: 'email', rect: { x: 60, y: 500, width: 300, height: 30 } }]);
  const server = await startServer({ provider });
  try {
    const res = await redactCall(server.url, await imageCv());
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(res.headers.get('x-rsredact-llm-calls'), '2');
    assert.match(res.headers.get('x-rsredact-detections') ?? '', /email/);
    await res.arrayBuffer();
  } finally {
    await server.close();
  }

  const blind = await startServer({ provider: splitProvider([], { supportsVision: false }) });
  try {
    const res = await redactCall(blind.url, await imageCv());
    assert.equal(res.status, 422);
    assert.equal(await errorCode(res), 'unsupported');
  } finally {
    await blind.close();
  }
});

test('the model can only name requested targets, and nothing it says reaches logs or headers', async () => {
  const requests: ProviderRequest[] = [];
  const server = await startServer({
    provider: customProvider({
      name: 'test',
      generate: async (request) => {
        requests.push(request);
        return { redactions: [{ line: 6, quote: 'EXPERIENCE', target: 'skill \u2192 priya@example.com', confidence: 0.9 }] };
      },
    }),
  });
  const { bytes } = await buildSampleCv();
  try {
    const res = await redactCall(server.url, bytes);
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    assert.doesNotMatch(res.headers.get('x-rsredact-detections') ?? '', /skill/);
    for (const line of server.logs) assert.doesNotMatch(line, /skill|priya/);

    const target = (requests[0]!.schema.schema as { properties: { redactions: { items: { properties: { target: { enum?: string[] } } } } } })
      .properties.redactions.items.properties.target;
    assert.deepEqual(target.enum, ['name', 'email', 'phone', 'social', 'url', 'handle', 'address']);
  } finally {
    await server.close();
  }
});

test('a provider failure is logged without the model reply', async () => {
  const server = await startServer({
    provider: customProvider({
      name: 'test',
      generate: async () => {
        throw Object.assign(new Error('Could not parse the model reply as JSON: priya.raghunathan@example.com'), { status: 502 });
      },
    }),
  });
  const { bytes } = await buildSampleCv();
  try {
    const res = await redactCall(server.url, bytes);
    assert.equal(res.status, 500);
    assert.equal(await errorCode(res), 'provider_error');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const errorLine = server.logs.find((line) => line.includes('"level":"error"'));
    assert.ok(errorLine, 'the failure was not logged');
    assert.match(errorLine, /status 502/);
    for (const line of server.logs) assert.doesNotMatch(line, /priya|parse the model reply/);
  } finally {
    await server.close();
  }
});

/** A provider that hangs until its request is aborted, and records that it was. */
function hangingProvider(): LLMProvider & { aborted: Promise<void>; entered: Promise<void> } {
  let aborted!: () => void;
  let entered!: () => void;
  const abortedPromise = new Promise<void>((resolve) => (aborted = resolve));
  const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
  const provider = customProvider({
    name: 'hanging',
    generate: (request) =>
      new Promise((_, reject) => {
        entered();
        request.signal?.addEventListener('abort', () => {
          aborted();
          reject(new Error('aborted'));
        });
      }),
  });
  return Object.assign(provider, { aborted: abortedPromise, entered: enteredPromise });
}

test('a request past its deadline is answered with a timeout and its model call aborted', async () => {
  const provider = hangingProvider();
  const server = await startServer({ provider, requestTimeoutMs: 500 });
  const { bytes } = await buildSampleCv();
  try {
    const res = await redactCall(server.url, bytes);
    assert.equal(res.status, 500);
    assert.equal(await errorCode(res), 'timeout');
    await provider.aborted;
  } finally {
    await server.close();
  }
});

test('a client that hangs up frees its slot and is logged as 499', async () => {
  const provider = hangingProvider();
  const server = await startServer({ provider, maxConcurrency: 1, maxQueue: 0 });
  const { bytes } = await buildSampleCv();
  try {
    const hangUp = new AbortController();
    const first = redactCall(server.url, bytes, { signal: hangUp.signal }).catch(() => null);
    await provider.entered;
    hangUp.abort();
    await first;
    await provider.aborted;
    await new Promise((resolve) => setTimeout(resolve, 50));

    const line = JSON.parse(server.logs.at(-1)!) as { status: number; error: string };
    assert.equal(line.status, 499);
    assert.equal(line.error, 'client_closed');

    // The slot is free again: with no queue, a busy slot would answer 429.
    const second = redactCall(server.url, bytes);
    const settled = await Promise.race([second, new Promise((resolve) => setTimeout(() => resolve('pending'), 300))]);
    assert.equal(settled, 'pending', 'the next request was turned away');
  } finally {
    await server.close();
  }
});

test('a queued request leaves its body unread until it has a slot', async () => {
  const provider = hangingProvider();
  const server = await startServer({ provider, maxConcurrency: 1, maxQueue: 1, requestTimeoutMs: 10_000 });
  const { bytes } = await buildSampleCv();
  const payload = Buffer.alloc(20 * 1024 * 1024, 0x20);
  try {
    const first = redactCall(server.url, bytes).catch(() => null);
    await provider.entered;

    const before = process.memoryUsage().arrayBuffers;
    const req = request(`${server.url}/v1/redact`, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': String(payload.length) },
    });
    req.on('error', () => {});
    req.write(payload);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const grown = process.memoryUsage().arrayBuffers - before;
    assert.ok(grown < 8 * 1024 * 1024, `the server buffered ${Math.round(grown / 1048576)} MiB of a queued body`);
    req.destroy();
    await first;
  } finally {
    await server.close();
  }
});

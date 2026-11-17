const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const Database = require('better-sqlite3');
const request = require('supertest');
const { createApp } = require('../src/app');
const { createHttpAdapter } = require('../ai-adapter');
const { openDatabase } = require('../db');

const route = '/api/integrations/quest/generations';
const origin = 'https://quest-images.example.test';
const secret = 'quest-test-secret-at-least-32-characters';
const url = 'https://api.quanteex.com/v1/images/generations';
const prompt = 'A winter village made of triangles and colored squares';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const image = () => Response.json({ data: [{ b64_json: png }] });
const capacity = () => Response.json({ error: { code: 'capacity_limited' } }, { status: 503 });
const authorized = (call) => call.set('Authorization', 'Bearer ' + secret);
const submit = (api, key, body = { prompt }) => authorized(api.post(route)).set('Idempotency-Key', key).send(body);
const status = async (api, id) => (await authorized(api.get(route + '/' + id)).expect(200)).body;
async function until(api, id, expected) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await status(api, id);
    if (result.status === expected) return result;
    if (['completed', 'failed'].includes(result.status)) assert.fail(JSON.stringify(result));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Job did not reach ' + expected);
}

function fixture(t, limit, fetchMock = async () => image()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-quest-'));
  const dbPath = path.join(dir, 'quest.db');
  fs.writeFileSync(path.join(dir, 'image-limit'), '10');
  fs.writeFileSync(path.join(dir, 'developer-image-limit'), '20');
  fs.writeFileSync(path.join(dir, 'quest-image-limit'), String(limit));
  const apps = new Set();
  const calls = [];
  function start() {
    const app = createApp({
      db: openDatabase(':memory:'),
      env: {
        AI_PROVIDER: 'http', AI_API_URL: url, IMAGE_BUDGET_DIRECTORY: dir,
        QUEST_DB_PATH: dbPath, QUEST_API_KEY: secret, QUEST_PUBLIC_ORIGIN: origin,
        ADMIN_TOKEN: 'different-workshop-admin-token',
      },
      aiAdapter: createHttpAdapter({ url, fetchImpl: async (_target, init) => {
        const data = JSON.parse(init.body);
        calls.push(data);
        return fetchMock(data);
      } }),
    });
    apps.add(app);
    return {
      api: request(app),
      stop() { app.locals.closeQuest(); app.locals.db.close(); apps.delete(app); },
    };
  }
  t.after(() => {
    for (const app of apps) { app.locals.closeQuest(); app.locals.db.close(); }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function inspect(fn) {
    const db = new Database(dbPath);
    try { return fn(db); } finally { db.close(); }
  }
  return { start, calls, inspect, dir, dbPath, used: () => inspect(db => db.prepare("SELECT used FROM image_call_budget WHERE scope='quest'").get().used) };
}

test('quest API requires the separate bearer key and rejects browser and administrative access', async (t) => {
  const f = fixture(t, 0);
  const { api } = f.start();
  await api.post(route).send({ prompt }).expect(401);
  await api.get(route + '/unknown').expect(401);
  await api.post(route).set('Authorization', 'Bearer different-workshop-admin-token').send({ prompt }).expect(401);
  await api.get(route + '/unknown').query({ key: secret }).expect(401);
  const browser = await authorized(api.get(route + '/unknown')).set('Origin', 'https://quest.kidcoded.ru').expect(403);
  assert.equal(browser.headers['access-control-allow-origin'], undefined);
  await authorized(api.get('/api/admin/status')).set('x-admin-token', secret).expect(401);
  await authorized(api.post(route)).send({ prompt }).expect(400);
  await submit(api, 'missing-prompt', { style: 'malevich' }).expect(400);
  await submit(api, 'blank-prompt', { prompt: '  \n  ' }).expect(400);
  await submit(api, 'personal-data', { prompt: 'Нарисуй табличку: мой телефон 12345678901' }).expect(400);
  await submit(api, 'invalid-0001', { prompt: 'a'.repeat(501) }).expect(400);
  await submit(api, 'invalid-0002', { prompt, teamId: '../../x' }).expect(400);
  await submit(api, 'invalid-0003', { prompt, style: '<>'.repeat(70) }).expect(400);
  await submit(api, 'invalid-0004', { prompt: 'a'.repeat(4300) }).expect(413);
  assert.equal((await submit(api, 'quota-zero').expect(402)).body.error.code, 'QUOTA_EXHAUSTED');
  assert.equal(f.calls.length, 0);
  assert.equal(f.used(), 0);
  for (let i = 0; i < 10; i++) await submit(api, 'rate-check-' + i);
  const limited = await submit(api, 'rate-limit').expect(429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
});

test('quest sends the complete prompt without a template and applies only an explicit style', async (t) => {
  const f = fixture(t, 4);
  const { api } = f.start();
  const russian = '  Маяк на скалистом берегу.\nНа вывеске написано «ОТКРЫТО».  ';
  const english = 'A documentary photograph of a desert at noon';
  const cases = [
    [{ prompt: russian, eventId: 'winter-26' }, russian],
    [{ prompt: english, style: '   ' }, english],
    [{ prompt: russian, style: 'акварель, мягкие края' }, russian + '\n\nVisual style: акварель, мягкие края'],
    [{ prompt: english, style: 'Малевич' }, english + '\n\nVisual style: Kazimir Malevich inspired Suprematist composition, geometric shapes and bold flat color.'],
  ];
  for (const [index, [body, expected]] of cases.entries()) {
    const { body: job } = await submit(api, 'exact-prompt-' + index, body).expect(202);
    await until(api, job.jobId, 'completed');
    assert.equal(f.calls[index].prompt, expected);
  }
  assert.equal(f.calls.length, cases.length);
});

test('quest jobs are asynchronous, idempotent under parallel submissions, and return isolated expiring raster links', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, 2, async () => { await gate; return image(); });
  const { api } = f.start();
  const body = { prompt, style: 'malevich', eventId: 'winter-26', teamId: 'team-4' };
  try {
    const replies = await Promise.all([submit(api, 'same-job-key', body), submit(api, 'same-job-key', body)]);
    assert.deepEqual(replies.map(r => r.status).sort(), [200, 202]);
    const first = replies.find(r => r.status === 202);
    assert.equal(first.body.status, 'queued');
    const id = first.body.jobId;
    assert.equal(replies[0].body.jobId, replies[1].body.jobId);
    assert.equal(first.headers.location, route + '/' + id);
    assert.equal((await until(api, id, 'processing')).teamId, 'team-4');
    assert.equal(f.calls[0].prompt, prompt + '\n\nVisual style: Kazimir Malevich inspired Suprematist composition, geometric shapes and bold flat color.');
    const other = (await submit(api, 'other-job-key').expect(202)).body.jobId;
    assert.equal((await status(api, other)).status, 'queued');
    assert.equal(f.calls.length, 1, 'only one worker runs');
    await submit(api, 'same-job-key', { ...body, prompt: 'A different winter artwork' }).expect(409);
    release();
    const done = await until(api, id, 'completed');
    const url = new URL(done.imageUrl);
    assert.equal(url.origin, origin);
    assert.notEqual(url.pathname.split('/').at(-1), id);
    const raster = await api.get(url.pathname).expect(200);
    assert.deepEqual(raster.body, Buffer.from(png, 'base64'));
    assert.match(raster.headers['content-type'], /^image\/png/);
    assert.equal(raster.headers['x-content-type-options'], 'nosniff');
    assert.equal(raster.headers['access-control-allow-origin'], undefined);
    await until(api, other, 'completed');
    await submit(api, 'same-job-key', body).expect(200);
    await submit(api, 'third-job-key').expect(402);
    assert.equal(f.used(), 2);
    assert.deepEqual((await api.get('/api/generation-quota')).body.quota, { total: 10, used: 0, remaining: 10 });
    const dev = await api.get('/api/admin/status').set('x-admin-token', 'different-workshop-admin-token');
    assert.deepEqual(dev.body.developerQuota, { total: 20, used: 0, remaining: 20 });
    assert.deepEqual((await api.get('/api/gallery')).body.works, []);
    f.inspect(db => db.prepare('UPDATE quest_jobs SET image_expires_at=0 WHERE id=?').run(id));
    await api.get(url.pathname).expect(404);
    assert.equal((await status(api, id)).imageUrl, null);
  } finally { release(); }
});

test('fallback and provider failures are charged, but no fallback can overspend', async (t) => {
  const f = fixture(t, 3, async (data) => data.model.endsWith('sunburst') ? capacity() : image());
  const { api, stop } = f.start();
  const first = (await submit(api, 'fallback-first').expect(202)).body.jobId;
  await until(api, first, 'completed');
  assert.equal(f.used(), 2);
  stop();
  const restarted = f.start().api;
  const second = (await submit(restarted, 'fallback-second').expect(202)).body.jobId;
  assert.equal((await until(restarted, second, 'failed')).error.code, 'QUOTA_EXHAUSTED');
  assert.equal(f.used(), 3);
  assert.equal(f.calls.length, 3);
  const failedProvider = fixture(t, 2, async () => capacity());
  const failure = failedProvider.start().api;
  const third = (await submit(failure, 'provider-failure').expect(202)).body.jobId;
  assert.equal((await until(failure, third, 'failed')).error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(failedProvider.used(), 2);
});

test('restart fails the in-flight job without replay and resumes never-started jobs', async (t) => {
  const f = fixture(t, 3);
  const worker = spawn(process.execPath, ['-e', `
    const { createApp } = require('./src/app');
    const { createHttpAdapter } = require('./ai-adapter');
    const env = JSON.parse(process.env.QUEST_TEST_ENV);
    const app = createApp({ env, aiAdapter: createHttpAdapter({
      url: env.AI_API_URL, fetchImpl: () => new Promise(() => {}),
    }) });
    const server = app.listen(0, '127.0.0.1', () => process.send(server.address().port));
  `], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', QUEST_TEST_ENV: JSON.stringify({
      AI_PROVIDER: 'http', AI_API_URL: url, IMAGE_BUDGET_DIRECTORY: f.dir,
      QUEST_DB_PATH: f.dbPath, QUEST_API_KEY: secret, QUEST_PUBLIC_ORIGIN: origin,
    }) },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = once(worker, 'exit');
  try {
    const port = await Promise.race([
      once(worker, 'message').then(([value]) => value),
      exited.then(() => assert.fail('Worker exited before startup')),
    ]);
    const old = request('http://127.0.0.1:' + port);
    const first = (await submit(old, 'restart-first').expect(202)).body.jobId;
    await until(old, first, 'processing');
    assert.equal(f.used(), 1);
    const second = (await submit(old, 'restart-second').expect(202)).body.jobId;
    worker.kill('SIGKILL');
    await exited;
    const { api } = f.start();
    assert.equal((await status(api, first)).error.code, 'JOB_INTERRUPTED');
    assert.equal((await submit(api, 'restart-first').expect(200)).body.jobId, first);
    await until(api, second, 'completed');
    assert.equal(f.calls.length, 1);
    assert.equal(f.used(), 2);
  } finally {
    if (!worker.killed) worker.kill('SIGKILL');
    await exited;
  }
});

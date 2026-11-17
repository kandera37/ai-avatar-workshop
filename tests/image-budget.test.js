const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { createHttpAdapter } = require('../ai-adapter');
const { openDatabase } = require('../db');
const { createApp } = require('../src/app');

const url = 'https://api.quanteex.com/v1/images/generations';
const token = 'budget-test-token';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const image = () => Response.json({ data: [{ b64_json: png }] });
const capacity = () => Response.json({ error: { code: 'capacity_limited' } }, { status: 503 });
const state = (total, used) => ({ total, used, remaining: Math.max(0, total - used) });

function fixture(t, { publicLimit = 10, developerLimit = 20, fetchImpl = async () => image() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-budget-'));
  const file = (name) => path.join(dir, name);
  const ledger = file('provider-attempts.log');
  const connections = new Set();
  const calls = [];
  const setLimit = (name, limit) => fs.writeFileSync(file(name), String(limit));
  setLimit('image-limit', publicLimit);
  setLimit('developer-image-limit', developerLimit);
  fs.writeFileSync(ledger, '2026-10-01T00:00:00.000Z\n');
  t.after(() => {
    for (const db of connections) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function start() {
    const db = openDatabase(file('avatars.db'));
    connections.add(db);
    const app = createApp({
      db,
      env: {
        AI_PROVIDER: 'http', AI_API_URL: url, ADMIN_TOKEN: token, GENERATION_COOLDOWN_MS: '0',
        IMAGE_BUDGET_DIRECTORY: dir, IMAGE_BUDGET_LEGACY_LEDGER: ledger,
      },
      aiAdapter: createHttpAdapter({ url, fetchImpl: async (target, init) => {
        calls.push({ target, ...init });
        return fetchImpl(target, init);
      } }),
    });
    return { api: request(app), stop: () => { db.close(); connections.delete(db); } };
  }
  return { start, calls, setLimit, ledger, file };
}

const auth = (query) => query.set('x-admin-token', token);
const publicQuota = async (api) => (await api.get('/api/generation-quota').expect(200)).body.quota;
const devQuota = async (api) => (await auth(api.get('/api/admin/status')).expect(200)).body.developerQuota;
const session = async (api, nickname = 'Разработчик') => (await api.post('/api/sessions').send({ nickname, is_developer: true }).expect(201)).body.id;
const devSession = async (api) => (await auth(api.post('/api/admin/developer/sessions')).expect(201)).body.id;
const generate = (api, sessionId, extra = {}) => api.post('/api/generate').send({ sessionId, prompt: 'friendly robot explorer', ...extra });
const develop = (api, sessionId) => api.post('/api/admin/developer/generate').send({ sessionId, prompt: 'friendly robot explorer' });

test('migrates public use once and keeps developer generation and edits private and separately counted across restart', async (t) => {
  const f = fixture(t, { developerLimit: 2 });
  const { api, stop } = f.start();
  assert.deepEqual(await publicQuota(api), state(10, 1));
  assert.deepEqual(await devQuota(api), state(2, 0));
  assert.deepEqual(Object.keys((await api.get('/api/generation-quota')).body), ['quota']);
  await api.get('/api/admin/status').expect(401);
  await api.post('/api/admin/developer/sessions').expect(401);
  const publicId = await session(api);
  const privateId = await devSession(api);
  await develop(api, privateId).query({ token, developer: 'true' }).set('Cookie', `developer=true; admin_token=${token}`).expect(401);
  await develop(api, privateId).set('x-admin-token', 'wrong-test-token').expect(401);
  await auth(develop(api, publicId)).expect(401);
  await auth(generate(api, privateId)).expect(401);
  await api.get('/api/sessions/' + privateId).expect(404);
  await generate(api, publicId, { prompt: '' }).expect(400);
  assert.equal(f.calls.length, 0);

  const generated = await auth(develop(api, privateId)).expect(201);
  assert.equal(generated.body.mode, 'generation');
  const edited = await auth(develop(api, privateId)).expect(201);
  assert.equal(edited.body.mode, 'edit');
  assert.equal(edited.body.generationCount, 2);
  assert.equal(f.calls[1].target, 'https://api.quanteex.com/v1/images/edits');
  assert.ok(f.calls[1].body.get('image') instanceof Blob);
  await api.get(`/api/sessions/${privateId}/images/${generated.body.id}`).expect(404);
  assert.equal((await auth(develop(api, privateId)).expect(402)).body.code, 'DEMO_QUOTA_EXHAUSTED');
  assert.deepEqual(await publicQuota(api), state(10, 1));
  await generate(api, publicId, { scope: 'developer' }).set('x-admin-token', token).expect(201);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every((call) => call.method === 'POST' && call.redirect === 'error'));

  stop();
  fs.unlinkSync(f.ledger);
  const restarted = f.start();
  assert.deepEqual(await publicQuota(restarted.api), state(10, 2));
  assert.deepEqual(await devQuota(restarted.api), state(2, 2));
  f.setLimit('developer-image-limit', 20);
  assert.deepEqual(await devQuota(restarted.api), state(20, 2));
});

test('a failed provider request costs one call and fallback cannot run past the budget', async (t) => {
  const f = fixture(t, { publicLimit: 4, fetchImpl: async (_url, init) => (
    JSON.parse(init.body).model.endsWith('sunburst') ? capacity() : image()
  ) });
  const { api } = f.start();
  const id = await session(api);
  const fallback = await generate(api, id).expect(201);
  assert.equal(fallback.body.fallbackUsed, true);
  assert.deepEqual(await publicQuota(api), state(4, 3));
  f.setLimit('image-limit', 3);
  const fresh = await session(api, 'Fresh visitor');
  assert.equal((await generate(api, fresh).expect(402)).body.code, 'DEMO_QUOTA_EXHAUSTED');
  assert.equal(f.calls.length, 2);

  f.setLimit('image-limit', 4);
  const restarted = f.start();
  assert.equal((await generate(restarted.api, fresh).expect(402)).body.code, 'DEMO_QUOTA_EXHAUSTED');
  assert.equal(f.calls.length, 3, 'fallback did not send the fourth external call');
  assert.deepEqual(await publicQuota(restarted.api), state(4, 4));
  assert.deepEqual(await devQuota(api), state(20, 0));
  fs.unlinkSync(f.file('image-limit'));
  await generate(api, fresh).expect(503);
  assert.equal(f.calls.length, 3, 'configuration errors fail closed');
});

test('parallel participants across SQLite connections cannot spend the last call twice', async (t) => {
  let entered;
  let finish;
  const started = new Promise((resolve) => { entered = resolve; });
  const release = new Promise((resolve) => { finish = resolve; });
  const f = fixture(t, { publicLimit: 2, fetchImpl: async () => { entered(); await release; return image(); } });
  const first = f.start().api;
  const second = f.start().api;
  const one = await session(first, 'First visitor');
  const two = await session(second, 'Second visitor');
  const running = generate(first, one).then((response) => response);
  try {
    await Promise.race([started, running.then((response) => { assert.fail(`Provider not reached (${response.status})`); })]);
    const [duplicate, other] = await Promise.all([generate(first, one), generate(second, two)]);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, 'GENERATION_IN_PROGRESS');
    assert.equal(other.status, 402);
    assert.equal(other.body.code, 'DEMO_QUOTA_EXHAUSTED');
    assert.deepEqual(await publicQuota(second), state(2, 2));
    assert.equal(f.calls.length, 1);
  } finally {
    finish();
    assert.equal((await running).status, 201);
  }
});

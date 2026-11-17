const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createHttpAdapter, AiAdapterError } = require('../ai-adapter');
const { openDatabase } = require('../db');
const { createApp } = require('../src/app');

const url = 'https://api.quanteex.com/v1/images/generations';
const models = ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'];
const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const imageData = `data:image/png;base64,${b64}`;
const env = { AI_PROVIDER: 'http', AI_API_URL: url, AI_GENERATION_MODELS: models.join(','), ADMIN_TOKEN: 'quanteex-test', GENERATION_COOLDOWN_MS: '0' };
const success = () => ({ ok: true, status: 200, headers: new Headers({ 'x-quanteex-request-id': 'qx-request-test' }), json: async () => ({ data: [{ b64_json: b64 }] }) });

test('Quanteex both models whitelist generation and multipart edit fields despite legacy extras', async () => {
  const calls = [];
  const adapter = createHttpAdapter({ url, size: '1k', quality: 'low', extraBody: { n: 4, response_format: 'b64_json', unsupported: true }, fetchImpl: async (target, options) => { calls.push({ target, ...options }); return success(); } });
  for (const model of models) {
    const generated = await adapter.generate('friendly robot', model);
    assert.equal(generated.imageData, imageData);
    assert.equal(generated.requestId, 'qx-request-test');
    assert.deepEqual(JSON.parse(calls.at(-1).body), { model, prompt: 'friendly robot', size: '1k', n: 1 });
    await adapter.edit('add a scarf', imageData, model);
    const edit = calls.at(-1);
    assert.equal(edit.target, 'https://api.quanteex.com/v1/images/edits');
    assert.deepEqual([...edit.body.keys()].sort(), ['image', 'model', 'n', 'prompt', 'size']);
    assert.equal(edit.body.get('model'), model);
    assert.equal(edit.body.get('n'), '1');
    assert.equal(edit.body.get('size'), '1k');
    assert.deepEqual(Buffer.from(await edit.body.get('image').arrayBuffer()), Buffer.from(b64, 'base64'));
    assert.equal(edit.headers['content-type'], undefined);
  }
});

test('Quanteex rejects retired models and exact pixel sizes before making an external request', async () => {
  let calls = 0;
  const adapter = createHttpAdapter({ url, fetchImpl: async () => { calls++; return success(); } });
  await assert.rejects(adapter.generate('friendly robot', 'gpt-image-2'), { code: 'INTEGRATION_ERROR' });
  await assert.rejects(adapter.edit('add a scarf', imageData, 'gpt-image-2'), { code: 'INTEGRATION_ERROR' });
  assert.equal(calls, 0);
  assert.throws(() => createHttpAdapter({ url, size: '1024x1024' }), /auto or 1k/);
  assert.throws(() => createApp({ db: openDatabase(':memory:'), env: { ...env, AI_GENERATION_MODELS: 'gpt-image-2' }, aiAdapter: {} }), /Quanteex supports only/);
});

test('Quanteex safety responses remain terminal even with a provider 5xx status', async () => {
  const adapter = createHttpAdapter({ url, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: { code: 'safety_violation', message: 'Content policy violation' } }) }) });
  await assert.rejects(adapter.generate('friendly robot'), { code: 'CONTENT_REJECT', status: 503 });
});

test('Quanteex temporary failures immediately fail over; both circuits recover via real user probes', async () => {
  for (const failure of [
    { code: 'PROVIDER_ERROR', status: 503, providerErrorCode: 'capacity_limited' },
    { code: 'RATE_LIMIT', status: 429 },
    { code: 'PROVIDER_ERROR', status: 502 },
    { code: 'PROVIDER_ERROR', status: 504, source: 'provider' },
    { code: 'TIMEOUT', status: 504, source: 'local_timeout' },
  ]) {
    let clock = 0;
    let failing = true;
    const calls = [];
    const app = createApp({ db: openDatabase(':memory:'), env, now: () => clock, aiAdapter: { async generate(prompt, model) {
      calls.push(model);
      if (failing) throw new AiAdapterError('temporarily unavailable', failure);
      return { imageData };
    } } });
    const sessionId = (await request(app).post('/api/sessions').send({ nickname: 'Quanteex-test' })).body.id;
    const generate = () => request(app).post('/api/generate').send({ sessionId, prompt: 'friendly robot explorer' });
    assert.equal((await generate()).status, failure.status);
    assert.deepEqual(calls, models, 'one attempt per model, no capacity/timeout retry');
    let snapshot = (await request(app).get(`/api/sessions/${sessionId}`)).body;
    assert.equal(snapshot.generationPolicy.inFlight, false);
    assert.equal(snapshot.generationCount, 0);
    assert.equal((await generate()).status, 503);
    assert.equal(calls.length, 2, 'unhealthy models consume no external requests');
    let status = (await request(app).get('/api/admin/status').set('x-admin-token', env.ADMIN_TOKEN)).body;
    assert.equal(status.providerLabel, 'Quanteex');
    assert.deepEqual(status.generationModelPool, models);
    assert.ok(status.generationModels.every((model) => model.state === 'unhealthy' && model.retryAfterSec === 600));
    clock = 600001;
    status = (await request(app).get('/api/admin/status').set('x-admin-token', env.ADMIN_TOKEN)).body;
    assert.ok(status.generationModels.every((model) => model.state === 'half_open'));
    failing = false;
    assert.equal((await generate()).status, 201);
    assert.equal(calls.at(-1), models[0]);
    snapshot = (await request(app).get(`/api/sessions/${sessionId}`)).body;
    assert.equal(snapshot.generationPolicy.inFlight, false);
    assert.equal(snapshot.generationCount, 1);
    app.locals.db.close();
  }
});

test('Quanteex successful fallback skips Sunburst until its cooldown expires', async () => {
  const calls = [];
  const app = createApp({ db: openDatabase(':memory:'), env, aiAdapter: { async generate(prompt, model) {
    calls.push(model);
    if (model === models[0]) throw new AiAdapterError('capacity', { code: 'PROVIDER_ERROR', status: 503 });
    return { imageData };
  } } });
  for (const nickname of ['first-user', 'second-user']) {
    const sessionId = (await request(app).post('/api/sessions').send({ nickname })).body.id;
    const response = await request(app).post('/api/generate').send({ sessionId, prompt: 'friendly robot explorer' });
    assert.equal(response.status, 201);
    assert.equal(response.body.model, models[1]);
    assert.equal(response.body.fallbackUsed, true);
  }
  assert.deepEqual(calls, [models[0], models[1], models[1]]);
  app.locals.db.close();
});

test('Quanteex terminal errors never trigger fallback; failed edits preserve the last version', async () => {
  for (const failure of [{ code: 'CLIENT_ERROR', status: 400, providerErrorCode: 'invalid_request' }, { code: 'AUTH', status: 401 }, { code: 'AUTH', status: 403 }, { code: 'CONTENT_REJECT', status: 502 }]) {
    const calls = [];
    const app = createApp({ db: openDatabase(':memory:'), env, aiAdapter: { async generate(prompt, model) { calls.push(model); throw new AiAdapterError('rejected', failure); } } });
    const sessionId = (await request(app).post('/api/sessions').send({ nickname: 'terminal-test' })).body.id;
    assert.equal((await request(app).post('/api/generate').send({ sessionId, prompt: 'friendly robot' })).status, failure.status);
    assert.deepEqual(calls, [models[0]]);
    app.locals.db.close();
  }
  const references = [];
  const app = createApp({ db: openDatabase(':memory:'), env, aiAdapter: {
    async generate() { return { imageData }; },
    async edit(prompt, reference, model) { references.push({ reference, model }); throw new AiAdapterError('capacity', { code: 'PROVIDER_ERROR', status: 503 }); },
  } });
  const sessionId = (await request(app).post('/api/sessions').send({ nickname: 'edit-test' })).body.id;
  const first = await request(app).post('/api/generate').send({ sessionId, prompt: 'friendly robot' });
  assert.equal((await request(app).post('/api/generate').send({ sessionId, prompt: 'add a scarf' })).status, 503);
  assert.deepEqual(references, [{ reference: imageData, model: models[1] }]);
  const snapshot = (await request(app).get(`/api/sessions/${sessionId}`)).body;
  assert.equal(snapshot.latestGeneration.id, first.body.id);
  assert.equal(snapshot.generationPolicy.inFlight, false);
  app.locals.db.close();
});

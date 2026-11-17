const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const request = require('supertest');
const { openDatabase } = require('../db');
const { AiAdapterError } = require('../ai-adapter');

const { createApp } = require('../src/app');
const app = createApp({ db: openDatabase(':memory:'), env: { AI_PROVIDER: 'mock', ADMIN_TOKEN: 'test-admin', GENERATION_COOLDOWN_MS: '0' } });

const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function createSession(nickname, participantId) {
  const res = await request(app).post('/api/sessions').send({ nickname, ...(participantId ? { participantId } : {}) });
  assert.equal(res.status, 201);
  assert.ok(res.body.id || res.body.sessionId);
  return res.body.id || res.body.sessionId;
}

test('creates participant session without registration', async () => {
  const sessionId = await createSession('test-01');
  assert.equal(typeof sessionId, 'string');
});

test('publishes a generated work and keeps prompt private', async () => {
  const sessionId = await createSession(`publish-${Date.now()}`);
  const created = await request(app).post('/api/works').send({
    sessionId,
    prompt: 'friendly space robot for children',
    imageData,
  });
  assert.ok([200, 201].includes(created.status));
  const workId = created.body.id || created.body.work?.id;
  assert.ok(workId);

  const published = await request(app).post(`/api/works/${workId}/publish`).send({ sessionId });
  assert.equal(published.status, 200);
  assert.equal(published.body.prompt, undefined);
  assert.equal(published.body.work?.prompt, undefined);
});

test('allows one like per participant and rejects duplicate like', async () => {
  const ownerSession = await createSession(`owner-${Date.now()}`);
  const likerSession = await createSession(`liker-${Date.now()}`);
  const created = await request(app).post('/api/works').send({ sessionId: ownerSession, prompt: 'robot', imageData });
  const workId = created.body.id || created.body.work?.id;
  await request(app).post(`/api/works/${workId}/publish`).send({ sessionId: ownerSession });

  const first = await request(app).post(`/api/works/${workId}/like`).send({ sessionId: likerSession });
  assert.equal(first.status, 200);
  const second = await request(app).post(`/api/works/${workId}/like`).send({ sessionId: likerSession });
  assert.equal(second.status, 409);
  const own = await request(app).post(`/api/works/${workId}/like`).send({ sessionId: ownerSession });
  assert.equal(own.status, 403);
});

test('stable participant identity blocks a duplicate like after creating a new hero session', async () => {
  const ownerSession = await createSession('stable-owner');
  const created = await request(app).post('/api/works').send({ sessionId: ownerSession, prompt: 'robot', imageData });
  const workId = created.body.id || created.body.work?.id;
  await request(app).post(`/api/works/${workId}/publish`).send({ sessionId: ownerSession });

  const participantId = crypto.randomUUID();
  const firstSession = await createSession('stable-voter1', participantId);
  const first = await request(app).post(`/api/works/${workId}/like`).send({ sessionId: firstSession });
  assert.equal(first.status, 200);

  const secondSession = await createSession('stable-voter2', participantId);
  assert.notEqual(firstSession, secondSession);
  const second = await request(app).post(`/api/works/${workId}/like`).send({ sessionId: secondSession });
  assert.equal(second.status, 409);
  assert.equal((await request(app).get('/api/gallery')).body.works.find((work) => work.id === workId).likes, 1);

  const firstSnapshot = await request(app).get(`/api/sessions/${firstSession}`);
  const secondSnapshot = await request(app).get(`/api/sessions/${secondSession}`);
  assert.equal(firstSnapshot.body.participantId, participantId);
  assert.equal(secondSnapshot.body.participantId, participantId);
  assert.ok(firstSnapshot.body.likedWorkIds.includes(workId));
  assert.ok(secondSnapshot.body.likedWorkIds.includes(workId));

  const otherContext = await createSession('stable-other', crypto.randomUUID());
  const otherSnapshot = await request(app).get(`/api/sessions/${otherContext}`);
  assert.notEqual(otherSnapshot.body.participantId, participantId);
});

test('admin can hide a published work from the gallery', async () => {
  const sessionId = await createSession(`hide-${Date.now()}`);
  const created = await request(app).post('/api/works').send({ sessionId, prompt: 'fantasy avatar', imageData });
  const workId = created.body.id || created.body.work?.id;
  await request(app).post(`/api/works/${workId}/publish`).send({ sessionId });

  const hidden = await request(app).patch(`/api/admin/works/${workId}`).set('x-admin-token', 'test-admin').send({ hidden: true });
  assert.equal(hidden.status, 200);

  const gallery = await request(app).get('/api/gallery');
  assert.equal(gallery.status, 200);
  const works = gallery.body.works || gallery.body;
  assert.equal(works.some((work) => String(work.id) === String(workId)), false);
});

test('compact gallery and session separate media while preserving ownership and visibility', async () => {
  const sessionId = await createSession('compact-owner');
  const otherSession = await createSession('compact-guest');
  const generated = await request(app).post('/api/generate').send({
    sessionId,
    prompt: 'friendly space robot',
  });
  assert.equal(generated.status, 201);
  const draft = await request(app).post('/api/works').send({
    sessionId,
    generationId: generated.body.id,
  });
  assert.equal(draft.status, 201);
  const workId = draft.body.id;
  const publicUrl = '/api/works/' + workId + '/image';

  const sessionUrl = '/api/sessions/' + sessionId + '?format=compact';
  const snapshot = (await request(app).get(sessionUrl).expect(200)).body;
  assert.equal(snapshot.latestGeneration.imageData, undefined);
  assert.equal(snapshot.work.imageData, undefined);
  const privateUrl = snapshot.latestGeneration.imageUrl;
  const privateMedia = await request(app).get(privateUrl).expect(200);
  assert.equal(privateMedia.headers['cache-control'], 'private, no-store');
  assert.match(privateMedia.headers['content-security-policy'], /sandbox;/);
  await request(app).get(privateUrl.replace(sessionId, otherSession)).expect(404);
  await request(app).get(publicUrl).expect(404);

  await request(app).post('/api/works/' + workId + '/publish?format=compact').send({ sessionId }).expect(200);
  const gallery = (await request(app).get('/api/gallery?format=compact').expect(200)).body;
  const card = gallery.works.find((item) => item.id === workId);
  assert.equal(card.imageUrl, publicUrl);
  assert.equal(card.imageData, undefined);
  assert.equal((await request(app).get(sessionUrl)).body.latestGeneration.imageUrl, publicUrl);
  const media = await request(app).get(publicUrl).expect(200);
  assert.equal(media.headers['cache-control'], 'public, no-cache');
  assert.ok(media.headers.etag);
  await request(app).get(publicUrl).set('If-None-Match', media.headers.etag).expect(304);
  await request(app).patch('/api/admin/works/' + workId).set('x-admin-token', 'test-admin').send({ hidden: true }).expect(200);
  await request(app).get(publicUrl).set('If-None-Match', media.headers.etag).expect(404);
  assert.equal((await request(app).get(sessionUrl)).body.latestGeneration.imageUrl, privateUrl);
});

test('admin endpoints require the configured token', async () => {
  const denied = await request(app).get('/api/admin/status');
  assert.equal(denied.status, 401);
  const allowed = await request(app).get('/api/admin/status').set('x-admin-token', 'test-admin');
  assert.equal(allowed.status, 200);
});

test('avatar previews and prompts are available only in the protected admin list', async () => {
  const sessionId = await createSession('private-preview');
  const prompt = 'friendly robot, orange spacesuit';
  const created = await request(app).post('/api/works').send({ sessionId, prompt, imageData });
  const id = created.body.id;
  await request(app).post(`/api/works/${id}/publish`).send({ sessionId });
  const denied = await request(app).get('/api/admin/works');
  assert.equal(denied.status, 401);
  assert.equal(denied.body.works, undefined);
  const admin = await request(app).get('/api/admin/works').set('x-admin-token', 'test-admin');
  const privateWork = admin.body.works.find((work) => work.id === id);
  assert.equal(privateWork.prompt, prompt);
  assert.equal(privateWork.imageData, imageData);
  assert.equal(typeof privateWork.createdAt, 'string');
  const gallery = await request(app).get('/api/gallery');
  const publicWork = gallery.body.works.find((work) => work.id === id);
  assert.equal(publicWork.prompt, undefined);
  assert.equal(publicWork.imageData, imageData);
  await request(app).patch(`/api/admin/works/${id}`).set('x-admin-token', 'test-admin').send({ hidden: true });
  const hidden = await request(app).get('/api/admin/works').set('x-admin-token', 'test-admin');
  assert.equal(hidden.body.works.find((work) => work.id === id).imageData, imageData);
});

test('demo quota errors keep their public message and do not trigger fallback', async () => {
  const cases = [
    ['DEMO_QUOTA_EXHAUSTED', 402, 'Лимит генераций исчерпан'],
    ['DEMO_QUOTA_UNAVAILABLE', 503, 'Генерация временно недоступна. Обратитесь к ведущему.'],
  ];
  for (const [code, status, message] of cases) {
    let attempts = 0;
    const quotaApp = createApp({
      db: openDatabase(':memory:'),
      env: { AI_GENERATION_MODELS: 'primary,fallback' },
      aiAdapter: {
        async generate() {
          attempts++;
          throw new AiAdapterError('Local quota check', { code, status, source: 'local_quota' });
        },
      },
    });
    const session = await request(quotaApp).post('/api/sessions').send({ nickname: 'demo-quota' }).expect(201);
    const response = await request(quotaApp).post('/api/generate').send({
      sessionId: session.body.id,
      prompt: 'friendly robot',
    }).expect(status);
    assert.equal(response.body.code, code);
    assert.equal(response.body.error, message);
    assert.equal(response.body.generationPolicy.inFlight, false);
    assert.equal(attempts, 1);
    quotaApp.locals.db.close();
  }
});

test('admin can delete a published work', async () => {
  const sessionId = await createSession(`delete-${Date.now()}`);
  const created = await request(app).post('/api/works').send({ sessionId, prompt: 'temporary avatar', imageData });
  const workId = created.body.id;
  await request(app).post(`/api/works/${workId}/publish`).send({ sessionId });
  const deleted = await request(app).delete(`/api/admin/works/${workId}`).set('x-admin-token', 'test-admin');
  assert.equal(deleted.status, 204);
  const gallery = await request(app).get('/api/gallery');
  assert.equal(gallery.body.works.some((work) => work.id === workId), false);
});

test('mock provider returns an image for a valid prompt', async () => {
  const sessionId = await createSession(`generate-${Date.now()}`);
  const generated = await request(app).post('/api/generate').send({
    sessionId,
    prompt: 'friendly robot in a colorful space station',
  });
  assert.equal(generated.status, 201);
  assert.match(generated.body.imageData, /^data:image\//);
  assert.equal(generated.body.provider, 'mock');
  assert.equal(typeof generated.body.durationMs, 'number');
});

test('composes provider prompt from the workshop base and keeps the user idea separate', async () => {
  const calls = [];
  const composedApp = createApp({
    db: openDatabase(':memory:'),
    env: { AI_PROVIDER: 'mock', ADMIN_TOKEN: 'compose-admin', BASE_PROMPT: 'BASE WORKSHOP STYLE', GENERATION_COOLDOWN_MS: '0' },
    aiAdapter: {
      async generate(prompt) { calls.push(prompt); return { imageData, provider: 'mock' }; },
      async edit(prompt) { calls.push(prompt); return { imageData, provider: 'mock' }; },
    },
  });
  const session = await request(composedApp).post('/api/sessions').send({ nickname: `compose-${Date.now()}` });
  const sessionId = session.body.id;
  const idea = 'робот в космосе';
  const generated = await request(composedApp).post('/api/generate').send({ sessionId, prompt: idea });
  assert.equal(generated.status, 201);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^BASE WORKSHOP STYLE\n\nParticipant idea/);
  assert.match(calls[0], new RegExp(idea));
  assert.match(calls[0], /exactly one fictional character/i);
  assert.match(calls[0], /square 1:1 composition/i);
  assert.match(calls[0], /Do not include text/i);
  assert.match(calls[0], /readable marks/i);
  assert.match(calls[0], /background secondary and visually simple/i);
  assert.notEqual(calls[0], idea);

  // An improvement keeps the same hidden style/safety block and only changes
  // the participant idea sent to the provider.
  const editedIdea = 'дракон с рюкзаком';
  const improved = await request(composedApp).post('/api/generate').send({ sessionId, prompt: editedIdea });
  assert.equal(improved.status, 201);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /^BASE WORKSHOP STYLE\n\nParticipant edit instruction/);
  assert.match(calls[1], new RegExp(editedIdea));
  assert.match(calls[1], /exactly one fictional character/i);
  assert.match(calls[1], /supplied reference image/i);
  assert.notEqual(calls[1], calls[0]);

  const snapshot = await request(composedApp).get(`/api/sessions/${sessionId}`);
  assert.equal(snapshot.body.latestGeneration.prompt, editedIdea);
  assert.equal(snapshot.body.latestGeneration.finalPrompt, undefined, 'full prompt must stay out of participant APIs');

  const draft = await request(composedApp).post('/api/works').send({ sessionId, generationId: improved.body.id });
  await request(composedApp).post(`/api/works/${draft.body.id}/publish`).send({ sessionId });
  const admin = await request(composedApp).get('/api/admin/works').set('x-admin-token', 'compose-admin');
  const work = admin.body.works.find((item) => item.id === draft.body.id);
  assert.equal(work.prompt, editedIdea);
  assert.equal(work.userPrompt, editedIdea);
  assert.equal(work.finalPrompt, calls[1]);
  const publicGallery = await request(composedApp).get('/api/gallery');
  assert.equal(publicGallery.body.works[0].prompt, undefined);
  assert.equal(publicGallery.body.works[0].finalPrompt, undefined);
});

test('softens participant text and logo requests in the provider prompt', async () => {
  const calls = [];
  const textApp = createApp({
    db: openDatabase(':memory:'),
    env: { AI_PROVIDER: 'mock', ADMIN_TOKEN: 'text-guard-admin', GENERATION_COOLDOWN_MS: '0' },
    aiAdapter: {
      async generate(prompt) { calls.push(prompt); return { imageData, provider: 'mock' }; },
    },
  });
  const owner = await request(textApp).post('/api/sessions').send({ nickname: `text-guard-${Date.now()}` });
  const userPrompt = 'робот с огромной надписью HERO на футболке';
  const generated = await request(textApp).post('/api/generate').send({ sessionId: owner.body.id, prompt: userPrompt });
  assert.equal(generated.status, 201);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0], /HERO/);
  assert.match(calls[0], /non-readable visual emblem/i);
  assert.match(calls[0], /Do not render any readable marks/i);
  const snapshot = await request(textApp).get(`/api/sessions/${owner.body.id}`);
  assert.equal(snapshot.body.latestGeneration.prompt, userPrompt, 'participant-facing prompt remains unchanged');
});

test('failed generation returns an error without deleting existing gallery work', async () => {
  const failingApp = createApp({
    db: openDatabase(':memory:'),
    aiAdapter: { async generate() { throw new Error('provider unavailable'); } },
  });
  const owner = await request(failingApp).post('/api/sessions').send({ nickname: `keep-${Date.now()}` });
  const sessionId = owner.body.id;
  const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const draft = await request(failingApp).post('/api/works').send({ sessionId, prompt: 'safe avatar', imageData });
  await request(failingApp).post(`/api/works/${draft.body.id}/publish`).send({ sessionId });
  const failedOwner = await request(failingApp).post('/api/sessions').send({ nickname: `failed-${Date.now()}` });
  const failed = await request(failingApp).post('/api/generate').send({ sessionId: failedOwner.body.id, prompt: 'another safe avatar' });
  assert.equal(failed.status, 502);
  const gallery = await request(failingApp).get('/api/gallery');
  assert.equal(gallery.body.works.length, 1);
});

test('handles a malformed provider response without crashing the API', async () => {
  const malformedApp = createApp({ db: openDatabase(':memory:'), aiAdapter: { async generate() { return null; } } });
  const owner = await request(malformedApp).post('/api/sessions').send({ nickname: `malformed-${Date.now()}` });
  const response = await request(malformedApp).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'safe avatar' });
  assert.equal(response.status, 502);
  assert.equal(response.body.code, 'INVALID_IMAGE');
  assert.equal(typeof response.body.durationMs, 'number');
});

test('keeps the first successful image when a later improvement fails', async () => {
  let calls = 0;
  const firstImage = imageData;
  const editApp = createApp({
    db: openDatabase(':memory:'),
    env: { AI_PROVIDER: 'mock', GENERATION_COOLDOWN_MS: '0' },
    aiAdapter: { async generate() {
      calls += 1;
      if (calls === 1) return { imageData: firstImage, provider: 'test' };
      throw new AiAdapterError('busy', { code: 'RATE_LIMIT', status: 429, retryAfterMs: 1000 });
    }, async edit() {
      throw new AiAdapterError('busy', { code: 'RATE_LIMIT', status: 429, retryAfterMs: 1000 });
    } },
  });
  const owner = await request(editApp).post('/api/sessions').send({ nickname: `edit-fail-${Date.now()}` });
  const first = await request(editApp).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'friendly robot' });
  assert.equal(first.status, 201);
  const failedEdit = await request(editApp).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'friendly dragon' });
  assert.equal(failedEdit.status, 429);
  assert.equal(failedEdit.body.code, 'RATE_LIMIT');
  const stored = editApp.locals.db.prepare('SELECT image_data, duration_ms FROM generations WHERE session_id = ?').all(owner.body.id);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].image_data, firstImage);
  assert.equal(typeof stored[0].duration_ms, 'number');
});

test('uses the previous image as the reference for an improvement', async () => {
  const calls = [];
  const firstImage = imageData;
  const secondImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const editApp = createApp({
    db: openDatabase(':memory:'),
    env: { AI_PROVIDER: 'mock', GENERATION_COOLDOWN_MS: '0' },
    aiAdapter: {
      async generate(prompt) { calls.push({ type: 'generate', prompt }); return { imageData: firstImage, provider: 'test' }; },
      async edit(prompt, referenceImage) { calls.push({ type: 'edit', prompt, referenceImage }); return { imageData: secondImage, provider: 'test' }; },
    },
  });
  const owner = await request(editApp).post('/api/sessions').send({ nickname: `edit-${Date.now()}` });
  const first = await request(editApp).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'friendly robot' });
  assert.equal(first.status, 201);
  assert.equal(first.body.mode, 'generation');
  const improved = await request(editApp).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'add an orange scarf' });
  assert.equal(improved.status, 201);
  assert.equal(improved.body.mode, 'edit');
  assert.deepEqual(calls.map((call) => call.type), ['generate', 'edit']);
  assert.equal(calls[1].referenceImage, firstImage);
  assert.match(calls[1].prompt, /add an orange scarf/);
  assert.match(calls[1].prompt, /reference image/i);
  const snapshot = await request(editApp).get(`/api/sessions/${owner.body.id}`);
  assert.equal(snapshot.body.latestGeneration.imageData, secondImage);
});

test('does not fall back to a new generation when edits are unavailable', async () => {
  let generateCalls = 0;
  const unsupportedApp = createApp({
    db: openDatabase(':memory:'),
    env: { AI_PROVIDER: 'mock', GENERATION_COOLDOWN_MS: '0' },
    aiAdapter: {
      async generate() { generateCalls += 1; return { imageData, provider: 'test' }; },
    },
  });
  const owner = await request(unsupportedApp).post('/api/sessions').send({ nickname: `edunsup-${Date.now().toString().slice(-6)}` });
  assert.equal((await request(unsupportedApp).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'friendly robot' })).status, 201);
  const result = await request(unsupportedApp).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'add an orange scarf' });
  assert.equal(result.status, 501);
  assert.equal(result.body.code, 'EDIT_UNSUPPORTED');
  assert.equal(generateCalls, 1);
  const snapshot = await request(unsupportedApp).get(`/api/sessions/${owner.body.id}`);
  assert.equal(snapshot.body.generationCount, 1);
  assert.equal(snapshot.body.latestGeneration.imageData, imageData);
});

test('session snapshot restores generation, work and like state without exposing it publicly', async () => {
  const owner = await createSession(`restore-${Date.now()}`);
  const generated = await request(app).post('/api/generate').send({ sessionId: owner, prompt: 'робот в космосе' });
  assert.equal(generated.status, 201);
  const draft = await request(app).post('/api/works').send({ sessionId: owner, generationId: generated.body.id });
  assert.equal(draft.status, 201);
  await request(app).post(`/api/works/${draft.body.id}/publish`).send({ sessionId: owner });
  const liker = await createSession(`rl-${Date.now().toString().slice(-8)}`);
  await request(app).post(`/api/works/${draft.body.id}/like`).send({ sessionId: liker });
  const snapshot = await request(app).get(`/api/sessions/${owner}`);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.generationCount, 1);
  assert.equal(snapshot.body.latestGeneration.prompt, 'робот в космосе');
  assert.equal(snapshot.body.work.status, 'published');
  assert.ok(Array.isArray(snapshot.body.likedWorkIds));
  assert.ok(snapshot.body.generationPolicy);
  const voterSnapshot = await request(app).get(`/api/sessions/${liker}`);
  assert.ok(voterSnapshot.body.likedWorkIds.includes(draft.body.id));
  const gallery = await request(app).get('/api/gallery');
  assert.equal(gallery.body.works.find((item) => item.id === draft.body.id).prompt, undefined);
});

test('rejects weak or garbage prompts before calling the adapter', async () => {
  let calls = 0;
  const validationApp = createApp({ db: openDatabase(':memory:'), env: { GENERATION_COOLDOWN_MS: '0' }, aiAdapter: { async generate() { calls += 1; return { imageData, provider: 'test' }; } } });
  const owner = await request(validationApp).post('/api/sessions').send({ nickname: `validation-${Date.now()}` });
  for (const prompt of ['', '   ', '123123', 'asdfasdf', 'qwerty', 'qwertyuiop', '......', 'аватар', 'персонаж', 'аватар!!!', 'xxx', 'абкабкабк', '!!1@2#3$4%5а', {}, ['robot']]) {
    const response = await request(validationApp).post('/api/generate').send({ sessionId: owner.body.id, prompt });
    assert.equal(response.status, 400, String(prompt));
    assert.equal(response.body.generationPolicy.retryAfterMs, 0);
  }
  assert.equal(calls, 0);
  const valid = await request(validationApp).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'дракон с рюкзаком' });
  assert.equal(valid.status, 201);
  assert.equal(calls, 1);
});

test('cooldown starts only after valid request and can be tested with an injected clock', async () => {
  let clock = 1000;
  let calls = 0;
  const clockApp = createApp({ db: openDatabase(':memory:'), env: { GENERATION_COOLDOWN_MS: '10000' }, now: () => clock, aiAdapter: { async generate() { calls += 1; return { imageData, provider: 'test' }; }, async edit() { calls += 1; return { imageData, provider: 'test' }; } } });
  const owner = await request(clockApp).post('/api/sessions').send({ nickname: `clock-${Date.now()}` });
  const bad = await request(clockApp).post('/api/generate').send({ sessionId: owner.body.id, prompt: '123123' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.generationPolicy.retryAfterMs, 0);
  assert.equal(owner.body.generationPolicy.retryAfterMs, 0);
  const first = await request(clockApp).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'робот в космосе' });
  assert.equal(first.status, 201);
  assert.equal(first.body.generationPolicy.retryAfterMs, 10000);
  assert.equal(first.body.generationPolicy.inFlight, false);
  clock = 10999;
  const early = await request(clockApp).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'дракон с рюкзаком' });
  assert.equal(early.status, 429);
  assert.equal(early.body.code, 'COOLDOWN');
  assert.equal(early.body.retryAfterMs, 1);
  assert.equal(early.body.generationPolicy.retryAfterMs, 1);
  const snapshot = await request(clockApp).get(`/api/sessions/${owner.body.id}`);
  assert.equal(snapshot.body.generationPolicy.retryAfterMs, 1);
  assert.equal(calls, 1);
  clock = 11000;
  const ready = await request(clockApp).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'волшебник в стиле пиксель-арт' });
  assert.equal(ready.status, 201);
  assert.equal(calls, 2);
});

test('generation cap is configurable and zero means unlimited', async () => {
  const capped = createApp({ db: openDatabase(':memory:'), env: { MAX_GENERATIONS_PER_SESSION: '2', GENERATION_COOLDOWN_MS: '0' }, aiAdapter: { async generate() { return { imageData, provider: 'test' }; }, async edit() { return { imageData, provider: 'test' }; } } });
  const owner = await request(capped).post('/api/sessions').send({ nickname: `cap-${Date.now()}` });
  for (const prompt of ['робот в космосе', 'дракон с рюкзаком']) {
    assert.equal((await request(capped).post('/api/generate').send({ sessionId: owner.body.id, prompt })).status, 201);
  }
  const blocked = await request(capped).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'волшебник в стиле пиксель-арт' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, 'GENERATION_LIMIT');
  const unlimited = createApp({ db: openDatabase(':memory:'), env: { MAX_GENERATIONS_PER_SESSION: '0', GENERATION_COOLDOWN_MS: '0' }, aiAdapter: { async generate() { return { imageData, provider: 'test' }; }, async edit() { return { imageData, provider: 'test' }; } } });
  const freeOwner = await request(unlimited).post('/api/sessions').send({ nickname: `free-${Date.now()}` });
  for (let i = 0; i < 3; i += 1) assert.equal((await request(unlimited).post('/api/generate').send({ sessionId: freeOwner.body.id, prompt: `робот в космосе ${i}` })).status, 201);
});

test('default policy permits more than two generations and reports remaining time from request start', async () => {
  let clock = 0;
  const defaultPolicyApp = createApp({ db: openDatabase(':memory:'), env: {}, now: () => clock, aiAdapter: { async generate() { clock += 3000; return { imageData, provider: 'test' }; }, async edit() { clock += 3000; return { imageData, provider: 'test' }; } } });
  const owner = await request(defaultPolicyApp).post('/api/sessions').send({ nickname: 'default-policy' });
  assert.deepEqual(owner.body.generationPolicy, { maxGenerations: 0, cooldownMs: 10000, retryAfterMs: 0, inFlight: false });
  for (let i = 0; i < 3; i += 1) {
    const generated = await request(defaultPolicyApp).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'робот в космосе' });
    assert.equal(generated.status, 201);
    assert.equal(generated.body.generationCount, i + 1);
    assert.equal(generated.body.generationPolicy.retryAfterMs, 7000);
    clock += 7000;
  }
});

test('provider failure clears the lock and allows an immediate retry without losing the saved image', async () => {
  let clock = 0;
  let calls = 0;
  const failureApp = createApp({ db: openDatabase(':memory:'), env: {}, now: () => clock, aiAdapter: { async generate() {
    calls += 1;
    return { imageData, provider: 'test' };
  }, async edit() {
    calls += 1;
    if (calls === 2) throw new AiAdapterError('request rejected', { code: 'CLIENT_ERROR', status: 400 });
    return { imageData, provider: 'test' };
  } } });
  const owner = await request(failureApp).post('/api/sessions').send({ nickname: 'failure-cooldown' });
  const first = await request(failureApp).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'робот в космосе' });
  clock = 10000;
  const failure = await request(failureApp).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'дракон с рюкзаком' });
  assert.equal(failure.status, 400);
  assert.equal(failure.body.generationPolicy.retryAfterMs, 0);
  assert.equal(failure.body.generationPolicy.inFlight, false);
  const blocked = await request(failureApp).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'робот в космосе' });
  assert.equal(blocked.status, 201);
  assert.equal(blocked.body.generationPolicy.retryAfterMs, 10000);
  assert.equal(calls, 3);
  const snapshot = await request(failureApp).get(`/api/sessions/${owner.body.id}`);
  assert.equal(snapshot.body.generationCount, 2);
  assert.equal(snapshot.body.latestGeneration.id, blocked.body.id);
  assert.equal(snapshot.body.latestGeneration.imageData, imageData);
});

test('short safe descriptions and invented names are accepted without substring false positives', async () => {
  let calls = 0;
  const safeApp = createApp({ db: openDatabase(':memory:'), env: { GENERATION_COOLDOWN_MS: '0' }, aiAdapter: { async generate() { calls += 1; return { imageData, provider: 'test' }; }, async edit() { calls += 1; return { imageData, provider: 'test' }; } } });
  const owner = await request(safeApp).post('/api/sessions').send({ nickname: 'short-prompts' });
  const prompts = ['робот в космосе', 'дракон с рюкзаком', 'волшебник в стиле пиксель-арт', 'добрый дракон', 'искатель сокровищ', 'дракон нашёл сокровище', 'робот рядом с кроватью', 'сказочный монарх', 'Zxkrth', 'Грмкс', 'герой 2026 года', 'ученик школы магии'];
  for (const prompt of prompts) {
    const response = await request(safeApp).post('/api/generate').send({ sessionId: owner.body.id, prompt });
    assert.equal(response.status, 201, prompt);
  }
  assert.equal(calls, prompts.length);
});

test('Cyrillic personal-data cues and unsafe terms never reach the adapter', async () => {
  let calls = 0;
  const safeApp = createApp({ db: openDatabase(':memory:'), env: {}, aiAdapter: { async generate() { calls += 1; return { imageData }; } } });
  const owner = await request(safeApp).post('/api/sessions').send({ nickname: 'private-prompts' });
  const privatePrompts = ['меня зовут Миша', 'мой адрес улица Ленина 7', 'школа № 7', 'ученик школы номер 12', 'робот, телефон +7 (999) 123-45-67', 'робот для child@example.com', 'мой телефон 1234567', 'меня зовут Оля, я герой будущего'];
  for (const prompt of privatePrompts) {
    const response = await request(safeApp).post('/api/generate').send({ sessionId: owner.body.id, prompt });
    assert.equal(response.status, 400, prompt);
    assert.match(response.body.error, /личные данные/);
    assert.equal(response.body.generationPolicy.retryAfterMs, 0);
  }
  for (const prompt of ['персонаж с оружием', 'герой весь в крови', 'наркотики у робота', 'nude character', 'кровавый персонаж']) {
    assert.equal((await request(safeApp).post('/api/generate').send({ sessionId: owner.body.id, prompt })).status, 400, prompt);
  }
  assert.equal(calls, 0);
});

test('session restore selects the latest generation when timestamps tie', async () => {
  const owner = await createSession('same-second-restore');
  const first = await request(app).post('/api/generate').send({ sessionId: owner, prompt: 'робот в космосе' });
  const latest = await request(app).post('/api/generate').send({ sessionId: owner, prompt: 'дракон с рюкзаком' });
  assert.equal(first.status, 201);
  assert.equal(latest.status, 201);
  app.locals.db.prepare("UPDATE generations SET created_at = '2026-09-24 12:00:00' WHERE session_id = ?").run(owner);
  const snapshot = await request(app).get(`/api/sessions/${owner}`);
  assert.equal(snapshot.body.latestGeneration.id, latest.body.id);
  assert.equal(snapshot.body.latestGeneration.prompt, 'дракон с рюкзаком');
  assert.equal(snapshot.body.generationCount, 2);
});

test('publication time is set on publishing and preserved on retry or admin show', async () => {
  const owner = await createSession('publication-time');
  const draft = await request(app).post('/api/works').send({ sessionId: owner, prompt: 'робот в космосе', imageData });
  const id = draft.body.id;
  app.locals.db.prepare("UPDATE works SET created_at = '2020-01-01 00:00:00' WHERE id = ?").run(id);
  assert.equal(app.locals.db.prepare('SELECT published_at FROM works WHERE id = ?').get(id).published_at, null);
  const published = await request(app).post(`/api/works/${id}/publish`).send({ sessionId: owner });
  assert.equal(published.status, 200);
  assert.ok(published.body.work.publishedAt);
  assert.notEqual(published.body.work.publishedAt, published.body.work.createdAt);
  // A past sentinel ensures an accidental rewrite fails without sleeping.
  const originalTime = '2025-01-01 00:00:00';
  app.locals.db.prepare('UPDATE works SET published_at = ? WHERE id = ?').run(originalTime, id);
  const retry = await request(app).post(`/api/works/${id}/publish`).send({ sessionId: owner });
  assert.equal(retry.body.work.publishedAt, originalTime);
  await request(app).patch(`/api/admin/works/${id}`).set('x-admin-token', 'test-admin').send({ hidden: true });
  await request(app).patch(`/api/admin/works/${id}`).set('x-admin-token', 'test-admin').send({ hidden: false });
  const list = await request(app).get('/api/admin/works').set('x-admin-token', 'test-admin');
  assert.equal(list.body.works.find((item) => item.id === id).publishedAt, originalTime);
});

test('provider labels extend rather than replace the machine-readable provider field', async () => {
  const mockHealth = await request(app).get('/api/health');
  assert.equal(mockHealth.body.provider, 'mock');
  assert.equal(mockHealth.body.providerLabel, 'Mock');
  const gateway = createApp({ db: openDatabase(':memory:'), env: { AI_PROVIDER: 'http', AI_API_URL: 'https://images.example.test/v1/images/generations', AI_MODEL: 'configured-image-model', AI_API_KEY: 'never-visible', ADMIN_TOKEN: 'label-test' }, aiAdapter: {} });
  const status = await request(gateway).get('/api/admin/status').set('x-admin-token', 'label-test');
  assert.equal(status.body.provider, 'http');
  assert.equal(status.body.providerLabel, 'HTTP API');
  assert.equal(status.body.model, 'configured-image-model');
  assert.equal(JSON.stringify(status.body).includes('never-visible'), false);
});

test('maps a provider rate limit to a retryable API response', async () => {
  const limitedApp = createApp({
    db: openDatabase(':memory:'),
    aiAdapter: { async generate() { throw new AiAdapterError('slow down', { code: 'RATE_LIMIT', status: 429, retryAfterMs: 2500 }); } },
  });
  const owner = await request(limitedApp).post('/api/sessions').send({ nickname: `limited-${Date.now()}` });
  const response = await request(limitedApp).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'friendly robot' });
  assert.equal(response.status, 429);
  assert.equal(response.body.code, 'RATE_LIMIT');
  assert.equal(response.body.retryAfterMs, 2500);
  assert.equal(typeof response.body.durationMs, 'number');
});

test('maps provider invalid_request to a neutral integration error, not a participant prompt error', async () => {
  let calls = 0;
  const invalidRequestApp = createApp({
    db: openDatabase(':memory:'),
    env: { AI_MODEL: 'gpt-image-2.5-sunburst', AI_FALLBACK_MODEL: 'gpt-image-2', GENERATION_COOLDOWN_MS: '0' },
    aiAdapter: { async generate() {
      calls += 1;
      throw new AiAdapterError('The image provider could not process this request. Check the request body and model name.', {
        code: 'CLIENT_ERROR', status: 400, source: 'provider', providerStatus: 400,
        providerErrorCode: 'invalid_request', providerErrorType: 'invalid_request_error',
        providerErrorMessage: 'The image provider could not process this request. Check the request body and model name.',
        requestId: 'gyw-invalid-request-test', requestFields: ['model', 'prompt', 'n', 'response_format'],
      });
    } },
  });
  const owner = await request(invalidRequestApp).post('/api/sessions').send({ nickname: 'integration-error' });
  const response = await request(invalidRequestApp).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'friendly robot' });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'INTEGRATION_ERROR');
  assert.match(response.body.error, /технические параметры запроса/i);
  assert.doesNotMatch(response.body.error, /описание|изменить его/i);
  assert.equal(calls, 1);
});

test('retries one transient provider failure and does not retry content rejection', async () => {
  let calls = 0;
  const retryApp = createApp({
    db: openDatabase(':memory:'),
    env: { GENERATION_COOLDOWN_MS: '0' },
    aiAdapter: { async generate() {
      calls += 1;
      if (calls === 1) throw new AiAdapterError('temporary', { code: 'PROVIDER_ERROR', status: 503 });
      return { imageData, provider: 'test' };
    } },
  });
  const owner = await request(retryApp).post('/api/sessions').send({ nickname: `retry-${Date.now()}` });
  const success = await request(retryApp).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'friendly robot' });
  assert.equal(success.status, 201);
  assert.equal(calls, 2);

  let rejectedCalls = 0;
  const rejectApp = createApp({
    db: openDatabase(':memory:'),
    env: { GENERATION_COOLDOWN_MS: '0' },
    aiAdapter: { async generate() {
      rejectedCalls += 1;
      throw new AiAdapterError('blocked', { code: 'CONTENT_REJECT', status: 400 });
    } },
  });
  const rejectedOwner = await request(rejectApp).post('/api/sessions').send({ nickname: `reject-${Date.now()}` });
  const rejected = await request(rejectApp).post('/api/generate').send({ sessionId: rejectedOwner.body.id, prompt: 'friendly robot' });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.code, 'CONTENT_REJECT');
  assert.equal(rejectedCalls, 1);
});

test('does not retry malformed provider responses even when mapped to 502', async () => {
  let calls = 0;
  const malformedApp = createApp({
    db: openDatabase(':memory:'),
    env: { GENERATION_COOLDOWN_MS: '0' },
    aiAdapter: { async generate() {
      calls += 1;
      throw new AiAdapterError('invalid response', { code: 'INVALID_RESPONSE', status: 502 });
    } },
  });
  const owner = await request(malformedApp).post('/api/sessions').send({ nickname: 'bad-response' });
  const response = await request(malformedApp).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'friendly robot' });
  assert.equal(response.status, 502);
  assert.equal(response.body.code, 'INVALID_RESPONSE');
  assert.equal(calls, 1);
});

test('generation model fallback follows Flare, retry, then fallback sequence', async () => {
  const scenarios = [
    { name: 'flare success', errors: [], expected: ['gpt-image-2.5-flare'] },
    { name: 'flare retry success', errors: ['503'], expected: ['gpt-image-2.5-flare', 'gpt-image-2.5-flare'] },
    { name: 'fallback after two 503', errors: ['503', '503'], expected: ['gpt-image-2.5-flare', 'gpt-image-2.5-flare', 'gpt-image-2'] },
    { name: 'fallback after two timeouts', errors: ['TIMEOUT', 'TIMEOUT'], expected: ['gpt-image-2.5-flare', 'gpt-image-2.5-flare', 'gpt-image-2'] },
    { name: 'fallback after two rate limits', errors: ['429', '429'], expected: ['gpt-image-2.5-flare', 'gpt-image-2.5-flare', 'gpt-image-2'] },
    { name: 'auth stops', errors: ['401'], expected: ['gpt-image-2.5-flare'] },
    { name: 'forbidden stops', errors: ['403'], expected: ['gpt-image-2.5-flare'] },
    { name: 'content reject stops', errors: ['CONTENT_REJECT'], expected: ['gpt-image-2.5-flare'] },
    { name: 'malformed stops', errors: ['INVALID_RESPONSE'], expected: ['gpt-image-2.5-flare'] },
    { name: 'fallback failure stops', errors: ['503', '503', '503'], expected: ['gpt-image-2.5-flare', 'gpt-image-2.5-flare', 'gpt-image-2'] },
    { name: 'fallback timeout stops', errors: ['TIMEOUT', 'TIMEOUT', 'TIMEOUT'], expected: ['gpt-image-2.5-flare', 'gpt-image-2.5-flare', 'gpt-image-2'] },
  ];
  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    const calls = [];
    const app = createApp({
      db: openDatabase(':memory:'),
      env: { AI_MODEL: 'gpt-image-2.5-flare', AI_FALLBACK_MODEL: 'gpt-image-2', GENERATION_COOLDOWN_MS: '0' },
      aiAdapter: { async generate(prompt, model) {
        calls.push(model);
        const error = scenario.errors[calls.length - 1];
        if (error) {
          const code = error === 'TIMEOUT' ? 'TIMEOUT' : error === 'CONTENT_REJECT' ? 'CONTENT_REJECT' : error === 'INVALID_RESPONSE' ? 'INVALID_RESPONSE' : error === '401' || error === '403' ? 'AUTH' : error === '429' ? 'RATE_LIMIT' : 'PROVIDER_ERROR';
          throw new AiAdapterError('test failure', { code, status: error === 'TIMEOUT' ? 504 : Number(error) || (code === 'CONTENT_REJECT' ? 400 : code === 'INVALID_RESPONSE' ? 502 : 503) });
        }
        return { imageData, provider: 'test' };
      } },
    });
    const owner = await request(app).post('/api/sessions').send({ nickname: `fallback-${scenarioIndex}` });
    const response = await request(app).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'friendly robot' });
    assert.deepEqual(calls, scenario.expected, scenario.name);
    if (scenario.name === 'flare success' || scenario.name === 'flare retry success' || scenario.name.startsWith('fallback after')) assert.equal(response.status, 201, scenario.name);
    else assert.notEqual(response.status, 201, scenario.name);
    if (scenario.name.startsWith('fallback ')) {
      assert.equal(calls.length, 3);
      const snapshot = await request(app).get(`/api/sessions/${owner.body.id}`);
      assert.equal(snapshot.body.generationPolicy.inFlight, false, scenario.name);
    }
  }
});

test('generation circuit breaker skips the primary during cooldown and probes it after TTL', async () => {
  let clock = 100000;
  const calls = [];
  let primaryFailures = 0;
  const circuitApp = createApp({
    db: openDatabase(':memory:'),
    now: () => clock,
    env: {
      AI_MODEL: 'gpt-image-2.5-sunburst',
      AI_FALLBACK_MODEL: 'gpt-image-2',
      AI_PRIMARY_UNHEALTHY_MS: '1000',
      GENERATION_COOLDOWN_MS: '0',
      ADMIN_TOKEN: 'circuit-admin',
    },
    aiAdapter: {
      async generate(prompt, model) {
        calls.push(model);
        if (model === 'gpt-image-2.5-sunburst' && primaryFailures < 2) {
          primaryFailures += 1;
          throw new AiAdapterError('temporary primary failure', { code: 'PROVIDER_ERROR', status: 503 });
        }
        return { imageData, provider: 'test' };
      },
    },
  });
  const makeOwner = async (nickname) => (await request(circuitApp).post('/api/sessions').send({ nickname })).body.id;

  const first = await request(circuitApp).post('/api/generate').send({ sessionId: await makeOwner('circuit-one'), prompt: 'friendly robot' });
  assert.equal(first.status, 201);
  assert.deepEqual(calls, ['gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst', 'gpt-image-2']);
  let status = await request(circuitApp).get('/api/admin/status').set('x-admin-token', 'circuit-admin');
  assert.equal(status.body.model, 'gpt-image-2.5-sunburst');
  assert.equal(status.body.fallbackModel, 'gpt-image-2');
  assert.equal(status.body.primaryHealth.state, 'unhealthy');
  assert.ok(status.body.primaryHealth.retryAfterSec >= 1);

  const duringCooldown = await request(circuitApp).post('/api/generate').send({ sessionId: await makeOwner('circuit-two'), prompt: 'friendly dragon' });
  assert.equal(duringCooldown.status, 201);
  assert.deepEqual(calls.slice(3), ['gpt-image-2']);

  clock += 1001;
  const probe = await request(circuitApp).post('/api/generate').send({ sessionId: await makeOwner('circuit-three'), prompt: 'friendly fox' });
  assert.equal(probe.status, 201);
  assert.deepEqual(calls.slice(4), ['gpt-image-2.5-sunburst']);
  status = await request(circuitApp).get('/api/admin/status').set('x-admin-token', 'circuit-admin');
  assert.equal(status.body.primaryHealth.state, 'healthy');
});

test('half-open retryable failure reopens the generation circuit and non-retryable errors do not fallback', async () => {
  let clock = 50000;
  const calls = [];
  const outcomes = [
    new AiAdapterError('temporary', { code: 'PROVIDER_ERROR', status: 503 }),
    new AiAdapterError('temporary', { code: 'PROVIDER_ERROR', status: 503 }),
    null,
    new AiAdapterError('temporary', { code: 'PROVIDER_ERROR', status: 503 }),
    new AiAdapterError('temporary', { code: 'PROVIDER_ERROR', status: 503 }),
    new AiAdapterError('invalid request', { code: 'CLIENT_ERROR', status: 400 }),
  ];
  const circuitApp = createApp({
    db: openDatabase(':memory:'),
    now: () => clock,
    env: { AI_MODEL: 'gpt-image-2.5-sunburst', AI_FALLBACK_MODEL: 'gpt-image-2', AI_PRIMARY_UNHEALTHY_MS: '100', GENERATION_COOLDOWN_MS: '0', ADMIN_TOKEN: 'half-open-admin' },
    aiAdapter: {
      async generate(prompt, model) {
        calls.push(model);
        const outcome = outcomes.shift();
        if (outcome && model === 'gpt-image-2.5-sunburst') throw outcome;
        return { imageData, provider: 'test' };
      },
    },
  });
  const owner = async (nickname) => (await request(circuitApp).post('/api/sessions').send({ nickname })).body.id;
  await request(circuitApp).post('/api/generate').send({ sessionId: await owner('half-one'), prompt: 'robot' });
  clock += 101;
  const reopened = await request(circuitApp).post('/api/generate').send({ sessionId: await owner('half-two'), prompt: 'robot explorer' });
  assert.equal(reopened.status, 201);
  const status = await request(circuitApp).get('/api/admin/status').set('x-admin-token', 'half-open-admin');
  assert.equal(status.body.primaryHealth.state, 'unhealthy');
  assert.deepEqual(calls.slice(3), ['gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst', 'gpt-image-2']);

  // A client error is terminal and must not invoke the fallback model.
  const terminalCalls = [];
  const terminalApp = createApp({
    db: openDatabase(':memory:'),
    env: { AI_MODEL: 'gpt-image-2.5-sunburst', AI_FALLBACK_MODEL: 'gpt-image-2', GENERATION_COOLDOWN_MS: '0' },
    aiAdapter: { async generate(prompt, model) {
      terminalCalls.push(model);
      throw new AiAdapterError('invalid request', { code: 'CLIENT_ERROR', status: 400 });
    } },
  });
  const terminalOwner = (await request(terminalApp).post('/api/sessions').send({ nickname: 'client-error' })).body.id;
  const nonRetryable = await request(terminalApp).post('/api/generate').send({ sessionId: terminalOwner, prompt: 'robot with a clear description' });
  assert.equal(nonRetryable.status, 400);
  assert.deepEqual(terminalCalls, ['gpt-image-2.5-sunburst']);
});

test('generation circuit health is unaffected by edits', async () => {
  const calls = [];
  const circuitApp = createApp({
    db: openDatabase(':memory:'),
    env: { AI_MODEL: 'gpt-image-2.5-sunburst', AI_FALLBACK_MODEL: 'gpt-image-2', GENERATION_COOLDOWN_MS: '0' },
    aiAdapter: {
      async generate(prompt, model) { calls.push({ type: 'generate', model }); return { imageData, provider: 'test' }; },
      async edit(prompt, reference, model) {
        calls.push({ type: 'edit', model, reference });
        throw new AiAdapterError('edit unavailable', { code: 'PROVIDER_ERROR', status: 503 });
      },
    },
  });
  const owner = (await request(circuitApp).post('/api/sessions').send({ nickname: 'edit-health' })).body.id;
  assert.equal((await request(circuitApp).post('/api/generate').send({ sessionId: owner, prompt: 'friendly robot' })).status, 201);
  assert.equal((await request(circuitApp).post('/api/generate').send({ sessionId: owner, prompt: 'add a hat' })).status, 503);
  assert.deepEqual(calls.map((call) => call.type), ['generate', 'edit', 'edit']);
  assert.deepEqual(calls.slice(1).map((call) => call.model), ['gpt-image-2.5-flare', 'gpt-image-2.5-flare']);
  const status = await request(circuitApp).get('/api/admin/status');
  assert.equal(status.status, 401);
});

test('edit keeps the same reference and does not use unconfirmed fallback model', async () => {
  const calls = [];
  const app = createApp({
    db: openDatabase(':memory:'),
    env: { AI_MODEL: 'gpt-image-2.5-flare', AI_FALLBACK_MODEL: 'gpt-image-2', GENERATION_COOLDOWN_MS: '0' },
    aiAdapter: {
      async generate(prompt, model) { calls.push({ type: 'generate', model }); return { imageData, provider: 'test' }; },
      async edit(prompt, reference, model) {
        calls.push({ type: 'edit', model, reference });
        throw new AiAdapterError('edit unavailable', { code: 'PROVIDER_ERROR', status: 503 });
      },
    },
  });
  const owner = await request(app).post('/api/sessions').send({ nickname: 'edit-fallback' });
  await request(app).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'friendly robot' });
  const failed = await request(app).post('/api/generate').send({ sessionId: owner.body.id, prompt: 'add a scarf' });
  assert.equal(failed.status, 503);
  assert.deepEqual(calls.map((call) => call.type), ['generate', 'edit', 'edit']);
  assert.deepEqual(calls.slice(1).map((call) => call.model), ['gpt-image-2.5-flare', 'gpt-image-2.5-flare']);
  assert.equal(calls[1].reference, imageData);
  assert.equal(calls[2].reference, imageData);
});

test('client abort does not leave an eternal active-generation lock', async () => {
  let resolveProvider;
  const appWithSlowProvider = createApp({
    db: openDatabase(':memory:'),
    env: { GENERATION_COOLDOWN_MS: '0' },
    aiAdapter: { async generate() {
      await new Promise((resolve) => { resolveProvider = resolve; });
      return { imageData, provider: 'test' };
    } },
  });
  const server = await new Promise((resolve) => {
    const listener = appWithSlowProvider.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const owner = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: 'abort-test' }) }).then((res) => res.json());
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${server.address().port}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: owner.id, prompt: 'friendly robot' }), signal: controller.signal }).catch(() => null);
    for (let i = 0; i < 50 && !resolveProvider; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    resolveProvider();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const snapshot = await request(appWithSlowProvider).get(`/api/sessions/${owner.id}`);
    assert.equal(snapshot.body.generationPolicy.inFlight, false);
    assert.equal(snapshot.body.generationCount, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('keeps one primary work per participant', async () => {
  const sessionId = await createSession(`single-${Date.now()}`);
  const first = await request(app).post('/api/works').send({ sessionId, prompt: 'safe avatar', imageData });
  assert.equal(first.status, 201);
  const second = await request(app).post('/api/works').send({ sessionId, prompt: 'another avatar', imageData });
  assert.equal(second.status, 200);
  assert.equal(second.body.id, first.body.id);
  await request(app).post(`/api/works/${first.body.id}/publish`).send({ sessionId });
  const third = await request(app).post('/api/works').send({ sessionId, prompt: 'third avatar', imageData });
  assert.equal(third.status, 409);
  const extraGeneration = await request(app).post('/api/generate').send({ sessionId, prompt: 'extra avatar' });
  assert.equal(extraGeneration.status, 409);
});

test('rejects an image data URL that is not base64 encoded image data', async () => {
  const sessionId = await createSession(`image-${Date.now()}`);
  const unsafe = await request(app).post('/api/works').send({
    sessionId,
    prompt: 'safe avatar',
    imageData: 'data:image/svg+xml,<svg onload="alert(1)"></svg>',
  });
  assert.equal(unsafe.status, 400);
});

test('rejects personal data and unsafe Russian prompt terms', async () => {
  const sessionId = await createSession(`safe-${Date.now()}`);
  const email = await request(app).post('/api/generate').send({ sessionId, prompt: 'портрет для child@example.com' });
  assert.equal(email.status, 400);
  const unsafe = await request(app).post('/api/generate').send({ sessionId, prompt: 'персонаж с оружием' });
  assert.equal(unsafe.status, 400);
});

test('does not consume a second generation slot on concurrent clicks', async () => {
  let release;
  let started;
  let calls = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const delayedApp = createApp({
    db: openDatabase(':memory:'),
    aiAdapter: {
      async generate() {
        calls += 1;
        started();
        await pending;
        return { imageData, provider: 'test' };
      },
    },
  });
  const created = await request(delayedApp).post('/api/sessions').send({ nickname: `race-${Date.now()}` });
  const sessionId = created.body.id;
  const firstPromise = request(delayedApp).post('/api/generate').send({ sessionId, prompt: 'friendly robot' });
  // Attach a handler so Supertest starts the request, then wait until the
  // adapter confirms that the session slot is occupied.
  firstPromise.then(() => {}, () => {});
  await startedPromise;
  const second = await request(delayedApp).post('/api/generate').send({ sessionId, prompt: 'friendly dragon' });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'GENERATION_IN_PROGRESS');
  assert.equal(second.body.generationPolicy.inFlight, true);
  assert.equal(calls, 1);
  const snapshot = await request(delayedApp).get(`/api/sessions/${sessionId}`);
  assert.equal(snapshot.body.generationPolicy.inFlight, true);
  release();
  const first = await firstPromise;
  assert.equal(first.status, 201);
  assert.equal(first.body.generationPolicy.inFlight, false);
});

test('returns JSON errors for malformed JSON and null request bodies', async () => {
  const malformed = await request(app)
    .post('/api/sessions')
    .set('content-type', 'application/json')
    .send('{');
  assert.equal(malformed.status, 400);
  assert.equal(typeof malformed.body.error, 'string');

  const empty = await request(app).post('/api/sessions').send(null);
  assert.equal(empty.status, 400);
  assert.equal(typeof empty.body.error, 'string');
});

test('returns JSON 404 for an unknown API route', async () => {
  const response = await request(app).get('/api/does-not-exist');
  assert.equal(response.status, 404);
  assert.equal(typeof response.body.error, 'string');
});

test('primary generation circuit skips unhealthy sunburst and probes it after TTL', async () => {
  let clock = 0;
  const sequence = [];
  const calls = [];
  const errorFor = (value) => new AiAdapterError('temporary test failure', {
    code: value === '429' ? 'RATE_LIMIT' : value === 'TIMEOUT' ? 'TIMEOUT' : 'PROVIDER_ERROR',
    status: value === '429' ? 429 : value === 'TIMEOUT' ? 504 : 503,
  });
  const appWithCircuit = createApp({
    db: openDatabase(':memory:'),
    now: () => clock,
    env: { AI_MODEL: 'gpt-image-2.5-sunburst', AI_FALLBACK_MODEL: 'gpt-image-2', AI_PRIMARY_UNHEALTHY_MS: '1000', GENERATION_COOLDOWN_MS: '0', ADMIN_TOKEN: 'circuit-admin' },
    aiAdapter: { async generate(prompt, model) {
      calls.push(model);
      const next = sequence.shift();
      if (next) throw errorFor(next);
      return { imageData, provider: 'test' };
    }, async edit() { return { imageData, provider: 'test' }; } },
  });
  const generate = async (nickname) => {
    const session = await request(appWithCircuit).post('/api/sessions').send({ nickname });
    assert.equal(session.status, 201);
    return request(appWithCircuit).post('/api/generate').send({ sessionId: session.body.id, prompt: 'friendly robot' });
  };

  sequence.push(null);
  assert.equal((await generate('cb-success')).status, 201);
  assert.deepEqual(calls.splice(0), ['gpt-image-2.5-sunburst']);

  sequence.push('503', null);
  assert.equal((await generate('cb-retry')).status, 201);
  assert.deepEqual(calls.splice(0), ['gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst']);

  sequence.push('503', '503', null);
  assert.equal((await generate('cb-fallback')).status, 201);
  assert.deepEqual(calls.splice(0), ['gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst', 'gpt-image-2']);
  let status = await request(appWithCircuit).get('/api/admin/status').set('x-admin-token', 'circuit-admin');
  assert.equal(status.status, 200);
  assert.equal(status.body.primaryHealth.state, 'unhealthy');
  assert.ok(status.body.primaryHealth.retryAfterSec >= 1);

  sequence.push(null);
  assert.equal((await generate('cb-bypass')).status, 201);
  assert.deepEqual(calls.splice(0), ['gpt-image-2']);

  clock = 1000;
  status = await request(appWithCircuit).get('/api/admin/status').set('x-admin-token', 'circuit-admin');
  assert.equal(status.body.primaryHealth.state, 'half_open');
  sequence.push(null);
  assert.equal((await generate('cb-half-open-success')).status, 201);
  assert.deepEqual(calls.splice(0), ['gpt-image-2.5-sunburst']);

  sequence.push('503', '503', null);
  assert.equal((await generate('cb-half-open-fail')).status, 201);
  assert.deepEqual(calls.splice(0), ['gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst', 'gpt-image-2']);
});

test('non-retryable primary errors never invoke generation fallback', async () => {
  const calls = [];
  const appWithClientError = createApp({
    db: openDatabase(':memory:'),
    env: { AI_MODEL: 'gpt-image-2.5-sunburst', AI_FALLBACK_MODEL: 'gpt-image-2', GENERATION_COOLDOWN_MS: '0' },
    aiAdapter: { async generate(prompt, model) {
      calls.push(model);
      throw new AiAdapterError('invalid prompt', { code: 'CLIENT_ERROR', status: 400 });
    }, async edit() { throw new AiAdapterError('edit unavailable', { code: 'CLIENT_ERROR', status: 400 }); } },
  });
  const session = await request(appWithClientError).post('/api/sessions').send({ nickname: 'cb-client-error' });
  const response = await request(appWithClientError).post('/api/generate').send({ sessionId: session.body.id, prompt: 'friendly robot' });
  assert.equal(response.status, 400);
  assert.deepEqual(calls, ['gpt-image-2.5-sunburst']);
});

test('ordered generation pool fails over and tracks independent model health', async () => {
  let clock = 0;
  const calls = [];
  const failures = new Map([['gpt-image-2.5-sunburst', 1], ['gpt-image-2', 1]]);
  const poolApp = createApp({
    db: openDatabase(':memory:'),
    now: () => clock,
    env: { AI_GENERATION_MODELS: 'gpt-image-2.5-sunburst,gpt-image-2,gpt-image-2.5-flare', AI_PRIMARY_UNHEALTHY_MS: '1000', GENERATION_COOLDOWN_MS: '0', ADMIN_TOKEN: 'pool-admin' },
    aiAdapter: { async generate(prompt, model) {
      calls.push(model);
      if ((failures.get(model) || 0) > 0) {
        failures.set(model, failures.get(model) - 1);
        throw new AiAdapterError('temporary', { code: 'PROVIDER_ERROR', status: 503 });
      }
      return { imageData, provider: 'test' };
    } },
  });
  const session = (await request(poolApp).post('/api/sessions').send({ nickname: 'pool-check' })).body.id;
  const first = await request(poolApp).post('/api/generate').send({ sessionId: session, prompt: 'friendly robot explorer' });
  assert.equal(first.status, 201);
  assert.deepEqual(calls, ['gpt-image-2.5-sunburst', 'gpt-image-2', 'gpt-image-2.5-flare']);
  let status = await request(poolApp).get('/api/admin/status').set('x-admin-token', 'pool-admin');
  assert.equal(status.body.generationModels[0].state, 'unhealthy');
  assert.equal(status.body.generationModels[1].state, 'unhealthy');
  clock = 1001;
  const second = await request(poolApp).post('/api/sessions').send({ nickname: 'pool-half' });
  const probe = await request(poolApp).post('/api/generate').send({ sessionId: second.body.id, prompt: 'friendly dragon explorer' });
  assert.equal(probe.status, 201);
  assert.equal(calls.at(-1), 'gpt-image-2.5-sunburst');
  status = await request(poolApp).get('/api/admin/status').set('x-admin-token', 'pool-admin');
  assert.equal(status.body.generationModels[0].state, 'healthy');
});

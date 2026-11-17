'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// An isolated, counted mock: this run never reads development keys or changes its DB.
process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.AI_PROVIDER = 'mock';
process.env.ADMIN_TOKEN = 'ui-test-token';
process.env.GENERATION_COOLDOWN_MS = '10000';
process.env.MAX_GENERATIONS_PER_SESSION = '0';
delete process.env.AI_API_KEY;
delete process.env.AI_API_URL;
const exportedApp = require('../src/app');
const { createMockAdapter, AiAdapterError } = require('../ai-adapter');
const { openDatabase } = require('../db');
const artifactsDir = path.join(__dirname, '..', 'artifacts', 'ui');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

async function visible(page, selector) { await page.locator(selector).waitFor({ state: 'visible', timeout: 5000 }); }
async function idle(page, selector) {
  await page.waitForFunction((target) => {
    const element = document.querySelector(target);
    return element && element.getAttribute('aria-busy') !== 'true' && !element.classList.contains('is-loading');
  }, selector, { timeout: 5000 });
}
async function buttonState(button, loading) {
  await button.hover({ force: true });
  const state = await button.evaluate((element) => ({ disabled: element.disabled, cursor: getComputedStyle(element).cursor, ariaBusy: element.getAttribute('aria-busy'), spinner: getComputedStyle(element, '::before').content }));
  assert.equal(state.disabled, true);
  assert.equal(state.cursor, loading ? 'progress' : 'not-allowed', 'hover must distinguish request progress from unavailable controls');
  if (loading) assert.equal(state.ariaBusy, 'true');
  else {
    assert.notEqual(state.ariaBusy, 'true');
    assert.ok(['none', 'normal'].includes(state.spinner), 'disabled idle controls must have no spinner');
  }
}
async function screenshots(page, state) {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(size.document <= size.width && size.body <= size.width, `${state}: horizontal overflow at ${width}px ${JSON.stringify(size)}`);
    await page.screenshot({ path: path.join(artifactsDir, `${state}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}
async function poll(page, endpoint) {
  const response = page.waitForResponse((result) => new URL(result.url()).pathname === endpoint, { timeout: 5000 });
  await page.clock.fastForward(7100);
  await response;
  // The endpoint response arrives before the parallel polling cycle has
  // rendered its result; give the page a turn to apply the snapshot and
  // warning threshold before assertions inspect the UI.
  await page.waitForTimeout(50);
}
async function waitLikes(page, selector, expected) {
  await page.waitForFunction(({ target, count }) => document.querySelector(target)?.textContent.trim() === String(count), { target: selector, count: expected }, { timeout: 5000 });
}

async function main() {
  fs.mkdirSync(artifactsDir, { recursive: true });
  let serverNow = Date.now();
  let adapterCalls = 0;
  const adapterHistory = [];
  let providerGate = null;
  let nextProviderError = null;
  const mock = createMockAdapter();
  const app = exportedApp.createApp({
    db: openDatabase(':memory:'),
    env: { AI_PROVIDER: 'mock', ADMIN_TOKEN: 'ui-test-token', GENERATION_COOLDOWN_MS: '10000', MAX_GENERATIONS_PER_SESSION: '0' },
    now: () => serverNow,
    aiAdapter: {
      async generate(prompt) {
        adapterCalls += 1;
        adapterHistory.push({ type: 'generate', prompt });
        if (providerGate) await providerGate.promise;
        if (nextProviderError) { const error = nextProviderError; nextProviderError = null; throw error; }
        return mock.generate(prompt);
      },
      async edit(prompt, referenceImage) {
        adapterCalls += 1;
        adapterHistory.push({ type: 'edit', prompt, referenceImage });
        if (providerGate) await providerGate.promise;
        if (nextProviderError) { const error = nextProviderError; nextProviderError = null; throw error; }
        return mock.edit(prompt, referenceImage);
      },
    },
  });
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function api(endpoint, body, method = body ? 'POST' : 'GET', extraHeaders = {}) {
    const response = await fetch(origin + endpoint, { method, headers: { 'content-type': 'application/json', ...extraHeaders }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = response.status === 204 ? {} : await response.json();
    assert.ok(response.ok, `${method} ${endpoint}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  }
  async function publishFixture(nickname, prompt = 'робот в космосе') {
    const session = await api('/api/sessions', { nickname });
    const generation = await api('/api/generate', { sessionId: session.id, prompt });
    const draft = await api('/api/works', { sessionId: session.id, generationId: generation.id });
    const result = await api(`/api/works/${draft.id}/publish`, { sessionId: session.id });
    return { session, generation, work: result.work };
  }
  let browser;
    const pageErrors = [];
  try {
    try { browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true }); }
    catch (error) {
      if (process.env.BROWSER_CHANNEL) throw error;
      console.warn('System Chrome unavailable; using Playwright Chromium.');
      browser = await chromium.launch({ headless: true });
    }
    async function newPage() {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.clock.install({ time: new Date(serverNow) });
      return page;
    }
    async function login(page, nickname) {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await page.locator('#nickname').fill(nickname);
      await page.locator('#loginForm').getByRole('button').click();
      await visible(page, '#workspace');
      await visible(page, '#createSection');
      return page.evaluate(() => localStorage.getItem('avatarSessionId'));
    }
    async function endCooldown(page) {
      serverNow += 11000;
      await page.clock.fastForward(11000);
      await page.waitForFunction(() => !document.querySelector('#attemptLabel')?.textContent.includes('через'));
    }
    async function runTimedVersion(page, prompt, durationMs) {
      await page.locator('#prompt').fill(prompt);
      providerGate = deferred();
      await page.evaluate(() => { window.__progressValues = []; });
      await page.locator('#generate').click();
      await page.waitForFunction(() => document.querySelector('#generate').getAttribute('aria-busy') === 'true');
      await page.evaluate(() => {
        const target = document.querySelector('[role="progressbar"]');
        new MutationObserver(() => window.__progressValues.push(Number(target.getAttribute('aria-valuenow')))).observe(target, { attributes: true });
      });
      let previous = 0;
      const checkpoints = [];
      for (const fraction of [0.25, 0.5, 0.75, 1]) {
        await page.clock.fastForward(durationMs / 4);
        await delay(20);
        const current = Number(await page.locator('[role="progressbar"]').getAttribute('aria-valuenow'));
        assert.ok(current >= previous, `estimated progress must be monotonic at ${fraction * 100}% of ${durationMs}ms`);
        assert.ok(current < 99, `estimated progress must remain below 99 before a ${durationMs}ms response (${fraction * 100}% checkpoint)`);
        if (fraction === 0.25) assert.ok(current <= 80, `progress must not get ahead at 25% of ${durationMs}ms (got ${current}%)`);
        checkpoints.push(current);
        previous = current;
      }
      const previousImage = await page.locator('#avatar').getAttribute('src');
      const response = page.waitForResponse((item) => item.url().endsWith('/api/generate'));
      providerGate.resolve();
      providerGate = null;
      await page.clock.fastForward(100);
      await response;
      await delay(30);
      assert.ok(Number(await page.locator('[role="progressbar"]').getAttribute('aria-valuenow')) < 100, `a ${durationMs}ms response must start a visible completion animation`);
      assert.equal(await page.locator('#avatar').getAttribute('src'), previousImage, 'the previous result stays visible until progress reaches 100%');
      await page.clock.fastForward(400);
      await delay(20);
      assert.ok(Number(await page.locator('[role="progressbar"]').getAttribute('aria-valuenow')) < 100, 'the completion animation must not jump to 100%');
      assert.equal(await page.locator('#avatar').getAttribute('src'), previousImage, 'do not replace the previous result before 100%');
      await page.clock.fastForward(700);
      await page.waitForFunction(() => window.__progressValues?.includes(100), null, { timeout: 5000 });
      await idle(page, '#generate');
      assert.equal(await page.locator('#generationProgressCopy').innerText(), 'Собираем образ', 'the progress state resets after completion');
      return checkpoints;
    }
    async function finishQuickVersion(page, prompt) {
      await page.locator('#prompt').fill(prompt);
      const response = page.waitForResponse((item) => item.url().endsWith('/api/generate'));
      await page.locator('#generate').click();
      await page.waitForFunction(() => document.querySelector('#generate').getAttribute('aria-busy') === 'true');
      await response;
      await delay(30);
      await page.clock.fastForward(1100);
      await idle(page, '#generate');
      return page.locator('#avatar').getAttribute('src');
    }
    const page = await newPage();
    const participantNickname = 'Workshop-07';
    const firstPrompt = 'робот в космосе';
    const editedPrompt = 'дракон с рюкзаком';
    const thirdPrompt = 'кот-учёный в круглых очках';
    const fourthPrompt = 'волшебник с фиолетовым плащом';

    console.log('[1/9] Login, normal/disabled states, system font and responsive layout');
    await page.goto(origin, { waitUntil: 'networkidle' });
    await buttonState(page.locator('#start'), false);
    await screenshots(page, 'login-disabled');
    await page.locator('#nickname').fill(participantNickname);
    await screenshots(page, 'login-normal');
    await page.locator('#loginForm').getByRole('button').click();
    await visible(page, '#workspace');
    await visible(page, '#createSection');
    assert.equal(await page.locator('#createTitle').innerText(), 'Опиши героя');
    assert.equal(await page.locator('#promptLabel').innerText(), 'Кто это?');
    assert.equal(await page.locator('#promptModeHint').innerText(), 'Выбери идею для старта или напиши свою.');
    assert.equal(await page.locator('#generate').innerText(), 'Создать аватар');
    assert.equal(await page.locator('#edit').count(), 0, 'the duplicate edit action is removed from participant UI');
    assert.match(await page.locator('#prompt').getAttribute('placeholder'), /Кто это\?/);
    const sessionId = await page.evaluate(() => localStorage.getItem('avatarSessionId'));
    assert.ok(sessionId);
    // The participant-facing mock notice is a product affordance, not a
    // provider label. It should be shown only when the health endpoint says
    // this run uses the local mock provider.
    await visible(page, '#mockNotice');
    await buttonState(page.locator('#generate'), false);
    assert.match(await page.locator('body').evaluate((element) => getComputedStyle(element).fontFamily), /Arial/);
    assert.equal(await page.locator('link[href*="fonts"]').count(), 0, 'the workshop requires no hosted font');
    await screenshots(page, 'workspace-disabled');

    console.log('[2/9] Invalid prompts stop before the provider; good short prompts are accepted');
    const callsBeforeBadPrompts = adapterCalls;
    for (const prompt of ['', '   ', '123123', 'asdfasdf', '......', 'аааааа', 'аватар', 'персонаж', 'мой телефон +79991234567', 'nude avatar']) {
      const response = await fetch(origin + '/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, prompt }) });
      assert.equal(response.status, 400, `reject an invalid prompt: ${JSON.stringify(prompt)}`);
    }
    assert.equal(adapterCalls, callsBeforeBadPrompts, 'rejected prompts must never call the AI adapter');
    await page.locator('#prompt').fill('asdfasdf');
    await page.locator('#generate').click();
    await idle(page, '#generate');
    assert.match(await page.locator('#genError').innerText(), /[А-Яа-яЁё]/);
    assert.doesNotMatch(await page.locator('#genError').innerText(), /HTTP|API|provider|stack|JSON/i);
    assert.equal(adapterCalls, callsBeforeBadPrompts);
    await screenshots(page, 'prompt-error');

    console.log('[3/9] One request per rapid clicks, loading, progress checkpoints, real 10-second cooldown');
    await page.locator('#prompt').fill(firstPrompt);
    await page.evaluate(() => localStorage.setItem('avatarGenerationEstimateMs.v2', '45000'));
    await screenshots(page, 'generation-normal');
    providerGate = deferred();
    const callsBeforeClicks = adapterCalls;
    let generateRequests = 0;
    page.on('request', (request) => { if (request.url().endsWith('/api/generate')) generateRequests += 1; });
    await page.locator('#generate').evaluate((button) => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); button.dispatchEvent(new MouseEvent('click', { bubbles: true })); button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await page.waitForFunction(() => document.querySelector('#generate').getAttribute('aria-busy') === 'true');
    assert.equal(await page.locator('#generationProgress').isVisible(), true, 'generation progress must be visible while waiting');
    assert.ok(Number(await page.locator('[role="progressbar"]').getAttribute('aria-valuenow')) < 100, 'estimated progress must stay below 100 before response');
    await buttonState(page.locator('#generate'), true);
    await screenshots(page, 'generation-loading');
    await page.evaluate(() => { window.__progressValues = []; });
    const progressTrack = page.locator('[role="progressbar"]');
    await page.evaluate(() => {
      const target = document.querySelector('[role="progressbar"]');
      new MutationObserver(() => window.__progressValues.push(Number(target.getAttribute('aria-valuenow')))).observe(target, { attributes: true });
    });
    let progressPrevious = 0;
    const firstProgressCheckpoints = [];
    for (const fraction of [0.25, 0.5, 0.75, 1]) {
      await page.clock.fastForward(2500);
      await delay(20);
      const current = Number(await progressTrack.getAttribute('aria-valuenow'));
      assert.ok(current >= progressPrevious, `initial estimated progress must be monotonic at ${fraction * 100}% of 10s`);
      assert.ok(current < 99, `initial estimated progress must stay below 99 before response at ${fraction * 100}% of 10s`);
      if (fraction === 0.25) assert.ok(current <= 80, `progress must not get ahead at 25% of 10s (got ${current}%)`);
      firstProgressCheckpoints.push(current);
      progressPrevious = current;
    }
    await delay(50);
    assert.equal(generateRequests, 1, 'several rapid clicks must send one HTTP generation request');
    assert.equal(adapterCalls, callsBeforeClicks + 1, 'several rapid clicks must call the adapter once');
    const firstResponse = page.waitForResponse((item) => item.url().endsWith('/api/generate'));
    providerGate.resolve(); providerGate = null;
    await page.clock.fastForward(100);
    await firstResponse;
    await delay(30);
    assert.ok(Number(await progressTrack.getAttribute('aria-valuenow')) < 100, '20% completion starts from the current estimated position');
    assert.equal(await page.locator('#result').isVisible(), false, 'the first result stays hidden during final progress');
    await page.clock.fastForward(400);
    await delay(20);
    assert.ok(Number(await progressTrack.getAttribute('aria-valuenow')) < 100, 'completion is animated for more than a quick jump');
    assert.equal(await page.locator('#result').isVisible(), false);
    await page.clock.fastForward(700);
    await visible(page, '#result');
    assert.equal(await page.locator('#generationProgress').isVisible(), false, 'fast completion must close the progress state');
    assert.equal(await page.evaluate(() => window.__progressValues.includes(100)), true, 'successful completion must pass through 100%');
    assert.match(await page.locator('#generationState').innerText(), /Текущая версия сохранена/);
    await idle(page, '#generate');
    await page.waitForFunction(() => window.__progressValues?.includes(100), null, { timeout: 5000 });
    const firstImage = await page.locator('#avatar').getAttribute('src');
    assert.match(firstImage, /^data:image\//);
    await buttonState(page.locator('#generate'), false);
    assert.match(await page.locator('#attemptLabel').innerText(), /через/);
    const cooldownResponse = await fetch(origin + '/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, prompt: editedPrompt }) });
    assert.equal(cooldownResponse.status, 429, 'server cooldown must enforce the same protection');
    assert.equal((await cooldownResponse.json()).code, 'COOLDOWN');
    assert.equal(adapterCalls, callsBeforeClicks + 1);
    await screenshots(page, 'generation-success-cooldown');
    await endCooldown(page);

    console.log('[4/9] Edit v2, restore after reload, edit v3, failed edit preservation, successful v4');
    const version2Checkpoints = await runTimedVersion(page, editedPrompt, 20000);
    assert.deepEqual(adapterHistory.slice(-1).map((call) => call.type), ['edit']);
    assert.equal(adapterHistory.at(-1).referenceImage, firstImage, 'v2 edit must use v1 as the reference image');
    await page.waitForFunction(() => document.querySelector('#previewLabel').textContent.includes('02'));
    const secondImage = await page.locator('#avatar').getAttribute('src');
    await page.reload({ waitUntil: 'networkidle' });
    await visible(page, '#workspace');
    await page.locator('#showCreate').click();
    await visible(page, '#result');
    const restoredSecond = await page.request.get(await page.locator('#avatar').evaluate((image) => image.src));
    assert.ok(restoredSecond.ok());
    assert.deepEqual(await restoredSecond.body(), Buffer.from(secondImage.split(',')[1], 'base64'), 'reload restores v2');
    assert.equal(await page.locator('#prompt').inputValue(), '', 'restored edit field is ready for the next instruction');
    assert.equal(await page.locator('#createTitle').innerText(), 'Измени героя');
    assert.equal(await page.locator('#promptLabel').innerText(), 'Что хочешь изменить?');
    assert.equal(await page.locator('#promptModeHint').innerText(), 'Опиши, что хочешь изменить в текущем герое.');
    assert.match(await page.locator('#prompt').getAttribute('placeholder'), /круглые очки.*шарф/i);
    assert.equal(await page.locator('#generate').innerText(), 'Улучшить аватар');
    assert.equal(await page.locator('.themes').isVisible(), false, 'creation suggestions are hidden during edits');
    assert.match(await page.locator('#generationState').innerText(), /Версия 02 восстановлена/);
    assert.match(await page.locator('#previewLabel').innerText(), /02/);
    await endCooldown(page);
    const version3Checkpoints = await runTimedVersion(page, thirdPrompt, 35000);
    assert.equal(adapterHistory.at(-1).type, 'edit');
    assert.equal(adapterHistory.at(-1).referenceImage, secondImage, 'v3 edit must use the latest successful v2 image');
    await page.waitForFunction(() => document.querySelector('#previewLabel').textContent.includes('03'));
    const thirdImage = await page.locator('#avatar').getAttribute('src');
    await endCooldown(page);
    const callsBeforeRejectedPrompt = adapterHistory.length;
    const rejectedEdit = await fetch(origin + '/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, prompt: 'добавь герою личные данные 1234567890' }) });
    assert.equal(rejectedEdit.status, 400, 'unsafe edit instructions must be rejected before the provider');
    assert.equal(adapterHistory.length, callsBeforeRejectedPrompt, 'a rejected private-data edit must not call the adapter');
    assert.equal(await page.locator('#avatar').getAttribute('src'), thirdImage, 'rejected edit keeps v3 image');
    assert.equal(await api(`/api/sessions/${sessionId}`).then((snapshot) => snapshot.generationCount), 3);
    await page.reload({ waitUntil: 'networkidle' });
    await visible(page, '#workspace');
    await page.locator('#showCreate').click();
    await visible(page, '#result');
    const restoredThirdSource = await page.locator('#avatar').evaluate((image) => image.src);
    const restoredThird = await page.request.get(restoredThirdSource);
    assert.ok(restoredThird.ok());
    assert.deepEqual(await restoredThird.body(), Buffer.from(thirdImage.split(',')[1], 'base64'), 'reload restores v3 before the next edit');
    assert.equal(await page.locator('#prompt').inputValue(), '', 'restored v3 leaves a clean edit field');
    await endCooldown(page);
    await page.locator('#prompt').fill('измени цвет плаща на фиолетовый');
    nextProviderError = new AiAdapterError('Content policy rejection detail must not leak', { code: 'CONTENT_REJECT', status: 400 });
    await page.locator('#generate').click();
    await idle(page, '#generate');
    assert.equal(await page.locator('#avatar').evaluate((image) => image.src), restoredThirdSource);
    assert.equal(await page.locator('#result').isVisible(), true);
    assert.equal(await page.locator('#generationProgress').isVisible(), false, 'failed edit must leave progress state');
    assert.match(await page.locator('#genError').innerText(), /[А-Яа-яЁё]/);
    assert.doesNotMatch(await page.locator('#genError').innerText(), /internal|provider|HTTP|API/i);
    await screenshots(page, 'generation-error');
    assert.equal(adapterHistory.at(-1).type, 'edit', 'failed improvement must use the edit adapter');
    assert.equal(adapterHistory.at(-1).referenceImage, thirdImage, 'failed v4 must reference v3');
    assert.equal(await page.locator('#generate').isDisabled(), false, 'failed generation must allow an immediate retry');
    await endCooldown(page);
    // A response arriving at 95% still holds the previous image until the finish animation completes.
    await page.evaluate(() => localStorage.setItem('avatarGenerationEstimateMs.v2', '45000'));
    const version4Checkpoints = await runTimedVersion(page, fourthPrompt, 67500);
    assert.equal(adapterHistory.at(-1).type, 'edit');
    assert.equal(adapterHistory.at(-1).referenceImage, thirdImage, 'v4 edit must reference the last successful v3 image');
    await page.waitForFunction(() => document.querySelector('#previewLabel').textContent.includes('04'));
    const finalImage = await page.locator('#avatar').getAttribute('src');
    const sessionAfterThree = await api(`/api/sessions/${sessionId}`);
    assert.equal(sessionAfterThree.generationCount, 4, 'unlimited policy must allow multiple edits');
    assert.equal(sessionAfterThree.generationPolicy.maxGenerations, 0);
    assert.equal(sessionAfterThree.latestGeneration.prompt, fourthPrompt);
    assert.deepEqual([firstProgressCheckpoints.length, version2Checkpoints.length, version3Checkpoints.length, version4Checkpoints.length], [4, 4, 4, 4]);

    console.log('[5/9] Publication recovery, immediate tile despite an old gallery request, restore');
    let rejectPublish = true;
    await page.route('**/api/works', async (route) => {
      if (route.request().method() === 'POST' && rejectPublish) {
        rejectPublish = false;
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary internal API failure' }) });
      }
      return route.continue();
    });
    await page.locator('#publish').click();
    await idle(page, '#publish');
    assert.equal(await page.locator('#avatar').getAttribute('src'), finalImage);
    assert.equal(await page.locator('#workState').getAttribute('data-tone'), 'error');
    assert.doesNotMatch(await page.locator('#workState').innerText(), /internal|HTTP|API|temporary/i);
    await screenshots(page, 'publication-error');
    await page.unroute('**/api/works');
    const staleGallery = deferred();
    const intercepted = deferred();
    let interceptOnce = true;
    await page.route('**/api/gallery?format=compact', async (route) => {
      if (!interceptOnce) return route.continue();
      interceptOnce = false;
      const response = await route.fetch();
      const body = await response.text();
      intercepted.resolve();
      await staleGallery.promise;
      return route.fulfill({ status: response.status(), contentType: 'application/json', body });
    });
    await page.clock.fastForward(7100);
    await intercepted.promise;
    await page.locator('#publish').click();
    await idle(page, '#publish');
    assert.equal(await page.locator('#showGallery').getAttribute('aria-current'), 'page', 'publication should focus the gallery tab');
    const publishedSession = await api(`/api/sessions/${sessionId}`);
    const ownId = publishedSession.work.id;
    const ownSelector = `#gallery [data-work-id="${ownId}"]`;
    await visible(page, ownSelector);
    assert.equal(await page.locator('#workState').getAttribute('data-tone'), 'success');
    staleGallery.resolve();
    await page.waitForTimeout(100);
    assert.equal(await page.locator(ownSelector).count(), 1, 'late stale gallery response must not remove the just-published tile');
    await page.unroute('**/api/gallery?format=compact');
    await screenshots(page, 'publication-success');
    const publicGallery = await api('/api/gallery');
    assert.equal(Object.hasOwn(publicGallery.works.find((work) => work.id === ownId), 'prompt'), false);
    assert.ok(!(await page.locator('#gallery').innerText()).includes(fourthPrompt));
    await page.reload({ waitUntil: 'networkidle' });
    await visible(page, '#workspace');
    await page.locator('#showCreate').click();
    assert.equal(await page.locator('#showCreate').getAttribute('aria-current'), 'page');
    await visible(page, '#result');
    assert.equal(await page.locator('#avatar').getAttribute('src'), '/api/works/' + ownId + '/image');
    await page.locator('#avatar').evaluate((image) => image.decode());
    await buttonState(page.locator('#generate'), false);
    await buttonState(page.locator('#publish'), false);
    assert.match(await page.locator('#publish').innerText(), /Опубликовано/);
    await visible(page, ownSelector);
    await buttonState(page.locator(`${ownSelector} .like`), false);

    console.log('[6/9] Polling adds new works/likes and preserves gallery focus and nodes');
    const guest = await newPage();
    const guestSession = await login(guest, 'Guest-08');
    const ownLike = guest.locator(`${ownSelector} .like`);
    await ownLike.click();
    await idle(guest, `${ownSelector} .like`);
    await buttonState(ownLike, false);
    await guest.reload({ waitUntil: 'networkidle' });
    await visible(guest, ownSelector);
    assert.equal(await guest.locator(`${ownSelector} .like`).isDisabled(), true, 'liked works must remain disabled after reload');
    const fixture = await publishFixture('Auto-17');
    const fixtureSelector = `#gallery [data-work-id="${fixture.work.id}"]`;
    await poll(page, '/api/gallery');
    await visible(page, fixtureSelector);
    await waitLikes(page, `${ownSelector} .like span:last-child`, 1);
    await poll(guest, '/api/gallery');
    await visible(guest, fixtureSelector);
    const galleryNode = await page.locator(fixtureSelector).elementHandle();
    await page.locator(`${fixtureSelector} .like`).focus();
    await api(`/api/works/${fixture.work.id}/like`, { sessionId: guestSession });
    await poll(page, '/api/gallery');
    await waitLikes(page, `${fixtureSelector} .like span:last-child`, 1);
    assert.equal(await galleryNode.evaluate((node, selector) => node === document.querySelector(selector), fixtureSelector), true, 'polling must keep existing gallery nodes');
    assert.equal(await galleryNode.evaluate((node) => document.activeElement === node.querySelector('.like')), true, 'polling must preserve keyboard focus');
    await screenshots(page, 'gallery-success');

    console.log('[7/9] Admin auth, protected prompt/status cards, automatic new works and likes');
    const admin = await newPage();
    await admin.goto(origin + '/admin.html', { waitUntil: 'networkidle' });
    await screenshots(admin, 'admin-login');
    await admin.locator('#token').fill('wrong-token');
    await admin.locator('#load').click();
    await idle(admin, '#load');
    assert.equal(await admin.locator('#works-panel').isVisible(), false);
    assert.match(await admin.locator('#msg').innerText(), /код/i);
    await admin.locator('#token').fill('ui-test-token');
    await admin.locator('#load').click();
    await idle(admin, '#load');
    await visible(admin, '#status-panel');
    assert.equal(await admin.locator('.status-card').count(), 6);
    assert.equal(await admin.locator('#debug').isVisible(), false, 'raw JSON belongs in collapsed debug details');
    await admin.locator('.admin-debug summary').click();
    assert.match(await admin.locator('[data-card="provider"] .stat-value').innerText(), /Mock/);
    await admin.locator('.admin-debug summary').click();
    const adminOwnSelector = `#works [data-work-id="${ownId}"]`;
    const adminOwn = admin.locator(adminOwnSelector);
    await visible(admin, adminOwnSelector);
    assert.equal(await adminOwn.locator('.work-image').getAttribute('src'), finalImage);
    assert.equal(await adminOwn.locator('.work-status').getAttribute('data-status'), 'published');
    const details = adminOwn.locator('.work-details');
    assert.equal(await details.evaluate((node) => node.open), false);
    await details.locator('summary').click();
    assert.equal(await details.locator('.prompt-text').innerText(), fourthPrompt);
    const technical = adminOwn.locator('.work-technical');
    assert.equal(await technical.evaluate((node) => node.open), false, 'full provider prompt starts collapsed');
    await technical.locator('summary').click();
    assert.match(await technical.locator('.final-prompt-text').innerText(), /Participant (?:idea|edit instruction)/);
    const adminNode = await adminOwn.elementHandle();
    await details.locator('summary').focus();
    await api(`/api/works/${ownId}/like`, { sessionId: fixture.session.id });
    const another = await publishFixture('Admin-Auto', 'дракон с рюкзаком');
    await poll(admin, '/api/admin/works');
    await visible(admin, `#works [data-work-id="${another.work.id}"]`);
    await admin.waitForFunction((selector) => document.querySelector(selector)?.textContent.includes('Лайки: 2'), `${adminOwnSelector} .work-facts`);
    assert.equal(await adminNode.evaluate((node, selector) => node === document.querySelector(selector), adminOwnSelector), true);
    assert.equal(await details.evaluate((node) => node.open), true, 'polling must keep prompt details open');
    assert.equal(await adminNode.evaluate((node) => document.activeElement === node.querySelector('summary')), true, 'admin polling must preserve keyboard focus');
    await screenshots(admin, 'admin-success');

    console.log('[7b/11] Admin polling keeps the last snapshot through transient failures');
    const publishedBeforePollingFailure = await admin.locator('[data-card="published"] .stat-value').innerText();
    let statusFailures = 0;
    await admin.route('**/api/admin/status', async (route) => {
      if (statusFailures < 3) {
        statusFailures += 1;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary status failure' }) });
      } else await route.continue();
    });
    await poll(admin, '/api/admin/status');
    await delay(25);
    assert.equal(await admin.locator('[data-card="published"] .stat-value').innerText(), publishedBeforePollingFailure, 'one status failure keeps counters');
    assert.equal(await admin.locator(adminOwnSelector).count(), 1, 'one polling failure keeps existing works');
    assert.equal(await admin.locator('#status-note').innerText(), '', 'one quiet polling failure does not show a large warning');
    await poll(admin, '/api/admin/status');
    await delay(25);
    assert.equal(await admin.locator('#status-note').innerText(), '', 'two quiet polling failures stay unobtrusive');
    await poll(admin, '/api/admin/status');
    await delay(25);
    assert.match(await admin.locator('#status-note').innerText(), /Не удалось обновить данные/);
    assert.equal(await admin.locator('#works-state').innerText(), '', 'polling does not create a second duplicate warning');
    await poll(admin, '/api/admin/status');
    await delay(25);
    assert.equal(await admin.locator('#status-note').innerText(), '', 'successful polling clears the warning');
    await admin.unroute('**/api/admin/status');

    const authFailure = await newPage();
    await authFailure.route('**/api/admin/status', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'forbidden' }) }));
    await authFailure.goto(origin + '/admin.html', { waitUntil: 'networkidle' });
    await authFailure.locator('#token').fill('ui-test-token');
    await authFailure.locator('#load').click();
    await idle(authFailure, '#load');
    assert.equal(await authFailure.locator('#status-panel').isVisible(), false, '403 locks the admin panel');
    assert.match(await authFailure.locator('#msg').innerText(), /код|доступ/i, '403 explains the authorization problem');
    await authFailure.close();

    console.log('[8/9] Moderation hide/show/delete uses the exact selected work');
    await adminOwn.getByRole('button', { name: 'Скрыть', exact: true }).click();
    await admin.waitForFunction((selector) => document.querySelector(selector)?.dataset.status === 'hidden', `${adminOwnSelector} .work-status`);
    assert.equal((await api('/api/gallery')).works.some((work) => work.id === ownId), false);
    await poll(guest, '/api/gallery');
    await guest.locator(ownSelector).waitFor({ state: 'detached' });
    await adminOwn.getByRole('button', { name: 'Показать', exact: true }).click();
    await admin.waitForFunction((selector) => document.querySelector(selector)?.dataset.status === 'published', `${adminOwnSelector} .work-status`);
    await poll(guest, '/api/gallery');
    await visible(guest, ownSelector);
    admin.once('dialog', (dialog) => dialog.accept());
    await adminOwn.getByRole('button', { name: 'Удалить', exact: true }).click();
    await adminOwn.waitFor({ state: 'detached' });
    assert.equal((await api('/api/gallery')).works.some((work) => work.id === ownId), false);

    console.log('[9/10] New hero requires confirmation and keeps the prior session intact');
    const newHeroPage = await newPage();
    const priorSessionId = await login(newHeroPage, 'NewHero-11');
    await newHeroPage.locator('#prompt').fill('дракон с рюкзаком');
    await newHeroPage.locator('#generate').click();
    await idle(newHeroPage, '#generate');
    const priorImage = await newHeroPage.locator('#avatar').getAttribute('src');
    await newHeroPage.locator('#prompt').fill('добавь круглые очки');
    let canceledMessage = '';
    newHeroPage.once('dialog', async (dialog) => { canceledMessage = dialog.message(); await dialog.dismiss(); });
    await newHeroPage.locator('#newHero').click();
    assert.match(canceledMessage, /останется в прежней сессии/i);
    assert.equal(await newHeroPage.evaluate(() => localStorage.getItem('avatarSessionId')), priorSessionId);
    assert.equal(await newHeroPage.locator('#avatar').getAttribute('src'), priorImage, 'cancel keeps the current avatar');
    newHeroPage.once('dialog', (dialog) => dialog.accept());
    await newHeroPage.locator('#newHero').click();
    await newHeroPage.waitForFunction((previousId) => localStorage.getItem('avatarSessionId') !== previousId, priorSessionId);
    await visible(newHeroPage, '#workspace');
    assert.equal(await newHeroPage.locator('#createTitle').innerText(), 'Опиши героя');
    assert.equal(await newHeroPage.locator('#promptLabel').innerText(), 'Кто это?');
    assert.equal(await newHeroPage.locator('#prompt').inputValue(), '');
    assert.equal(await newHeroPage.locator('#result').isVisible(), false);
    const priorSnapshot = await api(`/api/sessions/${priorSessionId}`);
    assert.equal(priorSnapshot.latestGeneration.imageData, priorImage, 'the previous session retains its unpublished version');
    await newHeroPage.close();

    console.log('[10/11] Independent participant contexts, polling, moderation and parallel generation');
    const participantA = await newPage();
    const participantB = await newPage();
    const adminContext = await newPage();
    const sessionA = await login(participantA, 'Multi-A-01');
    const sessionB = await login(participantB, 'Multi-B-02');
    assert.notEqual(sessionA, sessionB, 'participants receive distinct backend sessions');
    const participantIdentityA = await participantA.evaluate(() => localStorage.getItem('avatarParticipantId'));
    const participantIdentityB = await participantB.evaluate(() => localStorage.getItem('avatarParticipantId'));
    assert.ok(participantIdentityA && participantIdentityA.length >= 16, 'A has a stable opaque participant identity');
    assert.ok(participantIdentityB && participantIdentityB.length >= 16, 'B has a stable opaque participant identity');
    assert.notEqual(participantIdentityA, participantIdentityB, 'independent browser contexts receive different participant identities');
    assert.equal(await participantA.evaluate(() => localStorage.getItem('avatarSessionId')), sessionA);
    assert.equal(await participantB.evaluate(() => localStorage.getItem('avatarSessionId')), sessionB);
    assert.notEqual(await participantA.evaluate(() => localStorage.getItem('avatarSessionId')), await participantB.evaluate(() => localStorage.getItem('avatarSessionId')));

    const imageA1 = await finishQuickVersion(participantA, 'робот-пилот с красным шарфом');
    await endCooldown(participantA);
    await participantA.locator('#prompt').fill('добавь круглые очки');
    await participantB.locator('#showGallery').click();
    const initialGalleryIdsForB = new Set((await api('/api/gallery')).works.map((work) => work.id));
    assert.equal(await participantB.locator('#who').innerText(), 'Multi-B-02');
    assert.equal(await participantB.locator('#prompt').inputValue(), '', 'B starts with an independent empty prompt');
    assert.equal(await participantA.locator('#prompt').inputValue(), 'добавь круглые очки', 'B navigation does not change A prompt');

    await adminContext.goto(origin + '/admin.html', { waitUntil: 'networkidle' });
    await adminContext.locator('#token').fill('ui-test-token');
    await adminContext.locator('#load').click();
    await idle(adminContext, '#load');
    await visible(adminContext, '#works-panel');
    assert.equal(await adminContext.evaluate(() => localStorage.getItem('avatarSessionId')), null, 'admin context has no participant session');

    const publishPayloadsA = [];
    const publishPayloadsB = [];
    const capturePublish = (page, target) => page.on('request', (request) => {
      if (request.url().endsWith('/api/works') && request.method() === 'POST') target.push(JSON.parse(request.postData() || '{}'));
    });
    capturePublish(participantA, publishPayloadsA);
    capturePublish(participantB, publishPayloadsB);
    await finishQuickVersion(participantA, 'добавь круглые очки');
    const snapshotA = await api(`/api/sessions/${sessionA}`);
    const generationA = snapshotA.latestGeneration.id;
    assert.notEqual(generationA, (await api(`/api/sessions/${sessionB}`)).latestGeneration?.id);
    const editA = adapterHistory.filter((call) => call.type === 'edit' && call.prompt.includes('добавь круглые очки')).at(-1);
    assert.equal(editA.referenceImage, imageA1, 'A edit uses only A v1 as its reference');
    const imageA2 = await participantA.locator('#avatar').getAttribute('src');
    await participantA.locator('#publish').click();
    await idle(participantA, '#publish');
    const workAId = (await api(`/api/sessions/${sessionA}`)).work.id;
    assert.equal(publishPayloadsA.at(-1).sessionId, sessionA);
    assert.equal(publishPayloadsA.at(-1).generationId, generationA, 'A publication uses A latest generation');
    const selectorA = `#gallery [data-work-id="${workAId}"]`;
    await visible(participantA, selectorA);

    await poll(participantB, '/api/gallery');
    await visible(participantB, `#gallery [data-work-id="${workAId}"]`);
    assert.equal(initialGalleryIdsForB.has(workAId), false, 'B saw A arrive through polling, not initial page load');
    await poll(adminContext, '/api/admin/works');
    await visible(adminContext, `#works [data-work-id="${workAId}"]`);

    await participantB.locator('#showCreate').click();
    const imageB1 = await finishQuickVersion(participantB, 'кот-учёный в круглых очках');
    await endCooldown(participantB);
    await participantB.locator('#prompt').fill('добавь синюю бабочку на воротник');
    assert.equal(await participantA.locator('#prompt').inputValue(), '', 'B edit instruction does not appear in A');
    const imageB2 = await finishQuickVersion(participantB, 'добавь синюю бабочку на воротник');
    const snapshotB = await api(`/api/sessions/${sessionB}`);
    const generationB = snapshotB.latestGeneration.id;
    assert.notEqual(generationA, generationB);
    const editB = adapterHistory.filter((call) => call.type === 'edit' && call.prompt.includes('добавь синюю бабочку')).at(-1);
    assert.equal(editB.referenceImage, imageB1, 'B edit uses only B v1 as its reference');
    // The deterministic mock intentionally uses a small palette, so two
    // unrelated prompts may produce identical pixels. Independence is proven
    // by the separate session/generation ids and the reference-image checks
    // above, while both clients must still have a rendered image.
    assert.match(imageA2, /^data:image\//);
    assert.match(imageB2, /^data:image\//);
    await participantB.locator('#publish').click();
    await idle(participantB, '#publish');
    const workBId = (await api(`/api/sessions/${sessionB}`)).work.id;
    assert.notEqual(workAId, workBId);
    assert.equal(publishPayloadsB.at(-1).sessionId, sessionB);
    assert.equal(publishPayloadsB.at(-1).generationId, generationB, 'B publication uses B latest generation');
    await poll(participantA, '/api/gallery');
    await visible(participantA, `#gallery [data-work-id="${workBId}"]`);
    await poll(adminContext, '/api/admin/works');
    await visible(adminContext, `#works [data-work-id="${workBId}"]`);
    assert.equal(await participantB.locator('#who').innerText(), 'Multi-B-02', 'A nickname does not replace B participant identity');

    const selectorB = `#gallery [data-work-id="${workBId}"]`;
    await participantA.locator(`${selectorB} .like`).click();
    await idle(participantA, `${selectorB} .like`);
    await poll(participantB, '/api/gallery');
    await waitLikes(participantB, `${selectorB} .like span:last-child`, 1);
    assert.equal(await participantA.locator(`${selectorB} .like`).isDisabled(), true, 'A cannot click the same like twice in the UI');
    const duplicateLike = await fetch(origin + `/api/works/${workBId}/like`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: sessionA }) });
    assert.equal(duplicateLike.status, 409, 'backend rejects a repeated A like');
    assert.equal((await api('/api/gallery')).works.find((work) => work.id === workBId).likes, 1, 'duplicate attempt does not increase the count');

    const adminWorkA = adminContext.locator(`#works [data-work-id="${workAId}"]`);
    await adminWorkA.getByRole('button', { name: 'Скрыть', exact: true }).click();
    await adminContext.waitForFunction((workId) => document.querySelector(`#works [data-work-id="${workId}"] .work-status`)?.dataset.status === 'hidden', workAId);
    await Promise.all([poll(participantA, '/api/gallery'), poll(participantB, '/api/gallery')]);
    assert.equal(await participantA.locator(selectorA).count(), 0, 'hidden A work disappears from A gallery');
    assert.equal(await participantB.locator(selectorA).count(), 0, 'hidden A work disappears from B gallery');
    await adminWorkA.getByRole('button', { name: 'Показать', exact: true }).click();
    await adminContext.waitForFunction((workId) => document.querySelector(`#works [data-work-id="${workId}"] .work-status`)?.dataset.status === 'published', workAId);
    await Promise.all([poll(participantA, '/api/gallery'), poll(participantB, '/api/gallery')]);
    await visible(participantA, selectorA);
    await visible(participantB, selectorA);

    const bAvatarBeforeNewHero = await participantB.locator('#avatar').getAttribute('src');
    await participantA.locator('#showCreate').click();
    await participantA.locator('#newHero').click();
    await participantA.waitForFunction((oldId) => localStorage.getItem('avatarSessionId') !== oldId, sessionA);
    await visible(participantA, '#workspace');
    const newSessionA = await participantA.evaluate(() => localStorage.getItem('avatarSessionId'));
    assert.notEqual(newSessionA, sessionA, 'new hero creates a fresh generation session');
    assert.equal(await participantA.evaluate(() => localStorage.getItem('avatarParticipantId')), participantIdentityA, 'new hero keeps the same voter identity');
    const duplicateAfterNewHero = await fetch(origin + `/api/works/${workBId}/like`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: newSessionA, participantId: participantIdentityA }) });
    assert.equal(duplicateAfterNewHero.status, 409, 'a new hero session cannot repeat an existing participant like');
    assert.equal(await participantB.evaluate(() => localStorage.getItem('avatarSessionId')), sessionB, 'creating A new hero does not change B session');
    assert.equal(await participantB.locator('#avatar').getAttribute('src'), bAvatarBeforeNewHero, 'creating A new hero does not replace B avatar');
    assert.equal(await participantB.locator('#who').innerText(), 'Multi-B-02');
    assert.equal((await api(`/api/sessions/${sessionA}`)).latestGeneration.id, generationA, 'A old version remains persisted');

    await participantB.locator('#showCreate').click();
    await participantB.locator('#newHero').click();
    await participantB.waitForFunction((oldId) => localStorage.getItem('avatarSessionId') !== oldId, sessionB);
    await visible(participantB, '#workspace');
    const concurrentSessionA = await participantA.evaluate(() => localStorage.getItem('avatarSessionId'));
    const concurrentSessionB = await participantB.evaluate(() => localStorage.getItem('avatarSessionId'));
    assert.notEqual(concurrentSessionA, concurrentSessionB);
    const callsBeforeConcurrent = adapterHistory.length;
    providerGate = deferred();
    await Promise.all([
      participantA.locator('#prompt').fill('робот-строитель на Луне'),
      participantB.locator('#prompt').fill('лисёнок-астроном у телескопа'),
    ]);
    const responseA = participantA.waitForResponse((item) => item.url().endsWith('/api/generate'));
    const responseB = participantB.waitForResponse((item) => item.url().endsWith('/api/generate'));
    await Promise.all([participantA.locator('#generate').click(), participantB.locator('#generate').click()]);
    await Promise.all([
      participantA.waitForFunction(() => document.querySelector('#generate').getAttribute('aria-busy') === 'true'),
      participantB.waitForFunction(() => document.querySelector('#generate').getAttribute('aria-busy') === 'true'),
    ]);
    const callsDeadline = Date.now() + 5000;
    while (adapterHistory.length < callsBeforeConcurrent + 2 && Date.now() < callsDeadline) await delay(10);
    assert.equal(adapterHistory.length, callsBeforeConcurrent + 2, 'both participant requests reach the mock adapter');
    const concurrentCalls = adapterHistory.slice(callsBeforeConcurrent);
    assert.ok(concurrentCalls.every((call) => call.type === 'generate'));
    assert.ok(concurrentCalls.some((call) => call.prompt.includes('робот-строитель на Луне')));
    assert.ok(concurrentCalls.some((call) => call.prompt.includes('лисёнок-астроном у телескопа')));
    assert.ok(!concurrentCalls.some((call) => call.prompt.includes('Multi-A-01') || call.prompt.includes('Multi-B-02')), 'nicknames are not injected into prompts');
    providerGate.resolve(); providerGate = null;
    await Promise.all([responseA, responseB]);
    await delay(30);
    await Promise.all([participantA.clock.fastForward(1100), participantB.clock.fastForward(1100)]);
    await Promise.all([idle(participantA, '#generate'), idle(participantB, '#generate')]);
    const concurrentResultA = await (await api(`/api/sessions/${concurrentSessionA}`)).latestGeneration;
    const concurrentResultB = await (await api(`/api/sessions/${concurrentSessionB}`)).latestGeneration;
    assert.notEqual(concurrentResultA.id, concurrentResultB.id);
    assert.equal(await participantA.locator('#avatar').getAttribute('src'), concurrentResultA.imageData);
    assert.equal(await participantB.locator('#avatar').getAttribute('src'), concurrentResultB.imageData);
    assert.equal(await participantA.locator('#who').innerText(), 'Multi-A-01');
    assert.equal(await participantB.locator('#who').innerText(), 'Multi-B-02');
    await Promise.all([participantA.close(), participantB.close(), adminContext.close()]);

    console.log('[11/11] Browser runtime checks');
    assert.deepEqual(pageErrors, [], `browser runtime errors: ${pageErrors.join('; ')}`);
    console.log(`UI regression passed; ${adapterCalls} local mock calls, no external API. Screenshots: ${artifactsDir}`);
  } finally {
    providerGate?.resolve();
    if (browser) await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    app.locals.db.close();
    exportedApp.locals.db.close();
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });

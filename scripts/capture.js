const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.AI_PROVIDER = 'mock';
delete process.env.AI_API_KEY;
delete process.env.QUEST_API_KEY;
const { createApp } = require('../src/app');
const { createMockAdapter } = require('../ai-adapter');

(async () => {
  const directory = path.join(__dirname, '..', 'docs', 'images');
  fs.mkdirSync(directory, { recursive: true });
  const app = createApp({
    env: { AI_PROVIDER: 'mock', GENERATION_COOLDOWN_MS: '0', ADMIN_TOKEN: 'capture-only-demo-host' },
    aiAdapter: createMockAdapter(),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const errors = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
      recordVideo: { dir: path.join(__dirname, '..', 'artifacts', 'video'), size: { width: 1440, height: 1050 } },
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => [...document.images].filter(image => image.getAttribute('src')).every(image => image.complete && image.naturalWidth > 0));
    await page.screenshot({ path: path.join(directory, 'entry.png'), fullPage: true });
    await page.locator('#nickname').fill('Nova-07');
    await page.locator('#start').click();
    await page.locator('#workspace').waitFor({ state: 'visible' });
    await page.locator('#prompt').fill('Дружелюбный исследователь далёкой планеты, круглый шлем и бирюзовый рюкзак');
    await page.locator('#generate').click();
    await page.locator('#result').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#generate').classList.contains('is-loading'));
    await page.locator('#createSection').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(directory, 'workspace.png'), fullPage: true });
    await page.locator('#prompt').fill('Добавь яркий шарф и сохрани того же персонажа');
    await page.locator('#generate').click();
    await page.waitForFunction(() => document.querySelector('#previewLabel').textContent.includes('02'));
    await page.screenshot({ path: path.join(directory, 'version-02.png'), fullPage: true });
    await page.locator('#publish').click();
    await page.waitForFunction(() => document.querySelector('#publish').disabled && document.querySelector('#publish').textContent.includes('Опубликовано'));
    // A second participant goes through the same normal entry points.
    const other = await browser.newPage();
    await other.goto(origin);
    await other.locator('#nickname').fill('Pixel-04');
    await other.locator('#start').click();
    await other.locator('#prompt').fill('Добрый садовник на луне, лёгкий скафандр и зелёная лейка');
    await other.locator('#generate').click();
    await other.locator('#result').waitFor({ state: 'visible' });
    await other.locator('#publish').click();
    await other.waitForFunction(() => document.querySelector('#publish').textContent.includes('Опубликовано'));
    await page.locator('#showGallery').click();
    await page.waitForFunction(() => document.querySelectorAll('#gallery img').length === 2);
    await page.screenshot({ path: path.join(directory, 'gallery.png'), fullPage: true });
    const admin = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    await admin.goto(origin + '/admin.html');
    await admin.locator('#token').fill('capture-only-demo-host');
    await admin.locator('#load').click();
    await admin.locator('#works-panel').waitFor({ state: 'visible' });
    await admin.screenshot({ path: path.join(directory, 'moderation.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(directory, 'mobile.png'), fullPage: true });
    if (errors.length) throw new Error(errors.join('\n'));
    await context.close();
    console.log('Captured real UI after generate, edit, publish and moderation using a local deterministic fixture.');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    app.locals.db.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

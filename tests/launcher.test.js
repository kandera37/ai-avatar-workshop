const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

function fixture() {
  const parent = path.join(__dirname, '..', 'artifacts');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'launcher-'));
  for (const file of ['server.js', 'src', 'ai-adapter.js', 'db.js']) {
    fs.cpSync(path.join(__dirname, '..', file), path.join(directory, file), { recursive: true });
  }
  const env = { ...process.env, NODE_ENV: 'production', APP_MODE: 'demo' };
  for (const name of ['DB_PATH', 'QUEST_DB_PATH', 'IMAGE_BUDGET_DIRECTORY', 'ADMIN_TOKEN', 'ALLOW_PAID_IMAGE_API']) delete env[name];
  return { directory, env };
}
async function freePort() {
  const socket = net.createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
async function run(directory, env) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], { cwd: directory, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = 'http://127.0.0.1:' + port;
  let output = '';
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { output += value; });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Launcher exited: ' + output);
    try {
      if ((await fetch(origin + '/api/health')).ok) return { child, origin, output: () => output };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  child.kill();
  throw new Error('Launcher did not become ready');
}
async function stop(child) {
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

test('demo launcher ignores inherited provider credentials; persists image and budget across restart', async () => {
  const { directory, env } = fixture();
  let instance;
  try {
    instance = await run(directory, { ...env, AI_PROVIDER: 'http', AI_API_KEY: 'inherited-secret-never-send', AI_API_URL: 'http://127.0.0.1:1', QUEST_API_KEY: 'inherited-quest-secret-never-send' });
    assert.equal((await (await fetch(instance.origin + '/api/health')).json()).provider, 'mock');
    const created = await fetch(instance.origin + '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: 'Orbit-01' }) });
    const session = await created.json();
    assert.equal(created.status, 201);
    const response = await fetch(instance.origin + '/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: session.id || session.sessionId, prompt: 'Добрый робот исследователь с синим рюкзаком' }) });
    assert.equal(response.status, 201);
    const image = await response.json();
    assert.match(image.imageData, /^data:image/);
    assert.doesNotMatch(instance.output(), /inherited-secret|inherited-quest/);
    const quota = await (await fetch(instance.origin + '/api/generation-quota')).json();
    const adminCode = fs.readFileSync(path.join(directory, '.runtime', 'admin-code.txt'), 'utf8');
    await stop(instance.child); instance = null;
    instance = await run(directory, env);
    const restored = await fetch(instance.origin + '/api/sessions/' + (session.id || session.sessionId));
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).latestGeneration.imageData, image.imageData);
    assert.deepEqual(await (await fetch(instance.origin + '/api/generation-quota')).json(), quota);
    assert.equal(fs.readFileSync(path.join(directory, '.runtime', 'admin-code.txt'), 'utf8'), adminCode);
  } finally {
    if (instance) await stop(instance.child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('paid mode refuses to start without explicit opt-in or provider configuration', () => {
  const { directory, env } = fixture();
  try {
    for (const extra of [{}, { ALLOW_PAID_IMAGE_API: '1', AI_API_KEY: '', AI_API_URL: '' }]) {
      const result = spawnSync(process.execPath, ['server.js'], { cwd: directory, env: { ...env, APP_MODE: 'connected', ...extra }, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Connected mode requires/);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

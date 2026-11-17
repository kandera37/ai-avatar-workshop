require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const state = path.join(__dirname, '.runtime');
fs.mkdirSync(state, { recursive: true, mode: 0o700 });
const connected = process.env.APP_MODE === 'connected';
if (connected && process.env.ALLOW_PAID_IMAGE_API !== '1') {
  throw new Error('Connected mode requires ALLOW_PAID_IMAGE_API=1');
}
if (connected && (!process.env.AI_API_KEY || !process.env.AI_API_URL)) {
  throw new Error('Connected mode requires your AI_API_KEY and AI_API_URL');
}
if (!connected) {
  process.env.AI_PROVIDER = 'mock';
  delete process.env.AI_API_KEY;
  delete process.env.AI_API_URL;
  delete process.env.QUEST_API_KEY;
} else {
  process.env.AI_PROVIDER = 'http';
}
const modeState = path.join(state, connected ? 'connected' : 'demo');
fs.mkdirSync(modeState, { recursive: true, mode: 0o700 });
process.env.DB_PATH ||= path.join(modeState, 'avatars.db');
process.env.IMAGE_BUDGET_DIRECTORY ||= path.join(state, 'budgets', connected ? 'connected' : 'demo');
process.env.QUEST_DB_PATH ||= path.join(modeState, 'quest.db');
process.env.GENERATION_COOLDOWN_MS ||= '10000';
process.env.MAX_GENERATIONS_PER_SESSION ||= '5';
fs.mkdirSync(process.env.IMAGE_BUDGET_DIRECTORY, { recursive: true, mode: 0o700 });
for (const [name, initial] of [
  ['image-limit', connected ? '0' : '100'],
  ['developer-image-limit', '0'],
  ['quest-image-limit', '0'],
]) {
  const file = path.join(process.env.IMAGE_BUDGET_DIRECTORY, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, initial + '\n', { mode: 0o600, flag: 'wx' });
}
const adminCode = path.join(state, 'admin-code.txt');
if (!process.env.ADMIN_TOKEN) {
  if (!fs.existsSync(adminCode)) fs.writeFileSync(adminCode, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  process.env.ADMIN_TOKEN = fs.readFileSync(adminCode, 'utf8').trim();
}
const secrets = [process.env.ADMIN_TOKEN, process.env.AI_API_KEY, process.env.QUEST_API_KEY].filter(Boolean);
for (const method of ['log', 'info', 'warn', 'error']) {
  const original = console[method].bind(console);
  console[method] = (...args) => original(...args.map(value => {
    if (typeof value !== 'string') return '[diagnostic object omitted]';
    return secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);
  }));
}
const app = require('./src/app');
const server = app.listen(Number(process.env.PORT || 3000), '127.0.0.1', () => {
  console.info('Avatar Workshop is ready on localhost. Mode=' + (connected ? 'connected' : 'demo'));
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    app.locals.closeQuest?.();
    server.close(() => { app.locals.db.close(); process.exit(0); });
  });
}

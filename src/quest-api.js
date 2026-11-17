const crypto = require('node:crypto');
const express = require('express');
const Database = require('better-sqlite3');
const { AiAdapterError } = require('../ai-adapter');
const { openQuestImageBudget } = require('./image-budget');

const basePath = '/api/integrations/quest';
const maxQueuedAge = 10 * 60_000;
const imageLifetime = 24 * 60 * 60_000;
const jobLifetime = 7 * imageLifetime;
const maxImageBytes = 5 * 1024 * 1024;
const maxStoredBytes = 64 * 1024 * 1024;
const maxActiveJobs = 5;
const maxStoredJobs = 1024;
const uuid = /^[a-f0-9-]{36}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const allowedFields = ['prompt', 'style', 'eventId', 'teamId'];

const messages = {
  UNAUTHORIZED: 'A valid quest bearer key is required.',
  SERVER_ONLY: 'Use this API from your backend.',
  INVALID_REQUEST: 'Check the JSON body and Idempotency-Key.',
  INVALID_PROMPT: 'Provide a safe, descriptive prompt within the length limit.',
  UNSUPPORTED_MEDIA_TYPE: 'Send application/json.',
  REQUEST_TOO_LARGE: 'The request body exceeds 4 KiB.',
  IDEMPOTENCY_CONFLICT: 'This key was already used with a different request.',
  QUOTA_EXHAUSTED: 'The quest image budget is exhausted.',
  QUOTA_UNAVAILABLE: 'The quest image budget is unavailable.',
  RATE_LIMITED: 'Too many quest API requests.',
  QUEUE_FULL: 'The quest queue or storage is full.',
  NOT_FOUND: 'The requested resource was not found.',
  JOB_INTERRUPTED: 'The service restarted while processing this job.',
  QUEUE_EXPIRED: 'The job waited too long in the queue.',
  PROVIDER_TIMEOUT: 'The image provider timed out.',
  PROVIDER_REJECTED: 'The image provider rejected the request.',
  PROVIDER_UNAVAILABLE: 'The image provider did not return a usable image.',
};
const errorBody = (code) => ({ code, message: messages[code] });
const fail = (res, status, code) => res.status(status).json({ error: errorBody(code) });

function jobError(error) {
  switch (error?.code) {
    case 'DEMO_QUOTA_EXHAUSTED': return 'QUOTA_EXHAUSTED';
    case 'DEMO_QUOTA_UNAVAILABLE': return 'QUOTA_UNAVAILABLE';
    case 'CONTENT_REJECT':
    case 'CLIENT_ERROR': return 'PROVIDER_REJECTED';
    case 'TIMEOUT': return 'PROVIDER_TIMEOUT';
    default: return 'PROVIDER_UNAVAILABLE';
  }
}

function decodeImage(value) {
  const invalid = () => new AiAdapterError('Invalid quest image', { code: 'INVALID_IMAGE', status: 502 });
  if (typeof value !== 'string' || value.length > Math.ceil(maxImageBytes / 3) * 4 + 32) throw invalid();
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw invalid();
  const [, mime, encoded] = match;
  const bytes = Buffer.from(encoded, 'base64');
  const png = mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpeg = mime === 'image/jpeg' && bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  const webp = mime === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (bytes.length > maxImageBytes || !(png || jpeg || webp)) throw invalid();
  return { mime, bytes };
}

function openQuestApi(env, { generate, maxPrompt, isUnsafe }) {
  if (!env.QUEST_API_KEY) return null;
  const key = Buffer.from(env.QUEST_API_KEY);
  const origin = new URL(env.QUEST_PUBLIC_ORIGIN);
  if (key.length < 32 || origin.protocol !== 'https:' || origin.origin !== env.QUEST_PUBLIC_ORIGIN ||
      !env.QUEST_DB_PATH || !env.IMAGE_BUDGET_DIRECTORY) throw new Error('Invalid quest API configuration');

  const db = new Database(env.QUEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('secure_delete = ON');
  const budget = openQuestImageBudget(db, env.IMAGE_BUDGET_DIRECTORY);
  db.exec(`CREATE TABLE IF NOT EXISTS quest_jobs (
    id TEXT PRIMARY KEY,
    request_key TEXT UNIQUE NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','processing','completed','failed')),
    prompt TEXT,
    event_id TEXT,
    team_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    error_code TEXT,
    image_id TEXT UNIQUE,
    image_expires_at INTEGER,
    image_mime TEXT,
    image BLOB
  )`);
  const failJob = db.prepare("UPDATE quest_jobs SET status='failed', error_code=?, updated_at=?, prompt=NULL WHERE id=? AND status='processing'");
  // A previous worker may already have charged the provider. Never replay it.
  db.prepare("UPDATE quest_jobs SET status='failed', error_code='JOB_INTERRUPTED', updated_at=?, prompt=NULL WHERE status='processing'").run(Date.now());
  const expireQueue = db.prepare("UPDATE quest_jobs SET status='failed', error_code='QUEUE_EXPIRED', updated_at=?, prompt=NULL WHERE status='queued' AND created_at<=?");
  const expireImages = db.prepare("UPDATE quest_jobs SET image=NULL, image_mime=NULL WHERE image IS NOT NULL AND image_expires_at<=?");
  const expireJobs = db.prepare("DELETE FROM quest_jobs WHERE status IN ('completed','failed') AND updated_at<=?");
  const maintenance = db.transaction((now) => {
    expireQueue.run(now, now - maxQueuedAge);
    expireImages.run(now);
    expireJobs.run(now - jobLifetime);
  });
  const claim = db.prepare(`UPDATE quest_jobs SET status='processing', updated_at=?
    WHERE id=(SELECT id FROM quest_jobs WHERE status='queued' AND created_at>? ORDER BY created_at,rowid LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM quest_jobs WHERE status='processing')
    RETURNING id,prompt`);
  const finish = db.prepare(`UPDATE quest_jobs SET status='completed', updated_at=?, prompt=NULL,
    image_id=?, image_expires_at=?, image_mime=?, image=? WHERE id=? AND status='processing'`);
  const counts = db.prepare(`SELECT COUNT(*) AS jobs, COALESCE(SUM(status IN ('queued','processing')),0) AS active,
    COALESCE(SUM(length(image)),0) AS bytes FROM quest_jobs`);
  const fields = 'id, status, event_id, team_id, created_at, updated_at, error_code, image_id, image_expires_at';
  const getJob = db.prepare('SELECT ' + fields + ' FROM quest_jobs WHERE id=?');
  const getByKey = db.prepare('SELECT request_hash, ' + fields + ' FROM quest_jobs WHERE request_key=?');
  const getImage = db.prepare("SELECT image_mime,image FROM quest_jobs WHERE image_id=? AND image_expires_at>? AND status='completed'");
  const insert = db.prepare(`INSERT INTO quest_jobs (id,request_key,request_hash,status,prompt,event_id,team_id,created_at,updated_at)
    VALUES (?,?,?,'queued',?,?,?,?,?)`);
  const enqueue = db.transaction((idempotencyKey, requestHash, input) => {
    const existing = getByKey.get(idempotencyKey);
    if (existing) return existing.request_hash === requestHash ? { job: existing } : { conflict: true };
    if (!budget.snapshot('quest').remaining) throw budget.exhausted();
    const current = counts.get();
    if (current.active >= maxActiveJobs || current.jobs >= maxStoredJobs ||
        current.bytes + (current.active + 1) * maxImageBytes > maxStoredBytes) return { full: true };
    const id = crypto.randomUUID();
    const now = Date.now();
    insert.run(id, idempotencyKey, requestHash, input.text, input.eventId, input.teamId, now, now);
    return { job: getJob.get(id), created: true };
  });

  let closed = false;
  let running = false;
  let pending = null;
  function schedule() {
    if (closed || running || pending) return;
    pending = setImmediate(() => {
      pending = null;
      pump().catch(() => console.error('[quest] queue operation failed'));
    });
  }
  async function pump() {
    if (closed || running) return;
    const now = Date.now();
    const job = claim.get(now, now - maxQueuedAge);
    if (!job) return;
    running = true;
    try {
      if (!budget.snapshot('quest').remaining) throw budget.exhausted();
      const image = await generate(job.prompt, () => {
        if (closed) throw new AiAdapterError('Quest worker stopped', { code: 'DEMO_QUOTA_UNAVAILABLE', status: 503 });
        budget.reserve('quest');
      }, decodeImage);
      if (!closed) {
        const ended = Date.now();
        finish.run(ended, crypto.randomUUID(), ended + imageLifetime, image.mime, image.bytes, job.id);
      }
    } catch (error) {
      if (!closed) {
        const code = jobError(error);
        failJob.run(code, Date.now(), job.id);
        console.info('[quest] failed job', job.id, code);
      }
    } finally {
      running = false;
      schedule();
    }
  }
  maintenance(Date.now());
  const timer = setInterval(() => {
    try { maintenance(Date.now()); } catch { console.error('[quest] queue maintenance failed'); }
    schedule();
  }, 60_000);
  timer.unref();
  schedule();

  function view(row) {
    const image = row.image_id && row.image_expires_at > Date.now();
    return {
      jobId: row.id,
      status: row.status,
      ...(row.event_id && { eventId: row.event_id }),
      ...(row.team_id && { teamId: row.team_id }),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      ...(row.error_code && { error: errorBody(row.error_code) }),
      ...(row.status === 'completed' && {
        imageUrl: image ? origin.origin + basePath + '/images/' + row.image_id : null,
        imageExpiresAt: new Date(row.image_expires_at).toISOString(),
      }),
    };
  }
  const router = express.Router({ caseSensitive: true, strict: true });
  router.get('/images/:id', (req, res) => {
    const row = uuid.test(req.params.id) && getImage.get(req.params.id, Date.now());
    if (!row?.image) return fail(res, 404, 'NOT_FOUND');
    return res.set({
      'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Referrer-Policy': 'no-referrer',
    }).type(row.image_mime).send(row.image);
  });

  const rate = new Map();
  router.use((req, res, next) => {
    if (req.get('origin')) return fail(res, 403, 'SERVER_ONLY');
    const header = /^Bearer ([^\s]+)$/i.exec(req.get('authorization') || '');
    const supplied = Buffer.from(header?.[1] || '');
    if (supplied.length !== key.length || !crypto.timingSafeEqual(supplied, key)) {
      res.set('WWW-Authenticate', 'Bearer');
      return fail(res, 401, 'UNAUTHORIZED');
    }
    const method = req.method === 'POST' ? 'create' : 'read';
    const now = Date.now();
    let bucket = rate.get(method);
    if (!bucket || now >= bucket.until) {
      bucket = { until: now + 60_000, count: 0 };
      rate.set(method, bucket);
    }
    if (++bucket.count > (method === 'create' ? 10 : 120)) {
      res.set('Retry-After', String(Math.ceil((bucket.until - now) / 1000)));
      return fail(res, 429, 'RATE_LIMITED');
    }
    next();
  });
  router.post('/generations', express.json({ limit: '4kb' }), (req, res) => {
    if (!req.is('application/json')) return fail(res, 415, 'UNSUPPORTED_MEDIA_TYPE');
    const idempotencyKey = req.get('idempotency-key') || '';
    const body = req.body;
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey) || !body || Array.isArray(body) ||
        typeof body.prompt !== 'string' || Object.keys(body).some((field) => !allowedFields.includes(field))) {
      return fail(res, 400, 'INVALID_REQUEST');
    }
    const prompt = body.prompt;
    const style = typeof body.style === 'string' ? body.style.trim() : '';
    const eventId = body.eventId ?? null;
    const teamId = body.teamId ?? null;
    if ((body.style !== undefined && (typeof body.style !== 'string' || style.length > 80 || /[\p{Cc}]/u.test(style))) ||
        [eventId, teamId].some((id) => id !== null && (typeof id !== 'string' || !identifier.test(id)))) {
      return fail(res, 400, 'INVALID_REQUEST');
    }
    if (!prompt.trim() || prompt.length > maxPrompt || isUnsafe(prompt) || (style && isUnsafe(style))) {
      return fail(res, 400, 'INVALID_PROMPT');
    }
    const styleText = /^(malevich|малевич)$/iu.test(style) ? 'Kazimir Malevich inspired Suprematist composition, geometric shapes and bold flat color.' : style;
    const text = styleText ? prompt + '\n\nVisual style: ' + styleText : prompt;
    // Keep key matching compatible with earlier requests that trimmed the prompt.
    const hash = crypto.createHash('sha256').update(JSON.stringify({ prompt: prompt.trim(), style, eventId, teamId })).digest('hex');
    try {
      const outcome = enqueue.immediate(idempotencyKey, hash, { text, eventId, teamId });
      if (outcome.conflict) return fail(res, 409, 'IDEMPOTENCY_CONFLICT');
      if (outcome.full) {
        res.set('Retry-After', '60');
        return fail(res, 429, 'QUEUE_FULL');
      }
      res.set('Location', basePath + '/generations/' + outcome.job.id);
      res.status(outcome.created ? 202 : 200).json(view(outcome.job));
      schedule();
    } catch (error) {
      const code = jobError(error);
      return code === 'QUOTA_EXHAUSTED' ? fail(res, 402, code) : fail(res, 503, 'QUOTA_UNAVAILABLE');
    }
  });
  router.get('/generations/:id', (req, res) => {
    const row = uuid.test(req.params.id) && getJob.get(req.params.id);
    return row ? res.json(view(row)) : fail(res, 404, 'NOT_FOUND');
  });
  router.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return fail(res, 413, 'REQUEST_TOO_LARGE');
    if (err.status === 400) return fail(res, 400, 'INVALID_REQUEST');
    if (err.status === 415) return fail(res, 415, 'UNSUPPORTED_MEDIA_TYPE');
    console.error('[quest] request operation failed');
    return fail(res, 503, 'QUOTA_UNAVAILABLE');
  });
  router.use((req, res) => fail(res, 404, 'NOT_FOUND'));
  return { router, close() {
    closed = true;
    clearInterval(timer);
    clearImmediate(pending);
    db.close();
  } };
}

module.exports = { openQuestApi };

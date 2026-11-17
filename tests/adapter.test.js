const test = require('node:test');
const assert = require('node:assert/strict');
const { AiAdapterError, createHttpAdapter } = require('../ai-adapter');

const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('HTTP AI adapter keeps the API key on the backend and parses imageData', async () => {
  const calls = [];
  const adapter = createHttpAdapter({
    url: 'https://provider.example/generate',
    apiKey: 'secret-test-key',
    model: 'image-model-test',
    size: '512x512',
    quality: 'standard',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ imageData }) };
    },
  });
  const result = await adapter.generate('friendly robot');
  assert.equal(result.imageData, imageData);
  assert.equal(result.provider, 'http');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret-test-key');
  assert.deepEqual(JSON.parse(calls[0].options.body), { prompt: 'friendly robot', model: 'image-model-test', n: 1, size: '512x512', quality: 'standard' });
});

test('HTTP AI adapter downloads an image URL and reports provider errors', async () => {
  const calls = [];
  const adapter = createHttpAdapter({
    url: 'https://provider.example/generate',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return { ok: true, status: 200, json: async () => ({ imageUrl: 'https://cdn.example/avatar.png' }) };
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'image/png; charset=binary' },
        arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
      };
    },
  });
  const result = await adapter.generate('friendly dragon');
  assert.match(result.imageData, /^data:image\/png;base64,/);
  assert.equal(calls.length, 2);

  const failing = createHttpAdapter({
    url: 'https://provider.example/generate',
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: 'busy' }) }),
  });
  await assert.rejects(() => failing.generate('friendly robot'), /busy/);
});

test('HTTP adapter normalizes image content types and rejects unsupported image files', async () => {
  const unsupported = createHttpAdapter({
    url: 'https://provider.example/generate',
    fetchImpl: async (url) => url.includes('generate')
      ? { ok: true, status: 200, json: async () => ({ imageUrl: 'https://cdn.example/avatar.tiff' }) }
      : { ok: true, status: 200, headers: { get: () => 'image/tiff' }, arrayBuffer: async () => Uint8Array.from([1]).buffer },
  });
  await assert.rejects(() => unsupported.generate('friendly dragon'), (error) => error.code === 'INVALID_IMAGE');
});

test('HTTP adapter classifies rate limits, timeout and malformed image responses', async () => {
  const limited = createHttpAdapter({
    url: 'https://provider.example/generate',
    fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => '3' }, json: async () => ({ error: { message: 'slow down' } }) }),
  });
  await assert.rejects(
    () => limited.generate('friendly robot'),
    (error) => error instanceof AiAdapterError && error.code === 'RATE_LIMIT' && error.status === 429 && error.retryAfterMs === 3000,
  );

  const timedOut = createHttpAdapter({
    url: 'https://provider.example/generate',
    timeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); });
    }),
  });
  await assert.rejects(() => timedOut.generate('friendly robot'), (error) => error.code === 'TIMEOUT' && error.status === 504);

  const malformed = createHttpAdapter({
    url: 'https://provider.example/generate',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{}] }) }),
  });
  await assert.rejects(() => malformed.generate('friendly robot'), (error) => error.code === 'NO_IMAGE');
});

test('HTTP adapter keeps provider status and classifies content rejects', async () => {
  const unavailable = createHttpAdapter({
    url: 'https://provider.example/generate',
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: { message: 'upstream unavailable' } }) }),
  });
  await assert.rejects(() => unavailable.generate('friendly robot'), (error) => error.code === 'PROVIDER_ERROR' && error.status === 503);

  const rejected = createHttpAdapter({
    url: 'https://provider.example/generate',
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 'content_policy_violation', message: 'blocked' } }) }),
  });
  await assert.rejects(() => rejected.generate('unsafe idea'), (error) => error.code === 'CONTENT_REJECT' && error.status === 400);
});

test('HTTP adapter distinguishes auth, client and provider failures', async () => {
  const auth = createHttpAdapter({
    url: 'https://provider.example/generate',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }),
  });
  await assert.rejects(() => auth.generate('friendly robot'), (error) => error.code === 'AUTH' && error.status === 401);

  const client = createHttpAdapter({
    url: 'https://provider.example/generate',
    fetchImpl: async () => ({ ok: false, status: 422, json: async () => ({ error: 'invalid request' }) }),
  });
  await assert.rejects(() => client.generate('friendly robot'), (error) => error.code === 'CLIENT_ERROR' && error.status === 422);

  const provider = createHttpAdapter({
    url: 'https://provider.example/generate',
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: 'upstream failure' }) }),
  });
  await assert.rejects(() => provider.generate('friendly robot'), (error) => error.code === 'PROVIDER_ERROR' && error.status === 500);
});

test('HTTP adapter rejects invalid JSON and non-base64 data URLs', async () => {
  const invalidJson = createHttpAdapter({
    url: 'https://provider.example/generate',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('not json'); } }),
  });
  await assert.rejects(() => invalidJson.generate('friendly robot'), (error) => error.code === 'INVALID_RESPONSE' && error.status === 502);

  const invalidImage = createHttpAdapter({
    url: 'https://provider.example/generate',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ imageData: 'data:image/png,<svg>not base64</svg>' }) }),
  });
  await assert.rejects(() => invalidImage.generate('friendly robot'), (error) => error.code === 'INVALID_IMAGE' && error.status === 502);
});

test('HTTP adapter sends reference images as multipart edits', async () => {
  const calls = [];
  const adapter = createHttpAdapter({
    url: 'https://provider.example/v1/images/generations',
    apiKey: 'secret-edit-key',
    model: 'gpt-image-2.5-flare',
    size: '1024x1024',
    quality: 'low',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: imageData.replace(/^data:image\/png;base64,/, '') }] }) };
    },
  });

  const result = await adapter.edit('add an orange scarf', imageData);
  assert.equal(result.imageData, imageData);
  assert.equal(result.provider, 'http');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://provider.example/v1/images/edits');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret-edit-key');
  assert.equal(calls[0].options.headers['content-type'], undefined, 'fetch must set multipart boundary');
  assert.ok(calls[0].options.body instanceof FormData);
  assert.equal(calls[0].options.body.get('model'), 'gpt-image-2.5-flare');
  assert.equal(calls[0].options.body.get('prompt'), 'add an orange scarf');
  assert.equal(calls[0].options.body.get('size'), '1024x1024');
  assert.equal(calls[0].options.body.get('quality'), 'low');
  const reference = calls[0].options.body.get('image');
  assert.ok(reference instanceof Blob);
  assert.equal(reference.type, 'image/png');
  assert.ok(reference.size > 0);
});

test('HTTP adapter accepts a per-request model override without changing the prompt', async () => {
  let payload;
  const adapter = createHttpAdapter({
    url: 'https://provider.example/v1/images/generations',
    model: 'gpt-image-2.5-flare',
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: imageData.replace(/^data:image\/png;base64,/, '') }] }) };
    },
  });
  await adapter.generate('same prompt', 'gpt-image-2');
  assert.equal(payload.model, 'gpt-image-2');
  assert.equal(payload.prompt, 'same prompt');
});

test('HTTP adapter rejects an invalid reference before making an edit request', async () => {
  let calls = 0;
  const adapter = createHttpAdapter({
    url: 'https://provider.example/v1/images/generations',
    fetchImpl: async () => { calls += 1; return { ok: true, status: 200, json: async () => ({}) }; },
  });
  await assert.rejects(() => adapter.edit('change the scarf', 'not-an-image'), (error) => error.code === 'INVALID_REFERENCE_IMAGE' && error.status === 400);
  assert.equal(calls, 0);
});

test('HTTP adapter preserves safe provider error details for a client error', async () => {
  const failing = createHttpAdapter({
    url: 'https://provider.example/v1/images/generations',
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      headers: { get: (name) => name.toLowerCase() === 'x-gyw-request-id' ? 'gyw-400-test' : null },
      json: async () => ({ error: {
        code: 'invalid_parameter',
        type: 'invalid_request_error',
        message: 'n must be a positive integer',
        detail: 'n must be a positive integer',
      } }),
    }),
  });
  await assert.rejects(() => failing.generate('friendly robot'), (error) => {
    assert.ok(error instanceof AiAdapterError);
    assert.equal(error.code, 'CLIENT_ERROR');
    assert.equal(error.status, 400);
    assert.equal(error.requestId, 'gyw-400-test');
    assert.equal(error.providerErrorCode, 'invalid_parameter');
    assert.equal(error.providerErrorType, 'invalid_request_error');
    assert.equal(error.providerErrorMessage, 'n must be a positive integer');
    assert.equal(error.providerErrorDetail, 'n must be a positive integer');
    assert.notEqual(error.code, 'CONTENT_REJECT');
    return true;
  });
});

test('HTTP adapter distinguishes provider HTTP 504 from a local timeout', async () => {
  const provider504 = createHttpAdapter({
    url: 'https://provider.example/v1/images/generations',
    fetchImpl: async () => ({
      ok: false,
      status: 504,
      headers: { get: () => 'gyw-504-test' },
      json: async () => ({ error: { code: 'gateway_timeout', type: 'provider_error', message: 'upstream timed out' } }),
    }),
  });
  await assert.rejects(() => provider504.generate('friendly robot'), (error) => {
    assert.equal(error.code, 'PROVIDER_ERROR');
    assert.equal(error.status, 504);
    assert.equal(error.source, 'provider');
    assert.equal(error.providerStatus, 504);
    assert.equal(error.requestId, 'gyw-504-test');
    return true;
  });

  const localTimeout = createHttpAdapter({
    url: 'https://provider.example/v1/images/generations',
    timeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  await assert.rejects(() => localTimeout.generate('friendly robot'), (error) => {
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(error.status, 504);
    assert.equal(error.source, 'local_timeout');
    assert.equal(error.providerStatus, null);
    assert.equal(error.requestId, null);
    return true;
  });
});

test('fallback generation payload is limited to common image fields', async () => {
  let payload;
  const adapter = createHttpAdapter({
    url: 'https://provider.example/v1/images/generations',
    model: 'gpt-image-2.5-flare',
    size: '1024x1024',
    quality: 'low',
    extraBody: {
      n: 1,
      response_format: 'b64_json',
      model_specific_option: 'must-not-leak-to-fallback',
    },
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: imageData.replace(/^data:image\/png;base64,/, '') }] }) };
    },
  });
  await adapter.generate('same prompt', 'gpt-image-2');
  assert.deepEqual(Object.keys(payload).sort(), ['model', 'n', 'prompt', 'quality', 'response_format', 'size'].sort());
  assert.equal(payload.model, 'gpt-image-2');
  assert.equal(payload.prompt, 'same prompt');
  assert.equal(payload.n, 1);
  assert.equal(payload.size, '1024x1024');
  assert.equal(payload.quality, 'low');
  assert.equal(payload.response_format, 'b64_json');
  assert.equal(payload.model_specific_option, undefined);
});

test('Sunburst generation uses only its confirmed minimal payload', async () => {
  let payload;
  const adapter = createHttpAdapter({
    url: 'https://provider.example/v1/images/generations',
    model: 'gpt-image-2.5-sunburst',
    size: '1024x1024',
    quality: 'low',
    extraBody: {
      response_format: 'b64_json',
      model_specific_option: 'must-not-be-sent',
    },
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: imageData.replace(/^data:image\/png;base64,/, '') }] }) };
    },
  });
  await adapter.generate('friendly robot');
  assert.deepEqual(Object.keys(payload).sort(), ['model', 'n', 'prompt', 'response_format'].sort());
  assert.deepEqual(payload, {
    model: 'gpt-image-2.5-sunburst',
    prompt: 'friendly robot',
    n: 1,
    response_format: 'b64_json',
  });
  assert.equal(payload.size, undefined);
  assert.equal(payload.quality, undefined);
});

test('GPT Image 2 fallback keeps size and quality generation fields', async () => {
  let payload;
  const adapter = createHttpAdapter({
    url: 'https://provider.example/v1/images/generations',
    model: 'gpt-image-2.5-sunburst',
    fallbackModel: 'gpt-image-2',
    size: '1024x1024',
    quality: 'low',
    extraBody: { response_format: 'b64_json', model_specific_option: 'must-not-leak' },
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: imageData.replace(/^data:image\/png;base64,/, '') }] }) };
    },
  });
  await adapter.generate('friendly robot', 'gpt-image-2');
  assert.deepEqual(Object.keys(payload).sort(), ['model', 'n', 'prompt', 'response_format', 'size', 'quality'].sort());
  assert.deepEqual(payload, {
    model: 'gpt-image-2',
    prompt: 'friendly robot',
    n: 1,
    response_format: 'b64_json',
    size: '1024x1024',
    quality: 'low',
  });
  assert.equal(payload.model_specific_option, undefined);
});

test('fallback model uses its separate timeout budget', async () => {
  const calls = [];
  const adapter = createHttpAdapter({
    url: 'https://provider.example/v1/images/generations',
    model: 'gpt-image-2.5-flare',
    fallbackModel: 'gpt-image-2',
    timeoutMs: 5,
    fallbackTimeoutMs: 40,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body.model);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({ data: [{ b64_json: imageData.replace(/^data:image\/png;base64,/, '') }] }) }), 20);
        options.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  });
  await assert.rejects(() => adapter.generate('same prompt', 'gpt-image-2.5-flare'), (error) => error.code === 'TIMEOUT' && error.source === 'local_timeout');
  const result = await adapter.generate('same prompt', 'gpt-image-2');
  assert.equal(result.provider, 'http');
  assert.deepEqual(calls, ['gpt-image-2.5-flare', 'gpt-image-2']);
});

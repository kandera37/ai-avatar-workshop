const crypto = require('node:crypto');
const QUANTEEX_IMAGE_MODELS = ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'];

function isQuanteexUrl(url) {
  try { return new URL(url).hostname.toLowerCase() === 'api.quanteex.com'; } catch { return false; }
}

function svgDataUrl(prompt) {
  const palette = ['#ff602f', '#187f77', '#52758c', '#d3a52b'];
  const seed = parseInt(crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 8), 16);
  const background = palette[seed % palette.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="768" viewBox="0 0 768 768"><rect width="768" height="768" fill="${background}"/><circle cx="384" cy="310" r="175" fill="#fbfcfb"/><circle cx="330" cy="290" r="22" fill="#20242b"/><circle cx="438" cy="290" r="22" fill="#20242b"/><path d="M310 370 Q384 425 458 370" fill="none" stroke="#20242b" stroke-width="14" stroke-linecap="round"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function createMockAdapter() {
  return {
    async generate(prompt) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { imageData: svgDataUrl(prompt), provider: 'mock' };
    },
    async edit(prompt, referenceImage) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { imageData: svgDataUrl(`${prompt}\nreference:${referenceImage}`), provider: 'mock' };
    },
  };
}

class AiAdapterError extends Error {
  constructor(message, {
    code = 'PROVIDER_ERROR',
    status = 502,
    retryAfterMs = null,
    requestId = null,
    source = 'internal',
    providerStatus = null,
    providerErrorCode = null,
    providerErrorType = null,
    providerErrorMessage = null,
    providerErrorDetail = null,
    requestFields = null,
    cause,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AiAdapterError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.requestId = requestId;
    this.source = source;
    this.providerStatus = providerStatus;
    this.providerErrorCode = providerErrorCode;
    this.providerErrorType = providerErrorType;
    this.providerErrorMessage = providerErrorMessage;
    this.providerErrorDetail = providerErrorDetail;
    this.requestFields = requestFields;
  }
}

function getRetryAfterMs(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const value = headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function readResponseBody(response) {
  return response.json().catch(() => null);
}

function responseMessage(body, status) {
  if (typeof body?.error === 'string') return body.error;
  if (typeof body?.error?.message === 'string') return body.error.message;
  if (typeof body?.error?.detail === 'string') return body.error.detail;
  if (typeof body?.detail === 'string') return body.detail;
  if (typeof body?.message === 'string') return body.message;
  return `AI API returned HTTP ${status}`;
}

function safeProviderText(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.replace(/[\r\n]+/g, ' ').trim().slice(0, 1000);
}

function providerErrorDetails(body) {
  const nested = body?.error && typeof body.error === 'object' ? body.error : {};
  return {
    providerErrorCode: safeProviderText(nested.code),
    providerErrorType: safeProviderText(nested.type),
    providerErrorMessage: safeProviderText(nested.message) || (typeof body?.error === 'string' ? safeProviderText(body.error) : null),
    providerErrorDetail: safeProviderText(body?.detail) || safeProviderText(nested.detail),
  };
}

function responseText(body) {
  try { return JSON.stringify(body || '').toLowerCase(); } catch { return ''; }
}

function isContentReject(body) {
  const text = responseText(body);
  return /content[_ -]?policy|safety|moderation|prompt[_ -]?blocked|nsfw|inappropriate|violat(?:ion|ed)|policy[_ -]?violation/.test(text);
}

function extractImage(body) {
  return body?.imageData || body?.imageUrl || body?.data?.[0]?.url || body?.data?.[0]?.b64_json;
}

function validBase64(value) {
  return typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;
}

function validDataImage(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^data:image\/(?:png|jpe?g|webp|gif|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match || !validBase64(match[1]) || value.length > 8 * 1024 * 1024) return null;
  return value;
}

function imageDataParts(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^data:(image\/(?:png|jpe?g|webp|gif|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match || !validBase64(match[2])) return null;
  return { mimeType: match[1].toLowerCase(), bytes: Buffer.from(match[2], 'base64') };
}

function editUrlFor(url) {
  if (typeof url !== 'string' || !url) return null;
  if (/\/generations\/?$/i.test(url)) return url.replace(/\/generations\/?$/i, '/edits');
  return `${url.replace(/\/$/, '')}/edits`;
}

// Generation parameters are intentionally model-specific. Legacy provider
// Sunburst endpoint currently accepts only this minimal request shape, while
// GPT Image 2 keeps the size/quality parameters used by the fallback path.
function buildGenerationPayload({ selectedModel, prompt, n, size, quality, extraBody = {} }) {
  if (selectedModel === 'gpt-image-2.5-sunburst') {
    return {
      model: selectedModel,
      prompt,
      n: 1,
      response_format: 'b64_json',
    };
  }
  if (selectedModel === 'gpt-image-2') {
    const payload = {
      model: selectedModel,
      prompt,
      n: 1,
      response_format: 'b64_json',
    };
    if (size) payload.size = size;
    if (quality) payload.quality = quality;
    return payload;
  }
  // Preserve the configurable request shape for other providers/models.
  const payload = { ...extraBody, model: selectedModel, prompt, n };
  if (size) payload.size = size;
  if (quality) payload.quality = quality;
  return payload;
}

function createHttpAdapter({ url, editUrl = editUrlFor(url), apiKey, timeoutMs = 30000, fallbackModel = null, fallbackTimeoutMs = 119000, model = 'gpt-image-2.5-sunburst', size, quality, extraBody = {}, fetchImpl = fetch, generationTimeouts = {} }) {
  if (!url) throw new Error('AI_API_URL is not configured');
  const quanteex = isQuanteexUrl(url);
  const quanteexSize = size || 'auto';
  if (quanteex && !['auto', '1k'].includes(quanteexSize)) throw new Error('Quanteex AI_SIZE must be auto or 1k');
  if (quanteex && !isQuanteexUrl(editUrl)) throw new Error('Quanteex edit endpoint must use api.quanteex.com');
  const checkModel = (selectedModel) => {
    if (quanteex && !QUANTEEX_IMAGE_MODELS.includes(selectedModel)) {
      throw new AiAdapterError('Unsupported Quanteex image model', { code: 'INTEGRATION_ERROR', status: 400 });
    }
  };
  const safeTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 30000;
  const safeFallbackTimeout = Number.isFinite(Number(fallbackTimeoutMs)) && Number(fallbackTimeoutMs) > 0 ? Number(fallbackTimeoutMs) : 119000;
  async function requestImage(requestUrl, init, controller, metadata = {}) {
    const requestFields = metadata.requestFields || null;
    metadata.reserveImageCall?.();
    const response = await fetchImpl(requestUrl, { ...init, signal: controller.signal, ...(quanteex ? { redirect: 'error' } : {}) });
    const requestId = response.headers?.get?.('x-quanteex-request-id') || response.headers?.get?.('x-request-id') || response.headers?.get?.('x-gyw-request-id') || null;
    const responseStatus = Number(response.status) || 200;
    const body = await readResponseBody(response);
    if (!response.ok) {
      const errorBody = body || {};
      const status = Number(response.status) || 502;
      const details = providerErrorDetails(errorBody);
      const providerMeta = { status, requestId, source: 'provider', providerStatus: status, requestFields, ...details };
      if (status === 429) throw new AiAdapterError(responseMessage(errorBody, status), { code: 'RATE_LIMIT', retryAfterMs: getRetryAfterMs(response.headers), ...providerMeta });
      if (status === 401 || status === 403) throw new AiAdapterError('AI API authentication failed', { code: 'AUTH', ...providerMeta });
      if (isContentReject(errorBody)) throw new AiAdapterError(responseMessage(errorBody, status), { code: 'CONTENT_REJECT', ...providerMeta });
      if (status >= 400 && status < 500) {
        const code = isContentReject(errorBody) ? 'CONTENT_REJECT' : 'CLIENT_ERROR';
        throw new AiAdapterError(responseMessage(errorBody, status), { code, ...providerMeta });
      }
      // Preserve the provider status for diagnostics and retry decisions.
      throw new AiAdapterError(responseMessage(errorBody, status), { code: 'PROVIDER_ERROR', ...providerMeta });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AiAdapterError('AI API returned invalid JSON', { code: 'INVALID_RESPONSE', status: 502, requestId, source: 'provider', providerStatus: responseStatus, requestFields });
    const rawImage = extractImage(body);
    if (typeof rawImage !== 'string' || !rawImage.trim()) throw new AiAdapterError('AI API returned no image', { code: 'NO_IMAGE', status: 502, requestId, source: 'provider', providerStatus: responseStatus, requestFields });
    if (rawImage.startsWith('data:')) {
      const imageData = validDataImage(rawImage.trim());
      if (!imageData) throw new AiAdapterError('AI API returned an unsupported image format', { code: 'INVALID_IMAGE', status: 502, requestId, source: 'provider', providerStatus: responseStatus, requestFields });
      return { imageData, status: responseStatus, requestId, source: 'provider', providerStatus: responseStatus, requestFields };
    }
    if (/^https?:\/\//i.test(rawImage)) {
      const imageResponse = await fetchImpl(rawImage, { signal: controller.signal });
      if (!imageResponse.ok) throw new AiAdapterError(`Image download failed with HTTP ${imageResponse.status}`, { code: 'IMAGE_DOWNLOAD', status: 502 });
      const contentType = imageResponse.headers?.get?.('content-type') || 'image/png';
      const mimeType = String(contentType).split(';', 1)[0].trim().toLowerCase();
      if (!/^image\/(?:png|jpe?g|webp|gif|svg\+xml)$/.test(mimeType)) throw new AiAdapterError('AI API returned a non-image URL', { code: 'INVALID_IMAGE', status: 502 });
      const bytes = Buffer.from(await imageResponse.arrayBuffer());
      if (bytes.length > 8 * 1024 * 1024) throw new AiAdapterError('AI image is too large', { code: 'IMAGE_TOO_LARGE', status: 502 });
      return { imageData: `data:${mimeType};base64,${bytes.toString('base64')}`, status: responseStatus, requestId, source: 'provider', providerStatus: responseStatus, requestFields };
    }
    const base64 = validBase64(rawImage);
    if (!base64) throw new AiAdapterError('AI API returned an unsupported image format', { code: 'INVALID_IMAGE', status: 502 });
    return { imageData: `data:image/png;base64,${base64}`, status: responseStatus, requestId, source: 'provider', providerStatus: responseStatus, requestFields };
  }
  return {
    async generate(prompt, modelOverride = null, reserveImageCall) {
      const selectedModel = modelOverride || model || null;
      checkModel(selectedModel);
      const configuredN = Number(extraBody.n);
      const n = Number.isInteger(configuredN) && configuredN > 0 ? configuredN : 1;
      const isFallbackRequest = Boolean(modelOverride && model && selectedModel !== model);
      const selectedSize = size || extraBody.size;
      const selectedQuality = quality || extraBody.quality;
      // Fallback requests are built from the explicit model whitelist too;
      // model-specific primary options must never leak into GPT Image 2.
      // Quanteex documents the same native-1K contract for these two models.
      // Do not spread SDK/legacy options: quality and response_format are rejected.
      const payload = quanteex ? { model: selectedModel, prompt, size: quanteexSize, n: 1 } : buildGenerationPayload({
        selectedModel,
        prompt,
        n,
        size: selectedSize,
        quality: selectedQuality,
        extraBody: isFallbackRequest ? { response_format: extraBody.response_format } : extraBody,
      });
      const requestFields = Object.keys(payload);
      const controller = new AbortController();
      const configuredModelTimeout = Number(generationTimeouts[selectedModel]);
      const requestTimeout = Number.isFinite(configuredModelTimeout) && configuredModelTimeout > 0
        ? configuredModelTimeout
        : (fallbackModel && selectedModel === fallbackModel ? safeFallbackTimeout : safeTimeout);
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, requestTimeout);
      try {
        const responseData = await requestImage(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify(payload),
        }, controller, { requestFields, reserveImageCall });
        if (timedOut) throw new AiAdapterError('AI API request timed out', { code: 'TIMEOUT', status: 504, source: 'local_timeout', providerStatus: null, requestId: null, requestFields });
        return { ...responseData, provider: 'http' };
      } catch (error) {
        if (error instanceof AiAdapterError) throw error;
        if (error?.name === 'AbortError') throw new AiAdapterError('AI API request timed out', { code: 'TIMEOUT', status: 504, source: timedOut ? 'local_timeout' : 'network', providerStatus: null, requestId: null, requestFields, cause: error });
        throw new AiAdapterError(`AI API request failed: ${error.message || 'network error'}`, { code: 'NETWORK', status: 503, source: 'network', providerStatus: null, requestFields, cause: error });
      } finally {
        clearTimeout(timeout);
      }
    },
    async edit(prompt, referenceImage, modelOverride = null, reserveImageCall) {
      if (!editUrl) throw new AiAdapterError('AI edit API is not configured', { code: 'EDIT_UNSUPPORTED', status: 501 });
      const selectedModel = modelOverride || model || 'gpt-image-2.5-sunburst';
      checkModel(selectedModel);
      const reference = imageDataParts(referenceImage);
      if (!reference) throw new AiAdapterError('Reference image is invalid', { code: 'INVALID_REFERENCE_IMAGE', status: 400 });
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, safeTimeout);
      const requestFields = quanteex ? ['model', 'image', 'prompt', 'size', 'n'] : ['model', 'image', 'prompt', ...(size ? ['size'] : []), ...(quality ? ['quality'] : [])];
      try {
        const form = new FormData();
        form.append('model', selectedModel);
        form.append('image', new Blob([reference.bytes], { type: reference.mimeType }), 'reference.png');
        form.append('prompt', prompt);
        if (quanteex) {
          form.append('size', quanteexSize);
          form.append('n', '1');
        } else {
          if (size) form.append('size', size);
          if (quality) form.append('quality', quality);
        }
        const responseData = await requestImage(editUrl, {
          method: 'POST',
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
          body: form,
        }, controller, { requestFields, reserveImageCall });
        if (timedOut) throw new AiAdapterError('AI API edit request timed out', { code: 'TIMEOUT', status: 504, source: 'local_timeout', providerStatus: null, requestId: null, requestFields });
        return { ...responseData, provider: 'http' };
      } catch (error) {
        if (error instanceof AiAdapterError) throw error;
        if (error?.name === 'AbortError') throw new AiAdapterError('AI API edit request timed out', { code: 'TIMEOUT', status: 504, source: timedOut ? 'local_timeout' : 'network', providerStatus: null, requestId: null, requestFields, cause: error });
        throw new AiAdapterError(`AI API edit request failed: ${error.message || 'network error'}`, { code: 'NETWORK', status: 503, source: 'network', providerStatus: null, requestFields, cause: error });
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function createAiAdapter(env = process.env) {
  const provider = (env.AI_PROVIDER || 'mock').toLowerCase();
  if (provider === 'mock') return createMockAdapter();
  if (provider !== 'http') throw new Error(`Unsupported AI_PROVIDER: ${provider}`);
  const configuredTimeout = Number(env.AI_API_TIMEOUT_MS || 30000);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 30000;
  const configuredFallbackTimeout = Number(env.AI_FALLBACK_TIMEOUT_MS || 70000);
  const fallbackTimeoutMs = Number.isFinite(configuredFallbackTimeout) && configuredFallbackTimeout > 0 ? configuredFallbackTimeout : 119000;
  let extraBody = {};
  if (env.AI_EXTRA_BODY_JSON) {
    try { extraBody = JSON.parse(env.AI_EXTRA_BODY_JSON); } catch { throw new Error('AI_EXTRA_BODY_JSON must be valid JSON'); }
    if (!extraBody || Array.isArray(extraBody) || typeof extraBody !== 'object') throw new Error('AI_EXTRA_BODY_JSON must be a JSON object');
  }
  const fallbackModel = Object.prototype.hasOwnProperty.call(env, 'AI_FALLBACK_MODEL') ? env.AI_FALLBACK_MODEL : (isQuanteexUrl(env.AI_API_URL) ? 'gpt-image-2.5-flare' : 'gpt-image-2');
  const parseTimeout = (name, fallback) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const generationTimeouts = {
    'gpt-image-2.5-sunburst': parseTimeout('AI_GENERATION_TIMEOUT_SUNBURST_MS', 60000),
    'gpt-image-2': parseTimeout('AI_GENERATION_TIMEOUT_GPT_IMAGE_2_MS', 70000),
    'gpt-image-2.5-flare': parseTimeout('AI_GENERATION_TIMEOUT_FLARE_MS', 60000),
  };
  return createHttpAdapter({ url: env.AI_API_URL, editUrl: env.AI_EDIT_API_URL || editUrlFor(env.AI_API_URL), apiKey: env.AI_API_KEY, timeoutMs, fallbackModel: fallbackModel || null, fallbackTimeoutMs, model: env.AI_MODEL || 'gpt-image-2.5-sunburst', size: env.AI_SIZE, quality: env.AI_QUALITY, extraBody, generationTimeouts });
}

module.exports = { AiAdapterError, createAiAdapter, createMockAdapter, createHttpAdapter, svgDataUrl, editUrlFor, isQuanteexUrl, QUANTEEX_IMAGE_MODELS };

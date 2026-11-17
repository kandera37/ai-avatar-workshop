(() => {
  const $ = (id) => document.getElementById(id);
  const participantStorageKey = 'avatarParticipantId';
  const participantIdPattern = /^[A-Za-z0-9_-]{16,128}$/;
  function createParticipantId() {
    const randomUuid = window.crypto?.randomUUID?.();
    if (randomUuid) return randomUuid;
    const random = new Uint8Array(16);
    if (window.crypto?.getRandomValues) window.crypto.getRandomValues(random);
    else return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    return Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  function ensureParticipantId() {
    const stored = localStorage.getItem(participantStorageKey);
    if (stored && participantIdPattern.test(stored)) return stored;
    const created = createParticipantId();
    localStorage.setItem(participantStorageKey, created);
    return created;
  }
  let participantId = ensureParticipantId();
  let sessionId = localStorage.getItem('avatarSessionId');
  let generationId = null;
  let workId = null;
  let generationCount = 0;
  let generatedPrompt = '';
  let generating = false;
  let publishing = false;
  let published = false;
  let galleryLoading = false;
  let gallerySignature = '';
  let galleryPollTimer = null;
  let cooldownUntil = 0;
  let cooldownTimer = null;
  let progressFrame = null;
  let progressStartedAt = 0;
  let progressEstimateMs = 45000;
  let currentGenerationProgress = 0;
  const progressEstimateKey = 'avatarGenerationEstimateMs.v2';
  const progressDefaultMs = 45000;
  const galleryNodes = new Map();
  const galleryData = new Map();
  // Keep a just-published tile visible while an older polling response is
  // still in flight. It is removed as soon as the server includes the work.
  const optimisticWorks = new Map();
  const optimisticRevisions = new Map();
  let publicationRevision = 0;
  const likedWorks = new Set();
  const ownedWorks = new Set();
  const likeBusyWorks = new Set();

  function readGenerationEstimate() {
    const stored = Number(localStorage.getItem(progressEstimateKey));
    return Number.isFinite(stored) && stored >= 1000 && stored <= 180000 ? stored : progressDefaultMs;
  }
  function rememberGenerationDuration(durationMs) {
    const actual = Number(durationMs);
    if (!Number.isFinite(actual) || actual <= 0 || actual > 180000) return;
    const previous = readGenerationEstimate();
    // A smoothed estimate avoids a single unusually fast or slow request
    // making the next progress animation misleading.
    const next = Math.round(previous * 0.65 + actual * 0.35);
    progressEstimateMs = Math.max(1000, Math.min(180000, next));
    localStorage.setItem(progressEstimateKey, String(progressEstimateMs));
  }
  function updatePromptMode() {
    const hasAvatar = Boolean(generationId);
    const title = $('createTitle');
    const label = $('promptLabel');
    const prompt = $('prompt');
    const hint = $('promptHint');
    const modeHint = $('promptModeHint');
    const themes = document.querySelector('.themes');
    if (title) title.textContent = hasAvatar ? 'Измени героя' : 'Опиши героя';
    if (label) label.textContent = hasAvatar ? 'Что хочешь изменить?' : 'Кто это?';
    if (prompt) prompt.placeholder = hasAvatar
      ? 'Например: добавь круглые очки или сделай шарф красным.'
      : 'Кто это? Как выглядит? Где находится? Например: добрый робот-садовник на зелёной планете.';
    if (hint) hint.textContent = hasAvatar
      ? 'Опиши одну-две детали. Текущий герой останется основой новой версии.'
      : 'Добавь: кто это, как выглядит и где находится. Не пиши личные данные.';
    if (modeHint) modeHint.textContent = hasAvatar
      ? 'Опиши, что хочешь изменить в текущем герое.'
      : 'Выбери идею для старта или напиши свою.';
    if (themes) themes.classList.toggle('hidden', hasAvatar);
  }
  function progressCopy(percent) {
    if (percent >= 100) return 'Готово!';
    if (percent >= 99) return 'Ещё чуть-чуть';
    if (percent >= 78) return 'Почти готово';
    if (percent >= 42) return 'Добавляем детали';
    return 'Собираем образ';
  }
  function renderGenerationProgress(percent) {
    const progress = Math.max(0, Math.min(100, percent));
    const roundedProgress = Math.round(progress);
    const track = $('generationProgress')?.querySelector('[role="progressbar"]');
    const fill = $('generationProgressFill');
    const bot = $('generationProgress')?.querySelector('.generation-bot');
    const value = $('generationProgressPercent');
    const copy = $('generationProgressCopy');
    if (!track || !fill || !value || !copy) return;
    currentGenerationProgress = progress;
    track.setAttribute('aria-valuenow', String(roundedProgress));
    fill.style.width = `${progress}%`;
    if (bot) bot.style.left = `${progress}%`;
    value.textContent = `${roundedProgress}%`;
    copy.textContent = progressCopy(roundedProgress);
  }
  function cancelProgressFrame() {
    if (!progressFrame) return;
    clearTimeout(progressFrame);
    clearInterval(progressFrame);
    progressFrame = null;
  }
  function stopEstimatedProgress({ success = false } = {}) {
    cancelProgressFrame();
    if (!$('generationProgress')) return Promise.resolve();
    if (!success) {
      $('generationProgress').classList.add('hidden');
      renderGenerationProgress(0);
      return Promise.resolve();
    }
    const started = performance.now();
    const from = currentGenerationProgress;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    return new Promise((resolve) => {
      const finish = (now) => {
      const ratio = reducedMotion ? 1 : Math.min(1, (now - started) / 1000);
      renderGenerationProgress(from + (100 - from) * ratio);
      if (ratio < 1) progressFrame = setTimeout(() => finish(performance.now()), 40);
      else {
        progressFrame = null;
        setTimeout(() => {
          $('generationProgress').classList.add('hidden');
          renderGenerationProgress(0);
          resolve();
        }, 90);
      }
      };
      progressFrame = setTimeout(() => finish(performance.now()), 40);
    });
  }
  function startEstimatedProgress() {
    cancelProgressFrame();
    progressEstimateMs = readGenerationEstimate();
    progressStartedAt = Date.now();
    $('generationProgress').classList.remove('hidden');
    renderGenerationProgress(0);
    const tick = () => {
      const elapsed = Math.max(0, Date.now() - progressStartedAt);
      const expected = Math.max(1000, progressEstimateMs);
      const ratio = elapsed / expected;
      let percent;
      if (ratio <= 1) percent = 90 * ratio;
      else if (ratio <= 1.5) percent = 90 + 5 * ((ratio - 1) / 0.5);
      else percent = 95 + 8 * Math.min(0.5, (ratio - 1.5));
      renderGenerationProgress(Math.min(98.8, percent));
    };
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    progressFrame = setInterval(tick, reducedMotion ? 500 : 120);
  }

  async function api(url, options = {}, requestTimeoutMs = 100000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(url, { headers: { 'content-type': 'application/json' }, ...options, signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(body.error || 'Что-то пошло не так. Попробуй ещё раз.');
        error.status = response.status;
        error.code = body.code;
        error.retryAfterMs = body.retryAfterMs ?? body.generationPolicy?.retryAfterMs;
        error.generationPolicy = body.generationPolicy;
        throw error;
      }
      return body;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Сервер отвечает слишком долго. Попробуй ещё раз.');
      if (error instanceof TypeError) throw new Error('Нет связи с сервером. Проверь интернет и попробуй ещё раз.');
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function busy(button, value) {
    button.classList.toggle('is-loading', value);
    if (value) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  }
  function message(id, text, tone = '') { $(id).textContent = text; $(id).dataset.tone = tone; }
  function friendlyError(error, fallback = 'Не получилось. Попробуй ещё раз.') {
    if (error?.code === 'COOLDOWN') return 'Подожди немного перед следующей попыткой.';
    if (error?.code === 'RATE_LIMIT') return 'Сервис сейчас занят. Подожди немного и попробуй ещё раз.';
    if (error?.code === 'TIMEOUT') return 'Генерация заняла больше времени. Попробуй ещё раз.';
    if (error?.code === 'NETWORK') return 'Не удалось связаться с сервисом генерации. Попробуй ещё раз.';
    if (error?.code === 'PROVIDER_ERROR') return 'Сервис генерации временно недоступен. Попробуй ещё раз.';
    if (error?.code === 'CONTENT_REJECT') return 'Попробуй описать героя иначе, без неподходящих деталей.';
    if (error?.code === 'AUTH') return 'Сервис генерации сейчас не настроен. Позови ведущего.';
    if (error?.code === 'INTEGRATION_ERROR') return 'Сервис генерации сейчас не смог обработать технические параметры запроса. Попробуй ещё раз чуть позже.';
    if (error?.code === 'CLIENT_ERROR') return 'Сервис не принял описание. Попробуй изменить его и повторить.';
    if (error?.code === 'EDIT_UNSUPPORTED') return 'Улучшение сейчас недоступно. Можно опубликовать текущую версию.';
    if (['INVALID_RESPONSE', 'NO_IMAGE', 'INVALID_IMAGE', 'IMAGE_DOWNLOAD', 'IMAGE_TOO_LARGE'].includes(error?.code)) return 'Сервис не вернул готовое изображение. Попробуй ещё раз.';
    if (error?.code === 'GENERATION_LIMIT') return 'Попытки для этого участника закончились.';
    if (error?.code === 'DEMO_QUOTA_EXHAUSTED' || error?.code === 'DEMO_QUOTA_UNAVAILABLE') return error.message;
    if (error?.status >= 500 || /(?:api|provider|temporary|network|internal|http \d{3})/i.test(error?.message || '')) return fallback;
    return error?.message || fallback;
  }
  function setStep(active) {
    ['Login', 'Create', 'Gallery'].forEach((name, index) => {
      const item = $('stage' + name);
      if (!item) return;
      item.classList.toggle('is-current', index === active);
      item.classList.toggle('is-done', index < active);
      if (index === active) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
  }
  function showWorkspaceSection(section) {
    const gallery = section === 'gallery';
    $('showCreate').classList.toggle('is-current', !gallery);
    $('showGallery').classList.toggle('is-current', gallery);
    if (!gallery) $('showCreate').setAttribute('aria-current', 'page');
    else $('showCreate').removeAttribute('aria-current');
    if (gallery) $('showGallery').setAttribute('aria-current', 'page');
    else $('showGallery').removeAttribute('aria-current');
    setStep(gallery ? 2 : 1);
    const target = gallery ? $('gallerySection') : $('createSection');
    if (target && document.visibilityState !== 'hidden') {
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    }
  }
  let quotaBlocksGeneration = true;
  let quotaRequest = 0;
  async function refreshQuota() {
    const request = ++quotaRequest;
    let quota;
    try {
      ({ quota } = await api('/api/generation-quota', {}, 4000));
    } catch { /* Keep generation disabled while the server budget is unknown. */ }
    if (request !== quotaRequest) return;
    const progress = $('betaQuotaProgress');
    $('betaQuota').classList.toggle('hidden', quota === null);
    quotaBlocksGeneration = quota !== null && !quota?.remaining;
    if (quota) {
      progress.max = Math.max(1, quota.total);
      progress.value = quota.remaining;
    } else {
      progress.removeAttribute('value');
    }
    const status = quota
      ? (quota.remaining ? `Доступно генераций: ${quota.remaining} из ${quota.total}` : 'Лимит бесплатных генераций в тестовой версии исчерпан')
      : 'Не удалось проверить остаток генераций.';
    if ($('betaQuotaCount').textContent !== status) $('betaQuotaCount').textContent = status;
    updateControls();
  }
  function updateControls() {
    const running = generating || publishing;
    const canWrite = !running && !published;
    const coolingDown = Date.now() < cooldownUntil;
    $('generate').disabled = !canWrite || quotaBlocksGeneration || coolingDown || !$('prompt').value.trim();
    $('publish').disabled = running || published || !generationId;
    $('newHero').disabled = running;
    $('newSession').disabled = running;
    $('showCreate').disabled = running;
    $('showGallery').disabled = running;
    $('prompt').readOnly = !canWrite;
    document.querySelectorAll('[data-prompt]').forEach((button) => { button.disabled = !canWrite; });
    $('generate').textContent = generating ? (generationId ? 'Улучшаем аватар…' : 'Создаём аватар…') : (generationId ? 'Улучшить аватар' : 'Создать аватар');
    $('publish').textContent = publishing ? 'Публикуем…' : published ? 'Опубликовано' : 'Опубликовать в галерее';
    updatePromptMode();
    busy($('generate'), generating);
    busy($('publish'), publishing);
    if (coolingDown) {
      const seconds = Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 1000));
      $('attemptLabel').textContent = `Следующая попытка через ${seconds} с`;
    } else {
      $('attemptLabel').textContent = generationCount ? 'Можно создать новую версию' : 'Сделай первую версию';
    }
  }
  function startCooldown(milliseconds) {
    const duration = Number(milliseconds);
    if (!Number.isFinite(duration) || duration <= 0) return;
    cooldownUntil = Math.max(cooldownUntil, Date.now() + duration);
    if (cooldownTimer) clearInterval(cooldownTimer);
    cooldownTimer = setInterval(() => {
      if (Date.now() >= cooldownUntil) {
        clearInterval(cooldownTimer);
        cooldownTimer = null;
        cooldownUntil = 0;
        updateControls();
        return;
      }
      updateControls();
    }, 250);
    updateControls();
  }
  function galleryKey(works) { return works.map((work) => `${work.id}:${work.likes}:${work.createdAt || ''}`).join('|'); }
  function showWorkspace(nickname, snapshot = null) {
    $('login').classList.add('hidden');
    $('workspace').classList.remove('hidden');
    $('who').textContent = nickname;
    showWorkspaceSection('create');
    if (snapshot) restoreSnapshot(snapshot);
    updateControls();
    startGalleryPolling();
    loadGallery();
    loadProviderNotice();
  }
  async function loadProviderNotice() {
    const notice = $('mockNotice');
    notice.classList.add('hidden');
    try {
      const health = await api('/api/health');
      notice.classList.toggle('hidden', String(health.provider || '').toLowerCase() !== 'mock');
    } catch {
      // Provider details are optional for participants; keep the notice hidden
      // if the health endpoint is unavailable.
    }
  }
  function restoreSnapshot(snapshot) {
    generationCount = Number(snapshot?.generationCount || 0);
    likedWorks.clear();
    (snapshot?.likedWorkIds || []).forEach((id) => likedWorks.add(id));
    ownedWorks.clear();
    (snapshot?.ownedWorkIds || []).forEach((id) => ownedWorks.add(id));
    const latest = snapshot?.latestGeneration;
    const savedWork = snapshot?.work;
    const avatarSource = latest?.imageUrl || latest?.imageData;
    if (latest?.id && avatarSource) {
      generationId = latest.id;
      generatedPrompt = latest.prompt || '';
      // Keep the restored image, but leave the field ready for a new edit instruction.
      $('prompt').value = '';
      $('avatar').src = avatarSource;
      $('previewPlaceholder').classList.add('hidden');
      $('result').classList.remove('hidden');
      $('previewLabel').textContent = 'Версия ' + String(generationCount || 1).padStart(2, '0');
      message('generationState', savedWork?.status === 'published'
        ? 'Работа уже опубликована.'
        : `Версия ${String(generationCount || 1).padStart(2, '0')} восстановлена. Можно улучшить её или опубликовать.`, savedWork?.status === 'published' ? 'success' : '');
      const provider = latest.provider || snapshot?.provider;
      $('mockNotice').classList.toggle('hidden', provider !== 'mock');
    }
    if (savedWork?.id) {
      workId = savedWork.id;
      published = savedWork.status === 'published';
    }
    if (published) showWorkspaceSection('gallery');
    updateControls();
    if (snapshot?.generationPolicy?.retryAfterMs > 0) startCooldown(snapshot.generationPolicy.retryAfterMs);
  }
  async function restore() {
    if (!sessionId) return;
    $('start').disabled = true;
    $('nickname').disabled = true;
    busy($('start'), true);
    try {
      const session = await api('/api/sessions/' + sessionId + '?format=compact');
      if (session.participantId && participantIdPattern.test(session.participantId)) {
        participantId = session.participantId;
        localStorage.setItem(participantStorageKey, participantId);
      }
      showWorkspace(session.nickname, session);
    } catch (error) {
      if (error.status === 404) { localStorage.removeItem('avatarSessionId'); sessionId = null; }
      else message('loginError', 'Не удалось вернуться в мастерскую. Проверь связь и обнови страницу.');
    } finally {
      busy($('start'), false);
      $('nickname').disabled = false;
      $('start').disabled = !$('nickname').value.trim();
    }
  }
  $('nickname').addEventListener('input', () => {
    $('start').disabled = !$('nickname').value.trim();
    message('loginError', '');
  });
  $('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if ($('start').disabled) return;
    message('loginError', '');
    $('start').disabled = true;
    $('nickname').disabled = true;
    $('start').textContent = 'Входим…';
    busy($('start'), true);
    try {
      const session = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ nickname: $('nickname').value, participantId }) });
      sessionId = session.id;
      if (session.participantId && participantIdPattern.test(session.participantId)) {
        participantId = session.participantId;
        localStorage.setItem(participantStorageKey, participantId);
      }
      localStorage.setItem('avatarSessionId', sessionId);
      showWorkspace(session.nickname);
    } catch (error) { message('loginError', error.message); }
    finally {
      busy($('start'), false);
      $('nickname').disabled = false;
      $('start').disabled = !$('nickname').value.trim();
      $('start').textContent = 'Войти в мастерскую';
    }
  });
  $('newSession').onclick = () => { localStorage.removeItem('avatarSessionId'); location.reload(); };
  $('showCreate').onclick = () => { if (!$('showCreate').disabled) showWorkspaceSection('create'); };
  $('showGallery').onclick = () => { if (!$('showGallery').disabled) showWorkspaceSection('gallery'); };
  $('newHero').onclick = async () => {
    if (generating || publishing) return;
    if (!published && generationId && !window.confirm('Текущий аватар останется в прежней сессии, но из мастерской к нему уже не получится вернуться. Незавершённое изменение сбросится. Создать нового героя?')) return;
    const button = $('newHero');
    busy(button, true);
    button.disabled = true;
    try {
      const next = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ nickname: $('who').textContent, participantId }) });
      sessionId = next.id;
      if (next.participantId && participantIdPattern.test(next.participantId)) {
        participantId = next.participantId;
        localStorage.setItem(participantStorageKey, participantId);
      }
      localStorage.setItem('avatarSessionId', sessionId);
      location.reload();
    } catch (error) {
      message('workState', friendlyError(error, 'Не получилось начать нового героя. Попробуй ещё раз.'), 'error');
      busy(button, false);
      button.disabled = false;
    }
  };
  $('prompt').addEventListener('input', () => {
    updateControls();
    message('genError', '');
    if (!generationCount) message('generationState', $('prompt').value.trim() ? 'Описание готово. Можно создавать аватар.' : 'Напиши описание, чтобы начать.');
    else message('generationState', $('prompt').value.trim() ? 'Инструкция готова. Можно улучшить аватар.' : 'Опиши, что изменить, или опубликуй текущую версию.');
  });
  document.querySelectorAll('[data-prompt]').forEach((button) => {
    button.onclick = () => {
      $('prompt').value = button.dataset.prompt;
      $('prompt').dispatchEvent(new Event('input'));
      $('prompt').focus();
    };
  });
  $('generate').onclick = async () => {
    if ($('generate').disabled || generating || publishing) return;
    generating = true;
    const prompt = $('prompt').value;
    message('genError', '');
    message('workState', '');
    message('generationState', generationId ? 'Меняем детали героя. Оставь страницу открытой.' : 'Создаём персонажа. Оставь страницу открытой.');
    $('previewLabel').textContent = generationId ? 'Обновляется…' : 'Создаётся…';
    if (!generationId) {
      $('previewPlaceholder').classList.add('hidden');
      $('result').classList.add('hidden');
    } else {
      $('result').classList.remove('hidden');
    }
    startEstimatedProgress();
    updateControls();
    const slowTimer = setTimeout(() => { message('generationState', 'ИИ нужно ещё немного времени. Повторно нажимать не нужно.'); }, 12000);
    try {
      // A generation may contain two provider attempts plus a fallback. Keep
      // this request open longer than the provider chain so the UI never
      // reports a false final timeout while the backend still holds its lock.
      const result = await api('/api/generate', { method: 'POST', body: JSON.stringify({ sessionId, prompt }) }, 300000);
      if (String(result.provider || '').toLowerCase() !== 'mock') rememberGenerationDuration(result.durationMs);
      await stopEstimatedProgress({ success: true });
      generationId = result.id;
      generatedPrompt = prompt;
      workId = null;
      generationCount += 1;
      $('avatar').src = result.imageData;
      $('previewPlaceholder').classList.add('hidden');
      $('result').classList.remove('hidden');
      $('previewLabel').textContent = 'Версия ' + String(generationCount).padStart(2, '0');
      // After a successful version, the field is for the next edit instruction.
      $('prompt').value = '';
      message('generationState', 'Текущая версия сохранена. Можно улучшить её или опубликовать.', 'success');
      $('mockNotice').classList.toggle('hidden', result.provider !== 'mock');
      // A fallback keeps the same progress animation; only the neutral
      // status copy changes while the server tries the last allowed attempt.
      if (result.generationPolicy?.cooldownMs) startCooldown(result.generationPolicy.cooldownMs);
    } catch (error) {
      await stopEstimatedProgress();
      if (error.retryAfterMs > 0) startCooldown(error.retryAfterMs);
      message('genError', friendlyError(error, 'Не получилось создать аватар. Попробуй ещё раз.'));
      $('previewLabel').textContent = generationId ? 'Предыдущая версия сохранена' : 'Место для идеи';
      if (generationId) {
        $('result').classList.remove('hidden');
      } else {
        $('previewPlaceholder').classList.remove('hidden');
      }
      const quotaBlocked = error.code === 'DEMO_QUOTA_EXHAUSTED' || error.code === 'DEMO_QUOTA_UNAVAILABLE';
      if (quotaBlocked) {
        message('generationState', generationId ? 'Предыдущая версия сохранена. Её можно опубликовать.' : 'Обратись к ведущему.');
      } else {
        message('generationState', generationId ? 'Предыдущая версия сохранена. Измени описание или опубликуй её.' : 'Попробуй ещё раз с более подробным описанием.');
      }
    } finally {
      clearTimeout(slowTimer);
      await refreshQuota();
      generating = false;
      updateControls();
    }
  };
  $('publish').onclick = async () => {
    if ($('publish').disabled || publishing || generating || !generationId) return;
    publishing = true;
    updateControls();
    message('workState', 'Отправляем работу в общую галерею…');
    try {
      if (!workId) {
        const draft = await api('/api/works', { method: 'POST', body: JSON.stringify({ sessionId, generationId, prompt: generatedPrompt }) });
        workId = draft.id;
      }
      const publishedResult = await api('/api/works/' + workId + '/publish?format=compact', { method: 'POST', body: JSON.stringify({ sessionId }) });
      published = true;
      if (publishedResult.work) {
        publicationRevision += 1;
        optimisticWorks.set(publishedResult.work.id, publishedResult.work);
        optimisticRevisions.set(publishedResult.work.id, publicationRevision);
        galleryData.set(publishedResult.work.id, publishedResult.work);
        renderGallery([], { replace: false });
      }
      message('workState', 'Готово! Работа в галерее. Посмотри, что создали другие.', 'success');
      message('generationState', 'Твоя работа опубликована.', 'success');
      showWorkspaceSection('gallery');
      loadGallery({ silent: true });
    } catch (error) { message('workState', friendlyError(error, 'Не получилось опубликовать работу. Попробуй ещё раз.'), 'error'); }
    finally { publishing = false; updateControls(); }
  };
  function renderWork(work) {
    const tile = document.createElement('article');
    tile.className = 'tile';
    tile.dataset.workId = work.id;
    const image = document.createElement('img');
    image.alt = 'Аватар участника ' + work.nickname;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.src = work.imageUrl || work.imageData;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('b');
    name.textContent = work.nickname;
    const like = document.createElement('button');
    like.type = 'button';
    like.className = 'like';
    const heart = document.createElement('span');
    heart.className = 'heart';
    heart.setAttribute('aria-hidden', 'true');
    heart.textContent = '♡';
    const count = document.createElement('span');
    count.textContent = work.likes;
    like.append(heart, count);
    const own = work.id === workId || ownedWorks.has(work.id);
    like.disabled = own || likedWorks.has(work.id);
    like.classList.toggle('liked', likedWorks.has(work.id));
    if (likedWorks.has(work.id)) heart.textContent = '♥';
    like.setAttribute('aria-label', own ? 'Твоя работа, лайков: ' + work.likes : likedWorks.has(work.id) ? 'Лайк поставлен. Всего: ' + work.likes : 'Поставить лайк работе участника ' + work.nickname + '. Лайков: ' + work.likes);
    like.onclick = async () => {
      if (like.disabled) return;
      likeBusyWorks.add(work.id);
      like.disabled = true;
      busy(like, true);
      message('galleryMessage', '');
      try {
        const result = await api('/api/works/' + work.id + '/like', { method: 'POST', body: JSON.stringify({ sessionId, participantId }) });
        count.textContent = result.likes;
        heart.textContent = '♥';
        likedWorks.add(work.id);
        like.classList.add('liked');
        like.setAttribute('aria-label', 'Лайк поставлен. Всего: ' + result.likes);
        message('galleryMessage', 'Лайк поставлен.', 'success');
      } catch (error) {
        const duplicate = error.status === 409;
        if (duplicate) {
          likedWorks.add(work.id);
          heart.textContent = '♥';
          like.classList.add('liked');
          like.setAttribute('aria-label', 'Лайк уже поставлен');
        }
        like.disabled = duplicate || error.status === 403;
        message('galleryMessage', friendlyError(error, 'Не получилось поставить лайк. Попробуй ещё раз.'), 'error');
      } finally {
        busy(like, false);
        likeBusyWorks.delete(work.id);
        like.disabled = work.id === workId || likedWorks.has(work.id);
      }
    };
    meta.append(name, like);
    tile.append(image, meta);
    return tile;
  }
  function updateGalleryTile(tile, work) {
    const like = tile.querySelector('.like');
    const count = like?.querySelector('span:last-child');
    const heart = like?.querySelector('.heart');
    const liked = likedWorks.has(work.id);
    const own = work.id === workId || ownedWorks.has(work.id);
    if (count) count.textContent = work.likes;
    if (heart && liked) heart.textContent = '♥';
    if (like) {
      like.disabled = own || liked || likeBusyWorks.has(work.id);
      like.classList.toggle('liked', liked);
      like.setAttribute('aria-label', own ? 'Твоя работа, лайков: ' + work.likes : liked ? 'Лайк поставлен. Всего: ' + work.likes : 'Поставить лайк работе участника ' + work.nickname + '. Лайков: ' + work.likes);
    }
  }
  function renderGallery(works, { replace = true } = {}) {
    if (replace) galleryData.clear();
    works.forEach((work) => galleryData.set(work.id, work));
    const visibleWorks = [...galleryData.values()];
    const knownIds = new Set(visibleWorks.map((work) => work.id));
    optimisticWorks.forEach((work, id) => { if (!knownIds.has(id)) visibleWorks.push(work); });
    const box = $('gallery');
    const ids = new Set(visibleWorks.map((work) => work.id));
    galleryNodes.forEach((node, id) => {
      if (!ids.has(id)) { node.remove(); galleryNodes.delete(id); }
    });
    visibleWorks.forEach((work, index) => {
      let node = galleryNodes.get(work.id);
      if (!node) { node = renderWork(work); galleryNodes.set(work.id, node); }
      else updateGalleryTile(node, work);
      const nextKnown = visibleWorks.slice(index + 1).find((item) => galleryNodes.has(item.id));
      const anchor = nextKnown ? galleryNodes.get(nextKnown.id) : null;
      // Avoid moving an existing node on every poll. Besides reducing layout
      // work, this keeps an active like button's keyboard focus intact.
      if (!node.isConnected || node.nextElementSibling !== anchor) box.insertBefore(node, anchor);
    });
    $('galleryEmpty').classList.toggle('hidden', visibleWorks.length > 0);
    $('galleryCount').textContent = String(visibleWorks.length).padStart(2, '0');
  }
  async function loadGallery({ silent = false } = {}) {
    if (galleryLoading) return;
    const requestPublicationRevision = publicationRevision;
    galleryLoading = true;
    $('gallery').setAttribute('aria-busy', 'true');
    if (!silent) message('galleryMessage', '');
    try {
      const { works } = await api('/api/gallery?format=compact');
      const serverIds = new Set(works.map((work) => work.id));
      optimisticWorks.forEach((work, id) => {
        if (serverIds.has(id) || requestPublicationRevision >= Number(optimisticRevisions.get(id) || 0)) {
          optimisticWorks.delete(id);
          optimisticRevisions.delete(id);
        }
      });
      const signature = galleryKey(works);
      if (signature !== gallerySignature) {
        renderGallery(works);
        gallerySignature = signature;
      }
    } catch (error) { if (!silent) message('galleryMessage', friendlyError(error, 'Не удалось обновить галерею. Проверь связь и попробуй ещё раз.'), 'error'); }
    finally {
      galleryLoading = false;
      $('gallery').removeAttribute('aria-busy');
    }
  }
  function startGalleryPolling() {
    if (galleryPollTimer) clearInterval(galleryPollTimer);
    galleryPollTimer = setInterval(() => {
      if (!document.hidden) loadGallery({ silent: true });
    }, 7000);
  }
  restore();
  refreshQuota();
  setInterval(() => { if (!document.hidden && sessionId) refreshQuota(); }, 7000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshQuota(); });
})();

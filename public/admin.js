(() => {
  const $ = (id) => document.getElementById(id);
  const records = new Map();
  const pollIntervalMs = 7000;
  let token = '';
  let authorized = false;
  let loading = false;
  let visibleLoading = false;
  let actionBusy = false;
  let hasSnapshot = false;
  let revision = 0;
  let refreshPending = false;
  let statusSnapshot = null;
  let queueSnapshot = null;
  let pollingFailureStreak = 0;
  let developerSession = null;
  let developerVersion = 0;
  let developerBusy = false;

  function text(node, value) {
    const next = String(value ?? '');
    if (node.textContent !== next) node.textContent = next;
  }
  function setState(id, value, tone = '') {
    const node = typeof id === 'string' ? $(id) : id;
    text(node, value);
    node.dataset.tone = tone;
  }
  function setBusy(button, busy) {
    button.classList.toggle('is-loading', busy);
    if (busy) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  }
  function updateControls() {
    $('load').disabled = loading || actionBusy || developerBusy || !$('token').value.trim();
    $('token').disabled = visibleLoading || actionBusy || developerBusy;
    $('refresh').disabled = !authorized || loading || actionBusy;
    $('developerGenerate').disabled = !authorized || developerBusy || !statusSnapshot?.developerQuota?.remaining
      || !$('developerPrompt').value.trim() || $('developerPrompt').readOnly;
    $('developerReset').disabled = !authorized || developerBusy || !developerSession;
    records.forEach(({ refs, work }) => {
      refs.toggle.disabled = !authorized || actionBusy || work.status === 'draft';
      refs.remove.disabled = !authorized || actionBusy;
    });
  }
  async function call(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        headers: { 'x-admin-token': token, 'content-type': 'application/json', ...(options.headers || {}) },
        signal: controller.signal,
      });
      if (response.status === 204) return {};
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(response.status === 401 ? 'Введите правильный код ведущего.'
          : response.status >= 500 ? 'Сервер не ответил. Попробуйте ещё раз.'
            : body?.error || 'Не получилось выполнить действие. Попробуйте ещё раз.');
        error.status = response.status;
        throw error;
      }
      if (!body || typeof body !== 'object') throw new Error('Не удалось прочитать ответ сервера. Попробуйте обновить данные.');
      return body;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Сервер отвечает слишком долго. Попробуйте ещё раз.');
      if (error instanceof TypeError) throw new Error('Нет связи с сервером. Проверьте подключение.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function cardValue(name, value, tone = '') {
    const card = document.querySelector(`[data-card="${name}"]`);
    text(card.querySelector('.stat-value'), value);
    card.dataset.tone = tone;
  }
  function markStatus(state) {
    document.querySelectorAll('.status-card').forEach((card) => { card.dataset.state = state; });
  }
  function formatDuration(milliseconds) {
    if (milliseconds === null || milliseconds === undefined || milliseconds === '') return '—';
    const value = Number(milliseconds);
    if (!Number.isFinite(value) || value < 0) return '—';
    return value < 1000 ? `${Math.round(value)} мс` : `${(value / 1000).toFixed(1).replace('.', ',')} с`;
  }
  function formatDate(value) {
    if (!value) return 'время не сохранено';
    const raw = String(value);
    const date = new Date(/Z|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
    return Number.isNaN(date.getTime()) ? 'время не сохранено'
      : new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }
  const statusLabel = (status) => ({ published: 'Опубликовано', hidden: 'Скрыто', draft: 'Черновик' }[status] || 'Без статуса');
  const providerLabel = (value) => ({ mock: 'Mock', http: 'Внешний API' }[String(value || '').toLowerCase()] || value || 'Не указан');
  function worksLabel(count) {
    if (count % 10 === 1 && count % 100 !== 11) return `${count} работа`;
    if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) return `${count} работы`;
    return `${count} работ`;
  }
  function renderStatus(status, queue) {
    const quota = status.developerQuota;
    $('developer-panel').classList.toggle('hidden', !quota);
    text($('developerQuota'), quota ? `Использовано: ${quota.used} из ${quota.total}. Доступно: ${quota.remaining}.` : '');
    const counts = Array.isArray(status.counts) ? status.counts : [];
    const count = (name) => Number(counts.find((item) => item.status === name)?.count || 0);
    // The status endpoint confirms that the application answered. It does not
    // probe the external image provider, so keep this wording deliberately
    // narrow and avoid presenting provider availability as healthy.
    cardValue('backend', status.ok ? 'Ответ получен' : 'Нет ответа', status.ok ? 'success' : 'error');
    cardValue('provider', providerLabel(status.providerLabel || status.provider));
    cardValue('active', queue ? String(queue.pending ?? 0) : '—');
    cardValue('published', String(count('published')));
    cardValue('hidden', String(count('hidden')));
    cardValue('average', formatDuration(status.generationMetrics?.averageMs));
    const primaryHealth = status.primaryHealth || {};
    const healthState = String(primaryHealth.state || 'healthy');
    markStatus('ok');
    const pool = Array.isArray(status.generationModels) ? status.generationModels : [];
    const lastInfo = status.lastGeneration?.model ? `Последняя генерация: ${status.lastGeneration.model}${status.lastGeneration.fallbackUsed ? ' (переключение)' : ''}` : '';
    const modelInfo = pool.length
      ? `Модели: ${pool.map((item) => `${item.model} (${item.state}${item.state === 'unhealthy' ? `, ${Number(item.retryAfterSec || 0)} с` : ''})`).join(', ')}`
      : (status.model ? `Основная модель: ${status.model}${status.fallbackModel ? `; резервная модель: ${status.fallbackModel}` : ''}` : '');
    const healthInfo = healthState === 'unhealthy'
      ? `Основная модель: пауза (${Number(primaryHealth.retryAfterSec || 0)} с до проверки)`
      : healthState === 'half_open' ? 'Основная модель: повторная проверка' : 'Основная модель: работает';
    text(document.querySelector('[data-card="provider"] .hint'), [modelInfo, lastInfo, healthInfo].filter(Boolean).join('; ') || (String(status.provider).toLowerCase() === 'mock'
      ? 'Тестовый режим без внешнего API' : 'Выбранная настройка; доступность API не проверяется'));
    text($('debug'), JSON.stringify({ status, queue }, null, 2));
  }
  function updateWork(record, work) {
    record.work = work;
    const { refs } = record;
    const source = work.imageData || work.image_data;
    const imageData = typeof source === 'string' && /^data:image\/(?:png|jpe?g|webp|gif|svg\+xml);base64,/i.test(source) ? source : '';
    if (imageData && refs.image.getAttribute('src') !== imageData) {
      refs.image.src = imageData;
      refs.image.classList.remove('is-missing');
    } else if (!imageData) {
      refs.image.removeAttribute('src');
      refs.image.classList.add('is-missing');
    }
    refs.image.alt = imageData ? `Аватар участника ${work.nickname || ''}` : 'Изображение не загрузилось';
    text(refs.name, work.nickname || 'Без ника');
    text(refs.state, statusLabel(work.status));
    refs.state.dataset.status = work.status || '';
    text(refs.likes, `Лайки: ${Number(work.likes ?? 0)}`);
    const publishedAt = work.publishedAt || work.published_at;
    text(refs.date, publishedAt ? `Опубликовано: ${formatDate(publishedAt)}`
      : `Создано: ${formatDate(work.createdAt || work.created_at)} · время публикации не сохранено`);
    text(refs.toggle, work.status === 'hidden' ? 'Показать' : 'Скрыть');
    refs.toggle.title = work.status === 'draft' ? 'Черновик ещё не опубликован участником' : '';
    // `prompt` remains the backwards-compatible user description. Newer
    // responses may expose it explicitly as `userPrompt`; prefer that field
    // when present. The complete prompt assembled by the server is kept in a
    // separate, collapsed technical block so it is never shown as the main
    // workshop content.
    text(refs.prompt, work.userPrompt || work.prompt || 'Описание не сохранено');
    text(refs.finalPrompt, work.finalPrompt || work.final_prompt || 'Итоговый prompt не сохранён');
    refs.technical.hidden = !(work.finalPrompt || work.final_prompt);
  }
  function createWork(work) {
    const node = document.createElement('article');
    node.className = 'admin-work';
    node.dataset.workId = work.id;
    const element = (tag, className) => { const result = document.createElement(tag); result.className = className; return result; };
    const image = element('img', 'work-image');
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => {
      image.classList.add('is-missing');
      image.removeAttribute('src');
      image.alt = 'Изображение не загрузилось';
    });
    const body = element('div', 'work-body');
    const heading = element('div', 'work-heading');
    const name = document.createElement('h3');
    const state = element('span', 'work-status');
    heading.append(name, state);
    const facts = element('div', 'work-facts');
    const likes = document.createElement('span');
    const date = document.createElement('span');
    facts.append(likes, document.createElement('br'), date);
    const actions = element('div', 'work-actions');
    const toggle = element('button', 'secondary');
    const remove = element('button', 'danger');
    toggle.type = remove.type = 'button';
    remove.textContent = 'Удалить';
    const actionState = element('span', 'state');
    actionState.setAttribute('role', 'status');
    actions.append(toggle, remove, actionState);
    const details = element('details', 'work-details');
    const summary = document.createElement('summary');
    summary.textContent = 'Подробнее';
    const promptLabel = element('span', 'prompt-label');
    promptLabel.textContent = 'Описание участника';
    const prompt = element('p', 'prompt-text');
    details.append(summary, promptLabel, prompt);
    const technical = element('details', 'work-technical');
    const technicalSummary = document.createElement('summary');
    technicalSummary.textContent = 'Технические детали';
    const finalPrompt = element('p', 'final-prompt-text');
    finalPrompt.setAttribute('aria-label', 'Итоговый prompt для AI-провайдера');
    technical.append(technicalSummary, finalPrompt);
    body.append(heading, facts, actions, details, technical);
    node.append(image, body);
    const record = { node, work, refs: { image, name, state, likes, date, toggle, remove, actionState, prompt, technical, finalPrompt } };
    toggle.addEventListener('click', () => runAction(record, 'toggle'));
    remove.addEventListener('click', () => runAction(record, 'delete'));
    updateWork(record, work);
    return record;
  }
  function renderWorks(works) {
    const box = $('works');
    const ids = new Set(works.map((work) => work.id));
    records.forEach((record, id) => {
      if (!ids.has(id)) { record.node.remove(); records.delete(id); }
    });
    // Keep existing nodes in place so open details and keyboard focus survive polling.
    works.forEach((work, index) => {
      const existing = records.get(work.id);
      if (existing) updateWork(existing, work);
      else {
        const record = createWork(work);
        records.set(work.id, record);
        const nextKnown = works.slice(index + 1).find((item) => records.has(item.id));
        box.insertBefore(record.node, nextKnown ? records.get(nextKnown.id).node : null);
      }
    });
    let empty = box.querySelector('.empty-state');
    if (works.length) empty?.remove();
    else {
      if (!empty) { empty = document.createElement('p'); empty.className = 'empty-state'; box.append(empty); }
      text(empty, 'Работ пока нет. Они появятся здесь автоматически.');
    }
    text($('works-count'), worksLabel(works.length));
    updateControls();
  }
  function lockPanel() {
    authorized = false;
    token = '';
    revision += 1;
    refreshPending = false;
    statusSnapshot = queueSnapshot = null;
    pollingFailureStreak = 0;
    hasSnapshot = false;
    records.forEach((record) => record.node.remove());
    records.clear();
    $('status-panel').classList.add('hidden');
    $('works-panel').classList.add('hidden');
    $('developer-panel').classList.add('hidden');
    resetDeveloper();
    text($('debug'), 'Данные появятся после входа.');
    setState('msg', 'Код не подошёл или доступ изменился. Введите код ведущего ещё раз.', 'error');
    updateControls();
  }
  async function runAction(record, action) {
    if (!authorized || actionBusy || (action === 'toggle' && record.work.status === 'draft')) return;
    if (action === 'delete' && !window.confirm(`Удалить работу участника «${record.work.nickname || 'без ника'}»? Это нельзя отменить.`)) return;
    actionBusy = true;
    revision += 1;
    const button = action === 'delete' ? record.refs.remove : record.refs.toggle;
    setBusy(button, true);
    updateControls();
    setState(record.refs.actionState, action === 'delete' ? 'Удаляем…' : 'Сохраняем…');
    try {
      const result = await call(`/api/admin/works/${encodeURIComponent(record.work.id)}`, action === 'delete'
        ? { method: 'DELETE' }
        : { method: 'PATCH', body: JSON.stringify({ hidden: record.work.status !== 'hidden' }) });
      const previousStatus = record.work.status;
      const nextStatus = action === 'delete' ? null : result.status || (previousStatus === 'hidden' ? 'published' : 'hidden');
      if (action === 'delete') {
        record.node.remove();
        records.delete(record.work.id);
        renderWorks([...records.values()].map((item) => item.work));
        setState('works-state', 'Работа удалена.', 'success');
      } else {
        updateWork(record, { ...record.work, status: nextStatus });
        setState(record.refs.actionState, nextStatus === 'hidden' ? 'Работа скрыта из галереи.' : 'Работа снова в галерее.', 'success');
      }
      if (statusSnapshot) {
        if (!Array.isArray(statusSnapshot.counts)) statusSnapshot.counts = [];
        for (const status of [previousStatus, nextStatus].filter(Boolean)) {
          let count = statusSnapshot.counts.find((row) => row.status === status);
          if (!count) { count = { status, count: 0 }; statusSnapshot.counts.push(count); }
          count.count = Math.max(0, Number(count.count) + (status === previousStatus ? -1 : 1));
        }
        renderStatus(statusSnapshot, queueSnapshot);
      }
    } catch (error) {
      if ([401, 403].includes(error.status)) lockPanel();
      else setState(record.refs.actionState, error.message, 'error');
    } finally {
      actionBusy = false;
      setBusy(button, false);
      updateControls();
      if (authorized) {
        if (loading) refreshPending = true;
        else loadData({ quiet: true });
      }
    }
  }
  async function loadData({ quiet = false, login = false } = {}) {
    if (loading || actionBusy || !token || (!login && !authorized) || (quiet && document.hidden)) return false;
    loading = true;
    visibleLoading = !quiet;
    const snapshotRevision = revision;
    const trigger = login ? $('load') : $('refresh');
    if (!quiet) { setBusy(trigger, true); setState(login ? 'msg' : 'status-note', 'Обновляем данные…'); }
    updateControls();
    try {
      const [status, works, queue] = await Promise.allSettled([
        call('/api/admin/status'), call('/api/admin/works'), call('/api/admin/queue'),
      ]);
      if (snapshotRevision !== revision) return false;
      // A token that is no longer accepted is an authorization problem, not a
      // transient polling failure. Hide protected data and ask the host to log
      // in again instead of leaving stale controls enabled.
      if ([status, works, queue].some((result) => result.status === 'rejected' && [401, 403].includes(result.reason?.status))) {
        lockPanel();
        return false;
      }
      if ([status, works, queue].some((result) => result.status === 'fulfilled')) {
        authorized = true;
        $('status-panel').classList.remove('hidden');
        $('works-panel').classList.remove('hidden');
      }
      const statusOk = status.status === 'fulfilled' && typeof status.value.ok === 'boolean'
        && Array.isArray(status.value.counts)
        && status.value.counts.every((row) => row && typeof row.status === 'string' && Number.isFinite(Number(row.count)));
      const worksOk = works.status === 'fulfilled' && Array.isArray(works.value.works)
        && works.value.works.every((work) => work && typeof work.id === 'string');
      const queueOk = queue.status === 'fulfilled' && Number.isFinite(Number(queue.value.pending));
      const cycleOk = statusOk && worksOk && queueOk;
      if (statusOk) {
        statusSnapshot = status.value;
        if (queueOk) queueSnapshot = queue.value;
        // A queue hiccup should not blank the last known active count.
        renderStatus(statusSnapshot, queueSnapshot);
      } else if (statusSnapshot) {
        // Keep the last known counters/provider when one endpoint is down.
        // A temporary status failure must not make the dashboard look empty.
        renderStatus(statusSnapshot, queueSnapshot);
      }
      if (worksOk) renderWorks(works.value.works);
      if (!cycleOk) {
        pollingFailureStreak += 1;
        markStatus(hasSnapshot ? 'stale' : 'error');
        // Quiet polling failures are expected on a workshop network. Keep the
        // current cards and works visible; surface one compact warning only
        // after several consecutive failed cycles.
        if (pollingFailureStreak >= 3) {
          setState('status-note', hasSnapshot
            ? 'Не удалось обновить данные. На экране остаются последние данные; повторим автоматически.'
            : 'Не удалось загрузить данные. Проверьте связь и попробуйте ещё раз.', 'error');
        } else if (!quiet) {
          setState('status-note', hasSnapshot
            ? 'Данные пока не обновились. Повторим автоматически.'
            : 'Не удалось загрузить данные. Проверьте связь и попробуйте ещё раз.', hasSnapshot ? '' : 'error');
        } else {
          setState('status-note', '');
        }
        if (!authorized && !quiet) setState('msg', 'Не удалось подключиться. Проверьте связь и попробуйте войти ещё раз.', 'error');
      } else {
        pollingFailureStreak = 0;
        hasSnapshot = true;
        setState('msg', 'Вы вошли. Данные обновляются автоматически.', 'success');
        setState('status-note', '');
      }
      return cycleOk;
    } catch (error) {
      if (snapshotRevision !== revision) return false;
      if ([401, 403].includes(error?.status)) {
        lockPanel();
        return false;
      }
      pollingFailureStreak += 1;
      markStatus(hasSnapshot ? 'stale' : 'error');
      if (pollingFailureStreak >= 3) {
        setState('status-note', hasSnapshot
          ? 'Не удалось обновить данные. На экране остаются последние данные; повторим автоматически.'
          : 'Не удалось загрузить данные. Проверьте связь и попробуйте ещё раз.', 'error');
      } else if (!quiet) {
        setState('status-note', hasSnapshot
          ? 'Данные пока не обновились. Повторим автоматически.'
          : 'Не удалось открыть панель. Попробуйте войти ещё раз.', hasSnapshot ? '' : 'error');
      } else {
        setState('status-note', '');
      }
      if (!authorized && !quiet) setState('msg', 'Не удалось открыть панель. Попробуйте войти ещё раз.', 'error');
      return false;
    } finally {
      loading = false;
      visibleLoading = false;
      if (!quiet) setBusy(trigger, false);
      updateControls();
      if (refreshPending && authorized && !actionBusy) {
        refreshPending = false;
        loadData({ quiet: true });
      }
    }
  }
  $('admin-login').addEventListener('submit', (event) => {
    event.preventDefault();
    if (loading || actionBusy || developerBusy) return;
    const nextToken = $('token').value.trim();
    if (!nextToken) return;
    token = nextToken;
    revision += 1;
    loadData({ login: true });
  });
  function resetDeveloper() {
    developerSession = null;
    developerVersion = 0;
    $('developerImage').removeAttribute('src');
    $('developerImage').classList.add('hidden');
    $('developerPrompt').value = '';
    $('developerPrompt').readOnly = false;
    text($('developerPromptLabel'), 'Описание тестового аватара');
    text($('developerGenerate'), 'Создать тестовый аватар');
    setState('developerState', '');
    updateControls();
  }
  $('developerReset').addEventListener('click', resetDeveloper);
  $('developerPrompt').addEventListener('input', updateControls);
  $('developerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if ($('developerGenerate').disabled) return;
    const requestRevision = revision;
    developerBusy = true;
    setBusy($('developerGenerate'), true);
    setState('developerState', developerVersion ? 'Улучшаем тестовый аватар…' : 'Создаём тестовый аватар…');
    updateControls();
    try {
      if (!developerSession) {
        const session = await call('/api/admin/developer/sessions', { method: 'POST' });
        if (requestRevision !== revision) return;
        developerSession = session.id;
      }
      const result = await call('/api/admin/developer/generate', {
        method: 'POST',
        body: JSON.stringify({ sessionId: developerSession, prompt: $('developerPrompt').value }),
      }, 300000);
      if (requestRevision !== revision) return;
      developerVersion = result.generationCount;
      $('developerImage').src = result.imageData;
      $('developerImage').classList.remove('hidden');
      $('developerPrompt').value = '';
      const max = result.generationPolicy?.maxGenerations;
      const needsReset = max > 0 && developerVersion >= max;
      $('developerPrompt').readOnly = needsReset;
      text($('developerPromptLabel'), 'Что изменить в тестовом аватаре?');
      text($('developerGenerate'), 'Улучшить тестовый аватар');
      setState('developerState', `Версия ${developerVersion} сохранена.${needsReset ? ' Для следующего теста выберите «Новый герой».' : ''}`, 'success');
    } catch (error) {
      if (requestRevision !== revision) return;
      if ([401, 403].includes(error.status)) lockPanel();
      else setState('developerState', error.message, 'error');
    } finally {
      developerBusy = false;
      setBusy($('developerGenerate'), false);
      updateControls();
      if (loading) refreshPending = true;
      else loadData({ quiet: true });
    }
  });
  $('token').addEventListener('input', updateControls);
  $('refresh').addEventListener('click', () => loadData());
  setInterval(() => loadData({ quiet: true }), pollIntervalMs);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadData({ quiet: true }); });
})();

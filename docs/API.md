# Асинхронный Image API

Необязательный серверный модуль мастерской. Для подключения задайте свой HTTPS origin, отдельный QUEST_API_KEY длиной не менее 32 символов и ненулевой общий quest-image-limit. Demo-launcher намеренно отключает эту интеграцию; контракт можно проверить через npm test с локальным HTTP-провайдером.

## Запрос

POST /api/integrations/quest/generations

Заголовки: Authorization: Bearer YOUR_INTEGRATION_KEY, Content-Type: application/json, Idempotency-Key: новый UUID. Ключ должен находиться только на вашем backend.

Тело:
```json
{
  "prompt": "Дружелюбный персонаж с синим рюкзаком",
  "style": "watercolor"
}
```

prompt обязателен, поддерживает русский и английский, по умолчанию до 500 символов. style необязателен, до 80 символов. Дополнительно допустимы eventId и teamId; они не используются как инструкция модели. Не передавайте личные данные.

Без style текст prompt передаётся без художественного шаблона мастерской. Со style к нему добавляется строка Visual style: и указанное значение. Особый псевдоним malevich / малевич означает ровно:

```text
Kazimir Malevich inspired Suprematist composition, geometric shapes and bold flat color.
```

Это существующее поведение, а не стиль по умолчанию. Никаких новогодних или иных тематических указаний API не добавляет.

## Задание и результат

Новый запрос возвращает HTTP 202 и JSON с jobId, status и датами создания/обновления. Заголовок Location содержит путь polling. Повтор с тем же Idempotency-Key и телом возвращает существующее задание (200), не создаёт новый вызов. Если тело изменилось — 409 IDEMPOTENCY_CONFLICT.

GET /api/integrations/quest/generations/:jobId требует тот же Bearer-ключ и возвращает состояние:

- queued — ожидает обработки;
- processing — запрос выполняется;
- completed — есть imageUrl и imageExpiresAt;
- failed — есть error.code и error.message.

Опрашивайте раз в 5 секунд, до completed или failed. Ошибка может появиться после успешного POST: 202 означает постановку в очередь, а не успешную генерацию.

imageUrl доступен без Bearer и действует 24 часа. Это непрогнозируемая публичная ссылка, а не защищённое хранилище. Задания хранятся до 7 дней; ожидающие более 10 минут завершаются QUEUE_EXPIRED.

## Ошибки

| HTTP / код | Действие клиента |
| --- | --- |
| 400 INVALID_REQUEST / INVALID_PROMPT | Исправить тело или описание |
| 401 UNAUTHORIZED | Проверить серверный ключ |
| 403 SERVER_ONLY | Вызывать с backend |
| 402 QUOTA_EXHAUSTED | Увеличить общий лимит, не повторять автоматически |
| 409 IDEMPOTENCY_CONFLICT | Не менять тело уже принятого задания |
| 429 RATE_LIMITED / QUEUE_FULL | Снизить частоту, учесть Retry-After |
| 503 QUOTA_UNAVAILABLE | Проверить конфигурацию бюджета |
| failed + PROVIDER_TIMEOUT / PROVIDER_REJECTED / PROVIDER_UNAVAILABLE | Показать причину; новый POST может стоить ещё один вызов |
| failed + JOB_INTERRUPTED | Не повторять без решения о расходах |

Перед каждой фактической попыткой резервируется бюджет, включая fallback. Таймаут не означает, что провайдер ничего не списал.

## Пример Node.js 24

Сохраните как run-integration.mjs. Задайте QUEST_BASE_URL и QUEST_API_KEY в защищённом окружении своего backend. Скрипт делает один POST и затем только polling.

```js
const base = process.env.QUEST_BASE_URL;
const key = process.env.QUEST_API_KEY;
if (!base || !key) throw new Error('Configure your server environment');
const headers = { Authorization: 'Bearer ' + key };
const response = await fetch(new URL('/api/integrations/quest/generations', base), {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
  body: JSON.stringify({ prompt: 'Дружелюбный персонаж с синим рюкзаком' }),
});
let job = await response.json();
if (!response.ok) throw new Error(job.error?.code || 'Create failed');
const deadline = Date.now() + 10 * 60_000;
while (job.status !== 'completed' && job.status !== 'failed') {
  if (Date.now() >= deadline) throw new Error('Local polling deadline; job may still be running');
  await new Promise(resolve => setTimeout(resolve, 5000));
  const poll = await fetch(new URL('/api/integrations/quest/generations/' + job.jobId, base), { headers });
  const next = await poll.json();
  if (!poll.ok) throw new Error(next.error?.code || 'Polling failed');
  job = next;
}
if (job.status === 'failed') throw new Error(job.error?.code || 'Generation failed');
console.log(job.imageUrl);
```

Для файла CommonJS оберните пример в async-функцию; для .mjs top-level await доступен непосредственно. Секреты не выводите в журнал.

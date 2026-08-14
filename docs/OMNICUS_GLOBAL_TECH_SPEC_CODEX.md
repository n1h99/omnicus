# OMNICUS — ГЛОБАЛЬНОЕ ТЕХНИЧЕСКОЕ ЗАДАНИЕ ДЛЯ CODEX

**Версия:** 1.1  
**Статус:** историческая спецификация первого pilot; реализация и post-pilot
scope развёрнуты, актуальный статус зафиксирован в `docs/README.md` и
`docs/OPERATOR_GUIDE.md` (reviewed 2026-08-14)  
**Рабочее название:** Omnicus  
**Тип продукта:** омниканальная платформа коммуникаций и автоматизаций  
**Основные каналы:** Telegram, WhatsApp; Instagram — опционально  
**CRM:** одна общая CRM с единым API-корнем и проектным контекстом  
**Хостинг:** Railway  
**Язык интерфейса MVP:** русский

---

# 0. ИНСТРУКЦИЯ ДЛЯ CODEX

Этот файл является главным источником требований.

Codex обязан:

1. Прочитать документ полностью до начала реализации.
2. Не пытаться реализовать весь продукт одним большим изменением.
3. Сначала подготовить архитектурный план и структуру monorepo.
4. Реализовывать проект по этапам из раздела «План реализации».
5. После каждого этапа запускать typecheck, lint, tests и production build.
6. Не придумывать поля Telegram, WhatsApp или Instagram API.
7. Все внешние payload обрабатывать через отдельные адаптеры.
8. Не связывать бизнес-логику напрямую с форматом webhook конкретного канала.
9. Не хранить секреты в Git, коде, логах или открытом виде в БД.
10. Не реализовывать функциональность из раздела «Не входит».
11. При отсутствии токенов использовать mocks и fixtures.
12. Спорные решения фиксировать в `docs/DECISIONS.md`.
13. Создать корневой `AGENTS.md`.
14. Делать небольшие логические изменения.
15. Перед изменением БД создавать миграцию.
16. Не выполнять тяжёлую бизнес-логику синхронно в webhook endpoint.
17. Гарантировать идемпотентность повторных webhook.
18. Считать этот документ приоритетнее собственных предположений.
19. Соблюдать принятые ADR из `docs/DECISIONS.md`.
20. Реализовывать transitions только по `docs/STATE_MACHINES.md`.
21. Не начинать production CRM adapter до выполнения
    `docs/CRM_CONTRACT_REQUIRED.md`.
22. Считать `docs/DATABASE.md` предложением Prisma-модели до создания и review
    первой migration.

Начальный порядок:

```text
1. Проанализировать ТЗ.
2. Создать IMPLEMENTATION_PLAN.md.
3. После подтверждения начать Этап 0: scaffold и ADR.
4. Реализовать Auth/RBAC/Projects.
5. Реализовать Contacts/Tags/Custom Fields.
6. Реализовать transactional inbox/outbox и Telegram adapter.
7. Реализовать минимальный automation runtime.
8. Подключить CRM mock adapter и завершить Telegram ↔ CRM pilot.
9. Production CRM adapter делать только после contract review.
10. WhatsApp, Instagram, broadcasts и advanced automation делать после pilot.
```

## 0.1. Обязательные решения первого pilot

- Семантика обработки — at-least-once. End-to-end exactly-once не обещается.
- PostgreSQL transactional inbox/outbox хранит истину о входящих событиях и
  исходящих side effects.
- Redis/BullMQ используется для исполнения и может быть восстановлен из
  PostgreSQL.
- CRM base URL/token находятся в environment; БД хранит только project-specific
  CRM configuration.
- Access token — JWT; refresh token — opaque rotating token, в БД только hash.
- Невалидный webhook raw body не сохраняется.
- Automation engine детерминирован и следует правилам раздела 25 и
  `docs/STATE_MACHINES.md`.
- Первый pilot ограничен scope раздела 41.
- Формальные решения находятся в `docs/DECISIONS.md`; при кратком описании в
  этом файле ADR имеет приоритет только если он не противоречит явному требованию
  пользователя.

---

# 1. ОПИСАНИЕ ПРОДУКТА

Omnicus — облегчённая кастомная версия ManyChat, которая служит мостом между пользователями в мессенджерах и существующей CRM.

```text
Пользователь пишет в Telegram / WhatsApp / Instagram
        ↓
Внешняя платформа отправляет webhook
        ↓
Omnicus проверяет и сохраняет событие
        ↓
Событие нормализуется
        ↓
Создаётся или находится контакт
        ↓
Запускается визуальный сценарий
        ↓
Создаётся или обновляется лид в CRM
        ↓
Сообщение передаётся в CRM
        ↓
CRM отправляет ответ в Omnicus
        ↓
Omnicus отправляет ответ пользователю в исходный канал
```

Omnicus не заменяет основную CRM.

Omnicus отвечает за:

- подключение каналов;
- приём webhook;
- нормализацию событий;
- базу контактов и channel identities;
- теги и сегменты;
- визуальные сценарии;
- автоматические действия;
- передачу лидов и сообщений в CRM;
- отправку ответов CRM пользователю;
- шаблоны сообщений;
- массовые рассылки;
- роли, проекты и административное управление;
- журналы, retries и аудит.

---

# 2. ЦЕЛИ

## 2.1. Основная цель

Специалисты без изменения исходного кода должны уметь:

- подключать Telegram-ботов;
- подключать WhatsApp Business Cloud API;
- опционально подключать Instagram Professional;
- создавать проекты;
- управлять сотрудниками и ролями;
- видеть базу контактов;
- назначать теги;
- создавать сценарии на большом canvas;
- запускать действия по входящим событиям;
- передавать лиды и сообщения в CRM;
- принимать ответы от CRM;
- запускать массовые рассылки;
- использовать Telegram-шаблоны и WhatsApp templates.

## 2.2. Бизнес-цель

Сначала воспроизвести текущие сценарии ManyChat без остановки лидогенерации, затем подключать другие собственные проекты.

## 2.3. Техническая цель

Новое подключение канала должно добавляться через адаптер, а не через изменение всей системы.

---

# 3. НЕ ВХОДИТ В ПРОЕКТ

Без отдельного требования не реализовывать:

- аналитику воронок;
- BI-дашборды;
- AI-ответы;
- генеративный AI;
- A/B-тесты;
- биллинг, тарифы и подписки;
- marketplace;
- сложный операторский Inbox;
- полноценный helpdesk;
- ручную переписку операторов внутри Omnicus как основной рабочий процесс;
- дублирование CRM;
- финансовый модуль CRM;
- самостоятельный WhatsApp Embedded Signup;
- TikTok и прочие каналы;
- звонки и голосового бота;
- полноценный CDP;
- автоматическое объединение людей между каналами только по имени;
- произвольный конструктор отчётов.

История сообщений в карточке контакта допускается как диагностический timeline, но не как сложный Inbox.

---

# 4. АРХИТЕКТУРНЫЕ ПРИНЦИПЫ

## 4.1. Multi-project

Каждый проект имеет:

- название и slug;
- статус и настройки;
- каналы;
- контакты;
- теги;
- сценарии;
- шаблоны;
- рассылки;
- пользователей и роли;
- CRM-контекст;
- журналы.

Данные проекта недоступны пользователю без membership и permission.

## 4.2. Одна CRM

CRM одна. Базовый URL и token общие и задаются только через
`CRM_BASE_URL`/`CRM_AUTH_TOKEN`.

Проектный контекст меняет:

- `projectId`;
- названия;
- внутренние условия;
- теги;
- mapping полей;
- custom payload values;
- pipeline/stage при необходимости.

```text
Global CRM connection
  baseUrl
  auth
  timeout
  retryPolicy

Project CRM context
  externalProjectId
  fieldMapping
  defaultPipeline
  defaultStage
  customValues
```

Project CRM context хранится в `CrmProjectConfig`; global URL/token в PostgreSQL
не сохраняются.

## 4.3. Channel adapters

```ts
interface ChannelAdapter {
  channel: ChannelType;
  verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult>;
  parseWebhook(input: ParseWebhookInput): Promise<NormalizedEvent[]>;
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  validateConnection(input: ValidateConnectionInput): Promise<ValidationResult>;
  getCapabilities(): ChannelCapabilities;
}
```

Бизнес-логика не обращается напрямую к Telegram или Meta API.

## 4.4. Event-driven pipeline

Webhook endpoint:

1. проверяет подпись/секрет;
2. применяет limit raw body 2 MB;
3. для валидного события в одной PostgreSQL transaction сохраняет raw event и
   `InboxRecord`;
4. выполняет дедупликацию по provider event key;
5. быстро отвечает success после durable commit;
6. outbox/inbox relay сигнализирует job в BullMQ;
7. worker выполняет бизнес-логику;
8. потерянный Redis job восстанавливается scan-ом PostgreSQL.

Невалидная подпись не создаёт `InboxRecord`; raw body не сохраняется. Разрешены
только safe metadata из раздела 35.

## 4.5. Идемпотентность

Семантика системы — at-least-once. End-to-end exactly-once не обещается.

Повтор одного события не должен повторно:

- создавать контакт;
- создавать lead;
- запускать scenario;
- добавлять tag;
- отправлять message;
- создавать CRM record.

Все внешние side effects создаются через transactional `OutboxRecord` и имеют
idempotency key и состояния:

```text
pending → processing → succeeded | failed | unknown
```

`unknown` запрещает blind retry. Сначала выполняется reconciliation; ручной retry
требует permission, reason и audit.

## 4.6. API и Worker

`api`:

- REST API;
- auth;
- публичные webhooks;
- CRM callbacks;
- healthcheck;
- durable запись inbox/outbox;
- best-effort сигнал jobs после commit.

`worker`:

- webhook processing;
- scenario execution;
- external HTTP;
- CRM sync;
- outbound messages;
- broadcasts;
- delays;
- retries;
- dead-letter.

PostgreSQL — источник истины. Redis/BullMQ не хранит единственную копию intent
или результата.

---

# 5. СТЕК

## 5.1. Monorepo

- pnpm workspaces;
- Turborepo;
- TypeScript strict;
- единый eslint/prettier;
- shared contracts и runtime schemas.

```text
/apps
  /web
  /api
  /worker
/packages
  /database
  /shared
  /contracts
  /channel-core
  /channel-telegram
  /channel-whatsapp
  /channel-instagram
  /automation-engine
  /crm-client
  /config
  /test-fixtures
/docs
/prisma
/docker
AGENTS.md
pnpm-workspace.yaml
turbo.json
```

## 5.2. Frontend

- React;
- TypeScript;
- Vite;
- Ant Design;
- `@xyflow/react`;
- React Router;
- TanStack Query;
- Redux Toolkit;
- React Hook Form;
- Zod;
- Day.js;
- i18n-ready структура.

## 5.3. Backend

- NestJS;
- REST API;
- Swagger/OpenAPI;
- DTO validation;
- dependency injection;
- доменные модули;
- отдельный worker.

## 5.4. Data

- PostgreSQL;
- Prisma ORM;
- Prisma Migrate;
- JSONB для graph, mappings, settings и raw payload;
- Redis;
- BullMQ;
- Railway Storage Bucket или S3-compatible storage.

Очереди:

```text
inbound-events
scenario-execution
outbound-messages
broadcasts
crm-sync
delayed-actions
dead-letter
```

## 5.5. Tests

- Vitest;
- Jest/Supertest для NestJS;
- Playwright;
- test PostgreSQL/Redis;
- обезличенные webhook fixtures.

---

# 6. RAILWAY

Один Railway Project:

```text
web
api
worker
postgres
redis
storage bucket
```

Public:

- web;
- api;
- webhook endpoints.

Private network:

- API ↔ PostgreSQL;
- API ↔ Redis;
- Worker ↔ PostgreSQL;
- Worker ↔ Redis.

Storage:

- Railway Bucket — private authenticated S3-compatible storage, но не private
  network;
- Worker/API обращаются к bucket по публичному endpoint с credentials;
- использовать signed URLs;
- не обещать server-side encryption, object versioning, object lock или lifecycle
  policies;
- retention/delete реализуются application jobs;
- учитывать service egress.

Окружения:

```text
staging
production
```

Каждый сервис:

- отдельный start command;
- healthcheck;
- graceful shutdown;
- SIGTERM handling;
- environment validation;
- rollback-friendly deploy.

Endpoints:

```text
GET /health/live
GET /health/ready
```

`ready` проверяет БД, Redis и обязательные настройки.

Staging и production используют изолированные PostgreSQL, Redis и Bucket
instances. Для production обязательны backup schedule, RPO 24 часа, RTO 4 часа и
документированная проверка restore.

---

# 7. AUTH И СЕССИИ

- login по email/password;
- короткоживущий JWT access token;
- криптографически случайный opaque refresh token;
- в БД хранится только hash refresh token;
- refresh token в HttpOnly Secure cookie с explicit SameSite/Path/lifetime;
- refresh rotation, token family и reuse detection;
- повторное использование rotated token отзывает всю token family;
- synchronizer CSRF token в отдельном header и Origin/Referer validation для
  cookie-based state-changing operations;
- отзыв всех сессий;
- reset password;
- Argon2id;
- login rate limit;
- last login;
- deactivation пользователя.

---

# 8. РОЛИ И ПРАВА

Базовые роли:

- Super Admin;
- Project Admin;
- Automation Editor;
- Integration Manager;
- Contact Manager;
- Viewer.

Permissions:

```text
projects.read/create/update/delete
users.read/create/update/disable/assign_role
roles.read/manage
contacts.read/update/export/merge
tags.read/manage
channels.read/manage/rotate_secrets
scenarios.read/create/update/test/publish/disable/delete
templates.read/manage
broadcasts.read/create/launch/pause/cancel
integrations.read/manage/test
logs.read
audit.read
```

Один пользователь может иметь разные роли в разных проектах.

---

# 9. ОСНОВНОЙ UI

Sidebar:

```text
Обзор
Проекты
Контакты
Сценарии
Рассылки
Шаблоны
Каналы
Интеграции
Теги
Пользователи и роли
Журнал событий
Аудит
Настройки
```

Header:

- project selector;
- channel statuses;
- staging/production badge;
- critical error indicator;
- user menu;
- logout.

Общие требования:

- Ant Design;
- loading/skeleton;
- empty states;
- confirmation modal;
- понятные ошибки;
- filters in URL;
- server-side pagination;
- desktop-first;
- responsive shell;
- flow editor desktop-oriented.

---

# 10. ПРОЕКТЫ

Поля проекта:

```text
id
name
slug
description
status
timezone
locale
settings
```

CRM project mapping хранится отдельно в `CrmProjectConfig`.

Статусы:

```text
draft
active
paused
archived
```

Клонирование проекта:

Можно копировать:

- tags;
- scenarios;
- Telegram templates;
- settings.

Не копировать:

- contacts;
- history;
- webhook events;
- secrets;
- active broadcasts.

После клонирования:

- новый internal projectId;
- новый пустой `CrmProjectConfig`, который требует настройки `crmProjectId`;
- каналы подключаются заново;
- scenarios становятся draft;
- CRM base URL остаётся общим.

---

# 11. КОНТАКТЫ

## 11.1. Назначение

Хранить всех пользователей, взаимодействовавших с каналами. Это база идентичностей и событий, но не замена CRM.

## 11.2. Список

Колонки:

- name/displayName;
- username;
- phone, если доступен;
- channels;
- tags;
- CRM lead ID;
- first interaction;
- last interaction;
- status;
- automation mode.

Функции:

- поиск;
- сортировка;
- channel filter;
- tag filter;
- CRM lead filter;
- active/blocked filter;
- массовые теги;
- экспорт по permission;
- выбор для рассылки.

## 11.3. Карточка контакта

- основные данные;
- channel identities;
- tags;
- custom fields;
- CRM link;
- history/timeline;
- scenario executions;
- errors;
- audit;
- pause/resume automation.

## 11.4. Identity model

```text
Contact
├── Telegram identity
├── WhatsApp identity
└── Instagram identity
```

Не объединять автоматически по похожему имени.

Разрешённое объединение:

- вручную;
- по подтверждённому телефону;
- через deep link/token;
- по mapping из CRM.

Contact status:

```text
active
blocked
unsubscribed
archived
merged
```

Automation mode:

```text
automation_enabled
automation_paused
manual_mode
```

`Contact.automationMode` — project default для контакта.
`Conversation.automationModeOverride` — nullable override.

Effective mode:

```text
conversation override
→ contact mode
→ automation_enabled
```

---

# 12. ТЕГИ, ПОЛЯ И СЕГМЕНТЫ

Tag принадлежит проекту.

```text
id
projectId
name
color
description
createdBy
createdAt
```

Функции:

- create/update/delete;
- add/remove from contact;
- bulk apply;
- использовать в scenario;
- использовать в broadcast filter.

Custom field types:

```text
text
number
boolean
date
datetime
select
multi_select
json
```

Примеры:

```text
car_brand
budget
city
language
lead_source
preferred_time
crm_manager_id
```

Segment — сохранённый фильтр, а не копия контактов.

```text
channel = telegram
AND tag contains BMW
AND status = active
AND lastInteractionAt >= 30 days ago
```

---

# 13. ОБЩАЯ МОДЕЛЬ КАНАЛА

```ts
type ChannelType = 'telegram' | 'whatsapp' | 'instagram';

interface ChannelConnection {
  id: string;
  projectId: string;
  channel: ChannelType;
  name: string;
  status: 'draft' | 'connected' | 'error' | 'disabled';
  externalAccountId?: string;
  encryptedCredentials: unknown;
  settings: unknown;
  capabilities: unknown;
  lastWebhookAt?: string;
  lastErrorAt?: string;
}
```

Экран подключения показывает:

- name/type;
- connection status;
- webhook status;
- last webhook;
- external account ID;
- test connection;
- reconnect;
- rotate secret;
- disable;
- last errors.

Secrets после сохранения отображаются маской и никогда не возвращаются frontend в открытом виде.

Media pilot:

- входящий provider media сначала сохраняется как metadata/provider media ID;
- download выполняется лениво только при необходимости;
- перед сохранением проверяются MIME, размер и расширение;
- пользовательские template assets хранятся в private Railway Bucket;
- доступ через signed URL;
- retention/delete выполняют application jobs;
- расширенная media processing pipeline не входит в первый pilot.

---

# 14. TELEGRAM

## 14.1. Подключение

Admin вводит Bot Token.

Система:

1. валидирует token;
2. получает bot metadata;
3. генерирует webhook secret;
4. устанавливает HTTPS webhook;
5. сохраняет configuration;
6. показывает status.

Endpoint:

```text
POST /webhooks/telegram/:connectionId
```

Проверять secret header Telegram.

## 14.2. Incoming MVP

- private text;
- command;
- photo;
- video;
- document;
- audio;
- voice;
- contact;
- location;
- callback query;
- button click;
- edited message как event;
- blocked/unblocked при наличии event.

## 14.3. Outgoing MVP

- text;
- photo;
- document;
- video;
- inline keyboard;
- reply keyboard при необходимости;
- reply to message;
- disable notification;
- безопасный parse mode.

## 14.4. Ограничения

- нельзя написать произвольному пользователю, не взаимодействовавшему с ботом;
- blocked chat становится недоступным;
- `429` обрабатывается через retry-after;
- broadcast rate limited;
- отправка идёт через очередь;
- не делать синхронный цикл по всей базе.

## 14.5. Telegram templates

Telegram template — сохранённая конфигурация сообщения:

```text
name
text
parseMode
media
buttons
variables
status
projectId
```

Внешнее одобрение не требуется.

---

# 15. WHATSAPP

Статус: post-pilot. Не реализовывать в первом pilot.

## 15.1. Тип интеграции

WhatsApp Business Platform / Cloud API.

Embedded Signup не входит. Подключение выполняет администратор вручную.

Хранить зашифрованно:

- access token;
- app secret;
- verify token;
- phone number ID;
- WhatsApp Business Account ID;
- API metadata/version.

## 15.2. Webhooks

```text
GET  /webhooks/meta/whatsapp/:connectionId
POST /webhooks/meta/whatsapp/:connectionId
```

GET — verification challenge.

POST:

- signature verification по raw body;
- raw event persist;
- normalization;
- fast 200;
- worker processing.

## 15.3. Incoming MVP

- text;
- image;
- video;
- document;
- audio;
- location;
- contact;
- interactive button reply;
- list reply;
- statuses;
- errors;
- unsupported type.

## 15.4. Outgoing MVP

- free-form/service text, когда разрешено;
- media;
- interactive message, где разрешено;
- approved template;
- reply/context message, где поддерживается.

## 15.5. Message window

Хранить:

- last user message time;
- free-form allowed flag;
- reason template required;
- selected WhatsApp template.

UI блокирует заведомо запрещённый free-form message вне разрешённого окна.

## 15.6. Statuses

```text
queued
submitted
sent
delivered
read
failed
```

Хранить external message ID, error code/message, timestamp и raw status payload.

## 15.7. WhatsApp templates

Раздел должен уметь:

- sync templates from Meta;
- показывать name/language/category/status/components/variables;
- обновлять status;
- использовать template в scenario;
- использовать template в broadcast;
- создавать template через API, если актуальная версия API и аккаунт позволяют;
- показывать rejection reason.

UI statuses:

```text
draft_local
pending
approved
rejected
paused
disabled
unknown
```

Meta — источник истины официального статуса.

---

# 16. INSTAGRAM — ОПЦИОНАЛЬНО

Делать после Telegram и WhatsApp.

Scope:

- Instagram Professional account;
- incoming Direct messages;
- разрешённые outgoing replies;
- text/media по capabilities;
- webhook events;
- button/quick reply events при поддержке актуального API.

Ограничения:

- capabilities проверяются отдельно;
- массовые рассылки Instagram не входят;
- comments/private replies не смешивать с Direct;
- window rules проверяет adapter;
- permissions и API version сверять перед реализацией.

---

# 17. CAPABILITY MATRIX

```ts
interface ChannelCapabilities {
  incoming: {
    text: boolean;
    image: boolean;
    video: boolean;
    audio: boolean;
    document: boolean;
    location: boolean;
    contact: boolean;
    buttons: boolean;
  };
  outgoing: {
    freeText: boolean;
    image: boolean;
    video: boolean;
    audio: boolean;
    document: boolean;
    buttons: boolean;
    templates: boolean;
  };
  broadcasts: boolean;
  deliveryStatuses: boolean;
  readStatuses: boolean;
}
```

Редактор и broadcast wizard используют capability matrix.

Несовместимый flow нельзя publish.

---

# 18. NORMALIZED EVENTS

```ts
interface NormalizedEvent {
  id: string;
  projectId: string;
  connectionId: string;
  channel: ChannelType;
  externalEventId: string;
  eventType:
    | 'message.received'
    | 'message.updated'
    | 'message.status'
    | 'button.clicked'
    | 'contact.blocked'
    | 'contact.unblocked'
    | 'webhook.unknown';
  externalUserId?: string;
  externalConversationId?: string;
  externalMessageId?: string;
  occurredAt: string;
  receivedAt: string;
  sender?: NormalizedSender;
  content?: NormalizedContent;
  status?: NormalizedDeliveryStatus;
  metadata: Record<string, unknown>;
  rawEventId: string;
}
```

Content union:

```ts
type NormalizedContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaId?: string; url?: string; caption?: string }
  | { type: 'video'; mediaId?: string; url?: string; caption?: string }
  | { type: 'audio'; mediaId?: string; url?: string }
  | { type: 'document'; mediaId?: string; url?: string; filename?: string }
  | { type: 'location'; latitude: number; longitude: number }
  | { type: 'contact'; phone?: string; name?: string }
  | { type: 'button'; value: string; title?: string }
  | { type: 'unsupported'; sourceType: string };
```

Raw payload хранится отдельно и не является доменной моделью.

---

# 19. WEBHOOK PIPELINE

Синхронно:

```text
Receive request
→ resolve connection
→ enforce 2 MB body limit
→ verify signature/secret
→ calculate provider external event key
→ PostgreSQL transaction:
     persist valid RawWebhookEvent
     insert/deduplicate InboxRecord
→ best-effort BullMQ signal
→ return success
```

Webhook подтверждается после durable PostgreSQL commit и не ждёт CRM, scenario
или outbound delivery.

При invalid signature raw body не сохраняется. Сохраняются только:

```text
provider
projectId/connectionId, если connection разрешён
timestamp
source IP
allowlisted/redacted headers
rejection reason
correlationId
```

Асинхронно:

```text
Inbox relay/scan
→ claim InboxRecord with lease
→ load raw event
→ adapter.parseWebhook
→ persist normalized events
→ resolve identity/contact
→ persist message/status
→ trigger automations
→ create CRM/outbound OutboxRecords in domain transactions
→ mark InboxRecord processed
→ outbox relay executes external side effects
```

RawWebhookEvent fields:

```text
id
projectId
connectionId
channel
externalEventKey
safeHeaders
contentType
payloadRaw bytes
payloadJson nullable
receivedAt
purgeAfter
```

`signatureValid` удаляется из `RawWebhookEvent`: эта таблица содержит только
валидные payload. Invalid attempts используют отдельную safe metadata запись.

Unique:

```text
projectId + connectionId + externalEventKey
```

Уникальность также действует для `InboxRecord`. Duplicate возвращает успешное
подтверждение уже принятого event без повторных domain effects.

Retry:

- exponential backoff;
- jitter;
- retryable/non-retryable errors;
- max attempts;
- dead-letter;
- manual retry with audit.

PostgreSQL inbox statuses и transitions определены в
`docs/STATE_MACHINES.md`. Потеря или очистка Redis queue не должна терять
`received/retry_wait` intent.

---

# 20. CONVERSATIONS И MESSAGES

Conversation связывает:

- project;
- contact;
- identity;
- connection;
- external conversation;
- CRM lead;
- nullable automation mode override;
- last inbound/outbound.

```ts
interface MessageRecord {
  id: string;
  projectId: string;
  conversationId: string;
  contactId: string;
  channel: ChannelType;
  direction: 'inbound' | 'outbound';
  type: MessageType;
  text?: string;
  contentJson?: unknown;
  externalMessageId?: string;
  status: MessageStatus;
  source: 'channel' | 'scenario' | 'crm' | 'broadcast' | 'system';
  scenarioExecutionId?: string;
  broadcastId?: string;
  createdAt: string;
}
```

Timeline показывает:

- inbound/outbound message;
- status update;
- scenario start/end;
- HTTP request;
- CRM event;
- tag change;
- error.

---

# 21. CRM BRIDGE

## 21.1. Контракт

```ts
interface CrmClient {
  createOrUpdateLead(input: CreateOrUpdateLeadInput): Promise<CrmLeadResult>;
  forwardInboundMessage(input: ForwardInboundMessageInput): Promise<void>;
  syncContact(input: SyncContactInput): Promise<void>;
  getLeadContext?(input: GetLeadContextInput): Promise<CrmLeadContext>;
}
```

Global configuration:

- base URL из `CRM_BASE_URL`;
- bearer/auth token из `CRM_AUTH_TOKEN`;
- timeout;
- retry policy.

Base URL/token не сохраняются в PostgreSQL и не редактируются через project UI.

Project context:

- externalProjectId;
- source;
- pipeline/stage;
- field mapping;
- custom values.

Project context хранится в `CrmProjectConfig`. `Project.crmProjectId` как
дублирующее поле не используется.

До получения реального CRM API:

- определить только provider-neutral `CrmClient`;
- реализовать mock adapter;
- использовать синтетические mock fixtures;
- не придумывать endpoint, payload, response или error codes;
- считать production CRM adapter заблокированным требованиями
  `docs/CRM_CONTRACT_REQUIRED.md`.

Хранить у контакта/диалога:

```text
crmLeadId
crmContactId
crmManagerId
syncStatus
lastSyncAt
lastError
```

Основной flow:

```text
first message
→ Contact
→ Conversation
→ scenario
→ create/update CRM lead
→ save crmLeadId
→ forward first message
→ all later messages use crmLeadId
```

CRM → Omnicus endpoint:

```text
POST /integrations/crm/events
```

Commands:

```text
message.send
contact.tag.add
contact.tag.remove
automation.pause
automation.resume
lead.link
contact.update
```

Пример:

```json
{
  "eventId": "crm_evt_123",
  "type": "message.send",
  "projectId": "project_id",
  "crmLeadId": "lead_456",
  "conversationId": "conversation_id",
  "message": {
    "type": "text",
    "text": "Здравствуйте!"
  }
}
```

Security:

- HMAC или secret header;
- timestamp;
- replay protection;
- idempotency event ID;
- masked logs.

Входящий callback нельзя маршрутизировать только по переданному caller-ом
internal `projectId`. Проверенная подпись, `crmProjectId` и сохраненная
lead/conversation mapping должны согласованно определять project.

CRM outage:

- не терять message;
- retry;
- pending/failed status;
- no duplicates;
- manual retry.

CRM side effects выполняются через `OutboxRecord`. Timeout после возможного
применения переводит запись в `unknown`; blind retry запрещён до reconciliation.

---

# 22. ВИЗУАЛЬНЫЙ РЕДАКТОР СЦЕНАРИЕВ

Canvas:

- drag-and-drop;
- nodes/edges;
- zoom/pan;
- minimap;
- fit view;
- grid/snap;
- undo/redo;
- autosave draft;
- left node palette;
- right properties panel;
- validation panel;
- test run panel.

Использовать `@xyflow/react`.

Scenario statuses:

```text
draft
published
paused
archived
```

Versioning:

- published version immutable;
- изменение создаёт new draft;
- publish;
- rollback;
- duplicate;
- copy to project;
- archive.

Graph validation:

- no unguarded infinite cycles;
- trigger has outgoing path;
- required config present;
- channel capabilities valid;
- orphan nodes warning;
- unreachable nodes warning/error;
- secrets/templates valid.

Execution statuses:

```text
queued
running
waiting
completed
failed
cancelled
paused
```

Test mode:

- test/synthetic contact;
- choose trigger;
- inject variables;
- step-by-step execution;
- see path;
- see safe request/response;
- dry-run by default;
- real channel test only with permission;
- CRM creation disabled in dry-run.

---

# 23. NODE TYPES

Node base:

```ts
interface ScenarioNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: {
    title?: string;
    config: unknown;
    schemaVersion: number;
  };
}
```

## Triggers

### Incoming Message

Filters:

- channel/connection;
- exact/contains/startsWith;
- regex with limits;
- message type;
- command;
- first message only;
- has/does not have tag.

### Button Click

- callback value;
- button ID;
- channel;
- source template/message.

### Contact Created

Запуск один раз после создания contact.

### Tag Added

- tag;
- source;
- recursion protection.

### CRM Event

- event type;
- project;
- payload conditions.

## Logic

### Condition

Operators:

```text
equals
not_equals
contains
not_contains
starts_with
ends_with
greater_than
greater_or_equal
less_than
less_or_equal
exists
not_exists
in
not_in
matches_regex
```

Sources:

- contact fields;
- custom fields;
- tags;
- trigger;
- message;
- CRM context;
- previous node output;
- datetime.

## Actions

### Send Message

- current/fixed channel;
- text/media/buttons;
- variables;
- reply context;
- failure path.

### Send Template

- Telegram template;
- approved WhatsApp template;
- variable mapping;
- language;
- error path.

### Create/Update CRM Lead

- field mapping;
- source/custom fields;
- wait for response;
- save response values;
- success/failure edges.

### Forward Message to CRM

- content;
- contact context;
- conversation;
- crmLeadId;
- channel;
- attachments metadata.

### Add/Remove Tag

Idempotent. Remove does not error if absent.

### Set Custom Field

- field;
- value/expression;
- type validation.

### Delay

- seconds/minutes/hours/days;
- absolute datetime;
- project timezone;
- persisted job;
- no long `setTimeout`.

### Wait for Reply

- timeout;
- allowed message types;
- validation;
- save variable;
- success and timeout paths.

### Start Subflow

- input variables;
- await or fire-and-forget;
- recursion guard.

### Pause/Resume Automation

Меняет contact automation mode.

### Stop Flow

Завершает execution с reason.

---

# 24. EXTERNAL HTTP REQUEST NODE

Аналог ManyChat External Request.

Статус: post-pilot. Будущий response body hard limit — 5 MB.

Настройки:

- GET/POST/PUT/PATCH/DELETE;
- HTTPS URL;
- query params;
- headers;
- body;
- content type;
- timeout;
- retry policy;
- secret references;
- variables;
- response mapping;
- success condition;
- success/failure edge.

UI tabs:

```text
Request
Headers
Body
Response
Response mapping
Test
```

Security:

- HTTPS in production;
- SSRF protection;
- block loopback/link-local/private IP by default;
- DNS rebinding protection;
- block cloud metadata endpoints;
- redirect validation;
- response size limit;
- timeout;
- secrets only by reference;
- secret redaction;
- no arbitrary code;
- no eval.

Response mapping:

```text
response.data.leadId → crm.leadId
response.data.managerId → crm.managerId
response.status → request.status
```

Поддержать JSON path, default, required, type conversion и mapping error path.

---

# 25. VARIABLES И AUTOMATION ENGINE

System variables:

```text
{{project.id}}
{{project.name}}
{{contact.id}}
{{contact.firstName}}
{{contact.lastName}}
{{contact.username}}
{{contact.phone}}
{{contact.channel}}
{{conversation.id}}
{{message.id}}
{{message.text}}
{{message.type}}
{{crm.leadId}}
{{crm.managerId}}
{{trigger.type}}
{{trigger.occurredAt}}
```

Custom:

```text
{{contact.fields.budget}}
{{contact.fields.car_brand}}
```

Node outputs:

```text
{{nodes.http_1.response.data.leadId}}
{{nodes.http_1.response.status}}
```

Template rules:

- no eval;
- sandboxed expression language;
- nesting/output limits;
- escaped preview;
- required variable errors;
- date formatting;
- JSON-safe insertion.

Compile before publish:

- node schemas;
- edges/reachability;
- capabilities;
- secret references;
- template status;
- CRM mapping;
- cycles;
- variables.

Deterministic graph rules:

- condition branches имеют явный integer `priority`;
- branches проверяются по priority; одинаковый priority запрещён;
- у output port максимум один active edge, кроме schema-marked branching nodes;
- `null` не приводится автоматически к string/number;
- type coercion разрешён только явной node configuration;
- subflow pin-ится на конкретный published `ScenarioVersion`;
- unguarded cycle — цикл без Delay, Wait или явно настроенного iteration limit;
- graph с unguarded cycle нельзя publish.

Trigger matching:

1. active published scenarios;
2. trigger type;
3. channel/connection;
4. conditions;
5. duplicate policy;
6. create ScenarioExecution;
7. enqueue.

Contact/conversation concurrency policy:

```text
parallel
cancel_previous
queue
ignore_if_running
```

MVP default: `queue`.

Node execution must be idempotent.

```text
scenarioExecutionId + nodeId + attemptGroup
```

WaitState хранится в БД и продолжается новым inbound event.

Concurrency and Wait semantics:

- события одной conversation получают sequence и обрабатываются последовательно;
- для `(conversationId, scenarioId)` разрешён один active Wait for Reply;
- inbound event сначала транзакционно пытается resolve active Wait, затем может
  запускать остальные matching scenarios;
- timeout и reply используют conditional update/row lock; выигрывает только один;
- по умолчанию запускаются все matching scenarios;
- порядок между разными scenarios не гарантируется.

Wait, Delay и Subflow semantics фиксируются сейчас, но сами node types не входят
в первый pilot.

---

# 26. ШАБЛОНЫ СООБЩЕНИЙ

Отдельный пункт меню «Шаблоны».

Фильтры:

- project;
- channel;
- status;
- language;
- category;
- updatedAt.

Telegram templates:

- text;
- media;
- buttons;
- variables;
- preview;
- duplicate;
- archive.

WhatsApp templates:

- sync;
- create where supported;
- status;
- category;
- language;
- components;
- variable examples;
- preview;
- rejection reason;
- last sync;
- use in scenario;
- use in broadcast.

Перед отправкой проверить:

- project/connection ownership;
- allowed status;
- all variables;
- component count;
- media/header requirements.

---

# 27. МАССОВЫЕ РАССЫЛКИ

Статус: post-pilot. Не реализовывать до успешного review первого pilot.

Future scope:

- Telegram;
- WhatsApp;
- Instagram broadcasts не входят.

Wizard:

```text
1. Project
2. Channel/connection
3. Audience
4. Message/template
5. Preview
6. Recipient estimate
7. Start now or schedule
```

Audience:

- all active channel contacts;
- selected contacts;
- include tags;
- exclude tags;
- saved segment;
- last interaction;
- createdAt;
- custom fields;
- exclude blocked/unsubscribed.

Telegram:

- only users who interacted;
- blocked filtering;
- rate limit;
- 429/retry-after;
- queue and chunks;
- pause/cancel;
- no one-job-for-all approach.

WhatsApp:

- approved template where required;
- variable validation;
- platform restrictions;
- delivery statuses;
- failed recipient does not stop campaign.

Broadcast statuses:

```text
draft
scheduled
preparing
running
paused
completed
cancelled
failed
```

Recipient statuses:

```text
pending
queued
sent
delivered
read
failed
skipped
cancelled
```

Result screen — техническая сводка, не funnel analytics:

- total;
- queued;
- sent;
- delivered/read if available;
- failed;
- skipped;
- started/completed;
- error list;
- retry failed.

---

# 28. LOGS И ERRORS

Разделы:

- raw webhooks;
- normalized events;
- scenario executions;
- node executions;
- outbound messages;
- CRM requests;
- external HTTP requests;
- broadcasts;
- system errors;
- audit.

Filters:

- project;
- channel;
- connection;
- contact;
- conversation;
- scenario/execution;
- status;
- date range;
- error code;
- correlation ID.

Correlation ID проходит через:

```text
raw webhook
→ normalized event
→ message
→ scenario execution
→ node execution
→ CRM request
→ outbound message
```

Redact:

- passwords;
- bot tokens;
- access tokens;
- app secrets;
- Authorization;
- webhook secrets;
- private API keys.

Manual retry с permission:

- webhook processing;
- CRM request;
- HTTP node;
- outbound message;
- failed broadcast recipients.

Каждый retry создаёт audit record.

---

# 29. AUDIT

AuditLog:

```text
actorUserId
projectId
action
entityType
entityId
beforeSafeJson
afterSafeJson
ip
userAgent
correlationId
createdAt
```

Аудировать:

- login/logout;
- user/role changes;
- project changes;
- channel connection;
- secret rotation;
- scenario publish/rollback;
- broadcast launch/cancel;
- template changes;
- manual retry;
- contact merge;
- user-made tag changes.

---

# 30. DATABASE MODEL

Полный proposal находится в `docs/DATABASE.md`. На текущем шаге migration не
создавать и не запускать.

Все tenant-owned tables имеют `projectId`, composite unique `(projectId, id)` и
tenant-safe composite foreign keys. Application guard дополняет, но не заменяет
DB constraint.

## Core auth

```text
User
  id, email unique, passwordHash, firstName, lastName,
  status, lastLoginAt, createdAt, updatedAt

Session
  id, userId, tokenFamilyId, refreshTokenHash unique,
  csrfTokenHash, status, replacedBySessionId,
  expiresAt, rotatedAt, revokedAt, reuseDetectedAt,
  ip, userAgent, createdAt

PasswordResetToken
  id, userId, tokenHash unique, expiresAt, usedAt, createdAt

UserInviteToken
  id, projectId nullable for global invite, email, roleId,
  tokenHash unique, expiresAt, acceptedAt, revokedAt, createdAt

Role
  id, projectId nullable, name, scope(global|project),
  system, createdAt

Permission
  id, code unique, description

RolePermission
  projectId nullable, roleId, permissionId

GlobalUserRole
  id, userId, roleId, createdBy, createdAt

ProjectMembership
  id, projectId, userId, roleId, status, createdAt
```

## Project

```text
Project
  id, name, slug unique, description, status,
  timezone, locale, settings JSONB,
  createdAt, updatedAt

CrmProjectConfig
  id, projectId unique, crmProjectId,
  fieldMapping JSONB, defaultPipeline, defaultStage,
  additionalParameters JSONB, status, createdAt, updatedAt
```

CRM base URL/token в БД отсутствуют.

## Channels and contacts

```text
ChannelConnection
  id, projectId, channel, name, status,
  externalAccountId, credentialsEncrypted,
  settings JSONB, capabilities JSONB,
  lastWebhookAt, lastErrorAt, createdAt, updatedAt

Contact
  id, projectId, firstName, lastName, displayName,
  phone, email, status, automationMode,
  crmLeadId, crmContactId, crmManagerId,
  customFields JSONB, firstInteractionAt,
  lastInteractionAt, mergedIntoContactId,
  createdAt, updatedAt

ChannelIdentity
  id, projectId, contactId, connectionId, channel,
  externalUserId, externalConversationId, username,
  phone, displayName, metadata JSONB, blockedAt,
  lastInboundAt, lastOutboundAt, createdAt, updatedAt

Unique: connectionId + externalUserId

Conversation
  id, projectId, contactId, channelIdentityId,
  connectionId, channel, externalConversationId,
  status, automationModeOverride nullable, crmLeadId,
  lastInboundAt, lastOutboundAt, createdAt, updatedAt

ChannelConsent
  id, projectId, channelIdentityId, purpose,
  status, source, evidence JSONB, effectiveAt,
  createdAt, updatedAt
```

## Tags

```text
Tag
  id, projectId, name, normalizedName, color,
  description, createdAt, updatedAt

Unique: projectId + normalizedName

ContactTag
  projectId, contactId, tagId, source, createdAt

CustomFieldDefinition
  id, projectId, key, name, type, config JSONB,
  required, archivedAt, createdBy, createdAt, updatedAt

ContactCustomFieldValue
  id, projectId, contactId, definitionId,
  value JSONB plus typed query projections,
  createdAt, updatedAt

Segment
  id, projectId, name, filterSchemaVersion,
  filter JSONB, status, createdBy, createdAt, updatedAt
```

## Media

```text
MediaAsset
  id, projectId, connectionId nullable, source, status,
  providerMediaId, providerMetadata JSONB, bucketKey,
  filename, declared/detected MIME, extension, sizeBytes,
  checksum, retentionUntil, deletedAt, createdAt, updatedAt
```

## Messages/events

```text
Message
  id, projectId, conversationId, contactId,
  channel, direction, type, text, content JSONB,
  externalMessageId, status, source,
  scenarioExecutionId, broadcastId,
  error JSONB, createdAt, updatedAt

MessageStatusEvent
  id, messageId, status, externalTimestamp,
  errorCode, errorMessage, rawEventId, createdAt

RawWebhookEvent
  id, projectId, connectionId, channel,
  externalEventKey,
  safeHeaders JSONB, contentType,
  payloadRaw bytes, payloadJson JSONB nullable,
  receivedAt, purgeAfter

Unique: projectId + connectionId + externalEventKey

RejectedWebhookAttempt
  id, projectId, connectionId, provider, sourceIp,
  safeHeaders JSONB, rejectionReason, correlationId, receivedAt

InboxRecord
  id, projectId, rawWebhookEventId, provider, connectionId,
  externalEventKey, status, correlationId, attempts,
  attemptGroup, leaseOwner, leaseExpiresAt, nextAttemptAt,
  lastErrorSafe JSONB, receivedAt, processedAt, updatedAt

OutboxRecord
  id, projectId, operationType, aggregateType, aggregateId,
  idempotencyKey, payload JSONB, status, correlationId,
  attempts, attemptGroup, leaseOwner, leaseExpiresAt,
  nextAttemptAt, externalReference, resultSafe JSONB,
  lastErrorSafe JSONB, failureClass, retryable,
  unknownReason, createdAt, updatedAt

IdempotencyRecord
  id, projectId, scope, key, requestHash, status,
  resourceType, resourceId, responseSafe JSONB,
  expiresAt, createdAt, updatedAt

NormalizedEvent
  id, rawWebhookEventId, projectId, connectionId,
  channel, externalEventId, eventType,
  payload JSONB, occurredAt, createdAt

Unique: projectId + connectionId + externalEventId

OrphanMessageStatus
  id, projectId, connectionId, externalMessageId,
  externalStatusKey, status, normalizedPayload JSONB,
  occurredAt, resolutionStatus, resolvedMessageId,
  receivedAt, resolvedAt
```

## Scenarios

```text
Scenario
  id, projectId, name, description, status,
  activeVersionId, createdBy, createdAt, updatedAt

ScenarioVersion
  id, scenarioId, version, status,
  graph JSONB, variablesSchema JSONB,
  compiledDefinition JSONB, validation JSONB,
  createdBy, createdAt, publishedAt

Unique: scenarioId + version

ScenarioExecution
  id, projectId, scenarioId, scenarioVersionId,
  contactId, conversationId, triggerEventId,
  status, currentNodeId, variables JSONB,
  correlationId, startedAt, waitingAt,
  completedAt, failedAt, error JSONB

NodeExecution
  id, scenarioExecutionId, nodeId, nodeType,
  status, inputSafe JSONB, outputSafe JSONB,
  attempt, idempotencyKey, startedAt,
  completedAt, error JSONB

WaitState
  id, scenarioExecutionId, nodeId, conversationId,
  status, criteria JSONB, expiresAt,
  resolvedByEventId, createdAt, resolvedAt
```

## Templates/broadcasts

```text
MessageTemplate
  id, projectId, connectionId nullable, channel,
  name, language, category, status,
  externalTemplateId, content JSONB,
  variablesSchema JSONB, lastSyncedAt,
  createdAt, updatedAt

Broadcast
  id, projectId, connectionId, channel, name,
  status, audienceFilter JSONB, templateId,
  content JSONB, scheduledAt, startedAt,
  completedAt, createdBy, createdAt, updatedAt

BroadcastRecipient
  id, broadcastId, contactId, channelIdentityId,
  status, messageId, attempts, lastError,
  scheduledAt, sentAt, createdAt

Unique: broadcastId + channelIdentityId
```

## Secrets/audit

```text
IntegrationSecret
  id, scope, projectId nullable, name,
  encryptedValue, version, createdAt, rotatedAt

AuditLog
  as defined above
```

---

# 31. API RULES

Base:

```text
/api/v1
```

Success:

```json
{
  "data": {},
  "meta": {}
}
```

Error:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Readable message",
    "details": {},
    "correlationId": "..."
  }
}
```

Rules:

- DTO/runtime validation;
- project access guard;
- permission guard;
- cursor pagination for logs/messages;
- stable error codes;
- `Idempotency-Key` for side effects с PostgreSQL `IdempotencyRecord`;
- Origin/Referer и CSRF header validation для cookie-based state changes;
- optimistic concurrency/version для autosave draft;
- cross-project IDs проверяются composite constraints и guards.

---

# 32. API ENDPOINTS

Это target API. В первом pilot реализуются только endpoints, необходимые
этапам 1–5; WhatsApp/Instagram/broadcast endpoints остаются post-pilot.

## Auth

```text
POST /api/v1/auth/login
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
POST /api/v1/auth/logout-all
GET  /api/v1/auth/me
POST /api/v1/auth/forgot-password
POST /api/v1/auth/reset-password
```

## Projects

```text
GET    /api/v1/projects
POST   /api/v1/projects
GET    /api/v1/projects/:projectId
PATCH  /api/v1/projects/:projectId
POST   /api/v1/projects/:projectId/clone
POST   /api/v1/projects/:projectId/pause
POST   /api/v1/projects/:projectId/activate
```

## Users/Roles

```text
GET    /api/v1/users
POST   /api/v1/users
PATCH  /api/v1/users/:userId
POST   /api/v1/users/:userId/disable
POST   /api/v1/users/:userId/revoke-sessions
GET    /api/v1/roles
POST   /api/v1/roles
PATCH  /api/v1/roles/:roleId
GET    /api/v1/projects/:projectId/members
POST   /api/v1/projects/:projectId/members
PATCH  /api/v1/projects/:projectId/members/:membershipId
DELETE /api/v1/projects/:projectId/members/:membershipId
```

## Contacts/Tags

```text
GET    /api/v1/projects/:projectId/contacts
GET    /api/v1/projects/:projectId/contacts/:contactId
PATCH  /api/v1/projects/:projectId/contacts/:contactId
POST   /api/v1/projects/:projectId/contacts/:contactId/tags
DELETE /api/v1/projects/:projectId/contacts/:contactId/tags/:tagId
POST   /api/v1/projects/:projectId/contacts/merge
POST   /api/v1/projects/:projectId/contacts/bulk-tags
GET    /api/v1/projects/:projectId/contacts/:contactId/timeline
GET    /api/v1/projects/:projectId/tags
POST   /api/v1/projects/:projectId/tags
PATCH  /api/v1/projects/:projectId/tags/:tagId
DELETE /api/v1/projects/:projectId/tags/:tagId
```

## Channels

```text
GET   /api/v1/projects/:projectId/channels
POST  /api/v1/projects/:projectId/channels
GET   /api/v1/projects/:projectId/channels/:connectionId
PATCH /api/v1/projects/:projectId/channels/:connectionId
POST  /api/v1/projects/:projectId/channels/:connectionId/test
POST  /api/v1/projects/:projectId/channels/:connectionId/connect
POST  /api/v1/projects/:projectId/channels/:connectionId/disable
POST  /api/v1/projects/:projectId/channels/:connectionId/rotate-secret
```

## Scenarios

```text
GET   /api/v1/projects/:projectId/scenarios
POST  /api/v1/projects/:projectId/scenarios
GET   /api/v1/projects/:projectId/scenarios/:scenarioId
PATCH /api/v1/projects/:projectId/scenarios/:scenarioId
POST  /api/v1/projects/:projectId/scenarios/:scenarioId/versions
GET   /api/v1/projects/:projectId/scenarios/:scenarioId/versions
POST  /api/v1/projects/:projectId/scenarios/:scenarioId/validate
POST  /api/v1/projects/:projectId/scenarios/:scenarioId/test
POST  /api/v1/projects/:projectId/scenarios/:scenarioId/publish
POST  /api/v1/projects/:projectId/scenarios/:scenarioId/rollback
POST  /api/v1/projects/:projectId/scenarios/:scenarioId/pause
POST  /api/v1/projects/:projectId/scenarios/:scenarioId/duplicate
```

## Templates/Broadcasts

```text
GET    /api/v1/projects/:projectId/templates
POST   /api/v1/projects/:projectId/templates
GET    /api/v1/projects/:projectId/templates/:templateId
PATCH  /api/v1/projects/:projectId/templates/:templateId
DELETE /api/v1/projects/:projectId/templates/:templateId
POST   /api/v1/projects/:projectId/templates/sync
POST   /api/v1/projects/:projectId/templates/:templateId/test

GET   /api/v1/projects/:projectId/broadcasts
POST  /api/v1/projects/:projectId/broadcasts
GET   /api/v1/projects/:projectId/broadcasts/:broadcastId
PATCH /api/v1/projects/:projectId/broadcasts/:broadcastId
POST  /api/v1/projects/:projectId/broadcasts/:broadcastId/estimate
POST  /api/v1/projects/:projectId/broadcasts/:broadcastId/launch
POST  /api/v1/projects/:projectId/broadcasts/:broadcastId/pause
POST  /api/v1/projects/:projectId/broadcasts/:broadcastId/resume
POST  /api/v1/projects/:projectId/broadcasts/:broadcastId/cancel
POST  /api/v1/projects/:projectId/broadcasts/:broadcastId/retry-failed
GET   /api/v1/projects/:projectId/broadcasts/:broadcastId/recipients
```

## Logs/Public

```text
GET  /api/v1/projects/:projectId/logs/webhooks
GET  /api/v1/projects/:projectId/logs/executions
GET  /api/v1/projects/:projectId/logs/messages
GET  /api/v1/projects/:projectId/logs/requests
GET  /api/v1/projects/:projectId/audit
POST /api/v1/projects/:projectId/logs/:logType/:id/retry

POST /webhooks/telegram/:connectionId
GET  /webhooks/meta/whatsapp/:connectionId
POST /webhooks/meta/whatsapp/:connectionId
GET  /webhooks/meta/instagram/:connectionId
POST /webhooks/meta/instagram/:connectionId
POST /integrations/crm/events
```

---

# 33. FRONTEND ROUTES

```text
/login
/forgot-password
/reset-password
/app/projects
/app/projects/new
/app/:projectId/overview
/app/:projectId/contacts
/app/:projectId/contacts/:contactId
/app/:projectId/scenarios
/app/:projectId/scenarios/new
/app/:projectId/scenarios/:scenarioId
/app/:projectId/broadcasts
/app/:projectId/broadcasts/new
/app/:projectId/broadcasts/:broadcastId
/app/:projectId/templates
/app/:projectId/channels
/app/:projectId/channels/:connectionId
/app/:projectId/integrations
/app/:projectId/tags
/app/:projectId/users
/app/:projectId/roles
/app/:projectId/logs
/app/:projectId/audit
/app/:projectId/settings
```

---

# 34. FLOW EDITOR UI

Первый pilot реализует минимальный editor только для pilot node types. Полный
toolbar, External Request editor и advanced debugger относятся к post-pilot.

Toolbar:

- scenario name;
- save state;
- undo/redo;
- zoom/fit;
- validate;
- test;
- publish;
- pause;
- versions.

Node palette groups:

```text
Triggers
Messages
Logic
CRM
HTTP/API
Contact
Timing
Flow control
```

Node card:

- icon/type;
- title;
- summary;
- validation state;
- channel badges;
- success/error handles.

Properties panel:

- dynamic form;
- variable picker;
- capability warnings;
- test action;
- validation errors;
- duplicate/delete.

External request editor:

- method;
- URL;
- headers table;
- body editor;
- variables;
- test contact;
- Test Request;
- response preview;
- response mapping;
- timeout/retry.

JSON editor:

- syntax errors;
- formatted preview;
- variables;
- no secret exposure.

---

# 35. SECURITY

Secrets:

- encrypted at application layer;
- master key from env;
- never returned after save;
- masked UI;
- versioned rotation;
- authenticated encryption such as AES-GCM.

Webhook verification:

- Telegram secret header;
- Meta challenge + SHA-256 signature over raw body;
- constant-time compare;
- CRM HMAC + timestamp + replay window.
- signature проверяется до raw body persist;
- invalid raw body не сохраняется;
- invalid attempt содержит только provider, connectionId, time, IP,
  allowlisted/redacted headers, reason и correlation ID;
- body hard limit 2 MB.

External Request SSRF protection:

- block loopback;
- block link-local;
- block private ranges by default;
- block metadata endpoints;
- HTTPS only in production;
- validate redirects;
- response size and timeout limits.

Access control:

```text
authenticated
AND membership/global admin
AND permission
```

Other:

- login/password-reset rate limit;
- opaque refresh rotation/family/reuse detection;
- synchronizer CSRF token и Origin/Referer validation;
- signed storage URLs;
- private bucket;
- bucket доступен по публичной сети и не считается private network;
- MIME/size/extension validation и retention/delete jobs;
- minimal PII in logs;
- export by permission;
- dependency/secret scanning in CI.

---

# 36. OBSERVABILITY

Structured JSON logs:

```text
timestamp
level
service
environment
correlationId
projectId
connectionId
executionId
safeMessage
errorCode
```

Technical metrics:

- webhooks received/invalid;
- queue depth;
- job duration/failures;
- outbound failures;
- CRM latency/failures;
- scenario duration;
- broadcast progress.

Prepare Sentry-compatible integration.

Alerts:

- channel disconnected;
- webhook errors spike;
- stalled queue;
- CRM errors spike;
- worker unavailable;
- DB unavailable.

Retention pilot:

```text
technical logs: 30 days
audit: 180 days
valid raw webhook payload: 30 days
```

Retention выполняют наблюдаемые idempotent jobs. Удаление raw payload не должно
ломать минимальную correlation projection.

---

# 37. PERFORMANCE И НАДЁЖНОСТЬ

- webhook не ждёт CRM/scenario/outbound;
- webhook подтверждается только после durable inbox commit;
- raw webhook body максимум 2 MB;
- response будущего External HTTP Request максимум 5 MB;
- broadcast size для pilot неприменим;
- all large lists server paginated;
- worker stateless and horizontally scalable;
- distributed locks/idempotency, no in-memory locks;
- graceful shutdown;
- indexes for project/date, identity, conversation/messages, dedupe, scenario status, broadcast status.

Worker shutdown:

1. stop taking new jobs;
2. finish current jobs within timeout;
3. return unfinished jobs;
4. close Redis/DB.

Disaster recovery pilot:

```text
RPO: 24 hours
RTO: 4 hours
```

Обязательны configured backups и документированная restore verification до
завершения pilot.

---

# 38. TESTING

Unit:

- variable resolver;
- conditions;
- template renderer;
- graph validator;
- cycle guard;
- Telegram parser;
- WhatsApp parser;
- signature verification;
- dedupe key;
- CRM mapper;
- HTTP response mapping;
- rate limit;
- permissions;
- refresh rotation/reuse detection;
- CSRF validation;
- inbox/outbox transitions;
- lease recovery;
- unknown/reconciliation;
- tenant-safe relation guards.

Integration flows:

```text
Telegram webhook → queue → contact → scenario → CRM mock → outbound mock
CRM mock callback/result → conversation → outbound
Duplicate webhook → no duplicate effects
```

WhatsApp, Broadcast и advanced HTTP flows добавляются после pilot. Pilot
integration дополнительно:

```text
Inbox commit → BullMQ signal lost → PostgreSQL relay restores job
Outbox provider timeout after possible effect → unknown → reconciliation
Paused project webhook → deferred → resume
Invalid signature → safe metadata only, no raw payload
Status before message → orphan → resolved
```

E2E:

- login;
- create project;
- add user;
- create tag;
- connect mock channel;
- create/publish scenario;
- inspect contact;
- permissions;
- audit.

Failure tests:

- CRM timeout;
- Telegram 429;
- invalid signature;
- Redis unavailable;
- duplicate event;
- out-of-order status;
- blocked user;
- unknown side effect;
- worker restart during side effect.

Fixtures:

```text
packages/test-fixtures/telegram
packages/test-fixtures/crm
```

WhatsApp/Instagram fixtures добавляются только на соответствующем post-pilot
этапе.

---

# 39. CI/CD

PR checks:

```text
install
format check
lint
typecheck
unit tests
integration tests
build
prisma validate
```

Deploy:

- staging automatic after selected branch merge;
- production after manual confirmation/tag;
- migrations as pre-deploy;
- staging/dev seed only;
- production seed never deletes data.

---

# 40. ENVIRONMENT VARIABLES

```env
NODE_ENV=
APP_ENV=
WEB_URL=
API_PUBLIC_URL=
DATABASE_URL=
REDIS_URL=
JWT_ACCESS_SECRET=
JWT_ACCESS_TTL_SECONDS=
REFRESH_TOKEN_TTL_SECONDS=
REFRESH_COOKIE_NAME=
REFRESH_COOKIE_DOMAIN=
ENCRYPTION_MASTER_KEY=
CRM_BASE_URL=
CRM_AUTH_TOKEN=
CRM_WEBHOOK_SECRET=
STORAGE_ENDPOINT=
STORAGE_REGION=
STORAGE_BUCKET=
STORAGE_ACCESS_KEY_ID=
STORAGE_SECRET_ACCESS_KEY=
SENTRY_DSN=
CORS_ALLOWED_ORIGINS=
TRUST_PROXY=
WEBHOOK_MAX_BODY_BYTES=2097152
EXTERNAL_RESPONSE_MAX_BYTES=5242880
TECHNICAL_LOG_RETENTION_DAYS=30
AUDIT_RETENTION_DAYS=180
RAW_WEBHOOK_RETENTION_DAYS=30
```

Channel secrets хранятся зашифрованно через UI, а не отдельными env на каждый проект.

Refresh token является opaque value и не подписывается отдельным JWT secret.
Значения cookie domain/SameSite/secure policy валидируются для конкретного
deployment topology.

---

# 41. ПЛАН РЕАЛИЗАЦИИ

Подробный исполнимый план находится в `docs/IMPLEMENTATION_PLAN.md`.

## Этап 0. Scaffold и ADR

- monorepo и empty app shells;
- shared packages;
- PostgreSQL/Redis/Prisma;
- local Docker Compose;
- environment validation;
- CI/checks;
- health/graceful shutdown;
- Railway-ready commands;
- ADR, database proposal и runbook skeleton.

На текущем документальном шаге Этап 0 ещё не запускается.

## Этап 1. Auth, RBAC, Projects

- JWT access token;
- opaque refresh rotation/family/reuse detection;
- CSRF;
- users/invites/reset;
- roles/permissions/global roles/memberships;
- projects и formal transitions;
- project isolation;
- audit baseline.

## Этап 2. Contacts, Tags, Custom Fields

- contacts/identities;
- tags;
- custom field definitions и typed values;
- segment schema foundation;
- channel consent foundation;
- automation mode inheritance;
- list/card/filters/timeline foundation.

## Этап 3. Inbox/Outbox и Telegram Adapter

- transactional inbox/outbox;
- idempotency records;
- relay, leases, recovery, retry/unknown/reconciliation foundation;
- Telegram connection/webhook;
- invalid webhook safe metadata;
- normalization;
- contacts/messages/orphan statuses;
- lazy media metadata;
- logs/tests.

Критерий: Telegram webhook надёжно фиксируется в PostgreSQL, создаёт один
contact/message и восстанавливается после потери Redis job.

## Этап 4. Минимальный Automation Runtime

- scenario CRUD/draft/version/publish;
- deterministic validator/compiler;
- Incoming Message;
- Condition;
- Create/Update Lead port;
- Forward to CRM port;
- Send Message;
- Add/Remove Tag;
- execution/node logs;
- minimal pilot editor.

Не входят Delay, Wait, Subflow и External HTTP Request.

## Этап 5. CRM Adapter и полный Telegram ↔ CRM pilot

- `CrmClient`;
- mock adapter и fixtures;
- `CrmProjectConfig`;
- CRM operations через outbox;
- mock callback/reply;
- retries/unknown/reconciliation/manual retry;
- полный Telegram ↔ CRM mock flow;
- Railway staging deployment;
- backup restore verification.

Production CRM adapter разрешён только после contract review из
`docs/CRM_CONTRACT_REQUIRED.md`.

## После успешного pilot

- production CRM adapter, если pilot был mock-only;
- Delay/Wait/Subflow и advanced automation;
- WhatsApp;
- broadcasts;
- External HTTP Request;
- расширенные media workflows;
- Instagram только после отдельного подтверждения.

Security, tenant isolation, inbox/outbox, audit и observability baseline не
откладываются в post-pilot hardening.

---

# 42. ACCEPTANCE CRITERIA ПЕРВОГО PILOT

## Auth

- login работает;
- protected routes закрыты;
- backend permissions работают;
- admin деактивирует user;
- sessions can be revoked.
- refresh rotation/reuse detection работает;
- cookie-based state change без CSRF отклоняется.

## Projects

- можно создать минимум два проекта;
- данные изолированы;
- разные роли по проектам;
- clone не копирует contacts/secrets/history.

## Contacts

- first message создаёт contact;
- repeated message не создаёт duplicate;
- identity сохраняется;
- tags/filters работают;
- timeline виден.
- custom field type validation работает;
- conversation automation override имеет ожидаемый приоритет.

## Telegram

- token validated;
- webhook installed;
- secret verified;
- inbound text received;
- durable inbox создаётся до acknowledgement;
- duplicate update не создаёт повторных effects;
- потерянный BullMQ job восстанавливается из PostgreSQL;
- invalid signature не сохраняет raw body;
- outbound reply отправляется через outbox;
- 429/blocked handled;
- unknown delivery не retry-ится вслепую.

## CRM

- mock adapter получает create/update lead command;
- crmLeadId saved;
- later messages forwarded with lead ID;
- mock CRM callback/result sends response;
- duplicate CRM event gives no duplicate message;
- retryable outage retries;
- uncertain outcome становится unknown и проходит reconciliation;
- production adapter остаётся blocked без CRM contract.

## Scenarios

- drag-and-drop flow can be created;
- nodes connected;
- invalid flow cannot publish;
- published flow starts from real event;
- execution visible;
- draft does not change active version;
- rollback works.
- pilot nodes ограничены Incoming, Condition, CRM ports, Send Message и Tag;
- branch priority и strict null/type rules работают;
- unguarded cycle нельзя publish;
- events одной conversation обрабатываются последовательно.

## Security

- secrets never returned;
- logs redacted;
- invalid signature rejected;
- SSRF protected;
- project isolation tested;
- saved secret cannot be read back.
- tenant-safe DB constraints протестированы;
- refresh token plaintext отсутствует в БД/logs;
- raw webhook body больше 2 MB отклоняется.

## Operations

- Railway staging deploy работает;
- technical logs/raw/audit retention настроены;
- backups настроены;
- restore проверен и задокументирован;
- подтверждены RPO 24 часа и RTO 4 часа.

WhatsApp, Instagram, broadcasts, Delay, Wait, Subflows, External HTTP Request и
advanced media не являются acceptance criteria первого pilot.

---

# 43. DEFINITION OF DONE

Задача завершена, когда:

- implementation complete;
- TypeScript strict passes;
- lint passes;
- tests pass;
- migration created, если изменяется database schema;
- Swagger updated;
- loading/error/empty states added;
- permissions checked;
- audit added where needed;
- secrets not logged;
- docs updated;
- production build passes;
- Railway deploy works, если задача/этап включает deployment;
- acceptance criterion confirmed.

Для внешнего side effect дополнительно:

- outbox/idempotency state покрыт тестами;
- retryable/permanent/unknown классификация определена;
- reconciliation/manual retry и audit предусмотрены.

---

# 44. CODE RULES

TypeScript:

- strict;
- no `any` without justification;
- discriminated unions;
- exhaustive switch;
- shared contracts;
- all external data runtime validated.

Backend modules:

```text
AuthModule
UsersModule
RolesModule
ProjectsModule
ContactsModule
TagsModule
ChannelsModule
WebhooksModule
MessagesModule
ScenariosModule
AutomationModule
TemplatesModule
BroadcastsModule
CrmModule
IntegrationsModule
LogsModule
AuditModule
HealthModule
```

Stable error codes:

```text
AUTH_INVALID_CREDENTIALS
FORBIDDEN
PROJECT_NOT_FOUND
CHANNEL_CONNECTION_FAILED
WEBHOOK_INVALID_SIGNATURE
DUPLICATE_EVENT
SCENARIO_VALIDATION_FAILED
TEMPLATE_NOT_APPROVED
MESSAGE_WINDOW_CLOSED
CRM_UNAVAILABLE
EXTERNAL_REQUEST_FAILED
BROADCAST_CANCELLED
```

Dates:

- store UTC;
- display project timezone;
- ISO 8601 in API.

IDs:

- UUID or ULID;
- provider IDs as strings;
- never assume numeric range.

---

# 45. EDGE CASES

Формальная таблица
`условие → ожидаемое действие → итоговый статус → retry → audit` находится в
`docs/EDGE_CASES.md` и является обязательной для реализации/tests.

Ключевые правила:

- duplicate не повторяет domain/outbound effect;
- status before message сохраняется в `OrphanMessageStatus`;
- uncertain external outcome становится `unknown`, blind retry запрещён;
- paused project сохраняет валидный webhook как deferred;
- события одной conversation сериализуются;
- все matching scenarios запускаются без гарантии взаимного порядка;
- reply/timeout race разрешается одной conditional transaction;
- disabled channel не начинает новые outbound calls;
- unguarded cycle блокирует publish.

Таблица покрывает:

- duplicate webhook;
- status before message record;
- bot blocked/deleted;
- CRM unavailable;
- duplicate CRM callback;
- published version plus changed draft;
- wait timeout;
- two scenarios on same event;
- two messages simultaneously;
- contact merge with active executions;
- template rejected after broadcast draft;
- broadcast cancelled with running jobs;
- worker crash after external side effect before DB save;
- HTTP 200 with invalid JSON;
- redirect to private network;
- Telegram retry_after;
- Meta temporary/permanent errors;
- expired media URL;
- timezone differences;
- paused project still receives webhooks;
- disabled channel has queued messages;
- secret rotated during delivery.

---

# 46. MIGRATION FROM MANYCHAT

Цель — переход без остановки лидогенерации.

Порядок:

1. ManyChat продолжает работать.
2. Omnicus поднимается в staging.
3. Текущие flows воспроизводятся вручную.
4. Сравниваются CRM payload и responses.
5. Тестируются test contacts.
6. Production webhook/channel переключается в согласованное окно.
7. Проверяется lead creation и reply.
8. ManyChat отключается после подтверждения.
9. Есть rollback plan.

Автоматический универсальный импорт ManyChat flow не входит.

«Перенос с минимальными изменениями» означает воспроизведение логики и mapping, а не импорт закрытого внутреннего формата ManyChat.

---

# 47. ДОКУМЕНТАЦИЯ В РЕПОЗИТОРИИ

Codex должен создать:

```text
README.md
AGENTS.md
docs/PRODUCT.md
docs/ARCHITECTURE.md
docs/DECISIONS.md
docs/DATABASE.md
docs/STATE_MACHINES.md
docs/EDGE_CASES.md
docs/API.md
docs/AUTOMATION_ENGINE.md
docs/CHANNEL_TELEGRAM.md
docs/CHANNEL_WHATSAPP.md
docs/CHANNEL_INSTAGRAM.md
docs/CRM_INTEGRATION.md
docs/CRM_CONTRACT_REQUIRED.md
docs/SECURITY.md
docs/RAILWAY.md
docs/RUNBOOK.md
docs/TESTING.md
docs/IMPLEMENTATION_PLAN.md
```

Runbook объясняет:

- webhook diagnostics;
- failed job retry;
- channel disable;
- broadcast stop;
- secret rotation;
- worker recovery;
- rollback;
- CRM outage response.

---

# 48. ПЕРВЫЙ PROMPT ДЛЯ CODEX

```text
Прочитай OMNICUS_GLOBAL_TECH_SPEC_CODEX.md полностью.

Пока не реализовывай продукт.

Сначала:
1. Составь подробный план реализации по этапам.
2. Найди противоречия и недостающие решения.
3. Предложи точную структуру monorepo.
4. Предложи Prisma model для первых этапов.
5. Составь environment variables.
6. Создай AGENTS.md и docs/IMPLEMENTATION_PLAN.md.
7. Зафиксируй решения в docs/DECISIONS.md.
8. Укажи, что можно реализовать без реальных Telegram/Meta/CRM credentials.

После этого остановись и дай отчёт. Не начинай реализацию модулей без подтверждения.
```

---

# 49. ВТОРОЙ PROMPT ДЛЯ CODEX

```text
Реализуй Этап 0 из OMNICUS_GLOBAL_TECH_SPEC_CODEX.md.

Требования:
- pnpm monorepo;
- apps/web, apps/api, apps/worker;
- shared packages;
- React + Vite + TypeScript + Ant Design;
- NestJS API и worker;
- PostgreSQL + Prisma;
- Redis + BullMQ;
- health endpoints;
- environment validation;
- lint, typecheck, tests, build;
- local Docker Compose;
- Railway-ready start commands.

Пока не реализовывай Telegram, WhatsApp, CRM и flow builder.
После выполнения запусти проверки и дай отчёт с файлами, командами и рисками.
```

---

# 50. ФИНАЛЬНОЕ ОПРЕДЕЛЕНИЕ

Omnicus:

```text
Multi-project administration
+
Contact and channel identity database
+
Telegram / WhatsApp / optional Instagram adapters
+
Reliable webhook processor
+
Visual scenario builder
+
Automation execution engine
+
External HTTP request node
+
Single CRM bridge with project context
+
Message templates
+
Telegram and WhatsApp broadcasts
+
Logs, retries, audit and permissions
```

Omnicus не является новой CRM.

Первый pilot доказывает только:

```text
Auth/RBAC/Projects
+
Contacts/Tags/Custom Fields
+
Telegram
+
PostgreSQL Inbox/Outbox
+
Minimal Automation Runtime
+
CRM Mock Adapter
+
Execution Logs
+
Railway Staging
```

Остальные компоненты итогового продукта являются post-pilot backlog.

Главная ответственность:

```text
Принять событие
→ определить проект, канал и контакт
→ выполнить сценарий
→ передать данные в CRM
→ принять ответ CRM
→ отправить его пользователю
```

---

# 51. OFFICIAL DOCUMENTATION TO VERIFY

Перед реализацией каждого adapter обязательно сверять актуальные официальные документы:

```text
Telegram Bot API
https://core.telegram.org/bots/api

Telegram Bot FAQ
https://core.telegram.org/bots/faq

WhatsApp Business Platform
https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform

WhatsApp Webhooks
https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview

WhatsApp Templates
https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview

Instagram Platform
https://developers.facebook.com/documentation/instagram-platform

Instagram Webhooks
https://developers.facebook.com/documentation/instagram-platform/webhooks

Railway Docs
https://docs.railway.com/
```

Graph API versions, permissions, templates, event fields, message types и limits не предполагать по памяти. Выносить provider version в adapter/config и проверять перед интеграцией.

---

# КОНЕЦ ДОКУМЕНТА

---

# 52. NORMATIVE IMPLEMENTATION ADDENDUM - 2026-08-08

This addendum supersedes the original pre-implementation status statements
where they conflict with the deployed post-pilot product. The durable,
idempotent and project-isolation requirements above remain unchanged.

1. Telegram, official WhatsApp Cloud API, Cyber Pulse CRM integration,
   broadcasts, Automation Studio 2.2, Operations/Audit and System Health are
   implemented. Instagram and audio calls remain out of scope.
2. Editing a CRM-linked contact must update the existing project-scoped CRM
   lead. Matching name, email, phone or username must never cause an implicit
   merge.
3. Explicit contact merge must leave one primary Omnicus contact and one
   surviving CRM lead while preserving both Telegram and WhatsApp histories.
   The CRM side effect is a durable idempotent outbox operation. Historical
   merge evidence is reconciled only by the bounded dry-run-first backfill.
4. Telegram scheduling may be one-shot or bounded DAILY/WEEKLY recurring.
   WhatsApp scheduling is one-shot text only, must fit inside the currently
   open service window and must repeat that guard before provider delivery.
5. Telegram and WhatsApp voice media preserve duration metadata. Telegram
   video note is upload-only. Every attachment kind uses channel-specific MIME,
   signature, size and dimension validation before a provider intent is queued.
6. Machine contracts in `OMNICUS_TO_CRM_OPENAPI.yaml` and
   `OMNICUS_CRM_OUTBOUND_OPENAPI.yaml`, accepted ADRs and state machines define
   the exact current request/transition behavior.

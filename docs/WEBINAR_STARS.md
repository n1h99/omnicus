# Webinar Stars: integration and joint acceptance

Status 2026-11-03: ADR-067 and ADR-068 are implemented locally. Omnicus has durable report import, webhook recovery, matching, invitations, website registration, automation and CRM delivery. The counterpart is implemented in the existing Golden Visa staging worktrees (`cyber-pulse-back-meta-budget`, `cyber-pulse-front-meta-budget`). Rollout was authorized on 2026-11-03. Both migrations have been applied to Omnicus production (40 total, checksums verified, none pending). Runtime rollout targets Omnicus production and Golden Visa staging; actual provider acceptance and workflow activation remain separate checks.

## Verified rollout - 2026-11-03

- Omnicus production API, Web and Worker: code commit `2d74257`, all Railway deployments SUCCESS.
- Golden Visa staging backend: `4ad95bc`; frontend: `fa8f178`, both SUCCESS.
- Omnicus PostgreSQL: both webinar migrations applied, 40 total, none pending.
- Public API/Web readiness returns HTTP 200; PostgreSQL and Redis report up.
- API and Worker startup confirmed; sampled deployment logs contain no errors.
- Deployed web bundle contains the webinar workflow. CRM staging health returns 200,
  and the authenticated connection probe advertises `webinarContractVersion: webinars/v1`.
- Live webinar processing, invitation/scenario publishing and provider acceptance are
  separate operator steps. Begin by re-testing the existing CRM connection in Omnicus
  to refresh its advertised capabilities, then connect/test Webinar Stars.

## Источники и уровень подтверждения

- Пользователь передал HTML вкладки API из своего кабинета Webinar Stars
  и три скриншота вкладки Webhook 2026-11-02.
- Выполнены три ограниченных GET-запроса к API этого аккаунта. Результаты ниже.
- Примеры из кабинета являются документацией, а не записанными ответами
  действующего вебинара. Реальные участники и доставка webhook ещё не проверены.
- Версия API в переданном описании не указана; дату проверки нельзя считать
  версией API. Секреты и персональные данные в этот файл не включены.

## API из кабинета

Базовый адрес: `https://efir.webinar-stars.com/api/`.
В примерах запросов чтения используется GET и query-параметр `token`.
URL с токеном нельзя сохранять в журналы и тексты ошибок.

| Метод                 | Параметры помимо token                                                                    | Назначение                     |
| --------------------- | ----------------------------------------------------------------------------------------- | ------------------------------ |
| `get_reports/`        | `from`, `to`, `limit` (по умолчанию 100), `offset`, `search`                              | Список отчётов                 |
| `get_report/`         | обязательный `report`, необязательный `unique`                                            | Один отчёт и его участники     |
| `get_current_report/` | `webinar` (ID через запятую), `type`                                                      | Текущие сессии и присутствие   |
| `get_webinars/`       | `status`, `webinar`, `search`, `limit` (по умолчанию 100, максимум 500), `offset`, `full` | Вебинары, комнаты и расписание |
| `get_timezones/`      | нет                                                                                       | Справочник часовых поясов      |

У `get_report` значение `unique=1` объединяет дубли средствами провайдера,
`unique=0` или отсутствие параметра не объединяет их. Правила объединения
нужно проверить перед использованием для расчёта посещений.

Описаны POST-операции `webinar_create`, `webinar_update`, `webinar_start`,
`webinar_stop`. Они не вызывались. Их наличие не расширяет автоматически
первый этап интеграции до управления эфирами.

Документированные ошибки: `error=0` означает успех, `1` означает отказ в
доступе, `2` означает ошибку токена. Для отдельного отчёта также описана
ошибка `11` (не существует). HTTP 200 сам по себе не подтверждает успех.

### Неоднозначности документации

- Для отдельного отчёта таблица называет поле `reports`, а пример ответа
  использует `report`.
- Примеры смешивают JSON, PHP-синтаксис и текст без кавычек. Их нельзя
  использовать как реальные JSON fixtures без проверки.
- Время в текущем отчёте описано как локальное время вебинара. Строки без
  смещения нельзя автоматически трактовать как UTC. Правила времени для
  остальных методов и переходов летнего времени ещё нужно уточнить.
- Типы ID и счётчиков в примерах различаются: числа и строки. Отрицательные
  значения `visitor_id` присутствуют в примере; их нельзя отвергать по знаку.
- Статусы `buttons_info`, единицы `duration`, значение `once`, полнота
  истории повторных входов и максимальный размер отчёта ещё не проверены.
- `get_current_report` документирует `online_now`, `visitors[].online`,
  `visitors[].entered_at` и `no_active_session`. Это возможность опроса API,
  а не подтверждение realtime webhook входа, выхода или CTA.

## Webhook из кабинета

На скриншотах выбран формат `POST`, отправка включена, поле URL пустое.
Есть кнопка добавления URL; фактическая доставка на несколько адресов не проверена.
Конкретный Content-Type и кодирование тела по скриншотам неизвестны:
надпись POST не доказывает JSON или form-urlencoded.

Документированный пример содержит:

- `action = webinar_end`;
- `data.id` (ID отчёта по примеру);
- `data.webinar_name`, `data.webinar_id`;
- `data.date_start`, `data.date_end`, `data.duration`, `data.once`;
- `data.visitors_count`, `data.visitors_peak`.

Участников в примере нет: уведомление служит поводом получить отчёт через API.
Фактический payload, Content-Type, подпись, retry, timeout и требуемое тело
HTTP-ответа ещё предстоит проверить. Отсутствие этих настроек на скриншоте
не доказывает отсутствие возможностей у провайдера.

Для режима «старт одразу» предлагается отправлять webhook один раз в сутки
или по каждому просмотру. На скриншоте выбран один раз в сутки. Поэтому
нельзя предполагать отдельное немедленное событие для каждого зрителя.
Нужно проверить, изменяется ли один отчёт при последующих просмотрах:
дедупликация доставки не должна запрещать импорт новой версии того же отчёта.

## Выполненная проверка API

2026-11-02, только чтение; содержимое аккаунта не изменялось:

| Запрос                                                                   | Реальный результат                                                         |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `get_webinars`, `limit=1`, `offset=0`                                    | HTTP 200, JSON, `error=0`, `total=0`, `webinars=[]`                        |
| `get_reports`, `limit=1`, `offset=0`, `from=2026-01-01`, `to=2026-11-03` | HTTP 200, JSON, `error=0`, `reports=[]`; поле `num_rows` имеет тип string  |
| `get_timezones`                                                          | HTTP 200, JSON, `error=0`, 28 элементов; поля `id`, `name`, `offset_hours` |

Это подтверждает работоспособность авторизации и пустых ответов, но не
получение участников, обработку пагинации с данными или доставку webhook.

## Подготовка к совместной проверке

1. Применить обе новые миграции PostgreSQL при выпуске Omnicus:
   `20261102100000_webinar_stars_connection` и `20261103000000_webinar_lifecycle`.
   Обновить API, Web и Worker. Импорт выполняет API, доставку событий — Worker.
2. Выпустить backend и frontend Golden Visa CRM из подготовленных staging
   worktrees. При старте backend создаёт индексы новых MongoDB collections.
   Автомобильная CRM `main` этой реализацией не изменена.
3. В Omnicus проверить существующее подключение CRM заново: оно должно сообщить
   `webinarContractVersion: webinars/v1`. Без этой возможности отправка результатов
   останавливается с понятной ошибкой. Контракт: [OpenAPI](WEBINAR_CRM_OPENAPI.yaml).
4. Connections → Webinar Stars: сохранить API token, выполнить Test connection.
   Замена ключа ставит обработку на паузу и требует повторного теста.
5. Создать тестовую комнату на Webinar Stars и добавить её в Sessions:
   ID, точный URL комнаты, название, начало/окончание и IANA timezone.
   Add session сохраняет сессию в Omnicus; создание/запуск/остановка эфира
   выполняются в кабинете Webinar Stars.
6. В Settings указать только подтверждённые названия параметров автологина,
   передачи имени/email/телефона, tracking token и distributor ID. По умолчанию
   эти параметры пустые. Omnicus уже выдаёт собственную персональную ссылку;
   заполнение формы входа провайдера требует подтверждённых параметров.
7. Указать реальные значения статусов клика/просмотра кнопки из тестового отчёта.
   Неизвестное значение остаётся неизвестным. Replay задаётся явно для сессии;
   оно не выводится из недокументированного `once`.
8. Включить обработку; Generate webhook URL показывает новый адрес один раз.
   Вставить его в кабинет провайдера, выбрать POST и отправку `webinar_end`.
   Повторная генерация меняет адрес. Для проверки допускаются JSON и обычный
   вложенный form-urlencoded; фактическое кодирование провайдера нужно проверить.

## Регистрация, приглашения и автоматизации

В Sessions → Register contacts можно зарегистрировать существующие контакты
проекта и получить персональные ссылки. UTM и distributor ID сохраняются отдельно.
Повторная регистрация выдаёт ту же ссылку и не дублирует события.

Для формы сайта задайте Website registration source key в настройках сессии.
Website form setup выдаёт конфигурацию существующего lead-capture endpoint
с `metadata.webinarEventId`. Запрос отправляет backend сайта с ingestion key
и уникальным Idempotency-Key. Ключ нельзя включать в публичный JavaScript.
Ответ содержит participantUrl. Повтор запроса сохраняет контакт/ссылку;
конфликт email/телефона нескольких контактов требует решения оператором.

В Automation Studio создайте и опубликуйте сценарии с Incoming trigger →
Webinar event. Доступны регистрация, напоминание, плановое начало, получение
и обновление отчёта, посещение, пропуск, полный/частичный просмотр, CTA,
баннер, комментарий и просмотр записи. «Начало» означает время расписания
Omnicus, а не подтверждение старта трансляции провайдером.

События регистрации/напоминания передают `event.invitation.participantUrl`
и сведения о сессии. Напоминания по умолчанию: 1440, 60 и 10 минут.
Отменённые/завершившиеся сессии не отправляют просроченные напоминания.
При паузе новые приглашения сохраняются без событий; включите обработку
до тестовой регистрации. Изменение Settings применяется к новым приглашениям;
уже поставленные напоминания сохраняют исходное расписание.

Сообщения отправляют существующие Send email / Telegram / WhatsApp nodes:
выберите канал и шаблон, добавьте персональную ссылку. Действуют обычные
consent, доступность адресата и ограничения канала. Webinar CRM action
позволяет установить отдельный приоритет LOW/NORMAL/HIGH или создать задачу
менеджеру с заголовком, описанием и сроком. CRM-узел требует контекста отчёта.
Сценарии и шаблоны не публикуются автоматически.

## Импорт, сопоставление и доставка

Webhook сохраняет ограниченную квитанцию и задачу импорта в одной транзакции.
Периодический опрос последних семи дней восстанавливает пропущенные уведомления
и получает изменившиеся версии отчётов. Старые отчёты доступны через Saved reports.
Historical включён по умолчанию: просмотр/сопоставление разрешены, сообщения
и изменения CRM подавлены. Live import требует подходящей сессии после включения.

Если Webinar Stars после записи эфира указал в отчёте ID созданного автовебинара,
оператор может явно выбрать исходную сессию при импорте в Historical. Её часовой
пояс и подтверждённые статусы применяются к расчётам, исходный ID отчёта сохраняется.
Это исключение не включает рассылки, CRM или автоматическое сопоставление разных
вебинаров. Live import по-прежнему требует совпадения ID; отменённая сессия недоступна.

Matching использует tracking invitation, затем нормализованные email/телефон.
Имена не объединяют контакты. Неоднозначные участники доступны для Match contact,
Create contact (дополнительно нужны `contacts:create`) или Ignore. После решения
отчёт пересчитывается. Неопределённые участники задерживают вывод «не посетил».
Несколько входов объединяются; пересекающиеся интервалы не удваивают время.
Невалидное/неоднозначное локальное время и отсутствующие поля остаются неизвестными.
Процент считается по фактическому интервалу отчёта, порог полного просмотра — 90%.

Delivery log показывает обработку события сценариями и передачу в CRM.
Успех AUTOMATION означает создание executions/outbox существующего движка;
доставку письма/сообщения проверяйте в его журнале. UNKNOWN в CRM сначала
сверяется с журналом операции. Кнопка Reconcile не делает слепой повтор записи.
CRM должна уже иметь однозначную связь с контактом: при её отсутствии доставка
ожидает связку. В карточке лида вкладка Webinars показывает результаты,
комментарии, UTM, приоритет и задачи. Завершить задачу может её исполнитель/admin.

Disconnect стирает сохранённый ключ и отключает обработку; история остаётся.
Сырые отчёты из вкладки Reports читаются по запросу, а импортированные результаты
сохраняются в PostgreSQL. Данные участников доступны пользователям проекта
с правом `integrations:manage`; вебхуки не сохраняют исходное произвольное тело.

## Совместный лайв-тест

- Зарегистрировать два тестовых контакта: один посетит эфир, второй пропустит.
  Повторить регистрацию с тем же ключом; проверить одну ссылку и одно приглашение.
- Проверить доставку приглашения, короткого тестового напоминания и ссылку
  в выбранном канале. Установить известные email/телефон и tracking mapping.
- Войти, выйти, повторно войти; оставить комментарий, увидеть и нажать CTA/баннер.
  Зафиксировать фактический обезличенный API payload и значения статусов.
- Завершить эфир. Проверить webhook, сохранённый отчёт, объединение входов,
  длительность, частичный/полный просмотр и отсутствие ложного «не посетил».
- Повторить webhook и импорт того же отчёта: без дублей сообщений, истории и задач.
  Проверить обновление изменившегося отчёта, включая режим «старт одразу».
- Создать конфликт email/телефона, решить через Matching; проверить пересчёт.
- Проверить соответствующие сценарии и CRM Webinars, отдельный приоритет,
  задачу ответственного и ограничения её выполнения другим пользователем.
- Временно отключить CRM, восстановить связь, нажать Reconcile; результат должен
  появиться один раз. Импорт старого отчёта в Historical не должен отправить сообщения.

Автоматические проверки дополняют этот список; они не подтверждают реальные
параметры автологина, webhook Content-Type и доставку в аккаунт провайдера.

## Telegram invitation routing correction - 2026-11-03

The first live registration exposed a missing messenger conversation route: webinar
triggers have no inbound conversation, and explicit Telegram delivery was attempting
an empty conversation ID. The Message foreign key rejected it; the whole automation
transaction rolled back and the durable webinar action retried. No outbound message
had been created or sent by those failed attempts.

Explicit Telegram steps now resolve the existing private conversation using the
project, selected bot and active identity external user ID. The conversation must
belong to the same contact, remain active and permit automation. The execution and
runtime context retain the selected conversation for subsequent steps. Group/other
bot conversations are not used as a fallback. Missing or conflicting routes fail
before message/outbox creation. Existing published scenarios are unchanged.

Six route regression cases pass (166 worker tests total). A rollback-only check of
the actual published invitation graph now completes with one Message and one outbox
intent. Recovery reschedules only the original failed registration action, with an
audit record and unchanged deduplication identity; it does not register the contact
again or send directly through the Telegram API.

Live recovery confirmed, 2026-11-03 04:59 UTC: worker `8b8453f` is SUCCESS in
Railway. The original registration action was rescheduled once with an audit entry.
Its scenario completed; all three nodes succeeded. Exactly one message and one
outbox completed on the first delivery attempt, Telegram returned its message ID,
and the user confirmed receiving the invitation and personal link. No duplicate
registration or direct Telegram API send was used.

## First completed provider session - 2026-11-03

The reminder was sent at 05:15:01 UTC. Its original action and published scenario
completed on the first attempt, and Telegram acknowledged one outbound message.
The user confirmed receiving it with the original personal invitation URL.

The live room requires an active YouTube broadcast: an ordinary recorded video was
rejected. An active public broadcast was accepted for the test. The user entered as
a viewer, clicked the CTA, submitted the test comment and ended the session. The
provider report covers 09:28:01-09:32:28 Asia/Baku (4 minutes 27 seconds).

Bounded production inspection confirmed:

- The recovery poll saved the report at 05:33:04 UTC. Its two participant rows
  include one viewer with one comment and `button_1` status `clicked`, and the host
  with status `seen`. These are actual provider values, now available for explicit
  session status mappings; the mappings have not yet been saved.
- Both `get_reports` and `get_report` identify the newly created auto webinar as
  the report's `webinar_id`, whereas the configured session uses the original live
  webinar ID. The two rooms have different URLs. The responses expose no original
  webinar reference, and both `external_id` values are empty. Automatic binding by
  the configured provider ID therefore did not happen. Matching by title or adjacent
  numeric IDs is not a verified substitute for a provider relationship.
- The test viewer's phone has no matching active contact. The intended Telegram
  contact currently has neither a saved phone nor a normalized phone. The host's
  identifiers match more than one contact and remain unresolved. No name matching
  or automatic contact merge was performed.
- The report remains unbound and Historical with PARTIAL matching. Normalized
  duration and CTA booleans remain unknown until session configuration is applied.
  No report-driven CRM operation or automation action has been emitted.
- No webhook receipt exists. Railway API HTTP logs since 05:27 UTC contain no
  request to the Webinar Stars webhook route. Delivery and the actual request
  Content-Type are still unverified; absence of a receipt is not proof of a parser
  failure. Inspect the provider's saved webhook URL configuration next.

Invitation/reminder delivery, viewer entry, provider CTA/comment capture and poll
recovery are verified. Webhook delivery, correct live-session report binding,
contact matching and CRM delivery remain open acceptance items. No production
records were mutated during this inspection.

The user subsequently deferred CRM acceptance and prioritized Omnicus. The local
correction permits explicit MANUAL Historical binding across the observed provider
ID change and preserves a manually matched attendance row on refresh. A rollback-only
production-data check resolves the viewer to the original contact and invitation,
retains the same row over two import passes, and yields 267 seconds / 100%, a CTA
click and one comment. No delivery intents/messages are created.

Release and save confirmed at 05:57 UTC: Omnicus API and Web `6244444` are both
SUCCESS with only the new deployments active. API readiness and the public Web
return HTTP 200. The corrected import service saved the result in one audited
transaction, including the confirmed `clicked`/`seen` mappings, CRM disabled for
this test session, explicit Historical session binding and the viewer's manual
contact match. Repeating the import retained the original viewer row and invitation.
A separate read verified the saved values and zero CRM operations/new delivery
actions. The host remains UNMATCHED because its identifiers resolve to multiple
contacts, so the overall import is PARTIAL; the viewer row is fully normalized.
Automatic cross-ID binding and real webhook delivery remain unverified.

## Workspace styling - 2026-11-03

The Webinar Stars workspace uses the shared themed Input with a search prefix,
the standard refresh button and the application context for messages and confirmation
dialogs. Search no longer inherits the page-heading column layout. Workspace cards,
workflow tabs and form grids constrain their content on mobile; session date/number
fields use full-width shared controls. Session forms and manual report binding keep
their existing behavior. Email setup cards now use the full project content width.

Session calendars use the shared compact date/time picker: hours/minutes only,
bounded time columns and a stacked mobile popup. Add session is a compact button
with a plus icon aligned above the table. Provider-list pagination uses accessible
previous/next arrow buttons and the current page number, retaining its paging guards.

## Webhook request parsing correction - 2026-11-03

The operator re-saved the provider webhook configuration; the address remains in
the form with POST and sending enabled. No real webhook receipt exists yet, and
the sampled API HTTP logs since 15:20 UTC contain no Webinar Stars webhook request.

Inspection found that production disabled Nest's default body parsing and installed
only its JSON parser, whereas the original HTTP boundary fixture used Nest defaults,
which also parse forms. Production and this fixture now use the same bootstrap
helper. JSON keeps its existing size limit and raw bytes for signed integrations.
Nested form-urlencoded parsing is scoped to `/webhooks/webinar-stars`, with 64 KiB,
100-field and two-level nesting limits. Parser failures expose safe 400/413 responses
without invoking the webhook receiver. Other API routes do not gain form parsing.
Express 5.2.1 is now an explicit API dependency; that exact version was already used
by Nest, so the resolved dependency versions are unchanged.

This fixes receiver compatibility and the test coverage gap; it does not establish
the provider's actual Content-Type or explain the absence of a network request.
A short controlled provider session is still needed to verify real delivery and
inspect the report/webinar IDs in the bounded authenticated receipt. CRM remains deferred.

## Verified JSON webhook and recording binding - 2026-11-03

A real provider completion request using the saved POST format returned HTTP 400
at 16:11:47 UTC. Its body was not retained, so its precise encoding/failure remains
unverified. After selecting JSON in the provider's data-format dropdown and saving,
the next real completion reached the API at 16:19:11 UTC, returned HTTP 200 and
created an authenticated bounded receipt.

That receipt identifies the original live webinar, while get_report identifies its
new recording copy. Both identify the same report and exact local start/end window.
Automatic binding now accepts that evidence within the project/connection, still
requires one matching scheduled session, and retains the bounded proof on the import.
Conflicting receipts block binding; no reusable ID alias or guessed provider field
is introduced. A valid completed interval is required before Live delivery effects.

The completed report also contains earlier room visitors and comments. Visits with
valid dates entirely outside this interval are excluded; prior UNMATCHED raw rows
become IGNORED with OUTSIDE_REPORT_WINDOW. Dated comments outside the interval are
excluded, while unknown timestamps retain their unknown semantics.

A rollback-only check using the real report, receipt and actual import service
automatically binds a temporary session, measures 79 seconds for the current host,
excludes one earlier visit and all old comments, and preserves the binding after
receipt reads are hidden. Reprocessing creates no additional delivery intents.
The transaction was rolled back. A fresh invited viewer and report-driven Telegram
delivery still require live acceptance; CRM acceptance remains deferred.

## Fresh Omnicus-only automatic report acceptance - 2026-11-03

API, Web and Worker release b3e589f reached SUCCESS; public Web and API readiness
returned HTTP 200. A dedicated session and two newly published scenarios were
prepared through the application services, leaving prior published versions intact.
The session's webinar CRM flag is false. Its invitation maps the previously observed
utm_campaign parameter to the opaque invitation token; utm_source remains attribution.
The invitation message reached Telegram with a provider acknowledgement.

The operator entered through the new personal link in a fresh incognito window,
started the original room, watched, clicked CTA, posted a fresh comment and ended
the webinar. The authenticated receipt arrived at 16:50:01 UTC for the actual
20:47:36-20:50:01 Asia/Baku interval. The detailed report names its recording copy;
the receipt names the original room. The automatic import completed at 16:51:06 UTC:

- The original session was selected without manual binding; historical is false.
- The contact and invitation matched via TRACKING_TOKEN, whose roundtrip is now
  verified in the provider's returned UTM data. Autologin fields remain unverified.
- The report includes the old morning visitor, the host and the new visitor. The
  old visit is outside the interval. The host and new visitor share the invitation
  token in provider data and normalize to one invitation-linked attendance; this
  test does not establish independent host/viewer counting.
- Attendance is 145 seconds, 2.42 minutes, 100%, completed, CTA clicked and one
  current comment. The earlier room comment is excluded.
- REPORT_RECEIVED, ATTENDED, COMPLETED, CTA_CLICKED and COMMENTED actions succeeded.
  The result scenario completed once; its single result message was SENT and
  acknowledged by Telegram at 16:51:15 UTC.
- Reprocessing the completed import with the actual service in a rollback-only
  transaction preserves attendance ID/version/result, keeps seven session actions
  unchanged and creates zero additional messages. No webinar CRM action exists.

The session's CRM flag does not disable the project's separate generic CRM contact
sync and outbound-message history integration; those pre-existing routes remain
unchanged. CRM webinar acceptance is still deferred. Missed/replay branches,
additional delivery channels and independent host/viewer separation are not accepted
by this successful primary invitation-to-report Telegram test.

## Operator results and customer scenario setup (ADR-069)

Webinar workflow → Results shows one saved report at a time. Choose an import or use
Saved reports → Open results. The summary shows active registrations, attended,
confirmed missed, completed, partial viewing, CTA clicks, replay, comments, unmatched
identities and failed/unknown report delivery actions. These counts cover the whole
selected import; table filters affect participant rows only. Unknown values remain
Unknown. Ignored rows are excluded from engagement counts. An unfinished report or
unresolved matching displays a provisional-results notice, not an inferred no-show.

Search participants by name, contact, email, phone, source/campaign or distributor.
Filter attendance/matching, CTA and replay evidence; sort by name or watched duration.
The table is paginated on the server, up to 100 rows per page. View result opens contact
and CRM references, viewing, matching, all saved UTM and full normalized comments.
Counts and rows share a repeatable-read PostgreSQL snapshot. No provider read or
outbound action is caused by opening a saved report.

`GET /api/v1/projects/:projectId/webinar-stars/reporting` requires integrations:manage.
Query: optional importId (latest import if omitted), search (max 120), status
(ATTENDED/MISSED/PARTIALLY_WATCHED/COMPLETED/REPLAY_VIEWED/UNKNOWN), match
(MATCHED/MANUAL/UNMATCHED/IGNORED), cta/replay (yes/no/unknown), sort (name/watched),
page (1..100000), pageSize (1..100, default 20). The response is report metadata,
full-import summary, items, filtered total, page and pageSize. No import returns an
empty workspace; an inaccessible explicit import returns 404. Invalid filters return 400. All queries are project-scoped and all search/filter values are bound parameters.

Registration now accepts all five standard marketing UTM plus separate distributor ID.
The original values remain on the invitation. If a confirmed provider UTM field carries
tracking, its token wins on the outgoing URL so campaign input cannot break identity.
Saved attendance restores the invitation's original campaign/source/etc independently;
the technical token is not shown as a marketing campaign. Reported UTM fields absent
from invitation attribution are retained. Conflicting link parameter roles are rejected.
This fixes data separation without claiming an unverified custom/autologin parameter.

Webinar workflow → Scenarios creates a customer-facing draft for a selected session,
explicit active Telegram bot, editable message and optional contact tag. Presets cover
registration, scheduled reminders, attendee thanks, absence and CTA follow-up. Creation
requires automation:manage; review and publication use the existing Automation Studio.
The presets do not send staff statistics to participants or enable CRM. Existing email
and WhatsApp nodes remain available in Studio. Their live acceptance remains delegated.

The four known acceptance-only scenarios have been paused through the audited service.
Published versions, invitations and saved reports were retained. No customer follow-up
was published automatically and no additional live test was requested from the operator.

Release 48cc118 is SUCCESS for API, Web and Worker with one active deployment per
service. Public Web and API readiness return HTTP 200; unauthenticated reporting is
rejected with HTTP 401. Automatic processing refreshed the saved acceptance result:
145 seconds remain intact, original source attribution is restored and the technical
carrier is excluded from marketing UTM. The result-message count remains exactly one.
No explicit additional retry, message or webinar test was needed after rollout.

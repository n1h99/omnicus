# Очистка тестовых контактов Omnicus и лидов staging CRM

Подготовлены два отдельных скрипта. **Они не запускались на пользовательских
базах. Production CRM запрещена.** Это не API приложения и не миграция при
деплое: скрипты запускаются только вручную.

| Скрипт            | Область удаления                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `omnicus.mjs`     | Все контакты, включая архивные/объединённые, и связанные рабочие данные **одного явно указанного проекта** Omnicus           |
| `crm-staging.mjs` | Все лиды, включая архивные, карточки, договоры, история и связанные рабочие данные **одной явно указанной staging-базы** CRM |

## Что удаляется и что остаётся

Omnicus: контакты, identities, привязки тегов и значения custom fields,
переписка и статусы сообщений, исполнения сценариев, ожидания, задержки,
запланированные отправки, получатели рассылок, email deliveries/events,
тестовые email suppressions, lead-capture events, tracked links/clicks,
CRM operations, inbox/raw/normalized events, контактные outbox и project
idempotency records. Удаляется **весь audit выбранного проекта**, поскольку
он может содержать старые значения контактных данных. Глобальный audit не
затрагивается. Явные `audience.contactIds` рассылок очищаются.

CRM staging: leads, lead histories, contracts, conversations/messages,
drafts, internal notes, mentions, scheduled/provider operations, Omnicus
contact links, inbound/conversation/reaction operations, старые Manychat
webhook logs. Удаляются также осиротевшие записи этих коллекций.

Сохраняются пользователи, роли, проекты, настройки и credentials интеграций,
каналы, определения сценариев и их версии, определения тегов/custom fields,
сегменты, шаблоны, quick replies, сами кампании и рассылки. Bot interface и
его configuration outbox сохраняются. Другие проекты Omnicus и любые другие
базы Mongo не очищаются. Коллекции/индексы Mongo не удаляются.

Отчётность по удалённым сообщениям и контактам после очистки исчезнет.
Удаление suppressions допустимо только для согласованных **тестовых** данных:
не используйте инструмент для обхода реальных отписок/жалоб.

### Важная граница: файлы и внешние системы

Это **полная очистка указанного набора данных в БД**, но не инструмент
безвозвратного стирания всех копий персональных данных во всех сервисах.

- Контактные media records Omnicus удаляются, если они не используются
  сохраняемыми сценариями/шаблонами/кампаниями. Общие media и несвязанные
  `USER_UPLOAD` assets сохраняются, чтобы не сломать библиотеку контента.
- **Объекты в S3/Railway bucket не удаляются.** План сохраняет известные
  `bucketKey`/`storageKey` в `retainedFiles`, включая пометку общих Omnicus
  assets. Ключи CRM могут пересекаться с production, например после клонирования
  staging-базы. Само наличие ключа в staging не доказывает право удалить файл.
- CRM-файлы, известные только по URL, не гарантированно перечислены в манифесте.
  Перед физическим удалением нужны отдельная инвентаризация, подтверждение
  конкретного bucket и проверка отсутствия production-ссылок.
- Telegram/WhatsApp/Resend, почтовые ящики, внешняя CRM production, архивы
  backup, Railway logs и Redis не изменяются. Не выполняйте `FLUSHDB`,
  `FLUSHALL` или очистку общего bucket.
- В очередях Omnicus используются ссылки на durable записи. Старые задания
  после удаления их записей не являются разрешением заново отправлять
  сообщения. До открытия входящего трафика проверьте отсутствие неожиданных
  повторов; provider retries после открытия ingress могут создать новые данные.

Флаг `--accept-retained-files` означает согласие с этой границей. Если требуется
физически стереть вложения/логи/внешние копии, **не считайте задачу завершённой**
после этих двух скриптов: нужен отдельный согласованный этап хранения.

## Защита production CRM

1. По умолчанию выполняются только чтения. `--force`, `--all-projects` и
   `--allow-production` отсутствуют и отклоняются.
2. Скрипты не читают `.env`, не используют `DATABASE_URL`/`MONGODB_URI`, не
   запускают Nest/application context, HTTP-серверы, workers или интеграции.
3. CRM требует `RAILWAY_ENVIRONMENT_NAME=staging`, точного совпадения
   `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID` с
   заранее проверенным target; строки с `prod` в CRM host/database/baseUrl
   запрещены. `NODE_ENV` не используется для определения Railway environment:
   production build может законно работать в staging.
4. Отдельный `CLEANUP_CRM_STAGING_URI` должен точно совпадать с закреплёнными
   Mongo hosts и названием базы. Для Omnicus аналогично проверяется отдельный
   `CLEANUP_OMNICUS_DATABASE_URL`, затем точные project ID/name и staging pairing.
5. В обеих системах должна быть ровно одна соответствующая pairing: disabled.
   Omnicus project должен быть `PAUSED`. Дополнительные pairing или их чужие
   данные в CRM блокируют запуск.
6. Применение требует свежий (до 1 часа) план, точную confirmation phrase,
   совпадение полного снимка данных/настроек, checksum backup и явные
   подтверждения остановки writers и проверенного восстановления backup.
7. PostgreSQL удаляет в одной транзакции с FK и блокировками. Mongo требует
   replica set и transaction support, использует snapshot + majority и не
   делает автоматический retry. Standalone Mongo отклоняется.

**Это защита от ошибок выбора, не независимая аттестация инфраструктуры.**
Нельзя самому переименовать production в `staging` или подставить придуманные
Railway IDs, чтобы пройти проверки. Target заполняется после сверки Railway
Console с владельцем; переменные окружения должны приходить из выбранного
Railway project/environment/service. Используйте отдельного Mongo-пользователя
с правами **только на staging-базу**, а не production/admin credentials.
Если невозможно доказать, что база staging, запуск запрещён.

## Подготовка (ничего не удаляет)

Все файлы находятся в `omnicus/scripts/test-data-cleanup`. Ничего копировать
в CRM backend не требуется: это независимый комплект инструментов.

Установка зависимостей из этой папки:

```powershell
npm ci --omit=dev --ignore-scripts
node .\crm-staging.mjs --help
node .\omnicus.mjs --help
```

Создайте локальную копию `target.example.json` как `target.local.json`.
В ней только идентификаторы и адреса **без паролей и токенов**. Пример содержит
нерабочие placeholders и намеренно не позволит подключиться.

Для заполнения нужны:

- Railway project/environment/service IDs и имя окружения **staging CRM**;
- host:port и название **staging Mongo database**, точный HTTPS origin CRM;
- `crmProjectId` из pairing, не путать с Railway project ID;
- Railway IDs сервиса Omnicus и его PostgreSQL host:port/database;
- точные project UUID и название выбранного проекта Omnicus.

Omnicus может находиться в своём обычном окружении: ограничение там на один
проект и его staging CRM pairing, а не на название deployment environment.

**Не присылайте строки подключения в чат.** Задайте специальные cleanup
переменные только в процессе запуска/защищённой сессии. Не сохраняйте их в
репозитории или target JSON. Пароли не должны попадать в историю команд.

## Порядок очистки

1. Подтвердить, что **все** данные указанного Omnicus project и **все** лиды
   staging CRM тестовые. Если нужно сохранить часть — этот инструмент не
   подходит, нужен выборочный фильтр.
2. Согласовать окно обслуживания. В Omnicus поставить проект на паузу,
   отключить CRM sync; в staging CRM отключить соответствующее Omnicus
   connection. Завершить/отменить активные, scheduled и paused broadcasts и
   email campaigns. Не удалять настройки pairing.
3. Остановить API/worker/scheduler **обеих очищаемых систем**, обе стороны
   синхронизации, лендинг ingest, входящие webhooks и ручные записи. Production
   CRM не останавливать и не менять. Если Omnicus сервис обслуживает другие
   проекты, согласовать его короткое общее окно: SQL locks временно блокируют
   записи в общие таблицы, хотя строки других проектов не меняются.
4. Сделать native backup точных баз (`pg_dump` custom-format для PostgreSQL,
   `mongodump` archive для staging Mongo) после остановки writers. Проверить
   восстановление в отдельных временных базах. Сохранить файлы вне Git с
   ограниченными правами доступа. SHA-256 проверяется скриптом; принадлежность
   backup нужной базе и успешный restore — отдельная ответственность оператора.
   Снимок/backup ID из Railway без доступного проверенного файла здесь недостаточен.
5. Выполнить два dry-run из соответствующих проверенных Railway-сессий:

```powershell
# Сессия с идентификаторами staging CRM и CLEANUP_CRM_STAGING_URI:
node .\crm-staging.mjs --target .\target.local.json --plan .\crm.plan.json

# Сессия с идентификаторами Omnicus и CLEANUP_OMNICUS_DATABASE_URL:
node .\omnicus.mjs --target .\target.local.json --plan .\omnicus.plan.json
```

6. Проверить в обоих планах адреса, ID/name, `deleteCounts`, `updateCounts` и
   `retainedFiles`. Не должно быть неожиданно больших объёмов или чужой pairing.
   Файлы планов не перезаписываются. Для повторной проверки используйте новое
   имя `crm-2.plan.json` / `omnicus-2.plan.json`.
7. Применить **сначала Omnicus, затем staging CRM**, пока все writers выключены.
   Подставить отдельный backup, его SHA-256 и phrase из соответствующего dry-run:

```powershell
node .\omnicus.mjs --target .\target.local.json --plan .\omnicus.plan.json --apply --confirm "ERASE-OMNICUS-PROJECT-ИЗ_ПЛАНА" --backup "D:\VerifiedBackups\omnicus.dump" --backup-sha256 "SHA256_ЭТОГО_BACKUP" --writers-stopped --restore-tested --accept-retained-files

node .\crm-staging.mjs --target .\target.local.json --plan .\crm.plan.json --apply --confirm "ERASE-STAGING-CRM-ИЗ_ПЛАНА" --backup "D:\VerifiedBackups\crm-staging.archive" --backup-sha256 "SHA256_ЭТОГО_BACKUP" --writers-stopped --restore-tested --accept-retained-files
```

8. Убедиться, что оба `.receipt.json` имеют статус
   `DATABASE_COMMITTED_FILES_RETAINED`. Выполнить новые dry-run: удаляемые
   наборы должны быть пустыми. Настройки, сценарии, пользователи и другие
   Omnicus projects должны сохраниться. Сам cleanup оставляет проект на паузе
   и pairing выключенным.
9. После проверки согласовать возобновление работы: API/worker, pairing,
   Omnicus project и ingress. Повторно не запускать старые рассылки и retry
   старых provider requests. При физической очистке файлов сначала отдельно
   проверить storage manifest и отсутствие production/shared references.

Обе базы **не образуют общую транзакцию**. Если второй этап не прошёл, не
включайте синхронизацию: первый мог уже завершиться. Исправьте причину и
составьте новый план либо восстановите согласованный комплект backup.

`PREPARED_OUTCOME_NOT_CONFIRMED` не доказывает отсутствие commit: возможен
обрыв связи/ошибка записи receipt после commit. Не повторяйте удаление вслепую.
Сначала проверка фактического состояния обеих баз. Восстановление возможно
только из backup; UI Restore возвращает архивный контакт, но не hard-deleted.

## Проверки и ограничения

```powershell
npm ci --ignore-scripts
npm test
```

Тесты не используют пользовательские URL: PostgreSQL запускается в памяти
через PGlite с реальными миграциями репозитория; Mongo создаёт временный
loopback replica set (при первом запуске скачивается MongoDB binary).
Проверяются production guards, target mismatch, отсутствие `.env` fallback,
строгость CLI, backup/confirmation, устаревший/изменённый план, FK-порядок,
откат, shared assets, сохранение настроек, второго проекта и другой Mongo базы.

Ограничения: до 20 000 строк на таблицу/коллекцию и 100 MiB снимка на базу;
неизвестные таблицы/коллекции, нестандартные triggers, RLS, partitions,
cross-schema FK и дополнительные pairing требуют отдельного review, а не
ослабления guard. В штатный frontend/backend runtime зависимости не добавлены.

Планы могут содержать названия файлов. `.local.json`, `.plan.json`,
`.receipt.json`, `.dump` и `.archive` здесь игнорируются Git; хранить их нужно
защищённо. На Windows ограничение доступа задавайте через ACL — `mode: 0600`
само по себе не является гарантией Windows ACL.

# Проверка скриптов — 2026-09-15

Реальные PostgreSQL/Mongo базы, включая production CRM, не подключались для
очистки инструментами агента. Пользователь запустил PostgreSQL console-команду:
его скриншот подтверждает `OMNICUS_CLEANUP_COMMITTED` и 0 контактов.
Первая MongoDB console-попытка остановилась на SyntaxError верхнеуровневого
`await` до удаления. Payload исправлен: теперь полностью внутри async IIFE.
Успешный live-результат MongoDB пока не подтверждён.
Target для исходного CLI остаётся примером с
блокирующими placeholders. Исходный комплект опубликован коммитом `4732e69`;
дополнение standalone проверяется локально и само по себе не означает push/deploy.
Публикация скриптов в Git не запускает очистку: инструменты вызываются вручную.

## Результаты

- `node --test test/*.test.mjs`: **16 passed, 0 failed, 0 skipped**.
  Финальный прогон — Node 24.18.0. Интеграционные проверки использовали новый
  PostgreSQL в памяти (PGlite, реальные миграции) и новый Mongo replica set на
  loopback. Проверены rollback, FK/self-FK, сохранение второго проекта/базы,
  shared assets и несвязанных library uploads, конфигурации и Mongo indexes.
  Добавлены проверки нового standalone MongoDB: реальный CLI dry-run/apply,
  неизменные production/backup guards, отсутствие скрытого fallback, drift
  записей/сохраняемых настроек, честный partial failure без rollback/retry и
  отдельный успешный receipt. Все записи для удаления созданы самими тестами.
  PostgreSQL console-вариант дополнительно проверен на тех же реальных миграциях:
  блокировка при неотключённой связи/активных заданиях, rollback после ошибки
  уже после DELETE, успешный COMMIT, сохранение другого проекта, общих media
  и bot configuration outbox. Реальная база пользователя не очищалась инструментами.
- `pnpm lint`: passed. После финальных изменений также проверен отдельно
  `scripts/test-data-cleanup`.
- Prettier check каталога скриптов: passed.
- `pnpm db:validate`: passed, с явно заданным нерабочим loopback database URL,
  без подключения к базе или миграций.
- `pnpm build`: passed, 17 package build tasks и minimal runtime artifacts.
  Были предупреждения Windows bin links и размера frontend chunk, не ошибки.
- `pnpm test`: passed, 36 tasks, 34 из cache. Live service integration был
  явно отключён; 4 worker-теста и 1 API readiness-тест пропущены. DATABASE_URL
  и REDIS_URL принудительно указывали на loopback port 1, а не реальные базы.
- Оба CLI `--help`: passed.
- `git diff --check`: passed.

## Уже существующие общие замечания (не изменялись этой задачей)

- Root `pnpm typecheck` останавливается с TS2322 в
  `e2e/whatsapp-management.spec.ts:110`: несовместимый тип template component.
  Production build при этом проходит.
- Root `pnpm format:check` сообщает о форматировании пяти прежних UI-файлов:
  `apps/web/src/automation-editor-graph.ts`,
  `apps/web/src/automation-graph-preview.tsx`,
  `apps/web/src/automation-node-config.tsx`,
  `apps/web/src/pages/scenario-editor-page.tsx`, `apps/web/src/styles.css`.
- IDE по умолчанию давала Node 24.13.0 вместо требуемого 24.18.0. Общие
  проверки, которым нужен правильный engine, повторены с уже установленным
  `C:\nvm4w\nodejs\node.exe` 24.18.0, без изменения системной установки.

## До реального запуска исходного CLI

Нужны подтверждённые staging Railway/Mongo identities, project ID/name
Omnicus, сверенная pairing, остановленные writers, restore-tested native
backup обеих баз и согласованный свежий dry-run. Mongo standalone поддерживается
только с явным offline-флагом и остановленными writers; общей транзакции и
автоматического восстановления нет. Физическое удаление bucket objects и внешних копий не
реализовано: это отдельно согласуемый этап, особенно при shared/prod bucket.

Отдельные console-процедуры учитывают явно выбранную оператором работу без
остановки сервисов; их ограничения описаны в README. Новый Mongo console test
проверяет pins, disabled pairing, drift до удаления, частичный сбой без отката,
успешную очистку, сохранность конфигурации/индексов и другой базы на свежем
локальном standalone MongoDB. Сам `mongosh` в Railway тестом не запускается.
Исправленный полный payload дополнительно компилируется как обычный script
через `vm.Script` (без поддержки top-level await) и выполняется с адаптером
локальной тестовой MongoDB, включая порядок auth перед cleanup.

См. [инструкцию](README.md), [шаблон target](target.example.json) и ADR-059
в [решениях проекта](../../docs/DECISIONS.md).

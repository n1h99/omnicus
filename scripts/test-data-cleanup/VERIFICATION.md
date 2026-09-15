# Проверка скриптов — 2026-09-15

Реальные PostgreSQL/Mongo базы, включая production CRM, не подключались для
очистки. Пользовательские записи не удалялись. Target остаётся примером с
блокирующими placeholders. На момент этих проверок commit, push и deploy
не выполнялись. Последующая публикация скриптов в Git сама по себе не
запускает очистку: инструменты вызываются только вручную.

## Результаты

- `node --test test/*.test.mjs`: **11 passed, 0 failed, 0 skipped**.
  Финальный прогон — Node 24.18.0. Интеграционные проверки использовали новый
  PostgreSQL в памяти (PGlite, реальные миграции) и новый Mongo replica set на
  loopback. Проверены rollback, FK/self-FK, сохранение второго проекта/базы,
  shared assets и несвязанных library uploads, конфигурации и Mongo indexes.
- `pnpm lint`: passed. После финальных изменений также проверен отдельно
  `scripts/test-data-cleanup`.
- Prettier check каталога скриптов: passed.
- `pnpm db:validate`: passed, с явно заданным нерабочим loopback database URL,
  без подключения к базе или миграций.
- `pnpm build`: passed, 17 package build tasks и minimal runtime artifacts.
  Были предупреждения Windows bin links и размера frontend chunk, не ошибки.
- `pnpm test`: passed, 36 tasks, 30 из cache. Live service integration был
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

## До реального запуска

Нужны подтверждённые staging Railway/Mongo identities, project ID/name
Omnicus, сверенная pairing, остановленные writers, restore-tested native
backup обеих баз и согласованный свежий dry-run. Mongo standalone намеренно
не поддерживается. Физическое удаление bucket objects и внешних копий не
реализовано: это отдельно согласуемый этап, особенно при shared/prod bucket.

См. [инструкцию](README.md), [шаблон target](target.example.json) и ADR-059
в [решениях проекта](../../docs/DECISIONS.md).

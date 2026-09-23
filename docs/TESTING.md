# Testing

Status reviewed: 2026-09-17; historical regression counts retain their original dates.

## Communications and CRM contact-sync checks — 2026-09-17

The combined feature gate completed green on the pinned workspace toolchain:

- Omnicus API: 209/209 unit tests; the focused CRM contact-sync safety suite
  passed 4/4 after the final lifecycle/idempotency changes.
- Omnicus web: 60/60 tests; database package: 31/31 tests.
- Omnicus lint, typecheck, Prisma validation, migration/schema diff and the full
  17-package production build passed.
- Cyber Pulse backend: 194/194 tests, lint and production build passed.
- Cyber Pulse frontend: 63/63 tests, lint and production build passed.

These are automated and mocked checks. They do not prove Railway migration,
paired CRM create/edit delivery, real Telegram/WhatsApp delivery, approved Meta
template billing behavior or live Email Inbox delivery. Those remain final
module-by-module acceptance gates. The operational scopes are documented in
[COMMUNICATIONS.md](COMMUNICATIONS.md) and
[CRM_CONTACT_SYNC.md](CRM_CONTACT_SYNC.md).

## Email Inbox completion checks — 2026-09-17

ADR-060 completion fixes cover private-draft save replay and deletion revisions,
manual-send replay after a pause, immutable legacy Reply-To on retries, incoming
dates/previews/text limits, disabled/send-only mailbox dispatch and timeout batches,
existing-file attachment permissions, member names and filtered draft empty states.
Implementation changes are in `apps/api/src/email-inbox/`, the worker email and
automation services, and web `email-compose.tsx`, `email-inbox-settings.tsx` and
`pages/email-inbox-page.tsx`. No schema, migration or dependency versions changed.

Verified with Node 24.18.0 / pnpm 10.5.0:

- Focused API/worker regression: 36 passed; covers saved-response loss, stale
  draft deletion, unchanged send replay, delayed import previews, input bounds
  and inactive mailbox processing.
- `pnpm test --output-logs=errors-only`: 36 successful tasks, 31 cached.
  API 194 unit tests; worker 145; existing web/database/email-core suites pass.
  API integration: 6 passed, 1 skipped; worker service integration: 4 skipped.
  Live-service tests were explicitly disabled, with database/Redis URLs pinned
  to unavailable loopback ports. The ordered migration suite also passed against
  disposable PGlite PostgreSQL during this completion pass.
- `pnpm exec playwright test --workers=2`: all 16 passed, including 7 Email Inbox
  cases and the existing account/Telegram/WhatsApp/Automation Studio regressions.
  Desktop/mobile screenshots were inspected. API/provider data is mocked;
  no customer email is sent. The draft-search test waits for folder navigation
  to render before searching, avoiding a test interaction with a pending route.
- Lint, repository format check, typecheck (34 successful tasks), Prisma
  validation/SQL invariants, workspace boundaries and `git diff --check`: passed.
- `pnpm build`: 17 successful build tasks and all three minimal runtime
  artifacts passed, including the web bundle budget. Windows optional executable
  links and the existing frontend chunk size emitted warnings, not failures.
- Production web server: 10 tests passed.
- API and worker production-artifact smoke checks passed with deliberately
  unavailable local dependencies (API `safe-503`, worker `safe-failure`). These
  verify packaging and failure handling, not live database/queue readiness.
- Local Markdown links and fenced blocks in the email scope: passed.

### Existing dependency audit findings — release follow-up

`pnpm audit:production` **failed**: 14 advisories (10 high, 3 moderate, 1 low).
The manifests and lockfile are unchanged from HEAD, so these findings predate the
completion fixes. This is a shared dependency release gate, not a passed check.
It needs a separate dependency update and regression pass before release; local
feature completion does not clear it. Advisory counts are not proof that each
reported path is exploitable in the deployed configuration.

| Package        | Installed | Findings           | Patched floor reported by audit |
| -------------- | --------- | ------------------ | ------------------------------- |
| `deepmerge-ts` | 7.1.5     | 1 high             | 8.0.0                           |
| `mysql2`       | 3.15.3    | 1 high, 1 moderate | 3.23.1                          |
| `qs`           | 6.15.3    | 2 moderate         | 6.16.0                          |
| `fast-uri`     | 3.1.5     | 4 high             | 3.1.6                           |
| `sharp`        | 0.35.0    | 1 high             | 0.35.4                          |
| `multer`       | 2.2.0     | 3 high, 1 low      | 2.3.0                           |

Multer/Sharp are in the shared upload/media path used by attachments. The other
paths include Express query parsing and Prisma's toolchain dependencies. Audit
references include [Multer multipart parsing](https://github.com/advisories/GHSA-wc9g-mqfw-jrwm),
[Sharp image decoding](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c),
[DeepmergeTS](https://github.com/advisories/GHSA-ggr8-5vv4-36mx),
[MySQL2](https://github.com/advisories/GHSA-rgwj-5xj2-c3m3),
[qs](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g) and
[fast-uri](https://github.com/advisories/GHSA-f65p-4m7j-42xc).

Joint live module acceptance is deferred at the user's request. Deployment,
Resend/DNS setup and the original additive migration remain rollout steps in
[EMAIL_INBOX.md](EMAIL_INBOX.md). No push, live migration, DNS change or live mail
send was performed in this completion pass.

## Email Inbox local checks — 2026-09-15

`pnpm lint`, `pnpm typecheck`, `pnpm db:validate` and root `pnpm test` passed for
ADR-060 (36 successful test/build tasks, unchanged packages may use Turbo cache).
API: 189 unit tests; worker: 141; web: 59; database: 31; email-core: 10.
The API integration suite: 6 passed and 1 explicitly skipped
external-service test. Actual ordered SQL migrations also passed in disposable
PGlite PostgreSQL, including tenant/default mailbox/wait/deduplication constraints.

Focused coverage includes signed/tampered webhook ingestion, exact reply routing,
private draft access, unchanged manual-send replay, suppressed recipients,
sender snapshots, incoming content, automatic-reply exclusion, wait/timeout
ordering, unknown delivery cutoff and reordered delivery events.

`pnpm exec playwright test e2e/email-inbox.spec.ts`: 5 passed on the production
web bundle. Desktop/mobile, onboarding, thread reply, private drafts, same-key
network retry and isolated HTML were checked with mocked provider/API data.
Manual Chrome inspection also verified the local three-pane layout. These are
not real Resend delivery or DNS checks. Rollout and live checklist:
[EMAIL_INBOX.md](EMAIL_INBOX.md).

Final regression: all 14 Playwright tests passed, including existing WhatsApp,
Telegram/account layouts and Automation Studio. Production web server: 10 passed.
Format check, SQL invariant review, workspace boundaries and `git diff --check`
passed. `pnpm build` produced all three minimal runtime artifacts and passed the
web bundle budget. API production-artifact smoke passed with an intentionally
unavailable local database/Redis (safe 503, not live database readiness).
Windows packaging reported optional bin-link warnings; the runtime checks passed.
Worker production-artifact smoke also passed its expected safe-failure path with
intentionally unavailable local dependencies; it does not assert a live ready worker.

## WhatsApp management acceptance and UI follow-ups

The native management implementation is in `35fb7d2`; UI-only follow-ups are
`1ec63a6`, `e01ec51` and `3698b7b`. The guided walkthrough confirmed native
template submission, duplication, review-image upload, text/button preview,
explicit synchronization and navigation to Meta payment setup. Templates were
pending, no personal card was attached, and a complete billing report was not
verified. Missing-currency and report-failure states were observed.

Do not count that walkthrough as real template edit/delete acceptance, an
approved outside-window send, a successful payment, App Review approval or a
production-volume regression. See [WHATSAPP_MANAGEMENT.md](WHATSAPP_MANAGEMENT.md).

For the visual follow-ups the user explicitly requested no test runs.
TypeScript passed for the component changes; formatting and `git diff --check`
passed for the spacing-only change. This documentation pass uses only Markdown
integrity/diff checks. Existing test files are coverage, not a newly executed
test result. The general quality gate below remains applicable to future work.

When a visual acceptance run is requested, inspect configured/unconfigured and
invalid-access channels, unique vs repeated diagnostic causes, stale refresh
failure, initial billing loading/error/success, responsive toolbar actions,
image replacement/header switching, and the 18 px card / 16 px error gaps.

## Local quality gate

Run with the pinned Node/Corepack toolchain:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm versions
corepack pnpm preflight
corepack pnpm format:check
corepack pnpm lint
corepack pnpm check:boundaries
corepack pnpm db:validate
corepack pnpm db:diff:check
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm test:api:production
corepack pnpm test:web:production
corepack pnpm test:worker:production
corepack pnpm test:e2e
corepack pnpm audit:production
```

`db:diff:check` verifies the complete executable Prisma schema against the
ordered reviewed migrations and database invariants. It does not apply schema
changes. Production smoke suites exercise the assembled `.runtime` artifacts,
not development servers.

## Coverage expectations

Every durable integration must cover success, retryable failure, permanent
failure, timeout/`UNKNOWN`, reconciliation, lease recovery, stable idempotency
and project isolation. A queued operation is never asserted as delivered.

Telegram/CRM contract tests additionally cover duplicate delivery,
reaction-before-source, incorrect routing, media ownership, scheduled-message
reconciliation and source-context persistence. Live verification is recorded
separately because mock or unit coverage is not evidence of provider delivery.

Contact synchronization tests cover linked-lead update without duplication,
explicit merge idempotency, project isolation, preservation of Telegram and
WhatsApp histories, and the dry-run/execute behavior of the historical merge
backfill.

Inbound bridge regression additionally verifies that a linked contact queues
one `crm-history-<messageId>` operation without an automation node, an unlinked
contact queues one lead bootstrap, and a Telegram reply target is forwarded
only after same-conversation resolution.

WhatsApp contract and adapter suites additionally cover:

- exact raw-byte `X-Hub-Signature-256` verification and challenge-token
  rejection without raw/inbox persistence;
- multi-entry webhook splitting, stable duplicate keys, unknown phone IDs and
  project/WABA/phone isolation;
- inbound text, media, voice, contact, location, interactive reply, reaction
  and safe unsupported placeholders;
- customer-service-window persistence and the second guard immediately before
  a free-form provider call;
- APPROVED connection-scoped template resolution and typed parameters;
- media MIME/size boundaries, provider-media upload and authenticated temporary
  download without persisted URLs;
- `SENT -> DELIVERED -> READ`, duplicate/out-of-order callbacks, safe `FAILED`
  and timeout/`UNKNOWN` without blind retry;
- write-only Embedded Signup registration PIN, WABA/phone membership, template
  sync, mark-as-read and CRM same-bubble status updates;
- provider-aware automation replies and template-only WhatsApp broadcasts.
- one-shot text schedule create/update/cancel, optimistic revision, service-
  window expiry at delivery, and rejection of recurrence or scheduled media.

Mocks prove deterministic contracts, not Meta acceptance. Embedded Signup,
number registration, signed delivery, approved-template send and real delivery/
read receipts remain one combined live gate until dedicated Meta test assets
are supplied.

Automation tests cover deterministic graph execution, branch selection,
wait/delay/subflow continuation, immutable published versions and execution
journaling. Automation Studio 2.2 adds explicit coverage for:

- saving incomplete/disconnected drafts while publish/test stays strict;
- explicit draft save without background update requests, plus explicit
  connection deletion;
- External HTTP method/query/header/body validation and response mapping;
- project-secret isolation and write-only secret values;
- DNS/redirect validation, SSRF and cloud-metadata blocking;
- request/response/time limits, idempotency and HTTP outbox recovery.

Lead-capture and attribution tests cover ingest-key validation, required
idempotency, conflicting replay, normalized contact reuse, CRM bootstrap,
`WEBSITE_REGISTRATION` scenario matching, Telegram deep links, tracked redirect
deduplication and project isolation.

Email tests cover campaign/template lifecycle, immutable published versions,
audience estimates and snapshots, address deduplication, suppression priority,
automation delivery, Resend idempotency, retry/lease recovery, webhook
signature/deduplication, monotonic events, unsubscribe and CRM forwarding.

## Service-backed integration tests

API readiness and worker consumer tests require
`RUN_SERVICE_INTEGRATION=true` plus isolated PostgreSQL and Redis URLs. CI
provides both services. Without them, local suites explicitly skip the
service-backed cases; a skip is not runtime evidence.

## CI

CI uses the exact `.node-version`, pnpm version and frozen lockfile. It runs
format, lint, boundaries, typecheck, unit/integration tests, Prisma validation,
migration diff checks, production builds/smokes, Playwright and production
dependency audit. A Windows checkout job guards LF normalization.

High or critical production advisories fail CI. Temporary exceptions must meet
[DEPENDENCY_EXCEPTIONS.md](DEPENDENCY_EXCEPTIONS.md); findings are never
silently ignored.

## Latest complete local regression

The 2026-08-14 cross-repository gate completed green on the pinned toolchains:

- Omnicus: 577 package/unit tests, API integration 6/6, web production 9/9,
  Playwright 4/4, lint, typecheck, build, format, boundaries, Prisma checks,
  runtime artifacts and production dependency audit;
- Cyber Pulse backend: unit 190/190, e2e 1/1, lint and production build;
- Cyber Pulse frontend: Vitest 63/63, lint and production build.

Five service-dependent cases were explicitly skipped locally: one API case and
four worker cases require the isolated PostgreSQL/Redis integration flag. They
remain CI/service-backed gates and are not counted as runtime evidence. Across
the executed suites, 850 tests passed and no executed test failed.

These counts document that run; future changes still require the full commands
above and must not treat this record as a substitute for a new gate.

## 2026-08-29 customer patch regression

The customer-requested automation/UI patch was rechecked with Node.js
`24.18.0`. A targeted web run completed with 15 test files and 58 passing
tests. The root `pnpm test` Turbo graph then completed 36/36 tasks successfully,
including 2 passing API integration suites with 6 passing tests and 1 explicit
service-dependent skip. Four worker service-backed integration cases also
remain explicit local skips. No executed test failed.

This was a test/integration regression run, not a replacement for every command
in the full local quality gate above. The web production build required by the
task graph completed successfully.

## 2026-09-23 email spacing and Reply-To

Scope: `apps/web/src/email-inbox.css` removes the inner table gap in both
email-address and domain-DNS tables, uses a 12px outer gap and constrains the
settings grid on mobile. `packages/database/src/email-conversations.ts` snapshots
the selected TWO_WAY mailbox address as Reply-To. Existing snapshots, incoming
legacy aliases, RFC threading and modal structure are unchanged. Contract:
ADR-064 in `DECISIONS.md` and `EMAIL_INBOX.md`.

Regression coverage was added in `packages/database/src/email-conversations.test.ts`,
`apps/worker/src/email/email-inbound.service.test.ts` and `e2e/email-inbox.spec.ts`.
Checked on Node 24.18.0 / pnpm 10.5.0:

- Production build and minimal runtime artifacts, typecheck, Prisma validation,
  changed-file Prettier/ESLint and `git diff --check` pass.
- Database tests: 34 passed (including local PGlite migrations); worker unit tests:
  153 passed; web unit tests: 88 passed. Email Inbox/API/CRM email suites pass.
- API integration: 6 passed, 1 explicit service-dependent skip. Worker service
  integration: 4 explicit skips without isolated PostgreSQL/Redis services.
- Email browser regression: final serial run 21/21 passed, including 1440px and
  390px settings, Inbox and Conversations. Screenshots visually inspected; browser
  layout inspection also confirmed no page overflow and no internal header gap.
  Earlier concurrent runs had page-load timeouts; the final run used one worker.

The full repository gate is **not green**: existing Prettier issues remain in five
unmodified files; ESLint reports three pre-existing type-import errors in the
Telegram workspace/CRM controllers and service. API unit tests have 230 passing
and one existing failure in `api-exception.filter.test.ts`: 16 workspace error
codes lack human-readable mappings. No API source was changed by this patch.

No real email was sent, no DNS/config/database migration was applied, and no
commit/push/deployment was performed. After release, verify a new email's readable
Reply-To and a real reply in the same thread, with signed sending webhooks enabled.

## 2026-09-23 interactive email attachments (ADR-065)

Scope: Omnicus Inbox/Conversations plus CRM frontend/backend on `staging`.
New reusable email file controls include multiple selection/drop, compact cards,
pending/error/removal/retry, authenticated binary download and lazy raster/PDF
preview. CRM v1 upload/download transport enforces mapped lead/contact, authenticated
manager, project and shared-mailbox boundaries; outgoing history gets safe metadata.
See `EMAIL_INBOX.md` for the additive API contract and deployment order.

Checks on Node 24.18.0 / pnpm 10.5.0 (CRM uses npm):

- Omnicus typecheck: 34/34 tasks pass; production compilation and runtime artifacts
  pass; Prisma schema validation passes, no migration needed.
- Omnicus focused API attachment/inbox/CRM/media suites: 37 passing tests.
  Full API: 239 passed, the same pre-existing human-readable error-map test fails.
  Web: 97 passed; worker: 153 passed; media core: 38 passed. Media checks include
  email-only M4A, Windows ZIP MIME alias and unchanged messenger regressions.
- API integration rerun: 6 passed, 1 explicit isolated-service skip. Worker
  isolated-service integrations remain explicit skips (no live services used).
- Inbox/Conversations browser regression: final serial run 24/24 passed. Covers PDF canvas/local worker,
  authenticated download, files-only send, immutable ambiguous retry payload,
  upload failure/removal, library-only permissions and 390px layout. Screenshots
  of compose, PDF preview and mobile errors were visually reviewed.
- CRM frontend: production build and full ESLint pass; focused email suites
  21/21 pass. Full frontend test run has 86 passed and one pre-existing WhatsApp
  source-text assertion failure in `whatsapp-chat-v4.test.ts:125` (unchanged source).
- CRM browser fixtures: 3/3 pass, including 1440/390px attachment compose,
  files-only send, unchanged retry payload, incoming/outgoing filenames,
  image preview and authenticated download. Reproduce with `npm run test:browser`.
  Fixtures use local mocked data and are not production build entries.
- CRM backend: build, targeted changed-file ESLint and lead-email suite (5/5) pass.
  The touched service has an unrelated existing enum-comparison lint finding at
  `conversations.service.ts:226`; its new email forwarding signature is clean.

Omnicus full lint/format gates still include the unrelated type-import findings
documented above, four previously unformatted non-email files, and two browser-global
lint findings in the pre-existing local `tmp/email-settings-preview.js`. Changed
attachment files pass ESLint/Prettier; existing output PDFs and prior uncommitted
Reply-To/spacing changes are preserved. Full gates are not represented as green.

No commit/push, deployment, real provider email, DNS/config change or database
migration was performed. After deploying Omnicus and both CRM staging services,
perform one approved real send/reply with attachments and verify a second user's
lead permissions. Mocked browser/API tests do not establish live provider delivery.

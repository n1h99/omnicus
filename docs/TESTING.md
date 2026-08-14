# Testing

Status reviewed: 2026-08-14.

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

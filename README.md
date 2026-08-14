# Omnicus

Omnicus is a production-deployed omnichannel automation platform built as a
`pnpm`/Turborepo monorepo. The current release includes Auth/RBAC, projects,
contacts and segmentation, Telegram messaging, official WhatsApp Business
Cloud API support, durable inbox/outbox delivery, Cyber Pulse CRM integration,
broadcasts, media/templates, public website lead capture, tracked links,
Resend-backed email campaigns, cross-system contact merge and Automation Studio
2.2. WhatsApp CRM chat includes voice media and one-time text scheduling inside
the current service window; Telegram retains recurring scheduling and
upload-only circular video notes. The current platform
completion also includes Operations & Audit, complete
operator-delivered invitations/password recovery, custom roles, safe project
cloning and permission-guarded System Health. PostgreSQL is the source of truth;
Redis/BullMQ accelerates recoverable jobs and never owns business state.

Project workspaces also include Automation Activity: a project-scoped view of
contact journeys, current steps, completion/drop-off reasons, timelines and
bounded operational charts. User-facing access, audit, status and alert copy is
translated from internal codes into plain language.

WhatsApp is implemented against Meta's official Cloud API contract. The
connected test path has passed open-window automation, interactive reply and
CRM-history checks. The remaining external acceptance is an approved-template
send outside the window and production-volume verification on the customer's
Meta business account. Instagram remains deliberately deferred until its own
account and provider scope are approved.

`Email & SMS Broadcast` contains the working email campaign product. Email is
sent by the worker through Resend using the verified Omnicus mail and tracking
domains; signed provider events update project analytics and linked CRM lead
history. SMS has no provider and remains under construction.

Sentry is not part of the observability stack. Health and operational alerts are
derived from service probes, queues and durable PostgreSQL journals. Railway
backup configuration remains operator-owned and is not managed by Omnicus.

## Applications and packages

- `apps/web`: React/Vite administration console and Automation Studio.
- `apps/api`: NestJS API, public lead/redirect/unsubscribe routes, provider
  webhooks, CRM service contracts and health endpoints.
- `apps/worker`: BullMQ consumers for inbox/outbox, lead capture, CRM,
  broadcasts, email delivery, continuations and external HTTP operations.
- `packages/database`: Prisma schema and reviewed migrations.
- `packages/automation-core`, `packages/automation-http`: deterministic runtime
  and SSRF-safe External HTTP transport.
- `packages/channel-telegram`, `packages/channel-whatsapp`, `packages/crm-core`,
  `packages/media-core`, `packages/email-core`: provider adapters, rendering
  and durable integration boundaries.

The current implementation and remaining follow-ups are indexed in
[docs/README.md](docs/README.md).

## Required toolchain

- Node.js `24.18.0` from `.node-version`.
- pnpm `10.5.0` through Corepack.
- Docker Desktop or Docker Engine with Compose for local PostgreSQL and Redis.

The repository uses strict engine checks. Install the pinned tools with:

```bash
corepack enable
corepack install
corepack pnpm versions
corepack pnpm preflight
```

## Local setup

```bash
cp .env.example .env
corepack pnpm install --frozen-lockfile
docker compose up -d postgres redis
corepack pnpm db:validate
corepack pnpm db:generate
corepack pnpm db:migrate:dev
corepack pnpm dev
```

On PowerShell, use `Copy-Item .env.example .env` for the copy step.

Default local endpoints:

- Web: `http://localhost:5173`
- API: `http://localhost:3000/health/live` and `/health/ready`
- Swagger, development only: `http://localhost:3000/docs`
- Worker: `http://localhost:3001/health/live` and `/health/ready`
- PostgreSQL: `localhost:5432`
- Redis: `localhost:6379`

## Quality gate

```bash
corepack pnpm format:check
corepack pnpm lint
corepack pnpm check:boundaries
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm db:validate
corepack pnpm db:diff:check
corepack pnpm test:api:production
corepack pnpm test:web:production
corepack pnpm test:worker:production
corepack pnpm test:e2e
corepack pnpm audit:production
```

Production artifacts are assembled under `.runtime/web`, `.runtime/api` and
`.runtime/worker`. Railway deployment, variables, migration ownership and
recovery procedures are documented in [docs/RAILWAY.md](docs/RAILWAY.md) and
[docs/RUNBOOK.md](docs/RUNBOOK.md).

## Database safety

The executable Prisma schema is the current platform schema and every database
change is represented by a reviewed migration under
`packages/database/prisma/migrations`. Never use `prisma db push` against a
shared environment. Apply migrations once through the designated Railway API
pre-deploy step; web and worker services must not run migrations.

Development seeding is opt-in and guarded. Production administrator creation
uses the one-time audited bootstrap described in the operations runbook. Never
commit credentials, Telegram or Meta access tokens, Meta app secrets, CRM
bearer tokens, project secrets or Railway-generated values.

## Documentation

- [Documentation index and current status](docs/README.md)
- [Operator guide](docs/OPERATOR_GUIDE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Architecture decisions](docs/DECISIONS.md)
- [Database design and invariants](docs/DATABASE.md)
- [Automation runtime](docs/AUTOMATION_ENGINE.md)
- [Formal state machines](docs/STATE_MACHINES.md)
- [Testing](docs/TESTING.md)
- [Railway deployment](docs/RAILWAY.md)
- [Operations runbook](docs/RUNBOOK.md)
- [Cyber Pulse CRM integration](docs/CRM_INTEGRATION.md)
- [WhatsApp Business Cloud API](docs/WHATSAPP_CLOUD_API.md)
- [Email campaigns and Resend](docs/EMAIL_BROADCASTS.md)

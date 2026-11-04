# Omnicus

Omnicus is a customer communication and automation platform built as a
pnpm/Turborepo monorepo. It combines project workspaces, contacts and audiences,
Telegram, the official WhatsApp Business Cloud API, Resend email, broadcasts,
Automation Studio, Cyber Pulse CRM integration and Webinar Stars workflows.
PostgreSQL owns business state; Redis/BullMQ runs recoverable background jobs.

Documentation and file layout reviewed: **2026-11-03**.

## Start here

- [Documentation index and recorded release status](docs/README.md)
- [User guides and PDF instructions](docs/guides/README.md)
- [Create a project and connect CRM: short Russian guide](docs/guides/PROJECT_CRM_QUICKSTART_RU.md)
- [Requirements, source specifications and draft proposals](docs/specifications/README.md)
- [Operator workflows and current menu paths](docs/OPERATOR_GUIDE.md)
- [Railway deployment](docs/RAILWAY.md) and [operations runbook](docs/RUNBOOK.md)

## Recorded product status

The latest recorded Webinar Stars rollout is 2026-11-03, application release
`48cc118`. It includes invitations, reminders, saved Results, participant
filtering, full comments, original marketing UTM and customer scenario drafts.
The core Telegram/provider flow passed the recorded live test. Webinar CRM
acceptance remains deferred; missed/replay branches and additional delivery
channels retain their own acceptance scope. See [Webinar Stars](docs/WEBINAR_STARS.md).

WhatsApp uses Meta's official Cloud API. Approved-template delivery outside the
service window and production-volume acceptance remain separate checks.
Instagram messaging and SMS are not implemented product channels. The personal
WhatsApp documents under specifications are **draft proposals**, not shipped
features. Existing platform features and historical release evidence are
indexed in [the documentation catalog](docs/README.md).

## Repository layout

| Location              | Contents                                                                   |
| --------------------- | -------------------------------------------------------------------------- |
| `apps/web`            | React/Vite console and Automation Studio                                   |
| `apps/api`            | NestJS API, webhooks, public routes and CRM contracts                      |
| `apps/worker`         | Inbox/outbox, channel, CRM, email, broadcast and automation workers        |
| `packages`            | Database, deterministic automation runtime and integration adapters        |
| `e2e`                 | Browser acceptance and navigation checks                                   |
| `scripts`             | Toolchain, build, checks and explicitly operated maintenance tools         |
| `docs/guides`         | User PDFs and the project/CRM quick start                                  |
| `docs/specifications` | Source requirements, historical baseline and draft WhatsApp specifications |
| `docs/reviews`        | Meta App Review preparation notes                                          |
| `docs/archive`        | Historical status and Stage 1 review material                              |
| `tmp`                 | Ignored local authoring, screenshots, diagnostics and disposable work      |
| `.runtime`            | Generated deployment artifacts; rebuild rather than edit                   |

Keep release PDFs in the appropriate documentation folder. Local intermediate
renders and build dependencies belong in `tmp`; do not put them in the root.
Customer-provided source PDFs remain local and are intentionally ignored by Git.

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

## Documentation maintenance

[docs/README.md](docs/README.md) is the document catalog and recorded-status
entry point. The root README owns repository setup; do not maintain a second
`README.root.md` copy. Use [archive](docs/archive/README.md) for historical
evidence and [reviews](docs/reviews/README.md) for review preparation.

Creating a project and pairing CRM does not migrate historical contacts or copy
channels and scenarios from another project. Each connection has its own scope;
follow [the short setup guide](docs/guides/PROJECT_CRM_QUICKSTART_RU.md).

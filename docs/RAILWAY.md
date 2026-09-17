# Railway deployment

Status reviewed: 2026-08-14. Omnicus is deployed on Railway from `main`; pushes
to `origin/main` trigger the configured web, API and worker deployments.

## Email Inbox release (2026-09-15, deployment unverified)

The separate Email Inbox release (locally implemented 2026-09-15) **does** require
new migration `20260915010000_email_inbox` and `RESEND_API_KEY` on API as well as
worker. Keep `RESEND_WEBHOOK_SECRET` only on API and private storage on both.
Deploy compatible web/API/worker artifacts through the authorized release path.
Verify Omnicus API → Settings → Deploy → Pre-deploy Command contains
`pnpm db:migrate:deploy`: this is an operator-managed setting, not present in the
tracked API railway.toml. Only one service runs migrations. The checklist is in
[EMAIL_INBOX.md](EMAIL_INBOX.md); a Git push does not verify successful deployment.

## WhatsApp management release (2026-09-10)

The feature release `35fb7d2` changes API, worker and web, including delivery
pricing projections; keep all three services on compatible artifacts. It adds
no database migration and no new environment variables. Existing app settings
and encrypted per-channel Meta credentials remain authoritative.

The UI follow-ups through `3698b7b` are web-only: channel ordering/empty states,
grouped diagnostics, template toolbar/image preview, centered loading and
card/report-error spacing. A successful Git push is not evidence that Railway
finished deploying. Verify the web release commit and reload the browser after
deployment. The report's backend/provider error may still require separate
triage; adding an alert margin does not repair the failed request.

No wallet, card-storage service or payment API secret is introduced. Customers
manage payment methods in Meta. See [WHATSAPP_MANAGEMENT.md](WHATSAPP_MANAGEMENT.md).

## Services

All three services use the repository root and the same lockfile:

| Service | Config                     | Start command                       | Health path     |
| ------- | -------------------------- | ----------------------------------- | --------------- |
| Web     | `apps/web/railway.toml`    | `node .runtime/web/server.mjs`      | `/health/ready` |
| API     | `apps/api/railway.toml`    | `node .runtime/api/dist/main.js`    | `/health/ready` |
| Worker  | `apps/worker/railway.toml` | `node .runtime/worker/dist/main.js` | `/health/ready` |

Railpack reads the exact Node/pnpm versions from the repository and builds only
the selected service plus its workspace dependencies. All servers bind
`0.0.0.0`; Railway's `PORT` overrides local defaults.

## Core variables

Shared API/worker values include `APP_ENV`, `DATABASE_URL`, `REDIS_URL`,
`CHANNEL_SECRETS_KEY` and the reviewed proxy/health settings from
`.env.example`. The API additionally requires `JWT_ACCESS_SECRET`,
`API_PUBLIC_URL`, `CORS_ALLOWED_ORIGINS` and `CRM_INBOUND_ENABLED`. The worker
uses `CRM_INTEGRATION_ENABLED` and the bounded worker/continuation and
WhatsApp recovery intervals.

The API WhatsApp app boundary additionally uses
`WHATSAPP_META_APP_ID`, `WHATSAPP_META_APP_SECRET`,
`WHATSAPP_META_CONFIGURATION_ID`, `WHATSAPP_GRAPH_API_VERSION` and
`WHATSAPP_META_WEBHOOK_VERIFY_TOKEN`. The app secret and verify token are
server-only. Connected phone access tokens are encrypted project credentials,
not shared Railway variables. Missing Meta values keep WhatsApp setup
unavailable without degrading Telegram or the platform health probes.

The web build requires `VITE_API_URL`, which is used server-side as the upstream
for the same-origin `/api` proxy. Browser code must not receive database, Redis,
CRM, Telegram, media bucket or project-secret credentials.

Media storage requires the `MEDIA_BUCKET_*` values and
`MEDIA_STORAGE_ENABLED=true`. CRM inbound and outbound credentials are
different values. New project pairings store project-scoped credentials; the
global `CRM_BASE_URL`, `CRM_AUTH_TOKEN` and `CRM_INBOUND_AUTH_TOKEN` values are
compatibility inputs only for the legacy paired project.

Email delivery adds `RESEND_API_KEY`, `EMAIL_FROM`, optional
`EMAIL_REPLY_TO`, `EMAIL_DELIVERY_BATCH_SIZE`,
`EMAIL_DELIVERY_INTERVAL_MS` and `EMAIL_DELIVERY_LEASE_MS` to the worker. The
API alone owns `RESEND_WEBHOOK_SECRET`. `API_PUBLIC_URL` must be the public API
origin on both API and worker because it is used for public registration,
tracked redirects and unsubscribe links.

Current public domain ownership:

- web: `https://omnicus.app`;
- API/webhooks: `https://api.omnicus.app`;
- Resend sending domain: `mail.omnicus.app`;
- Resend tracking domain: `links.mail.omnicus.app`.

The worker has no customer-facing route and does not need a branded custom
domain. Its Railway-generated HTTP endpoint is used only for health checks.

Never commit Railway variables or paste them into logs, documentation or test
fixtures. `.railway/` is ignored.

## Networking and health

- Web serves the SPA and proxies `/api` to the API origin.
- Telegram and Meta call public API webhooks derived from server-owned
  `API_PUBLIC_URL`. Meta's app-level WhatsApp callback is
  `/webhooks/whatsapp` and requires exact raw-body HMAC verification.
- API readiness probes PostgreSQL and Redis.
- Worker readiness requires both its BullMQ producer and running consumer.
- Dependency failure returns `503`; liveness stays independent of external
  dependencies.

Railway private networking does not replace authentication or encryption.
`TRUST_PROXY` must match the reviewed ingress topology and must not trust broad
ranges by convenience.

## Migration flow

The executable schema has reviewed migrations through
`20260814030000_email_campaigns`, including lead capture/link tracking and
WhatsApp mailing eligibility. Exactly one designated API
pre-deploy step runs:

```text
pnpm db:migrate:deploy
```

Do not run migrations from web, worker, replica start commands or multiple
services. A failed migration blocks the new application release. Never use
`prisma db push` against Railway.

The one-time administrator bootstrap is a separate, explicitly enabled API
pre-deploy operation. Remove all bootstrap variables immediately after it
succeeds. Details and incident procedures are in [RUNBOOK.md](RUNBOOK.md).

After both the updated Omnicus worker/API and Cyber Pulse backend are deployed,
historical contact merges are reconciled from the Railway **Omnicus worker**
service shell. Always preview one project first:

```text
node .runtime/worker/dist/crm/contact-merge-backfill.cli.js --dry-run --project-id <omnicus-project-id>
```

If `conflicts` and `failed` are empty and the counts are expected, execute:

```text
node .runtime/worker/dist/crm/contact-merge-backfill.cli.js --execute --project-id <omnicus-project-id>
```

The command defaults to dry-run, uses batches of 50 and accepts
`--batch-size 1..500`. It is idempotent and does not replace the migration.

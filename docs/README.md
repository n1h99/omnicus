# Omnicus documentation

Catalog and release record reviewed: **2026-11-04**. For repository setup and
commands, use the [root README](../README.md).

## User instructions

| Need                                    | Document                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| All user PDFs                           | [Guide catalog](guides/README.md)                                             |
| Add a project and connect CRM           | [Short Russian setup guide](guides/PROJECT_CRM_QUICKSTART_RU.md)              |
| Daily work in Omnicus                   | [Omnicus user guide, 20 pages](guides/Omnicus_User_Guide_RU.pdf)              |
| Webinar setup and operation             | [Webinar Stars guide, 12 pages](guides/Omnicus_Webinar_Stars_Guide_RU.pdf)    |
| Work across Omnicus and Cyber Pulse     | [Combined workflow guide, 24 pages](guides/Omnicus_CRM_Workflow_Guide_RU.pdf) |
| Current project menu and operator tasks | [Operator guide](OPERATOR_GUIDE.md)                                           |
| Meta lead-form setup in Russian         | [Meta lead guide](META_LEADS_USER_GUIDE_RU.md)                                |

## Recorded release and acceptance boundaries

- **Golden Visa Meta forms, 2026-11-04:** the verified business-hours form was
  added to live intake after API `f73af81` deployed successfully. The normal
  processing path recovered the two missed source receipts: one CRM card and
  one confirmed Telegram send; one contact conflict retained in `REVIEW`.
  USD budgets are supported for both verified budget forms. Credentials and the
  original live cutover were preserved. [Recovery record](META_LEADS.md#budgetad-extension-2026-10-14).
- **Webinar Stars, 2026-11-03:** the recorded Omnicus API/Web/Worker rollout is
  `48cc118`; both webinar migrations were applied. Invitations/reminders,
  provider interactions, JSON completion, original-session binding, personal-link
  contact matching and report-driven Telegram delivery passed the recorded live
  checks. Results includes server-side filters/pagination, full comments and
  original marketing attribution. Customer scenario presets create drafts for
  explicit publication. The four diagnostic scenarios are paused with published
  versions retained. **Webinar CRM acceptance is deferred**; the tested webinar's
  CRM flag is off. Missed/replay branches and other channels remain separate
  acceptance work. [Current workflow and checklist](WEBINAR_STARS.md).
- **Core platform:** projects/RBAC, contacts, Communications, Telegram, WhatsApp
  Cloud API, email, broadcasts, Automation Studio 2.2, CRM pairing/contact sync,
  public registration, tracked links, Operations & Audit and Automation Activity
  are implemented. Deployment and provider evidence is scoped to each recorded
  release; the presence of code does not verify a newly connected account.
- **WhatsApp:** open-window messaging and the connected CRM flow have recorded
  live evidence. Outside-window approved-template delivery and production volume
  retain separate acceptance. [Feature and billing boundaries](WHATSAPP_MANAGEMENT.md).
- **Meta and CRM:** the Golden Visa Omnicus route and the automotive ApiX route
  are separate integrations. CRM `staging` identifies the live Golden Visa
  business, not a disposable sandbox. [Route boundaries](META_LEADS.md).
- **Proposals:** personal WhatsApp specifications are drafts for agreement.
  Instagram messaging and SMS remain deferred. Requirements PDFs are source
  material, not evidence that a feature is deployed or accepted.

Older dated rollout details are preserved in the
[historical status snapshot](archive/DOCUMENTATION_STATUS_2026-11-03.md).
This documentation cleanup did not run a new deployment or provider acceptance.

## Engineering and operations

| Area                                          | Reference                                                     |
| --------------------------------------------- | ------------------------------------------------------------- |
| Agent instructions and requirement precedence | [AGENTS.md](AGENTS.md)                                        |
| Architecture and trust boundaries             | [ARCHITECTURE.md](ARCHITECTURE.md)                            |
| Implementation stages and follow-ups          | [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)              |
| Accepted decisions                            | [DECISIONS.md](DECISIONS.md)                                  |
| Database and migration invariants             | [DATABASE.md](DATABASE.md)                                    |
| Automation semantics                          | [AUTOMATION_ENGINE.md](AUTOMATION_ENGINE.md)                  |
| Durable lifecycle rules                       | [STATE_MACHINES.md](STATE_MACHINES.md)                        |
| Edge cases                                    | [EDGE_CASES.md](EDGE_CASES.md)                                |
| Railway topology and rollout                  | [RAILWAY.md](RAILWAY.md)                                      |
| Incidents and recovery                        | [RUNBOOK.md](RUNBOOK.md)                                      |
| Test and release gates                        | [TESTING.md](TESTING.md)                                      |
| Dependency exceptions                         | [DEPENDENCY_EXCEPTIONS.md](DEPENDENCY_EXCEPTIONS.md)          |
| Manual test-data tools                        | [Cleanup tool README](../scripts/test-data-cleanup/README.md) |

## Integration and product contracts

| Area                                         | Reference                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| Cyber Pulse integration                      | [CRM_INTEGRATION.md](CRM_INTEGRATION.md)                               |
| CRM lead profile synchronization             | [CRM_CONTACT_SYNC.md](CRM_CONTACT_SYNC.md)                             |
| Contact conversations                        | [COMMUNICATIONS.md](COMMUNICATIONS.md)                                 |
| Webinar Stars setup, behavior and acceptance | [WEBINAR_STARS.md](WEBINAR_STARS.md)                                   |
| Meta lead intake                             | [META_LEADS.md](META_LEADS.md)                                         |
| WhatsApp Cloud API                           | [WHATSAPP_CLOUD_API.md](WHATSAPP_CLOUD_API.md)                         |
| WhatsApp templates, health and billing       | [WHATSAPP_MANAGEMENT.md](WHATSAPP_MANAGEMENT.md)                       |
| Email campaigns and Resend                   | [EMAIL_BROADCASTS.md](EMAIL_BROADCASTS.md)                             |
| Email Inbox                                  | [EMAIL_INBOX.md](EMAIL_INBOX.md)                                       |
| CRM to Omnicus                               | [OMNICUS_CRM_OUTBOUND_OPENAPI.yaml](OMNICUS_CRM_OUTBOUND_OPENAPI.yaml) |
| Omnicus to CRM                               | [OMNICUS_TO_CRM_OPENAPI.yaml](OMNICUS_TO_CRM_OPENAPI.yaml)             |
| CRM pairing                                  | [CRM_PAIRING_OPENAPI.yaml](CRM_PAIRING_OPENAPI.yaml)                   |
| Webinar CRM extension                        | [WEBINAR_CRM_OPENAPI.yaml](WEBINAR_CRM_OPENAPI.yaml)                   |

## Specifications, reviews and history

- [Requirements and specification catalog](specifications/README.md): source PDFs,
  draft personal WhatsApp alternatives and the historical pilot baseline.
- [Meta App Review preparation](reviews/README.md): submission material and
  operator checklist; current Meta approval must be checked in Meta itself.
- [Archive catalog](archive/README.md): old status entries and Stage 1 SQL proposal.
- Customer patch notes: [2026-08-29](CUSTOMER_PATCH_NOTES_2026-08-29.md),
  [2026-09-10](CUSTOMER_PATCH_NOTES_2026-09-10.md),
  [2026-09-17](CUSTOMER_PATCH_NOTES_2026-09-17.md).
- Retained handoffs: [original CRM contract gate](CRM_CONTRACT_REQUIRED.md),
  [outbound history](CRM_OUTBOUND_HISTORY_HANDOFF.md),
  [Telegram sticker/media](CRM_TELEGRAM_STICKER_MEDIA_HANDOFF.md),
  [Telegram v3 implementation](OMNICUS_TELEGRAM_CHAT_V3_IMPLEMENTATION.md),
  [external gate ledger](PILOT_EXTERNAL_GATES.md).

When historical prose differs from current behavior, use accepted ADRs, the
versioned contracts, executable schema and capability responses. The root
README and this catalog replace the removed duplicate `README.root.md`.

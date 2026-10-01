# Meta lead forms → Golden Visa CRM (contract meta-leads/v1)

Local implementation, 2026-10-01. **Not deployed or activated by this change.**
Omnicus uses its production deployment. CRM Git branch `staging` is the LIVE
Golden Visa business; car-import CRM production is not a target.

## Safe rollout

1. Deploy the CRM backend from `staging` and Omnicus API/web after the user approves
   publishing. Apply the additive `20261001100000_meta_lead_intake` PostgreSQL
   migration to the verified Omnicus database. Never import inventory `.env`
   files over live variables. Existing MongoDB cards do not need backfilling:
   matching reads their current email/phone, including archived cards.
2. Set `META_LEADS_ENABLED=true` **only on the Golden Visa CRM backend**. This
   permits the dedicated endpoint and serializes competing manual/Omnicus/Meta
   creates for the same email/phone. A matching contact returns HTTP 409 instead of a
   duplicate. Leave it absent/false on car-import CRM. No new Omnicus Railway
   credential variable is needed; do not replace WhatsApp or CRM pairing tokens.
3. In Omnicus, open the target project's **CRM integration → Meta lead forms →
   Connection settings**. A working project-specific CRM pairing is required.
   Enter Page ID `717670618093733`, form ID `1580656199599705`, Graph `v26.0`, a
   **fresh** server-appropriate Page access token, the existing Meta application's
   App Secret, and a new random webhook verify token (32+ characters). Save.
   Secrets are encrypted with the existing CHANNEL_SECRETS_KEY, never returned
   by the API and cleared from the form after save. No token is included here.
4. **Test access** verifies Page token identity, form ownership, permission to
   read leads, and availability of the new paired CRM endpoint. This is not
   proof of webhook subscription, App Review approval, or token longevity.
5. **Start preview** records the cutover timestamp and runs read-only CRM matching.
   It permits receiving signed events and polling but does not create CRM cards.
6. In the same Meta app configure the **Page** webhook callback at the Omnicus API
   origin plus `/webhooks/meta-leads/<omnicus-project-id>`, using the saved verify
   token. Subscribe to `leadgen` and subscribe the app to the target Page.
   Do not edit the existing WhatsApp callback/credential. This first version
   must not overwrite a Page callback already serving another integration;
   inspect it first and extend routing separately if it is in use.
   uses a callback per project and one Page per configuration; connecting more
   Pages to one app needs a separately designed app-level router, not replacing
   another project's callback. Confirm both Meta subscription levels externally.
7. Choose the historical interval under **Compare historical leads**. Scans read
   all available pages and only compare records inside `[from, until)`, up to
   90 days per requested interval. API availability/retention still limits what
   can be recovered. Review results: existing card / missing / needs review.
   Nothing is imported automatically, and no historical Telegram flood occurs.
8. Approve individual unambiguous rows with **Link** or **Import**. Matching runs
   again at apply time. These manually approved imports never send NEW LEAD.
   Resolve conflicting CRM cards manually; this feature does not merge them.
9. After reviewing the report and one controlled end-to-end test, explicitly
   **Enable live delivery**. The original cutover is retained. Rows already
   previewed remain pending individual approval; enabling does not bulk-release
   them. Newly received live submissions can create a card and its notification.

The exposed Explorer token from the conversation must not be reused. Token
expiry/access revocation surfaces as a scan error or processing failure. Renew
the credential in this panel after stopping intake, test again, then resume.
The cutover does not move on resume, so polling can recover the paused interval.

## What is matched

Permanent identity is `(omnicusProjectId, pageId, leadgenId)`; webhook, polling,
manual retries and old receipts share it. CRM stores a unique indexed source-key
array on the card without TTL. Repeated submissions from one person can attach
multiple source keys to a single card without silently creating another deal.

For submissions with no known source key, match trimmed case-insensitive email
and international phone digits, ignoring common spaces, parentheses and dashes
and recognizing the `00` international prefix. No country-code guessing, fuzzy
name matching, Gmail dot/plus alias stripping or `Unknown` matching. If both
contact fields are present but disagree with the found card, or more than one
card matches, stop in REVIEW. No reliable identifier also means REVIEW.

Matches preserve profile data, assignments, stage, archive state, comments and
consents. Missing fields are not silently filled. Names remain `full_name` rather
than a guessed first/last split. Country maps from the actual form question
`country_of_residence:` (including its trailing colon). A new card uses META
attribution, original submission time and the existing NEW pipeline default.
Submitting a lead form never grants WhatsApp/email marketing consent.

Exact matching cannot identify a manually entered card when both contacts were
mistyped or changed; historical preview and human review are important. This is
not a promise of perfect person identification or exactly-once network delivery.

## Journal, retries and operational safety

Webhook raw bytes require HMAC-SHA256 with the configured App Secret. Unknown
Pages/forms are ignored; valid configured receipts are inserted before HTTP 200.
No Graph/CRM request is made inside webhook acknowledgement. Invalid bodies and
signatures are not persisted. The existing WhatsApp handler is unchanged.

PostgreSQL is authoritative for inbox, frozen payload and outbound intent. A
bounded background pump in the API drains at most ten submissions and one poll
page per tick. The API may run on multiple replicas: claim ownership uses atomic
conditional writes and expiring journal leases. CRM's separate creation gate and
permanent source index protect actual writes. Form pagination commits cursor and
receipts together; no `paging.next` URL/access token is stored. A completed live
scan starts again after five minutes, so very large forms take longer than five
minutes to complete a full cycle. Errors do not advance cursors or drop receipts.

States: FETCH → READY → PREVIEW_NEW/PREVIEW_MATCH/REVIEW, or READY → DELIVERING →
DONE/UNKNOWN. Failed reads back off up to five minutes and stop in ERROR after
twelve attempts. A missing apply response or expired DELIVERING claim becomes
UNKNOWN and reconciles the permanent source key first. No blind apply retry.
An explicit, audited Recheck is available after investigation. Notify decisions
are frozen before sending; existing/source-linked cards never queue another alert.

CRM uses standalone-MongoDB-compatible contact creation gates, shared with manual and
ordinary Omnicus creates only while META_LEADS_ENABLED=true. Concurrent writers
receive `LEAD_CREATION_BUSY` (503), not a successful duplicate. **There is no TTL
or automatic lock stealing.** A crashed writer or ambiguous MongoDB failure keeps
the affected identity gates in `lead_creation_gates` (`_id: meta-v1:<sha256>`).
Email/phone/source keys are hashed; all locks acquired by one attempt share an
`owner`. Unrelated contacts are not blocked. Before an operator removes the
verified stale owner's exact records, stop all CRM writers and inspect whether the lead/source key was
saved, and establish that no old process can resume. Then restart and reconcile.
Do not clear arbitrary locks, disable the guard while intake is running, or use
automatic expiry as a workaround. Ordinary conflicts release the gate normally.

CRM-to-Omnicus contact creation reuses the existing durable reverse-sync queue.
There is no second person store or automatic marketing scenario trigger here.
A reconciliation call repairs a failure between card persistence and sync enqueue.
All settings, scans, approvals and explicit retries require integrations:manage;
write actions are audited without credentials or personal data in the audit event.

## HTTP contract

Omnicus authenticated project prefix: `/api/v1/projects/:projectId/meta-leads`.

| Method / suffix                 | Purpose                                                     |
| ------------------------------- | ----------------------------------------------------------- |
| GET / PUT root                  | Read safe configuration / save disabled credentials         |
| POST `/test`                    | Verify Graph access and paired CRM capability               |
| POST `/start`                   | `{liveFrom: ISO8601, deliveryEnabled: boolean}`             |
| POST `/stop`                    | Stop intake and future dispatch; in-flight calls may finish |
| POST `/history-preview`         | `{from: ISO8601, until: ISO8601}`; no import                |
| GET `/submissions?cursor=...`   | `{items, nextCursor}`, 100 project-scoped rows              |
| GET `/polls`                    | Last 100 scan statuses, without provider cursors            |
| POST `/submissions/:id/approve` | `{confirmHistoricalImport: boolean}`                        |
| POST `/submissions/:id/retry`   | `{confirmUnknownRetry: boolean}`                            |

CRM authenticated prefix: `/integrations/v1/omnicus/meta-leads/v1`.
POST `/preview`, `/apply`, `/reconcile` accept required strings `crmProjectId`,
`omnicusProjectId`, `pageId`, `formId`, `leadId`, `createdAt`; optional `name`,
`email`, `phone`, `countryOfResidence`, `notify` (boolean, defaults to no alert).
Existing service bearer authentication and active paired-project validation apply.
Outcomes: NEW/MATCH/REVIEW for preview; CREATED/LINKED/REVIEW for apply;
LINKED/NOT_FOUND for reconciliation. Matched responses carry `crmLeadId`;
review responses carry a safe `reason`. The POST reconcile may repair reverse
sync but never creates a card or emits a new-lead notification.

Provider contract: Graph v26.0, verified 2026-10-01 against user-run calls and
[Meta's official LeadgenForm SDK](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/leadgenform.py)
and [Lead SDK](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/lead.py).
The Meta developer site returned 429 during implementation. Live account review,
Page subscription, token lifetime and actual webhook delivery remain to be tested.

## Local verification and handoff (2026-10-01)

Implemented under ADR-066. Main changes: Omnicus `apps/api/src/meta-leads/`,
`apps/web/src/meta-leads-panel.tsx` and its CRM integration-page mount; three
additive Prisma models/migration; CRM `meta-leads.service.ts`,
`lead-creation-guard.service.ts`, source-key index and guarded existing create
entry points. Existing environment inventories and unrelated PDF output were
preserved; no credential value was copied from the conversation.

Checks completed locally:

- 48 new checks: 22 Meta API/unit tests, 6 HTTP authorization/validation tests,
  16 CRM matching/import tests using disposable standalone MongoDB, 3 UI component
  tests, and 1 disposable PGlite migration test.
- CRM targeted regression: 59 tests passed including ordinary Omnicus upsert
  and Telegram lead-notification tests. Production backend build passed.
- Omnicus web: 100 tests passed; API integration: 12 passed, 1 external-service
  readiness check skipped. Database suite: 35 tests passed, including all real
  migrations applied to PGlite. No installed/live database was used.
- API/web typechecks, focused lint/format, Prisma validation/SQL invariants,
  workspace boundaries, web bundle guard and `git diff --check` passed.
- Full API and web production builds/runtime packaging passed using the pinned
  Node 24.18.0 at `C:/nvm4w/nodejs`. The IDE's default Node 24.19.0 initially
  failed the existing strict version gate; no global toolchain was changed.

Known unrelated baseline checks are not represented as green: the full API unit
suite has one failure for 16 missing human-readable error mappings in existing
workspace/communication code. Full CRM test-inclusive tsc also reports existing
conversation/reaction test typing errors; focused lint of the pre-existing
Omnicus upsert reports two existing unsafe JSON assignments. New files and the
production CRM build pass. These unrelated issues were not refactored here.

The Browser skill found no connected browser. UI component tests passed, but
visual browser acceptance is still pending. No Git commit/push, Railway deploy,
live migration, Meta subscription change, real lead import or Telegram delivery
was performed. Next gate: approve publishing, configure the fresh credential,
run preview against the real Golden Visa database and verify one controlled lead.

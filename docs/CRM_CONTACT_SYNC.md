# CRM lead to Omnicus contact synchronization

Status: implemented in Omnicus `main` and Cyber Pulse backend `staging` on
2026-09-17. Deployment, migration application and live paired-project
acceptance must be verified separately.

## Purpose and ownership

The existing integration projects Omnicus contacts into Cyber Pulse leads.
This extension closes the reverse profile gap: a manager-created or edited CRM
lead creates or updates the matching Omnicus contact.

Cyber Pulse remains authoritative for the lead card change that triggered the
snapshot. Omnicus remains authoritative for contact/channel history,
messaging-policy state and identities. Synchronization never performs fuzzy
matching by name, phone, email or username.

## Trigger and snapshot

Cyber Pulse queues the latest full contact snapshot after these successful
lead operations:

- create;
- general update, including `client` profile fields;
- archive;
- restore.

The snapshot contains the CRM lead ID, display name, email, phone, Telegram
username, CRM lifecycle status and the lead `updatedAt` timestamp. Empty
profile fields are valid. Omnicus uses `CRM lead <crmLeadId>` only as a stable
fallback display name.

Hard deletion is not projected. Vehicle, media and document-only updates do
not enqueue redundant contact snapshots. Bulk imports that write Mongoose
models directly do not use the lead service and therefore require an explicit
future backfill if they must appear immediately.

## Cyber Pulse durable delivery record

MongoDB stores one `OmnicusContactSync` record per lead. A new lead update
replaces the pending payload with the latest complete snapshot, assigns a new
`syncVersion`, resets retry state and cannot be overwritten by completion of
an older in-flight version.

States:

```text
PENDING -> PROCESSING -> SUCCEEDED
                     -> PENDING (bounded backoff)
                     -> DEAD_LETTER (after 12 failed attempts)
```

The dispatcher scans every five seconds, claims at most 20 records per pass,
recovers two-minute stale locks and uses exponential delay from five seconds
up to fifteen minutes. A new edit resets a dead-letter record because the
latest state supersedes the failed snapshot. Lead save is not rolled back when
queue persistence or Omnicus delivery is temporarily unavailable; failures
are logged with safe code and lead ID only.

## Omnicus endpoint and idempotency

Cyber Pulse calls:

```text
POST /integrations/v1/crm/contacts/upsert
Authorization: Bearer <project-scoped service token>
Idempotency-Key: crm-lead-sync:<lead-id>:<snapshot-hash>
X-Correlation-Id: <uuid>
```

The exact request/response schema is in
[OMNICUS_CRM_OUTBOUND_OPENAPI.yaml](OMNICUS_CRM_OUTBOUND_OPENAPI.yaml).
Omnicus verifies the authenticated project pairing, serializes concurrent
updates for the same project/lead, and searches only by
`projectId + crmLeadId`. Reusing an idempotency key with another payload is a
conflict.

`Contact.crmSourceUpdatedAt` stores the latest applied CRM version. An older
snapshot returns `applied=false` and cannot overwrite newer data. The additive
migration is `20260917100000_crm_contact_inbound_sync`.

CRM `ARCHIVED` maps to contact archive state for ordinary active contacts.
Messaging-safety states `BLOCKED` and `UNSUBSCRIBED` are never erased by CRM
archive/restore. The endpoint writes a content-free audit projection and never
stores the service credential or raw CRM payload in audit logs.

## Pairing and deployment order

Preferred rollout order:

1. deploy the Omnicus migration and API containing the upsert endpoint;
2. confirm the paired project route and inbound service authentication;
3. deploy Cyber Pulse backend with the MongoDB queue/dispatcher;
4. create a minimally filled test lead, then add/change contact fields;
5. verify one Omnicus contact retains the same ID and `crmLeadId`;
6. archive/restore the lead and verify policy statuses are preserved.

Deploying Cyber Pulse first does not roll back lead edits; requests remain in
its retry queue. It can still reach `DEAD_LETTER`, so the endpoint and pairing
must be restored before relying on eventual delivery.

No automatic bulk backfill is part of this release. Existing CRM leads
synchronize on their next general edit/archive/restore. A future bulk backfill
must be a bounded, idempotent operator command with project and count guards;
it must not be implemented as an unbounded startup scan.

## Incident checks

- Contact missing: find the lead's `OmnicusContactSync` record and inspect
  `status`, `attempts`, `nextAttemptAt` and `lastErrorCode` without copying its
  PII payload into tickets.
- `OMNICUS_CONTACT_SYNC_NOT_CONFIGURED`: restore an active pairing or the
  reviewed legacy route configuration.
- Authentication/routing failure: compare paired `crmProjectId` and
  `omnicusProjectId`; never change request IDs to bypass isolation.
- `DEAD_LETTER`: fix the route/validation issue, then save the lead again to
  enqueue the latest snapshot. There is no public blind-retry endpoint.
- Duplicate-looking contact: inspect exact `crmLeadId` links. Do not merge by
  phone/email automatically; use the explicit contact merge workflow.
- Stale data: compare CRM `updatedAt` with Omnicus `crmSourceUpdatedAt`; an
  intentionally ignored older snapshot is a successful safety outcome.

Automated verification and the remaining live gate are recorded in
[TESTING.md](TESTING.md).

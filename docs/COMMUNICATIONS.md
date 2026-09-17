# Communications workspace

Status: implemented on `origin/main` on 2026-09-17. Railway deployment and
joint live channel acceptance must be verified separately.

## Product boundary

`Project -> Communications` is the Omnicus contact-first workspace for direct
manager communication. The desktop layout keeps the searchable contact list in
the left pane and the selected conversation in the right pane. It reuses the
existing Telegram, WhatsApp and Email records and delivery services; it does
not copy Cyber Pulse UI code, create a second message store or replace the CRM
lead-card chat.

The contact list includes every non-merged project contact and exposes only
safe summary data. Telegram and WhatsApp tabs are derived from active channel
identities. Email appears when the contact has an address and uses the existing
Email Inbox mailbox/thread APIs. A contact can therefore exist before any chat
identity is available.

## Permissions

- `communications:read`: open the workspace, search contacts, read contact and
  channel summaries, message history and approved WhatsApp templates.
- `communications:send`: send Telegram/WhatsApp messages and upload or select
  channel media.
- Email still enforces its own `email:read` and `email:send` mailbox rules.
- Media uploads still require the normal project/media ownership checks.

The permission migration is
`20260917090000_communications_permissions`. Built-in project roles receive the
documented defaults; custom roles must be reviewed explicitly after rollout.

## API surface

All routes are authenticated and project-scoped under
`/api/v1/projects/:projectId/communications`:

```text
GET  /contacts
GET  /contacts/:contactId
GET  /contacts/:contactId/messages?identityId=...
GET  /contacts/:contactId/whatsapp-templates?connectionId=...
POST /contacts/:contactId/messages
GET  /media
POST /media/upload/:kind?channel=telegram|whatsapp
GET  /media/:assetId/url
```

Message submission requires a caller-generated `clientRequestId`. The API
translates the request into the same durable channel outbox used by CRM and
automation, and records the authenticated Omnicus user in safe audit metadata.
A queued response is not provider delivery evidence.

## Channel rules

### Telegram

Telegram requires an active contact identity. Text, supported media, replies
and the already implemented provider-specific options pass through the shared
Telegram validation and outbox boundary. The Communications page must not
invent capabilities that the selected connection does not expose.

### WhatsApp

Free-form content remains subject to the persisted customer-service window.
Outside the window, use a connection-scoped, synchronized and `APPROVED` Meta
template. Meta templates are not CRM quick replies: quick replies are text
shortcuts and cannot reopen a closed service window.

For an eligible contact with granted WhatsApp consent and a valid phone,
sending an official template may create the missing project/connection-scoped
WhatsApp identity. The identity is synchronized to paired CRM history through
the normal durable CRM boundary. A phone already owned by another contact,
blocked reachability, missing consent or inactive contact/connection fails
closed. Omnicus never claims that template submission is free; Meta bills the
connected business account under its current rules.

### Email

The Email tab is a second navigation surface over Email Inbox, not another
email implementation. Mailbox assignment, private drafts, suppression,
sender/reply snapshots, attachments, signed receiving and UNKNOWN handling
remain governed by [EMAIL_INBOX.md](EMAIL_INBOX.md). Campaign composition stays
in `Email & SMS Broadcast`.

## Deliberate limits

- The first release does not copy CRM-only notes, personal quick replies,
  scheduling controls, mutation menus or the complete Telegram advanced
  composer into Omnicus.
- A missing channel identity is visible as unavailable; Omnicus does not infer
  Telegram identities from usernames or merge contacts by profile fields.
- The workspace does not bypass consent, reachability, service-window,
  suppression, project status or channel status guards.
- CRM keeps its existing lead-card modals. Changes to this page must not make
  CRM depend on Omnicus frontend code.

## Rollout and smoke checks

1. Apply the communications permission migration and synchronize built-in
   project roles.
2. Confirm a read-only role can open history but cannot send or upload.
3. Verify contact search and selection with contacts that have no identities,
   one identity and both Telegram/WhatsApp identities.
4. Send Telegram text/media on an active test identity and reconcile the
   provider result.
5. Verify WhatsApp free-form open-window behavior, the closed-window guard and
   an approved Meta template with the customer's test business account.
6. Open an Email conversation using an assigned mailbox and confirm that the
   same thread appears in Email Inbox.
7. Confirm CRM lead-card chats still behave unchanged.

Automated coverage is summarized in [TESTING.md](TESTING.md). Live provider
acceptance remains a separate operational gate.

# Customer patch notes — 2026-09-17

## Contact audiences

- Contact groups can be manual or rule-based.
- Telegram, WhatsApp and email broadcasts can target all eligible contacts, a
  saved group or selected individual contacts.
- Channel eligibility, consent, reachability and suppressions are still
  checked when a campaign starts.

## Communications in Omnicus

- Projects now include a contact-first `Communications` workspace.
- Contacts stay in the left pane; Email, WhatsApp and Telegram conversations
  open in the right pane.
- Telegram and WhatsApp reuse the existing durable message pipeline.
- Email reuses Email Inbox and its mailbox permissions.
- CRM lead-card chat remains available and unchanged.

## WhatsApp templates in CRM

- CRM labels official provider templates as **Meta templates**.
- CRM quick replies are explicitly described as local text shortcuts; they do
  not bypass the customer-service window.
- The template dialog can refresh the synchronized Meta list and warns that
  Meta may charge the connected business account. CRM does not add a message
  fee or store payment details.

## CRM contacts in Omnicus

- Creating or editing a CRM lead now creates or updates its Omnicus contact.
- Minimally filled leads receive a stable fallback display name.
- Delivery is retried from a durable CRM queue and older snapshots cannot
  overwrite newer contact data.
- Archive/restore synchronization preserves blocked and unsubscribed safety
  states.
- Existing CRM leads synchronize on the next general edit; this release does
  not run an automatic historical bulk backfill.

## Release notes

The code is published in Omnicus `main` and Cyber Pulse frontend/backend
`staging`. Repository publication is not proof of Railway migration or live
provider acceptance. Follow [COMMUNICATIONS.md](COMMUNICATIONS.md),
[CRM_CONTACT_SYNC.md](CRM_CONTACT_SYNC.md) and the joint live checklist before
declaring production acceptance.

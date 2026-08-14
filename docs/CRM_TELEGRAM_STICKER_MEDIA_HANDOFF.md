# CRM handoff: Telegram stickers and media spoilers

Status: completed historical handoff for provider contract 3.1.0. Current
capabilities are published by contract 3.3.0.

Authoritative schemas:

- CRM to Omnicus: `OMNICUS_CRM_OUTBOUND_OPENAPI.yaml`
- Omnicus to CRM: `OMNICUS_TO_CRM_OPENAPI.yaml`

## Capability gates

CRM must fetch the existing connection-scoped capability response and enable
features only when these exact keys have `supported=true`:

- `stickers`
- `mediaSpoilers`

At the time of the 3.1.0 handoff, `mediaGroups` was `supported=false`. Contract
3.2.0 now publishes a dedicated durable media-group aggregate. Do not implement
an outbound album by calling the single-message endpoint repeatedly; use the
current v3.2 OpenAPI and capability response.

## CRM to Omnicus

The existing media upload accepts `kind=STICKER`. The existing outbound message
DTO accepts:

```json
{
  "media": {
    "kind": "STICKER",
    "mediaAssetId": "uuid"
  }
}
```

Sticker messages must not contain `text`, `entities` or `linkPreviewOptions`.
Supported uploads are WEBP, TGS and WEBM; Omnicus validates their signature,
extension and format-specific size limit.

For PHOTO, VIDEO and ANIMATION only, the existing outbound DTO accepts:

```json
{
  "hasSpoiler": true,
  "media": {
    "kind": "PHOTO",
    "mediaAssetId": "uuid"
  }
}
```

The operation lifecycle, idempotency key and reconciliation rules do not
change.

## Omnicus to CRM

Inbound and outbound-history media now allow:

```json
{
  "kind": "STICKER",
  "type": "sticker"
}
```

Media may additionally contain `hasSpoiler`, `mediaGroupId`, `emoji` and
`setName`. The last two fields are optional sticker metadata. CRM should use
`mediaGroupId` only to group already-existing inbound Telegram media. It is not
an instruction to send an album.

CRM should render sticker media without a caption field, preserve spoiler
presentation, and retain metadata-only fallback when the short-lived download
URL cannot be ingested. Signed URLs and provider payloads must not be stored.

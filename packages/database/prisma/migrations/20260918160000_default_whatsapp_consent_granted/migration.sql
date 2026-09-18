ALTER TABLE "contacts"
  ALTER COLUMN "whatsAppConsentStatus" SET DEFAULT 'GRANTED';

UPDATE "contacts"
SET
  "whatsAppConsentStatus" = 'GRANTED'::"MarketingConsentStatus",
  "whatsAppConsentSource" = COALESCE("whatsAppConsentSource", 'default_granted'),
  "whatsAppConsentAt" = COALESCE("whatsAppConsentAt", "updatedAt", NOW()),
  "whatsAppOptOutAt" = NULL
WHERE "whatsAppConsentStatus" = 'UNKNOWN'::"MarketingConsentStatus";

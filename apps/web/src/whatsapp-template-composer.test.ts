import { describe, expect, it } from 'vitest';

import {
  assetKindForWhatsAppSlot,
  whatsAppParameterSlots,
  whatsAppTemplateComponents,
  whatsAppTemplateComposerIssue,
  whatsAppTemplateParameterValues,
} from './whatsapp-template-composer';
import type { WhatsAppMessageTemplate } from './whatsapp-templates-api';

function template(
  components: WhatsAppMessageTemplate['components'],
  category: WhatsAppMessageTemplate['category'] = 'UTILITY',
): WhatsAppMessageTemplate {
  return {
    category,
    components,
    id: 'template-id',
    languageCode: 'en_US',
    lastSyncedAt: '2026-08-03T00:00:00.000Z',
    name: 'order_ready',
    quality: 'GREEN',
    rejectionReasonCode: null,
    status: 'APPROVED',
  };
}

describe('WhatsApp template composer', () => {
  it('blocks normalized unsupported Meta structures instead of sending a stripped template', () => {
    expect(
      whatsAppTemplateComposerIssue(
        template([{ type: 'BODY', unsupportedReason: 'WHATSAPP_TEMPLATE_COMPONENT_UNSUPPORTED' }]),
      ),
    ).toContain('not supported');
  });
  it('maps safe text, media and quick-reply values into Meta component order', () => {
    const slots = whatsAppParameterSlots(
      template([
        { format: 'IMAGE', type: 'HEADER' },
        { text: 'Hello {{1}}, order {{2}} is ready', type: 'BODY' },
        { buttons: [{ text: 'Confirm', type: 'QUICK_REPLY' }], type: 'BUTTONS' },
      ]),
    );

    expect(assetKindForWhatsAppSlot(slots[0]!)).toBe('PHOTO');
    const components = whatsAppTemplateComponents(slots, {
      'body-1': '{{contact.firstName}}',
      'body-2': 'A-42',
      'button-0': 'confirm:A-42',
      'header-media': 'asset-id',
    });

    expect(components).toEqual([
      { parameters: [{ mediaAssetId: 'asset-id', type: 'image' }], type: 'header' },
      {
        index: 0,
        parameters: [{ payload: 'confirm:A-42', type: 'payload' }],
        subType: 'quick_reply',
        type: 'button',
      },
      {
        parameters: [
          { text: '{{contact.firstName}}', type: 'text' },
          { text: 'A-42', type: 'text' },
        ],
        type: 'body',
      },
    ]);
    expect(whatsAppTemplateParameterValues(slots, components)).toEqual({
      'body-1': '{{contact.firstName}}',
      'body-2': 'A-42',
      'button-0': 'confirm:A-42',
      'header-media': 'asset-id',
    });
  });

  it('supports static and dynamic URL buttons without exposing the provider URL', () => {
    const staticTemplate = template([
      { buttons: [{ text: 'Open', type: 'URL' }], type: 'BUTTONS' },
    ]);
    expect(whatsAppTemplateComposerIssue(staticTemplate)).toBeUndefined();
    expect(whatsAppParameterSlots(staticTemplate)).toEqual([]);

    const slots = whatsAppParameterSlots(
      template([
        { buttons: [{ dynamic: true, text: 'Track order', type: 'URL' }], type: 'BUTTONS' },
      ]),
    );
    expect(slots).toEqual([expect.objectContaining({ index: 0, key: 'button-0', kind: 'url' })]);
    const components = whatsAppTemplateComponents(slots, { 'button-0': 'A-42' });
    expect(components).toEqual([
      {
        index: 0,
        parameters: [{ text: 'A-42', type: 'text' }],
        subType: 'url',
        type: 'button',
      },
    ]);
    expect(whatsAppTemplateParameterValues(slots, components)).toEqual({
      'button-0': 'A-42',
    });
  });

  it('fails closed for provider shapes the safe composer cannot represent', () => {
    expect(whatsAppTemplateComposerIssue(template([], 'AUTHENTICATION'))).toMatch(/OTP-specific/);
    expect(
      whatsAppTemplateComposerIssue(template([{ text: 'Hello {{customer_name}}', type: 'BODY' }])),
    ).toMatch(/Named Meta variables/);
    expect(
      whatsAppTemplateComposerIssue(template([{ format: 'LOCATION', type: 'HEADER' }])),
    ).toMatch(/Location template headers/);
  });
});

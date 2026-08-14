import { describe, expect, it } from 'vitest';

import {
  createDefaultEmailDocument,
  emailAssetReferences,
  renderEmailDocument,
  renderEmailTemplate,
} from './index';

describe('email core', () => {
  it('renders safe variables, fallback values and an unsubscribe link', () => {
    const rendered = renderEmailDocument(
      createDefaultEmailDocument(),
      { contact: { firstName: '<Eldar>' } },
      { unsubscribeUrl: 'https://api.omnicus.app/api/v1/public/email/unsubscribe/token' },
    );
    expect(rendered.html).toContain('&lt;Eldar&gt;');
    expect(rendered.html).toContain('Unsubscribe');
    expect(rendered.missingVariables).toEqual([]);
  });

  it('reports missing variables and extracts unique assets', () => {
    expect(renderEmailTemplate('Hello {{contact.firstName}}', { contact: {} }).missing).toEqual([
      'contact.firstName',
    ]);
    const document = createDefaultEmailDocument();
    document.blocks.push({
      align: 'center',
      alt: 'Photo',
      assetId: '7b6f5038-b728-4ab3-ae8d-5422ea3138ea',
      id: 'image',
      type: 'IMAGE',
      widthPercent: 80,
    });
    expect(emailAssetReferences(document)).toEqual([
      {
        assetId: '7b6f5038-b728-4ab3-ae8d-5422ea3138ea',
        usage: 'INLINE',
      },
    ]);
  });
});

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
      heightPx: 240,
      id: 'image',
      objectFit: 'cover',
      type: 'IMAGE',
      widthPercent: 80,
    });
    document.blocks.push({
      assetId: '233e4567-e89b-42d3-a456-426614174000',
      fileName: 'report.pdf',
      id: 'attachment',
      label: 'Download report',
      type: 'ATTACHMENT',
    });
    expect(emailAssetReferences(document)).toEqual([
      {
        assetId: '7b6f5038-b728-4ab3-ae8d-5422ea3138ea',
        usage: 'INLINE',
      },
      {
        assetId: '233e4567-e89b-42d3-a456-426614174000',
        usage: 'ATTACHMENT',
      },
    ]);
    const rendered = renderEmailDocument(
      document,
      {},
      {
        assetContentIds: {
          '7b6f5038-b728-4ab3-ae8d-5422ea3138ea': 'photo@mail.omnicus.app',
        },
      },
    );
    expect(rendered.html).toContain('cid:photo@mail.omnicus.app');
    expect(rendered.html).toContain('height:240px');
    expect(rendered.html).toContain('object-fit:cover');
    expect(rendered.html).not.toContain('Download report');
    expect(rendered.text).not.toContain('Download report');
  });
});

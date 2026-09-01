import { describe, expect, it } from 'vitest';

import {
  createDefaultEmailDocument,
  emailAssetReferences,
  renderEmailDocument,
  renderInlineMarkup,
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

  it('renders plain URLs as trackable anchors without corrupting Markdown links', () => {
    const rendered = renderInlineMarkup(
      'Open https://example.com/report?first=1&second=2, or [**view docs**](https://docs.example.com/path).',
    );

    expect(rendered).toContain(
      '<a href="https://example.com/report?first=1&amp;second=2" style="color:#0f766e;text-decoration:underline">https://example.com/report?first=1&amp;second=2</a>,',
    );
    expect(rendered).toContain(
      '<a href="https://docs.example.com/path" style="color:#0f766e;text-decoration:underline"><strong>view docs</strong></a>.',
    );
    expect(rendered.match(/<a /g)).toHaveLength(2);
  });

  it('keeps HTML escaped while auto-linking a plain URL', () => {
    const rendered = renderInlineMarkup(
      '<script>alert(1)</script> https://example.com/path <strong>unsafe</strong>',
    );

    expect(rendered).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(rendered).toContain(
      '<a href="https://example.com/path" style="color:#0f766e;text-decoration:underline">https://example.com/path</a>',
    );
    expect(rendered).toContain('&lt;strong&gt;unsafe&lt;/strong&gt;');
    expect(rendered).not.toContain('<script>');
  });
});

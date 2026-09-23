// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { safeEmailDocument } from './email-safe-html';

const parse = (html: string) =>
  new DOMParser().parseFromString(safeEmailDocument(html), 'text/html');

describe('safe email formatting', () => {
  it('preserves paragraphs, emphasis, quotes, lists and tables', () => {
    const doc = parse(
      '<p>Reply <strong>test</strong></p><blockquote>Original</blockquote><ul><li>Item</li></ul><table><tr><td colspan="2">Cell</td></tr></table>',
    );
    expect(doc.querySelector('strong')?.textContent).toBe('test');
    expect(doc.querySelector('blockquote')?.textContent).toBe('Original');
    expect(doc.querySelector('li')?.textContent).toBe('Item');
    expect(doc.querySelector('td')?.getAttribute('colspan')).toBe('2');
  });

  it('removes scripts, handlers, embeds, forms and tracking resources', () => {
    const doc = parse(
      '<script>parent.alert(1)</script><iframe src="https://tracking.invalid"></iframe><img src="https://tracking.invalid/pixel"><form><input></form><svg onload="alert(1)"></svg><p onclick="alert(1)" style="position:fixed" class="fake" id="root">Safe</p>',
    );
    expect(
      doc.body.querySelector('script,iframe,img,form,input,svg,[onclick],[style],[class],[id]'),
    ).toBeNull();
    expect(doc.body.textContent).toBe('Safe');
  });

  it('keeps link text without enabling navigation or sender CSS', () => {
    const doc = parse(
      '<style>body{background:url(https://tracking.invalid)}</style><a href="https://tracking.invalid/click">Support</a><meta http-equiv="refresh" content="0;url=https://tracking.invalid"><base href="https://tracking.invalid">',
    );
    expect(doc.body.textContent).toBe('Support');
    expect(doc.querySelector('a,base,meta[http-equiv="refresh"]')).toBeNull();
    expect(doc.documentElement.innerHTML).not.toContain('tracking.invalid');
  });

  it('enforces a restrictive CSP and disables referrers', () => {
    const doc = parse('<p>Safe</p>');
    const policy = doc
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute('content');
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(doc.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer');
  });

  it('keeps text direction without extra sender attributes', () => {
    const doc = parse('<p dir="rtl" aria-label="fake" data-value="private">مرحبا</p>');
    expect(doc.querySelector('p')?.outerHTML).toBe('<p dir="rtl">مرحبا</p>');
  });
});

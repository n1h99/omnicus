import DOMPurify from 'dompurify';

/** No remote resources, styles, forms, images, or executable content from a sender. */
export function safeEmailDocument(html: string): string {
  const body = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p',
      'br',
      'div',
      'span',
      'b',
      'strong',
      'i',
      'em',
      'u',
      's',
      'blockquote',
      'pre',
      'code',
      'ul',
      'ol',
      'li',
      'table',
      'thead',
      'tbody',
      'tr',
      'td',
      'th',
      'h1',
      'h2',
      'h3',
      'h4',
      'hr',
    ],
    ALLOWED_ATTR: ['colspan', 'rowspan', 'dir'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  // Links are shown as text. Disabling navigation and every resource prevents tracking pixels and CSS exfiltration.
  return (
    '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><meta name="referrer" content="no-referrer"><style>body{font:14px/1.65 system-ui,sans-serif;color:#26344a;margin:16px;overflow-wrap:anywhere}p{margin:0 0 12px}table{max-width:100%;border-collapse:collapse}td,th{padding:6px}blockquote{border-left:3px solid #dfe5ee;margin:12px 0;padding-left:14px;color:#64748b}pre{white-space:pre-wrap}h1,h2,h3{line-height:1.3}</style></head><body>' +
    body +
    '</body></html>'
  );
}

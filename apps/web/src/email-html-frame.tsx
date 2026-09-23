import { useEffect, useMemo, useRef } from 'react';

import { safeEmailDocument } from './email-safe-html';

/** Isolated, sanitized email HTML that takes only as much height as its content. */
export function EmailHtmlFrame({ html, title }: { html: string; title: string }) {
  const document = useMemo(() => safeEmailDocument(html), [html]);
  const cleanup = useRef<() => void>(() => {});
  useEffect(() => () => cleanup.current(), []);

  return (
    <iframe
      title={title}
      // Same-origin allows measuring the document. Sender scripts remain
      // forbidden by both sandbox and CSP, on top of the HTML allowlist.
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      srcDoc={document}
      className="mail-html-frame"
      onLoad={(event) => {
        cleanup.current();
        const frame = event.currentTarget;
        const body = frame.contentDocument?.body;
        if (!body) return;

        let pendingResize: number | undefined;
        const resize = () => {
          pendingResize = undefined;
          const height = `${Math.ceil(body.getBoundingClientRect().height)}px`;
          if (frame.style.height !== height) frame.style.height = height;
        };
        // Defer writes to avoid a resize feedback loop when the viewport changes.
        const observer = new ResizeObserver(() => {
          if (pendingResize === undefined) pendingResize = requestAnimationFrame(resize);
        });
        observer.observe(body);
        cleanup.current = () => {
          observer.disconnect();
          if (pendingResize !== undefined) cancelAnimationFrame(pendingResize);
        };
        resize();
      }}
    />
  );
}

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EmailHtmlFrame } from './email-html-frame';

let container: HTMLDivElement;
let root: Root;
let notifyResize: () => void;
const disconnect = vi.fn();

beforeEach(() => {
  disconnect.mockClear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        notifyResize = callback;
      }
      observe = vi.fn();
      disconnect = disconnect;
    },
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('email HTML frame', () => {
  it('renders sanitized HTML in a frame with scripts disabled', () => {
    act(() =>
      root.render(
        <EmailHtmlFrame
          html="<p>Reply</p><script>alert(1)</script><blockquote>Test</blockquote>"
          title="Email from client"
        />,
      ),
    );
    const frame = container.querySelector('iframe')!;
    expect(frame.srcdoc).toContain('<blockquote>Test</blockquote>');
    expect(frame.srcdoc).not.toContain('<script>');
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.title).toBe('Email from client');
  });

  it('measures content, batches observer updates and cancels them on unmount', () => {
    const requestFrame = vi.fn(() => 42);
    const cancelFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    act(() => root.render(<EmailHtmlFrame html="<p>Short reply</p>" title="Email" />));
    const frame = container.querySelector('iframe')!;
    vi.spyOn(frame.contentDocument!.body, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 500, 73.5),
    );
    act(() => frame.dispatchEvent(new Event('load')));
    expect(frame.style.height).toBe('74px');
    notifyResize();
    notifyResize();
    expect(requestFrame).toHaveBeenCalledTimes(1);
    act(() => root.render(null));
    expect(disconnect).toHaveBeenCalled();
    expect(cancelFrame).toHaveBeenCalledWith(42);
  });

  it('refreshes its sanitized document when HTML changes', () => {
    act(() => root.render(<EmailHtmlFrame html="<p>Before</p>" title="Email" />));
    act(() => root.render(<EmailHtmlFrame html="<p>After</p>" title="Email" />));
    expect(container.querySelector('iframe')?.srcdoc).toContain('<p>After</p>');
    expect(container.querySelector('iframe')?.srcdoc).not.toContain('<p>Before</p>');
  });
});

import { Alert, Button, Spin } from 'antd';
import { useEffect, useRef, useState } from 'react';
import {
  AnnotationMode,
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type RenderTask,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

export default function EmailPdfPreview({ blob }: { blob: Blob }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let disposed = false;
    let task: ReturnType<typeof getDocument> | undefined;
    void blob
      .arrayBuffer()
      .then(async (bytes) => {
        if (disposed) return;
        task = getDocument({
          data: new Uint8Array(bytes),
          disableFontFace: true,
          useSystemFonts: true,
          useWasm: false,
          useWorkerFetch: false,
          maxImageSize: 16_000_000,
          canvasMaxAreaInBytes: 16_000_000,
          enableXfa: false,
        });
        task.onPassword = () => {
          if (!disposed) setError('This PDF is password-protected. Download it to open.');
          void task?.destroy();
        };
        const pdf = await task.promise;
        if (!disposed) setDocument(pdf);
      })
      .catch(() => {
        if (!disposed) setError('This PDF cannot be previewed. You can still download it.');
      });
    return () => {
      disposed = true;
      void task?.destroy();
    };
  }, [blob]);
  useEffect(() => {
    if (!document || !canvas.current) return;
    const target = canvas.current;
    let disposed = false;
    let task: RenderTask | undefined;
    void document
      .getPage(page)
      .then(async (pdfPage) => {
        if (disposed) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({
          scale: Math.min(1.5, 1800 / base.width, 1800 / base.height),
        });
        target.width = Math.ceil(viewport.width);
        target.height = Math.ceil(viewport.height);
        task = pdfPage.render({ canvas: target, viewport, annotationMode: AnnotationMode.DISABLE });
        await task.promise;
        if (!disposed) setBusy(false);
      })
      .catch(() => {
        if (!disposed)
          setError('This PDF page cannot be previewed. You can still download the file.');
      });
    return () => {
      disposed = true;
      task?.cancel();
    };
  }, [document, page]);
  if (error) return <Alert type="warning" title={error} showIcon />;
  return (
    <div className="email-pdf-preview">
      <div className="email-pdf-controls">
        <Button
          disabled={busy || page <= 1}
          onClick={() => {
            setBusy(true);
            setPage(page - 1);
          }}
        >
          Previous
        </Button>
        <span>
          Page {page} / {document?.numPages ?? '…'}
        </span>
        <Button
          disabled={busy || !document || page >= document.numPages}
          onClick={() => {
            setBusy(true);
            setPage(page + 1);
          }}
        >
          Next
        </Button>
      </div>
      {busy && <Spin />}
      <canvas ref={canvas} aria-label={`PDF page ${page}`} />
    </div>
  );
}

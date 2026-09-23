import {
  CloseOutlined,
  DownloadOutlined,
  EyeOutlined,
  PaperClipOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { Alert, Button, Modal, Spin, Upload } from 'antd';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import './email-files.css';
import {
  EMAIL_FILE_ACCEPT,
  emailFileProblem,
  emailFileSize,
  emailPreviewType,
  type EmailFile,
  type useEmailFiles,
} from './email-file-utils';

const PdfPreview = lazy(() => import('./email-pdf-preview'));
export function EmailFilePicker({
  files,
  disabled = false,
  canUpload = true,
  onChange,
}: {
  files: ReturnType<typeof useEmailFiles>;
  disabled?: boolean;
  canUpload?: boolean;
  onChange: () => void;
}) {
  return (
    <section className="email-files-picker" aria-label="Email attachments">
      {files.items.length > 0 && (
        <ul className="email-files-list">
          {files.items.map((file) => (
            <li className="email-file" key={file.id}>
              {file.state === 'uploading' ? <Spin size="small" /> : <PaperClipOutlined />}
              <div className="email-file-info">
                <span title={file.filename}>{file.filename}</span>
                <small>
                  {emailFileSize(file.sizeBytes)} ·{' '}
                  {file.state === 'uploading'
                    ? 'Uploading…'
                    : file.state === 'error'
                      ? file.error
                      : file.status && file.status !== 'AVAILABLE'
                        ? 'Unavailable — remove this file'
                        : 'Ready'}
                </small>
              </div>
              {file.state === 'error' && file.file && !emailFileProblem(file.file) && (
                <Button
                  size="small"
                  type="text"
                  disabled={disabled}
                  icon={<ReloadOutlined />}
                  aria-label={`Retry ${file.filename}`}
                  onClick={() => void files.retry(file)}
                />
              )}
              <Button
                size="small"
                type="text"
                disabled={disabled}
                icon={<CloseOutlined />}
                aria-label={`Remove ${file.filename}`}
                onClick={() => {
                  files.remove(file.id);
                  onChange();
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {canUpload && (
        <Upload.Dragger
          multiple
          accept={EMAIL_FILE_ACCEPT}
          showUploadList={false}
          disabled={disabled}
          beforeUpload={(file, batch) => {
            if (file.uid === batch[0]?.uid) {
              files.add(batch);
              onChange();
            }
            return false;
          }}
        >
          <span className="email-files-prompt">
            <PaperClipOutlined /> Attach files <span>or drop them here</span>
          </span>
        </Upload.Dragger>
      )}
      {(canUpload || files.items.length > 0) && (
        <small className="email-files-hint">Up to 20 files · 20 MB each · 25 MB total</small>
      )}
      {files.error && <Alert type="error" showIcon title={files.error} />}
    </section>
  );
}

function ImagePreview({ blob, type, name }: { blob: Blob; type: string; name: string }) {
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const reader = new FileReader();
    reader.onload = () => setSrc(String(reader.result));
    reader.onerror = () => setFailed(true);
    reader.readAsDataURL(new Blob([blob], { type }));
    return () => {
      reader.onload = null;
      reader.onerror = null;
      reader.abort();
    };
  }, [blob, type]);
  if (failed)
    return (
      <Alert type="warning" title="This image cannot be previewed. You can still download it." />
    );
  return src ? (
    <img className="email-image-preview" src={src} alt={name} onError={() => setFailed(true)} />
  ) : (
    <Spin />
  );
}

export function EmailAttachmentList({
  files,
  load,
}: {
  files: (EmailFile & { path: string })[];
  load: (path: string, signal: AbortSignal) => Promise<Blob>;
}) {
  const [preview, setPreview] = useState<{
    file: EmailFile;
    blob?: Blob;
    type?: string;
    error?: string;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      active.current?.abort();
    },
    [],
  );
  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename.replace(/[\r\n/\\]/g, '_') || 'attachment';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  const open = async (file: EmailFile & { path: string }, showPreview: boolean) => {
    active.current?.abort();
    const request = new AbortController();
    active.current = request;
    setBusy(file.path);
    setError('');
    if (showPreview) setPreview({ file });
    try {
      const blob = await load(file.path, request.signal);
      if (request.signal.aborted) return;
      if (showPreview) {
        try {
          const type = await emailPreviewType(blob);
          if (!request.signal.aborted) setPreview({ file, blob, type });
        } catch (cause) {
          if (!request.signal.aborted)
            setPreview({
              file,
              blob,
              error: cause instanceof Error ? cause.message : 'Preview unavailable.',
            });
        }
      } else downloadBlob(blob, file.filename);
    } catch (cause) {
      if (!request.signal.aborted) {
        const reason =
          cause instanceof Error
            ? cause.message
            : 'The file could not be loaded. Please try again.';
        if (showPreview) setPreview({ file, error: reason });
        else setError(reason);
      }
    } finally {
      if (!request.signal.aborted) setBusy(null);
    }
  };
  if (!files.length) return null;
  return (
    <section className="email-files" aria-label="Message attachments">
      <ul className="email-files-list">
        {files.map((file) => (
          <li className="email-file" key={file.path}>
            <PaperClipOutlined />
            <div className="email-file-info">
              <span title={file.filename}>{file.filename}</span>
              <small>
                {emailFileSize(file.sizeBytes)}
                {file.status && file.status !== 'AVAILABLE'
                  ? ' · ' + file.status.toLowerCase().replaceAll('_', ' ')
                  : ''}
              </small>
            </div>
            {/\.(pdf|png|jpe?g|gif|webp)$/i.test(file.filename) && (
              <Button
                size="small"
                type="text"
                icon={<EyeOutlined />}
                aria-label={`Preview ${file.filename}`}
                disabled={Boolean(busy) || file.status !== 'AVAILABLE'}
                onClick={() => void open(file, true)}
              />
            )}
            <Button
              size="small"
              type="text"
              icon={<DownloadOutlined />}
              aria-label={`Download ${file.filename}`}
              loading={busy === file.path}
              disabled={Boolean(busy) || file.status !== 'AVAILABLE'}
              onClick={() => void open(file, false)}
            />
          </li>
        ))}
      </ul>
      {error && <Alert type="error" title={error} showIcon />}
      {preview && (
        <Modal
          open
          width={900}
          title={preview.file.filename}
          onCancel={() => {
            active.current?.abort();
            setPreview(null);
            setBusy(null);
          }}
          footer={
            <Button
              icon={<DownloadOutlined />}
              aria-label="Download"
              disabled={!preview.blob}
              onClick={() => preview.blob && downloadBlob(preview.blob, preview.file.filename)}
            >
              Download
            </Button>
          }
        >
          <div className="email-file-preview">
            {preview.error ? (
              <Alert type="warning" title={preview.error} showIcon />
            ) : !preview.blob ? (
              <Spin />
            ) : preview.type === 'application/pdf' ? (
              <Suspense fallback={<Spin />}>
                <PdfPreview blob={preview.blob} />
              </Suspense>
            ) : (
              <ImagePreview blob={preview.blob} type={preview.type!} name={preview.file.filename} />
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}

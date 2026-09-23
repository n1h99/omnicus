import { SendOutlined } from '@ant-design/icons';
import { Alert, App, Button, Form, Input, Modal, Select, Space, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest, ApiError, getUserErrorMessage } from './api';
import { useMediaAssets, type MediaAsset } from './media-api';
import { useInboxActions, type Mailbox, type MailDraft } from './email-inbox-api';
import { EmailFilePicker } from './email-files';
import { useEmailFiles } from './email-file-utils';
import { useAuth } from './auth';

export type ComposeInitial = {
  mailboxId?: string;
  threadId?: string;
  to?: string;
  subject?: string;
  replyToMessageId?: string;
  draft?: MailDraft;
};
type Values = { mailboxId: string; to: string; subject: string; text: string };

export function EmailCompose({
  projectId,
  mailboxes,
  initial,
  canReadMedia,
  canUploadMedia,
  onClose,
  onSent,
}: {
  projectId: string;
  mailboxes: Mailbox[];
  initial: ComposeInitial;
  canReadMedia: boolean;
  canUploadMedia: boolean;
  onClose: () => void;
  onSent: (threadId: string) => void;
}) {
  const [form] = Form.useForm<Values>();
  const actions = useInboxActions(projectId);
  const { message, modal } = App.useApp();
  const media = useMediaAssets(projectId, canReadMedia);
  const { accessToken } = useAuth();
  const availableFiles = useMemo(
    () =>
      media.data?.map((asset) => ({
        id: asset.id,
        filename: asset.originalFilename ?? 'Attached file',
        sizeBytes: Number(asset.sizeBytes ?? 0),
        status: asset.status,
        contentType: asset.detectedMimeType,
      })),
    [media.data],
  );
  const files = useEmailFiles(
    (initial.draft?.assetIds ?? []).map((id) => ({
      id,
      filename: 'Attached file',
      sizeBytes: 0,
      status: 'LOADING',
    })),
    async (file, _requestId, signal) => {
      const body = new FormData();
      body.set('file', file);
      const asset = await apiRequest<MediaAsset>(
        `/api/v1/projects/${projectId}/media-assets/upload/DOCUMENT?channel=email`,
        { method: 'POST', body, signal },
        accessToken,
      );
      void media.refetch();
      return {
        id: asset.id,
        filename: asset.originalFilename ?? file.name,
        sizeBytes: Number(asset.sizeBytes ?? file.size),
        contentType: asset.detectedMimeType,
        status: asset.status,
      };
    },
    availableFiles,
  );
  const assetIds = files.assetIds;
  const [revision, setRevision] = useState(initial.draft?.revision ?? 0);
  const [dirty, setDirty] = useState(!initial.draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const draftId = useRef(initial.draft?.id ?? crypto.randomUUID());
  const sendAttempt = useRef<{ key: string; body: string } | null>(null);
  const mailboxId = Form.useWatch('mailboxId', form) as string | undefined;
  const mailbox = mailboxes.find((item) => item.id === mailboxId);
  const threadId = initial.draft?.threadId ?? initial.threadId;
  const changed = () => {
    setDirty(true);
    setError('');
  };
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);
  const close = () => {
    if (busy) return;
    if (dirty)
      modal.confirm({
        title: 'Discard unsaved changes?',
        content: 'Use Save draft to keep this message in your private drafts.',
        okText: 'Discard changes',
        okButtonProps: { danger: true },
        onOk: onClose,
      });
    else onClose();
  };
  const save = async () => {
    if (busy || files.isBlocked()) return;
    if (sendAttempt.current) {
      setError(
        'Retry the pending send with unchanged content, or check Sent before saving another draft.',
      );
      return;
    }
    const values = form.getFieldsValue();
    if (!values.mailboxId) {
      setError('Choose a sender before saving.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const draft = await actions.request<MailDraft>('drafts/' + draftId.current, 'PUT', {
        ...values,
        to: values.to ?? '',
        subject: values.subject ?? '',
        text: values.text ?? '',
        revision,
        assetIds,
        ...(threadId ? { threadId } : {}),
      });
      setRevision(draft.revision);
      setDirty(false);
      void message.success('Draft saved. Only you can see it.');
    } catch (err) {
      setError(getUserErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    if (busy || files.isBlocked()) return;
    const values = await form.validateFields().catch(() => null);
    if (!values || files.isBlocked()) return;
    const body = {
      ...values,
      assetIds,
      ...(threadId ? { threadId } : {}),
      ...(initial.replyToMessageId ? { replyToMessageId: initial.replyToMessageId } : {}),
      ...(revision ? { draftId: draftId.current, draftRevision: revision } : {}),
    };
    const serialized = JSON.stringify(body);
    // An ambiguous response keeps the same key and exact payload. Edits require resolving the previous attempt first.
    if (sendAttempt.current && sendAttempt.current.body !== serialized) {
      setError(
        'A previous send has an uncertain result. Restore its content and retry, or check Sent before composing another message.',
      );
      return;
    }
    sendAttempt.current ??= { key: crypto.randomUUID(), body: serialized };
    setBusy(true);
    setError('');
    try {
      const sent = await actions.request<{ threadId: string }>('messages', 'POST', {
        ...body,
        requestId: sendAttempt.current.key,
      });
      setDirty(false);
      void message.success('Email queued. Delivery status is shown in the conversation.');
      onSent(sent.threadId);
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408)
        sendAttempt.current = null;
      setError(getUserErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      width={760}
      title={threadId ? 'Reply by email' : 'New email'}
      onCancel={close}
      maskClosable={false}
      footer={
        <div className="mail-compose-footer">
          <Button
            disabled={busy || files.blocked || Boolean(sendAttempt.current)}
            onClick={() => void save()}
          >
            Save draft
          </Button>
          <Space>
            <Button disabled={busy} onClick={close}>
              Close
            </Button>
            <Button
              type="primary"
              aria-label="Send email"
              icon={<SendOutlined />}
              loading={busy}
              disabled={!mailbox?.sendingReady || files.blocked}
              onClick={() => void send()}
            >
              Send email
            </Button>
          </Space>
        </div>
      }
    >
      {error && <Alert className="mail-alert" type="error" showIcon title={error} />}
      <Form
        form={form}
        layout="vertical"
        disabled={busy || Boolean(sendAttempt.current)}
        onValuesChange={changed}
        initialValues={{
          mailboxId:
            initial.draft?.mailboxId ??
            initial.mailboxId ??
            mailboxes.find((item) => item.isDefault)?.id ??
            mailboxes[0]?.id,
          to: initial.draft?.toEmail ?? initial.to ?? '',
          subject: initial.draft?.subject ?? initial.subject ?? '',
          text: initial.draft?.textBody ?? '',
        }}
      >
        <Form.Item label="From" name="mailboxId" rules={[{ required: true }]}>
          <Select
            disabled={!!threadId || busy || Boolean(sendAttempt.current)}
            options={mailboxes.map((item) => ({
              value: item.id,
              label: `${item.displayName} <${item.address}>${item.sendingReady ? '' : ' · not ready'}`,
            }))}
          />
        </Form.Item>
        <Form.Item label="To" name="to" rules={[{ required: true, type: 'email' }]}>
          <Input
            disabled={!!threadId || busy || Boolean(sendAttempt.current)}
            maxLength={254}
            placeholder="client@example.com"
          />
        </Form.Item>
        <Form.Item
          label="Subject"
          name="subject"
          rules={[
            { required: true, whitespace: true },
            { pattern: /^[^\r\n]+$/, message: 'Use a single-line subject.' },
          ]}
        >
          <Input maxLength={200} />
        </Form.Item>
        <Form.Item
          label="Message"
          name="text"
          rules={[
            {
              validator: async (_, value: string) => {
                if (!value?.trim() && !assetIds.length)
                  throw new Error('Write a message or attach a file.');
              },
            },
          ]}
        >
          <Input.TextArea
            autoSize={{ minRows: 8, maxRows: 18 }}
            maxLength={100_000}
            placeholder="Write your message…"
          />
        </Form.Item>
        {mailbox?.signature && (
          <div className="mail-signature">
            <Typography.Text type="secondary">Sender signature · added on send</Typography.Text>
            <div>{mailbox.signature}</div>
          </div>
        )}
        <EmailFilePicker
          files={files}
          canUpload={canReadMedia && canUploadMedia}
          disabled={busy || Boolean(sendAttempt.current)}
          onChange={changed}
        />
        {canReadMedia && (
          <Space wrap className="mail-attachments-picker">
            <Select
              mode="multiple"
              aria-label="Choose files from Content library"
              disabled={busy || files.blocked || Boolean(sendAttempt.current)}
              placeholder="Choose files from Content library"
              value={assetIds}
              onChange={(ids: string[]) => {
                files.select(
                  ids.map(
                    (id) =>
                      availableFiles?.find((file) => file.id === id) ??
                      files.items.find((file) => file.id === id)!,
                  ),
                );
                changed();
              }}
              maxCount={20}
              style={{ minWidth: 270, maxWidth: '100%' }}
              options={(media.data ?? [])
                .filter(
                  (item) =>
                    item.status === 'AVAILABLE' && ['DOCUMENT', 'PHOTO'].includes(item.kind),
                )
                .map((item) => ({ value: item.id, label: item.originalFilename ?? item.id }))}
            />
          </Space>
        )}
        {!mailbox?.receivingReady && (
          <Alert
            className="mail-alert"
            showIcon
            type="warning"
            title={
              mailbox?.mode === 'SEND_ONLY'
                ? 'Send-only address: replies are not collected here.'
                : 'Incoming email is not ready. Verify receiving DNS in Settings to collect replies.'
            }
          />
        )}
      </Form>
    </Modal>
  );
}

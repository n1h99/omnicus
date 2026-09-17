import { PaperClipOutlined, SendOutlined } from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { useEffect, useRef, useState } from 'react';
import { ApiError, getUserErrorMessage } from './api';
import { useMediaAssets, useMediaMutations } from './media-api';
import { useInboxActions, type Mailbox, type MailDraft } from './email-inbox-api';

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
  const mediaActions = useMediaMutations(projectId);
  const [assetIds, setAssetIds] = useState<string[]>(initial.draft?.assetIds ?? []);
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
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
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
          <Button disabled={busy} onClick={() => void save()}>
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
              disabled={!mailbox?.sendingReady}
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
        disabled={busy}
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
            disabled={!!threadId || busy}
            options={mailboxes.map((item) => ({
              value: item.id,
              label: `${item.displayName} <${item.address}>${item.sendingReady ? '' : ' · not ready'}`,
            }))}
          />
        </Form.Item>
        <Form.Item label="To" name="to" rules={[{ required: true, type: 'email' }]}>
          <Input disabled={!!threadId || busy} maxLength={254} placeholder="client@example.com" />
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
        {assetIds.map((id) => (
          <Tag
            key={id}
            closable={!busy}
            onClose={() => {
              setAssetIds((current) => current.filter((item) => item !== id));
              changed();
            }}
          >
            {media.data?.find((item) => item.id === id)?.originalFilename ?? 'Attached file'}
          </Tag>
        ))}
        {canReadMedia && (
          <Space wrap className="mail-attachments-picker">
            <Select
              mode="multiple"
              aria-label="Choose files from Content library"
              disabled={busy}
              placeholder="Choose files from Content library"
              value={assetIds}
              onChange={(ids: string[]) => {
                setAssetIds(ids);
                changed();
              }}
              maxCount={20}
              style={{ minWidth: 270, maxWidth: '100%' }}
              options={(media.data ?? [])
                .filter((item) => item.status === 'AVAILABLE')
                .map((item) => ({ value: item.id, label: item.originalFilename ?? item.id }))}
            />
            {canUploadMedia && (
              <Upload
                showUploadList={false}
                beforeUpload={(file) => {
                  if (assetIds.length >= 20) {
                    setError('Up to 20 attachments per email.');
                    return false;
                  }
                  setBusy(true);
                  void mediaActions.upload
                    .mutateAsync({ file, kind: 'DOCUMENT', channel: 'EMAIL' })
                    .then((asset) => {
                      setAssetIds((current) => [...new Set([...current, asset.id])]);
                      changed();
                    })
                    .catch((err: unknown) => setError(getUserErrorMessage(err)))
                    .finally(() => setBusy(false));
                  return false;
                }}
              >
                <Button disabled={busy} icon={<PaperClipOutlined />}>
                  Upload file
                </Button>
              </Upload>
            )}
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

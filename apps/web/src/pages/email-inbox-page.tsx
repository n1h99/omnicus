import {
  ArrowLeftOutlined,
  DeleteOutlined,
  EditOutlined,
  InboxOutlined,
  MailOutlined,
  PaperClipOutlined,
  ReloadOutlined,
  SendOutlined,
  SettingOutlined,
  StarFilled,
  StarOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App,
  Avatar,
  Button,
  Empty,
  Input,
  Pagination,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { getUserErrorMessage } from '../api';
import { hasProjectPermission, useProjectAccess } from '../project-access';
import {
  useInboxActions,
  useInboxQuery,
  useMailboxes,
  type MailDraft,
  type MailMessage,
  type MailThread,
  type MailThreadDetail,
} from '../email-inbox-api';
import { EmailCompose, type ComposeInitial } from '../email-compose';
import { EmailInboxSettings } from '../email-inbox-settings';
import { EmailHtmlFrame } from '../email-html-frame';
import { replySubject } from '@omnicus/email-core';
import '../email-inbox.css';

const folders = [
  { key: 'inbox', label: 'Inbox', icon: <InboxOutlined /> },
  { key: 'sent', label: 'Sent', icon: <SendOutlined /> },
  { key: 'drafts', label: 'Drafts', icon: <EditOutlined /> },
  { key: 'starred', label: 'Starred', icon: <StarOutlined /> },
  { key: 'archived', label: 'Archived', icon: <InboxOutlined /> },
  { key: 'all', label: 'All mail', icon: <MailOutlined /> },
];
const dateLabel = (date: string) =>
  new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function EmailInboxPage() {
  const { projectId } = useParams();
  return projectId ? (
    <App component={false}>
      <EmailInboxWorkspace key={projectId} projectId={projectId} />
    </App>
  ) : null;
}
function EmailInboxWorkspace({ projectId }: { projectId: string }) {
  const [params, setParams] = useSearchParams();
  const access = useProjectAccess(projectId);
  const mailboxes = useMailboxes(projectId);
  const actions = useInboxActions(projectId);
  const { message, modal } = App.useApp();
  const canManage = hasProjectPermission(access.data, 'email:manage');
  const canSend = hasProjectPermission(access.data, 'email:send');
  const canReadMedia = hasProjectPermission(access.data, 'media:read');
  const canUploadMedia = canReadMedia && hasProjectPermission(access.data, 'media:manage');
  const settings = params.get('view') === 'settings' && canManage;
  const folder = folders.some((item) => item.key === params.get('folder'))
    ? params.get('folder')!
    : 'inbox';
  const mailboxId = params.get('mailbox') ?? '';
  const threadId = params.get('thread') ?? '';
  const search = params.get('q') ?? '';
  const contactId = params.get('contactId') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [compose, setCompose] = useState<ComposeInitial | null>(null);
  const [busy, setBusy] = useState(false);
  const change = (values: Record<string, string | null>) =>
    setParams((old) => {
      const next = new URLSearchParams(old);
      for (const [key, value] of Object.entries(values)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    });
  const query = new URLSearchParams({
    ...(contactId ? { contactId } : {}),
    folder: folder === 'drafts' ? 'inbox' : folder,
    page: String(page),
    q: search,
    ...(mailboxId ? { mailboxId } : {}),
  });
  const threads = useInboxQuery<{ items: MailThread[]; total: number; pageSize: number }>(
    projectId,
    'threads?' + query.toString(),
    !settings && folder !== 'drafts',
    true,
  );
  const drafts = useInboxQuery<MailDraft[]>(projectId, 'drafts', !settings && folder === 'drafts');
  const visibleDrafts = (drafts.data ?? []).filter(
    (draft) =>
      (!mailboxId || draft.mailboxId === mailboxId) &&
      (!search || (draft.subject + draft.toEmail).toLowerCase().includes(search.toLowerCase())),
  );
  const current = threads.data?.items.find((thread) => thread.id === threadId);
  const perform = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } catch (err) {
      void message.error(getUserErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="email-workspace">
      <div className="page-heading-row">
        <div>
          <Typography.Title level={2}>Email Inbox</Typography.Title>
          <Typography.Paragraph type="secondary">
            Every conversation, from the first campaign to the next reply.
          </Typography.Paragraph>
        </div>
        <Space wrap>
          <Link to={`/projects/${projectId}/email-sms-broadcast`}>Campaigns</Link>
          {canManage && (
            <Button
              icon={<SettingOutlined />}
              onClick={() => change({ view: settings ? null : 'settings' })}
            >
              {settings ? 'Back to inbox' : 'Settings'}
            </Button>
          )}
        </Space>
      </div>
      {settings ? (
        <EmailInboxSettings projectId={projectId} mailboxes={mailboxes.data ?? []} />
      ) : mailboxes.isLoading ? (
        <div className="mail-empty">
          <Spin />
          <p>Loading your mailboxes…</p>
        </div>
      ) : mailboxes.isError ? (
        <Alert
          type="error"
          showIcon
          title="Mailboxes could not be loaded"
          action={<Button onClick={() => void mailboxes.refetch()}>Retry</Button>}
        />
      ) : !mailboxes.data?.length ? (
        <div className="mail-onboarding">
          <div className="mail-onboarding-icon">
            <MailOutlined />
          </div>
          <Typography.Title level={3}>A home for your email conversations</Typography.Title>
          <Typography.Paragraph type="secondary">
            Connect a sending domain and add an address to collect replies,
            <br />
            continue conversations, and keep your team in sync.
          </Typography.Paragraph>
          {canManage ? (
            <Button
              type="primary"
              icon={<PlusMailIcon />}
              onClick={() => change({ view: 'settings' })}
            >
              Set up email
            </Button>
          ) : (
            <Typography.Text type="secondary">
              Ask your project administrator to create an address and give you access.
            </Typography.Text>
          )}
          <Typography.Paragraph className="mail-onboarding-note" type="secondary">
            Existing campaign delivery is not affected.
          </Typography.Paragraph>
        </div>
      ) : (
        <div className={'mail-layout' + (threadId ? ' mail-layout--reading' : '')}>
          <aside className="mail-folders" aria-label="Mail folders">
            <Button
              block
              aria-label="Compose"
              type="primary"
              icon={<EditOutlined />}
              disabled={!canSend || !mailboxes.data.some((item) => item.sendingReady)}
              onClick={() => setCompose(mailboxId ? { mailboxId } : {})}
            >
              Compose
            </Button>
            <Select
              className="mail-address-filter"
              aria-label="Filter by email address"
              value={mailboxId}
              onChange={(value: string) =>
                change({ mailbox: value || null, page: null, thread: null })
              }
              options={[
                { value: '', label: 'All addresses' },
                ...mailboxes.data.map((item) => ({ value: item.id, label: item.address })),
              ]}
            />
            <nav>
              {folders.map((item) => (
                <button
                  type="button"
                  key={item.key}
                  aria-label={item.label}
                  className={'mail-folder' + (folder === item.key ? ' is-active' : '')}
                  aria-current={folder === item.key ? 'page' : undefined}
                  onClick={() => change({ folder: item.key, page: null, thread: null })}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </nav>
            <div className="mail-folders-note">
              {mailboxes.data.filter((item) => item.receivingReady).length} receiving address(es)
              <br />
              Replies stay with their conversation.
            </div>
          </aside>
          <div className="mail-thread-list">
            <div className="mail-list-toolbar">
              {contactId && (
                <Button
                  title="Clear contact filter"
                  onClick={() => change({ contactId: null, page: null })}
                >
                  Contact ×
                </Button>
              )}
              <Input.Search
                key={search}
                aria-label="Search email"
                placeholder="Search subject or email"
                defaultValue={search}
                allowClear
                onSearch={(value) => change({ q: value || null, page: null, thread: null })}
              />
              <Tooltip title="Refresh">
                <Button
                  aria-label="Refresh email"
                  icon={<ReloadOutlined />}
                  onClick={() => void actions.refresh()}
                />
              </Tooltip>
            </div>
            <div className="mail-list-caption">
              <strong>{folders.find((item) => item.key === folder)?.label}</strong>
              <span>
                {folder === 'drafts' ? visibleDrafts.length : (threads.data?.total ?? 0)}{' '}
                conversations
              </span>
            </div>
            {(folder === 'drafts' ? drafts.isLoading : threads.isLoading) && (
              <div className="mail-empty">
                <Spin />
              </div>
            )}
            {(folder === 'drafts' ? drafts.isError : threads.isError) && (
              <Alert
                type="error"
                title="Messages could not be loaded"
                action={<Button onClick={() => void actions.refresh()}>Retry</Button>}
              />
            )}
            <div className="mail-list-scroll">
              {folder === 'drafts'
                ? visibleDrafts.map((draft) => (
                    <div className="mail-draft-row" key={draft.id}>
                      <button
                        type="button"
                        className="mail-thread-row"
                        disabled={!canSend}
                        onClick={() => setCompose({ draft })}
                      >
                        <strong>{draft.toEmail || 'No recipient'}</strong>
                        <span>{draft.subject || '(No subject)'}</span>
                        <small>{draft.textBody || 'Empty draft'}</small>
                      </button>
                      {canSend && (
                        <Button
                          type="text"
                          aria-label="Delete draft"
                          icon={<DeleteOutlined />}
                          disabled={busy}
                          onClick={() =>
                            modal.confirm({
                              title: 'Delete this draft?',
                              okText: 'Delete draft',
                              okButtonProps: { danger: true },
                              onOk: () =>
                                perform(() =>
                                  actions.request(`drafts/${draft.id}`, 'DELETE', {
                                    revision: draft.revision,
                                  }),
                                ),
                            })
                          }
                        />
                      )}
                    </div>
                  ))
                : threads.data?.items.map((thread) => (
                    <button
                      type="button"
                      key={thread.id}
                      className={
                        'mail-thread-row' +
                        (thread.unread ? ' is-unread' : '') +
                        (threadId === thread.id ? ' is-selected' : '')
                      }
                      onClick={() => {
                        change({ thread: thread.id });
                        if (thread.unread)
                          void perform(() =>
                            actions.request(`threads/${thread.id}/state`, 'PATCH', { read: true }),
                          );
                      }}
                    >
                      <span className="mail-thread-row-top">
                        <strong>{thread.peerEmail}</strong>
                        <time dateTime={thread.lastMessageAt}>
                          {dateLabel(thread.lastMessageAt)}
                        </time>
                      </span>
                      <span className="mail-thread-subject">
                        {thread.starred && <StarFilled className="mail-star" />}{' '}
                        {thread.subject || '(No subject)'}{' '}
                        <small>{thread.messageCount > 1 ? thread.messageCount : ''}</small>
                      </span>
                      <small>{thread.preview || 'No preview available'}</small>
                      <span className="mail-address-label">{thread.mailbox.address}</span>
                    </button>
                  ))}
            </div>
            {!(folder === 'drafts'
              ? drafts.isLoading || drafts.isError || visibleDrafts.length
              : threads.isLoading || threads.isError || threads.data?.items.length) && (
              <Empty
                className="mail-list-empty"
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  search
                    ? 'No matching conversations'
                    : folder === 'drafts'
                      ? 'No saved drafts'
                      : 'No conversations here yet'
                }
              />
            )}
            {folder !== 'drafts' && !!threads.data?.total && (
              <Pagination
                size="small"
                simple
                current={page}
                pageSize={30}
                total={threads.data.total}
                onChange={(value) => change({ page: String(value), thread: null })}
              />
            )}
          </div>
          <main className="mail-reader" aria-label="Email conversation">
            {threadId && folder !== 'drafts' ? (
              <EmailConversation
                key={threadId}
                projectId={projectId}
                threadId={threadId}
                canSend={canSend}
                current={current}
                onBack={() => change({ thread: null })}
                onReply={(value) => setCompose(value)}
              />
            ) : (
              <div className="mail-empty mail-reader-empty">
                <MailOutlined />
                <Typography.Title level={4}>Your conversations, in one place</Typography.Title>
                <Typography.Text type="secondary">
                  Choose a conversation to read its history and reply.
                </Typography.Text>
              </div>
            )}
          </main>
        </div>
      )}
      {compose && (
        <EmailCompose
          projectId={projectId}
          mailboxes={mailboxes.data ?? []}
          initial={compose}
          canReadMedia={canReadMedia}
          canUploadMedia={canUploadMedia}
          onClose={() => setCompose(null)}
          onSent={(id) => {
            setCompose(null);
            change({ thread: id, folder: 'sent', page: null, view: null });
          }}
        />
      )}
    </section>
  );
}
function PlusMailIcon() {
  return <MailOutlined />;
}

function EmailConversation({
  projectId,
  threadId,
  canSend,
  current,
  onReply,
  onBack,
}: {
  projectId: string;
  threadId: string;
  canSend: boolean;
  current: MailThread | undefined;
  onReply: (initial: ComposeInitial) => void;
  onBack: () => void;
}) {
  const [before, setBefore] = useState('');
  const detail = useInboxQuery<MailThreadDetail>(
    projectId,
    `threads/${threadId}${before ? '?before=' + before : ''}`,
    true,
    !before,
  );
  const mailboxes = useMailboxes(projectId);
  const actions = useInboxActions(projectId);
  const { message } = App.useApp();
  const thread = detail.data;
  const mailbox = mailboxes.data?.find((item) => item.id === thread?.mailboxId);
  const changeState = async (input: { starred?: boolean; archived?: boolean; read?: boolean }) => {
    try {
      await actions.request(`threads/${threadId}/state`, 'PATCH', input);
    } catch (err) {
      void message.error(getUserErrorMessage(err));
    }
  };
  const lastId = thread?.messages.at(-1)?.id;
  useEffect(() => {
    if (lastId)
      void actions
        .request(`threads/${threadId}/state`, 'PATCH', { read: true })
        .catch(() => undefined); /* Explicit current message changes, not every polling response. */
  }, [lastId]);
  if (detail.isLoading)
    return (
      <div className="mail-empty">
        <Spin />
      </div>
    );
  if (detail.isError || !thread)
    return (
      <Alert
        type="error"
        title="This conversation is unavailable"
        action={<Button onClick={() => void detail.refetch()}>Retry</Button>}
      />
    );
  const reply = (email?: MailMessage) =>
    onReply({
      mailboxId: thread.mailboxId,
      threadId: thread.id,
      to: thread.peerEmail,
      subject: replySubject(thread.subject),
      ...(email ? { replyToMessageId: email.id } : {}),
    });
  const state = current ?? thread;
  return (
    <>
      <div className="mail-reader-toolbar">
        <Button
          type="text"
          aria-label="Back to conversations"
          icon={<ArrowLeftOutlined />}
          onClick={onBack}
        />
        <Space>
          <Tooltip title={state.starred ? 'Remove star' : 'Star conversation'}>
            <Button
              aria-label="Star conversation"
              icon={state.starred ? <StarFilled className="mail-star" /> : <StarOutlined />}
              onClick={() => void changeState({ starred: !state.starred })}
            />
          </Tooltip>
          <Button
            onClick={() => {
              void changeState({ archived: !state.archived });
              onBack();
            }}
          >
            {state.archived ? 'Unarchive' : 'Archive'}
          </Button>
          <Button
            onClick={() => {
              void changeState({ read: false });
              onBack();
            }}
          >
            Mark unread
          </Button>
        </Space>
      </div>
      <div className="mail-conversation-heading">
        <Typography.Title level={3}>{thread.subject || '(No subject)'}</Typography.Title>
        <Space wrap>
          <Typography.Text type="secondary">{mailbox?.address}</Typography.Text>
          {thread.contactId && (
            <Link to={`/projects/${projectId}/contacts/${thread.contactId}`}>View contact ↗</Link>
          )}
        </Space>
      </div>
      <div className="mail-message-scroll">
        {before && (
          <Button block onClick={() => setBefore('')}>
            Back to latest messages
          </Button>
        )}
        {thread.nextCursor && (
          <Button block onClick={() => setBefore(thread.nextCursor!)}>
            Load older messages
          </Button>
        )}
        {thread.messages.map((email, index) => (
          <EmailMessageCard
            key={email.id}
            projectId={projectId}
            email={email}
            expanded={index === thread.messages.length - 1}
            canReply={canSend && !!mailbox?.sendingReady}
            onReply={() => reply(email)}
          />
        ))}
        {!thread.messages.length && <Empty description="No messages in this conversation" />}
        {canSend && (
          <Button
            className="mail-reply-button"
            icon={<SendOutlined />}
            disabled={!mailbox?.sendingReady}
            onClick={() => reply(thread.messages.at(-1))}
          >
            Reply to {thread.peerEmail}
          </Button>
        )}
      </div>
    </>
  );
}
function EmailMessageCard({
  projectId,
  email,
  expanded,
  canReply,
  onReply,
}: {
  projectId: string;
  email: MailMessage;
  expanded: boolean;
  canReply: boolean;
  onReply: () => void;
}) {
  const [open, setOpen] = useState(expanded);
  const [mode, setMode] = useState('Formatted');
  const actions = useInboxActions(projectId);
  const { message } = App.useApp();
  const hasHtml = Boolean(email.htmlBody.trim());
  const download = (path: string, filename: string) =>
    void actions
      .download(path, filename)
      .catch((err: unknown) => message.error(getUserErrorMessage(err)));
  return (
    <article
      className={
        'mail-message-card' + (email.direction === 'OUTBOUND' ? ' mail-message-card--sent' : '')
      }
    >
      <button
        type="button"
        className="mail-message-summary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Avatar size={34}>{email.fromAddress.slice(0, 1).toUpperCase()}</Avatar>
        <span className="mail-message-sender">
          <strong>{email.fromAddress}</strong>
          <small>to {email.toAddress}</small>
        </span>
        <span className="mail-message-meta">
          <time>{new Date(email.occurredAt).toLocaleString()}</time>
          <span>
            {email.direction === 'INBOUND'
              ? 'Received'
              : (email.delivery?.status.toLowerCase().replaceAll('_', ' ') ?? 'Queued')}
            {email.source === 'CAMPAIGN'
              ? ' · Campaign'
              : email.source === 'AUTOMATION'
                ? ' · Automation'
                : ''}
          </span>
        </span>
      </button>
      {open ? (
        <div className="mail-message-body">
          {email.isAutomatic && <Tag>Automatic message</Tag>}
          {email.delivery?.lastError && (
            <Alert
              className="mail-alert"
              type={email.delivery.status === 'UNKNOWN' ? 'warning' : 'error'}
              showIcon
              title={
                email.delivery.status === 'UNKNOWN'
                  ? 'Delivery is unconfirmed. Check Resend before sending another copy.'
                  : 'Delivery needs attention'
              }
              description={email.delivery.lastError}
            />
          )}
          {hasHtml && (
            <div className="mail-format-toggle">
              <Typography.Text type="secondary">
                External images and links are disabled for safety.
              </Typography.Text>
              <Segmented
                size="small"
                aria-label="Email display format"
                value={mode}
                onChange={(value) => setMode(String(value))}
                options={['Formatted', 'Plain text']}
              />
            </div>
          )}
          {hasHtml && mode === 'Formatted' ? (
            <EmailHtmlFrame html={email.htmlBody} title={'Email from ' + email.fromAddress} />
          ) : (
            <div className="mail-plain-text">{email.textBody || 'No plain-text content.'}</div>
          )}
          <div className="mail-attachment-list">
            {email.attachments.map((file) => (
              <Button
                key={file.id}
                icon={<PaperClipOutlined />}
                disabled={file.status !== 'AVAILABLE'}
                onClick={() => download('attachments/' + file.id, file.filename)}
              >
                {file.filename} · {Math.ceil(file.sizeBytes / 1024)} KB
                {file.status !== 'AVAILABLE' ? ' · ' + file.status.toLowerCase() : ''}
              </Button>
            ))}
            {email.delivery?.attachmentAssetIds.map((id, index) => (
              <Button
                key={id}
                icon={<PaperClipOutlined />}
                onClick={() =>
                  download(`messages/${email.id}/assets/${id}`, `attachment-${index + 1}`)
                }
              >
                Attachment {index + 1}
              </Button>
            ))}
          </div>
          {canReply && (
            <Button type="text" onClick={onReply}>
              Reply
            </Button>
          )}
        </div>
      ) : (
        <p className="mail-collapsed-preview">{email.textBody.slice(0, 180) || email.subject}</p>
      )}
    </article>
  );
}

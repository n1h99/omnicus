import {
  AppstoreAddOutlined,
  BoldOutlined,
  CloseOutlined,
  CodeOutlined,
  ClockCircleOutlined,
  ContactsOutlined,
  FileTextOutlined,
  ItalicOutlined,
  LinkOutlined,
  MailOutlined,
  MessageOutlined,
  PaperClipOutlined,
  ReloadOutlined,
  SearchOutlined,
  SendOutlined,
  StrikethroughOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  WhatsAppOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Avatar,
  Button,
  Empty,
  Input,
  Modal,
  Pagination,
  Popover,
  Segmented,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';

import { getUserErrorMessage } from '../api';
import {
  type CommunicationChannel,
  type CommunicationContact,
  type CommunicationIdentity,
  type CommunicationMessage,
  type CommunicationTemplate,
  useCommunicationActions,
  useCommunicationContact,
  useCommunicationContacts,
  useCommunicationMedia,
  useCommunicationMessages,
  useCommunicationTemplates,
} from '../communications-api';
import { EmailCompose, type ComposeInitial } from '../email-compose';
import {
  type MailMessage,
  type MailThread,
  type MailThreadDetail,
  useInboxActions,
  useInboxQuery,
  useMailboxes,
} from '../email-inbox-api';
import type { MediaKind } from '../media-api';
import { hasProjectPermission, useProjectAccess } from '../project-access';
import { useTemplates } from '../templates-api';
import {
  assetKindForWhatsAppSlot,
  whatsAppParameterSlots,
  whatsAppTemplateComponents,
  whatsAppTemplateComposerIssue,
} from '../whatsapp-template-composer';
import { resolveWhatsAppTemplateMessage } from '../whatsapp-template-message';
import '../communications.css';

const channelLabels: Record<CommunicationChannel, string> = {
  EMAIL: 'Email',
  TELEGRAM: 'Telegram',
  WHATSAPP: 'WhatsApp',
};

function shortDate(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || '?'
  );
}

function channelIcon(channel: CommunicationChannel) {
  if (channel === 'WHATSAPP') return <WhatsAppOutlined />;
  if (channel === 'EMAIL') return <MailOutlined />;
  return <SendOutlined />;
}

export function CommunicationsPage() {
  const { projectId } = useParams();
  return projectId ? (
    <AntApp component={false}>
      <CommunicationsWorkspace projectId={projectId} />
    </AntApp>
  ) : null;
}

function CommunicationsWorkspace({ projectId }: { projectId: string }) {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const access = useProjectAccess(projectId);
  const contacts = useCommunicationContacts(projectId, search, page);
  const selectedContactId = params.get('contact') ?? contacts.data?.items[0]?.id;
  const contact = useCommunicationContact(projectId, selectedContactId);
  const requestedChannel = params.get('channel')?.toUpperCase();
  const selectedChannel: CommunicationChannel = ['EMAIL', 'TELEGRAM', 'WHATSAPP'].includes(
    requestedChannel ?? '',
  )
    ? (requestedChannel as CommunicationChannel)
    : 'WHATSAPP';
  const canSendMessages = hasProjectPermission(access.data, 'communications:send');
  const choose = (values: { contact?: string; channel?: CommunicationChannel }) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (values.contact) next.set('contact', values.contact);
      if (values.channel) next.set('channel', values.channel.toLowerCase());
      return next;
    });

  return (
    <section className="communications-page">
      <div className="page-heading-row communications-heading">
        <div>
          <Typography.Title level={2}>Communications</Typography.Title>
          <Typography.Paragraph type="secondary">
            Email, WhatsApp and Telegram conversations in one contact workspace.
          </Typography.Paragraph>
        </div>
        <Button
          icon={<ReloadOutlined />}
          loading={contacts.isFetching || contact.isFetching}
          onClick={() => {
            void contacts.refetch();
            void contact.refetch();
          }}
        >
          Refresh
        </Button>
      </div>

      <div className="communications-layout surface">
        <aside className="communications-contact-pane" aria-label="Contacts">
          <div className="communications-contact-toolbar">
            <Input
              allowClear
              aria-label="Search communications contacts"
              placeholder="Search contacts"
              prefix={<SearchOutlined />}
              value={search}
              onChange={(event) => {
                setPage(1);
                setSearch(event.target.value);
              }}
            />
            <span>{contacts.data?.total ?? 0} contacts</span>
          </div>
          <div className="communications-contact-list">
            {contacts.isLoading ? (
              <div className="communications-state">
                <Spin />
              </div>
            ) : contacts.isError ? (
              <Alert
                type="error"
                showIcon
                title="Contacts could not be loaded"
                action={<Button onClick={() => void contacts.refetch()}>Retry</Button>}
              />
            ) : contacts.data?.items.length ? (
              contacts.data.items.map((item) => (
                <button
                  className={`communications-contact${selectedContactId === item.id ? ' is-selected' : ''}`}
                  key={item.id}
                  type="button"
                  onClick={() => choose({ contact: item.id })}
                >
                  <Avatar>{initials(item.displayName)}</Avatar>
                  <span className="communications-contact-copy">
                    <span className="communications-contact-line">
                      <strong>{item.displayName}</strong>
                      <time>{shortDate(item.lastInteractionAt)}</time>
                    </span>
                    <small>{item.preview ?? item.email ?? item.phone ?? 'No messages yet'}</small>
                    <span className="communications-contact-channels">
                      {item.channels.map((channel) => (
                        <span key={channel} title={channelLabels[channel]}>
                          {channelIcon(channel)}
                        </span>
                      ))}
                    </span>
                  </span>
                </button>
              ))
            ) : (
              <Empty description="No contacts found" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
          </div>
          {(contacts.data?.total ?? 0) > 40 ? (
            <Pagination
              current={page}
              pageSize={40}
              simple
              total={contacts.data?.total ?? 0}
              onChange={setPage}
            />
          ) : null}
        </aside>

        <main className="communications-conversation-pane">
          {!selectedContactId ? (
            <div className="communications-empty">
              <TeamOutlined />
              <Typography.Title level={4}>Choose a contact</Typography.Title>
              <Typography.Text type="secondary">
                Their conversations will appear here.
              </Typography.Text>
            </div>
          ) : contact.isLoading ? (
            <div className="communications-state">
              <Spin size="large" />
            </div>
          ) : contact.isError || !contact.data ? (
            <Alert
              type="error"
              showIcon
              title="Contact communications are unavailable"
              description={getUserErrorMessage(contact.error)}
              action={<Button onClick={() => void contact.refetch()}>Retry</Button>}
            />
          ) : (
            <>
              <header className="communications-contact-header">
                <div>
                  <Avatar size={42}>{initials(contact.data.displayName)}</Avatar>
                  <span>
                    <strong>{contact.data.displayName}</strong>
                    <small>
                      {contact.data.phone ?? contact.data.email ?? 'Contact details unavailable'}
                    </small>
                  </span>
                </div>
                <Link to={`/projects/${projectId}/contacts/${contact.data.id}`}>
                  Open contact <LinkOutlined />
                </Link>
              </header>
              <Tabs
                activeKey={selectedChannel}
                className="communications-channel-tabs"
                classNames={{
                  body: 'communications-tab-body',
                  content: 'communications-tab-content',
                }}
                onChange={(value) => choose({ channel: value as CommunicationChannel })}
                items={(['EMAIL', 'WHATSAPP', 'TELEGRAM'] as const).map((channel) => ({
                  key: channel,
                  label: (
                    <span className="communications-tab-label">
                      {channelIcon(channel)} {channelLabels[channel]}
                    </span>
                  ),
                  children:
                    channel === 'EMAIL' ? (
                      <ContactEmailPanel contact={contact.data} projectId={projectId} />
                    ) : (
                      <MessengerPanel
                        key={`${contact.data.id}-${channel}`}
                        channel={channel}
                        active={selectedChannel === channel}
                        canSend={canSendMessages}
                        contact={contact.data}
                        projectId={projectId}
                        onIdentityCreated={() => void contact.refetch()}
                      />
                    ),
                }))}
              />
            </>
          )}
        </main>
      </div>
    </section>
  );
}

function MessengerPanel({
  active,
  canSend,
  channel,
  contact,
  projectId,
  onIdentityCreated,
}: {
  active: boolean;
  canSend: boolean;
  channel: 'TELEGRAM' | 'WHATSAPP';
  contact: CommunicationContact;
  projectId: string;
  onIdentityCreated: () => void;
}) {
  const { message } = AntApp.useApp();
  const identities = contact.identities.filter(
    (identity) =>
      identity.channel === channel &&
      identity.status === 'ACTIVE' &&
      identity.connection.status === 'ACTIVE',
  );
  const availableConnections = contact.connections.filter(
    (connection) => connection.type === channel && connection.status === 'ACTIVE',
  );
  const [identityId, setIdentityId] = useState(identities[0]?.id);
  const identity = identities.find((candidate) => candidate.id === identityId) ?? identities[0];
  const [connectionId, setConnectionId] = useState(
    identity?.connectionId ?? availableConnections[0]?.id,
  );
  const messages = useCommunicationMessages(projectId, contact.id, identity?.id);
  const messageTemplates = useCommunicationTemplates(
    projectId,
    contact.id,
    connectionId,
    channel === 'WHATSAPP',
  );
  const actions = useCommunicationActions(projectId, contact.id);
  const quickReplyTemplates = useTemplates(projectId);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<CommunicationMessage>();
  const [pendingMedia, setPendingMedia] = useState<{
    id: string;
    kind: MediaKind;
    name: string;
  }>();
  const [templateOpen, setTemplateOpen] = useState(false);
  const [interactiveOpen, setInteractiveOpen] = useState(false);
  const [structuredOpen, setStructuredOpen] = useState(false);
  const [quickRepliesOpen, setQuickRepliesOpen] = useState(false);
  const [quickReplySearch, setQuickReplySearch] = useState('');
  const selectionRef = useRef({ end: 0, start: 0 });
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const lastMessageId = messages.data?.items.at(-1)?.id;
  const serviceWindowOpen =
    channel === 'TELEGRAM' ||
    Boolean(
      messages.data?.conversation?.serviceWindowExpiresAt &&
      new Date(messages.data.conversation.serviceWindowExpiresAt).getTime() > Date.now(),
    );

  useEffect(() => {
    const scroll = messageScrollRef.current;
    if (active && scroll) scroll.scrollTop = scroll.scrollHeight;
  }, [active, lastMessageId]);

  const send = async () => {
    if (!canSend || (!draft.trim() && !pendingMedia) || !identity) return;
    try {
      await actions.send.mutateAsync({
        channel,
        clientRequestId: crypto.randomUUID(),
        identityId: identity.id,
        ...(pendingMedia
          ? { media: { kind: pendingMedia.kind, mediaAssetId: pendingMedia.id } }
          : {}),
        ...(replyTo ? { replyToMessageId: replyTo.id } : {}),
        ...(channel === 'WHATSAPP' ? { linkPreviewOptions: { isDisabled: false } } : {}),
        ...(draft.trim() ? { text: draft.trim() } : {}),
      });
      setDraft('');
      setPendingMedia(undefined);
      setReplyTo(undefined);
      void message.success('Message queued.');
    } catch (error) {
      void message.error(getUserErrorMessage(error, 'Message could not be sent.'));
    }
  };

  const applyWhatsAppFormat = (marker: '*' | '_' | '~' | '```') => {
    const { end, start } = selectionRef.current;
    const safeStart = Math.max(0, Math.min(start, draft.length));
    const safeEnd = Math.max(safeStart, Math.min(end, draft.length));
    const selected = draft.slice(safeStart, safeEnd);
    const fallback = marker === '```' ? 'code' : 'text';
    const value = selected || fallback;
    setDraft(`${draft.slice(0, safeStart)}${marker}${value}${marker}${draft.slice(safeEnd)}`);
  };

  const quickReplies = (quickReplyTemplates.data ?? []).filter((template) => {
    const version = template.activeVersion;
    const content = version?.content.text?.trim();
    const query = quickReplySearch.trim().toLocaleLowerCase();
    return (
      version?.kind === 'TEXT' &&
      Boolean(content) &&
      (!query ||
        template.name.toLocaleLowerCase().includes(query) ||
        content?.toLocaleLowerCase().includes(query))
    );
  });

  return (
    <div className="communications-messenger">
      <div className="communications-messenger-header">
        <div className="communications-channel-toolbar">
          <div>
            <strong>{channel === 'WHATSAPP' ? 'WhatsApp Business' : 'Telegram'}</strong>
            <small>
              {identity
                ? `${identity.connection.name} · ${identity.username ? `@${identity.username}` : identity.externalUserId}`
                : channel === 'WHATSAPP'
                  ? 'No existing identity — start with an approved Meta template'
                  : 'This contact has not started a conversation with a connected Telegram bot'}
            </small>
          </div>
          <Space wrap>
            {identities.length > 1 ? (
              <Select
                aria-label={`Choose ${channelLabels[channel]} identity`}
                value={identity?.id}
                onChange={(value) => {
                  setIdentityId(value);
                  const next = identities.find((candidate) => candidate.id === value);
                  if (next) setConnectionId(next.connectionId);
                }}
                options={identities.map((candidate) => ({
                  label: `${candidate.connection.name} · ${candidate.username ?? candidate.externalUserId}`,
                  value: candidate.id,
                }))}
              />
            ) : null}
          </Space>
        </div>

        {channel === 'WHATSAPP' && identity ? (
          <div className={`communications-window ${serviceWindowOpen ? 'is-open' : 'is-closed'}`}>
            <ClockCircleOutlined />
            <span>
              <strong>
                {serviceWindowOpen
                  ? '24-hour service window is open'
                  : '24-hour service window is closed'}
              </strong>
              <small>
                {serviceWindowOpen
                  ? `Free-form messages are available${messages.data?.conversation?.serviceWindowExpiresAt ? ` until ${new Date(messages.data.conversation.serviceWindowExpiresAt).toLocaleString()}` : ''}.`
                  : 'Use an approved Meta template to start or reopen the conversation.'}
              </small>
            </span>
          </div>
        ) : null}
      </div>

      <div className="communications-message-scroll" ref={messageScrollRef}>
        {!identity ? (
          <div className="communications-empty communications-empty--compact">
            {channel === 'WHATSAPP' ? <WhatsAppOutlined /> : <SendOutlined />}
            <Typography.Title level={4}>
              {channel === 'WHATSAPP'
                ? 'Start this WhatsApp conversation'
                : 'Telegram is not available yet'}
            </Typography.Title>
            <Typography.Text type="secondary">
              {channel === 'WHATSAPP'
                ? contact.whatsAppConsentStatus === 'GRANTED' && contact.phone
                  ? 'Choose an approved Meta template. Omnicus will create the official channel identity and queue the message.'
                  : 'A phone number and granted WhatsApp consent are required before an official template can be sent.'
                : 'The contact must first open the connected bot so Telegram provides a chat identity.'}
            </Typography.Text>
          </div>
        ) : messages.isLoading ? (
          <div className="communications-state">
            <Spin />
          </div>
        ) : messages.isError ? (
          <Alert
            type="error"
            title="Messages could not be loaded"
            action={<Button onClick={() => void messages.refetch()}>Retry</Button>}
          />
        ) : messages.data?.items.length ? (
          messages.data.items.map((item) => {
            const metadata = object(item.metadata);
            const replyId =
              text(metadata?.replyToOmnicusMessageId) ?? text(metadata?.replyToMessageId);
            const replyTarget = replyId
              ? messages.data.items.find((candidate) => candidate.id === replyId)
              : undefined;
            return (
              <CommunicationBubble
                item={item}
                key={item.id}
                onReply={() => setReplyTo(item)}
                {...(replyTarget ? { replyTarget } : {})}
                templates={messageTemplates.data ?? []}
              />
            );
          })
        ) : (
          <div className="communications-empty communications-empty--compact">
            <MessageOutlined />
            <Typography.Text type="secondary">
              No messages in this conversation yet.
            </Typography.Text>
          </div>
        )}
      </div>

      <div className="communications-composer">
        <div className="communications-composer-main">
          {replyTo ? (
            <div className="communications-reply-preview">
              <span>
                <strong>Replying to message</strong>
                <small>{messageText(replyTo, messageTemplates.data ?? [])}</small>
              </span>
              <Button
                aria-label="Cancel reply"
                icon={<CloseOutlined />}
                size="small"
                type="text"
                onClick={() => setReplyTo(undefined)}
              />
            </div>
          ) : null}
          {pendingMedia ? (
            <div className="communications-reply-preview">
              <span>
                <strong>{pendingMedia.name}</strong>
                <small>{pendingMedia.kind}</small>
              </span>
              <Button
                aria-label="Remove attachment"
                icon={<CloseOutlined />}
                size="small"
                type="text"
                onClick={() => setPendingMedia(undefined)}
              />
            </div>
          ) : null}
          <div className="communications-format-toolbar">
            {channel === 'WHATSAPP' ? (
              <>
                <Tooltip title="Bold">
                  <Button
                    aria-label="Bold"
                    disabled={!canSend || !identity || !serviceWindowOpen}
                    icon={<BoldOutlined />}
                    size="small"
                    type="text"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => applyWhatsAppFormat('*')}
                  />
                </Tooltip>
                <Tooltip title="Italic">
                  <Button
                    aria-label="Italic"
                    disabled={!canSend || !identity || !serviceWindowOpen}
                    icon={<ItalicOutlined />}
                    size="small"
                    type="text"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => applyWhatsAppFormat('_')}
                  />
                </Tooltip>
                <Tooltip title="Strikethrough">
                  <Button
                    aria-label="Strikethrough"
                    disabled={!canSend || !identity || !serviceWindowOpen}
                    icon={<StrikethroughOutlined />}
                    size="small"
                    type="text"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => applyWhatsAppFormat('~')}
                  />
                </Tooltip>
                <Tooltip title="Monospace">
                  <Button
                    aria-label="Monospace"
                    disabled={!canSend || !identity || !serviceWindowOpen}
                    icon={<CodeOutlined />}
                    size="small"
                    type="text"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => applyWhatsAppFormat('```')}
                  />
                </Tooltip>
              </>
            ) : null}
          </div>
          <div className="communications-compose-row">
            <Input.TextArea
              autoSize={{ minRows: 1, maxRows: 6 }}
              disabled={!canSend || !identity || !serviceWindowOpen}
              maxLength={4096}
              placeholder={
                !identity
                  ? channel === 'WHATSAPP'
                    ? 'Choose Meta template to start'
                    : 'The contact must start a conversation with the Telegram bot'
                  : serviceWindowOpen
                    ? `Message via ${channelLabels[channel]}`
                    : 'Use an approved Meta template outside the 24-hour window'
              }
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onSelect={(event) => {
                selectionRef.current = {
                  end: event.currentTarget.selectionEnd,
                  start: event.currentTarget.selectionStart,
                };
              }}
              onPressEnter={(event) => {
                if (!event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
          </div>
        </div>
        <div className="communications-composer-actions">
          <div className="communications-composer-tools">
            <Upload
              accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip"
              beforeUpload={async (file) => {
                const kind = mediaKind(file);
                try {
                  const asset = await actions.upload.mutateAsync({ channel, file, kind });
                  setPendingMedia({
                    id: asset.id,
                    kind,
                    name: asset.originalFilename ?? file.name,
                  });
                } catch (error) {
                  void message.error(getUserErrorMessage(error, 'File could not be uploaded.'));
                }
                return false;
              }}
              disabled={!canSend || !identity || !serviceWindowOpen || actions.upload.isPending}
              showUploadList={false}
            >
              <Button
                aria-label="Attach a file"
                disabled={!canSend || !identity || !serviceWindowOpen || actions.upload.isPending}
                icon={<PaperClipOutlined />}
                loading={actions.upload.isPending}
                size="small"
              >
                Attach
              </Button>
            </Upload>
            <Popover
              content={
                <div className="communications-quick-replies">
                  <strong>Quick replies</strong>
                  <small>Saved text templates for regular messages.</small>
                  <Input
                    allowClear
                    prefix={<SearchOutlined />}
                    placeholder="Search quick replies"
                    value={quickReplySearch}
                    onChange={(event) => setQuickReplySearch(event.target.value)}
                  />
                  <div>
                    {quickReplyTemplates.isLoading ? (
                      <Spin size="small" />
                    ) : quickReplies.length ? (
                      quickReplies.map((template) => (
                        <button
                          key={template.id}
                          type="button"
                          onClick={() => {
                            setDraft(template.activeVersion?.content.text ?? '');
                            setQuickRepliesOpen(false);
                          }}
                        >
                          <strong>{template.name}</strong>
                          <small>{template.activeVersion?.content.text}</small>
                        </button>
                      ))
                    ) : (
                      <small>No published text templates found.</small>
                    )}
                  </div>
                </div>
              }
              open={quickRepliesOpen}
              placement="topLeft"
              trigger="click"
              onOpenChange={setQuickRepliesOpen}
            >
              <Button
                icon={<ThunderboltOutlined />}
                size="small"
                disabled={!canSend || !identity || !serviceWindowOpen}
              >
                Quick replies
              </Button>
            </Popover>
            <Button
              icon={<ContactsOutlined />}
              size="small"
              disabled={!canSend || !identity || !serviceWindowOpen}
              onClick={() => setStructuredOpen(true)}
            >
              {channel === 'WHATSAPP' ? 'Contact / Location' : 'Contact / Poll'}
            </Button>
            {channel === 'WHATSAPP' ? (
              <>
                <Button
                  icon={<AppstoreAddOutlined />}
                  size="small"
                  disabled={!canSend || !identity || !serviceWindowOpen}
                  onClick={() => setInteractiveOpen(true)}
                >
                  Buttons / List
                </Button>
                <Button
                  icon={<FileTextOutlined />}
                  size="small"
                  disabled={!canSend || !connectionId || !availableConnections.length}
                  onClick={() => setTemplateOpen(true)}
                >
                  Meta template
                </Button>
              </>
            ) : null}
          </div>
          <Button
            type="primary"
            aria-label="Send message"
            icon={<SendOutlined />}
            loading={actions.send.isPending}
            disabled={
              !canSend || !identity || !serviceWindowOpen || (!draft.trim() && !pendingMedia)
            }
            onClick={() => void send()}
          />
        </div>
      </div>

      {channel === 'WHATSAPP' && canSend && templateOpen ? (
        <WhatsAppTemplateModal
          connections={availableConnections}
          contact={contact}
          {...(connectionId ? { connectionId } : {})}
          {...(identity ? { identity } : {})}
          onClose={() => setTemplateOpen(false)}
          onConnectionChange={setConnectionId}
          onIdentityCreated={onIdentityCreated}
          projectId={projectId}
        />
      ) : null}
      {channel === 'WHATSAPP' && identity && interactiveOpen ? (
        <WhatsAppInteractiveModal
          actions={actions}
          identityId={identity.id}
          onClose={() => setInteractiveOpen(false)}
          onSent={() => {
            setInteractiveOpen(false);
            setReplyTo(undefined);
          }}
          {...(replyTo ? { replyToMessageId: replyTo.id } : {})}
        />
      ) : null}
      {identity && structuredOpen ? (
        <StructuredMessageModal
          actions={actions}
          channel={channel}
          identityId={identity.id}
          onClose={() => setStructuredOpen(false)}
          onSent={() => {
            setStructuredOpen(false);
            setReplyTo(undefined);
          }}
          {...(replyTo ? { replyToMessageId: replyTo.id } : {})}
        />
      ) : null}
    </div>
  );
}

type CommunicationActions = ReturnType<typeof useCommunicationActions>;

function WhatsAppInteractiveModal({
  actions,
  identityId,
  onClose,
  onSent,
  replyToMessageId,
}: {
  actions: CommunicationActions;
  identityId: string;
  onClose: () => void;
  onSent: () => void;
  replyToMessageId?: string;
}) {
  const { message } = AntApp.useApp();
  const [mode, setMode] = useState<'button' | 'list'>('button');
  const [header, setHeader] = useState('');
  const [body, setBody] = useState('');
  const [footer, setFooter] = useState('');
  const [actionLabel, setActionLabel] = useState('Choose');
  const [sectionTitle, setSectionTitle] = useState('Options');
  const [rows, setRows] = useState('Yes | yes\nNo | no');
  const parsedRows = rows
    .split('\n')
    .map((line) => line.split('|').map((value) => value.trim()))
    .filter(([title, id]) => Boolean(title && id));
  const invalid =
    !body.trim() ||
    !parsedRows.length ||
    (mode === 'button'
      ? parsedRows.length > 3 || parsedRows.some(([title]) => (title?.length ?? 0) > 20)
      : !actionLabel.trim() ||
        parsedRows.length > 10 ||
        parsedRows.some(([title, id, description]) =>
          Boolean(
            (title?.length ?? 0) > 24 || (id?.length ?? 0) > 200 || (description?.length ?? 0) > 72,
          ),
        ));
  const send = async () => {
    if (invalid) return;
    const interactive =
      mode === 'button'
        ? {
            action: {
              buttons: parsedRows.map(([title, id]) => ({ id: id!, title: title! })),
            },
            body: { text: body.trim() },
            ...(footer.trim() ? { footer: { text: footer.trim() } } : {}),
            ...(header.trim() ? { header: { text: header.trim(), type: 'text' } } : {}),
            type: 'button',
          }
        : {
            action: {
              button: actionLabel.trim(),
              sections: [
                {
                  rows: parsedRows.map(([title, id, description]) => ({
                    id: id!,
                    title: title!,
                    ...(description ? { description } : {}),
                  })),
                  ...(sectionTitle.trim() ? { title: sectionTitle.trim() } : {}),
                },
              ],
            },
            body: { text: body.trim() },
            ...(footer.trim() ? { footer: { text: footer.trim() } } : {}),
            ...(header.trim() ? { header: { text: header.trim(), type: 'text' } } : {}),
            type: 'list',
          };
    try {
      await actions.send.mutateAsync({
        channel: 'WHATSAPP',
        clientRequestId: crypto.randomUUID(),
        identityId,
        interactive,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      });
      void message.success('Interactive WhatsApp message queued.');
      onSent();
    } catch (error) {
      void message.error(getUserErrorMessage(error, 'Interactive message could not be sent.'));
    }
  };
  return (
    <Modal
      centered
      open
      width={660}
      title="WhatsApp buttons and lists"
      okText="Send"
      confirmLoading={actions.send.isPending}
      okButtonProps={{ disabled: invalid }}
      onCancel={onClose}
      onOk={() => void send()}
    >
      <div className="communications-structured-modal">
        <Segmented
          block
          value={mode}
          options={[
            { label: 'Reply buttons', value: 'button' },
            { label: 'List menu', value: 'list' },
          ]}
          onChange={(value) => setMode(value as 'button' | 'list')}
        />
        <label>
          <span>Header (optional)</span>
          <Input
            maxLength={60}
            value={header}
            onChange={(event) => setHeader(event.target.value)}
          />
        </label>
        <label>
          <span>Message</span>
          <Input.TextArea
            autoSize={{ minRows: 3, maxRows: 7 }}
            maxLength={1024}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        <label>
          <span>Footer (optional)</span>
          <Input
            maxLength={60}
            value={footer}
            onChange={(event) => setFooter(event.target.value)}
          />
        </label>
        {mode === 'list' ? (
          <div className="communications-structured-grid">
            <label>
              <span>Open-list button</span>
              <Input
                maxLength={20}
                value={actionLabel}
                onChange={(event) => setActionLabel(event.target.value)}
              />
            </label>
            <label>
              <span>Section title</span>
              <Input
                maxLength={24}
                value={sectionTitle}
                onChange={(event) => setSectionTitle(event.target.value)}
              />
            </label>
          </div>
        ) : null}
        <label>
          <span>{mode === 'button' ? 'Buttons' : 'List rows'}</span>
          <Input.TextArea
            autoSize={{ minRows: 3, maxRows: 10 }}
            value={rows}
            placeholder={
              mode === 'button'
                ? 'Button label | callback_id'
                : 'Row title | callback_id | Optional description'
            }
            onChange={(event) => setRows(event.target.value)}
          />
          <small>One item per line, separated with |.</small>
        </label>
      </div>
    </Modal>
  );
}

function StructuredMessageModal({
  actions,
  channel,
  identityId,
  onClose,
  onSent,
  replyToMessageId,
}: {
  actions: CommunicationActions;
  channel: 'TELEGRAM' | 'WHATSAPP';
  identityId: string;
  onClose: () => void;
  onSent: () => void;
  replyToMessageId?: string;
}) {
  const { message } = AntApp.useApp();
  const [mode, setMode] = useState<'contact' | 'location' | 'poll'>('contact');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [address, setAddress] = useState('');
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState('');
  const parsedOptions = options
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  const coordinatesValid =
    Number.isFinite(Number(latitude)) &&
    Number(latitude) >= -90 &&
    Number(latitude) <= 90 &&
    Number.isFinite(Number(longitude)) &&
    Number(longitude) >= -180 &&
    Number(longitude) <= 180;
  const invalid =
    mode === 'contact'
      ? !name.trim() || !phone.trim()
      : mode === 'location'
        ? !coordinatesValid
        : !question.trim() || parsedOptions.length < 2 || parsedOptions.length > 10;
  const send = async () => {
    if (invalid) return;
    const structured =
      mode === 'contact'
        ? channel === 'WHATSAPP'
          ? {
              type: 'whatsapp_contact',
              formattedName: name.trim(),
              firstName: name.trim(),
              phones: [{ phone: phone.trim() }],
              ...(email.trim() ? { emails: [{ email: email.trim() }] } : {}),
            }
          : {
              type: 'contact',
              firstName: name.trim(),
              phoneNumber: phone.trim(),
            }
        : mode === 'location'
          ? {
              type: channel === 'WHATSAPP' ? 'whatsapp_location' : 'location',
              latitude: Number(latitude),
              longitude: Number(longitude),
              ...(address.trim()
                ? channel === 'WHATSAPP'
                  ? { address: address.trim(), name: address.trim() }
                  : {}
                : {}),
            }
          : {
              type: 'poll',
              question: question.trim(),
              options: parsedOptions,
              isAnonymous: false,
              allowsMultipleAnswers: false,
            };
    try {
      await actions.send.mutateAsync({
        channel,
        clientRequestId: crypto.randomUUID(),
        identityId,
        structured,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      });
      void message.success('Structured message queued.');
      onSent();
    } catch (error) {
      void message.error(getUserErrorMessage(error, 'Structured message could not be sent.'));
    }
  };
  const modes = [
    { label: 'Contact', value: 'contact' },
    { label: 'Location', value: 'location' },
    ...(channel === 'TELEGRAM' ? [{ label: 'Poll', value: 'poll' }] : []),
  ];
  return (
    <Modal
      centered
      open
      width={620}
      title={`Send via ${channelLabels[channel]}`}
      okText="Send"
      confirmLoading={actions.send.isPending}
      okButtonProps={{ disabled: invalid }}
      onCancel={onClose}
      onOk={() => void send()}
    >
      <div className="communications-structured-modal">
        <Segmented
          block
          value={mode}
          options={modes}
          onChange={(value) => setMode(value as 'contact' | 'location' | 'poll')}
        />
        {mode === 'contact' ? (
          <>
            <label>
              <span>Contact name</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              <span>Phone</span>
              <Input value={phone} onChange={(event) => setPhone(event.target.value)} />
            </label>
            {channel === 'WHATSAPP' ? (
              <label>
                <span>Email (optional)</span>
                <Input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
            ) : null}
          </>
        ) : mode === 'location' ? (
          <>
            <div className="communications-structured-grid">
              <label>
                <span>Latitude</span>
                <Input value={latitude} onChange={(event) => setLatitude(event.target.value)} />
              </label>
              <label>
                <span>Longitude</span>
                <Input value={longitude} onChange={(event) => setLongitude(event.target.value)} />
              </label>
            </div>
            {channel === 'WHATSAPP' ? (
              <label>
                <span>Location name / address (optional)</span>
                <Input value={address} onChange={(event) => setAddress(event.target.value)} />
              </label>
            ) : null}
          </>
        ) : (
          <>
            <label>
              <span>Question</span>
              <Input value={question} onChange={(event) => setQuestion(event.target.value)} />
            </label>
            <label>
              <span>Answer options</span>
              <Input.TextArea
                autoSize={{ minRows: 3, maxRows: 10 }}
                placeholder="One option per line"
                value={options}
                onChange={(event) => setOptions(event.target.value)}
              />
            </label>
          </>
        )}
      </div>
    </Modal>
  );
}

function CommunicationBubble({
  item,
  onReply,
  replyTarget,
  templates,
}: {
  item: CommunicationMessage;
  onReply: () => void;
  replyTarget?: CommunicationMessage;
  templates: CommunicationTemplate[];
}) {
  const template = resolveWhatsAppTemplateMessage(item.content.whatsAppTemplate, templates);
  const interactive = object(item.content.interactive);
  const interactiveBody = text(object(interactive?.body)?.text);
  const interactiveHeader = text(object(interactive?.header)?.text);
  const interactiveFooter = text(object(interactive?.footer)?.text);
  const action = object(interactive?.action);
  const interactiveButtons = Array.isArray(action?.buttons)
    ? action.buttons
        .map((candidate) => text(object(candidate)?.title))
        .filter((value): value is string => Boolean(value))
    : Array.isArray(action?.sections)
      ? action.sections.flatMap((candidateSection) => {
          const section = object(candidateSection);
          return Array.isArray(section?.rows)
            ? section.rows
                .map((candidate) => text(object(candidate)?.title))
                .filter((value): value is string => Boolean(value))
            : [];
        })
      : [];
  const structured = object(item.content.structured);
  const contact =
    object(item.content.contact) ?? (text(structured?.type) === 'contact' ? structured : undefined);
  const location =
    typeof item.content.latitude === 'number' && typeof item.content.longitude === 'number'
      ? item.content
      : text(structured?.type) === 'location'
        ? structured
        : undefined;
  const poll = text(structured?.type) === 'poll' ? structured : undefined;
  return (
    <article className={`communications-message is-${item.direction.toLowerCase()}`}>
      <div>
        {replyTarget ? (
          <div className="communications-message-reply-reference">
            <small>Reply to</small>
            <span>{messageText(replyTarget, templates)}</span>
          </div>
        ) : null}
        {item.content.whatsAppTemplate ? (
          <div className="communications-template-message">
            <Tag color="green">Meta template</Tag>
            {template?.header ? <strong>{template.header}</strong> : null}
            <p>{template?.body ?? messageText(item, templates)}</p>
            {template?.footer ? <small>{template.footer}</small> : null}
            {template?.buttons.length ? (
              <div className="communications-template-buttons">
                {template.buttons.map((button, index) => (
                  <span key={`${button}-${index}`}>{button}</span>
                ))}
              </div>
            ) : null}
            {template ? (
              <small className="communications-template-meta">
                {template.name} · {template.languageCode}
              </small>
            ) : null}
          </div>
        ) : interactiveBody ? (
          <div className="communications-interactive-message">
            {interactiveHeader ? <strong>{interactiveHeader}</strong> : null}
            <p>{interactiveBody}</p>
            {interactiveFooter ? <small>{interactiveFooter}</small> : null}
            {interactiveButtons.length ? (
              <div className="communications-template-buttons">
                {interactiveButtons.map((button, index) => (
                  <span key={`${button}-${index}`}>{button}</span>
                ))}
              </div>
            ) : null}
          </div>
        ) : contact ? (
          <div className="communications-shared-card">
            <ContactsOutlined />
            <span>
              <strong>{text(contact.formattedName) ?? text(contact.firstName) ?? 'Contact'}</strong>
              <small>{sharedContactPhone(contact) ?? 'Shared contact'}</small>
            </span>
          </div>
        ) : location ? (
          <div className="communications-shared-card">
            <LinkOutlined />
            <span>
              <strong>{text(location.name) ?? text(location.address) ?? 'Location'}</strong>
              <small>
                {String(location.latitude)}, {String(location.longitude)}
              </small>
            </span>
          </div>
        ) : poll ? (
          <div className="communications-poll-message">
            <strong>{text(poll.question) ?? 'Poll'}</strong>
            {Array.isArray(poll.options)
              ? poll.options.map((option, index) => (
                  <span key={`${String(option)}-${index}`}>{String(option)}</span>
                ))
              : null}
          </div>
        ) : (
          <p>{messageText(item, templates)}</p>
        )}
        {item.mediaAsset ? (
          <span className="communications-media-label">
            <PaperClipOutlined /> {item.mediaAsset.originalFilename ?? item.mediaAsset.kind}
          </span>
        ) : null}
        <footer>
          <time>{new Date(item.createdAt).toLocaleString()}</time>
          <span>{item.status.toLowerCase()}</span>
          <button type="button" onClick={onReply}>
            Reply
          </button>
        </footer>
      </div>
    </article>
  );
}

function messageText(item: CommunicationMessage, templates: CommunicationTemplate[] = []) {
  const content = item.content;
  const template = object(content.whatsAppTemplate);
  const templatePreview = resolveWhatsAppTemplateMessage(content.whatsAppTemplate, templates);
  const interactive = object(content.interactive);
  const structured = object(content.structured);
  return (
    text(content.text) ??
    text(content.caption) ??
    text(object(content.richMessage)?.markdown) ??
    text(object(interactive?.body)?.text) ??
    templatePreview?.body ??
    text(template?.name) ??
    text(structured?.question) ??
    item.mediaAsset?.originalFilename ??
    item.type.toLowerCase().replaceAll('_', ' ')
  );
}

function sharedContactPhone(contact: Record<string, unknown>) {
  if (text(contact.phoneNumber)) return text(contact.phoneNumber);
  if (!Array.isArray(contact.phones)) return undefined;
  return contact.phones
    .map((candidate) => text(object(candidate)?.phone))
    .find((value): value is string => Boolean(value));
}

function WhatsAppTemplateModal({
  connectionId,
  connections,
  contact,
  identity,
  onClose,
  onConnectionChange,
  onIdentityCreated,
  projectId,
}: {
  connectionId?: string;
  connections: CommunicationContact['connections'];
  contact: CommunicationContact;
  identity?: CommunicationIdentity;
  onClose: () => void;
  onConnectionChange: (value: string) => void;
  onIdentityCreated: () => void;
  projectId: string;
}) {
  const { message } = AntApp.useApp();
  const templates = useCommunicationTemplates(projectId, contact.id, connectionId);
  const media = useCommunicationMedia(projectId);
  const actions = useCommunicationActions(projectId, contact.id);
  const [templateId, setTemplateId] = useState<string>();
  const [values, setValues] = useState<Record<string, string>>({});
  const selected = templates.data?.find((template) => template.id === templateId);
  const slots = whatsAppParameterSlots(selected);
  const missing = slots.some((slot) => !values[slot.key]?.trim());
  const issue = selected ? whatsAppTemplateComposerIssue(selected) : undefined;
  const send = async () => {
    if (!selected || !connectionId || missing || issue) return;
    try {
      const components = whatsAppTemplateComponents(slots, values);
      await actions.send.mutateAsync({
        channel: 'WHATSAPP',
        clientRequestId: crypto.randomUUID(),
        connectionId,
        ...(identity ? { identityId: identity.id } : {}),
        template: {
          languageCode: selected.languageCode,
          name: selected.name,
          ...(components ? { components } : {}),
        },
      });
      onIdentityCreated();
      onClose();
      void message.success('Approved Meta template queued.');
    } catch (error) {
      void message.error(getUserErrorMessage(error, 'Meta template could not be sent.'));
    }
  };
  return (
    <Modal
      open
      centered
      width={720}
      title="Send an approved Meta WhatsApp template"
      okText="Send Meta template"
      confirmLoading={actions.send.isPending}
      okButtonProps={{ disabled: !selected || missing || Boolean(issue) }}
      onCancel={onClose}
      onOk={() => void send()}
    >
      <div className="communications-template-modal">
        <Alert
          type="info"
          showIcon
          title="Start or reopen a WhatsApp conversation"
          description="This list contains official templates approved for the selected WhatsApp Business account. Meta may charge the connected business account under its current rates."
        />
        <label>
          <span>WhatsApp Business number</span>
          <Select
            disabled={Boolean(identity)}
            value={connectionId ?? null}
            options={connections.map((connection) => ({
              label: connection.name,
              value: connection.id,
            }))}
            onChange={(value) => {
              onConnectionChange(value);
              setTemplateId(undefined);
              setValues({});
            }}
          />
        </label>
        {templates.isError ? (
          <Alert
            type="error"
            title="Approved Meta templates could not be loaded"
            action={<Button onClick={() => void templates.refetch()}>Retry</Button>}
          />
        ) : (
          <label>
            <span>Approved Meta template</span>
            <Select
              showSearch
              optionFilterProp="label"
              loading={templates.isLoading}
              placeholder="Choose an approved Meta template"
              value={templateId ?? null}
              onChange={(value) => {
                setTemplateId(value);
                setValues({});
              }}
              options={(templates.data ?? []).map((template) => {
                const templateIssue = whatsAppTemplateComposerIssue(template);
                return {
                  disabled: !template.sendable || Boolean(templateIssue),
                  label: `${template.name} · ${template.languageCode} · ${templateIssue ?? template.category.toLowerCase()}`,
                  value: template.id,
                };
              })}
            />
          </label>
        )}
        {selected ? <TemplatePreview template={selected} /> : null}
        {slots.map((slot) => (
          <label key={slot.key}>
            <span>{slot.label}</span>
            {slot.kind === 'media' ? (
              <div className="communications-template-media-field">
                <Select
                  placeholder={`Choose a ${slot.mediaType}`}
                  value={values[slot.key] ?? null}
                  onChange={(value: string) =>
                    setValues((current) => ({ ...current, [slot.key]: value }))
                  }
                  options={(media.data ?? [])
                    .filter(
                      (asset) =>
                        asset.status === 'AVAILABLE' &&
                        asset.validationChannel === 'whatsapp' &&
                        asset.kind === assetKindForWhatsAppSlot(slot),
                    )
                    .map((asset) => ({
                      label: asset.originalFilename ?? asset.id,
                      value: asset.id,
                    }))}
                />
                <Upload
                  accept={
                    slot.mediaType === 'image'
                      ? 'image/jpeg,image/png'
                      : slot.mediaType === 'video'
                        ? 'video/mp4,video/3gpp'
                        : '.pdf,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx'
                  }
                  beforeUpload={async (file) => {
                    const kind = assetKindForWhatsAppSlot(slot) as MediaKind;
                    try {
                      const asset = await actions.upload.mutateAsync({
                        channel: 'WHATSAPP',
                        file,
                        kind,
                      });
                      setValues((current) => ({ ...current, [slot.key]: asset.id }));
                      void message.success('Template header file uploaded.');
                    } catch (error) {
                      void message.error(
                        getUserErrorMessage(error, 'Template header file could not be uploaded.'),
                      );
                    }
                    return false;
                  }}
                  disabled={actions.upload.isPending}
                  showUploadList={false}
                >
                  <Button icon={<PaperClipOutlined />} loading={actions.upload.isPending}>
                    Upload
                  </Button>
                </Upload>
              </div>
            ) : (
              <Input
                value={values[slot.key]}
                placeholder={
                  slot.kind === 'url'
                    ? 'Dynamic URL value'
                    : slot.kind === 'quick_reply'
                      ? 'Reply payload'
                      : 'Approved template variable value'
                }
                onChange={(event) =>
                  setValues((current) => ({ ...current, [slot.key]: event.target.value }))
                }
              />
            )}
          </label>
        ))}
      </div>
    </Modal>
  );
}

function TemplatePreview({ template }: { template: CommunicationTemplate }) {
  return (
    <div className="communications-template-preview">
      <span>
        <strong>{template.name}</strong>
        <Tag color="green">Approved</Tag>
      </span>
      <small>
        {template.languageCode} · {template.category.toLowerCase()}
      </small>
      {template.components.map((component, index) =>
        component.text ? <p key={`${component.type}-${index}`}>{component.text}</p> : null,
      )}
    </div>
  );
}

function ContactEmailPanel({
  contact,
  projectId,
}: {
  contact: CommunicationContact;
  projectId: string;
}) {
  const access = useProjectAccess(projectId);
  const canRead = hasProjectPermission(access.data, 'email:read');
  const canSend = hasProjectPermission(access.data, 'email:send');
  const canReadMedia = hasProjectPermission(access.data, 'media:read');
  const canUploadMedia = canReadMedia && hasProjectPermission(access.data, 'media:manage');
  const mailboxes = useMailboxes(projectId, canRead);
  const threads = useInboxQuery<{ items: MailThread[]; total: number; pageSize: number }>(
    projectId,
    `threads?folder=all&page=1&contactId=${contact.id}`,
    canRead,
    true,
  );
  const [threadId, setThreadId] = useState<string>();
  const [compose, setCompose] = useState<ComposeInitial | null>(null);
  const activeThreadId = threadId ?? threads.data?.items[0]?.id;

  if (!canRead)
    return (
      <div className="communications-empty communications-empty--compact">
        <MailOutlined />
        <Typography.Text type="secondary">
          Email access is not included in your project role.
        </Typography.Text>
      </div>
    );

  return (
    <div className="communications-email">
      <aside className="communications-email-threads">
        <div className="communications-email-actions">
          <Button
            type="primary"
            block
            disabled={
              !canSend || !contact.email || !mailboxes.data?.some((item) => item.sendingReady)
            }
            icon={<MailOutlined />}
            onClick={() => {
              if (contact.email) setCompose({ to: contact.email });
            }}
          >
            New email
          </Button>
          <Link to={`/projects/${projectId}/email-inbox?folder=all&contactId=${contact.id}`}>
            Open full inbox
          </Link>
        </div>
        {threads.isLoading ? (
          <div className="communications-state">
            <Spin size="small" />
          </div>
        ) : threads.data?.items.length ? (
          threads.data.items.map((thread) => (
            <button
              className={`communications-email-thread${activeThreadId === thread.id ? ' is-selected' : ''}`}
              key={thread.id}
              type="button"
              onClick={() => setThreadId(thread.id)}
            >
              <span>
                <strong>{thread.subject || '(No subject)'}</strong>
                <time>{shortDate(thread.lastMessageAt)}</time>
              </span>
              <small>{thread.preview}</small>
            </button>
          ))
        ) : (
          <Empty description="No email conversations" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </aside>
      <ContactEmailConversation
        canSend={canSend}
        projectId={projectId}
        {...(activeThreadId ? { threadId: activeThreadId } : {})}
        onReply={setCompose}
      />
      {compose ? (
        <EmailCompose
          projectId={projectId}
          mailboxes={mailboxes.data ?? []}
          initial={compose}
          canReadMedia={canReadMedia}
          canUploadMedia={canUploadMedia}
          onClose={() => setCompose(null)}
          onSent={(id) => {
            setCompose(null);
            setThreadId(id);
          }}
        />
      ) : null}
    </div>
  );
}

function ContactEmailConversation({
  canSend,
  onReply,
  projectId,
  threadId,
}: {
  canSend: boolean;
  onReply: (value: ComposeInitial) => void;
  projectId: string;
  threadId?: string;
}) {
  const detail = useInboxQuery<MailThreadDetail>(
    projectId,
    `threads/${threadId}`,
    Boolean(threadId),
    Boolean(threadId),
  );
  const actions = useInboxActions(projectId);
  const lastId = detail.data?.messages.at(-1)?.id;
  useEffect(() => {
    if (threadId && lastId)
      void actions
        .request(`threads/${threadId}/state`, 'PATCH', { read: true })
        .catch(() => undefined);
  }, [lastId, threadId]);
  if (!threadId)
    return (
      <div className="communications-empty communications-empty--compact">
        <MailOutlined />
        <Typography.Text type="secondary">
          Choose an email conversation or compose a new one.
        </Typography.Text>
      </div>
    );
  if (detail.isLoading)
    return (
      <div className="communications-state">
        <Spin />
      </div>
    );
  if (detail.isError || !detail.data)
    return <Alert type="error" title="Email conversation could not be loaded" />;
  const thread = detail.data;
  const reply = (email?: MailMessage) =>
    onReply({
      mailboxId: thread.mailboxId,
      threadId: thread.id,
      to: thread.peerEmail,
      subject: thread.subject.toLowerCase().startsWith('re:')
        ? thread.subject
        : `Re: ${thread.subject}`,
      ...(email ? { replyToMessageId: email.id } : {}),
    });
  return (
    <main className="communications-email-reader">
      <header>
        <strong>{thread.subject || '(No subject)'}</strong>
        <small>{thread.peerEmail}</small>
      </header>
      <div className="communications-email-message-list">
        {thread.messages.map((email) => (
          <article className={email.direction === 'OUTBOUND' ? 'is-outbound' : ''} key={email.id}>
            <span>
              <strong>
                {email.direction === 'OUTBOUND' ? email.fromAddress : email.fromAddress}
              </strong>
              <time>{new Date(email.occurredAt).toLocaleString()}</time>
            </span>
            <p>{email.textBody || '(No text content)'}</p>
            {email.attachments.length ? (
              <small>{email.attachments.length} attachment(s)</small>
            ) : null}
            {canSend ? (
              <Button type="link" size="small" onClick={() => reply(email)}>
                Reply
              </Button>
            ) : null}
          </article>
        ))}
      </div>
      {canSend ? (
        <Button
          className="communications-email-reply"
          icon={<SendOutlined />}
          onClick={() => reply(thread.messages.at(-1))}
        >
          Reply by email
        </Button>
      ) : null}
    </main>
  );
}

function mediaKind(file: File): MediaKind {
  if (file.type.startsWith('image/')) return 'PHOTO';
  if (file.type.startsWith('video/')) return 'VIDEO';
  if (file.type.startsWith('audio/')) return 'AUDIO';
  return 'DOCUMENT';
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

import {
  ApiOutlined,
  CheckCircleOutlined,
  CloudServerOutlined,
  DeleteOutlined,
  KeyOutlined,
  LockOutlined,
  MessageOutlined,
  SafetyCertificateOutlined,
  SendOutlined,
  SettingOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Divider,
  Form,
  Input,
  Modal,
  Select,
  Spin,
  Switch,
  Table,
  Typography,
  message,
} from 'antd';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';

import { getUserErrorMessage } from '../api';
import { WhatsAppChannelCenter } from '../whatsapp-channel-center';
import {
  channelAccountLabel,
  channelProviderCopy,
  channelProviderLabel,
  isWhatsAppChannel,
  providerPipelineCopy,
  whatsappMissingConfiguration,
} from '../channel-provider';
import {
  type ChannelInboundEvent,
  type ChannelOutboundEvent,
  type WhatsAppChannel,
  useChannel,
  useChannelIdentities,
  useChannelInboundEvents,
  useChannelMutations,
  useChannelOutboundEvents,
  useWhatsAppSetup,
} from '../channels-api';
import { hasProjectPermission, useProjectAccess } from '../project-access';
import { StatusText } from '../status-text';
import {
  launchWhatsAppEmbeddedSignup,
  preloadWhatsAppEmbeddedSignup,
  type WhatsAppEmbeddedSignupResult,
} from '../whatsapp-embedded-signup';
import {
  TechnicalRecordDrawer,
  type TechnicalRecordSection,
  type TechnicalRecordTopField,
} from '../technical-record-drawer';

type WhatsAppSettingsValues = {
  accessToken?: string;
  businessAccountId?: string;
  graphApiVersion?: string;
  phoneNumberId?: string;
};

function idempotencyKey() {
  return crypto.randomUUID();
}

function cleanOptional(value?: string) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function WhatsAppSetupModal({
  channel,
  completeEmbedded,
  completingEmbedded,
  connect,
  connecting,
  onClose,
  onOpenSettings,
  open,
  projectId,
}: {
  channel: WhatsAppChannel;
  completeEmbedded: (result: WhatsAppEmbeddedSignupResult & { pin: string }) => Promise<void>;
  completingEmbedded: boolean;
  connect: () => Promise<void>;
  connecting: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  open: boolean;
  projectId: string | undefined;
}) {
  const setup = useWhatsAppSetup(projectId, open);
  const [pinForm] = Form.useForm<{ twoStepPin: string }>();
  const [embeddedSdkReady, setEmbeddedSdkReady] = useState(false);
  const [embeddedSdkError, setEmbeddedSdkError] = useState<string>();
  const [embeddedSdkAttempt, setEmbeddedSdkAttempt] = useState(0);
  const [embeddedWindowOpen, setEmbeddedWindowOpen] = useState(false);
  const missing = whatsappMissingConfiguration(channel);
  const ready = channel.setupReady;
  const embeddedConfigured = Boolean(
    setup.data?.configured &&
    setup.data.appId &&
    setup.data.configurationId &&
    setup.data.graphApiVersion,
  );

  useEffect(() => {
    if (!open || !embeddedConfigured || !setup.data?.appId || !setup.data.graphApiVersion) {
      setEmbeddedSdkReady(false);
      setEmbeddedSdkError(undefined);
      return;
    }
    let active = true;
    setEmbeddedSdkError(undefined);
    void preloadWhatsAppEmbeddedSignup({
      appId: setup.data.appId,
      graphApiVersion: setup.data.graphApiVersion,
    })
      .then(() => {
        if (active) setEmbeddedSdkReady(true);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setEmbeddedSdkReady(false);
        setEmbeddedSdkError(
          error instanceof Error ? error.message : 'Meta setup could not be loaded.',
        );
      });
    return () => {
      active = false;
    };
  }, [
    embeddedConfigured,
    embeddedSdkAttempt,
    open,
    setup.data?.appId,
    setup.data?.graphApiVersion,
  ]);

  const startEmbeddedSignup = async () => {
    if (!setup.data?.appId || !setup.data.configurationId || !setup.data.graphApiVersion) return;
    try {
      const { twoStepPin } = await pinForm.validateFields();
      setEmbeddedWindowOpen(true);
      const result = await launchWhatsAppEmbeddedSignup({
        appId: setup.data.appId,
        configurationId: setup.data.configurationId,
        graphApiVersion: setup.data.graphApiVersion,
      });
      await completeEmbedded({ ...result, pin: twoStepPin.trim() });
      pinForm.resetFields();
      onClose();
    } catch (error) {
      void message.error(getUserErrorMessage(error, 'WhatsApp setup could not be completed.'));
    } finally {
      setEmbeddedWindowOpen(false);
    }
  };

  const pending = completingEmbedded || embeddedWindowOpen;

  return (
    <Modal
      centered
      className="whatsapp-setup-modal"
      closable={!pending}
      footer={
        ready
          ? [
              <Button key="cancel" onClick={onClose}>
                Not now
              </Button>,
              <Button
                icon={<MessageOutlined />}
                key="connect"
                disabled={connecting}
                loading={connecting}
                onClick={() => void connect()}
                type="primary"
              >
                Connect WhatsApp
              </Button>,
            ]
          : embeddedConfigured
            ? [
                <Button disabled={pending} key="close" onClick={onClose}>
                  Not now
                </Button>,
                <Button disabled={pending} key="settings" onClick={onOpenSettings}>
                  Enter credentials manually
                </Button>,
                <Button
                  disabled={!embeddedSdkReady || pending}
                  icon={<MessageOutlined />}
                  key="embedded"
                  loading={pending || (!embeddedSdkReady && !embeddedSdkError)}
                  onClick={() => void startEmbeddedSignup()}
                  type="primary"
                >
                  Continue with Meta
                </Button>,
              ]
            : [
                <Button key="close" onClick={onClose}>
                  Close
                </Button>,
                <Button
                  icon={<SettingOutlined />}
                  key="settings"
                  onClick={onOpenSettings}
                  type="primary"
                >
                  Open channel settings
                </Button>,
              ]
      }
      keyboard={!pending}
      maskClosable={!pending}
      onCancel={() => {
        if (!pending) {
          onClose();
        }
      }}
      open={open}
      title="Connect WhatsApp Business"
      width={680}
    >
      <div className="whatsapp-modal-heading">
        <div className="channel-provider-mark channel-provider-mark--whatsapp">
          <MessageOutlined />
        </div>
        <div>
          <Typography.Title level={4}>Official Meta Cloud API</Typography.Title>
          <Typography.Text type="secondary">
            Omnicus will validate the business phone and subscribe its WhatsApp Business Account
            before activating this channel.
          </Typography.Text>
        </div>
      </div>

      {setup.isLoading ? (
        <div className="whatsapp-setup-loading">
          <Spin /> Checking Meta setup…
        </div>
      ) : setup.isError ? (
        <Alert
          description={getUserErrorMessage(
            setup.error,
            'WhatsApp setup status could not be loaded.',
          )}
          message="Setup status unavailable"
          showIcon
          type="error"
        />
      ) : ready ? (
        <Alert
          className="channel-soft-notice"
          description="The required server configuration, business account, phone number and access token are available. Continue to validate the account and connect the webhook."
          icon={<CheckCircleOutlined />}
          message="Ready to connect"
          showIcon
          type="success"
        />
      ) : embeddedConfigured ? (
        <Alert
          className="channel-soft-notice"
          description="Choose the business and phone in Meta's official window. Omnicus will validate the result, register this number and activate this existing draft without creating a duplicate connection."
          icon={<CheckCircleOutlined />}
          message="Ready for Meta signup"
          showIcon
          type="success"
        />
      ) : (
        <Alert
          className="channel-soft-notice"
          description="Complete the items below, save the channel settings and return here. No connection will be claimed until Meta validates it."
          icon={<WarningOutlined />}
          message="Meta configuration required"
          showIcon
          type="warning"
        />
      )}

      {!setup.isLoading && !ready && !embeddedConfigured ? (
        <div className="whatsapp-requirements">
          <Typography.Text strong>Still needed</Typography.Text>
          {missing.length ? (
            <ul>
              {missing.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <Typography.Paragraph type="secondary">
              Save the WhatsApp account identifiers and refresh this setup check.
            </Typography.Paragraph>
          )}
        </div>
      ) : null}

      {!ready && embeddedConfigured ? (
        <>
          <Form form={pinForm} layout="vertical" requiredMark={false}>
            <Form.Item
              extra="Used once to register and protect this business number. The PIN is never stored or displayed after setup."
              label="6-digit two-step verification PIN"
              name="twoStepPin"
              rules={[
                {
                  message: 'Enter the 6-digit PIN that will protect this WhatsApp number',
                  pattern: /^\d{6}$/,
                  required: true,
                },
              ]}
            >
              <Input.Password
                autoComplete="new-password"
                disabled={pending}
                inputMode="numeric"
                maxLength={6}
                pattern="[0-9]*"
                placeholder="••••••"
              />
            </Form.Item>
          </Form>
          {embeddedSdkError ? (
            <Alert
              action={
                <Button
                  onClick={() => setEmbeddedSdkAttempt((attempt) => attempt + 1)}
                  size="small"
                >
                  Retry
                </Button>
              }
              className="form-alert"
              description="No Meta authorization or account change has been submitted."
              message={embeddedSdkError}
              showIcon
              type="error"
            />
          ) : null}
          <Divider plain>or use existing credentials</Divider>
        </>
      ) : null}

      <div className="whatsapp-setup-boundary">
        <LockOutlined />
        <div>
          <strong>Secrets stay outside the browser</strong>
          <span>
            The Meta app secret and webhook verification token are configured on the server. The
            official signup returns only a short-lived authorization result; manual setup encrypts
            the phone-specific access token immediately after saving.
          </span>
        </div>
      </div>

      {setup.data ? (
        <Descriptions
          className="whatsapp-setup-facts"
          column={1}
          items={[
            {
              children: setup.data.configured ? 'Available' : 'Not configured',
              key: 'meta-app',
              label: 'Embedded Signup',
            },
            {
              children: setup.data.graphApiVersion ?? 'Not configured',
              key: 'graph-version',
              label: 'Graph API version',
            },
            {
              children: setup.data.callbackUrl,
              key: 'callback',
              label: 'Webhook callback',
            },
            {
              children:
                setup.data.appId && setup.data.configurationId
                  ? 'Embedded Signup configuration detected'
                  : 'Manual official setup',
              key: 'onboarding',
              label: 'Onboarding mode',
            },
          ]}
          size="small"
        />
      ) : null}
    </Modal>
  );
}

export function ChannelDetailPage() {
  const { projectId, connectionId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const channel = useChannel(projectId, connectionId);
  const inbound = useChannelInboundEvents(projectId, connectionId);
  const outbound = useChannelOutboundEvents(projectId, connectionId);
  const mutations = useChannelMutations(projectId);
  const [telegramTokenForm] = Form.useForm<{ botToken: string }>();
  const [whatsappSettingsForm] = Form.useForm<WhatsAppSettingsValues>();
  const access = useProjectAccess(projectId);
  const canManage = hasProjectPermission(access.data, 'channels:manage');
  const identities = useChannelIdentities(projectId, canManage ? connectionId : undefined);
  const [setupOpen, setSetupOpen] = useState(searchParams.get('setup') === '1');
  const [rotatingOpen, setRotatingOpen] = useState(false);
  const [disablingOpen, setDisablingOpen] = useState(false);
  const [selectedInboundEvent, setSelectedInboundEvent] = useState<{
    event: ChannelInboundEvent;
    top: TechnicalRecordTopField[];
  } | null>(null);
  const [selectedOutboundEvent, setSelectedOutboundEvent] = useState<{
    event: ChannelOutboundEvent;
    top: TechnicalRecordTopField[];
  } | null>(null);
  const whatsappSettingsRef = useRef<HTMLDivElement | null>(null);
  const retryKey = useRef<string | undefined>(undefined);
  const pipelineNotificationState = useRef<{
    key: string;
    inbound: Map<string, string>;
    outbound: Map<string, string>;
  } | null>(null);

  useEffect(() => {
    if (searchParams.get('setup') === '1') setSetupOpen(true);
  }, [searchParams]);

  useEffect(() => {
    if (!projectId || !connectionId || !channel.data || !inbound.data || !outbound.data) return;
    const key = `${projectId}:${connectionId}`;
    const previous = pipelineNotificationState.current;
    const copy = providerPipelineCopy(channel.data.type);
    if (!previous || previous.key !== key) {
      pipelineNotificationState.current = {
        key,
        inbound: new Map(
          inbound.data.map((event) => [
            `${event.externalUpdateId}:${event.receivedAt}`,
            event.inboxRecord?.status ?? event.status,
          ]),
        ),
        outbound: new Map(outbound.data.map((event) => [event.id, event.status])),
      };
      return;
    }

    for (const event of outbound.data) {
      const priorStatus = previous.outbound.get(event.id);
      if (priorStatus !== event.status) {
        if (event.status === 'FAILED') {
          void message.error(
            event.lastError
              ? `${copy.outboundFailure}: ${event.lastError}`
              : `${copy.outboundFailure}. Open the outbound pipeline for safe diagnostics.`,
          );
        } else if (event.status === 'UNKNOWN') {
          void message.warning(copy.unknown);
        }
      }
      previous.outbound.set(event.id, event.status);
    }

    for (const event of inbound.data) {
      const eventKey = `${event.externalUpdateId}:${event.receivedAt}`;
      const status = event.inboxRecord?.status ?? event.status;
      const priorStatus = previous.inbound.get(eventKey);
      if (priorStatus !== status && ['FAILED', 'DEAD_LETTER'].includes(status)) {
        void message.error(
          event.inboxRecord?.lastError
            ? `${copy.inboundFailure}: ${event.inboxRecord.lastError}`
            : `${copy.inboundFailure}. Open the inbound pipeline for safe diagnostics.`,
        );
      }
      previous.inbound.set(eventKey, status);
    }
  }, [channel.data, connectionId, inbound.data, outbound.data, projectId]);

  const closePipelineEvent = () => {
    setSelectedInboundEvent(null);
    setSelectedOutboundEvent(null);
  };

  const openInboundEvent = (event: ChannelInboundEvent) => {
    setSelectedOutboundEvent(null);
    setSelectedInboundEvent({
      event,
      top: [
        { label: 'Received', value: new Date(event.receivedAt).toLocaleString() },
        { label: 'Event', value: event.inboxRecord?.normalizedEvent?.type ?? 'Not available' },
        {
          label: 'Status',
          value: <StatusText status={event.inboxRecord?.status ?? 'NOT_CREATED'} />,
        },
        { label: 'Contact', value: event.inboxRecord?.normalizedEvent?.message?.contactId ?? '—' },
      ],
    });
  };

  const openOutboundEvent = (event: ChannelOutboundEvent) => {
    setSelectedInboundEvent(null);
    setSelectedOutboundEvent({
      event,
      top: [
        { label: 'Created', value: new Date(event.createdAt).toLocaleString() },
        { label: 'Event', value: event.message?.status ?? 'Not available' },
        { label: 'Status', value: <StatusText status={event.status} /> },
      ],
    });
  };

  const activatePipelineRow = (callback: () => void) => (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      callback();
    }
  };

  const inboundPipelineSections = (event: ChannelInboundEvent): TechnicalRecordSection[] => {
    const normalizedType = event.inboxRecord?.normalizedEvent?.type ?? 'Not available';
    const contactId = event.inboxRecord?.normalizedEvent?.message?.contactId;
    const normalizedEvent = event.inboxRecord?.normalizedEvent;
    const safeError = event.inboxRecord?.lastError;

    return [
      {
        title: 'Processing',
        fields: [
          {
            label: 'Inbox status',
            value: <StatusText status={event.inboxRecord?.status ?? 'NOT_CREATED'} />,
            copy: false,
          },
          {
            label: 'Attempts',
            value:
              event.inboxRecord && event.inboxRecord.maxAttempts
                ? `${event.inboxRecord.attempts}/${event.inboxRecord.maxAttempts}`
                : '—',
          },
          { label: 'Normalized event', value: normalizedType },
          { label: 'Contact', value: contactId ?? '—' },
          { label: 'Safe error', value: safeError ?? 'No safe error' },
        ],
      },
      {
        title: 'Identifiers',
        fields: [
          { label: 'Provider update ID', value: event.externalUpdateId },
          { label: 'Correlation ID', value: event.correlationId },
          { label: 'Contact ID', value: contactId ?? '—' },
          { label: 'Connection ID', value: connection?.id ?? '—' },
          { label: 'Operation ID', value: event.externalUpdateId },
        ],
      },
      {
        title: 'Additional details',
        fields: normalizedEvent
          ? [{ label: 'Normalized event details', value: normalizedEvent }]
          : [],
      },
    ];
  };

  const outboundPipelineSections = (event: ChannelOutboundEvent): TechnicalRecordSection[] => [
    {
      title: 'Processing',
      fields: [
        {
          label: 'Outbox status',
          value: <StatusText status={event.status} />,
          copy: false,
        },
        {
          label: 'Attempts',
          value: event.maxAttempts ? `${event.attempts}/${event.maxAttempts}` : '—',
        },
        { label: 'Safe error', value: event.lastError ?? 'No safe error' },
      ],
    },
    {
      title: 'Identifiers',
      fields: [
        { label: 'Message ID', value: event.message?.externalMessageId ?? '—' },
        { label: 'Connection ID', value: connection?.id ?? '—' },
        { label: 'Outbox record ID', value: event.id },
      ],
    },
    {
      title: 'Additional details',
      fields: [{ label: 'Message', value: event.message }],
    },
  ];

  if (channel.isLoading) return <Spin className="route-loading" />;
  if (channel.isError || !channel.data) {
    return (
      <Alert
        message={getUserErrorMessage(channel.error, 'Channel connection could not be loaded.')}
        showIcon
        type="error"
      />
    );
  }

  const connection = channel.data;
  const provider = channelProviderCopy[connection.type];
  const pipelineCopy = providerPipelineCopy(connection.type);
  const canRotateSecrets = hasProjectPermission(access.data, 'channels:rotate_secrets');
  const action = async (
    operation: () => Promise<unknown>,
    successMessage: string,
    fallback = `The ${provider.channelLabel} action could not be completed.`,
  ) => {
    try {
      await operation();
      void message.success(successMessage);
      return true;
    } catch (error) {
      void message.error(getUserErrorMessage(error, fallback));
      return false;
    }
  };

  const closeSetup = () => {
    setSetupOpen(false);
    const next = new URLSearchParams(searchParams);
    next.delete('setup');
    setSearchParams(next, { replace: true });
  };

  const connectWhatsApp = async () => {
    const connected = await action(
      () => mutations.connect.mutateAsync(connection.id),
      'WhatsApp Business connected.',
      'WhatsApp could not be connected.',
    );
    if (connected) closeSetup();
  };

  const accountFacts =
    connection.type === 'TELEGRAM'
      ? [
          {
            children: connection.botUsername ? `@${connection.botUsername}` : '—',
            key: 'bot',
            label: 'Bot',
          },
          {
            children: connection.externalBotId ?? '—',
            key: 'external-id',
            label: 'Telegram bot ID',
          },
          { children: connection.maskedToken ?? '—', key: 'token', label: 'Bot token' },
        ]
      : [
          {
            children: connection.displayPhoneNumber ?? '—',
            key: 'phone',
            label: 'Business phone',
          },
          {
            children: connection.verifiedName ?? '—',
            key: 'verified-name',
            label: 'Verified business name',
          },
          {
            children: connection.businessAccountId ?? '—',
            key: 'business-account',
            label: 'Business Account ID',
          },
          {
            children: connection.phoneNumberId ?? '—',
            key: 'phone-number-id',
            label: 'Phone Number ID',
          },
          {
            children: connection.maskedToken ?? 'Not saved',
            key: 'token',
            label: 'Access token',
          },
          {
            children: connection.graphApiVersion ?? 'Not configured',
            key: 'graph-version',
            label: 'Graph API version',
          },
        ];

  const inboundOperationsLink = `/projects/${projectId}/operations?${new URLSearchParams({
    connectionId: connection.id,
    source: 'INBOX',
  }).toString()}`;
  const outboundOperationsLink = `/projects/${projectId}/operations?${new URLSearchParams({
    connectionId: connection.id,
    source: 'OUTBOX',
  }).toString()}`;

  return (
    <section>
      <div className="entity-hero channel-entity-hero">
        <div className="entity-hero-copy channel-hero-copy">
          <div
            className={`channel-provider-mark channel-provider-mark--${connection.type.toLowerCase()}`}
          >
            {connection.type === 'WHATSAPP' ? <MessageOutlined /> : <ApiOutlined />}
          </div>
          <div>
            <Typography.Title level={2}>{connection.name}</Typography.Title>
            <Typography.Text type="secondary">{channelAccountLabel(connection)}</Typography.Text>
          </div>
        </div>
      </div>

      {isWhatsAppChannel(connection) && !connection.setupReady ? (
        <div className="channel-readiness-banner">
          <div className="channel-readiness-icon">
            <SettingOutlined />
          </div>
          <div>
            <strong>Finish WhatsApp setup</strong>
            <span>
              This draft is safe to keep, but it cannot receive or send messages until the Meta app
              and business phone settings are complete.
            </span>
          </div>
          {canManage ? (
            <Button onClick={() => setSetupOpen(true)} type="primary">
              Continue setup
            </Button>
          ) : null}
        </div>
      ) : null}

      <Card className="channel-overview-card" title="Connection overview">
        <Descriptions
          column={{ lg: 3, md: 2, xs: 1 }}
          items={[
            { children: channelProviderLabel(connection.type), key: 'type', label: 'Provider' },
            {
              children: <StatusText status={connection.status} />,
              key: 'status',
              label: 'Status',
            },
            ...accountFacts,
            {
              children: <StatusText status={connection.webhookStatus} />,
              key: 'webhook',
              label: 'Webhook',
            },
            {
              children: connection.lastWebhookAt
                ? new Date(connection.lastWebhookAt).toLocaleString()
                : '—',
              key: 'last-webhook',
              label: 'Last webhook',
            },
            {
              children: connection.lastErrorAt
                ? new Date(connection.lastErrorAt).toLocaleString()
                : '—',
              key: 'last-error',
              label: 'Last error',
            },
            {
              children: new Date(connection.updatedAt).toLocaleString(),
              key: 'updated',
              label: 'Updated',
            },
          ]}
          size="small"
        />
      </Card>

      <Card className="channel-behavior-card" title={`How ${provider.channelLabel} works here`}>
        <div className="channel-behavior-grid">
          {connection.type === 'WHATSAPP' ? (
            <>
              <div className="channel-behavior-item">
                <CloudServerOutlined />
                <div>
                  <strong>Official business connection</strong>
                  <span>Messages use Meta Cloud API and the registered business phone.</span>
                </div>
              </div>
              <div className="channel-behavior-item">
                <CheckCircleOutlined />
                <div>
                  <strong>Delivery and read updates</strong>
                  <span>
                    Sent, delivered, read and failed states appear when Meta reports them.
                  </span>
                </div>
              </div>
              <div className="channel-behavior-item">
                <SafetyCertificateOutlined />
                <div>
                  <strong>Customer service window</strong>
                  <span>
                    Free-form replies require an open conversation window; approved templates are
                    used outside it.
                  </span>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="channel-behavior-item">
                <ApiOutlined />
                <div>
                  <strong>Bot-based messaging</strong>
                  <span>The bot token identifies this channel and stays encrypted.</span>
                </div>
              </div>
              <div className="channel-behavior-item">
                <MessageOutlined />
                <div>
                  <strong>Telegram-native controls</strong>
                  <span>
                    Silent messages, reply keyboards and Telegram rich options stay available.
                  </span>
                </div>
              </div>
              <div className="channel-behavior-item">
                <SafetyCertificateOutlined />
                <div>
                  <strong>Webhook delivery</strong>
                  <span>
                    Incoming updates are acknowledged before background processing begins.
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      </Card>

      {connection.type === 'WHATSAPP' ? (
        <WhatsAppChannelCenter
          key={connection.id}
          projectId={projectId}
          channel={connection}
          canManage={canManage}
          onSetup={() => setSetupOpen(true)}
          onOpenSettings={() =>
            whatsappSettingsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        />
      ) : null}

      {canManage ? (
        <div className="channel-management-grid">
          <div className="channel-management-stack">
            {connection.type === 'TELEGRAM' ? (
              <Card title="Replace bot token">
                <Typography.Paragraph type="secondary">
                  The full token is validated, encrypted and never shown again.
                </Typography.Paragraph>
                <Form
                  form={telegramTokenForm}
                  layout="vertical"
                  onFinish={async (values: { botToken: string }) => {
                    const saved = await action(
                      () =>
                        mutations.update.mutateAsync({
                          botToken: values.botToken,
                          id: connection.id,
                          type: 'TELEGRAM',
                        }),
                      'Bot token replaced.',
                    );
                    if (saved) telegramTokenForm.resetFields(['botToken']);
                    mutations.update.reset();
                  }}
                >
                  <Form.Item label="New bot token" name="botToken" rules={[{ required: true }]}>
                    <Input.Password autoComplete="new-password" />
                  </Form.Item>
                  <Button block htmlType="submit">
                    Replace token
                  </Button>
                </Form>
              </Card>
            ) : (
              <Card ref={whatsappSettingsRef} title="WhatsApp account settings">
                <Typography.Paragraph type="secondary">
                  IDs remain visible for verification. A new access token is encrypted and never
                  displayed again.
                </Typography.Paragraph>
                <Form<WhatsAppSettingsValues>
                  form={whatsappSettingsForm}
                  initialValues={{
                    businessAccountId: connection.businessAccountId ?? undefined,
                    graphApiVersion: connection.graphApiVersion ?? undefined,
                    phoneNumberId: connection.phoneNumberId ?? undefined,
                  }}
                  layout="vertical"
                  onFinish={async (values) => {
                    const saved = await action(
                      () =>
                        mutations.update.mutateAsync({
                          id: connection.id,
                          type: 'WHATSAPP',
                          ...(cleanOptional(values.accessToken)
                            ? { accessToken: cleanOptional(values.accessToken)! }
                            : {}),
                          ...(cleanOptional(values.businessAccountId)
                            ? { businessAccountId: cleanOptional(values.businessAccountId)! }
                            : {}),
                          ...(cleanOptional(values.graphApiVersion)
                            ? { graphApiVersion: cleanOptional(values.graphApiVersion)! }
                            : {}),
                          ...(cleanOptional(values.phoneNumberId)
                            ? { phoneNumberId: cleanOptional(values.phoneNumberId)! }
                            : {}),
                        }),
                      'WhatsApp settings saved.',
                      'WhatsApp settings could not be saved.',
                    );
                    if (saved) whatsappSettingsForm.setFieldValue('accessToken', '');
                    mutations.update.reset();
                  }}
                  requiredMark={false}
                >
                  <div className="whatsapp-field-grid whatsapp-field-grid--detail">
                    <Form.Item
                      label="WhatsApp Business Account ID"
                      name="businessAccountId"
                      rules={[{ message: 'Enter the Business Account ID', required: true }]}
                    >
                      <Input autoComplete="off" />
                    </Form.Item>
                    <Form.Item
                      label="Phone Number ID"
                      name="phoneNumberId"
                      rules={[{ message: 'Enter the Phone Number ID', required: true }]}
                    >
                      <Input autoComplete="off" />
                    </Form.Item>
                  </div>
                  <Form.Item
                    label="Graph API version"
                    name="graphApiVersion"
                    rules={[
                      { message: 'Enter the Graph API version', required: true },
                      {
                        message: "Use Meta's v<number>.<number> format",
                        pattern: /^v\d+\.\d+$/,
                      },
                    ]}
                  >
                    <Input autoComplete="off" placeholder="Version configured for this Meta app" />
                  </Form.Item>
                  <Form.Item
                    extra={
                      connection.maskedToken
                        ? `Current token: ${connection.maskedToken}. Leave empty to keep it.`
                        : 'Add the permanent access token for this business phone.'
                    }
                    label="New permanent access token"
                    name="accessToken"
                    rules={[
                      {
                        message: 'Add the access token before connecting',
                        required: !connection.maskedToken,
                      },
                      { message: 'The Meta access token is too short', min: 16 },
                    ]}
                  >
                    <Input.Password autoComplete="new-password" />
                  </Form.Item>
                  <Button block htmlType="submit" loading={mutations.update.isPending}>
                    Save Meta settings
                  </Button>
                </Form>
              </Card>
            )}

            <Card className="channel-actions-card" title="Connection actions">
              <div className="channel-actions">
                {connection.status !== 'ACTIVE' || connection.webhookStatus !== 'CONNECTED' ? (
                  <Button
                    block
                    className="channel-primary-action"
                    icon={connection.type === 'WHATSAPP' ? <MessageOutlined /> : <ApiOutlined />}
                    loading={mutations.connect.isPending}
                    onClick={() =>
                      connection.type === 'WHATSAPP'
                        ? setSetupOpen(true)
                        : void action(
                            () => mutations.connect.mutateAsync(connection.id),
                            'Webhook connected.',
                          )
                    }
                    type="primary"
                  >
                    {connection.type === 'WHATSAPP' ? 'Connect WhatsApp' : 'Connect webhook'}
                  </Button>
                ) : null}
                <Button
                  block
                  disabled={connection.type === 'WHATSAPP' && !connection.setupReady}
                  icon={<SafetyCertificateOutlined />}
                  loading={mutations.test.isPending}
                  onClick={() =>
                    void action(
                      () => mutations.test.mutateAsync(connection.id),
                      'Connection verified.',
                    )
                  }
                >
                  Test connection
                </Button>
                {canRotateSecrets && connection.type === 'TELEGRAM' ? (
                  <Button block icon={<KeyOutlined />} onClick={() => setRotatingOpen(true)}>
                    Rotate webhook secret
                  </Button>
                ) : null}
                <Button
                  block
                  className="channel-danger-action"
                  danger
                  disabled={connection.status === 'DISABLED'}
                  icon={<DeleteOutlined />}
                  loading={mutations.disable.isPending}
                  onClick={() => setDisablingOpen(true)}
                >
                  Disable channel
                </Button>
              </div>
            </Card>
          </div>

          <Card className="channel-test-message-card" title="Send test message">
            {connection.type === 'WHATSAPP' ? (
              <Alert
                className="channel-test-rule"
                description="Free-form text is accepted only for a contact with an open customer service window. Outside that window, use an approved WhatsApp template from the messaging workspace."
                message="WhatsApp delivery rule"
                showIcon
                type="info"
              />
            ) : null}
            <Form
              layout="vertical"
              onFinish={async (values) => {
                retryKey.current ??= idempotencyKey();
                const succeeded = await action(
                  () =>
                    mutations.send.mutateAsync({
                      id: connection.id,
                      ...values,
                      idempotencyKey: retryKey.current!,
                    }),
                  'Message queued for delivery.',
                  `${provider.channelLabel} test message could not be queued.`,
                );
                if (succeeded) retryKey.current = undefined;
              }}
            >
              <Form.Item
                label={provider.recipientLabel}
                name="channelIdentityId"
                rules={[{ message: `Select a ${provider.channelLabel} contact`, required: true }]}
              >
                <Select
                  allowClear
                  loading={identities.isLoading}
                  notFoundContent={
                    identities.isError
                      ? `${provider.channelLabel} contacts could not be loaded`
                      : `This channel has no ${provider.channelLabel} contacts yet`
                  }
                  optionFilterProp="label"
                  options={(identities.data ?? []).map((identity) => {
                    const providerIdentity =
                      connection.type === 'TELEGRAM' && identity.username
                        ? `@${identity.username}`
                        : (identity.displayName ?? identity.externalUserId);
                    return {
                      disabled: identity.status !== 'ACTIVE',
                      label: [
                        identity.contact.displayName,
                        providerIdentity,
                        identity.status === 'ACTIVE' ? null : `[${identity.status}]`,
                      ]
                        .filter(Boolean)
                        .join(' · '),
                      value: identity.id,
                    };
                  })}
                  placeholder="Choose a recipient"
                  showSearch
                />
              </Form.Item>
              <Form.Item label="Message" name="text" rules={[{ required: true }]}>
                <Input.TextArea autoSize={{ maxRows: 6, minRows: 3 }} />
              </Form.Item>
              {connection.type === 'TELEGRAM' ? (
                <Form.Item
                  label="Send without notification"
                  name="disableNotification"
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
              ) : null}
              <Button
                block
                disabled={connection.status !== 'ACTIVE'}
                htmlType="submit"
                icon={<SendOutlined />}
                loading={mutations.send.isPending}
                type="primary"
              >
                Queue test message
              </Button>
            </Form>
          </Card>
        </div>
      ) : null}

      <Modal
        className="account-confirm-modal"
        footer={null}
        onCancel={() => setRotatingOpen(false)}
        open={rotatingOpen}
        title="Rotate webhook secret?"
        width={460}
      >
        <Typography.Paragraph type="secondary">
          The previous webhook secret will stop working after rotation.
        </Typography.Paragraph>
        <div className="modal-form-actions">
          <Button onClick={() => setRotatingOpen(false)}>Cancel</Button>
          <Button
            danger
            loading={mutations.rotate.isPending}
            onClick={async () => {
              const succeeded = await action(
                () => mutations.rotate.mutateAsync(connection.id),
                'Webhook secret rotated.',
              );
              if (succeeded) setRotatingOpen(false);
            }}
          >
            Rotate webhook secret
          </Button>
        </div>
      </Modal>
      <Modal
        className="account-confirm-modal"
        footer={null}
        onCancel={() => setDisablingOpen(false)}
        open={disablingOpen}
        title={`Disable this ${provider.connectionNoun}?`}
        width={460}
      >
        <Typography.Paragraph type="secondary">
          {connection.type === 'WHATSAPP'
            ? 'Omnicus will stop processing this number. Existing contacts and message history remain available, and the shared Meta app webhook is not removed.'
            : 'Existing contacts and message history will not be deleted.'}
        </Typography.Paragraph>
        <div className="modal-form-actions">
          <Button onClick={() => setDisablingOpen(false)}>Cancel</Button>
          <Button
            danger
            loading={mutations.disable.isPending}
            onClick={async () => {
              const succeeded = await action(
                () => mutations.disable.mutateAsync(connection.id),
                `${provider.channelLabel} channel disabled.`,
              );
              if (succeeded) setDisablingOpen(false);
            }}
          >
            Disable channel
          </Button>
        </div>
      </Modal>

      <Card className="pipeline-card" title="Inbound pipeline">
        <Typography.Paragraph type="secondary">
          Safe processing diagnostics only. Provider payloads and channel secrets are never shown.
        </Typography.Paragraph>
        {inboundOperationsLink ? (
          <Typography.Paragraph type="secondary">
            Need older events?{' '}
            <Link to={inboundOperationsLink}>Open full inbound operation history</Link>.
          </Typography.Paragraph>
        ) : null}
        <Table<ChannelInboundEvent>
          columns={[
            {
              dataIndex: 'receivedAt',
              render: (value: string) => new Date(value).toLocaleString(),
              title: 'Received',
            },
            {
              render: (_, event) => event.inboxRecord?.normalizedEvent?.type ?? '—',
              title: 'Event',
            },
            {
              render: (_, event) => (
                <StatusText status={event.inboxRecord?.status ?? 'NOT_CREATED'} />
              ),
              title: 'Status',
            },
            {
              render: (_, event) => event.inboxRecord?.normalizedEvent?.message?.contactId ?? '—',
              title: 'Contact',
            },
            {
              render: (_, event) =>
                event.inboxRecord
                  ? `${event.inboxRecord.attempts}/${event.inboxRecord.maxAttempts}`
                  : '—',
              title: 'Attempts',
            },
          ]}
          dataSource={inbound.data ?? []}
          loading={inbound.isLoading}
          locale={{
            emptyText: inbound.isError
              ? 'Inbound diagnostics could not be loaded'
              : pipelineCopy.inboundEmpty,
          }}
          pagination={false}
          onRow={(row) => ({
            className: 'clickable-table-row',
            onClick: () => openInboundEvent(row),
            onKeyDown: activatePipelineRow(() => openInboundEvent(row)),
            tabIndex: 0,
          })}
          rowKey={(event) => `${event.externalUpdateId}-${event.receivedAt}`}
          scroll={{ x: 1100 }}
          size="small"
        />
      </Card>

      <Card className="pipeline-card" title="Outbound pipeline">
        <Typography.Paragraph type="secondary">
          Safe delivery diagnostics only. Message content and channel secrets are never shown.
        </Typography.Paragraph>
        {outboundOperationsLink ? (
          <Typography.Paragraph type="secondary">
            Need older events?{' '}
            <Link to={outboundOperationsLink}>Open full outbound operation history</Link>.
          </Typography.Paragraph>
        ) : null}
        <Table<ChannelOutboundEvent>
          columns={[
            {
              dataIndex: 'createdAt',
              render: (value: string) => new Date(value).toLocaleString(),
              title: 'Created',
            },
            {
              render: (_, event) => event.message?.status ?? '—',
              title: 'Event',
            },
            {
              render: (_, event) => <StatusText status={event.status} />,
              title: 'Status',
            },
            {
              render: (_, event) => `${event.attempts}/${event.maxAttempts}`,
              title: 'Attempts',
            },
          ]}
          dataSource={outbound.data ?? []}
          loading={outbound.isLoading}
          locale={{
            emptyText: outbound.isError
              ? 'Outbound diagnostics could not be loaded'
              : pipelineCopy.outboundEmpty,
          }}
          pagination={false}
          onRow={(row) => ({
            className: 'clickable-table-row',
            onClick: () => openOutboundEvent(row),
            onKeyDown: activatePipelineRow(() => openOutboundEvent(row)),
            tabIndex: 0,
          })}
          rowKey="id"
          scroll={{ x: 900 }}
          size="small"
        />
      </Card>

      <TechnicalRecordDrawer
        onClose={closePipelineEvent}
        open={Boolean(selectedInboundEvent)}
        sections={selectedInboundEvent ? inboundPipelineSections(selectedInboundEvent.event) : []}
        title="Inbound event details"
        top={selectedInboundEvent?.top ?? []}
      />
      <TechnicalRecordDrawer
        onClose={closePipelineEvent}
        open={Boolean(selectedOutboundEvent)}
        sections={
          selectedOutboundEvent ? outboundPipelineSections(selectedOutboundEvent.event) : []
        }
        title="Outbound event details"
        top={selectedOutboundEvent?.top ?? []}
      />

      {isWhatsAppChannel(connection) ? (
        <WhatsAppSetupModal
          channel={connection}
          completeEmbedded={async (result) => {
            await mutations.completeWhatsAppSetup.mutateAsync({
              code: result.code,
              connectionId: connection.id,
              name: connection.name,
              phoneNumberId: result.phoneNumberId,
              pin: result.pin,
              wabaId: result.wabaId,
            });
            void message.success('WhatsApp Business connected.');
          }}
          completingEmbedded={mutations.completeWhatsAppSetup.isPending}
          connect={connectWhatsApp}
          connecting={mutations.connect.isPending}
          onClose={closeSetup}
          onOpenSettings={() => {
            closeSetup();
            requestAnimationFrame(() =>
              whatsappSettingsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
            );
          }}
          open={setupOpen}
          projectId={projectId}
        />
      ) : null}
    </section>
  );
}

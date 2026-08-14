import {
  conditionOperators,
  waitReplyMediaTypes,
  type ConditionOperator,
} from '@omnicus/automation-core';
import {
  Alert,
  AutoComplete,
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Segmented,
  Select,
  Space,
  Tabs,
  Typography,
  Upload,
  message,
} from 'antd';
import { useEffect, useState } from 'react';

import { ApiError, getUserErrorMessage } from './api';
import type { ScenarioSummary } from './automation-api';
import { channelAccountLabel } from './channel-provider';
import { useChannels, type TelegramChannel } from './channels-api';
import {
  useMediaAssets,
  useMediaMutations,
  type MediaKind,
} from './media-api';
import {
  type AutomationCustomField,
  type AutomationSecret,
  type AutomationTag,
  type ExternalHttpTestResult,
  useLeadCaptureConfiguration,
} from './automation-studio-api';
import {
  conditionFieldType,
  defaultCustomFieldValue,
  durationParts,
  durationSeconds,
  durationUnits,
  externalHttpSafeErrorMessage,
  previewAutomationText,
  type DurationUnit,
} from './automation-studio';
import type { MessageTemplate } from './templates-api';
import {
  assetKindForWhatsAppSlot,
  whatsAppParameterSlots,
  whatsAppTemplateComponents,
  whatsAppTemplateComposerIssue,
  whatsAppTemplateParameterValues,
} from './whatsapp-template-composer';
import {
  type WhatsAppTemplateComponentInput,
  useWhatsAppTemplates,
} from './whatsapp-templates-api';

interface Props {
  config: Record<string, unknown>;
  customFields: AutomationCustomField[];
  nodeType: string;
  onCreateSecret(name: string, value: string): Promise<string>;
  onChange(config: Record<string, unknown>): void;
  projectId: string | undefined;
  scenarioId: string | undefined;
  scenarios: ScenarioSummary[];
  secrets: AutomationSecret[];
  tags: AutomationTag[];
  templates: MessageTemplate[];
  testHttpRequest(
    config: Record<string, unknown>,
    variables?: Record<string, unknown>,
  ): Promise<ExternalHttpTestResult>;
}

interface ConditionProps {
  condition: { field?: string; operator?: string; value?: unknown };
  customFields: AutomationCustomField[];
  onChange(condition: { field: string; operator: ConditionOperator; value?: unknown }): void;
}

interface ConditionGroupProps {
  customFields: AutomationCustomField[];
  group: {
    combinator: 'AND' | 'OR';
    rules: Array<{ field: string; operator: string; value?: unknown }>;
  };
  onChange(group: {
    combinator: 'AND' | 'OR';
    rules: Array<{ field: string; operator: string; value?: unknown }>;
  }): void;
}

function AutomationCopyField({
  copyLabel,
  successMessage,
  value,
}: {
  copyLabel: string;
  successMessage: string;
  value: string;
}) {
  return (
    <Input
      aria-label={copyLabel}
      className="automation-copy-field"
      readOnly
      suffix={
        <Button
          aria-label={`Copy ${copyLabel}`}
          className="automation-copy-field-button"
          htmlType="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              void message.success(successMessage);
            } catch {
              void message.error(`${copyLabel} could not be copied.`);
            }
          }}
          size="small"
          type="text"
        >
          Copy
        </Button>
      }
      title={value}
      value={value}
    />
  );
}

const conditionOperatorLabels: Record<ConditionOperator, string> = {
  contains: 'Contains',
  ends_with: 'Ends with',
  equals: 'Equals',
  exists: 'Exists',
  greater_or_equal: 'Greater than or equal',
  greater_than: 'Greater than',
  less_or_equal: 'Less than or equal',
  less_than: 'Less than',
  not_equals: 'Does not equal',
  not_exists: 'Does not exist',
  starts_with: 'Starts with',
};

const mediaTypeLabels: Record<(typeof waitReplyMediaTypes)[number], string> = {
  ANIMATION: 'Animation',
  AUDIO: 'Audio',
  DOCUMENT: 'Document',
  PHOTO: 'Photo',
  STICKER: 'Sticker',
  VIDEO: 'Video',
  VIDEO_NOTE: 'Video note',
  VOICE: 'Voice message',
};

const mediaAccept: Record<MediaKind, string> = {
  ANIMATION: 'image/gif,video/mp4',
  AUDIO: 'audio/*',
  DOCUMENT: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,application/octet-stream',
  PHOTO: 'image/jpeg,image/png,image/webp',
  STICKER: 'image/webp',
  VIDEO: 'video/*',
  VIDEO_NOTE: 'video/mp4,video/webm',
  VOICE: 'audio/ogg,audio/opus,audio/webm',
};

export function AutomationNodeConfig({
  config,
  customFields,
  nodeType,
  onCreateSecret,
  onChange,
  projectId,
  scenarioId,
  scenarios,
  secrets,
  tags,
  templates,
  testHttpRequest,
}: Props) {
  const updateConfig = (next: Record<string, unknown>) => onChange({ ...config, ...next });
  const set = (key: string, value: unknown) => onChange({ ...config, [key]: value });
  const triggerType =
    typeof config.triggerType === 'string' ? config.triggerType : 'INCOMING_MESSAGE';
  const channels = useChannels(
    projectId,
    nodeType === 'SEND_TEMPLATE' ||
      nodeType === 'SEND_MESSAGE' ||
      (nodeType === 'INCOMING_MESSAGE' && triggerType === 'TELEGRAM_DEEP_LINK'),
  );
  const assets = useMediaAssets(
    projectId,
    nodeType === 'SEND_TEMPLATE' || nodeType === 'SEND_MESSAGE',
  );
  const mediaMutations = useMediaMutations(projectId);
  const [uploadKind, setUploadKind] = useState<MediaKind>('DOCUMENT');
  const sourceKey =
    typeof config.sourceKey === 'string' && config.sourceKey
      ? config.sourceKey
      : `scenario-${scenarioId ?? 'new'}`;
  const leadCapture = useLeadCaptureConfiguration(
    projectId,
    sourceKey,
    nodeType === 'INCOMING_MESSAGE' && triggerType === 'WEBSITE_REGISTRATION',
  );
  const activeTelegramChannels = (channels.data ?? []).filter(
    (channel): channel is TelegramChannel =>
      channel.type === 'TELEGRAM' && channel.status === 'ACTIVE',
  );
  const activeWhatsAppChannels = (channels.data ?? []).filter(
    (channel) => channel.type === 'WHATSAPP' && channel.status === 'ACTIVE',
  );
  const sendDeliveryTarget = (() => {
    const target = config.deliveryTarget;
    return target === 'TELEGRAM' || target === 'WHATSAPP' || target === 'INCOMING_CONVERSATION'
      ? target
      : 'INCOMING_CONVERSATION';
  })();
  const telegramConnectionId =
    typeof config.telegramConnectionId === 'string' ? config.telegramConnectionId : undefined;
  const whatsappConnectionId =
    typeof config.whatsappConnectionId === 'string' ? config.whatsappConnectionId : undefined;

  useEffect(() => {
    const updates: Record<string, unknown> = {};
    const telegramActiveIds = activeTelegramChannels.map((channel) => channel.id);
    const whatsappActiveIds = activeWhatsAppChannels.map((channel) => channel.id);
    if (sendDeliveryTarget === 'INCOMING_CONVERSATION') {
      if (telegramConnectionId !== undefined) updates.telegramConnectionId = undefined;
      if (whatsappConnectionId !== undefined) updates.whatsappConnectionId = undefined;
    } else if (sendDeliveryTarget === 'TELEGRAM') {
      const validConnection = telegramConnectionId
        ? telegramActiveIds.includes(telegramConnectionId)
        : false;
      if (whatsappConnectionId !== undefined) updates.whatsappConnectionId = undefined;
      if (!activeTelegramChannels.length) {
        if (telegramConnectionId !== undefined) updates.telegramConnectionId = undefined;
      } else if (!validConnection) {
        if (activeTelegramChannels.length === 1)
          updates.telegramConnectionId = activeTelegramChannels[0]!.id;
        else if (telegramConnectionId !== undefined) updates.telegramConnectionId = undefined;
      }
    } else {
      const validConnection = whatsappConnectionId
        ? whatsappActiveIds.includes(whatsappConnectionId)
        : false;
      if (telegramConnectionId !== undefined) updates.telegramConnectionId = undefined;
      if (!activeWhatsAppChannels.length) {
        if (whatsappConnectionId !== undefined) updates.whatsappConnectionId = undefined;
      } else if (!validConnection) {
        if (activeWhatsAppChannels.length === 1)
          updates.whatsappConnectionId = activeWhatsAppChannels[0]!.id;
        else if (whatsappConnectionId !== undefined) updates.whatsappConnectionId = undefined;
      }
    }
    if (Object.keys(updates).length) onChange({ ...config, ...updates });
  }, [
    activeTelegramChannels,
    activeWhatsAppChannels,
    sendDeliveryTarget,
    telegramConnectionId,
    whatsappConnectionId,
    config,
  ]);

  const sendDeliveryInfo = {
    INCOMING_CONVERSATION: {
      description: 'Uses the channel that started the automation.',
      message: 'Automatic channel selection',
    },
    TELEGRAM: {
      description: 'Always sends this message through the selected Telegram connection.',
      message: 'Telegram delivery',
    },
    WHATSAPP: {
      description:
        'Always sends this message through the selected WhatsApp connection. Free-form messages require an open customer-service window.',
      message: 'WhatsApp delivery',
    },
  }[sendDeliveryTarget];
  const [whatsAppCatalogConnectionId, setWhatsAppCatalogConnectionId] = useState<string>();
  const effectiveWhatsAppCatalogConnectionId = activeWhatsAppChannels.some(
    (channel) => channel.id === whatsAppCatalogConnectionId,
  )
    ? whatsAppCatalogConnectionId
    : activeWhatsAppChannels[0]?.id;
  const whatsAppTemplates = useWhatsAppTemplates(projectId, effectiveWhatsAppCatalogConnectionId);

  if (nodeType === 'INCOMING_MESSAGE') {
    const startPayload =
      typeof config.startPayload === 'string' && config.startPayload
        ? config.startPayload
        : `flow_${(scenarioId ?? 'new').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48)}`;
    const telegramConnectionId =
      typeof config.connectionId === 'string' ? config.connectionId : undefined;
    const telegramConnection = activeTelegramChannels.find(
      (channel) => channel.id === telegramConnectionId,
    );
    const deepLink = telegramConnection?.botUsername
      ? `https://t.me/${telegramConnection.botUsername.replace(/^@/, '')}?start=${encodeURIComponent(startPayload)}`
      : undefined;
    return (
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Form.Item label="Starts when" style={{ marginBottom: 0 }}>
          <Segmented
            block
            onChange={(value) => {
              if (value === 'WEBSITE_REGISTRATION') {
                updateConfig({
                  connectionId: undefined,
                  sourceKey,
                  startPayload: undefined,
                  triggerType: value,
                });
              } else if (value === 'TELEGRAM_DEEP_LINK') {
                updateConfig({
                  connectionId: activeTelegramChannels[0]?.id,
                  sourceKey: undefined,
                  startPayload,
                  triggerType: value,
                });
              } else {
                updateConfig({
                  connectionId: undefined,
                  sourceKey: undefined,
                  startPayload: undefined,
                  triggerType: value,
                });
              }
            }}
            options={[
              { label: 'Incoming message', value: 'INCOMING_MESSAGE' },
              { label: 'Website registration', value: 'WEBSITE_REGISTRATION' },
              { label: 'Telegram link', value: 'TELEGRAM_DEEP_LINK' },
            ]}
            value={triggerType}
          />
        </Form.Item>

        {triggerType === 'WEBSITE_REGISTRATION' ? (
          <>
            <Form.Item label="Source key" style={{ marginBottom: 0 }}>
              <Input
                maxLength={64}
                onChange={(event) =>
                  set(
                    'sourceKey',
                    event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''),
                  )
                }
                value={sourceKey}
              />
            </Form.Item>
            {leadCapture.data ? (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Typography.Text strong>Webhook URL</Typography.Text>
                <AutomationCopyField
                  copyLabel="webhook URL"
                  successMessage="Webhook URL copied."
                  value={leadCapture.data.endpointUrl}
                />
                <Typography.Text strong>Authentication header</Typography.Text>
                <AutomationCopyField
                  copyLabel="authentication header"
                  successMessage="Authentication header copied."
                  value={`X-Omnicus-Ingest-Key: ${leadCapture.data.headers['X-Omnicus-Ingest-Key']}`}
                />
                <Alert
                  description="Send a unique Idempotency-Key for every website registration. The body may contain firstName, lastName, phone, email, consents and metadata."
                  message="Ready for website forms"
                  showIcon
                  type="success"
                />
              </Space>
            ) : (
              <Typography.Text type="secondary">
                {leadCapture.isError ? 'Webhook configuration could not be loaded.' : 'Loading webhook configuration...'}
              </Typography.Text>
            )}
          </>
        ) : null}

        {triggerType === 'TELEGRAM_DEEP_LINK' ? (
          <>
            <Form.Item label="Telegram connection" style={{ marginBottom: 0 }}>
              <Select
                onChange={(value: string) => set('connectionId', value)}
                options={activeTelegramChannels.map((channel) => ({
                  label: `${channel.name} - ${channelAccountLabel(channel)}`,
                  value: channel.id,
                }))}
                placeholder="Choose an active Telegram bot"
                value={telegramConnectionId ?? null}
              />
            </Form.Item>
            <Form.Item label="Start payload" style={{ marginBottom: 0 }}>
              <Input
                maxLength={64}
                onChange={(event) =>
                  set('startPayload', event.target.value.replace(/[^A-Za-z0-9_-]/g, ''))
                }
                value={startPayload}
              />
            </Form.Item>
            {deepLink ? (
              <Form.Item label="Telegram launch link" style={{ marginBottom: 0 }}>
                <AutomationCopyField
                  copyLabel="Telegram launch link"
                  successMessage="Telegram link copied."
                  value={deepLink}
                />
              </Form.Item>
            ) : (
              <Alert
                description="Choose an active Telegram connection with a bot username."
                message="Telegram link is not ready"
                showIcon
                type="warning"
              />
            )}
          </>
        ) : null}

        {triggerType === 'INCOMING_MESSAGE' ? (
          <Alert
            description="The published automation starts for every new Telegram or WhatsApp inbound event that is not consumed by a wait step."
            message="Standard incoming trigger"
            showIcon
            type="info"
          />
        ) : null}
      </Space>
    );
  }

  if (nodeType === 'SEND_MESSAGE') {
    const text = typeof config.text === 'string' ? config.text : '';
    const preview = previewAutomationText(text, customFields);
    const telegramButtons = Array.isArray(config.telegramButtons)
      ? (config.telegramButtons as Array<{ text?: string; url?: string }>)
      : [];
    const messageTextField = (
      <Form.Item label="Message text" style={{ marginBottom: 0 }}>
        <div style={{ marginTop: 6 }}>
          <Input.TextArea
            maxLength={4096}
            onChange={(event) => set('text', event.target.value)}
            rows={6}
            value={text}
          />
        </div>
      </Form.Item>
    );
    const insertVariableField = (
      <Form.Item label="Insert variable" style={{ marginBottom: 0 }}>
        <Select
          onChange={(path: string) => set('text', `${text}{{${path}}}`)}
          options={automationVariableOptions(customFields)}
          placeholder="Choose a contact or event variable"
          showSearch
          value={null}
        />
      </Form.Item>
    );
    return (
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert
          className="automation-channel-note"
          description={sendDeliveryInfo.description}
          message={sendDeliveryInfo.message}
          showIcon
          type="info"
        />
        <Form.Item label="Send via" style={{ marginBottom: 0 }}>
          <Segmented
            className="segmented-switcher"
            onChange={(value) => {
              updateConfig({
                deliveryTarget: value,
                ...(value === sendDeliveryTarget ? {} : { mediaAssetId: undefined }),
                ...(value === 'INCOMING_CONVERSATION'
                  ? {
                      telegramButtons: undefined,
                      telegramConnectionId: undefined,
                      whatsappConnectionId: undefined,
                    }
                  : {}),
                ...(value === 'TELEGRAM' ? { whatsappConnectionId: undefined } : {}),
                ...(value === 'WHATSAPP'
                  ? { telegramButtons: undefined, telegramConnectionId: undefined }
                  : {}),
              });
            }}
            options={[
              { label: 'Automatic', value: 'INCOMING_CONVERSATION' },
              { label: 'Telegram only', value: 'TELEGRAM' },
              { label: 'WhatsApp only', value: 'WHATSAPP' },
            ]}
            value={sendDeliveryTarget}
          />
        </Form.Item>
        {sendDeliveryTarget === 'TELEGRAM' ? (
          <Space direction="vertical" size={20}>
            <Form.Item label="Telegram connection" style={{ marginBottom: 0 }}>
              <Space direction="vertical" size={6}>
                <Select
                  onChange={(value: string) => set('telegramConnectionId', value)}
                  options={activeTelegramChannels.map((channel) => ({
                    label: `${channel.name} — ${channelAccountLabel(channel)}`,
                    value: channel.id,
                  }))}
                  optionFilterProp="label"
                  placeholder="Choose an active Telegram connection"
                  showSearch
                  value={telegramConnectionId ?? null}
                />
                {!activeTelegramChannels.length ? (
                  <Alert
                    description="No active Telegram connection is available for this project."
                    message="No active Telegram connection is available for this project."
                    showIcon
                    type="warning"
                  />
                ) : (
                  <Typography.Text type="secondary">
                    The contact must have an active Telegram identity for the selected connection.
                  </Typography.Text>
                )}
              </Space>
            </Form.Item>
            {messageTextField}
            {insertVariableField}
          </Space>
        ) : null}
        {sendDeliveryTarget === 'WHATSAPP' ? (
          <Space direction="vertical" size={20}>
            <Form.Item label="WhatsApp connection" style={{ marginBottom: 0 }}>
              <Space direction="vertical" size={6}>
                <Select
                  onChange={(value: string) => set('whatsappConnectionId', value)}
                  options={activeWhatsAppChannels.map((channel) => ({
                    label: `${channel.name} — ${channelAccountLabel(channel)}`,
                    value: channel.id,
                  }))}
                  optionFilterProp="label"
                  placeholder="Choose an active WhatsApp connection"
                  showSearch
                  value={whatsappConnectionId ?? null}
                />
                {!activeWhatsAppChannels.length ? (
                  <Alert
                    description="No active WhatsApp connection is available for this project."
                    message="No active WhatsApp connection is available for this project."
                    showIcon
                    type="warning"
                  />
                ) : (
                  <Space direction="vertical" size={12}>
                    <Typography.Text type="secondary">
                      The contact must have an active WhatsApp identity for the selected connection.
                    </Typography.Text>
                    <Alert
                      description="Free-form WhatsApp messages require an open customer-service window. Use Send template outside that window."
                      message="Free-form WhatsApp messages require an open customer-service window."
                      showIcon
                      type="warning"
                    />
                  </Space>
                )}
              </Space>
            </Form.Item>
            {messageTextField}
            {insertVariableField}
          </Space>
        ) : null}
        {sendDeliveryTarget === 'INCOMING_CONVERSATION' ? (
          <Space direction="vertical" size={20}>
            {messageTextField}
            {insertVariableField}
          </Space>
        ) : null}

        <Form.Item label="Attachment" style={{ marginBottom: 0 }}>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Select
              allowClear
              onChange={(value?: string) => set('mediaAssetId', value)}
              options={(assets.data ?? [])
                .filter((asset) => {
                  const targetChannel =
                    sendDeliveryTarget === 'TELEGRAM'
                      ? 'telegram'
                      : sendDeliveryTarget === 'WHATSAPP'
                        ? 'whatsapp'
                        : undefined;
                  return !targetChannel || !asset.validationChannel || asset.validationChannel === targetChannel;
                })
                .map((asset) => ({
                  label: `${asset.originalFilename ?? asset.id.slice(0, 8)} · ${asset.kind.replaceAll('_', ' ').toLowerCase()}`,
                  value: asset.id,
                }))}
              placeholder="Select an uploaded file"
              value={typeof config.mediaAssetId === 'string' ? config.mediaAssetId : null}
            />
            {sendDeliveryTarget === 'INCOMING_CONVERSATION' ? (
              <Typography.Text type="secondary">
                Choose Telegram only or WhatsApp only before uploading a channel-validated file.
              </Typography.Text>
            ) : (
              <div className="automation-attachment-upload-grid">
                <div className="automation-attachment-kind-field">
                  <Typography.Text type="secondary">Upload as</Typography.Text>
                  <Select<MediaKind>
                    onChange={setUploadKind}
                    options={Object.keys(mediaAccept).map((kind) => ({
                      label: kind.replaceAll('_', ' ').toLowerCase(),
                      value: kind as MediaKind,
                    }))}
                    value={uploadKind}
                  />
                </div>
                <Upload
                  accept={mediaAccept[uploadKind]}
                  beforeUpload={(file) => {
                    void mediaMutations.upload
                      .mutateAsync({
                        channel: sendDeliveryTarget === 'WHATSAPP' ? 'WHATSAPP' : 'TELEGRAM',
                        file,
                        kind: uploadKind,
                      })
                      .then((asset) => {
                        set('mediaAssetId', asset.id);
                        void message.success('Attachment uploaded');
                      })
                      .catch(() => void message.error('Attachment could not be uploaded'));
                    return Upload.LIST_IGNORE;
                  }}
                  disabled={mediaMutations.upload.isPending}
                  maxCount={1}
                  showUploadList={false}
                >
                  <Button
                    className="automation-attachment-upload-button"
                    loading={mediaMutations.upload.isPending}
                  >
                    Upload file
                  </Button>
                </Upload>
              </div>
            )}
          </Space>
        </Form.Item>

        {sendDeliveryTarget === 'TELEGRAM' ? (
          <Space
            className="automation-url-buttons"
            direction="vertical"
            size={10}
            style={{ width: '100%' }}
          >
            <Typography.Text strong>URL buttons</Typography.Text>
            {telegramButtons.map((button, index) => (
              <div className="automation-url-button-card" key={index}>
                <div className="automation-url-button-header">
                  <Typography.Text strong>Button {index + 1}</Typography.Text>
                  <Button
                    danger
                    onClick={() =>
                      set(
                        'telegramButtons',
                        telegramButtons.filter((_, buttonIndex) => buttonIndex !== index),
                      )
                    }
                    size="small"
                    type="text"
                  >
                    Remove
                  </Button>
                </div>
                <label className="automation-url-button-field">
                  <span>Button text</span>
                  <Input
                    maxLength={64}
                    onChange={(event) => {
                      const next = [...telegramButtons];
                      next[index] = { ...button, text: event.target.value };
                      set('telegramButtons', next);
                    }}
                    placeholder="Open test page"
                    value={button.text}
                  />
                </label>
                <label className="automation-url-button-field">
                  <span>Destination URL</span>
                  <Input
                    onChange={(event) => {
                      const next = [...telegramButtons];
                      next[index] = { ...button, url: event.target.value };
                      set('telegramButtons', next);
                    }}
                    placeholder="https://example.com"
                    value={button.url}
                  />
                </label>
              </div>
            ))}
            <Button
              block
              className="automation-url-button-add"
              disabled={telegramButtons.length >= 8}
              onClick={() => set('telegramButtons', [...telegramButtons, { text: '', url: '' }])}
              type="dashed"
            >
              Add URL button
            </Button>
          </Space>
        ) : null}

        {sendDeliveryTarget === 'WHATSAPP' ? (
          <Typography.Text type="secondary">
            WhatsApp buttons are available through approved templates in the Send template step.
          </Typography.Text>
        ) : null}

        <Checkbox
          checked={config.trackLinks === true}
          onChange={(event) => set('trackLinks', event.target.checked)}
        >
          Track link clicks per contact
        </Checkbox>

        <div className="automation-message-preview">
          <Typography.Text strong>Preview</Typography.Text>
          <Typography.Paragraph>
            {preview.output || 'Message preview is empty.'}
          </Typography.Paragraph>
          {preview.missing.length ? (
            <Typography.Text type="danger">
              Missing sample values: {preview.missing.join(', ')}
            </Typography.Text>
          ) : null}
        </div>
      </Space>
    );
  }

  if (nodeType === 'SEND_TEMPLATE') {
    const whatsAppTemplate =
      config.whatsAppTemplate &&
      typeof config.whatsAppTemplate === 'object' &&
      !Array.isArray(config.whatsAppTemplate)
        ? (config.whatsAppTemplate as {
            components?: WhatsAppTemplateComponentInput[];
            languageCode?: string;
            name?: string;
          })
        : undefined;
    const provider = whatsAppTemplate ? 'WHATSAPP' : 'TELEGRAM';
    const selectedWhatsAppTemplate = whatsAppTemplates.data?.find(
      (template) =>
        template.name === whatsAppTemplate?.name &&
        template.languageCode === whatsAppTemplate.languageCode,
    );
    const parameterSlots = whatsAppParameterSlots(selectedWhatsAppTemplate);
    const parameterValues = whatsAppTemplateParameterValues(
      parameterSlots,
      whatsAppTemplate?.components,
    );
    const updateWhatsAppParameters = (values: Record<string, string>) => {
      if (!selectedWhatsAppTemplate) return;
      const components = whatsAppTemplateComponents(parameterSlots, values);
      onChange({
        whatsAppTemplate: {
          languageCode: selectedWhatsAppTemplate.languageCode,
          name: selectedWhatsAppTemplate.name,
          ...(components ? { components } : {}),
        },
      });
    };
    return (
      <Space direction="vertical" style={{ width: '100%' }}>
        <Alert
          className="automation-channel-note"
          description="WhatsApp resolves the approved template by name and language on the conversation that starts the run. The scenario is not tied to one phone number. Telegram uses an immutable Omnicus template version."
          message="Channel-compatible template required"
          showIcon
          type="info"
        />
        <Segmented
          className="segmented-switcher"
          block
          onChange={(value) =>
            value === 'WHATSAPP'
              ? onChange({ whatsAppTemplate: { languageCode: '', name: '' } })
              : onChange({ templateId: '', templateVersionId: '' })
          }
          options={[
            { label: 'Telegram', value: 'TELEGRAM' },
            { label: 'WhatsApp', value: 'WHATSAPP' },
          ]}
          value={provider}
        />
        {provider === 'WHATSAPP' ? (
          <>
            {channels.isError ? (
              <Alert
                message={getUserErrorMessage(
                  channels.error,
                  'WhatsApp channels could not be loaded.',
                )}
                showIcon
                type="error"
              />
            ) : !channels.isLoading && !activeWhatsAppChannels.length ? (
              <Alert
                description="Connect and activate a WhatsApp Business number before choosing its approved template catalog."
                message="No active WhatsApp channel"
                showIcon
                type="warning"
              />
            ) : null}
            <Form.Item
              extra="This number is used only to browse its synced Meta catalog. It is not saved in the scenario."
              label="Template source"
            >
              <Select
                onChange={setWhatsAppCatalogConnectionId}
                options={activeWhatsAppChannels.map((channel) => ({
                  label: `${channel.name} — ${channelAccountLabel(channel)}`,
                  value: channel.id,
                }))}
                optionFilterProp="label"
                placeholder="Choose a connected WhatsApp number"
                showSearch
                value={effectiveWhatsAppCatalogConnectionId ?? null}
              />
            </Form.Item>
            {whatsAppTemplates.isError ? (
              <Alert
                message={getUserErrorMessage(
                  whatsAppTemplates.error,
                  'Approved WhatsApp templates could not be loaded from this channel.',
                )}
                showIcon
                type="error"
              />
            ) : null}
            <Form.Item
              extra="At runtime Omnicus requires the same approved template on the WhatsApp number that owns the conversation."
              label="Approved Meta template"
            >
              <Select
                disabled={!effectiveWhatsAppCatalogConnectionId}
                loading={whatsAppTemplates.isLoading}
                onChange={(templateId: string) => {
                  const template = whatsAppTemplates.data?.find(
                    (candidate) => candidate.id === templateId,
                  );
                  if (!template) return;
                  onChange({
                    whatsAppTemplate: {
                      languageCode: template.languageCode,
                      name: template.name,
                    },
                  });
                }}
                options={(whatsAppTemplates.data ?? [])
                  .filter((template) => template.status === 'APPROVED')
                  .map((template) => {
                    const issue = whatsAppTemplateComposerIssue(template);
                    return {
                      disabled: Boolean(issue),
                      label: `${template.name} — ${template.languageCode}${
                        issue ? ` · ${issue}` : ''
                      }`,
                      value: template.id,
                    };
                  })}
                optionFilterProp="label"
                placeholder="Select an approved template"
                showSearch
                value={selectedWhatsAppTemplate?.id ?? null}
              />
            </Form.Item>
            {whatsAppTemplate?.name && !selectedWhatsAppTemplate ? (
              <Alert
                message={`“${whatsAppTemplate.name}” (${whatsAppTemplate.languageCode ?? 'unknown language'}) is not approved on this catalog source.`}
                showIcon
                type="warning"
              />
            ) : null}
            {parameterSlots.length ? (
              <div className="automation-whatsapp-template-values">
                <Typography.Text strong>Template values</Typography.Text>
                <Typography.Paragraph type="secondary">
                  Text values may use the same bounded automation variables as message steps. Media
                  must be an existing private project asset.
                </Typography.Paragraph>
                {parameterSlots.map((slot) => (
                  <Form.Item key={slot.key} label={slot.label} required>
                    {slot.kind === 'media' ? (
                      <Select
                        onChange={(value: string) =>
                          updateWhatsAppParameters({ ...parameterValues, [slot.key]: value })
                        }
                        options={(assets.data ?? [])
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
                        placeholder={`Choose a ${slot.mediaType}`}
                        value={parameterValues[slot.key] || null}
                      />
                    ) : (
                      <Input
                        onChange={(event) =>
                          updateWhatsAppParameters({
                            ...parameterValues,
                            [slot.key]: event.target.value,
                          })
                        }
                        placeholder={
                          slot.kind === 'quick_reply'
                            ? 'Payload returned when this reply is tapped'
                            : slot.kind === 'url'
                              ? 'Dynamic part appended to the approved button URL'
                              : 'Text or {{contact.variable}}'
                        }
                        value={parameterValues[slot.key] ?? ''}
                      />
                    )}
                  </Form.Item>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <Form.Item label="Published template version">
            <Select
              onChange={(versionId: string) => {
                const template = templates.find(
                  (candidate) => candidate.activeVersion?.id === versionId,
                );
                onChange({ templateId: template?.id, templateVersionId: versionId });
              }}
              options={templates
                .filter((template) => template.status === 'PUBLISHED' && template.activeVersion)
                .map((template) => ({
                  label: `${template.name} (${template.activeVersion!.kind})`,
                  value: template.activeVersion!.id,
                }))}
              placeholder="Select a published template"
              showSearch
              value={typeof config.templateVersionId === 'string' ? config.templateVersionId : null}
            />
          </Form.Item>
        )}
      </Space>
    );
  }

  if (nodeType === 'CONDITION')
    return (
      <>
        <Typography.Paragraph type="secondary">
          Configure each branch on its connection. This fallback is used only when a branch has no
          condition of its own.
        </Typography.Paragraph>
        <AutomationConditionFields
          condition={config}
          customFields={customFields}
          onChange={(condition) => onChange(condition)}
        />
      </>
    );

  if (nodeType === 'DELAY' || nodeType === 'WAIT_FOR_REPLY') {
    const key = nodeType === 'DELAY' ? 'delaySeconds' : 'timeoutSeconds';
    return (
      <Space direction="vertical" style={{ width: '100%' }}>
        <DurationField
          label={nodeType === 'DELAY' ? 'Delay for' : 'Wait up to'}
          onChange={(seconds) => set(key, seconds)}
          seconds={config[key]}
        />
        {nodeType === 'WAIT_FOR_REPLY' ? (
          <WaitCriteriaFields
            criteria={record(config.criteria)}
            onChange={(criteria) => set('criteria', criteria)}
          />
        ) : null}
      </Space>
    );
  }

  if (nodeType === 'ADD_TAG' || nodeType === 'REMOVE_TAG')
    return (
      <Form.Item label="Tag">
        <Select
          onChange={(tagId) => set('tagId', tagId)}
          options={tags.map((tag) => ({ label: tag.name, value: tag.id }))}
          placeholder="Select a project tag"
          showSearch
          value={typeof config.tagId === 'string' ? config.tagId : null}
        />
      </Form.Item>
    );

  if (nodeType === 'SET_CUSTOM_FIELD') {
    const selected = customFields.find((field) => field.key === config.key);
    return (
      <Space direction="vertical" style={{ width: '100%' }}>
        <Form.Item label="Custom field">
          <Select
            onChange={(key: string) => {
              const field = customFields.find((candidate) => candidate.key === key);
              onChange({ key, value: defaultCustomFieldValue(field) });
            }}
            options={customFields.map((field) => ({
              label: `${field.name} (${field.type.toLowerCase()})`,
              value: field.key,
            }))}
            placeholder="Select an active custom field"
            showSearch
            value={typeof config.key === 'string' ? config.key : null}
          />
        </Form.Item>
        {selected ? (
          <Form.Item label="Value">
            <CustomFieldValueInput
              field={selected}
              onChange={(value) => set('value', value)}
              value={config.value}
            />
          </Form.Item>
        ) : null}
      </Space>
    );
  }

  if (nodeType === 'CLEAR_CUSTOM_FIELD')
    return (
      <Form.Item
        extra="The field definition stays available; only this contact's current value is cleared."
        label="Custom field"
      >
        <Select
          onChange={(key: string) => onChange({ key })}
          options={customFields.map((field) => ({
            label: `${field.name} (${field.type.toLowerCase()})`,
            value: field.key,
          }))}
          placeholder="Select an active custom field"
          showSearch
          value={typeof config.key === 'string' ? config.key : null}
        />
      </Form.Item>
    );

  if (nodeType === 'START_SUBFLOW')
    return (
      <Form.Item label="Published scenario">
        <Select
          onChange={(value: string) => {
            const scenario = scenarios.find((candidate) => candidate.id === value);
            onChange({ scenarioId: value, scenarioVersionId: scenario?.activeVersionId });
          }}
          options={scenarios
            .filter((scenario) => scenario.status === 'PUBLISHED' && scenario.activeVersionId)
            .map((scenario) => ({ label: scenario.name, value: scenario.id }))}
          placeholder="Select a published scenario"
          showSearch
          value={typeof config.scenarioId === 'string' ? config.scenarioId : null}
        />
      </Form.Item>
    );

  if (nodeType === 'EXTERNAL_HTTP_REQUEST')
    return (
      <ExternalHttpFields
        config={config}
        onChange={onChange}
        onCreateSecret={onCreateSecret}
        secrets={secrets}
        testRequest={testHttpRequest}
      />
    );

  return (
    <div className="automation-node-empty-config">
      <strong>No additional settings</strong>
      <small>This step is ready to use as soon as it is connected.</small>
    </div>
  );
}

function ExternalHttpFields({
  config,
  onChange,
  onCreateSecret,
  secrets,
  testRequest,
}: {
  config: Record<string, unknown>;
  onChange(config: Record<string, unknown>): void;
  onCreateSecret(name: string, value: string): Promise<string>;
  secrets: AutomationSecret[];
  testRequest(
    config: Record<string, unknown>,
    variables?: Record<string, unknown>,
  ): Promise<ExternalHttpTestResult>;
}) {
  const [secretName, setSecretName] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [creatingSecret, setCreatingSecret] = useState(false);
  const [secretError, setSecretError] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string>();
  const [testResult, setTestResult] = useState<ExternalHttpTestResult>();
  const [testVariablesDraft, setTestVariablesDraft] = useState('{}');
  const set = (key: string, value: unknown) => onChange({ ...config, [key]: value });
  const query = objectArray(config.query);
  const headers = objectArray(config.headers);
  const mappings = objectArray(config.mappings);
  const method = typeof config.method === 'string' ? config.method : 'GET';
  const contentType =
    typeof config.contentType === 'string' ? config.contentType : 'application/json';

  const requestTab = (
    <Space className="automation-http-section" direction="vertical" style={{ width: '100%' }}>
      <Form.Item label="Method">
        <Select
          onChange={(value) => set('method', value)}
          options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((value) => ({
            label: value,
            value,
          }))}
          value={method}
        />
      </Form.Item>
      <Form.Item label="HTTPS URL">
        <Input
          maxLength={2048}
          onChange={(event) => set('url', event.target.value)}
          placeholder="https://api.example.com/hooks/{{contact.id}}"
          value={typeof config.url === 'string' ? config.url : 'https://'}
        />
      </Form.Item>
      <Space.Compact block>
        <Form.Item label="Timeout, ms" style={{ width: '50%' }}>
          <InputNumber
            max={30_000}
            min={1_000}
            onChange={(value) => set('timeoutMs', value ?? 10_000)}
            precision={0}
            style={{ width: '100%' }}
            value={typeof config.timeoutMs === 'number' ? config.timeoutMs : 10_000}
          />
        </Form.Item>
        <Form.Item label="Maximum attempts" style={{ width: '50%' }}>
          <InputNumber
            max={5}
            min={1}
            onChange={(value) => set('maxAttempts', value ?? 1)}
            precision={0}
            style={{ width: '100%' }}
            value={typeof config.maxAttempts === 'number' ? config.maxAttempts : 1}
          />
        </Form.Item>
      </Space.Compact>
      <Typography.Text strong>Query parameters</Typography.Text>
      {query.map((item, index) => (
        <Space.Compact block key={`query-${index}`}>
          <Input
            onChange={(event) =>
              set('query', replaceAt(query, index, { ...item, name: event.target.value }))
            }
            placeholder="name"
            value={stringValue(item.name)}
          />
          <Input
            onChange={(event) =>
              set('query', replaceAt(query, index, { ...item, value: event.target.value }))
            }
            placeholder="{{contact.id}}"
            value={stringValue(item.value)}
          />
          <Button danger onClick={() => set('query', removeAt(query, index))}>
            Remove
          </Button>
        </Space.Compact>
      ))}
      <Button
        disabled={query.length >= 20}
        onClick={() => set('query', [...query, { name: '', value: '' }])}
      >
        Add query parameter
      </Button>
    </Space>
  );

  const headersTab = (
    <Space className="automation-http-section" direction="vertical" style={{ width: '100%' }}>
      <Alert
        message="Authorization, Cookie and X-Api-Key values must use a write-only project secret."
        showIcon
        type="info"
      />
      {headers.map((item, index) => {
        const usesSecret = typeof item.secretId === 'string';
        return (
          <Space direction="vertical" key={`header-${index}`} style={{ width: '100%' }}>
            <Input
              onChange={(event) =>
                set('headers', replaceAt(headers, index, { ...item, name: event.target.value }))
              }
              placeholder="Header name"
              value={stringValue(item.name)}
            />
            <Select
              onChange={(mode: 'secret' | 'value') =>
                set(
                  'headers',
                  replaceAt(
                    headers,
                    index,
                    mode === 'secret'
                      ? { name: item.name, secretId: secrets[0]?.id }
                      : { name: item.name, value: '' },
                  ),
                )
              }
              options={[
                { label: 'Visible template value', value: 'value' },
                { label: 'Write-only secret reference', value: 'secret' },
              ]}
              value={usesSecret ? 'secret' : 'value'}
            />
            {usesSecret ? (
              <Select
                onChange={(secretId) =>
                  set('headers', replaceAt(headers, index, { name: item.name, secretId }))
                }
                options={secrets.map((secret) => ({ label: secret.name, value: secret.id }))}
                placeholder="Select secret"
                value={item.secretId}
              />
            ) : (
              <Input
                onChange={(event) =>
                  set(
                    'headers',
                    replaceAt(headers, index, { name: item.name, value: event.target.value }),
                  )
                }
                placeholder="Header value or {{variable}}"
                value={stringValue(item.value)}
              />
            )}
            <Button danger onClick={() => set('headers', removeAt(headers, index))} size="small">
              Remove header
            </Button>
          </Space>
        );
      })}
      <Button
        disabled={headers.length >= 20}
        onClick={() => set('headers', [...headers, { name: '', value: '' }])}
      >
        Add header
      </Button>
      <Typography.Text strong>Create write-only secret</Typography.Text>
      <Input
        onChange={(event) => setSecretName(event.target.value)}
        placeholder="Secret name"
        value={secretName}
      />
      <Input.Password
        onChange={(event) => setSecretValue(event.target.value)}
        placeholder="Secret value (never shown again)"
        value={secretValue}
      />
      <Button
        disabled={!secretName.trim() || !secretValue}
        loading={creatingSecret}
        onClick={async () => {
          setCreatingSecret(true);
          try {
            await onCreateSecret(secretName, secretValue);
            setSecretError(false);
            setSecretName('');
            setSecretValue('');
          } catch {
            setSecretError(true);
          } finally {
            setCreatingSecret(false);
          }
        }}
      >
        Save secret
      </Button>
      {secretError ? (
        <Typography.Text type="danger">
          Secret could not be saved. Check the name and try again.
        </Typography.Text>
      ) : null}
    </Space>
  );

  const bodyTab = (
    <Space className="automation-http-section" direction="vertical" style={{ width: '100%' }}>
      <Form.Item label="Content type">
        <Select
          disabled={method === 'GET'}
          onChange={(value) => set('contentType', value)}
          options={['application/json', 'application/x-www-form-urlencoded', 'text/plain'].map(
            (value) => ({ label: value, value }),
          )}
          value={contentType}
        />
      </Form.Item>
      {method === 'GET' ? (
        <Typography.Text type="secondary">GET requests do not send a body.</Typography.Text>
      ) : contentType === 'application/json' ? (
        <JsonValueInput onChange={(value) => set('body', value)} value={config.body ?? {}} />
      ) : (
        <Input.TextArea
          maxLength={65_536}
          onChange={(event) => set('body', event.target.value)}
          rows={8}
          value={typeof config.body === 'string' ? config.body : ''}
        />
      )}
    </Space>
  );

  const responseTab = (
    <Space className="automation-http-section" direction="vertical" style={{ width: '100%' }}>
      <Space.Compact block>
        <Form.Item label="Success from" style={{ width: '50%' }}>
          <InputNumber
            max={599}
            min={100}
            onChange={(value) => set('successStatusMinimum', value ?? 200)}
            value={
              typeof config.successStatusMinimum === 'number' ? config.successStatusMinimum : 200
            }
          />
        </Form.Item>
        <Form.Item label="Success through" style={{ width: '50%' }}>
          <InputNumber
            max={599}
            min={100}
            onChange={(value) => set('successStatusMaximum', value ?? 299)}
            value={
              typeof config.successStatusMaximum === 'number' ? config.successStatusMaximum : 299
            }
          />
        </Form.Item>
      </Space.Compact>
      {mappings.map((item, index) => (
        <Space direction="vertical" key={`mapping-${index}`} style={{ width: '100%' }}>
          <Input
            onChange={(event) =>
              set(
                'mappings',
                replaceAt(mappings, index, { ...item, sourcePath: event.target.value }),
              )
            }
            placeholder="response.data.customerId"
            value={stringValue(item.sourcePath)}
          />
          <Input
            onChange={(event) =>
              set(
                'mappings',
                replaceAt(mappings, index, { ...item, targetPath: event.target.value }),
              )
            }
            placeholder="crm.customerId"
            value={stringValue(item.targetPath)}
          />
          <Select
            onChange={(type) => set('mappings', replaceAt(mappings, index, { ...item, type }))}
            options={['json', 'string', 'number', 'boolean'].map((value) => ({
              label: value,
              value,
            }))}
            value={typeof item.type === 'string' ? item.type : 'json'}
          />
          <Checkbox
            checked={item.required === true}
            onChange={(event) =>
              set(
                'mappings',
                replaceAt(mappings, index, { ...item, required: event.target.checked }),
              )
            }
          >
            Required mapping
          </Checkbox>
          <Button danger onClick={() => set('mappings', removeAt(mappings, index))} size="small">
            Remove mapping
          </Button>
        </Space>
      ))}
      <Button
        disabled={mappings.length >= 20}
        onClick={() =>
          set('mappings', [
            ...mappings,
            {
              required: false,
              sourcePath: 'response.data',
              targetPath: 'http.result',
              type: 'json',
            },
          ])
        }
      >
        Add response mapping
      </Button>
    </Space>
  );

  const testTab = (
    <Space className="automation-http-section" direction="vertical" style={{ width: '100%' }}>
      <Alert
        message="Test performs a real bounded HTTPS request and does not publish the scenario."
        showIcon
        type="warning"
      />
      <Form.Item label="Sample variables JSON">
        <Input.TextArea
          onChange={(event) => setTestVariablesDraft(event.target.value)}
          rows={6}
          value={testVariablesDraft}
        />
      </Form.Item>
      <Button
        loading={testing}
        onClick={async () => {
          setTesting(true);
          try {
            const parsed = JSON.parse(testVariablesDraft) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
            setTestResult(await testRequest(config, parsed as Record<string, unknown>));
            setTestError(undefined);
          } catch (error) {
            setTestResult(undefined);
            setTestError(error instanceof ApiError ? error.code : 'REQUEST_FAILED');
          } finally {
            setTesting(false);
          }
        }}
        type="primary"
      >
        Test request
      </Button>
      {testError ? (
        <div className="automation-http-test-error" role="alert">
          <strong>Request blocked safely</strong>
          <span>{externalHttpSafeErrorMessage(testError)}</span>
          <code>{testError}</code>
        </div>
      ) : null}
      {testResult ? (
        <Alert
          description={
            <pre className="automation-http-preview">
              {JSON.stringify(
                {
                  data: testResult.data,
                  mappingKeys: testResult.mappingKeys,
                  outcome: testResult.outcome,
                  previewTruncated: testResult.previewTruncated,
                  sizeBytes: testResult.sizeBytes,
                  statusCode: testResult.statusCode,
                },
                null,
                2,
              )}
            </pre>
          }
          message="Safe response preview"
          type={testResult.outcome === 'success' ? 'success' : 'warning'}
        />
      ) : null}
    </Space>
  );

  return (
    <Tabs
      className="automation-http-tabs"
      items={[
        { children: requestTab, key: 'request', label: 'Request' },
        { children: headersTab, key: 'headers', label: 'Headers' },
        { children: bodyTab, key: 'body', label: 'Body' },
        { children: responseTab, key: 'response', label: 'Response' },
        { children: testTab, key: 'test', label: 'Test' },
      ]}
      size="small"
    />
  );
}

export function AutomationConditionFields({ condition, customFields, onChange }: ConditionProps) {
  const field = condition.field ?? 'message.text';
  const operator = conditionOperators.includes(condition.operator as ConditionOperator)
    ? (condition.operator as ConditionOperator)
    : 'exists';
  const fieldType = conditionFieldType(field, customFields);
  const operators = operatorsFor(fieldType);
  const selectedField = customFields.find(
    (candidate) => `contact.customFields.${candidate.key}` === field,
  );
  const update = (
    next: Partial<{ field: string; operator: ConditionOperator; value: unknown }>,
  ) => {
    const nextOperator = next.operator ?? operator;
    const nextField = next.field ?? field;
    const nextFieldType = conditionFieldType(nextField, customFields);
    const nextDefinition = customFields.find(
      (candidate) => `contact.customFields.${candidate.key}` === nextField,
    );
    const nextValue =
      next.value === undefined
        ? (condition.value ?? defaultComparisonValue(nextFieldType, nextDefinition))
        : next.value;
    onChange({
      field: nextField,
      operator: nextOperator,
      ...(['exists', 'not_exists'].includes(nextOperator) ? {} : { value: nextValue ?? '' }),
    });
  };
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Form.Item label="Field">
        <AutoComplete
          onChange={(value: string) => {
            const type = conditionFieldType(value, customFields);
            const nextOperator = operatorsFor(type).includes(operator) ? operator : 'equals';
            const definition = customFields.find(
              (candidate) => `contact.customFields.${candidate.key}` === value,
            );
            onChange({
              field: value,
              operator: nextOperator,
              ...(['exists', 'not_exists'].includes(nextOperator)
                ? {}
                : { value: defaultComparisonValue(type, definition) }),
            });
          }}
          options={conditionFieldOptions(customFields)}
          placeholder="Choose a field or enter crm.leadId"
          showSearch
          value={field}
        />
      </Form.Item>
      <Form.Item label="Operator">
        <Select
          onChange={(value: ConditionOperator) => update({ operator: value })}
          options={operators.map((value) => ({ label: conditionOperatorLabels[value], value }))}
          value={operator}
        />
      </Form.Item>
      {!['exists', 'not_exists'].includes(operator) ? (
        <Form.Item label="Comparison value">
          <ConditionValueInput
            field={selectedField}
            fieldType={fieldType}
            onChange={(value) => update({ value })}
            value={condition.value}
          />
        </Form.Item>
      ) : null}
    </Space>
  );
}

export function AutomationConditionGroupFields({
  customFields,
  group,
  onChange,
}: ConditionGroupProps) {
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Form.Item label="Match rules">
        <Select
          onChange={(combinator: 'AND' | 'OR') => onChange({ ...group, combinator })}
          options={[
            { label: 'All rules (AND)', value: 'AND' },
            { label: 'Any rule (OR)', value: 'OR' },
          ]}
          value={group.combinator}
        />
      </Form.Item>
      {group.rules.map((rule, index) => (
        <div className="automation-condition-rule" key={`${index}-${rule.field}`}>
          <Typography.Text strong>Rule {index + 1}</Typography.Text>
          <AutomationConditionFields
            condition={rule}
            customFields={customFields}
            onChange={(next) =>
              onChange({
                ...group,
                rules: group.rules.map((candidate, candidateIndex) =>
                  candidateIndex === index ? next : candidate,
                ),
              })
            }
          />
          {group.rules.length > 1 ? (
            <Button
              danger
              onClick={() =>
                onChange({
                  ...group,
                  rules: group.rules.filter((_, candidateIndex) => candidateIndex !== index),
                })
              }
              size="small"
            >
              Remove rule
            </Button>
          ) : null}
        </div>
      ))}
      <Button
        disabled={group.rules.length >= 20}
        onClick={() =>
          onChange({
            ...group,
            rules: [...group.rules, { field: 'message.text', operator: 'exists' }],
          })
        }
      >
        Add rule
      </Button>
    </Space>
  );
}

function DurationField({
  label,
  onChange,
  seconds,
}: {
  label: string;
  onChange(seconds: number): void;
  seconds: unknown;
}) {
  const parts = durationParts(seconds);
  return (
    <Form.Item label={label}>
      <div className="automation-duration-control">
        <InputNumber
          className="automation-duration-value"
          min={1}
          onChange={(value) => onChange(durationSeconds(value, parts.unit))}
          precision={0}
          value={parts.value}
        />
        <Select
          className="automation-duration-unit"
          onChange={(unit: DurationUnit) => onChange(durationSeconds(parts.value, unit))}
          options={Object.keys(durationUnits).map((unit) => ({ label: unit, value: unit }))}
          value={parts.unit}
        />
      </div>
    </Form.Item>
  );
}

function WaitCriteriaFields({
  criteria,
  onChange,
}: {
  criteria: Record<string, unknown>;
  onChange(criteria: Record<string, unknown>): void;
}) {
  const kind = typeof criteria.kind === 'string' ? criteria.kind : 'ANY';
  const setKind = (next: string) => {
    if (next === 'ANY') onChange({ kind: 'ANY' });
    else if (next === 'MEDIA') onChange({ kind: 'MEDIA', mediaTypes: ['PHOTO'] });
    else
      onChange({
        caseSensitive: next === 'CALLBACK',
        kind: next,
        operator: 'equals',
        value: '',
      });
  };
  return (
    <>
      <Form.Item label="Reply type">
        <Select
          onChange={setKind}
          options={[
            { label: 'Any supported customer reply', value: 'ANY' },
            { label: 'Text message', value: 'TEXT' },
            { label: 'Button callback', value: 'CALLBACK' },
            { label: 'Selected media types', value: 'MEDIA' },
          ]}
          value={kind}
        />
      </Form.Item>
      {kind === 'TEXT' || kind === 'CALLBACK' ? (
        <>
          <Form.Item label={kind === 'TEXT' ? 'Text comparison' : 'Callback comparison'}>
            <Select
              onChange={(operator) => onChange({ ...criteria, operator })}
              options={['equals', 'contains', 'starts_with', 'ends_with'].map((value) => ({
                label: conditionOperatorLabels[value as ConditionOperator],
                value,
              }))}
              value={typeof criteria.operator === 'string' ? criteria.operator : 'equals'}
            />
          </Form.Item>
          <Form.Item label={kind === 'TEXT' ? 'Expected text' : 'Expected callback data'}>
            <Input
              maxLength={kind === 'TEXT' ? 4096 : 64}
              onChange={(event) => onChange({ ...criteria, value: event.target.value })}
              value={typeof criteria.value === 'string' ? criteria.value : ''}
            />
          </Form.Item>
          <Checkbox
            checked={criteria.caseSensitive === true}
            onChange={(event) => onChange({ ...criteria, caseSensitive: event.target.checked })}
          >
            Case-sensitive comparison
          </Checkbox>
        </>
      ) : null}
      {kind === 'MEDIA' ? (
        <Form.Item label="Accepted media">
          <Select
            mode="multiple"
            onChange={(mediaTypes) => onChange({ kind: 'MEDIA', mediaTypes })}
            options={waitReplyMediaTypes.map((value) => ({
              label: mediaTypeLabels[value],
              value,
            }))}
            value={Array.isArray(criteria.mediaTypes) ? criteria.mediaTypes : []}
          />
        </Form.Item>
      ) : null}
    </>
  );
}

function ConditionValueInput({
  field,
  fieldType,
  onChange,
  value,
}: {
  field: AutomationCustomField | undefined;
  fieldType: AutomationCustomField['type'] | 'TEXT';
  onChange(value: unknown): void;
  value: unknown;
}) {
  if (fieldType === 'NUMBER')
    return <InputNumber onChange={onChange} style={{ width: '100%' }} value={numberValue(value)} />;
  if (fieldType === 'BOOLEAN')
    return (
      <Select
        onChange={onChange}
        options={[
          { label: 'True', value: true },
          { label: 'False', value: false },
        ]}
        value={typeof value === 'boolean' ? value : false}
      />
    );
  if (field && ['SELECT', 'MULTI_SELECT'].includes(fieldType))
    return (
      <Select
        onChange={onChange}
        options={(field.options ?? []).map((option) => ({ label: option, value: option }))}
        showSearch
        value={typeof value === 'string' ? value : undefined}
      />
    );
  return (
    <Input
      onChange={(event) => onChange(event.target.value)}
      type={fieldType === 'DATE' ? 'date' : fieldType === 'DATETIME' ? 'datetime-local' : 'text'}
      value={typeof value === 'string' ? value : ''}
    />
  );
}

function CustomFieldValueInput({
  field,
  onChange,
  value,
}: {
  field: AutomationCustomField;
  onChange(value: unknown): void;
  value: unknown;
}) {
  if (field.type === 'JSON') return <JsonValueInput onChange={onChange} value={value} />;
  if (field.type === 'MULTI_SELECT')
    return (
      <Select
        mode="multiple"
        onChange={onChange}
        options={(field.options ?? []).map((option) => ({ label: option, value: option }))}
        value={Array.isArray(value) ? value : []}
      />
    );
  return (
    <ConditionValueInput field={field} fieldType={field.type} onChange={onChange} value={value} />
  );
}

function JsonValueInput({ value, onChange }: { value: unknown; onChange(value: unknown): void }) {
  const serialized = JSON.stringify(value ?? {}, null, 2);
  const [draft, setDraft] = useState(serialized);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setDraft(serialized), [serialized]);
  return (
    <>
      <Input.TextArea
        {...(invalid ? { status: 'error' as const } : {})}
        onBlur={() => {
          try {
            onChange(JSON.parse(draft) as unknown);
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
        onChange={(event) => setDraft(event.target.value)}
        rows={5}
        value={draft}
      />
      {invalid ? <Typography.Text type="danger">Enter valid JSON.</Typography.Text> : null}
    </>
  );
}

function conditionFieldOptions(customFields: AutomationCustomField[]) {
  return [
    {
      label: 'Incoming event',
      options: [
        { label: 'Message text', value: 'message.text' },
        { label: 'Callback data', value: 'callback.data' },
        { label: 'Event type', value: 'event.type' },
      ],
    },
    {
      label: 'Execution variables',
      options: [
        {
          label: 'Mapped HTTP value (replace path)',
          value: 'crm.leadId',
        },
      ],
    },
    {
      label: 'Contact',
      options: [
        { label: 'Display name', value: 'contact.displayName' },
        { label: 'First name', value: 'contact.firstName' },
        { label: 'Last name', value: 'contact.lastName' },
        { label: 'Username', value: 'contact.username' },
        { label: 'Email', value: 'contact.email' },
        { label: 'Phone', value: 'contact.phone' },
      ],
    },
    {
      label: 'Custom fields',
      options: customFields.map((field) => ({
        label: `${field.name} (${field.type.toLowerCase()})`,
        value: `contact.customFields.${field.key}`,
      })),
    },
  ];
}

function automationVariableOptions(customFields: AutomationCustomField[]) {
  return [
    {
      label: 'Contact',
      options: ['displayName', 'firstName', 'lastName', 'username', 'email', 'phone'].map(
        (field) => ({ label: field, value: `contact.${field}` }),
      ),
    },
    {
      label: 'Contact custom fields',
      options: customFields
        .filter((field) => field.type !== 'JSON' && field.type !== 'MULTI_SELECT')
        .map((field) => ({
          label: field.name,
          value: `contact.customFields.${field.key}`,
        })),
    },
    {
      label: 'Incoming event',
      options: [
        { label: 'Event type', value: 'event.type' },
        { label: 'Message text', value: 'event.content.text' },
        { label: 'Callback data', value: 'event.content.data' },
      ],
    },
  ];
}

function operatorsFor(type: AutomationCustomField['type'] | 'TEXT'): ConditionOperator[] {
  if (type === 'NUMBER')
    return [
      'equals',
      'not_equals',
      'greater_than',
      'greater_or_equal',
      'less_than',
      'less_or_equal',
      'exists',
      'not_exists',
    ];
  if (type === 'BOOLEAN') return ['equals', 'not_equals', 'exists', 'not_exists'];
  if (type === 'MULTI_SELECT') return ['contains', 'exists', 'not_exists'];
  if (type === 'JSON') return ['exists', 'not_exists'];
  return ['equals', 'not_equals', 'contains', 'starts_with', 'ends_with', 'exists', 'not_exists'];
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function objectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(record) : [];
}

function replaceAt(
  values: Array<Record<string, unknown>>,
  index: number,
  value: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return values.map((candidate, candidateIndex) => (candidateIndex === index ? value : candidate));
}

function removeAt(
  values: Array<Record<string, unknown>>,
  index: number,
): Array<Record<string, unknown>> {
  return values.filter((_, candidateIndex) => candidateIndex !== index);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function defaultComparisonValue(
  type: AutomationCustomField['type'] | 'TEXT',
  field: AutomationCustomField | undefined,
): unknown {
  if (type === 'NUMBER') return 0;
  if (type === 'BOOLEAN') return false;
  if (type === 'SELECT' || type === 'MULTI_SELECT') return field?.options?.[0] ?? '';
  return '';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

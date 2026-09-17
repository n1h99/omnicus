import { Alert, Button, Form, Input, Select, Space, Spin, Typography, message } from 'antd';
import { useNavigate, useParams } from 'react-router';

import { getUserErrorMessage } from '../api';
import { useContactAudienceOptions, type AudienceSelection } from '../audience-api';
import { AudienceSelector } from '../audience-selector';
import { useBroadcastMutations, type BroadcastAudience } from '../broadcasts-api';
import { channelAccountLabel, channelProviderLabel } from '../channel-provider';
import { useChannels } from '../channels-api';
import { useMediaAssets } from '../media-api';
import { useTemplates } from '../templates-api';
import {
  assetKindForWhatsAppSlot,
  whatsAppParameterSlots,
  whatsAppTemplateComponents,
  whatsAppTemplateComposerIssue,
} from '../whatsapp-template-composer';
import { useWhatsAppTemplates } from '../whatsapp-templates-api';

type BroadcastFormValues = {
  audienceMode: AudienceSelection['mode'];
  contactIds?: string[];
  connectionId: string;
  contentMode: 'TEMPLATE' | 'TEXT' | 'WHATSAPP_TEMPLATE';
  excludeTagIds?: string[];
  includeTagIds?: string[];
  name: string;
  segmentId?: string;
  templateVersionId?: string;
  text?: string;
  whatsAppParameters?: Record<string, string>;
  whatsAppTemplateId?: string;
};

export function BroadcastCreatePage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const channels = useChannels(projectId);
  const templates = useTemplates(projectId);
  const assets = useMediaAssets(projectId);
  const mutations = useBroadcastMutations(projectId);
  const [form] = Form.useForm<BroadcastFormValues>();
  const connectionId = Form.useWatch('connectionId', form);
  const audienceMode = Form.useWatch('audienceMode', form) ?? 'ALL_ACTIVE';
  const contactIds = Form.useWatch('contactIds', form);
  const segmentId = Form.useWatch('segmentId', form);
  const includeTagIds = Form.useWatch('includeTagIds', form);
  const excludeTagIds = Form.useWatch('excludeTagIds', form);
  const contentMode = Form.useWatch('contentMode', form) ?? 'TEXT';
  const whatsAppTemplateId = Form.useWatch('whatsAppTemplateId', form);
  const selectedChannel = (channels.data ?? []).find((channel) => channel.id === connectionId);
  const isWhatsApp = selectedChannel?.type === 'WHATSAPP';
  const audienceOptions = useContactAudienceOptions(projectId, connectionId, Boolean(connectionId));
  const whatsAppTemplates = useWhatsAppTemplates(projectId, isWhatsApp ? connectionId : undefined);
  const selectedWhatsAppTemplate = whatsAppTemplates.data?.find(
    (template) => template.id === whatsAppTemplateId,
  );
  const parameterSlots = whatsAppParameterSlots(selectedWhatsAppTemplate);

  if (channels.isLoading || templates.isLoading)
    return <Spin className="route-loading" size="large" />;

  return (
    <section className="narrow-page broadcast-create-page">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>New broadcast</Typography.Title>
          <Typography.Text type="secondary">
            Choose the channel first. Omnicus applies the delivery rules for that provider.
          </Typography.Text>
        </div>
      </div>
      <Form<BroadcastFormValues>
        className="settings-form surface"
        form={form}
        initialValues={{ audienceMode: 'ALL_ACTIVE', contentMode: 'TEXT' }}
        layout="vertical"
        onFinish={async (values) => {
          try {
            const components = whatsAppTemplateComponents(
              parameterSlots,
              values.whatsAppParameters,
            );
            const whatsappTemplate = values.whatsAppTemplateId
              ? {
                  templateId: values.whatsAppTemplateId,
                  ...(components ? { components } : {}),
                }
              : undefined;
            const audience: BroadcastAudience = {
              mode: values.audienceMode,
              ...(values.contactIds?.length ? { contactIds: values.contactIds } : {}),
              ...(values.excludeTagIds?.length ? { excludeTagIds: values.excludeTagIds } : {}),
              ...(values.includeTagIds?.length ? { includeTagIds: values.includeTagIds } : {}),
              ...(values.segmentId ? { segmentId: values.segmentId } : {}),
            };
            const broadcast = await mutations.create.mutateAsync({
              audience,
              connectionId: values.connectionId,
              name: values.name,
              ...(isWhatsApp
                ? { whatsAppTemplate: whatsappTemplate! }
                : values.contentMode === 'TEMPLATE'
                  ? { templateVersionId: values.templateVersionId! }
                  : { text: values.text! }),
            });
            void message.success('Broadcast draft created.');
            void navigate(`/projects/${projectId}/broadcasts/${broadcast.id}`);
          } catch (error) {
            void message.error(getUserErrorMessage(error, 'Broadcast could not be created.'));
          }
        }}
        requiredMark={false}
      >
        {channels.isError ? (
          <Alert
            className="form-alert"
            message={getUserErrorMessage(channels.error, 'Channels could not be loaded.')}
            showIcon
            type="error"
          />
        ) : null}
        <Form.Item
          label="Name"
          name="name"
          rules={[{ message: 'Enter a name for this broadcast', required: true }]}
        >
          <Input maxLength={120} />
        </Form.Item>
        <Form.Item
          label="Channel"
          name="connectionId"
          rules={[{ message: 'Choose an active channel', required: true }]}
        >
          <Select
            onChange={(id: string) => {
              const channel = (channels.data ?? []).find((candidate) => candidate.id === id);
              form.resetFields([
                'contactIds',
                'excludeTagIds',
                'includeTagIds',
                'segmentId',
                'templateVersionId',
                'text',
                'whatsAppParameters',
                'whatsAppTemplateId',
              ]);
              form.setFieldsValue({
                audienceMode: 'ALL_ACTIVE',
                contentMode: channel?.type === 'WHATSAPP' ? 'WHATSAPP_TEMPLATE' : 'TEXT',
              });
            }}
            options={(channels.data ?? [])
              .filter((channel) => channel.status === 'ACTIVE')
              .map((channel) => ({
                label: `${channelProviderLabel(channel.type)} — ${channel.name} (${channelAccountLabel(channel)})`,
                value: channel.id,
              }))}
            optionFilterProp="label"
            placeholder="Choose Telegram or WhatsApp"
            showSearch
          />
        </Form.Item>

        {selectedChannel ? (
          <Alert
            className="broadcast-provider-rule"
            description={
              isWhatsApp
                ? 'A WhatsApp broadcast always uses one approved Meta template. It includes active WhatsApp contacts only; send it only to people whose business-message consent you have recorded.'
                : 'Telegram broadcasts can use direct text or an immutable published Omnicus template.'
            }
            message={`${channelProviderLabel(selectedChannel.type)} delivery rule`}
            showIcon
            type="info"
          />
        ) : null}

        <div className="broadcast-audience-section">
          <Typography.Title level={4}>Audience</Typography.Title>
          <AudienceSelector
            allLabel={
              isWhatsApp ? 'All eligible WhatsApp contacts' : 'All active Telegram contacts'
            }
            description={
              isWhatsApp
                ? 'Only active, reachable contacts with recorded WhatsApp consent are included when the broadcast starts.'
                : 'Only active contacts connected to this Telegram account are included when the broadcast starts.'
            }
            disabled={!selectedChannel}
            loading={audienceOptions.isLoading}
            onChange={(audience) => {
              form.setFieldValue('audienceMode', audience.mode);
              form.setFieldValue('contactIds', audience.contactIds);
              form.setFieldValue('excludeTagIds', audience.excludeTagIds);
              form.setFieldValue('includeTagIds', audience.includeTagIds);
              form.setFieldValue('segmentId', audience.segmentId);
            }}
            {...(audienceOptions.data ? { options: audienceOptions.data } : {})}
            value={{
              mode: audienceMode,
              ...(contactIds ? { contactIds } : {}),
              ...(excludeTagIds ? { excludeTagIds } : {}),
              ...(includeTagIds ? { includeTagIds } : {}),
              ...(segmentId ? { segmentId } : {}),
            }}
          />
          {audienceOptions.isError && selectedChannel ? (
            <Alert
              className="form-alert"
              message={getUserErrorMessage(
                audienceOptions.error,
                'Contact groups and audience options could not be loaded.',
              )}
              showIcon
              type="error"
            />
          ) : null}
        </div>
        <Form.Item hidden name="audienceMode" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item
          hidden
          name="segmentId"
          rules={[
            ({ getFieldValue }) => ({
              validator: async (_, value) => {
                if (getFieldValue('audienceMode') !== 'SEGMENT' || value) return;
                throw new Error('Choose a contact group');
              },
            }),
          ]}
        >
          <Input />
        </Form.Item>
        <Form.Item
          hidden
          name="contactIds"
          rules={[
            ({ getFieldValue }) => ({
              validator: async (_, value: string[] | undefined) => {
                if (getFieldValue('audienceMode') !== 'CONTACTS' || value?.length) return;
                throw new Error('Choose at least one contact');
              },
            }),
          ]}
        >
          <Select mode="multiple" />
        </Form.Item>
        <Form.Item hidden name="includeTagIds">
          <Select mode="multiple" />
        </Form.Item>
        <Form.Item hidden name="excludeTagIds">
          <Select mode="multiple" />
        </Form.Item>

        {!selectedChannel ? null : isWhatsApp ? (
          <>
            <Form.Item
              extra="Only templates currently approved by Meta can be selected."
              label="Approved WhatsApp template"
              name="whatsAppTemplateId"
              rules={[{ message: 'Choose an approved WhatsApp template', required: true }]}
            >
              <Select
                loading={whatsAppTemplates.isLoading}
                onChange={() => form.setFieldValue('whatsAppParameters', undefined)}
                notFoundContent={
                  whatsAppTemplates.isError
                    ? 'Templates could not be loaded'
                    : 'Sync an approved template from Meta first'
                }
                options={(whatsAppTemplates.data ?? [])
                  .filter((template) => template.status === 'APPROVED')
                  .map((template) => {
                    const issue = whatsAppTemplateComposerIssue(template);
                    return {
                      disabled: Boolean(issue),
                      label: `${template.name} — ${template.languageCode} · ${
                        issue ?? template.category.toLowerCase()
                      }`,
                      value: template.id,
                    };
                  })}
                optionFilterProp="label"
                placeholder="Choose an approved template"
                showSearch
              />
            </Form.Item>

            {whatsAppTemplates.isError ? (
              <Alert
                className="form-alert"
                message={getUserErrorMessage(
                  whatsAppTemplates.error,
                  'Approved WhatsApp templates could not be loaded.',
                )}
                showIcon
                type="error"
              />
            ) : null}

            {selectedWhatsAppTemplate ? (
              <div className="broadcast-whatsapp-template-preview">
                <strong>{selectedWhatsAppTemplate.name}</strong>
                <span>
                  {selectedWhatsAppTemplate.languageCode} ·{' '}
                  {selectedWhatsAppTemplate.category.toLowerCase()}
                </span>
                {selectedWhatsAppTemplate.components.map((component, index) =>
                  component.text ? (
                    <Typography.Paragraph key={`${component.type}-${index}`}>
                      {component.text}
                    </Typography.Paragraph>
                  ) : null,
                )}
              </div>
            ) : null}

            {parameterSlots.length ? (
              <div className="broadcast-template-parameters">
                <Typography.Text strong>Template values</Typography.Text>
                <Typography.Paragraph type="secondary">
                  Enter a value for every variable exactly in the order approved by Meta.
                </Typography.Paragraph>
                {parameterSlots.map((slot) => (
                  <Form.Item
                    key={slot.key}
                    label={slot.label}
                    name={['whatsAppParameters', slot.key]}
                    rules={[{ message: `Add ${slot.label.toLowerCase()}`, required: true }]}
                  >
                    {slot.kind === 'media' ? (
                      <Select
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
                      />
                    ) : (
                      <Input
                        placeholder={
                          slot.kind === 'quick_reply'
                            ? 'Safe payload returned when the contact taps this reply'
                            : slot.kind === 'url'
                              ? 'Dynamic part appended to the approved button URL'
                              : 'Value sent to each recipient'
                        }
                      />
                    )}
                  </Form.Item>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <>
            <Form.Item label="Content" name="contentMode">
              <Select
                options={[
                  { label: 'Text', value: 'TEXT' },
                  { label: 'Published template', value: 'TEMPLATE' },
                ]}
              />
            </Form.Item>
            {contentMode === 'TEMPLATE' ? (
              <Form.Item label="Template" name="templateVersionId" rules={[{ required: true }]}>
                <Select
                  options={(templates.data ?? [])
                    .filter((template) => template.status === 'PUBLISHED' && template.activeVersion)
                    .map((template) => ({
                      label: `${template.name} (${template.activeVersion!.kind})`,
                      value: template.activeVersion!.id,
                    }))}
                />
              </Form.Item>
            ) : (
              <Form.Item label="Text" name="text" rules={[{ required: true }]}>
                <Input.TextArea maxLength={4096} rows={6} />
              </Form.Item>
            )}
          </>
        )}

        <Space>
          <Button htmlType="submit" loading={mutations.create.isPending} type="primary">
            Create
          </Button>
          <Button onClick={() => navigate(-1)}>Cancel</Button>
        </Space>
      </Form>
    </section>
  );
}

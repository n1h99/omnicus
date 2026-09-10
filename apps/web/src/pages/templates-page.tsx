import { UndoOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Table,
  Typography,
  message,
} from 'antd';
import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router';

import { getUserErrorMessage } from '../api';
import { useMediaAssets } from '../media-api';
import { hasProjectPermission, useProjectAccess } from '../project-access';
import { StatusText } from '../status-text';
import {
  type MessageTemplate,
  type TelegramInlineKeyboardButton,
  type TemplateInput,
  useTemplateMutations,
  useTemplates,
} from '../templates-api';
import { WhatsAppTemplatesPanel } from '../whatsapp-templates-panel';

type TemplateFormInput = Omit<TemplateInput, 'inlineKeyboard'> & {
  buttonRows?: Array<{ buttons?: TelegramInlineKeyboardButton[] }>;
};

export function TemplatesPage() {
  const { projectId } = useParams();
  const [view, setView] = useState<'active' | 'archived'>('active');
  const [searchParams, setSearchParams] = useSearchParams();
  const providerView = searchParams.get('provider') === 'WHATSAPP' ? 'WHATSAPP' : 'OMNICUS';
  const setProviderView = (provider: 'OMNICUS' | 'WHATSAPP') => setSearchParams({ provider });
  const templates = useTemplates(projectId, view === 'archived');
  const assets = useMediaAssets(projectId);
  const access = useProjectAccess(projectId);
  const mutations = useTemplateMutations(projectId);
  const canManage = hasProjectPermission(access.data, 'templates:manage');
  const [editing, setEditing] = useState<MessageTemplate | 'new'>();
  const [previewing, setPreviewing] = useState<MessageTemplate>();
  const [archiving, setArchiving] = useState<MessageTemplate>();
  const [previewVariables, setPreviewVariables] = useState(
    JSON.stringify({ contact: { firstName: 'Eldar' } }, null, 2),
  );
  const [previewResult, setPreviewResult] = useState<{
    missing: string[];
    output: string;
  }>();
  const [form] = Form.useForm<TemplateFormInput>();
  const kind = Form.useWatch('kind', form) ?? 'TEXT';

  const open = (template?: MessageTemplate) => {
    setEditing(template ?? 'new');
    const version = template?.draftVersion ?? template?.activeVersion;
    form.setFieldsValue({
      kind: version?.kind ?? 'TEXT',
      name: template?.name ?? '',
      ...(template?.description ? { description: template.description } : {}),
      ...(version?.mediaAssetId ? { mediaAssetId: version.mediaAssetId } : {}),
      ...(version?.content.caption !== undefined ? { caption: version.content.caption } : {}),
      ...(version?.content.inlineKeyboard
        ? {
            buttonRows: version.content.inlineKeyboard.map((buttons) => ({
              buttons,
            })),
          }
        : {}),
      ...(version?.content.text !== undefined ? { text: version.content.text } : {}),
    });
  };

  const save = async (values: TemplateFormInput) => {
    try {
      const input: TemplateInput = {
        ...values,
        ...(values.buttonRows?.length
          ? {
              inlineKeyboard: values.buttonRows
                .map((row) => row.buttons ?? [])
                .filter((row) => row.length > 0),
            }
          : {}),
      };
      delete (input as TemplateInput & { buttonRows?: unknown }).buttonRows;
      if (editing === 'new') await mutations.create.mutateAsync(input);
      else if (editing) await mutations.update.mutateAsync({ id: editing.id, ...input });
      setEditing(undefined);
      form.resetFields();
      void message.success('Template draft saved.');
    } catch (error) {
      void message.error(getUserErrorMessage(error, 'Template could not be saved.'));
    }
  };

  if (providerView === 'WHATSAPP') {
    return (
      <section>
        <div className="page-heading-row">
          <div>
            <Typography.Title level={2}>Message templates</Typography.Title>
            <Typography.Text type="secondary">
              Reusable content for Telegram and Meta-approved WhatsApp conversations.
            </Typography.Text>
          </div>
        </div>
        <Segmented
          className="channel-template-provider-switch segmented-switcher"
          onChange={(value) => setProviderView(value as 'OMNICUS' | 'WHATSAPP')}
          options={[
            { label: 'Telegram', value: 'OMNICUS' },
            { label: 'WhatsApp', value: 'WHATSAPP' },
          ]}
          value={providerView}
        />
        <WhatsAppTemplatesPanel
          canManage={hasProjectPermission(access.data, 'channels:manage')}
          projectId={projectId}
        />
      </section>
    );
  }

  return (
    <section>
      <div className="page-heading-row">
        <div>
          <Typography.Title level={2}>Message templates</Typography.Title>
          <Typography.Text type="secondary">
            Reusable content for Telegram and Meta-approved WhatsApp conversations.
          </Typography.Text>
        </div>
      </div>
      <div className="list-page-action-row">
        <div className="list-page-action-left-group">
          <Segmented
            className="channel-template-provider-switch segmented-switcher"
            onChange={(value) => setProviderView(value as 'OMNICUS' | 'WHATSAPP')}
            options={[
              { label: 'Telegram', value: 'OMNICUS' },
              { label: 'WhatsApp', value: 'WHATSAPP' },
            ]}
            value={providerView}
          />
          <Segmented
            className="archive-view-switch segmented-switcher"
            onChange={(value) => setView(value as 'active' | 'archived')}
            options={[
              { label: 'Active templates', value: 'active' },
              { label: 'Archived', value: 'archived' },
            ]}
            value={view}
          />
        </div>
        {canManage ? (
          <Button className="list-page-action-button" onClick={() => open()} type="primary">
            New Template
          </Button>
        ) : null}
      </div>
      {templates.isError ? (
        <Alert
          message={getUserErrorMessage(templates.error, 'Templates could not be loaded.')}
          showIcon
          type="error"
        />
      ) : null}
      <Table<MessageTemplate>
        {...(templates.isPlaceholderData
          ? {
              locale: {
                emptyText: <Typography.Text type="secondary">Updating view…</Typography.Text>,
              },
            }
          : {})}
        aria-busy={templates.isPlaceholderData}
        className={`archive-state-table query-transition-table${templates.isPlaceholderData ? ' is-query-updating' : ''}`}
        dataSource={templates.data ?? []}
        loading={templates.isLoading}
        rowKey="id"
        scroll={{ x: 1040 }}
        tableLayout="fixed"
        columns={[
          { dataIndex: 'name', ellipsis: true, title: 'Name', width: 360 },
          {
            title: 'Kind',
            render: (_, template) => (template.draftVersion ?? template.activeVersion)?.kind ?? '—',
            width: 210,
          },
          {
            dataIndex: 'status',
            render: (value) => <StatusText status={value} />,
            title: 'Status',
            width: 150,
          },
          {
            key: 'actions',
            render: (_, template) =>
              templates.isPlaceholderData ? null : (
                <Space className="archive-table-actions" size={8}>
                  <Button
                    onClick={() => {
                      setPreviewing(template);
                      setPreviewResult(undefined);
                    }}
                    size="small"
                  >
                    Preview
                  </Button>
                  {canManage && template.status !== 'ARCHIVED' ? (
                    <Button
                      className="template-edit-button"
                      onClick={() => open(template)}
                      size="small"
                    >
                      Edit
                    </Button>
                  ) : null}
                  {canManage && template.status !== 'ARCHIVED' && template.draftVersion ? (
                    <Button
                      loading={mutations.publish.isPending}
                      onClick={async () => {
                        try {
                          await mutations.publish.mutateAsync(template.id);
                          void message.success('Template published.');
                        } catch (error) {
                          void message.error(
                            getUserErrorMessage(error, 'Template could not be published.'),
                          );
                        }
                      }}
                      size="small"
                      type="primary"
                    >
                      Publish
                    </Button>
                  ) : null}
                  {canManage && template.status !== 'ARCHIVED' ? (
                    <Button danger onClick={() => setArchiving(template)} size="small">
                      Archive
                    </Button>
                  ) : null}
                  {canManage && template.status === 'ARCHIVED' ? (
                    <Button
                      icon={<UndoOutlined />}
                      loading={mutations.restore.isPending}
                      onClick={async () => {
                        try {
                          await mutations.restore.mutateAsync(template.id);
                          void message.success('Template restored.');
                        } catch (error) {
                          void message.error(
                            getUserErrorMessage(error, 'Template could not be restored.'),
                          );
                        }
                      }}
                      size="small"
                      type="primary"
                    >
                      Restore
                    </Button>
                  ) : null}
                </Space>
              ),
            title: 'Actions',
            width: 320,
          },
        ]}
      />
      <Modal
        cancelText="Keep template"
        centered
        className="confirm-dialog"
        okButtonProps={{ danger: true, loading: mutations.archive.isPending }}
        okText="Archive template"
        onCancel={() => setArchiving(undefined)}
        onOk={async () => {
          if (!archiving) return;
          try {
            await mutations.archive.mutateAsync(archiving.id);
            setArchiving(undefined);
            void message.success('Template archived.');
          } catch (error) {
            void message.error(getUserErrorMessage(error, 'Template could not be archived.'));
          }
        }}
        open={Boolean(archiving)}
        title="Archive this template?"
      >
        <Typography.Paragraph type="secondary">
          {archiving?.name} will be removed from the active template library. Published scenario
          versions keep their existing content snapshot.
        </Typography.Paragraph>
      </Modal>
      <Modal
        destroyOnHidden
        footer={null}
        onCancel={() => setEditing(undefined)}
        open={Boolean(editing)}
        title={editing === 'new' ? 'New template' : 'Edit template draft'}
      >
        <Form form={form} initialValues={{ kind: 'TEXT' }} layout="vertical" onFinish={save}>
          <Form.Item label="Name" name="name" rules={[{ required: true }]}>
            <Input maxLength={120} />
          </Form.Item>
          <Form.Item label="Description" name="description">
            <Input.TextArea maxLength={500} />
          </Form.Item>
          <Form.Item label="Type" name="kind" rules={[{ required: true }]}>
            <Select
              options={[
                { label: 'Text', value: 'TEXT' },
                { label: 'Photo', value: 'PHOTO' },
                { label: 'Document', value: 'DOCUMENT' },
                { label: 'Video', value: 'VIDEO' },
                { label: 'Audio', value: 'AUDIO' },
                { label: 'Voice message', value: 'VOICE' },
                { label: 'Video note', value: 'VIDEO_NOTE' },
                { label: 'Animation', value: 'ANIMATION' },
                { label: 'Sticker', value: 'STICKER' },
              ]}
            />
          </Form.Item>
          {kind === 'TEXT' ? (
            <Form.Item label="Text" name="text" rules={[{ required: true }]}>
              <Input.TextArea maxLength={4096} rows={6} />
            </Form.Item>
          ) : (
            <>
              <Form.Item label="Media asset" name="mediaAssetId" rules={[{ required: true }]}>
                <Select
                  options={(assets.data ?? [])
                    .filter((asset) => asset.status === 'AVAILABLE' && asset.kind === kind)
                    .map((asset) => ({
                      label: asset.originalFilename ?? asset.id,
                      value: asset.id,
                    }))}
                />
              </Form.Item>
              {kind === 'VIDEO_NOTE' || kind === 'STICKER' ? null : (
                <Form.Item label="Caption" name="caption">
                  <Input.TextArea maxLength={1024} rows={4} />
                </Form.Item>
              )}
            </>
          )}
          <Form.List name="buttonRows">
            {(rows, { add: addRow, remove: removeRow }) => (
              <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text strong>Inline buttons</Typography.Text>
                {rows.map((row, rowIndex) => (
                  <Space
                    align="start"
                    className="template-button-row"
                    direction="vertical"
                    key={row.key}
                  >
                    <Space>
                      <Typography.Text>Row {rowIndex + 1}</Typography.Text>
                      <Button danger onClick={() => removeRow(row.name)} size="small">
                        Remove row
                      </Button>
                    </Space>
                    <Form.List name={[row.name, 'buttons']}>
                      {(buttons, { add: addButton, remove: removeButton }) => (
                        <Space direction="vertical" style={{ width: '100%' }}>
                          {buttons.map((button) => (
                            <Space align="start" key={button.key} wrap>
                              <Form.Item
                                label="Label"
                                name={[button.name, 'text']}
                                rules={[{ required: true }]}
                              >
                                <Input maxLength={64} placeholder="Up to 1 000" />
                              </Form.Item>
                              <Form.Item label="Callback data" name={[button.name, 'callbackData']}>
                                <Input maxLength={64} placeholder="budget:under_1000" />
                              </Form.Item>
                              <Form.Item label="URL" name={[button.name, 'url']}>
                                <Input placeholder="https://…" />
                              </Form.Item>
                              <Button danger onClick={() => removeButton(button.name)}>
                                Remove
                              </Button>
                            </Space>
                          ))}
                          <Button
                            disabled={buttons.length >= 8}
                            onClick={() => addButton({ callbackData: '', text: '' })}
                            size="small"
                          >
                            Add button
                          </Button>
                        </Space>
                      )}
                    </Form.List>
                  </Space>
                ))}
                <Button
                  disabled={rows.length >= 8}
                  onClick={() => addRow({ buttons: [{ callbackData: '', text: '' }] })}
                >
                  Add button row
                </Button>
                <Typography.Text type="secondary">
                  Set exactly one action per button: callback data for automation, or an HTTP(S)
                  URL.
                </Typography.Text>
              </Space>
            )}
          </Form.List>
          <Typography.Paragraph type="secondary">
            Variables use paths such as {'{{contact.firstName}}'} and are checked during preview or
            execution.
          </Typography.Paragraph>
          <Button
            htmlType="submit"
            loading={mutations.create.isPending || mutations.update.isPending}
            type="primary"
          >
            Save draft
          </Button>
        </Form>
      </Modal>
      <Modal
        footer={null}
        onCancel={() => setPreviewing(undefined)}
        open={Boolean(previewing)}
        title="Template preview"
      >
        <Typography.Paragraph type="secondary">
          Provide JSON variables. Preview never sends a provider message.
        </Typography.Paragraph>
        <Input.TextArea
          aria-label="Preview variables"
          onChange={(event) => setPreviewVariables(event.target.value)}
          rows={8}
          value={previewVariables}
        />
        <Button
          loading={mutations.preview.isPending}
          onClick={async () => {
            if (!previewing) return;
            let variables: Record<string, unknown>;
            try {
              const parsed = JSON.parse(previewVariables) as unknown;
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
              variables = parsed as Record<string, unknown>;
            } catch {
              setPreviewResult(undefined);
              void message.error('Preview could not be rendered. Variables must be a JSON object.');
              return;
            }
            try {
              const result = await mutations.preview.mutateAsync({
                id: previewing.id,
                variables,
              });
              setPreviewResult(result);
            } catch (error) {
              setPreviewResult(undefined);
              void message.error(getUserErrorMessage(error, 'Preview could not be rendered.'));
            }
          }}
          style={{ marginTop: 12 }}
          type="primary"
        >
          Render preview
        </Button>
        {previewResult ? (
          <Space direction="vertical" style={{ marginTop: 16, width: '100%' }}>
            {previewResult.missing.length ? (
              <StatusText label={`Missing: ${previewResult.missing.join(', ')}`} status="PENDING" />
            ) : (
              <StatusText label="All variables resolved" status="SUCCEEDED" />
            )}
            <Typography.Paragraph copyable>
              {previewResult.output || '(empty output)'}
            </Typography.Paragraph>
          </Space>
        ) : null}
      </Modal>
    </section>
  );
}

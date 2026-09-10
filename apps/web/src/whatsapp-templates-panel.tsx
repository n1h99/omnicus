import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Typography,
  message,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';

import { getUserErrorMessage } from './api';
import { channelAccountLabel } from './channel-provider';
import { useChannels } from './channels-api';
import { humanizeStatus } from './humanize';
import { StatusText } from './status-text';
import { WhatsAppTemplateEditor } from './whatsapp-template-editor';
import {
  type WhatsAppMessageTemplate,
  type WhatsAppTemplateComponent,
  useWhatsAppTemplateMutations,
  useWhatsAppTemplates,
} from './whatsapp-templates-api';

function componentLabel(component: WhatsAppTemplateComponent) {
  const labels = {
    BODY: 'Body',
    BUTTONS: 'Buttons',
    FOOTER: 'Footer',
    HEADER: 'Header',
  } as const;
  return labels[component.type];
}

export function WhatsAppTemplatesPanel({
  canManage,
  projectId,
}: {
  canManage: boolean;
  projectId: string | undefined;
}) {
  const channels = useChannels(projectId);
  const whatsappChannels = useMemo(
    () => (channels.data ?? []).filter((channel) => channel.type === 'WHATSAPP'),
    [channels.data],
  );
  const [connectionId, setConnectionId] = useState<string>();
  const [previewing, setPreviewing] = useState<WhatsAppMessageTemplate>();
  const [editing, setEditing] = useState<{
    template?: WhatsAppMessageTemplate;
    duplicate?: boolean;
  }>();
  const [deleting, setDeleting] = useState<WhatsAppMessageTemplate>();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>();
  const templates = useWhatsAppTemplates(projectId, connectionId);
  const mutations = useWhatsAppTemplateMutations(projectId, connectionId);
  const connection = whatsappChannels.find((channel) => channel.id === connectionId);

  useEffect(() => {
    setEditing(undefined);
    setDeleting(undefined);
    setPreviewing(undefined);
  }, [projectId, connectionId]);

  useEffect(() => {
    if (!connectionId && whatsappChannels[0]) setConnectionId(whatsappChannels[0].id);
    if (connectionId && !whatsappChannels.some((channel) => channel.id === connectionId)) {
      setConnectionId(whatsappChannels[0]?.id);
    }
  }, [connectionId, whatsappChannels]);

  if (channels.isError) {
    return (
      <Alert
        message={getUserErrorMessage(channels.error, 'WhatsApp channels could not be loaded.')}
        showIcon
        type="error"
      />
    );
  }

  if (!channels.isLoading && !whatsappChannels.length) {
    return (
      <Card className="whatsapp-template-empty">
        <Empty
          description="Connect a WhatsApp Business channel before syncing Meta templates."
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      </Card>
    );
  }

  return (
    <div className="whatsapp-template-workspace">
      <Alert
        className="channel-soft-notice"
        description="Create templates here and submit them to Meta. Once approved, they are available in broadcasts and automations. Templates are shared by all numbers in the same WhatsApp Business Account."
        message="WhatsApp templates"
        showIcon
        type="info"
      />
      <Card className="whatsapp-template-toolbar">
        <div className="whatsapp-template-channel-picker">
          <Typography.Text strong>WhatsApp channel</Typography.Text>
          <Select
            loading={channels.isLoading}
            onChange={setConnectionId}
            disabled={Boolean(editing || deleting)}
            optionFilterProp="label"
            options={whatsappChannels.map((channel) => ({
              label: `${channel.name} · ${channelAccountLabel(channel)}`,
              value: channel.id,
            }))}
            placeholder="Choose a business number"
            showSearch
            value={connectionId}
          />
        </div>
        {canManage ? (
          <div className="whatsapp-template-toolbar-actions">
            <Button
              disabled={!connectionId || connection?.status !== 'ACTIVE'}
              icon={<PlusOutlined />}
              type="primary"
              onClick={() => setEditing({})}
            >
              New template
            </Button>
            <Button
              disabled={!connectionId || connection?.status !== 'ACTIVE'}
              icon={<ReloadOutlined />}
              loading={mutations.sync.isPending}
              onClick={async () => {
                try {
                  await mutations.sync.mutateAsync();
                  void message.success('WhatsApp templates synced from Meta.');
                } catch (error) {
                  void message.error(
                    getUserErrorMessage(error, 'WhatsApp templates could not be synced.'),
                  );
                }
              }}
            >
              Sync from Meta
            </Button>
          </div>
        ) : null}
      </Card>

      {connection && connection.status !== 'ACTIVE' ? (
        <Alert
          className="form-alert"
          description="Finish and activate this WhatsApp connection before requesting its approved templates from Meta."
          message="Channel is not active"
          showIcon
          type="warning"
        />
      ) : null}
      {templates.isError ? (
        <Alert
          className="form-alert"
          message={getUserErrorMessage(templates.error, 'WhatsApp templates could not be loaded.')}
          showIcon
          type="error"
        />
      ) : null}

      <Space wrap className="wa-template-filters">
        <Input.Search
          aria-label="Search WhatsApp templates"
          placeholder="Search templates"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          allowClear
        />
        <Select
          aria-label="Filter Meta status"
          placeholder="All statuses"
          allowClear
          value={statusFilter}
          onChange={setStatusFilter}
          style={{ minWidth: 160 }}
          options={['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'UNKNOWN'].map(
            (value) => ({ value, label: humanizeStatus(value) }),
          )}
        />
      </Space>
      <Table<WhatsAppMessageTemplate>
        columns={[
          { dataIndex: 'name', ellipsis: true, title: 'Template', width: 250 },
          { dataIndex: 'languageCode', title: 'Language', width: 120 },
          {
            dataIndex: 'category',
            render: (value: string) => humanizeStatus(value),
            title: 'Purpose',
            width: 150,
          },
          {
            dataIndex: 'status',
            render: (value: string) => (
              <StatusText
                status={value}
                label={value === 'PENDING' ? 'Pending Meta review' : humanizeStatus(value)}
              />
            ),
            title: 'Meta status',
            width: 140,
          },
          {
            dataIndex: 'quality',
            render: (value: string) => (
              <StatusText
                label={humanizeStatus(value)}
                status={value === 'GREEN' ? 'SUCCEEDED' : value === 'RED' ? 'FAILED' : 'PENDING'}
              />
            ),
            title: 'Quality',
            width: 120,
          },
          {
            dataIndex: 'lastSyncedAt',
            render: (value: string) => new Date(value).toLocaleString(),
            title: 'Last synced',
            width: 190,
          },
          {
            key: 'actions',
            render: (_, template) => (
              <Space wrap>
                <Button icon={<EyeOutlined />} onClick={() => setPreviewing(template)} size="small">
                  View
                </Button>
                {canManage && connection?.status === 'ACTIVE' ? (
                  <>
                    {['MARKETING', 'UTILITY'].includes(template.category) &&
                    !template.components.some(
                      (c) => c.unsupportedReason || c.format === 'LOCATION',
                    ) ? (
                      <>
                        <Button
                          icon={<CopyOutlined />}
                          size="small"
                          onClick={() => setEditing({ template, duplicate: true })}
                        >
                          Duplicate
                        </Button>
                        {['APPROVED', 'REJECTED', 'PAUSED'].includes(template.status) ? (
                          <Button
                            icon={<EditOutlined />}
                            size="small"
                            onClick={() => setEditing({ template })}
                          >
                            Edit
                          </Button>
                        ) : null}
                      </>
                    ) : null}
                    <Button
                      danger
                      icon={<DeleteOutlined />}
                      size="small"
                      onClick={() => setDeleting(template)}
                    >
                      Delete
                    </Button>
                  </>
                ) : null}
              </Space>
            ),
            title: 'Actions',
            width: 230,
          },
        ]}
        dataSource={(templates.data ?? []).filter(
          (template) =>
            (!statusFilter || template.status === statusFilter) &&
            `${template.name} ${template.languageCode}`
              .toLowerCase()
              .includes(search.toLowerCase()),
        )}
        loading={channels.isLoading || templates.isLoading}
        locale={{
          emptyText: connectionId
            ? 'No templates have been synced for this number yet'
            : 'Choose a WhatsApp channel',
        }}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        rowKey="id"
        scroll={{ x: 1070 }}
        tableLayout="fixed"
      />

      <Modal
        footer={null}
        onCancel={() => setPreviewing(undefined)}
        open={Boolean(previewing)}
        title={previewing ? `${previewing.name} · ${previewing.languageCode}` : 'Template content'}
        width={640}
      >
        {previewing?.rejectionReasonCode ? (
          <Alert
            className="form-alert"
            description="This is the review reason returned by Meta. Update the template and resubmit, or open WhatsApp Manager for an appeal."
            message={`Meta review code: ${previewing.rejectionReasonCode}`}
            showIcon
            type="warning"
          />
        ) : null}
        <Space className="whatsapp-template-components" direction="vertical" size={10}>
          {(previewing?.components ?? []).map((component, index) => (
            <div className="whatsapp-template-component" key={`${component.type}-${index}`}>
              <span>{componentLabel(component)}</span>
              {component.format ? <small>{humanizeStatus(component.format)}</small> : null}
              {component.text ? (
                <Typography.Paragraph>{component.text}</Typography.Paragraph>
              ) : null}
              {component.buttons?.length ? (
                <div className="whatsapp-template-buttons">
                  {component.buttons.map((button, buttonIndex) => (
                    <span key={`${button.type}-${buttonIndex}`}>{button.text}</span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </Space>
      </Modal>
      {editing && connectionId ? (
        <WhatsAppTemplateEditor
          key={`${connectionId}:${editing.template?.id ?? 'new'}:${editing.duplicate ?? false}`}
          projectId={projectId}
          connectionId={connectionId}
          {...editing}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
      <Modal
        open={Boolean(deleting)}
        title="Delete template from Meta?"
        okText="Delete template"
        okButtonProps={{ danger: true, loading: mutations.remove.isPending }}
        onCancel={() => setDeleting(undefined)}
        onOk={async () => {
          if (!deleting) return;
          try {
            await mutations.remove.mutateAsync(deleting.id);
            setDeleting(undefined);
            void message.success('Template deleted from Meta.');
          } catch (error) {
            void message.error(getUserErrorMessage(error, 'Template could not be deleted.'));
          }
        }}
      >
        <Typography.Paragraph>
          <strong>
            {deleting?.name} · {deleting?.languageCode}
          </strong>{' '}
          will be deleted for every number in this WhatsApp Business Account. Broadcasts and
          automations using it will no longer be able to send it. Existing message history is
          retained.
        </Typography.Paragraph>
      </Modal>
    </div>
  );
}

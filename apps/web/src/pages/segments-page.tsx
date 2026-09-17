import { DeleteOutlined, EditOutlined, PlusOutlined, TeamOutlined } from '@ant-design/icons';
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
  Tag,
  Typography,
  message,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';

import { apiRequest, getUserErrorMessage } from '../api';
import { useContactAudienceOptions } from '../audience-api';
import { useAuth } from '../auth';
import { hasProjectPermission, useProjectAccess } from '../project-access';

type SegmentFilter = {
  channel?: string;
  contactIds?: string[];
  customFieldKey?: string;
  customFieldValue?: boolean | number | string;
  hasCrmLeadId?: boolean;
  status?: string;
  tagId?: string;
};

interface Segment {
  filter: SegmentFilter;
  id: string;
  memberCount: number;
  name: string;
  status: 'ACTIVE' | 'ARCHIVED';
  updatedAt: string;
}

type GroupFormValues = {
  channel?: string;
  contactIds?: string[];
  hasCrmLeadId?: 'ANY' | 'NO' | 'YES';
  kind: 'DYNAMIC' | 'MANUAL';
  name: string;
  status?: string;
  tagId?: string;
};

export function SegmentsPage() {
  const { projectId } = useParams();
  const { accessToken } = useAuth();
  const access = useProjectAccess(projectId);
  const cache = useQueryClient();
  const [form] = Form.useForm<GroupFormValues>();
  const kind = Form.useWatch('kind', form) ?? 'MANUAL';
  const [editing, setEditing] = useState<Segment>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [deletingSegment, setDeletingSegment] = useState<Segment>();
  const options = useContactAudienceOptions(projectId);
  const segments = useQuery({
    enabled: Boolean(projectId),
    queryFn: () => apiRequest<Segment[]>(`/api/v1/projects/${projectId}/segments`, {}, accessToken),
    queryKey: ['segments', projectId],
  });
  const invalidate = async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: ['segments', projectId] }),
      cache.invalidateQueries({ queryKey: ['contact-audience-options', projectId] }),
      cache.invalidateQueries({ queryKey: ['email-audience-options', projectId] }),
    ]);
  };
  const save = useMutation({
    mutationFn: ({ filter, id, name }: { filter: SegmentFilter; id?: string; name: string }) =>
      apiRequest<Segment>(
        `/api/v1/projects/${projectId}/segments${id ? `/${id}` : ''}`,
        { body: JSON.stringify({ filter, name }), method: id ? 'PATCH' : 'POST' },
        accessToken,
      ),
    onSuccess: invalidate,
  });
  const archive = useMutation({
    mutationFn: (id: string) =>
      apiRequest<void>(
        `/api/v1/projects/${projectId}/segments/${id}`,
        { method: 'DELETE' },
        accessToken,
      ),
    onSuccess: invalidate,
  });
  const canEdit = hasProjectPermission(access.data, 'contacts:update');

  const openEditor = (segment?: Segment) => {
    setEditing(segment);
    form.resetFields();
    form.setFieldsValue(segment ? valuesFromSegment(segment) : defaultValues());
    setEditorOpen(true);
  };

  return (
    <section>
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>Contact groups</Typography.Title>
          <Typography.Text type="secondary">
            Build reusable manual lists or dynamic groups for broadcasts and contact filtering.
          </Typography.Text>
        </div>
        {canEdit ? (
          <Button icon={<PlusOutlined />} onClick={() => openEditor()} type="primary">
            Create group
          </Button>
        ) : null}
      </div>
      <Alert
        className="contact-groups-note"
        message="Groups are evaluated again when a broadcast starts. Channel consent, reachability and suppression rules are applied afterward."
        showIcon
        type="info"
      />
      {segments.isError ? (
        <Alert
          message={getUserErrorMessage(segments.error, 'Contact groups could not be loaded.')}
          showIcon
          type="error"
        />
      ) : null}
      <Table<Segment>
        columns={[
          {
            dataIndex: 'name',
            render: (name) => (
              <Space>
                <TeamOutlined />
                <Typography.Text strong>{name}</Typography.Text>
              </Space>
            ),
            title: 'Group',
          },
          {
            key: 'kind',
            render: (_, row) => (
              <Tag color={isManual(row.filter) ? 'blue' : 'purple'}>
                {isManual(row.filter) ? 'Manual' : 'Dynamic'}
              </Tag>
            ),
            title: 'Type',
          },
          {
            dataIndex: 'memberCount',
            render: (count: number) => `${count} contact${count === 1 ? '' : 's'}`,
            title: 'Current members',
          },
          {
            dataIndex: 'filter',
            render: (filter: SegmentFilter) => describeFilter(filter, options.data?.tags),
            title: 'Definition',
          },
          {
            dataIndex: 'updatedAt',
            render: (value) => new Date(value).toLocaleString(),
            title: 'Updated',
          },
          {
            key: 'actions',
            render: (_, row) =>
              canEdit ? (
                <Space>
                  <Button icon={<EditOutlined />} onClick={() => openEditor(row)} size="small">
                    Edit
                  </Button>
                  <Button
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => setDeletingSegment(row)}
                    size="small"
                  >
                    Archive
                  </Button>
                </Space>
              ) : (
                '—'
              ),
            title: 'Actions',
          },
        ]}
        dataSource={segments.data ?? []}
        loading={segments.isLoading}
        rowKey="id"
      />
      <Modal
        destroyOnHidden
        footer={null}
        onCancel={() => setEditorOpen(false)}
        open={editorOpen}
        title={editing ? 'Edit contact group' : 'Create contact group'}
        width={640}
      >
        <Form<GroupFormValues>
          form={form}
          layout="vertical"
          onFinish={async (values) => {
            try {
              await save.mutateAsync({
                filter: filterFromValues(values, editing?.filter),
                ...(editing ? { id: editing.id } : {}),
                name: values.name,
              });
              void message.success(editing ? 'Contact group updated.' : 'Contact group created.');
              setEditorOpen(false);
            } catch (error) {
              void message.error(getUserErrorMessage(error, 'Contact group could not be saved.'));
            }
          }}
          requiredMark={false}
        >
          <Form.Item
            label="Group name"
            name="name"
            rules={[{ message: 'Enter a group name', required: true }]}
          >
            <Input maxLength={120} placeholder="For example: VIP customers" />
          </Form.Item>
          <Form.Item label="Group type" name="kind">
            <Segmented
              block
              options={[
                { label: 'Manual · choose people', value: 'MANUAL' },
                { label: 'Dynamic · use rules', value: 'DYNAMIC' },
              ]}
            />
          </Form.Item>
          {kind === 'MANUAL' ? (
            <Form.Item
              label="Contacts"
              name="contactIds"
              rules={[{ message: 'Choose at least one contact', required: true, type: 'array' }]}
            >
              <Select<string[]>
                loading={options.isLoading}
                maxTagCount="responsive"
                mode="multiple"
                optionFilterProp="label"
                options={(options.data?.contacts ?? []).map((contact) => ({
                  disabled: contact.status !== 'ACTIVE',
                  label: contactLabel(contact),
                  value: contact.id,
                }))}
                placeholder="Search and select contacts"
                showSearch
              />
            </Form.Item>
          ) : (
            <div className="contact-group-rules">
              <Form.Item label="Contact status" name="status">
                <Select
                  allowClear
                  options={[
                    { label: 'Active', value: 'ACTIVE' },
                    { label: 'Blocked', value: 'BLOCKED' },
                    { label: 'Unsubscribed', value: 'UNSUBSCRIBED' },
                    { label: 'Archived', value: 'ARCHIVED' },
                  ]}
                  placeholder="Any non-merged status"
                />
              </Form.Item>
              <Form.Item label="Channel" name="channel">
                <Select
                  allowClear
                  options={[
                    { label: 'Telegram', value: 'TELEGRAM' },
                    { label: 'WhatsApp', value: 'WHATSAPP' },
                  ]}
                  placeholder="Any channel"
                />
              </Form.Item>
              <Form.Item label="Must have tag" name="tagId">
                <Select
                  allowClear
                  loading={options.isLoading}
                  options={(options.data?.tags ?? []).map((tag) => ({
                    label: tag.name,
                    value: tag.id,
                  }))}
                  placeholder="Any tag"
                />
              </Form.Item>
              <Form.Item label="CRM lead" name="hasCrmLeadId">
                <Select
                  options={[
                    { label: 'Any', value: 'ANY' },
                    { label: 'Has a CRM lead', value: 'YES' },
                    { label: 'Has no CRM lead', value: 'NO' },
                  ]}
                />
              </Form.Item>
              {editing?.filter.customFieldKey ? (
                <Alert
                  message={`This group also keeps its existing custom-field rule: ${editing.filter.customFieldKey}.`}
                  showIcon
                  type="info"
                />
              ) : null}
            </div>
          )}
          <div className="modal-form-actions">
            <Button onClick={() => setEditorOpen(false)}>Cancel</Button>
            <Button htmlType="submit" loading={save.isPending} type="primary">
              {editing ? 'Save changes' : 'Create group'}
            </Button>
          </div>
        </Form>
      </Modal>
      <Modal
        className="account-confirm-modal"
        footer={null}
        onCancel={() => setDeletingSegment(undefined)}
        open={Boolean(deletingSegment)}
        title="Archive this contact group?"
        width={460}
      >
        <Typography.Paragraph type="secondary">
          {deletingSegment
            ? `${deletingSegment.name} will disappear from new audience selections. Existing broadcast snapshots stay unchanged.`
            : ''}
        </Typography.Paragraph>
        <div className="modal-form-actions">
          <Button onClick={() => setDeletingSegment(undefined)}>Cancel</Button>
          <Button
            danger
            loading={archive.isPending}
            onClick={async () => {
              if (!deletingSegment) return;
              try {
                await archive.mutateAsync(deletingSegment.id);
                void message.success('Contact group archived.');
                setDeletingSegment(undefined);
              } catch (error) {
                void message.error(
                  getUserErrorMessage(error, 'Contact group could not be archived.'),
                );
              }
            }}
          >
            Archive group
          </Button>
        </div>
      </Modal>
    </section>
  );
}

function defaultValues(): GroupFormValues {
  return { hasCrmLeadId: 'ANY', kind: 'MANUAL', name: '' };
}

function valuesFromSegment(segment: Segment): GroupFormValues {
  return {
    ...(segment.filter.channel ? { channel: segment.filter.channel } : {}),
    ...(segment.filter.contactIds ? { contactIds: segment.filter.contactIds } : {}),
    hasCrmLeadId:
      segment.filter.hasCrmLeadId === undefined
        ? 'ANY'
        : segment.filter.hasCrmLeadId
          ? 'YES'
          : 'NO',
    kind: isManual(segment.filter) ? 'MANUAL' : 'DYNAMIC',
    name: segment.name,
    ...(segment.filter.status ? { status: segment.filter.status } : {}),
    ...(segment.filter.tagId ? { tagId: segment.filter.tagId } : {}),
  };
}

function filterFromValues(values: GroupFormValues, current?: SegmentFilter): SegmentFilter {
  if (values.kind === 'MANUAL') return { contactIds: values.contactIds ?? [] };
  const filter: SegmentFilter = { ...current };
  delete filter.contactIds;
  for (const key of ['channel', 'status', 'tagId'] as const) {
    if (values[key]) filter[key] = values[key];
    else delete filter[key];
  }
  if (values.hasCrmLeadId === 'ANY') delete filter.hasCrmLeadId;
  else filter.hasCrmLeadId = values.hasCrmLeadId === 'YES';
  return filter;
}

function isManual(filter: SegmentFilter) {
  return Array.isArray(filter.contactIds);
}

function describeFilter(
  filter: SegmentFilter,
  tags: Array<{ id: string; name: string }> | undefined,
) {
  if (isManual(filter)) return 'Chosen contacts';
  const rules = [
    filter.status ? `Status: ${filter.status.toLowerCase()}` : undefined,
    filter.channel ? `Channel: ${filter.channel.toLowerCase()}` : undefined,
    filter.tagId
      ? `Tag: ${tags?.find((tag) => tag.id === filter.tagId)?.name ?? 'saved tag'}`
      : undefined,
    filter.hasCrmLeadId === true ? 'Has CRM lead' : undefined,
    filter.hasCrmLeadId === false ? 'No CRM lead' : undefined,
    filter.customFieldKey ? `Custom field: ${filter.customFieldKey}` : undefined,
  ].filter(Boolean);
  return rules.length ? rules.join(' · ') : 'All non-merged contacts';
}

function contactLabel(contact: {
  displayName: string;
  email?: string | null;
  phone?: string | null;
}) {
  const address = contact.email ?? contact.phone;
  return address ? `${contact.displayName} · ${address}` : contact.displayName;
}

import { PlusOutlined, SearchOutlined, TeamOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { apiRequest, getUserErrorMessage } from '../api';
import { useAuth } from '../auth';
import { hasProjectPermission, useProjectAccess } from '../project-access';
import { StatusText } from '../status-text';

interface ContactRow {
  id: string;
  displayName: string;
  email: string | null;
  groups: { id: string; name: string }[];
  lastInteractionAt: string | null;
  status: 'ACTIVE' | 'BLOCKED' | 'UNSUBSCRIBED' | 'ARCHIVED' | 'MERGED';
  tags: { tag: { id: string; name: string; color: string | null } }[];
  channelIdentities: { channel: string }[];
}

interface ContactPage {
  items: ContactRow[];
  page: number;
  pageSize: number;
  total: number;
}

interface SegmentItem {
  id: string;
  name: string;
}

interface CreateContactInput {
  displayName: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  username?: string;
}

export function ContactsPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { accessToken } = useAuth();
  const queryClient = useQueryClient();
  const access = useProjectAccess(projectId);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm<CreateContactInput>();
  const [groupForm] = Form.useForm<{ name: string }>();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>();
  const [segmentId, setSegmentId] = useState<string>();
  const [groupOpen, setGroupOpen] = useState(false);
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const createContact = useMutation({
    mutationFn: (input: CreateContactInput) =>
      apiRequest<ContactRow>(
        `/api/v1/projects/${projectId}/contacts`,
        { body: JSON.stringify(input), method: 'POST' },
        accessToken,
      ),
    onSuccess: async (contact) => {
      await queryClient.invalidateQueries({ queryKey: ['contacts', projectId] });
      createForm.resetFields();
      setCreateOpen(false);
      void message.success('Contact created.');
      navigate(`/projects/${projectId}/contacts/${contact.id}`);
    },
  });
  const createGroup = useMutation({
    mutationFn: (name: string) =>
      apiRequest<SegmentItem>(
        `/api/v1/projects/${projectId}/segments`,
        {
          body: JSON.stringify({ filter: { contactIds: selectedContactIds }, name }),
          method: 'POST',
        },
        accessToken,
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['segments', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['contact-audience-options', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['email-audience-options', projectId] }),
      ]);
      groupForm.resetFields();
      setGroupOpen(false);
      setSelectedContactIds([]);
      void message.success('Contact group created.');
    },
  });
  const queryString = useMemo(
    () =>
      new URLSearchParams({
        page: String(page),
        pageSize: '25',
        ...(search ? { search } : {}),
        ...(status ? { status } : {}),
        ...(segmentId ? { segmentId } : {}),
      }).toString(),
    [page, search, segmentId, status],
  );
  const contacts = useQuery({
    enabled: Boolean(projectId),
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === projectId && previousQuery?.queryKey[2] === accessToken
        ? previousData
        : undefined,
    queryFn: () =>
      apiRequest<ContactPage>(
        `/api/v1/projects/${projectId}/contacts?${queryString}`,
        {},
        accessToken,
      ),
    queryKey: ['contacts', projectId, accessToken, queryString],
  });
  const segments = useQuery({
    enabled: Boolean(projectId),
    queryFn: () =>
      apiRequest<SegmentItem[]>(`/api/v1/projects/${projectId}/segments`, {}, accessToken),
    queryKey: ['segments', projectId],
  });

  return (
    <section>
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>Contacts</Typography.Title>
          <Typography.Text type="secondary">
            Search, filter and manage the people connected to this project.
          </Typography.Text>
        </div>
      </div>
      <div className="filter-panel surface">
        <Space align="center" className="contacts-toolbar" wrap>
          {hasProjectPermission(access.data, 'contacts:manage') ? (
            <Button
              className="contacts-toolbar-create"
              icon={<PlusOutlined />}
              onClick={() => setCreateOpen(true)}
              type="primary"
            >
              Create contact
            </Button>
          ) : null}
          {hasProjectPermission(access.data, 'contacts:update') && selectedContactIds.length ? (
            <Button icon={<TeamOutlined />} onClick={() => setGroupOpen(true)}>
              Create group ({selectedContactIds.length})
            </Button>
          ) : null}
          <Input
            allowClear
            aria-label="Search contacts"
            autoComplete="off"
            className="contact-search-input"
            name="contact-search"
            onChange={(event) => {
              setPage(1);
              setSearch(event.target.value);
            }}
            placeholder="Name, username, phone or email"
            prefix={<SearchOutlined />}
            spellCheck={false}
            style={{ width: 320 }}
            value={search}
          />
          <Select
            allowClear
            aria-label="Contact status"
            onChange={(value) => {
              setPage(1);
              setStatus(value);
            }}
            options={[
              { label: 'Active', value: 'ACTIVE' },
              { label: 'Blocked', value: 'BLOCKED' },
              { label: 'Unsubscribed', value: 'UNSUBSCRIBED' },
              { label: 'Archived', value: 'ARCHIVED' },
              { label: 'Merged', value: 'MERGED' },
            ]}
            placeholder="Status"
            style={{ width: 180 }}
            value={status}
          />
          <Select
            allowClear
            aria-label="Contact group"
            onChange={(value) => {
              setPage(1);
              setSegmentId(value);
            }}
            options={(segments.data ?? []).map((segment) => ({
              label: segment.name,
              value: segment.id,
            }))}
            placeholder="Contact group"
            style={{ width: 220 }}
            value={segmentId}
          />
        </Space>
      </div>
      {contacts.isError ? (
        <Alert
          className="form-alert"
          message="Contacts could not be loaded. Refresh the page or try again."
          showIcon
          type="error"
        />
      ) : null}
      <Table<ContactRow>
        aria-busy={contacts.isPlaceholderData}
        className={`query-transition-table${contacts.isPlaceholderData ? ' is-query-updating' : ''}`}
        columns={[
          {
            dataIndex: 'displayName',
            render: (name) => <Typography.Text strong>{name}</Typography.Text>,
            title: 'Name',
          },
          { dataIndex: 'email', title: 'Email' },
          {
            dataIndex: 'channelIdentities',
            render: (items) =>
              items.map((item: { channel: string }) => (
                <Tag key={item.channel}>{item.channel}</Tag>
              )),
            title: 'Channels',
          },
          {
            dataIndex: 'tags',
            render: (items) =>
              items.map((item: ContactRow['tags'][number]) => (
                <Tag {...(item.tag.color ? { color: item.tag.color } : {})} key={item.tag.id}>
                  {item.tag.name}
                </Tag>
              )),
            title: 'Tags',
          },
          {
            dataIndex: 'groups',
            render: (items: ContactRow['groups']) =>
              items.length ? (
                <div className="contact-group-tags">
                  {items.slice(0, 2).map((group) => (
                    <Tag className="contact-group-tag" key={group.id}>
                      {group.name}
                    </Tag>
                  ))}
                  {items.length > 2 ? (
                    <Tag className="contact-group-tag">+{items.length - 2}</Tag>
                  ) : null}
                </div>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              ),
            title: 'Groups',
          },
          {
            dataIndex: 'status',
            render: (value) => <StatusText status={value} />,
            title: 'Status',
          },
          {
            dataIndex: 'lastInteractionAt',
            render: (value: string | null) => (value ? new Date(value).toLocaleString() : '—'),
            title: 'Last interaction',
          },
        ]}
        dataSource={contacts.data?.items ?? []}
        loading={contacts.isLoading}
        locale={{
          emptyText: contacts.isPlaceholderData ? (
            <Typography.Text type="secondary">Updating results…</Typography.Text>
          ) : (
            <Empty
              description="No contacts match the selected filters"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          ),
        }}
        pagination={{
          current: page,
          onChange: setPage,
          pageSize: 25,
          total: contacts.data?.total ?? 0,
        }}
        onRow={(row) =>
          contacts.isPlaceholderData
            ? {}
            : {
                className: 'clickable-row',
                onClick: () => navigate(`/projects/${projectId}/contacts/${row.id}`),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    navigate(`/projects/${projectId}/contacts/${row.id}`);
                  }
                },
                role: 'link',
                tabIndex: 0,
              }
        }
        {...(hasProjectPermission(access.data, 'contacts:update')
          ? {
              rowSelection: {
                getCheckboxProps: (row) => ({ disabled: row.status === 'MERGED' }),
                onChange: (keys) => setSelectedContactIds(keys.map(String)),
                preserveSelectedRowKeys: true,
                selectedRowKeys: selectedContactIds,
              },
            }
          : {})}
        rowKey="id"
      />
      <Modal
        confirmLoading={createContact.isPending}
        destroyOnClose
        onCancel={() => {
          createForm.resetFields();
          setCreateOpen(false);
        }}
        onOk={() => createForm.submit()}
        open={createOpen}
        title="Create contact"
      >
        <Form<CreateContactInput>
          form={createForm}
          layout="vertical"
          onFinish={(values) => {
            createContact.mutate(values, {
              onError: (error) =>
                void message.error(getUserErrorMessage(error, 'Contact could not be created.')),
            });
          }}
        >
          <Form.Item label="Display name" name="displayName" rules={[{ required: true }]}>
            <Input autoComplete="name" maxLength={200} />
          </Form.Item>
          <Space align="start" style={{ width: '100%' }}>
            <Form.Item label="First name" name="firstName">
              <Input autoComplete="given-name" maxLength={100} />
            </Form.Item>
            <Form.Item label="Last name" name="lastName">
              <Input autoComplete="family-name" maxLength={100} />
            </Form.Item>
          </Space>
          <Form.Item label="Email" name="email" rules={[{ type: 'email' }]}>
            <Input autoComplete="email" maxLength={320} />
          </Form.Item>
          <Form.Item label="Phone" name="phone">
            <Input autoComplete="tel" maxLength={50} />
          </Form.Item>
          <Form.Item label="Username" name="username">
            <Input autoComplete="off" maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        confirmLoading={createGroup.isPending}
        destroyOnHidden
        onCancel={() => setGroupOpen(false)}
        onOk={() => groupForm.submit()}
        open={groupOpen}
        title="Create contact group"
      >
        <Typography.Paragraph type="secondary">
          Save the {selectedContactIds.length} selected contact
          {selectedContactIds.length === 1 ? '' : 's'} as a reusable manual group.
        </Typography.Paragraph>
        <Form<{ name: string }>
          form={groupForm}
          layout="vertical"
          onFinish={(values) =>
            createGroup.mutate(values.name, {
              onError: (error) =>
                void message.error(
                  getUserErrorMessage(error, 'Contact group could not be created.'),
                ),
            })
          }
        >
          <Form.Item
            label="Group name"
            name="name"
            rules={[{ message: 'Enter a group name', required: true }]}
          >
            <Input maxLength={120} placeholder="For example: Priority customers" />
          </Form.Item>
        </Form>
      </Modal>
    </section>
  );
}

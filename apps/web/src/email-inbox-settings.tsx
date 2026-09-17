import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Collapse,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';
import { useAuth } from './auth';
import { getUserErrorMessage } from './api';
import { useInboxActions, useInboxQuery, type Mailbox, type MailDomain } from './email-inbox-api';

type Member = { id: string; email: string; name: string };
type MailboxValues = {
  domainId: string;
  localPart: string;
  displayName: string;
  signature: string;
  mode: string;
  shared: boolean;
  isDefault: boolean;
  memberUserIds: string[];
  status: string;
};

export function EmailInboxSettings({
  projectId,
  mailboxes,
}: {
  projectId: string;
  mailboxes: Mailbox[];
}) {
  const { identity } = useAuth();
  const superAdmin = identity?.globalRoleNames.includes('super-admin') ?? false;
  const domains = useInboxQuery<MailDomain[]>(projectId, 'domains');
  const health = useInboxQuery<{
    counts: Record<string, number>;
    failedReceipts: Array<{ id: string; lastError: string; mailbox: { address: string } }>;
    failedAutomations: Array<{ id: string; threadId: string; automationError: string }>;
  }>(projectId, 'health', true, true);
  const members = useInboxQuery<Member[]>(projectId, 'members');
  const available = useInboxQuery<Array<{ id: string; name: string }>>(
    projectId,
    'available-domains',
    superAdmin,
  );
  const actions = useInboxActions(projectId);
  const { message } = App.useApp();
  const [domainId, setDomainId] = useState<string>();
  const [edit, setEdit] = useState<Mailbox | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form] = Form.useForm<MailboxValues>();
  const shared = Form.useWatch('shared', form) as boolean | undefined;
  const perform = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (err) {
      setError(getUserErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const editMailbox = (item: Mailbox | 'new') => {
    form.resetFields();
    form.setFieldsValue(
      item === 'new'
        ? {
            domainId: domains.data?.[0]?.id ?? '',
            localPart: '',
            displayName: '',
            signature: '',
            mode: 'TWO_WAY',
            shared: true,
            isDefault: !mailboxes.length,
            memberUserIds: [],
            status: 'ACTIVE',
          }
        : { ...item, localPart: item.address.split('@')[0] ?? '' },
    );
    setEdit(item);
  };
  return (
    <div className="mail-settings">
      {error && <Alert showIcon type="error" title={error} />}
      {(domains.isError || members.isError) && (
        <Alert
          showIcon
          type="error"
          title="Email settings could not be loaded."
          action={
            <Button
              onClick={() => {
                void domains.refetch();
                void members.refetch();
              }}
            >
              Retry
            </Button>
          }
        />
      )}
      <Card
        title="Sending & receiving domains"
        extra={
          <a href="https://resend.com/domains" target="_blank" rel="noopener noreferrer">
            Open Resend ↗
          </a>
        }
      >
        <Typography.Paragraph type="secondary">
          Connect a domain verified in the platform’s Resend account. Addresses below are identities
          in Omnicus, not separate Gmail or IMAP accounts.
        </Typography.Paragraph>
        <Alert
          type="info"
          showIcon
          title="Keep existing business email working"
          description="Use a dedicated subdomain for Omnicus if this domain already receives mail in Google Workspace or another provider. Do not replace existing MX records without agreeing on the migration. Enable receiving in Resend, configure its DNS records, and subscribe the signed webhook to email.received."
        />
        {superAdmin ? (
          <Space wrap className="mail-settings-connect">
            <Select
              style={{ width: 300 }}
              loading={available.isLoading}
              placeholder="Select an existing Resend domain"
              value={domainId}
              onChange={setDomainId}
              options={(available.data ?? [])
                .filter(
                  (item) => !domains.data?.some((domain) => domain.providerDomainId === item.id),
                )
                .map((item) => ({ value: item.id, label: item.name }))}
            />
            <Button
              disabled={!domainId || busy}
              loading={busy}
              onClick={() =>
                void perform(async () => {
                  await actions.request('domains', 'POST', { providerDomainId: domainId });
                  setDomainId(undefined);
                  void message.success('Domain connected.');
                })
              }
            >
              Connect domain
            </Button>
          </Space>
        ) : (
          <Typography.Paragraph className="mail-settings-connect" type="secondary">
            A system administrator connects provider domains. Project email managers can refresh DNS
            status and manage addresses.
          </Typography.Paragraph>
        )}
        {available.isError && superAdmin && (
          <Alert
            className="mail-alert"
            type="warning"
            title="Provider domains are unavailable"
            description="The API service needs a Resend API key with full access. Ask the platform administrator to check its configuration."
            action={<Button onClick={() => void available.refetch()}>Retry</Button>}
          />
        )}
        <Collapse
          ghost
          items={(domains.data ?? []).map((domain) => ({
            key: domain.id,
            label: (
              <Space wrap>
                <strong>{domain.name}</strong>
                <Tag
                  color={domain.status === 'verified' && domain.sendingEnabled ? 'green' : 'orange'}
                >
                  Sending{' '}
                  {domain.status === 'verified' && domain.sendingEnabled ? 'ready' : 'pending'}
                </Tag>
                <Tag color={domain.receivingReady ? 'green' : 'default'}>
                  Receiving {domain.receivingReady ? 'ready' : 'not ready'}
                </Tag>
              </Space>
            ),
            children: (
              <>
                <Space wrap>
                  <Typography.Text type="secondary">
                    Region: {domain.region ?? 'Unknown'} · Last checked:{' '}
                    {domain.lastCheckedAt
                      ? new Date(domain.lastCheckedAt).toLocaleString()
                      : 'Never'}
                  </Typography.Text>
                  <Button
                    size="small"
                    icon={<ReloadOutlined />}
                    disabled={busy}
                    onClick={() =>
                      void perform(() => actions.request(`domains/${domain.id}/refresh`, 'POST'))
                    }
                  >
                    Refresh DNS status
                  </Button>
                </Space>
                <Table
                  size="small"
                  pagination={false}
                  scroll={{ x: 600 }}
                  rowKey={(row) => row.type + row.name + row.record}
                  dataSource={domain.dnsRecords}
                  columns={[
                    { title: 'Purpose', dataIndex: 'record' },
                    { title: 'Type', dataIndex: 'type' },
                    { title: 'Name', dataIndex: 'name' },
                    {
                      title: 'Value',
                      dataIndex: 'value',
                      render: (value: string) => (
                        <Typography.Text copyable style={{ overflowWrap: 'anywhere' }}>
                          {value}
                        </Typography.Text>
                      ),
                    },
                    { title: 'Priority', dataIndex: 'priority' },
                    { title: 'Status', dataIndex: 'status' },
                  ]}
                />
              </>
            ),
          }))}
        />
        {!domains.isLoading && !domains.data?.length && (
          <Typography.Paragraph type="secondary" className="mail-settings-connect">
            No domain connected yet. Existing legacy campaign sending remains unchanged.
          </Typography.Paragraph>
        )}
      </Card>
      <Card
        title="Email addresses"
        extra={
          <Button
            icon={<PlusOutlined />}
            disabled={!domains.data?.length}
            onClick={() => editMailbox('new')}
          >
            Add address
          </Button>
        }
      >
        <Typography.Paragraph type="secondary">
          Shared addresses are visible to members with email permissions. Restricted addresses are
          available to assigned members and email managers. The default address is used for new
          campaigns and automations.
        </Typography.Paragraph>
        <Table
          dataSource={mailboxes}
          rowKey="id"
          pagination={false}
          scroll={{ x: 650 }}
          columns={[
            {
              title: 'Address',
              render: (_, item: Mailbox) => (
                <div>
                  <strong>{item.displayName}</strong>
                  <div>
                    {item.address} {item.isDefault && <Tag>Default</Tag>}
                  </div>
                </div>
              ),
            },
            {
              title: 'Mode',
              render: (_, item: Mailbox) =>
                item.mode === 'SEND_ONLY' ? 'Send only' : 'Two-way email',
            },
            {
              title: 'Access',
              render: (_, item: Mailbox) =>
                item.shared ? 'Shared' : `${item.memberUserIds.length} assigned`,
            },
            {
              title: 'Status',
              render: (_, item: Mailbox) => (
                <Tag color={item.sendingReady ? 'green' : 'orange'}>
                  {item.status === 'DISABLED'
                    ? 'Disabled'
                    : item.sendingReady
                      ? 'Sending ready'
                      : 'Needs setup'}
                </Tag>
              ),
            },
            {
              title: '',
              render: (_, item: Mailbox) => <Button onClick={() => editMailbox(item)}>Edit</Button>,
            },
          ]}
        />
      </Card>
      <Card
        title="Incoming processing"
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void health.refetch()}>
            Refresh
          </Button>
        }
      >
        {health.isError ? (
          <Alert type="warning" title="Processing status could not be loaded." />
        ) : (
          <>
            <Space wrap>
              {Object.entries(health.data?.counts ?? {}).map(([status, count]) => (
                <Tag key={status} color={status === 'FAILED' ? 'red' : 'default'}>
                  {status.toLowerCase()}: {count}
                </Tag>
              ))}
            </Space>
            {!health.data?.failedReceipts.length && !health.data?.failedAutomations.length && (
              <Typography.Paragraph type="secondary">
                No failed incoming messages recorded. This does not replace a live sending and
                receiving test.
              </Typography.Paragraph>
            )}
            {health.data?.failedReceipts.map((row) => (
              <Alert
                className="mail-alert"
                key={row.id}
                type="warning"
                title={row.mailbox.address}
                description={row.lastError}
                action={
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void perform(() => actions.request(`receipts/${row.id}/retry`, 'POST'))
                    }
                  >
                    Retry import
                  </Button>
                }
              />
            ))}
            {health.data?.failedAutomations.map((row) => (
              <Alert
                className="mail-alert"
                key={row.id}
                type="warning"
                title="Email automation could not continue"
                description={row.automationError}
                action={
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void perform(() =>
                        actions.request(`messages/${row.id}/retry-automation`, 'POST'),
                      )
                    }
                  >
                    Retry processing
                  </Button>
                }
              />
            ))}
          </>
        )}
      </Card>
      <Card title="Provider billing">
        <Typography.Paragraph>
          Resend bills the connected provider account directly. Omnicus does not collect card
          details or maintain a separate email balance.
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary">
          Reference prices checked September 15, 2026: Free — $0, 3,000 emails/month, 100/day, 3
          domains. Pro — $20/month, 50,000 emails, 10 domains; additional emails $0.90/1,000.
          Received and sent emails count toward usage. This is not your live usage or invoice; check
          the current plan and billing in Resend.
        </Typography.Paragraph>
        <Space wrap>
          <a href="https://resend.com/pricing" target="_blank" rel="noopener noreferrer">
            Current plans ↗
          </a>
          <a href="https://resend.com/settings/billing" target="_blank" rel="noopener noreferrer">
            Manage provider billing ↗
          </a>
        </Space>
      </Card>
      <Modal
        open={!!edit}
        title={edit === 'new' ? 'Add email address' : 'Edit email address'}
        onCancel={() => !busy && setEdit(null)}
        confirmLoading={busy}
        onOk={() =>
          void perform(async () => {
            const values = await form.validateFields();
            const { domainId: selectedDomain, localPart, ...settings } = values;
            await actions.request(
              edit === 'new' ? 'mailboxes' : `mailboxes/${(edit as Mailbox).id}`,
              edit === 'new' ? 'POST' : 'PATCH',
              edit === 'new'
                ? { ...settings, domainId: selectedDomain, localPart, status: undefined }
                : settings,
            );
            setEdit(null);
            void message.success('Email address saved.');
          })
        }
      >
        <Form form={form} layout="vertical" disabled={busy}>
          {edit === 'new' && (
            <>
              <Form.Item name="domainId" label="Domain" rules={[{ required: true }]}>
                <Select
                  options={(domains.data ?? []).map((domain) => ({
                    value: domain.id,
                    label: domain.name,
                  }))}
                />
              </Form.Item>
              <Form.Item
                name="localPart"
                label="Address before @"
                rules={[
                  { required: true },
                  {
                    pattern: /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/,
                    message: 'Use letters, numbers, dots, hyphens or underscores.',
                  },
                ]}
              >
                <Input placeholder="sales" maxLength={64} />
              </Form.Item>
            </>
          )}
          <Form.Item
            name="displayName"
            label="Sender name"
            rules={[
              { required: true },
              { pattern: /^[^<>\r\n]+$/, message: 'Enter a plain sender name.' },
            ]}
          >
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="signature" label="Signature">
            <Input.TextArea rows={3} maxLength={5000} />
          </Form.Item>
          <Form.Item name="mode" label="Mode">
            <Select
              options={[
                { value: 'TWO_WAY', label: 'Send & receive' },
                { value: 'SEND_ONLY', label: 'Send only (for no-reply)' },
              ]}
            />
          </Form.Item>
          <Form.Item name="shared" valuePropName="checked">
            <Checkbox>Shared with project email users</Checkbox>
          </Form.Item>
          {!shared && (
            <Form.Item name="memberUserIds" label="Assigned members">
              <Select
                mode="multiple"
                options={(members.data ?? []).map((member) => ({
                  value: member.id,
                  label: member.name ? `${member.name} · ${member.email}` : member.email,
                }))}
              />
            </Form.Item>
          )}
          <Form.Item name="isDefault" valuePropName="checked">
            <Checkbox>Default sender for this project</Checkbox>
          </Form.Item>
          {edit !== 'new' && (
            <Form.Item name="status" label="Status">
              <Select
                options={[
                  { value: 'ACTIVE', label: 'Active' },
                  { value: 'DISABLED', label: 'Disabled (keep history)' },
                ]}
              />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  );
}

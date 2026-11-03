import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { Link } from 'react-router';
import { apiRequest, getUserErrorMessage } from './api';
import { useAuth } from './auth';
import type { WebinarConnection } from './webinar-stars-api';
dayjs.extend(utc);
dayjs.extend(timezone);

interface EventRow {
  id: string;
  title: string;
  providerWebinarId: string;
  roomUrl: string;
  timezone: string;
  scheduledAt: string;
  endsAt: string;
  cancelledAt: string | null;
  settings: Record<string, unknown>;
  _count: { invitations: number; imports: number };
}
interface ImportRow {
  id: string;
  externalReportId: string;
  eventId: string | null;
  state: string;
  historical: boolean;
  lastError: string | null;
  attempts: number;
  processedAt: string | null;
  _count: { attendances: number };
}
interface ContactOption {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
}
interface ParticipantRow {
  id: string;
  matchState: string;
  matchReason: string | null;
  contact: { id: string; displayName: string } | null;
  result: Record<string, unknown>;
  report: { historical: boolean; externalReportId: string };
}
interface ActionRow {
  id: string;
  kind: string;
  eventType: string;
  state: string;
  dueAt: string;
  lastError: string | null;
  attempts: number;
}
interface InvitationRow {
  id: string;
  participantUrl: string;
  contact: ContactOption;
  openedAt: string | null;
}
interface SettingsValues {
  registrationSourceKey?: string | undefined;
  nameParameter?: string | undefined;
  emailParameter?: string | undefined;
  phoneParameter?: string | undefined;
  trackingParameter?: string | undefined;
  distributorParameter?: string | undefined;
  autologinParameter?: string | undefined;
  autologinValue?: string | undefined;
  clickStatuses?: string[] | undefined;
  seenStatuses?: string[] | undefined;
  reminderMinutes?: string[] | undefined;
  completedPercentage?: number;
  crmEnabled?: boolean;
  replay?: string;
}
interface EventValues extends SettingsValues {
  title: string;
  providerWebinarId: string;
  roomUrl: string;
  timezone: string;
  scheduledAt: Dayjs;
  endsAt: Dayjs;
}
const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const rowText = (value: unknown) =>
  value === null || value === undefined ? 'Not provided' : String(value);
const settingValues = (config: Record<string, unknown>): SettingsValues => {
  const parameters = asObject(config.parameters),
    constant = asObject(config.constants),
    parameter = (source: string) =>
      Object.entries(parameters).find(([, value]) => value === source)?.[0];
  return {
    registrationSourceKey:
      typeof config.registrationSourceKey === 'string' ? config.registrationSourceKey : undefined,
    nameParameter: parameter('name'),
    emailParameter: parameter('email'),
    phoneParameter: parameter('phone'),
    trackingParameter:
      typeof config.trackingParameter === 'string'
        ? config.trackingParameter
        : parameter('trackingToken'),
    distributorParameter: parameter('distributorId'),
    autologinParameter: Object.keys(constant)[0],
    autologinValue:
      typeof Object.values(constant)[0] === 'string'
        ? (Object.values(constant)[0] as string)
        : undefined,
    clickStatuses: (config.clickStatuses as string[]) ?? [],
    seenStatuses: (config.seenStatuses as string[]) ?? [],
    reminderMinutes: ((config.reminderMinutes as number[]) ?? [1440, 60, 10]).map(String),
    completedPercentage:
      typeof config.completedPercentage === 'number' ? config.completedPercentage : 90,
    crmEnabled: config.crmEnabled === true,
    replay: config.replay === true ? 'yes' : config.replay === false ? 'no' : 'unknown',
  };
};
function settingsInput(values: SettingsValues) {
  return {
    registrationSourceKey: values.registrationSourceKey || null,
    parameters: Object.fromEntries(
      (
        [
          [values.nameParameter, 'name'],
          [values.emailParameter, 'email'],
          [values.phoneParameter, 'phone'],
          [values.trackingParameter, 'trackingToken'],
          [values.distributorParameter, 'distributorId'],
        ] as const
      )
        .filter(([name]) => name?.trim())
        .map(([name, source]) => [name!.trim(), source]),
    ),
    constants: values.autologinParameter
      ? { [values.autologinParameter]: values.autologinValue ?? '' }
      : {},
    trackingParameter: values.trackingParameter || null,
    clickStatuses: values.clickStatuses ?? [],
    seenStatuses: values.seenStatuses ?? [],
    reminderMinutes: (values.reminderMinutes ?? []).map(Number),
    completedPercentage: values.completedPercentage ?? 90,
    crmEnabled: values.crmEnabled ?? false,
    replay: values.replay === 'yes' ? true : values.replay === 'no' ? false : null,
  };
}
function SettingsFields() {
  return (
    <>
      <Form.Item name="registrationSourceKey" label="Website registration source key (optional)">
        <Input maxLength={64} placeholder="e.g. webinar-signup" />
      </Form.Item>
      <Typography.Title level={5}>Reminders and results</Typography.Title>
      <Form.Item name="reminderMinutes" label="Reminders before start (minutes)">
        <Select
          mode="tags"
          options={['1440', '60', '10'].map((value) => ({ value, label: `${value} minutes` }))}
        />
      </Form.Item>
      <Form.Item name="completedPercentage" label="Completed at watched percentage">
        <InputNumber min={1} max={100} />
      </Form.Item>
      <Form.Item name="replay" label="Is this a replay session?">
        <Select
          options={[
            { value: 'unknown', label: 'Not verified' },
            { value: 'no', label: 'No' },
            { value: 'yes', label: 'Yes' },
          ]}
        />
      </Form.Item>
      <Form.Item name="crmEnabled" valuePropName="checked">
        <Checkbox>
          Deliver matched results to the connected CRM (requires webinars/v1 support)
        </Checkbox>
      </Form.Item>
      <Typography.Title level={5}>Verified Webinar Stars settings</Typography.Title>
      <Typography.Paragraph type="secondary">
        These optional names and statuses must come from Webinar Stars. Leave them empty until
        confirmed; the personal Omnicus link works without autologin.
      </Typography.Paragraph>
      {(
        [
          ['nameParameter', 'Name parameter'],
          ['emailParameter', 'Email parameter'],
          ['phoneParameter', 'Phone parameter'],
          ['trackingParameter', 'Tracking parameter (also returned in report UTM)'],
          ['distributorParameter', 'Distributor parameter'],
          ['autologinParameter', 'Autologin flag name'],
          ['autologinValue', 'Autologin flag value'],
        ] as const
      ).map(([name, label]) => (
        <Form.Item key={name} name={name} label={label}>
          <Input maxLength={name === 'autologinValue' ? 500 : 64} />
        </Form.Item>
      ))}
      <Form.Item name="clickStatuses" label="Confirmed click statuses">
        <Select mode="tags" />
      </Form.Item>
      <Form.Item name="seenStatuses" label="Confirmed view statuses">
        <Select mode="tags" />
      </Form.Item>
    </>
  );
}

export function WebinarLifecyclePanel({
  projectId,
  connection,
}: {
  projectId: string;
  connection: WebinarConnection;
}) {
  const [registrationConfig, setRegistrationConfig] = useState<unknown | null>(null);
  const [createContactRow, setCreateContactRow] = useState<ParticipantRow | null>(null);
  const [contactForm] = Form.useForm<{
    displayName: string;
    email?: string | undefined;
    phone?: string | undefined;
  }>();
  const { accessToken } = useAuth(),
    client = useQueryClient(),
    base = `/api/v1/projects/${projectId}/webinar-stars`;
  const [tab, setTab] = useState('events'),
    [createOpen, setCreateOpen] = useState(false),
    [settingsEvent, setSettingsEvent] = useState<EventRow | null>(null),
    [inviteEvent, setInviteEvent] = useState<EventRow | null>(null),
    [matchRow, setMatchRow] = useState<ParticipantRow | null>(null),
    [selectedContact, setSelectedContact] = useState<string>(),
    [webhookUrl, setWebhookUrl] = useState<string | null>(null),
    [contactSearch, setContactSearch] = useState(''),
    [invitations, setInvitations] = useState<InvitationRow[]>([]),
    [showInvitations, setShowInvitations] = useState(false);
  const [eventForm] = Form.useForm<EventValues>(),
    [settingsForm] = Form.useForm<SettingsValues>(),
    [inviteForm] = Form.useForm<{
      contactIds: string[];
      utm_campaign?: string | undefined;
      distributorId?: string;
    }>(),
    [importForm] = Form.useForm<{
      reportId: string;
      eventId?: string | undefined;
      runActions?: boolean;
    }>();
  const useLifecycleQuery = <T,>(name: string, enabled = true) =>
    useQuery({
      queryKey: ['webinar-lifecycle', projectId, connection.revision, name],
      queryFn: ({ signal }) => apiRequest<T>(`${base}/${name}`, { signal }, accessToken),
      enabled,
      retry: false,
      gcTime: 0,
      refetchInterval: connection.enabled ? 5000 : false,
    });
  const events = useLifecycleQuery<EventRow[]>('events'),
    imports = useLifecycleQuery<ImportRow[]>('imports', tab === 'imports'),
    participants = useLifecycleQuery<ParticipantRow[]>('participants', tab === 'participants'),
    actions = useLifecycleQuery<ActionRow[]>('actions', tab === 'actions');
  const contacts = useQuery({
    queryKey: ['webinar-contact-options', projectId, contactSearch],
    queryFn: ({ signal }) =>
      apiRequest<ContactOption[]>(
        `${base}/contact-options?${new URLSearchParams({ search: contactSearch })}`,
        { signal },
        accessToken,
      ),
    enabled: Boolean(inviteEvent || matchRow),
    retry: false,
    gcTime: 0,
  });
  const mutate = useMutation({
    mutationFn: ({
      path,
      body,
      method = 'POST',
    }: {
      path: string;
      body?: unknown;
      method?: string;
    }) =>
      apiRequest<unknown>(
        `${base}/${path}`,
        { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
        accessToken,
      ),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['webinar-lifecycle', projectId] }),
        client.invalidateQueries({ queryKey: ['webinar-stars', projectId, 'config'] }),
      ]);
    },
  });
  const run = async (path: string, body?: unknown, method = 'POST') => {
    try {
      return await mutate.mutateAsync({ path, body, method });
    } catch (error) {
      void message.error(getUserErrorMessage(error));
      throw error;
    }
  };
  const create = async (values: EventValues) => {
    try {
      await run('events', {
        providerWebinarId: values.providerWebinarId,
        title: values.title,
        roomUrl: values.roomUrl,
        timezone: values.timezone,
        scheduledAt: dayjs
          .tz(values.scheduledAt.format('YYYY-MM-DD HH:mm:ss'), values.timezone)
          .toISOString(),
        endsAt: dayjs
          .tz(values.endsAt.format('YYYY-MM-DD HH:mm:ss'), values.timezone)
          .toISOString(),
        settings: settingsInput(values),
      });
      setCreateOpen(false);
      eventForm.resetFields();
    } catch {
      /* Error is shown by run. */
    }
  };
  const contactOptions = (contacts.data ?? []).map((row) => ({
    value: row.id,
    label: `${row.displayName}${row.email ? ` · ${row.email}` : ''}`,
  }));
  const failure = (error: unknown) => (
    <Alert
      type="error"
      showIcon
      title="Data could not be loaded"
      description={getUserErrorMessage(error)}
    />
  );
  return (
    <Card title="Webinar workflow">
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <Space wrap>
          <Switch
            checked={connection.enabled ?? false}
            loading={mutate.isPending}
            onChange={(enabled) => void run('processing', { enabled }, 'PUT').catch(() => {})}
          />
          <Typography.Text>Automatic report processing and configured scenarios</Typography.Text>
          <Tag>{connection.enabled ? 'Enabled' : 'Paused'}</Tag>
        </Space>
        <Typography.Paragraph type="secondary">
          Historical imports do not send messages or update CRM. Invitations and live reports start
          only your published Webinar event scenarios.{' '}
          <Link to={`/projects/${projectId}/scenarios`}>Open Automation Studio</Link>
        </Typography.Paragraph>
        {connection.lastPollError ? (
          <Alert
            type="warning"
            showIcon
            title="Report polling needs attention"
            description={connection.lastPollError}
          />
        ) : null}
        <Space wrap>
          <Button
            disabled={mutate.isPending}
            onClick={() =>
              void run('webhook/rotate')
                .then((value) => setWebhookUrl(asObject(value).url as string))
                .catch(() => {})
            }
          >
            {connection.webhookConfigured ? 'Replace webhook URL' : 'Generate webhook URL'}
          </Button>
          <Typography.Text type="secondary">
            Shown once. Copy it into Webinar Stars → Integrations → Webhook.
          </Typography.Text>
        </Space>
        {webhookUrl ? (
          <Input.TextArea aria-label="Webhook URL" readOnly value={webhookUrl} autoSize />
        ) : null}
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            { key: 'events', label: 'Sessions' },
            { key: 'imports', label: 'Saved reports' },
            { key: 'participants', label: 'Matching' },
            { key: 'actions', label: 'Delivery log' },
          ]}
        />
        {tab === 'events' ? (
          <>
            <Button
              type="primary"
              onClick={() => {
                eventForm.setFieldsValue({
                  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                  ...settingValues({}),
                });
                setCreateOpen(true);
              }}
            >
              Add session
            </Button>
            {events.isError ? (
              failure(events.error)
            ) : (
              <Table<EventRow>
                rowKey="id"
                dataSource={events.data ?? []}
                loading={events.isFetching}
                pagination={{ pageSize: 10 }}
                scroll={{ x: 850 }}
                columns={[
                  {
                    title: 'Session',
                    dataIndex: 'title',
                    render: (value: string, row) => (
                      <>
                        {value}
                        <br />
                        <Typography.Text type="secondary" copyable>
                          {row.id}
                        </Typography.Text>
                      </>
                    ),
                  },
                  {
                    title: 'Start',
                    dataIndex: 'scheduledAt',
                    render: (value: string, row) =>
                      dayjs(value).tz(row.timezone).format('YYYY-MM-DD HH:mm') +
                      ` (${row.timezone})`,
                  },
                  { title: 'Registrations', render: (_, row) => row._count.invitations },
                  {
                    title: 'Actions',
                    render: (_, row) => (
                      <Space wrap>
                        <Button
                          disabled={Boolean(row.cancelledAt)}
                          onClick={() => {
                            setInviteEvent(row);
                            setInvitations([]);
                          }}
                        >
                          Register contacts
                        </Button>
                        <Button
                          onClick={() => {
                            settingsForm.setFieldsValue(settingValues(row.settings));
                            setSettingsEvent(row);
                          }}
                        >
                          Settings
                        </Button>
                        <Button
                          onClick={() =>
                            void apiRequest<InvitationRow[]>(
                              `${base}/events/${row.id}/invitations`,
                              {},
                              accessToken,
                            )
                              .then((rows) => {
                                setInvitations(rows);
                                setShowInvitations(true);
                              })
                              .catch((error) => void message.error(getUserErrorMessage(error)))
                          }
                        >
                          Links
                        </Button>
                        <Button
                          onClick={() =>
                            void apiRequest<unknown>(
                              `${base}/events/${row.id}/registration-config`,
                              {},
                              accessToken,
                            )
                              .then(setRegistrationConfig)
                              .catch((error) => void message.error(getUserErrorMessage(error)))
                          }
                        >
                          Website form setup
                        </Button>
                        {row.cancelledAt ? (
                          <Tag>Cancelled</Tag>
                        ) : (
                          <Button
                            danger
                            onClick={() =>
                              Modal.confirm({
                                title: 'Cancel this session?',
                                content: 'Pending reminders will be stopped.',
                                onOk: () => run(`events/${row.id}/cancel`),
                              })
                            }
                          >
                            Cancel
                          </Button>
                        )}
                      </Space>
                    ),
                  },
                ]}
              />
            )}
            <Typography.Paragraph type="secondary">
              Create the room in Webinar Stars, then add its URL and schedule here. Omnicus does not
              start or stop your broadcast.
            </Typography.Paragraph>
          </>
        ) : null}
        {tab === 'imports' ? (
          <>
            <Form
              form={importForm}
              layout="vertical"
              onFinish={(values) =>
                void run('imports', {
                  reportId: values.reportId,
                  eventId: values.eventId,
                  historical: !values.runActions,
                })
                  .then(() => importForm.resetFields())
                  .catch(() => {})
              }
            >
              <Space wrap align="start">
                <Form.Item
                  name="reportId"
                  label="Report ID"
                  rules={[
                    {
                      required: true,
                      pattern: /^\d{1,30}$/,
                      message: 'Enter the report ID from Webinar Stars.',
                    },
                  ]}
                >
                  <Input maxLength={30} />
                </Form.Item>
                <Form.Item name="eventId" label="Bind to session">
                  <Select
                    allowClear
                    style={{ minWidth: 240 }}
                    options={(events.data ?? []).map((row) => ({
                      value: row.id,
                      label: row.title,
                    }))}
                  />
                </Form.Item>
              </Space>
              <Typography.Paragraph type="secondary">
                Select a session to calculate viewing time and apply its click statuses. Historical
                imports can be explicitly bound when Webinar Stars changed the webinar ID after
                recording. Live imports require matching webinar IDs.
              </Typography.Paragraph>
              <Form.Item name="runActions" valuePropName="checked">
                <Checkbox disabled={!connection.enabled}>
                  Run configured automations and CRM delivery (live session only)
                </Checkbox>
              </Form.Item>
              <Button htmlType="submit" loading={mutate.isPending}>
                Queue report import
              </Button>
            </Form>
            {imports.isError ? (
              failure(imports.error)
            ) : (
              <Table<ImportRow>
                rowKey="id"
                dataSource={imports.data ?? []}
                loading={imports.isFetching}
                pagination={{ pageSize: 10 }}
                scroll={{ x: 700 }}
                columns={[
                  { title: 'Report', dataIndex: 'externalReportId' },
                  { title: 'Status', dataIndex: 'state' },
                  {
                    title: 'Mode',
                    render: (_, row) => (row.historical ? 'Historical / no messages' : 'Live'),
                  },
                  { title: 'Participants', render: (_, row) => row._count.attendances },
                  { title: 'Last error', dataIndex: 'lastError' },
                  {
                    title: 'Actions',
                    render: (_, row) => (
                      <Button
                        disabled={
                          mutate.isPending ||
                          !['FAILED', 'COMPLETED', 'PARTIAL'].includes(row.state)
                        }
                        onClick={() => void run(`imports/${row.id}/retry`).catch(() => {})}
                      >
                        Refresh / retry
                      </Button>
                    ),
                  },
                ]}
              />
            )}
          </>
        ) : null}
        {tab === 'participants' ? (
          participants.isError ? (
            failure(participants.error)
          ) : (
            <Table<ParticipantRow>
              rowKey="id"
              dataSource={participants.data ?? []}
              loading={participants.isFetching}
              pagination={{ pageSize: 20 }}
              scroll={{ x: 900 }}
              expandable={{
                expandedRowRender: (row) => (
                  <Descriptions
                    column={1}
                    items={[
                      'status',
                      'watchedMinutes',
                      'watchedPercentage',
                      'completed',
                      'ctaClicked',
                      'bannerClicked',
                      'commentsCount',
                      'distributorId',
                    ].map((key) => ({ key, label: key, children: rowText(row.result[key]) }))}
                  />
                ),
              }}
              columns={[
                { title: 'Participant', render: (_, row) => rowText(row.result.name) },
                { title: 'Email', render: (_, row) => rowText(row.result.email) },
                { title: 'Report', render: (_, row) => row.report.externalReportId },
                {
                  title: 'Match',
                  render: (_, row) => (
                    <>
                      {row.contact?.displayName ?? row.matchState}
                      <br />
                      <Typography.Text type="secondary">{row.matchReason}</Typography.Text>
                    </>
                  ),
                },
                {
                  title: 'Actions',
                  render: (_, row) =>
                    row.contact || row.matchState === 'IGNORED' ? null : (
                      <Space>
                        <Button
                          onClick={() => {
                            setSelectedContact(undefined);
                            setMatchRow(row);
                          }}
                        >
                          Match contact
                        </Button>
                        <Button
                          onClick={() => {
                            contactForm.setFieldsValue({
                              displayName:
                                typeof row.result.name === 'string' ? row.result.name : '',
                              email:
                                typeof row.result.email === 'string' ? row.result.email : undefined,
                              phone:
                                typeof row.result.phone === 'string' ? row.result.phone : undefined,
                            });
                            setCreateContactRow(row);
                          }}
                        >
                          Create contact
                        </Button>
                        <Button
                          onClick={() =>
                            void run(`participants/${row.id}/match`, { ignore: true }).catch(
                              () => {},
                            )
                          }
                        >
                          Ignore
                        </Button>
                      </Space>
                    ),
                },
              ]}
            />
          )
        ) : null}
        {tab === 'actions' ? (
          actions.isError ? (
            failure(actions.error)
          ) : (
            <Table<ActionRow>
              rowKey="id"
              dataSource={actions.data ?? []}
              loading={actions.isFetching}
              pagination={{ pageSize: 20 }}
              scroll={{ x: 850 }}
              columns={[
                { title: 'Event', dataIndex: 'eventType' },
                { title: 'Destination', dataIndex: 'kind' },
                { title: 'State', dataIndex: 'state' },
                {
                  title: 'Due',
                  dataIndex: 'dueAt',
                  render: (value: string) => new Date(value).toLocaleString(),
                },
                { title: 'Last error', dataIndex: 'lastError' },
                { title: 'Attempts', dataIndex: 'attempts' },
                {
                  title: 'Actions',
                  render: (_, row) =>
                    ['FAILED', 'UNKNOWN'].includes(row.state) ? (
                      <Button onClick={() => void run(`actions/${row.id}/retry`).catch(() => {})}>
                        {row.state === 'UNKNOWN' ? 'Reconcile' : 'Retry'}
                      </Button>
                    ) : null,
                },
              ]}
            />
          )
        ) : null}
      </Space>
      <Modal
        title="Website registration setup"
        open={Boolean(registrationConfig)}
        onCancel={() => setRegistrationConfig(null)}
        footer={null}
      >
        {asObject(registrationConfig).configured === true ? (
          <>
            <Typography.Paragraph>
              Send registrations from your website backend using these headers and a unique
              Idempotency-Key. Keep the ingestion key on your server. Replace the example contact
              details with the submitted form data and consent choices.
            </Typography.Paragraph>
            <Input.TextArea
              aria-label="Website registration configuration"
              readOnly
              autoSize
              value={JSON.stringify(registrationConfig, null, 2)}
            />
          </>
        ) : (
          <Alert
            showIcon
            type="info"
            title="Set a website source key in the session settings first."
          />
        )}
      </Modal>
      <Modal
        title="Add webinar session"
        open={createOpen}
        width={720}
        onCancel={() => setCreateOpen(false)}
        onOk={() => eventForm.submit()}
        confirmLoading={mutate.isPending}
        destroyOnHidden
      >
        <Form form={eventForm} layout="vertical" onFinish={(values) => void create(values)}>
          <Form.Item name="title" label="Title" rules={[{ required: true }]}>
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item
            name="providerWebinarId"
            label="Webinar Stars webinar ID"
            rules={[{ required: true, pattern: /^\d{1,30}$/ }]}
          >
            <Input maxLength={30} />
          </Form.Item>
          <Form.Item
            name="roomUrl"
            label="Webinar Stars room URL"
            rules={[{ required: true, type: 'url' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="timezone" label="Webinar timezone (IANA)" rules={[{ required: true }]}>
            <Input placeholder="Europe/Kyiv" />
          </Form.Item>
          <Typography.Paragraph type="secondary">
            Enter both times in the selected webinar timezone.
          </Typography.Paragraph>
          <Space wrap>
            <Form.Item name="scheduledAt" label="Start" rules={[{ required: true }]}>
              <DatePicker showTime format="YYYY-MM-DD HH:mm" />
            </Form.Item>
            <Form.Item name="endsAt" label="Expected end" rules={[{ required: true }]}>
              <DatePicker showTime format="YYYY-MM-DD HH:mm" />
            </Form.Item>
          </Space>
          <SettingsFields />
        </Form>
      </Modal>
      <Modal
        title={`Session settings: ${settingsEvent?.title ?? ''}`}
        open={Boolean(settingsEvent)}
        width={720}
        onCancel={() => setSettingsEvent(null)}
        onOk={() => settingsForm.submit()}
        confirmLoading={mutate.isPending}
      >
        <Form
          form={settingsForm}
          layout="vertical"
          onFinish={(values) =>
            void run(`events/${settingsEvent!.id}/settings`, settingsInput(values), 'PUT')
              .then(() => setSettingsEvent(null))
              .catch(() => {})
          }
        >
          <SettingsFields />
        </Form>
      </Modal>
      <Modal
        title={`Register contacts: ${inviteEvent?.title ?? ''}`}
        open={Boolean(inviteEvent)}
        onCancel={() => setInviteEvent(null)}
        onOk={() => inviteForm.submit()}
        confirmLoading={mutate.isPending}
      >
        <Form
          form={inviteForm}
          layout="vertical"
          onFinish={(values) =>
            void run(`events/${inviteEvent!.id}/invitations`, {
              contactIds: values.contactIds,
              attribution: Object.fromEntries(
                [
                  ['utm_campaign', values.utm_campaign],
                  ['distributorId', values.distributorId],
                ].filter(([, value]) => value),
              ),
            })
              .then((value) => {
                setInvitations(value as InvitationRow[]);
                setShowInvitations(true);
                setInviteEvent(null);
                inviteForm.resetFields();
              })
              .catch(() => {})
          }
        >
          <Form.Item name="contactIds" label="Contacts" rules={[{ required: true }]}>
            <Select
              mode="multiple"
              showSearch
              filterOption={false}
              onSearch={setContactSearch}
              options={contactOptions}
              loading={contacts.isFetching}
            />
          </Form.Item>
          <Form.Item name="utm_campaign" label="UTM campaign">
            <Input maxLength={500} />
          </Form.Item>
          <Form.Item name="distributorId" label="Distributor ID">
            <Input maxLength={500} />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            title="Uses your published webinar scenarios"
            description="Registering a contact creates their personal link. The Webinar registered scenario handles invitations; Webinar reminder handles scheduled reminders."
          />
        </Form>
      </Modal>
      <Modal
        title="Match participant"
        open={Boolean(matchRow)}
        onCancel={() => setMatchRow(null)}
        onOk={() =>
          selectedContact &&
          void run(`participants/${matchRow!.id}/match`, { contactId: selectedContact })
            .then(() => setMatchRow(null))
            .catch(() => {})
        }
        okButtonProps={{ disabled: !selectedContact }}
        confirmLoading={mutate.isPending}
      >
        <Select
          style={{ width: '100%' }}
          showSearch
          filterOption={false}
          onSearch={setContactSearch}
          value={selectedContact}
          onChange={setSelectedContact}
          options={contactOptions}
          placeholder="Find a contact in this project"
        />
      </Modal>
      <Modal
        title="Create and match contact"
        open={Boolean(createContactRow)}
        onCancel={() => setCreateContactRow(null)}
        confirmLoading={mutate.isPending}
        onOk={() =>
          void contactForm
            .validateFields()
            .then((values) =>
              run(
                `participants/${createContactRow!.id}/contact`,
                Object.fromEntries(Object.entries(values).filter(([, value]) => Boolean(value))),
              ),
            )
            .then(() => setCreateContactRow(null))
            .catch(() => {})
        }
      >
        <Form form={contactForm} layout="vertical">
          <Form.Item name="displayName" label="Name" rules={[{ required: true, whitespace: true }]}>
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item name="email" label="Email" rules={[{ type: 'email' }]}>
            <Input maxLength={320} />
          </Form.Item>
          <Form.Item name="phone" label="Phone">
            <Input maxLength={50} />
          </Form.Item>
        </Form>
      </Modal>
      <Drawer
        title="Participant links"
        open={showInvitations}
        onClose={() => setShowInvitations(false)}
        size="large"
      >
        <Table<InvitationRow>
          rowKey="id"
          dataSource={invitations}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: 'Contact', render: (_, row) => row.contact?.displayName ?? row.id },
            {
              title: 'Personal link',
              render: (_, row) => (
                <Typography.Text copyable style={{ wordBreak: 'break-all' }}>
                  {row.participantUrl}
                </Typography.Text>
              ),
            },
            {
              title: 'Opened',
              dataIndex: 'openedAt',
              render: (value: string | null) =>
                value ? new Date(value).toLocaleString() : 'Not yet',
            },
          ]}
        />
      </Drawer>
    </Card>
  );
}

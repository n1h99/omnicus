import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import { useState } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { apiRequest, getUserErrorMessage } from '../api';
import { useAuth } from '../auth';
import { WebinarLifecyclePanel } from '../webinar-lifecycle-panel';
import {
  useWebinarStars,
  type WebinarConnection,
  type WebinarParticipant,
  type WebinarReportSummary,
  type WebinarSummary,
} from '../webinar-stars-api';

export function WebinarStarsPage() {
  const { projectId } = useParams();
  return projectId ? <WebinarWorkspace key={projectId} projectId={projectId} /> : null;
}

function WebinarWorkspace({ projectId }: { projectId: string }) {
  const { accessToken } = useAuth();
  // Configuration is shared with the workspace queries and keys each credential revision.
  const config = useQuery({
    queryKey: ['webinar-stars', projectId, 'config'],
    queryFn: ({ signal }) =>
      apiRequest<WebinarConnection | null>(
        `/api/v1/projects/${projectId}/webinar-stars`,
        { signal },
        accessToken,
      ),
    retry: false,
    gcTime: 0,
  });
  const [tab, setTab] = useState('webinars');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [reportId, setReportId] = useState<string | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [form] = Form.useForm<{ token: string }>();
  const revision = config.data?.verifiedAt ? `${config.data.id}:${config.data.revision}` : '';
  const data = useWebinarStars(projectId, revision, tab, search, offset, reportId);
  const busy = data.save.isPending || data.test.isPending || data.disconnect.isPending;
  const active = tab === 'webinars' ? data.webinars : data.reports;
  const resetView = () => {
    setOffset(0);
    setReportId(null);
  };

  const save = async ({ token }: { token: string }) => {
    try {
      await data.save.mutateAsync(token.trim());
      form.resetFields();
      resetView();
      void message.success('Connection saved. Test it to load your webinars.');
    } catch (error) {
      void message.error(getUserErrorMessage(error, 'Connection could not be saved.'));
    } finally {
      data.save.reset();
    }
  };
  const test = async () => {
    try {
      await data.test.mutateAsync();
      void message.success('Webinar Stars connection verified.');
    } catch (error) {
      void message.error(getUserErrorMessage(error, 'Connection test failed.'));
    }
  };
  const disconnect = async () => {
    try {
      await data.disconnect.mutateAsync();
      resetView();
      form.resetFields();
      setDisconnectOpen(false);
      void message.success('Webinar Stars disconnected.');
    } catch (error) {
      void message.error(getUserErrorMessage(error, 'Connection could not be removed.'));
    }
  };
  if (config.isLoading) return <Spin className="route-loading" />;
  if (config.isError)
    return (
      <Alert
        showIcon
        type="error"
        title="Connection could not be loaded"
        description={getUserErrorMessage(config.error)}
        action={<Button onClick={() => void config.refetch()}>Retry</Button>}
      />
    );

  return (
    <section>
      <div className="page-heading-row">
        <div>
          <Typography.Title level={2}>Webinar Stars</Typography.Title>
          <Typography.Text type="secondary">
            Your webinars, reports and participant activity.
          </Typography.Text>
        </div>
      </div>
      <Space orientation="vertical" size="large" style={{ width: '100%' }}>
        <Card
          title="Connection"
          extra={
            <Tag color={config.data?.verifiedAt ? 'green' : 'default'}>
              {config.data?.verifiedAt
                ? 'Verified'
                : config.data
                  ? 'Test required'
                  : 'Not connected'}
            </Tag>
          }
        >
          <Typography.Paragraph>
            Copy your API token from Webinar Stars → Integrations → API.
          </Typography.Paragraph>
          {config.data?.verifiedAt ? (
            <Typography.Paragraph type="secondary">
              Last verified: {new Date(config.data.verifiedAt).toLocaleString()}
            </Typography.Paragraph>
          ) : null}
          <Form form={form} layout="vertical" onFinish={(values) => void save(values)}>
            <Form.Item
              name="token"
              label={config.data ? 'Replace API token' : 'API token'}
              rules={[
                { required: true, whitespace: true, message: 'Enter an API token.' },
                { min: 10, max: 512, message: 'Check the API token length.' },
              ]}
            >
              <Input.Password
                autoComplete="new-password"
                placeholder={
                  config.data
                    ? 'Enter a new token to replace the saved one'
                    : 'Enter your Webinar Stars API token'
                }
                disabled={busy}
              />
            </Form.Item>
            <Space wrap>
              <Button
                type="primary"
                htmlType="submit"
                loading={data.save.isPending}
                disabled={busy}
              >
                Save connection
              </Button>
              <Button
                onClick={() => void test()}
                loading={data.test.isPending}
                disabled={!config.data || busy}
              >
                Test connection
              </Button>
              {config.data ? (
                <Button danger disabled={busy} onClick={() => setDisconnectOpen(true)}>
                  Disconnect
                </Button>
              ) : null}
            </Space>
          </Form>
        </Card>
        {revision && config.data ? (
          <WebinarLifecyclePanel key={revision} projectId={projectId} connection={config.data} />
        ) : null}
        {revision ? (
          <Card>
            <div className="page-heading-row">
              <Input.Search
                aria-label="Search webinars or reports"
                placeholder="Search by webinar name or ID"
                maxLength={120}
                allowClear
                onSearch={(value) => {
                  setSearch(value.trim());
                  resetView();
                }}
                style={{ maxWidth: 420 }}
              />
              <Button loading={active.isFetching} onClick={() => void active.refetch()}>
                Refresh
              </Button>
            </div>
            <Tabs
              activeKey={tab}
              onChange={(key) => {
                setTab(key);
                resetView();
              }}
              items={[
                { key: 'webinars', label: 'Webinars' },
                { key: 'reports', label: 'Reports' },
              ]}
            />
            <Typography.Paragraph type="secondary">
              Dates and times are shown in the webinar’s local time.
            </Typography.Paragraph>
            {active.isError ? (
              <Alert
                type="error"
                showIcon
                title="Data could not be loaded"
                description={getUserErrorMessage(active.error)}
              />
            ) : tab === 'webinars' ? (
              <Table<WebinarSummary>
                rowKey="id"
                loading={data.webinars.isFetching}
                dataSource={data.webinars.data?.items ?? []}
                pagination={false}
                scroll={{ x: 720 }}
                locale={{
                  emptyText: (
                    <Empty description="No webinars found" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                  ),
                }}
                columns={[
                  {
                    title: 'Webinar',
                    dataIndex: 'name',
                    render: (value: string | null, row) => (
                      <>
                        {value ?? 'Untitled webinar'}
                        <Typography.Text type="secondary"> · {row.id}</Typography.Text>
                      </>
                    ),
                  },
                  {
                    title: 'Type',
                    dataIndex: 'type',
                    render: (value: string) =>
                      value === 'live' ? 'Live' : value === 'auto' ? 'Automated' : 'Not specified',
                  },
                  {
                    title: 'Scheduled',
                    dataIndex: 'scheduledAtLocal',
                    render: (value: string | null) => value ?? '—',
                  },
                  {
                    title: 'Timezone',
                    dataIndex: 'timezoneName',
                    render: (value: string | null) => value ?? 'Not provided',
                  },
                  {
                    title: 'Room',
                    render: (_, row) =>
                      row.url ? (
                        <a href={row.url} target="_blank" rel="noopener noreferrer">
                          Open room
                        </a>
                      ) : (
                        '—'
                      ),
                  },
                ]}
              />
            ) : (
              <Table<WebinarReportSummary>
                rowKey="id"
                loading={data.reports.isFetching}
                dataSource={data.reports.data?.items ?? []}
                pagination={false}
                scroll={{ x: 720 }}
                locale={{
                  emptyText: (
                    <Empty description="No reports found" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                  ),
                }}
                columns={[
                  {
                    title: 'Webinar',
                    dataIndex: 'name',
                    render: (value: string | null) => value ?? 'Untitled webinar',
                  },
                  {
                    title: 'Started',
                    dataIndex: 'startedAtLocal',
                    render: (value: string | null) => value ?? '—',
                  },
                  {
                    title: 'Visitors',
                    dataIndex: 'visitorsCount',
                    render: (value: number | null) => value ?? '—',
                  },
                  {
                    title: 'Peak online',
                    dataIndex: 'visitorsPeak',
                    render: (value: number | null) => value ?? '—',
                  },
                  {
                    title: 'Report',
                    render: (_, row) => (
                      <Button onClick={() => setReportId(row.id)}>View participants</Button>
                    ),
                  },
                ]}
              />
            )}
            <Space style={{ marginTop: 16 }}>
              <Button
                disabled={offset === 0 || active.isFetching}
                onClick={() => setOffset((value) => Math.max(0, value - 25))}
              >
                Previous
              </Button>
              <Typography.Text>Page {Math.floor(offset / 25) + 1}</Typography.Text>
              <Button
                disabled={!active.data?.hasMore || active.isFetching || offset >= 100000}
                onClick={() => setOffset((value) => value + 25)}
              >
                Next
              </Button>
            </Space>
          </Card>
        ) : (
          <Alert
            showIcon
            type="info"
            title={
              config.data
                ? 'Test your connection to load webinars and reports.'
                : 'Connect your Webinar Stars account to get started.'
            }
          />
        )}
      </Space>
      <Drawer
        title={data.report.data?.name ?? 'Webinar report'}
        open={Boolean(reportId) && Boolean(revision)}
        onClose={() => setReportId(null)}
        size="large"
        destroyOnHidden
      >
        {data.report.isFetching ? (
          <Spin />
        ) : data.report.isError ? (
          <Alert
            showIcon
            type="error"
            title="Report could not be loaded"
            description={getUserErrorMessage(data.report.error)}
            action={<Button onClick={() => void data.report.refetch()}>Retry</Button>}
          />
        ) : data.report.data ? (
          <>
            <Descriptions
              column={1}
              items={[
                {
                  key: 'start',
                  label: 'Started (webinar local time)',
                  children: data.report.data.startedAtLocal ?? 'Not provided',
                },
                {
                  key: 'end',
                  label: 'Ended (webinar local time)',
                  children: data.report.data.endedAtLocal ?? 'Not provided',
                },
                {
                  key: 'visitors',
                  label: 'Reported visitors',
                  children: data.report.data.visitorsCount ?? 'Not provided',
                },
              ]}
            />
            <Typography.Paragraph type="secondary">
              Each row is a visit. Repeat visits can appear separately. Expand a visit to see
              comments and activity.
            </Typography.Paragraph>
            <Table<WebinarParticipant>
              rowKey="rowKey"
              dataSource={data.report.data.participants}
              pagination={{ pageSize: 20, showSizeChanger: false }}
              scroll={{ x: 700 }}
              locale={{ emptyText: 'No participants in this report' }}
              columns={[
                {
                  title: 'Name',
                  dataIndex: 'name',
                  render: (value: string | null) => value ?? 'Not provided',
                },
                { title: 'Email', dataIndex: 'email' },
                { title: 'Phone', dataIndex: 'phone' },
                { title: 'Joined', dataIndex: 'joinedAtLocal' },
                { title: 'Left', dataIndex: 'leftAtLocal' },
              ]}
              expandable={{
                expandedRowRender: (row) => (
                  <>
                    <Descriptions
                      column={1}
                      items={[
                        {
                          key: 'place',
                          label: 'Location',
                          children:
                            [row.country, row.city].filter(Boolean).join(', ') || 'Not provided',
                        },
                        { key: 'device', label: 'Device', children: row.device ?? 'Not provided' },
                        { key: 'utm', label: 'UTM', children: row.utm ?? 'Not provided' },
                      ]}
                    />
                    <Typography.Title level={5}>Comments</Typography.Title>
                    {row.comments.length ? (
                      row.comments.map((comment, index) => (
                        <Typography.Paragraph key={index}>
                          {comment.atLocal ? `${comment.atLocal}: ` : ''}
                          {comment.text}
                        </Typography.Paragraph>
                      ))
                    ) : (
                      <Typography.Paragraph>No comments reported.</Typography.Paragraph>
                    )}
                    <Typography.Title level={5}>Button and banner activity</Typography.Title>
                    {row.actions.length ? (
                      row.actions.map((action, index) => (
                        <Typography.Paragraph key={index}>
                          {action.type ?? 'Action'}:{' '}
                          {action.label ?? action.status ?? 'Status not provided'}
                        </Typography.Paragraph>
                      ))
                    ) : (
                      <Typography.Paragraph>No activity reported.</Typography.Paragraph>
                    )}
                  </>
                ),
              }}
            />
          </>
        ) : null}
      </Drawer>
      <Modal
        title="Disconnect Webinar Stars?"
        open={disconnectOpen}
        okText="Disconnect"
        okButtonProps={{ danger: true }}
        confirmLoading={data.disconnect.isPending}
        onOk={() => void disconnect()}
        onCancel={() => setDisconnectOpen(false)}
      >
        <Typography.Paragraph>
          The saved API token will be removed from this project.
        </Typography.Paragraph>
      </Modal>
    </section>
  );
}

import {
  ClockCircleOutlined,
  CopyOutlined,
  EyeOutlined,
  LinkOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Collapse,
  ConfigProvider,
  DatePicker,
  Form,
  Input,
  Modal,
  Space,
  Table,
  Typography,
  message,
} from 'antd';
import { useState } from 'react';
import type { Dayjs } from 'dayjs';
import { apiRequest, getUserErrorMessage } from './api';
import { useAuth } from './auth';
import './meta-leads.css';

type MetaConfig = {
  pageId: string;
  formIds: string[];
  graphVersion: string;
  enabled: boolean;
  deliveryEnabled: boolean;
  liveFrom: string | null;
  verifiedAt: string | null;
  webhookPath: string;
};
type Submission = {
  id: string;
  leadId: string;
  formId: string;
  state: string;
  historical: boolean;
  lastError: string | null;
  payload: { name?: string; email?: string; phone?: string } | null;
  result: { reason?: string; crmLeadId?: string } | null;
};
type ConfigValues = {
  pageId: string;
  formIds: string;
  graphVersion: string;
  pageToken?: string;
  appSecret?: string;
  verifyToken?: string;
};
const labels: Record<string, string> = {
  FETCH: 'Fetching',
  READY: 'Queued',
  DELIVERING: 'Delivering',
  UNKNOWN: 'Checking delivery',
  PREVIEW_NEW: 'Missing in CRM',
  PREVIEW_MATCH: 'Existing CRM card',
  REVIEW: 'Needs review',
  ERROR: 'Failed',
  DONE: 'Linked to CRM',
};

export function MetaLeadsPanel({ projectId }: { projectId: string }) {
  const { accessToken } = useAuth();
  const cache = useQueryClient();
  const base = `/api/v1/projects/${projectId}/meta-leads`;
  const [form] = Form.useForm<ConfigValues>();
  const [cursor, setCursor] = useState<string>();
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    explanation: string;
    path: string;
    body: object;
  }>();
  const config = useQuery({
    queryKey: ['meta-leads', projectId, 'config'],
    queryFn: () => apiRequest<MetaConfig | null>(base, {}, accessToken),
  });
  const submissions = useQuery({
    queryKey: ['meta-leads', projectId, 'submissions', cursor],
    enabled: Boolean(config.data),
    refetchInterval: 10_000,
    queryFn: () =>
      apiRequest<{ items: Submission[]; nextCursor: string | null }>(
        `${base}/submissions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        {},
        accessToken,
      ),
  });
  const polls = useQuery({
    queryKey: ['meta-leads', projectId, 'polls'],
    enabled: Boolean(config.data),
    refetchInterval: 10_000,
    queryFn: () =>
      apiRequest<
        Array<{ id: string; historical: boolean; completed: boolean; lastError: string | null }>
      >(`${base}/polls`, {}, accessToken),
  });
  const action = useMutation({
    mutationFn: ({
      path,
      body,
      method = 'POST',
    }: {
      path: string;
      body?: object;
      method?: string;
    }) =>
      apiRequest<unknown>(
        `${base}${path}`,
        { method, ...(body ? { body: JSON.stringify(body) } : {}) },
        accessToken,
      ),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ['meta-leads', projectId] });
      void message.success('Request completed. Check the status below.');
    },
    onError: (error) => {
      void message.error(
        getUserErrorMessage(
          error,
          'Meta lead operation failed. Check the credentials, CRM feature flag and connection.',
        ),
      );
    },
  });
  const perform = async (input: Parameters<typeof action.mutateAsync>[0]) => {
    try {
      await action.mutateAsync(input);
      return true;
    } catch {
      return false;
    }
  };
  const start = (deliveryEnabled: boolean) =>
    setConfirm({
      title: deliveryEnabled ? 'Enable live lead delivery?' : 'Start preview mode?',
      explanation: deliveryEnabled
        ? 'New submissions after the cutover may create CRM cards and Telegram notifications. Existing cards are linked without profile changes. Historical records stay pending approval.'
        : 'Receipts and periodic checks will run, but this mode does not create CRM cards or send notifications.',
      path: '/start',
      body: { liveFrom: config.data?.liveFrom ?? new Date().toISOString(), deliveryEnabled },
    });
  const deliveryMode = config.data?.enabled
    ? config.data.deliveryEnabled
      ? 'live'
      : 'preview'
    : 'disabled';
  const modeCopy = {
    live: {
      label: 'LIVE DELIVERY',
      description: 'Automatic delivery is enabled for new leads.',
    },
    preview: {
      label: 'PREVIEW ONLY',
      description: 'Compare incoming leads without automatic CRM creation.',
    },
    disabled: {
      label: 'DISABLED',
      description: 'Automatic intake is off. Saved submissions are kept.',
    },
  }[deliveryMode];

  return (
    <Card title="Meta lead forms" style={{ marginTop: 20 }}>
      <Typography.Paragraph className="meta-leads-intro" type="secondary">
        Facebook / Instagram instant forms → this project’s CRM. Preview first; existing cards are
        matched by email and phone, including archived cards. Conflicts require review.
      </Typography.Paragraph>
      {config.isError ? (
        <Typography.Paragraph type="danger">
          Meta settings could not be loaded. Check that the API deployment and database migration
          are complete.
        </Typography.Paragraph>
      ) : null}
      <section className="meta-leads-controls" aria-label="Meta lead delivery controls">
        <div className="meta-leads-controls-main">
          <div className="meta-leads-mode">
            <div className="meta-leads-mode-heading">
              <span className="meta-leads-mode-title">Delivery mode</span>
              <span
                className={`meta-leads-mode-badge meta-leads-mode-badge--${deliveryMode}`}
                role="status"
              >
                <span className="meta-leads-mode-dot" aria-hidden="true" />
                {modeCopy.label}
              </span>
            </div>
            <p className="meta-leads-mode-description">{modeCopy.description}</p>
          </div>
          <div className="meta-leads-actions" role="group" aria-label="Delivery actions">
            <Button
              icon={<SafetyCertificateOutlined />}
              loading={action.isPending}
              disabled={!config.data || config.data.enabled}
              onClick={() => void perform({ path: '/test' })}
            >
              Test access
            </Button>
            <Button
              icon={<EyeOutlined />}
              disabled={!config.data?.verifiedAt || action.isPending}
              onClick={() => start(false)}
            >
              Start preview
            </Button>
            <Button
              icon={<PlayCircleOutlined />}
              type={deliveryMode === 'live' ? 'default' : 'primary'}
              disabled={!config.data?.verifiedAt || action.isPending || config.data.deliveryEnabled}
              onClick={() => start(true)}
            >
              Enable live delivery
            </Button>
            <Button
              icon={<PauseOutlined />}
              disabled={!config.data?.enabled || action.isPending}
              onClick={() =>
                setConfirm({
                  title: 'Stop Meta intake?',
                  explanation:
                    'Background intake and delivery will stop. Already in-flight requests may complete. Stored records remain available.',
                  path: '/stop',
                  body: {},
                })
              }
            >
              Stop
            </Button>
          </div>
        </div>
        <div className="meta-leads-controls-footer">
          {config.data?.liveFrom ? (
            <div className="meta-leads-cutover">
              <ClockCircleOutlined aria-hidden="true" />
              <span>Live cutover</span>
              <time dateTime={config.data.liveFrom}>
                {new Date(config.data.liveFrom).toLocaleString()}
              </time>
              <span className="meta-leads-cutover-zone">Browser local time</span>
            </div>
          ) : null}
          <span className="meta-leads-target">Only this project’s CRM is targeted.</span>
        </div>
      </section>
      <Collapse
        items={[
          {
            key: 'settings',
            label: 'Connection settings',
            children: (
              <>
                <Typography.Paragraph type="secondary">
                  Use a separate Page token. App Secret is the existing Meta app secret; do not
                  rotate it or replace WhatsApp credentials. Secrets are encrypted and never shown
                  again. Stop intake before editing.
                </Typography.Paragraph>
                <Form
                  form={form}
                  layout="vertical"
                  key={config.data?.pageId ?? 'new'}
                  initialValues={{
                    pageId: config.data?.pageId,
                    formIds: config.data?.formIds.join(', '),
                    graphVersion: config.data?.graphVersion ?? 'v26.0',
                  }}
                  disabled={config.data?.enabled || action.isPending}
                  onFinish={async (values) => {
                    const body = {
                      ...values,
                      formIds: values.formIds.split(/[\s,]+/).filter(Boolean),
                    };
                    for (const key of ['pageToken', 'appSecret', 'verifyToken'] as const)
                      if (!body[key]?.trim()) delete body[key];
                    if (await perform({ path: '', method: 'PUT', body }))
                      form.setFieldsValue({ pageToken: '', appSecret: '', verifyToken: '' });
                  }}
                >
                  <Form.Item
                    name="pageId"
                    label="Facebook Page ID"
                    rules={[{ required: true, pattern: /^\d{1,30}$/ }]}
                  >
                    <Input autoComplete="off" disabled={Boolean(config.data)} />
                  </Form.Item>
                  <Form.Item
                    name="formIds"
                    label="Form IDs (comma-separated)"
                    rules={[{ required: true }]}
                  >
                    <Input autoComplete="off" />
                  </Form.Item>
                  <Form.Item
                    name="graphVersion"
                    label="Graph API version"
                    rules={[{ required: true, pattern: /^v\d+\.\d+$/ }]}
                  >
                    <Input />
                  </Form.Item>
                  <Form.Item
                    name="pageToken"
                    label="Page access token"
                    rules={[{ required: !config.data }]}
                  >
                    <Input.Password
                      autoComplete="new-password"
                      placeholder={config.data ? 'Leave blank to keep the saved token' : ''}
                    />
                  </Form.Item>
                  <Form.Item
                    name="appSecret"
                    label="Meta App Secret"
                    rules={[{ required: !config.data }]}
                  >
                    <Input.Password autoComplete="new-password" />
                  </Form.Item>
                  <Form.Item
                    name="verifyToken"
                    label="Webhook verify token (at least 32 characters)"
                    rules={[{ required: !config.data }, { min: 32 }]}
                  >
                    <Input.Password autoComplete="new-password" />
                  </Form.Item>
                  <Button htmlType="submit" loading={action.isPending}>
                    Save disabled configuration
                  </Button>
                </Form>
                {config.data ? (
                  <section className="meta-leads-webhook" aria-label="Webhook path">
                    <div className="meta-leads-webhook-heading">
                      <span className="meta-leads-webhook-icon" aria-hidden="true">
                        <LinkOutlined />
                      </span>
                      <div>
                        <div className="meta-leads-webhook-title">Webhook path</div>
                        <div className="meta-leads-webhook-description">
                          Add this path to your Omnicus API domain, not the website address.
                        </div>
                      </div>
                    </div>
                    <div className="meta-leads-webhook-endpoint">
                      <code>{config.data.webhookPath}</code>
                      <Button
                        aria-label="Copy webhook path"
                        icon={<CopyOutlined />}
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(config.data!.webhookPath);
                            void message.success('Webhook path copied.');
                          } catch {
                            void message.error(
                              'Could not copy. Select and copy the path manually.',
                            );
                          }
                        }}
                      >
                        Copy path
                      </Button>
                    </div>
                    <div className="meta-leads-webhook-description">
                      Subscribe the Page webhook to <code>leadgen</code>, then connect this app to
                      the Page.
                    </div>
                  </section>
                ) : null}
              </>
            ),
          },
          {
            key: 'history',
            label: 'Compare historical leads — no CRM changes',
            children: (
              <>
                <Typography.Paragraph type="secondary">
                  Choose an interval of up to 90 days. The end is exclusive. The report does not
                  import or notify; approve individual unambiguous records after checking the
                  results. Intake must be running in preview or live mode.
                </Typography.Paragraph>
                <div className="meta-leads-history-controls">
                  <ConfigProvider
                    theme={{
                      token: { controlItemBgActive: '#e7f2f0', borderRadiusSM: 6 },
                      components: {
                        DatePicker: {
                          cellActiveWithRangeBg: '#e7f2f0',
                          cellHoverWithRangeBg: '#d4e9e5',
                          cellHoverBg: '#f1f5f9',
                          cellRangeBorderColor: '#76b1a9',
                          cellWidth: 36,
                          cellHeight: 24,
                          textHeight: 40,
                          timeColumnWidth: 48,
                          timeColumnHeight: 224,
                          timeCellHeight: 28,
                          borderRadiusLG: 16,
                        },
                      },
                    }}
                  >
                    <DatePicker.RangePicker
                      className="meta-leads-history-range"
                      classNames={{ popup: { root: 'meta-leads-history-picker' } }}
                      format="MMM D, YYYY HH:mm"
                      placeholder={['Start date & time', 'End date & time']}
                      showTime={{ format: 'HH:mm', showSecond: false }}
                      value={range}
                      onChange={(value) => setRange(value)}
                    />
                  </ConfigProvider>
                  <Button
                    disabled={
                      !config.data?.enabled || !range?.[0] || !range?.[1] || action.isPending
                    }
                    onClick={() =>
                      void perform({
                        path: '/history-preview',
                        body: { from: range![0]!.toISOString(), until: range![1]!.toISOString() },
                      })
                    }
                  >
                    Run comparison
                  </Button>
                </div>
                <Typography.Paragraph style={{ marginTop: 12 }}>
                  {polls.data?.filter((poll) => poll.historical && !poll.completed).length ?? 0}{' '}
                  history scans pending. Polling checks every 5 minutes; large forms are read in
                  pages.
                </Typography.Paragraph>
              </>
            ),
          },
        ]}
      />
      {polls.data?.some((poll) => poll.lastError) ? (
        <Typography.Paragraph type="danger" style={{ marginTop: 12 }}>
          A scan needs attention:{' '}
          {Array.from(
            new Set(polls.data.filter((poll) => poll.lastError).map((poll) => poll.lastError)),
          ).join(', ')}
        </Typography.Paragraph>
      ) : null}
      {submissions.isError ? (
        <Typography.Paragraph type="danger">
          Could not load the comparison report.
        </Typography.Paragraph>
      ) : null}
      <Table<Submission>
        style={{ marginTop: 16 }}
        size="small"
        rowKey="id"
        loading={submissions.isLoading}
        dataSource={submissions.data?.items ?? []}
        pagination={false}
        scroll={{ x: 780 }}
        columns={[
          {
            title: 'Lead',
            key: 'lead',
            render: (_, row) => (
              <>
                <div>{row.payload?.name || 'Unknown'}</div>
                <Typography.Text type="secondary">
                  {row.payload?.email || row.payload?.phone || row.leadId}
                </Typography.Text>
              </>
            ),
          },
          {
            title: 'Result',
            dataIndex: 'state',
            render: (value: string, row) => (
              <>
                <div>
                  {labels[value] ?? value}
                  {row.historical ? ' · Historical' : ''}
                </div>
                <Typography.Text type="secondary">
                  {row.result?.reason || row.lastError || ''}
                </Typography.Text>
              </>
            ),
          },
          { title: 'CRM card', key: 'crm', render: (_, row) => row.result?.crmLeadId || '—' },
          {
            title: 'Action',
            key: 'action',
            render: (_, row) =>
              ['PREVIEW_NEW', 'PREVIEW_MATCH'].includes(row.state) ? (
                <Button
                  size="small"
                  disabled={!config.data?.enabled || action.isPending}
                  onClick={() =>
                    setConfirm({
                      title:
                        row.state === 'PREVIEW_NEW' ? 'Import this lead?' : 'Link this submission?',
                      explanation:
                        'Matching will be checked again. Existing card fields stay unchanged. This manually approved operation does not send a NEW LEAD notification.',
                      path: `/submissions/${row.id}/approve`,
                      body: { confirmHistoricalImport: row.historical },
                    })
                  }
                >
                  {row.state === 'PREVIEW_NEW' ? 'Import' : 'Link'}
                </Button>
              ) : ['REVIEW', 'ERROR', 'UNKNOWN'].includes(row.state) ? (
                <Button
                  size="small"
                  disabled={action.isPending}
                  onClick={() =>
                    setConfirm({
                      title: 'Recheck this submission?',
                      explanation:
                        row.state === 'UNKNOWN'
                          ? 'First check the CRM and ensure no previous writer is still running. This is an explicit retry of uncertain delivery; source-ID and contact checks will run again.'
                          : 'Resolve conflicting cards or the connection error first. The system will compare again; it never automatically merges cards.',
                      path: `/submissions/${row.id}/retry`,
                      body: { confirmUnknownRetry: row.state === 'UNKNOWN' },
                    })
                  }
                >
                  Recheck
                </Button>
              ) : (
                '—'
              ),
          },
        ]}
      />
      <Space style={{ marginTop: 12 }}>
        <Button disabled={!cursor} onClick={() => setCursor(undefined)}>
          First page
        </Button>
        <Button
          disabled={!submissions.data?.nextCursor}
          onClick={() => setCursor(submissions.data?.nextCursor ?? undefined)}
        >
          Next page
        </Button>
      </Space>
      <Modal
        title={confirm?.title}
        open={Boolean(confirm)}
        onCancel={() => setConfirm(undefined)}
        confirmLoading={action.isPending}
        onOk={async () => {
          if (confirm && (await perform(confirm))) setConfirm(undefined);
        }}
      >
        <Typography.Paragraph>{confirm?.explanation}</Typography.Paragraph>
      </Modal>
    </Card>
  );
}

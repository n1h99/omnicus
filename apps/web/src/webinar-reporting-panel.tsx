import { useEffect, useState } from 'react';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { Link } from 'react-router';
import { apiRequest, getUserErrorMessage } from './api';
import { useAuth } from './auth';
import { hasProjectPermission, useProjectAccess } from './project-access';

interface ReportChoice {
  id: string;
  externalReportId: string;
  event?: { title: string } | null;
}
interface Participant {
  id: string;
  contactId: string | null;
  contactName: string | null;
  crmLeadId: string | null;
  matchState: string;
  matchReason: string | null;
  result: Record<string, unknown>;
}
interface ReportData {
  report: {
    id: string;
    externalReportId: string;
    state: string;
    historical: boolean;
    lastError: string | null;
    processedAt: string | null;
    summary: Record<string, unknown> | null;
    event: { title: string; timezone: string } | null;
  } | null;
  summary: Record<string, number | null> | null;
  items: Participant[];
  total: number;
  page: number;
  pageSize: number;
}
const text = (value: unknown) =>
  value === null || value === undefined || value === '' ? 'Not provided' : String(value);
const flag = (value: unknown) =>
  value === true ? (
    <Tag color="green">Yes</Tag>
  ) : value === false ? (
    <Tag>No</Tag>
  ) : (
    <Typography.Text type="secondary">Unknown</Typography.Text>
  );
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const labels: Record<string, string> = {
  ATTENDED: 'Attended',
  MISSED: 'Missed',
  COMPLETED: 'Completed',
  PARTIALLY_WATCHED: 'Partially watched',
  REPLAY_VIEWED: 'Replay viewed',
  UNKNOWN: 'Unknown',
};

export function WebinarReportingPanel({
  projectId,
  revision,
  reports,
  importId,
  onSelect,
}: {
  projectId: string;
  revision: number;
  reports: ReportChoice[];
  importId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const { accessToken } = useAuth();
  const access = useProjectAccess(projectId);
  const [filters, setFilters] = useState({
    search: '',
    status: '',
    match: '',
    cta: '',
    replay: '',
    sort: 'name',
  });
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(20);
  const [detail, setDetail] = useState<Participant | null>(null);
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(filters.search), 250);
    return () => clearTimeout(timer);
  }, [filters.search]);
  const selected = importId ?? reports[0]?.id;
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (selected) params.set('importId', selected);
  for (const [key, value] of Object.entries({ ...filters, search }))
    if (value) params.set(key, value);
  const query = useQuery({
    queryKey: ['webinar-lifecycle', projectId, revision, 'reporting', params.toString()],
    queryFn: ({ signal }) =>
      apiRequest<ReportData>(
        `/api/v1/projects/${projectId}/webinar-stars/reporting?${params}`,
        { signal },
        accessToken,
      ),
    enabled: Boolean(selected),
    retry: false,
    gcTime: 0,
    refetchInterval: 10000,
  });
  const change = (key: keyof typeof filters, value: string) => {
    setFilters((old) => ({ ...old, [key]: value }));
    setPage(1);
  };
  const data = query.data,
    report = data?.report,
    summary = data?.summary;
  const comments = Array.isArray(detail?.result.comments) ? detail.result.comments.map(object) : [];
  return (
    <div className="webinar-workflow-stack">
      <div className="webinar-report-heading">
        <div>
          <Typography.Title level={4}>Webinar results</Typography.Title>
          <Typography.Text type="secondary">
            Saved results for your team. Counts refer to the whole selected report.
          </Typography.Text>
        </div>
        <Button
          icon={<ReloadOutlined />}
          loading={query.isFetching}
          disabled={!selected}
          onClick={() => void query.refetch()}
        >
          Refresh results
        </Button>
      </div>
      <Select
        aria-label="Saved report"
        className="webinar-report-select"
        showSearch
        optionFilterProp="label"
        placeholder="Choose a saved report"
        value={selected}
        options={reports.map((row) => ({
          value: row.id,
          label: `${row.event?.title ?? 'Report'} · ${row.externalReportId}`,
        }))}
        onChange={(id) => {
          if (id) onSelect(id);
          setPage(1);
          setDetail(null);
        }}
      />
      {!reports.length ? (
        <Empty description="No saved reports. Import a report or wait for a completed webinar." />
      ) : null}
      {query.isError ? (
        <Alert
          type="error"
          showIcon
          title="Results could not be loaded"
          description={getUserErrorMessage(query.error)}
        />
      ) : null}
      {report ? (
        <>
          <Space wrap>
            <Typography.Text strong>
              {report.event?.title ?? text(report.summary?.name)}
            </Typography.Text>
            <Tag>{report.state}</Tag>
            <Tag>{report.historical ? 'Historical' : 'Live'}</Tag>
            <Typography.Text type="secondary">Report {report.externalReportId}</Typography.Text>
          </Space>
          <Descriptions
            size="small"
            column={{ xs: 1, sm: 2, lg: 3 }}
            items={[
              {
                key: 'start',
                label: 'Actual start',
                children: text(report.summary?.startedAtLocal),
              },
              { key: 'end', label: 'Actual end', children: text(report.summary?.endedAtLocal) },
              {
                key: 'timezone',
                label: 'Timezone',
                children: report.event?.timezone ?? 'Webinar local time',
              },
              {
                key: 'processed',
                label: 'Last processed',
                children: report.processedAt
                  ? new Date(report.processedAt).toLocaleString()
                  : 'Pending',
              },
            ]}
          />
          {report.lastError ? (
            <Alert
              type="error"
              showIcon
              title="Report processing needs attention"
              description={report.lastError}
            />
          ) : null}
          {summary ? (
            <div className="webinar-report-stats">
              {[
                ['registered', 'Registered'],
                ['attended', 'Attended'],
                ['missed', 'Confirmed missed'],
                ['completed', 'Completed'],
                ['partial', 'Partially watched'],
                ['ctaClicked', 'CTA clicked'],
                ['replay', 'Replay viewed'],
                ['comments', 'Comments'],
                ['unmatched', 'Unmatched'],
                ['deliveryErrors', 'Action errors'],
              ].map(([key, label]) => (
                <Card size="small" key={key}>
                  <Typography.Text type="secondary">{label}</Typography.Text>
                  <div className="webinar-report-stat-value">{summary[key!] ?? '—'}</div>
                </Card>
              ))}
            </div>
          ) : null}
          {summary &&
          (Number(summary.unmatched) > 0 || !['COMPLETED', 'PARTIAL'].includes(report.state)) ? (
            <Alert
              type="info"
              showIcon
              title="Results are provisional"
              description="No-show conclusions wait for a completed report and resolved participants. Use Matching to resolve unknown contacts."
            />
          ) : null}
          <Typography.Paragraph type="secondary">
            Participants are normalized identities, not raw room visits. Missing provider evidence
            is shown as Unknown. Ignored rows are excluded from attendance counts.
            {hasProjectPermission(access.data, 'automation:read') ? (
              <>
                {' '}
                <Link to={`/projects/${projectId}/automation-activity`}>
                  View scenario activity and message delivery
                </Link>
              </>
            ) : null}
          </Typography.Paragraph>
        </>
      ) : null}
      {selected ? (
        <>
          <div className="webinar-report-filters">
            <Input
              aria-label="Search report participants"
              prefix={<SearchOutlined />}
              placeholder="Name, email, phone, UTM or distributor"
              maxLength={120}
              allowClear
              value={filters.search}
              onChange={(event) => change('search', event.target.value)}
            />
            <Select
              aria-label="Attendance status"
              value={filters.status}
              onChange={(value) => change('status', value)}
              options={[
                { value: '', label: 'All attendance statuses' },
                ...Object.entries(labels).map(([value, label]) => ({ value, label })),
              ]}
            />
            <Select
              aria-label="Matching status"
              value={filters.match}
              onChange={(value) => change('match', value)}
              options={[
                { value: '', label: 'Active participants' },
                ...['MATCHED', 'MANUAL', 'UNMATCHED', 'IGNORED'].map((value) => ({
                  value,
                  label: value.charAt(0) + value.slice(1).toLowerCase(),
                })),
              ]}
            />
            <Select
              aria-label="CTA filter"
              value={filters.cta}
              onChange={(value) => change('cta', value)}
              options={[
                { value: '', label: 'All CTA results' },
                { value: 'yes', label: 'CTA clicked' },
                { value: 'no', label: 'CTA not clicked' },
                { value: 'unknown', label: 'CTA unknown' },
              ]}
            />
            <Select
              aria-label="Replay filter"
              value={filters.replay}
              onChange={(value) => change('replay', value)}
              options={[
                { value: '', label: 'All viewing types' },
                { value: 'yes', label: 'Replay' },
                { value: 'no', label: 'Live' },
                { value: 'unknown', label: 'Viewing type unknown' },
              ]}
            />
            <Select
              aria-label="Sort participants"
              value={filters.sort}
              onChange={(value) => change('sort', value)}
              options={[
                { value: 'name', label: 'Sort by name' },
                { value: 'watched', label: 'Longest viewing first' },
              ]}
            />
          </div>
          <Table<Participant>
            rowKey="id"
            loading={query.isFetching}
            dataSource={data?.items ?? []}
            scroll={{ x: 1380 }}
            pagination={{
              current: page,
              pageSize,
              total: data?.total ?? 0,
              showSizeChanger: true,
              pageSizeOptions: [20, 50, 100],
              showTotal: (total) => `${total} participants`,
              onChange: (nextPage, size) => {
                setPage(size === pageSize ? nextPage : 1);
                setPageSize(size);
              },
            }}
            columns={[
              {
                title: 'Participant',
                key: 'name',
                width: 220,
                render: (_, row) => (
                  <>
                    <div>
                      {row.contactId ? (
                        <Link to={`/projects/${projectId}/contacts/${row.contactId}`}>
                          {row.contactName ?? text(row.result.name)}
                        </Link>
                      ) : (
                        text(row.result.name)
                      )}
                    </div>
                    <Typography.Text type="secondary">{text(row.result.email)}</Typography.Text>
                    <div>{row.result.phone ? String(row.result.phone) : ''}</div>
                  </>
                ),
              },
              {
                title: 'Status',
                key: 'status',
                render: (_, row) => labels[String(row.result.status)] ?? text(row.result.status),
              },
              {
                title: 'Viewing',
                key: 'viewing',
                render: (_, row) => (
                  <>
                    {typeof row.result.watchedSeconds === 'number'
                      ? `${Math.floor(row.result.watchedSeconds / 60)}m ${row.result.watchedSeconds % 60}s`
                      : 'Unknown'}
                    <div>
                      {typeof row.result.watchedPercentage === 'number'
                        ? `${row.result.watchedPercentage}%`
                        : 'Unknown'}
                    </div>
                  </>
                ),
              },
              { title: 'CTA', key: 'cta', render: (_, row) => flag(row.result.ctaClicked) },
              {
                title: 'Banner',
                key: 'banner',
                render: (_, row) => flag(row.result.bannerClicked),
              },
              {
                title: 'Comments',
                key: 'comments',
                render: (_, row) => text(row.result.commentsCount),
              },
              {
                title: 'Source / campaign',
                key: 'source',
                render: (_, row) => (
                  <>
                    {text(object(row.result.utm).utm_source)}
                    <div>{text(object(row.result.utm).utm_campaign)}</div>
                  </>
                ),
              },
              {
                title: 'Distributor',
                key: 'distributor',
                render: (_, row) => text(row.result.distributorId),
              },
              { title: 'Replay', key: 'replay', render: (_, row) => flag(row.result.isReplay) },
              {
                title: 'Matching',
                key: 'matching',
                render: (_, row) => <Tag>{row.matchState}</Tag>,
              },
              {
                title: 'Details',
                key: 'details',
                render: (_, row) => (
                  <Button size="small" onClick={() => setDetail(row)}>
                    View result
                  </Button>
                ),
              },
            ]}
          />
        </>
      ) : null}
      <Drawer
        title="Participant result"
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        size="large"
      >
        {detail ? (
          <Space orientation="vertical" size="large" style={{ width: '100%' }}>
            <Descriptions
              column={1}
              items={[
                { key: 'name', label: 'Participant', children: text(detail.result.name) },
                { key: 'contact', label: 'Contact', children: text(detail.contactName) },
                { key: 'crm', label: 'CRM lead', children: text(detail.crmLeadId) },
                ...(
                  [
                    ['email', 'Email'],
                    ['phone', 'Phone'],
                    ['status', 'Status'],
                    ['watchedMinutes', 'Watched minutes'],
                    ['watchedPercentage', 'Watched percentage'],
                    ['firstJoinedAtLocal', 'First entry (webinar time)'],
                    ['lastLeftAtLocal', 'Last exit (webinar time)'],
                    ['distributorId', 'Distributor'],
                  ] as const
                ).map(([key, label]) => ({ key, label, children: text(detail.result[key]) })),
                {
                  key: 'match',
                  label: 'Matching',
                  children: `${detail.matchState} · ${detail.matchReason ?? ''}`,
                },
                { key: 'cta', label: 'CTA clicked', children: flag(detail.result.ctaClicked) },
                { key: 'replay', label: 'Replay', children: flag(detail.result.isReplay) },
              ]}
            />
            <div>
              <Typography.Title level={5}>Attribution</Typography.Title>
              <Descriptions
                column={1}
                items={Object.entries(object(detail.result.utm)).map(([key, value]) => ({
                  key,
                  label: key,
                  children: text(value),
                }))}
              />
            </div>
            <div>
              <Typography.Title level={5}>Comments</Typography.Title>
              {comments.length ? (
                comments.map((comment, index) => (
                  <Card size="small" key={index}>
                    <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>
                      {text(comment.text)}
                    </Typography.Paragraph>
                    <Typography.Text type="secondary">{text(comment.atLocal)}</Typography.Text>
                  </Card>
                ))
              ) : (
                <Typography.Text type="secondary">No comments reported.</Typography.Text>
              )}
            </div>
          </Space>
        ) : null}
      </Drawer>
    </div>
  );
}

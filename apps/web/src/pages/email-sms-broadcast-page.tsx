import {
  ArrowRightOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  MailOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  RocketOutlined,
  SafetyCertificateOutlined,
  SaveOutlined,
  SendOutlined,
  StopOutlined,
} from '@ant-design/icons';
import {
  createDefaultEmailDocument,
  emailDocumentSchema,
  type EmailDocument,
} from '@omnicus/email-core';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import dayjs from 'dayjs';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';

import { getUserErrorMessage } from '../api';
import { EmailBuilder } from '../email-builder';
import {
  type EmailAudience,
  type EmailAnalyticsEvent,
  type EmailCampaign,
  type EmailCampaignInput,
  type EmailCampaignStatus,
  type EmailTemplate,
  type EmailTemplateVersion,
  useEmailAnalytics,
  useEmailAudienceOptions,
  useEmailCampaignDeliveries,
  useEmailCampaigns,
  useEmailMutations,
  useEmailSuppressions,
  useEmailTemplates,
} from '../email-api';
import '../email-broadcast.css';

type ChannelView = 'email' | 'sms';
type EmailTab = 'analytics' | 'campaigns' | 'templates' | 'suppressions';

const statusColor: Record<EmailCampaignStatus, string> = {
  CANCELLED: 'default',
  COMPLETED: 'success',
  DRAFT: 'default',
  FAILED: 'error',
  PAUSED: 'warning',
  PREPARING: 'processing',
  SCHEDULED: 'cyan',
  RUNNING: 'processing',
};

function titleCase(value: string) {
  return value.toLowerCase().replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function ActionConfirmModal({
  confirmLabel,
  description,
  loading = false,
  onCancel,
  onConfirm,
  open,
  title,
}: {
  confirmLabel: string;
  description: string;
  loading?: boolean | undefined;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
  open: boolean;
  title: string;
}) {
  return (
    <Modal
      className="account-confirm-modal"
      closable={!loading}
      footer={null}
      keyboard={!loading}
      maskClosable={!loading}
      onCancel={() => {
        if (!loading) onCancel();
      }}
      open={open}
      title={title}
      width={460}
    >
      <Typography.Paragraph type="secondary">{description}</Typography.Paragraph>
      <div className="modal-form-actions">
        <Button disabled={loading} onClick={onCancel}>Cancel</Button>
        <Button danger loading={loading} onClick={() => void onConfirm()}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

function campaignInput(campaign: EmailCampaign): EmailCampaignInput {
  return {
    audience: campaign.audience,
    design: campaign.design,
    name: campaign.name,
    preheader: campaign.preheader,
    scheduledAt: campaign.scheduledAt,
    sourceTemplateVersionId: campaign.sourceTemplateVersionId,
    subject: campaign.subject,
  };
}

export function EmailSmsBroadcastPage() {
  const { projectId } = useParams();
  const [channel, setChannel] = useState<ChannelView>('email');
  const [tab, setTab] = useState<EmailTab>('campaigns');
  const [editingCampaign, setEditingCampaign] = useState<EmailCampaign>();
  const [editingTemplate, setEditingTemplate] = useState<EmailTemplate>();
  const [resultsCampaign, setResultsCampaign] = useState<EmailCampaign>();
  const campaigns = useEmailCampaigns(projectId);
  const templates = useEmailTemplates(projectId);
  const suppressions = useEmailSuppressions(projectId);
  const options = useEmailAudienceOptions(projectId);
  const mutations = useEmailMutations(projectId);
  const deliveries = useEmailCampaignDeliveries(projectId, resultsCampaign?.id);

  const totals = useMemo(() => {
    const items = campaigns.data ?? [];
    return {
      active: items.filter((item) => ['PREPARING', 'SCHEDULED', 'RUNNING'].includes(item.status)).length,
      delivered: items.reduce(
        (sum, item) =>
          sum +
          (item.metrics.DELIVERED ?? 0) +
          (item.metrics.OPENED ?? 0) +
          (item.metrics.CLICKED ?? 0),
        0,
      ),
      drafts: items.filter((item) => item.status === 'DRAFT').length,
      recipients: items.reduce((sum, item) => sum + item.totalRecipients, 0),
    };
  }, [campaigns.data]);

  const createCampaign = async (version?: EmailTemplateVersion) => {
    try {
      const created = await mutations.createCampaign.mutateAsync({
        audience: { mode: 'ALL_ACTIVE' },
        design: version?.design ?? createDefaultEmailDocument(),
        name: `Email campaign ${dayjs().format('MMM D, HH:mm:ss')}`,
        preheader: version?.preheader ?? null,
        sourceTemplateVersionId: version?.id ?? null,
        subject: version?.subject ?? 'A message from Omnicus',
      });
      setEditingCampaign(created);
    } catch (error) {
      void message.error(getUserErrorMessage(error, 'Campaign could not be created.'));
    }
  };

  const createTemplate = async () => {
    try {
      const created = await mutations.createTemplate.mutateAsync({
        design: createDefaultEmailDocument(),
        name: `Email template ${dayjs().format('MMM D, HH:mm:ss')}`,
        subject: 'A message from Omnicus',
      });
      setEditingTemplate(created);
    } catch (error) {
      void message.error(getUserErrorMessage(error, 'Template could not be created.'));
    }
  };

  return (
    <section className="email-broadcast-page">
      <div className="email-broadcast-hero">
        <div>
          <Typography.Text className="email-hero-kicker">OUTBOUND STUDIO</Typography.Text>
          <Typography.Title level={2}>Email & SMS Broadcast</Typography.Title>
          <Typography.Paragraph>
            Design personal campaigns, manage recipients and follow delivery from inbox to CRM.
          </Typography.Paragraph>
        </div>
        <Segmented
          block
          className="email-channel-switch"
          onChange={(value) => setChannel(value as ChannelView)}
          options={[
            { icon: <MailOutlined />, label: 'Email', value: 'email' },
            { icon: <SendOutlined />, label: 'SMS', value: 'sms' },
          ]}
          value={channel}
        />
      </div>

      {channel === 'sms' ? <SmsUnderConstruction /> : (
        <>
          <div className="email-stat-grid">
            <Card><Statistic prefix={<FileTextOutlined />} title="Drafts" value={totals.drafts} /></Card>
            <Card><Statistic prefix={<RocketOutlined />} title="Active campaigns" value={totals.active} /></Card>
            <Card><Statistic prefix={<SendOutlined />} title="Queued recipients" value={totals.recipients} /></Card>
            <Card><Statistic prefix={<CheckCircleOutlined />} title="Delivered" value={totals.delivered} /></Card>
          </div>

          <Card className="email-command-card">
            <Tabs
              activeKey={tab}
              items={[
                { key: 'campaigns', label: 'Campaigns' },
                { key: 'templates', label: 'Templates' },
                { key: 'suppressions', label: 'Suppression list' },
                { key: 'analytics', label: 'Analytics' },
              ]}
              onChange={(value) => setTab(value as EmailTab)}
              tabBarExtraContent={
                tab === 'campaigns' ? (
                  <Button icon={<PlusOutlined />} onClick={() => void createCampaign()} type="primary">Create email</Button>
                ) : tab === 'templates' ? (
                  <Button icon={<PlusOutlined />} onClick={() => void createTemplate()} type="primary">New template</Button>
                ) : null
              }
            />
            <div className="email-command-content">
              {tab === 'campaigns' ? (
                <CampaignTable
                  campaigns={campaigns.data ?? []}
                  loading={campaigns.isLoading}
                  onEdit={setEditingCampaign}
                  onResults={setResultsCampaign}
                />
              ) : null}
              {tab === 'analytics' ? <EmailAnalytics projectId={projectId} /> : null}
              {tab === 'templates' ? (
                <TemplateLibrary
                  loading={templates.isLoading}
                  onCreateCampaign={(version) => void createCampaign(version)}
                  onEdit={setEditingTemplate}
                  templates={templates.data ?? []}
                />
              ) : null}
              {tab === 'suppressions' ? (
                <SuppressionList
                  items={suppressions.data ?? []}
                  loading={suppressions.isLoading}
                  projectId={projectId}
                />
              ) : null}
            </div>
          </Card>
        </>
      )}

      <CampaignEditor
        campaign={editingCampaign}
        onClose={() => setEditingCampaign(undefined)}
        onUpdated={setEditingCampaign}
        options={options.data}
        projectId={projectId}
        templates={templates.data ?? []}
      />
      <TemplateEditor
        onClose={() => setEditingTemplate(undefined)}
        onUpdated={setEditingTemplate}
        projectId={projectId}
        template={editingTemplate}
      />
      <Modal
        footer={null}
        onCancel={() => setResultsCampaign(undefined)}
        open={Boolean(resultsCampaign)}
        title={resultsCampaign ? `Delivery report · ${resultsCampaign.name}` : 'Delivery report'}
        width={980}
      >
        <Table
          columns={[
            { dataIndex: ['contact', 'displayName'], title: 'Contact' },
            { dataIndex: 'toEmail', title: 'Email' },
            { dataIndex: 'status', render: (value) => <Tag>{titleCase(value)}</Tag>, title: 'Status' },
            { dataIndex: 'attempts', title: 'Attempts', width: 100 },
            { dataIndex: 'lastError', ellipsis: true, title: 'Last error' },
          ]}
          dataSource={deliveries.data ?? []}
          loading={deliveries.isLoading}
          pagination={{ pageSize: 10 }}
          rowKey="id"
        />
      </Modal>
    </section>
  );
}

const emailActivityPresentation: Record<string, { color: string; label: string }> = {
  BOUNCED: { color: 'orange', label: 'Bounced' },
  CLICKED: { color: 'green', label: 'Link clicked' },
  COMPLAINED: { color: 'red', label: 'Spam complaint' },
  DELIVERED: { color: 'cyan', label: 'Delivered' },
  DELIVERY_DELAYED: { color: 'gold', label: 'Delivery delayed' },
  FAILED: { color: 'red', label: 'Failed' },
  OPENED: { color: 'blue', label: 'Opened' },
  SENT: { color: 'geekblue', label: 'Sent' },
  UNSUBSCRIBED: { color: 'volcano', label: 'Unsubscribed' },
};

function emailSourceLabel(source: string) {
  if (source === 'CAMPAIGN') return 'Email campaign';
  if (source === 'AUTOMATION') return 'Automation';
  if (source === 'TEST') return 'Test email';
  return titleCase(source);
}

function EmailAnalytics({ projectId }: { projectId?: string | undefined }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const analytics = useEmailAnalytics(projectId, page, pageSize);
  const data = analytics.data;

  return (
    <div className="email-analytics">
      <div className="email-section-intro">
        <div>
          <Typography.Title level={4}>Email activity</Typography.Title>
          <Typography.Text type="secondary">
            A detailed delivery timeline across campaigns, automations and test messages.
          </Typography.Text>
        </div>
        <Tag color="cyan">{data?.total ?? 0} events</Tag>
      </div>
      <Table<EmailAnalyticsEvent>
        columns={[
          {
            dataIndex: 'type',
            render: (value: string) => {
              const presentation = emailActivityPresentation[value] ?? {
                color: 'default',
                label: titleCase(value),
              };
              return <Tag color={presentation.color}>{presentation.label}</Tag>;
            },
            title: 'Activity',
            width: 125,
          },
          {
            render: (_, event) => (
              <div className="email-analytics-primary">
                <strong>{event.contactName || event.email}</strong>
                <small>{event.contactName ? event.email : 'Contact is not linked'}</small>
              </div>
            ),
            title: 'Recipient',
            width: 210,
          },
          {
            render: (_, event) => (
              <div className="email-analytics-primary">
                <strong>{event.campaignName || emailSourceLabel(event.source)}</strong>
                <small>{emailSourceLabel(event.source)}</small>
              </div>
            ),
            title: 'Campaign / source',
            width: 180,
          },
          {
            dataIndex: 'subject',
            ellipsis: true,
            title: 'Subject',
            width: 185,
          },
          {
            dataIndex: 'targetUrl',
            render: (targetUrl: string | null) => targetUrl ? (
              <Typography.Link
                copyable={{ text: targetUrl }}
                ellipsis
                href={targetUrl}
                rel="noreferrer"
                style={{ maxWidth: '100%' }}
                target="_blank"
                title={targetUrl}
              >
                {targetUrl}
              </Typography.Link>
            ) : <Typography.Text type="secondary">Not applicable</Typography.Text>,
            title: 'Opened link',
            width: 220,
          },
          {
            render: (_, event) => (
              <div className="email-analytics-client">
                <span>{event.ipAddress || 'IP not provided'}</span>
                <Typography.Text ellipsis={{ tooltip: event.userAgent || undefined }} type="secondary">
                  {event.userAgent || 'Client details unavailable'}
                </Typography.Text>
              </div>
            ),
            title: 'Client',
            width: 190,
          },
          {
            dataIndex: 'occurredAt',
            render: (value: string) => (
              <div className="email-analytics-time">
                <strong>{dayjs(value).format('MMM D, YYYY')}</strong>
                <small>{dayjs(value).format('HH:mm:ss')}</small>
              </div>
            ),
            title: 'Time',
            width: 125,
          },
        ]}
        dataSource={data?.items ?? []}
        loading={analytics.isLoading}
        locale={{
          emptyText: <Empty description="Email activity will appear after messages are sent" image={Empty.PRESENTED_IMAGE_SIMPLE} />,
        }}
        onChange={(pagination) => {
          setPage(pagination.current ?? 1);
          setPageSize(pagination.pageSize ?? 25);
        }}
        pagination={{
          current: data?.page ?? page,
          pageSize: data?.pageSize ?? pageSize,
          showSizeChanger: true,
          showTotal: (total) => `${total} events`,
          total: data?.total ?? 0,
        }}
        rowKey="id"
        tableLayout="fixed"
      />
    </div>
  );
}

function CampaignTable({
  campaigns,
  loading,
  onEdit,
  onResults,
}: {
  campaigns: EmailCampaign[];
  loading: boolean;
  onEdit: (campaign: EmailCampaign) => void;
  onResults: (campaign: EmailCampaign) => void;
}) {
  const { projectId } = useParams();
  const mutations = useEmailMutations(projectId);
  const [cancelTarget, setCancelTarget] = useState<EmailCampaign>();
  const [deleteTarget, setDeleteTarget] = useState<EmailCampaign>();
  const run = async (operation: () => Promise<unknown>, success: string) => {
    try {
      await operation();
      void message.success(success);
      return true;
    } catch (error) {
      void message.error(getUserErrorMessage(error, 'Campaign action failed.'));
      return false;
    }
  };
  return (
    <>
      <Table<EmailCampaign>
      columns={[
        {
          dataIndex: 'name',
          render: (_, record) => (
            <button className="email-campaign-name" onClick={() => onEdit(record)} type="button">
              <span>{record.name}</span><small>{record.subject}</small>
            </button>
          ),
          title: 'Campaign',
        },
        { dataIndex: 'status', render: (value) => <Tag color={statusColor[value as EmailCampaignStatus]}>{titleCase(value)}</Tag>, title: 'Status', width: 180 },
        { dataIndex: 'totalRecipients', render: (value, record) => <Button onClick={() => onResults(record)} type="link">{value}</Button>, title: 'Recipients', width: 120 },
        { render: (_, record) => (record.metrics.DELIVERED ?? 0) + (record.metrics.OPENED ?? 0) + (record.metrics.CLICKED ?? 0), title: 'Delivered', width: 110 },
        { render: (_, record) => record.metrics.CLICKED ?? 0, title: 'Clicked', width: 100 },
        { dataIndex: 'updatedAt', render: (value) => dayjs(value).format('MMM D, HH:mm'), title: 'Updated', width: 150 },
        {
          render: (_, record) => (
            <Space>
              <Button icon={<EditOutlined />} onClick={() => onEdit(record)} size="small">Open</Button>
              {record.status === 'DRAFT' ? <Button danger icon={<DeleteOutlined />} onClick={() => setDeleteTarget(record)} size="small">Delete</Button> : null}
              {record.status === 'RUNNING' ? <Button icon={<PauseOutlined />} onClick={() => void run(() => mutations.pauseCampaign.mutateAsync(record.id), 'Campaign paused.')} size="small" /> : null}
              {record.status === 'PAUSED' ? <Button icon={<PlayCircleOutlined />} onClick={() => void run(() => mutations.resumeCampaign.mutateAsync(record.id), 'Campaign resumed.')} size="small" /> : null}
              {record.status === 'FAILED' || (record.status === 'COMPLETED' && Boolean(record.errorCode)) ? <Button icon={<ReloadOutlined />} onClick={() => void run(() => mutations.retryCampaign.mutateAsync(record.id), 'Failed deliveries queued again.')} size="small">Retry</Button> : null}
              {['SCHEDULED', 'PREPARING', 'RUNNING', 'PAUSED'].includes(record.status) ? <Button danger icon={<StopOutlined />} onClick={() => setCancelTarget(record)} size="small" /> : null}
            </Space>
          ),
          title: '',
          width: 220,
        },
      ]}
      dataSource={campaigns}
      loading={loading}
      locale={{ emptyText: <Empty description="Create your first email campaign" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
      pagination={{ pageSize: 10 }}
      rowKey="id"
        scroll={{ x: 1050 }}
      />
      <ActionConfirmModal
        confirmLabel="Delete campaign"
        description={deleteTarget ? `"${deleteTarget.name}" will be permanently deleted. This action cannot be undone.` : ''}
        loading={mutations.deleteCampaign.isPending}
        onCancel={() => setDeleteTarget(undefined)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          const deleted = await run(
            () => mutations.deleteCampaign.mutateAsync(deleteTarget.id),
            'Campaign deleted.',
          );
          if (deleted) setDeleteTarget(undefined);
        }}
        open={Boolean(deleteTarget)}
        title="Delete this email campaign?"
      />
      <ActionConfirmModal
        confirmLabel="Cancel campaign"
        description={cancelTarget ? `"${cancelTarget.name}" will stop sending to recipients that have not been processed yet.` : ''}
        loading={mutations.cancelCampaign.isPending}
        onCancel={() => setCancelTarget(undefined)}
        onConfirm={async () => {
          if (!cancelTarget) return;
          const cancelled = await run(
            () => mutations.cancelCampaign.mutateAsync(cancelTarget.id),
            'Campaign cancelled.',
          );
          if (cancelled) setCancelTarget(undefined);
        }}
        open={Boolean(cancelTarget)}
        title="Cancel this email campaign?"
      />
    </>
  );
}

function CampaignEditor({
  campaign,
  onClose,
  onUpdated,
  options,
  projectId,
  templates,
}: {
  campaign?: EmailCampaign | undefined;
  onClose: () => void;
  onUpdated: (campaign: EmailCampaign) => void;
  options?: ReturnType<typeof useEmailAudienceOptions>['data'];
  projectId?: string | undefined;
  templates: EmailTemplate[];
}) {
  const mutations = useEmailMutations(projectId);
  const [draft, setDraft] = useState<EmailCampaignInput>();
  const [launchEstimate, setLaunchEstimate] = useState<{
    duplicateAddresses: number;
    eligibleRecipients: number;
    excludedSuppressed: number;
    totalMatched: number;
  }>();
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  const [testOpen, setTestOpen] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const lastSaved = useRef('');
  const updateCampaignRef = useRef(mutations.updateCampaign.mutateAsync);
  const onUpdatedRef = useRef(onUpdated);
  updateCampaignRef.current = mutations.updateCampaign.mutateAsync;
  onUpdatedRef.current = onUpdated;

  useEffect(() => {
    if (!campaign) return;
    const next = campaignInput(campaign);
    setDraft(next);
    lastSaved.current = JSON.stringify(next);
    setSaveState('saved');
  }, [campaign?.id]);

  useEffect(() => {
    if (!campaign || !draft || campaign.status !== 'DRAFT') return;
    const serialized = JSON.stringify(draft);
    if (serialized === lastSaved.current) return;
    setSaveState('unsaved');
    if (
      !draft.name.trim() ||
      !draft.subject.trim() ||
      !emailDocumentSchema.safeParse(draft.design).success
    )
      return;
    const timer = window.setTimeout(() => {
      setSaveState('saving');
      void updateCampaignRef.current({ id: campaign.id, ...draft })
        .then((updated) => {
          lastSaved.current = JSON.stringify(campaignInput(updated));
          setSaveState('saved');
          onUpdatedRef.current(updated);
        })
        .catch((error) => {
          setSaveState('unsaved');
          void message.error(getUserErrorMessage(error, 'Draft could not be saved.'));
        });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [campaign?.id, campaign?.status, draft]);

  if (!campaign || !draft) return null;
  const editable = campaign.status === 'DRAFT';
  const audience = draft.audience;
  const applyTemplate = (versionId: string) => {
    const version = templates.flatMap((template) => template.versions).find((item) => item.id === versionId);
    if (!version) return;
    setDraft((current) => current ? { ...current, design: version.design, preheader: version.preheader, sourceTemplateVersionId: version.id, subject: version.subject } : current);
  };
  const saveNow = async () => {
    try {
      setSaveState('saving');
      const updated = await mutations.updateCampaign.mutateAsync({ id: campaign.id, ...draft });
      lastSaved.current = JSON.stringify(campaignInput(updated));
      setSaveState('saved');
      onUpdated(updated);
      return updated;
    } catch (error) {
      setSaveState('unsaved');
      void message.error(getUserErrorMessage(error, 'Draft could not be saved.'));
      return undefined;
    }
  };
  const launch = async () => {
    const saved = await saveNow();
    if (!saved) return;
    try {
      const estimate = await mutations.estimateCampaign.mutateAsync(campaign.id);
      setLaunchEstimate(estimate);
    } catch (error) {
      void message.error(getUserErrorMessage(error, 'Audience could not be estimated.'));
    }
  };
  return (
    <Drawer
      className="email-editor-drawer"
      destroyOnClose
      extra={
        <Space>
          <span className={`email-save-state is-${saveState}`}><span />{saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Draft saved' : 'Unsaved changes'}</span>
          <Button disabled={!editable} icon={<ExperimentOutlined />} onClick={() => setTestOpen(true)}>Send test</Button>
          <Button disabled={!editable} icon={<SaveOutlined />} onClick={() => void saveNow()}>Save</Button>
          <Button disabled={!editable} icon={<RocketOutlined />} onClick={() => void launch()} type="primary">{draft.scheduledAt ? 'Schedule' : 'Launch'}</Button>
        </Space>
      }
      onClose={onClose}
      open
      placement="right"
      title={<span className="email-editor-title"><MailOutlined /> {campaign.name}</span>}
      width="100vw"
    >
      {!editable ? <Alert className="email-editor-alert" message={`This campaign is ${titleCase(campaign.status)}. Its recipient and content snapshot can no longer be edited.`} type="info" /> : null}
      <div className="email-campaign-settings">
        <div className="email-settings-primary">
          <label>Internal campaign name<Input disabled={!editable} onChange={(event) => setDraft({ ...draft, name: event.target.value })} value={draft.name} /></label>
          <label>Subject line<Input disabled={!editable} maxLength={998} onChange={(event) => setDraft({ ...draft, subject: event.target.value })} value={draft.subject} /></label>
          <label>Inbox preview<Input disabled={!editable} maxLength={500} onChange={(event) => setDraft({ ...draft, preheader: event.target.value })} placeholder="A short summary visible beside the subject" value={draft.preheader ?? ''} /></label>
        </div>
        <div className="email-settings-secondary">
          <label>Start from template<Select allowClear disabled={!editable} onChange={(value) => value && applyTemplate(value)} options={templates.filter((template) => template.activeVersion).map((template) => ({ label: template.name, value: template.activeVersion!.id }))} placeholder="Choose a published template" /></label>
          <label>Delivery time<DatePicker disabled={!editable} onChange={(value) => setDraft({ ...draft, scheduledAt: value?.toISOString() ?? null })} placeholder="Send immediately" showTime style={{ width: '100%' }} value={draft.scheduledAt ? dayjs(draft.scheduledAt) : null} /></label>
          <Button disabled={!editable} icon={<CopyOutlined />} onClick={() => { setTemplateName(`${draft.name} template`); setTemplateOpen(true); }}>Save as reusable template</Button>
        </div>
      </div>
      <AudiencePanel audience={audience} disabled={!editable} onChange={(next) => setDraft({ ...draft, audience: next })} options={options} />
      <EmailBuilder disabled={!editable} document={draft.design} onChange={(design) => setDraft({ ...draft, design })} projectId={projectId} />

      <Modal onCancel={() => setTestOpen(false)} onOk={async () => {
        try {
          await mutations.testSend.mutateAsync({ design: draft.design, preheader: draft.preheader ?? null, subject: draft.subject, to: testEmail });
          setTestOpen(false);
          void message.success('Test email queued.');
        } catch (error) { void message.error(getUserErrorMessage(error, 'Test email could not be queued.')); }
      }} okButtonProps={{ disabled: !/^\S+@\S+\.\S+$/.test(testEmail), loading: mutations.testSend.isPending }} open={testOpen} title="Send a test email">
        <Typography.Paragraph type="secondary">Test sends bypass marketing consent and are clearly separated from campaign metrics.</Typography.Paragraph>
        <Input onChange={(event) => setTestEmail(event.target.value)} placeholder="you@example.com" prefix={<MailOutlined />} value={testEmail} />
      </Modal>
      <Modal onCancel={() => setTemplateOpen(false)} onOk={async () => {
        try {
          await mutations.createTemplate.mutateAsync({ design: draft.design, name: templateName, preheader: draft.preheader ?? null, subject: draft.subject });
          setTemplateOpen(false);
          void message.success('Reusable template created as a draft.');
        } catch (error) { void message.error(getUserErrorMessage(error, 'Template could not be created.')); }
      }} okButtonProps={{ disabled: !templateName.trim(), loading: mutations.createTemplate.isPending }} open={templateOpen} title="Save as template">
        <Input onChange={(event) => setTemplateName(event.target.value)} placeholder="Template name" value={templateName} />
      </Modal>
      <Modal
        className="account-confirm-modal email-launch-confirm-modal"
        closable={!mutations.launchCampaign.isPending}
        footer={null}
        keyboard={!mutations.launchCampaign.isPending}
        maskClosable={!mutations.launchCampaign.isPending}
        onCancel={() => setLaunchEstimate(undefined)}
        open={Boolean(launchEstimate)}
        title={draft.scheduledAt ? 'Schedule this email campaign?' : 'Start this email campaign?'}
        width={500}
      >
        <Typography.Paragraph type="secondary">
          {launchEstimate
            ? `${launchEstimate.eligibleRecipients} eligible contacts will receive this campaign.`
            : ''}
        </Typography.Paragraph>
        <div className="email-launch-summary">
          <div><span>Matched contacts</span><strong>{launchEstimate?.totalMatched ?? 0}</strong></div>
          <div><span>Eligible recipients</span><strong>{launchEstimate?.eligibleRecipients ?? 0}</strong></div>
          <div><span>Suppressed addresses</span><strong>{launchEstimate?.excludedSuppressed ?? 0}</strong></div>
          <div><span>Duplicate addresses</span><strong>{launchEstimate?.duplicateAddresses ?? 0}</strong></div>
        </div>
        <div className="modal-form-actions">
          <Button disabled={mutations.launchCampaign.isPending} onClick={() => setLaunchEstimate(undefined)}>Cancel</Button>
          <Button
            loading={mutations.launchCampaign.isPending}
            onClick={async () => {
              try {
                const launched = await mutations.launchCampaign.mutateAsync(campaign.id);
                setLaunchEstimate(undefined);
                onUpdated(launched);
                void message.success(draft.scheduledAt ? 'Campaign scheduled.' : 'Campaign started.');
              } catch (error) {
                void message.error(getUserErrorMessage(error, 'Campaign could not be started.'));
              }
            }}
            type="primary"
          >
            {draft.scheduledAt ? 'Schedule campaign' : 'Start campaign'}
          </Button>
        </div>
      </Modal>
    </Drawer>
  );
}

function AudiencePanel({ audience, disabled, onChange, options }: { audience: EmailAudience; disabled: boolean; onChange: (audience: EmailAudience) => void; options?: ReturnType<typeof useEmailAudienceOptions>['data'] }) {
  return (
    <Card className="email-audience-card" title={<span><SafetyCertificateOutlined /> Audience & delivery rules</span>}>
      <div className="email-audience-grid">
        <label>Recipients<Select disabled={disabled} onChange={(mode) => onChange({ ...audience, mode })} options={[{ label: 'All active contacts with email', value: 'ALL_ACTIVE' }, { label: 'Saved segment', value: 'SEGMENT' }, { label: 'Selected contacts', value: 'CONTACTS' }]} value={audience.mode} /></label>
        {audience.mode === 'SEGMENT' ? <label>Segment<Select<string> disabled={disabled} onChange={(segmentId) => onChange({ ...audience, segmentId })} options={(options?.segments ?? []).map((item) => ({ label: item.name, value: item.id }))} value={audience.segmentId ?? null} /></label> : null}
        {audience.mode === 'CONTACTS' ? <label>Contacts<Select<string[]> disabled={disabled} mode="multiple" onChange={(contactIds) => onChange({ ...audience, contactIds })} optionFilterProp="label" options={(options?.contacts ?? []).map((item) => ({ disabled: !item.eligible, label: `${item.displayName} · ${item.email}`, value: item.id }))} value={audience.contactIds ?? []} /></label> : null}
        <label>Must have tags<Select<string[]> allowClear disabled={disabled} mode="multiple" onChange={(includeTagIds) => onChange({ ...audience, includeTagIds, excludeTagIds: (audience.excludeTagIds ?? []).filter((tagId) => !includeTagIds.includes(tagId)) })} options={(options?.tags ?? []).map((item) => ({ disabled: Boolean(audience.excludeTagIds?.includes(item.id)), label: item.name, value: item.id }))} value={audience.includeTagIds ?? []} /></label>
        <label>Exclude tags<Select<string[]> allowClear disabled={disabled} mode="multiple" onChange={(excludeTagIds) => onChange({ ...audience, excludeTagIds, includeTagIds: (audience.includeTagIds ?? []).filter((tagId) => !excludeTagIds.includes(tagId)) })} options={(options?.tags ?? []).map((item) => ({ disabled: Boolean(audience.includeTagIds?.includes(item.id)), label: item.name, value: item.id }))} value={audience.excludeTagIds ?? []} /></label>
      </div>
      <Typography.Text type="secondary">Active contacts with a valid email are included. Unsubscribed, bounced, complained and manually suppressed addresses are removed again immediately before delivery.</Typography.Text>
    </Card>
  );
}

function TemplateLibrary({ loading, onCreateCampaign, onEdit, templates }: { loading: boolean; onCreateCampaign: (version: EmailTemplateVersion) => void; onEdit: (template: EmailTemplate) => void; templates: EmailTemplate[] }) {
  const { projectId } = useParams();
  const mutations = useEmailMutations(projectId);
  const [archiveTarget, setArchiveTarget] = useState<EmailTemplate>();
  if (loading) return <Spin />;
  if (!templates.length) return <Empty description="Build a reusable design for campaigns and automations" />;
  return (
    <>
      <div className="email-template-grid">{templates.map((template) => {
        const version = template.draftVersion ?? template.activeVersion;
        return <Card actions={[
          <Button icon={<EditOutlined />} key="edit" onClick={() => onEdit(template)} type="text">Edit</Button>,
          <Button disabled={!template.activeVersion} icon={<ArrowRightOutlined />} key="use" onClick={() => template.activeVersion && onCreateCampaign(template.activeVersion)} type="text">Use</Button>,
          <Button icon={<CopyOutlined />} key="copy" loading={mutations.duplicateTemplate.isPending} onClick={() => void mutations.duplicateTemplate.mutateAsync(template.id)} type="text">Duplicate</Button>,
          <Button danger icon={<DeleteOutlined />} key="archive" onClick={() => setArchiveTarget(template)} type="text">Delete</Button>,
        ]} className="email-template-card" key={template.id}>
          <div className="email-template-card-top"><span className="email-template-icon"><MailOutlined /></span><Tag color={template.activeVersion ? 'success' : 'default'}>{template.activeVersion ? `Published v${template.activeVersion.version}` : 'Draft'}</Tag></div>
          <Typography.Title ellipsis level={4}>{template.name}</Typography.Title>
          <Typography.Paragraph ellipsis={{ rows: 2 }} type="secondary">{template.description || version?.subject || 'Reusable email template'}</Typography.Paragraph>
          <Typography.Text className="email-template-meta" type="secondary"><ClockCircleOutlined /> Updated {dayjs(template.updatedAt).format('MMM D, YYYY')}</Typography.Text>
        </Card>;
      })}</div>
      <ActionConfirmModal
        confirmLabel="Archive template"
        description={archiveTarget ? `"${archiveTarget.name}" will be removed from the active template library. Existing campaign history will remain available.` : ''}
        loading={mutations.archiveTemplate.isPending}
        onCancel={() => setArchiveTarget(undefined)}
        onConfirm={async () => {
          if (!archiveTarget) return;
          try {
            await mutations.archiveTemplate.mutateAsync(archiveTarget.id);
            setArchiveTarget(undefined);
            void message.success('Template archived.');
          } catch (error) {
            void message.error(getUserErrorMessage(error, 'Template could not be archived.'));
          }
        }}
        open={Boolean(archiveTarget)}
        title="Archive this email template?"
      />
    </>
  );
}

function TemplateEditor({ onClose, onUpdated, projectId, template }: { onClose: () => void; onUpdated: (template: EmailTemplate) => void; projectId?: string | undefined; template?: EmailTemplate | undefined }) {
  const mutations = useEmailMutations(projectId);
  const version = template?.draftVersion ?? template?.activeVersion;
  const [subject, setSubject] = useState('');
  const [preheader, setPreheader] = useState('');
  const [design, setDesign] = useState<EmailDocument>();
  useEffect(() => {
    if (!version) return;
    setSubject(version.subject);
    setPreheader(version.preheader ?? '');
    setDesign(version.design);
  }, [template?.id, version?.id]);
  if (!template || !version || !design) return null;
  const save = async () => {
    try {
      const updated = await mutations.updateTemplateDraft.mutateAsync({ design, id: template.id, preheader, subject });
      onUpdated(updated);
      void message.success('Template draft saved.');
      return updated;
    } catch (error) { void message.error(getUserErrorMessage(error, 'Template could not be saved.')); return undefined; }
  };
  return <Drawer className="email-editor-drawer" destroyOnClose extra={<Space><Button icon={<SaveOutlined />} onClick={() => void save()}>Save template</Button><Button icon={<RocketOutlined />} onClick={async () => { const saved = await save(); if (!saved) return; try { const published = await mutations.publishTemplate.mutateAsync(template.id); onUpdated(published); void message.success('Template published and pinned for automations.'); } catch (error) { void message.error(getUserErrorMessage(error, 'Template could not be published.')); } }} type="primary">Publish version</Button></Space>} onClose={onClose} open placement="right" title={`Template · ${template.name}`} width="calc(100vw - 42px)">
    <div className="email-template-settings"><label>Subject line<Input onChange={(event) => setSubject(event.target.value)} value={subject} /></label><label>Inbox preview<Input onChange={(event) => setPreheader(event.target.value)} value={preheader} /></label></div>
    <EmailBuilder document={design} onChange={setDesign} projectId={projectId} />
  </Drawer>;
}

function SuppressionList({ items, loading, projectId }: { items: Array<{ createdAt: string; id: string; normalizedEmail: string; note: string | null; reason: string; source: string }>; loading: boolean; projectId?: string | undefined }) {
  const mutations = useEmailMutations(projectId);
  const [open, setOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<(typeof items)[number]>();
  const [form] = Form.useForm();
  return <><div className="email-section-intro"><div><Typography.Title level={4}>Do-not-send addresses</Typography.Title><Typography.Text type="secondary">Permanent protection for unsubscribes, complaints, hard bounces and manual exclusions.</Typography.Text></div><Button icon={<PlusOutlined />} onClick={() => setOpen(true)}>Add address</Button></div><Table columns={[{ dataIndex: 'normalizedEmail', title: 'Email' }, { dataIndex: 'reason', render: (value) => <Tag>{titleCase(value)}</Tag>, title: 'Reason' }, { dataIndex: 'source', title: 'Source' }, { dataIndex: 'createdAt', render: (value) => dayjs(value).format('MMM D, YYYY HH:mm'), title: 'Added' }, { render: (_, record) => <Button danger icon={<DeleteOutlined />} onClick={() => setRemoveTarget(record)} size="small">Remove</Button>, title: '' }]} dataSource={items} loading={loading} rowKey="id" /><Modal onCancel={() => setOpen(false)} onOk={() => form.validateFields().then(async (values) => { try { await mutations.addSuppression.mutateAsync(values); form.resetFields(); setOpen(false); void message.success('Address added to the suppression list.'); } catch (error) { void message.error(getUserErrorMessage(error, 'Address could not be suppressed.')); } })} open={open} title="Add a do-not-send address"><Form form={form} layout="vertical"><Form.Item label="Email" name="email" rules={[{ required: true, type: 'email' }]}><Input /></Form.Item><Form.Item initialValue="MANUAL" label="Reason" name="reason"><Select options={[{ label: 'Manual exclusion', value: 'MANUAL' }, { label: 'Unsubscribed', value: 'UNSUBSCRIBED' }]} /></Form.Item><Form.Item label="Internal note" name="note"><Input.TextArea rows={3} /></Form.Item></Form></Modal><ActionConfirmModal confirmLabel="Allow sending" description={removeTarget ? `${removeTarget.normalizedEmail} will be removed from the do-not-send list and can receive future campaigns again.` : ''} loading={mutations.removeSuppression.isPending} onCancel={() => setRemoveTarget(undefined)} onConfirm={async () => { if (!removeTarget) return; try { await mutations.removeSuppression.mutateAsync(removeTarget.id); setRemoveTarget(undefined); void message.success('Address removed from the do-not-send list.'); } catch (error) { void message.error(getUserErrorMessage(error, 'Address could not be removed.')); } }} open={Boolean(removeTarget)} title="Allow sending to this address again?" /></>;
}

function SmsUnderConstruction() {
  return (
    <div className="sms-construction">
      <div className="sms-orbit">
        <span />
        <span />
        <span />
        <SendOutlined className="sms-orbit-icon" />
      </div>
      <Typography.Text className="email-hero-kicker">COMING NEXT</Typography.Text>
      <Typography.Title level={2}>SMS campaigns are under construction</Typography.Title>
      <Typography.Paragraph>
        Sender verification, providers, quiet hours and consent rules will be connected here without compromising the email and messenger delivery paths.
      </Typography.Paragraph>
      <div className="sms-roadmap">
        <span><CheckCircleOutlined className="sms-roadmap-icon" /> Product surface reserved</span>
        <span><ClockCircleOutlined className="sms-roadmap-icon" /> Provider selection pending</span>
        <span><SafetyCertificateOutlined className="sms-roadmap-icon" /> Consent-first architecture</span>
      </div>
    </div>
  );
}

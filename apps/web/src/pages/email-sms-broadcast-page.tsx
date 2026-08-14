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
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
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
  type EmailCampaign,
  type EmailCampaignInput,
  type EmailCampaignStatus,
  type EmailTemplate,
  type EmailTemplateVersion,
  useEmailAudienceOptions,
  useEmailCampaignDeliveries,
  useEmailCampaigns,
  useEmailMutations,
  useEmailSuppressions,
  useEmailTemplates,
} from '../email-api';
import '../email-broadcast.css';

type ChannelView = 'email' | 'sms';
type EmailTab = 'campaigns' | 'templates' | 'suppressions';

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
            Design personal campaigns, protect consent and follow delivery from inbox to CRM.
          </Typography.Paragraph>
        </div>
        <Segmented
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
            {tab === 'campaigns' ? (
              <CampaignTable
                campaigns={campaigns.data ?? []}
                loading={campaigns.isLoading}
                onEdit={setEditingCampaign}
                onResults={setResultsCampaign}
              />
            ) : null}
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
  const run = async (operation: () => Promise<unknown>, success: string) => {
    try {
      await operation();
      void message.success(success);
    } catch (error) {
      void message.error(getUserErrorMessage(error, 'Campaign action failed.'));
    }
  };
  return (
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
              {record.status === 'RUNNING' ? <Button icon={<PauseOutlined />} onClick={() => void run(() => mutations.pauseCampaign.mutateAsync(record.id), 'Campaign paused.')} size="small" /> : null}
              {record.status === 'PAUSED' ? <Button icon={<PlayCircleOutlined />} onClick={() => void run(() => mutations.resumeCampaign.mutateAsync(record.id), 'Campaign resumed.')} size="small" /> : null}
              {record.status === 'FAILED' || (record.status === 'COMPLETED' && Boolean(record.errorCode)) ? <Button icon={<ReloadOutlined />} onClick={() => void run(() => mutations.retryCampaign.mutateAsync(record.id), 'Failed deliveries queued again.')} size="small" /> : null}
              {['SCHEDULED', 'PREPARING', 'RUNNING', 'PAUSED'].includes(record.status) ? <Popconfirm onConfirm={() => void run(() => mutations.cancelCampaign.mutateAsync(record.id), 'Campaign cancelled.')} title="Cancel this campaign?"><Button danger icon={<StopOutlined />} size="small" /></Popconfirm> : null}
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
      Modal.confirm({
        content: (
          <Descriptions column={1} size="small">
            <Descriptions.Item label="Matched">{estimate.totalMatched}</Descriptions.Item>
            <Descriptions.Item label="Eligible">{estimate.eligibleRecipients}</Descriptions.Item>
            <Descriptions.Item label="No consent">{estimate.excludedNoConsent}</Descriptions.Item>
            <Descriptions.Item label="Suppressed">{estimate.excludedSuppressed}</Descriptions.Item>
            <Descriptions.Item label="Duplicate addresses">{estimate.duplicateAddresses}</Descriptions.Item>
          </Descriptions>
        ),
        okText: saved.scheduledAt ? 'Schedule campaign' : 'Start campaign',
        onOk: async () => {
          const launched = await mutations.launchCampaign.mutateAsync(campaign.id);
          onUpdated(launched);
          void message.success(saved.scheduledAt ? 'Campaign scheduled.' : 'Campaign started.');
        },
        title: `Send to ${estimate.eligibleRecipients} eligible contacts?`,
      });
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
    </Drawer>
  );
}

function AudiencePanel({ audience, disabled, onChange, options }: { audience: EmailAudience; disabled: boolean; onChange: (audience: EmailAudience) => void; options?: ReturnType<typeof useEmailAudienceOptions>['data'] }) {
  return (
    <Card className="email-audience-card" title={<span><SafetyCertificateOutlined /> Audience & consent</span>}>
      <div className="email-audience-grid">
        <label>Recipients<Select disabled={disabled} onChange={(mode) => onChange({ ...audience, mode })} options={[{ label: 'All active contacts with consent', value: 'ALL_ACTIVE' }, { label: 'Saved segment', value: 'SEGMENT' }, { label: 'Selected contacts', value: 'CONTACTS' }]} value={audience.mode} /></label>
        {audience.mode === 'SEGMENT' ? <label>Segment<Select<string> disabled={disabled} onChange={(segmentId) => onChange({ ...audience, segmentId })} options={(options?.segments ?? []).map((item) => ({ label: item.name, value: item.id }))} value={audience.segmentId ?? null} /></label> : null}
        {audience.mode === 'CONTACTS' ? <label>Contacts<Select<string[]> disabled={disabled} mode="multiple" onChange={(contactIds) => onChange({ ...audience, contactIds })} optionFilterProp="label" options={(options?.contacts ?? []).map((item) => ({ disabled: item.emailConsentStatus !== 'GRANTED', label: `${item.displayName} · ${item.email}`, value: item.id }))} value={audience.contactIds ?? []} /></label> : null}
        <label>Must have tags<Select<string[]> allowClear disabled={disabled} mode="multiple" onChange={(includeTagIds) => onChange({ ...audience, includeTagIds })} options={(options?.tags ?? []).map((item) => ({ label: item.name, value: item.id }))} value={audience.includeTagIds ?? []} /></label>
        <label>Exclude tags<Select<string[]> allowClear disabled={disabled} mode="multiple" onChange={(excludeTagIds) => onChange({ ...audience, excludeTagIds })} options={(options?.tags ?? []).map((item) => ({ label: item.name, value: item.id }))} value={audience.excludeTagIds ?? []} /></label>
      </div>
      <Typography.Text type="secondary">Only active contacts with explicit email consent are included. Unsubscribed, bounced and complained addresses are removed again immediately before delivery.</Typography.Text>
    </Card>
  );
}

function TemplateLibrary({ loading, onCreateCampaign, onEdit, templates }: { loading: boolean; onCreateCampaign: (version: EmailTemplateVersion) => void; onEdit: (template: EmailTemplate) => void; templates: EmailTemplate[] }) {
  const { projectId } = useParams();
  const mutations = useEmailMutations(projectId);
  if (loading) return <Spin />;
  if (!templates.length) return <Empty description="Build a reusable design for campaigns and automations" />;
  return <div className="email-template-grid">{templates.map((template) => {
    const version = template.draftVersion ?? template.activeVersion;
    return <Card actions={[
      <Button icon={<EditOutlined />} key="edit" onClick={() => onEdit(template)} type="text">Edit</Button>,
      <Button disabled={!template.activeVersion} icon={<ArrowRightOutlined />} key="use" onClick={() => template.activeVersion && onCreateCampaign(template.activeVersion)} type="text">Use</Button>,
      <Button icon={<CopyOutlined />} key="copy" loading={mutations.duplicateTemplate.isPending} onClick={() => void mutations.duplicateTemplate.mutateAsync(template.id)} type="text">Duplicate</Button>,
      <Popconfirm key="archive" onConfirm={() => void mutations.archiveTemplate.mutateAsync(template.id)} title="Archive this template?"><Button danger icon={<DeleteOutlined />} type="text" /></Popconfirm>,
    ]} className="email-template-card" key={template.id}>
      <div className="email-template-card-top"><span className="email-template-icon"><MailOutlined /></span><Tag color={template.activeVersion ? 'success' : 'default'}>{template.activeVersion ? `Published v${template.activeVersion.version}` : 'Draft'}</Tag></div>
      <Typography.Title ellipsis level={4}>{template.name}</Typography.Title>
      <Typography.Paragraph ellipsis={{ rows: 2 }} type="secondary">{template.description || version?.subject || 'Reusable email template'}</Typography.Paragraph>
      <Typography.Text className="email-template-meta" type="secondary"><ClockCircleOutlined /> Updated {dayjs(template.updatedAt).format('MMM D, YYYY')}</Typography.Text>
    </Card>;
  })}</div>;
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
  return <Drawer className="email-editor-drawer" destroyOnClose extra={<Space><Button icon={<SaveOutlined />} onClick={() => void save()}>Save draft</Button><Button icon={<RocketOutlined />} onClick={async () => { const saved = await save(); if (!saved) return; try { const published = await mutations.publishTemplate.mutateAsync(template.id); onUpdated(published); void message.success('Template published and pinned for automations.'); } catch (error) { void message.error(getUserErrorMessage(error, 'Template could not be published.')); } }} type="primary">Publish version</Button></Space>} onClose={onClose} open placement="right" title={`Template · ${template.name}`} width="calc(100vw - 42px)">
    <div className="email-template-settings"><label>Subject line<Input onChange={(event) => setSubject(event.target.value)} value={subject} /></label><label>Inbox preview<Input onChange={(event) => setPreheader(event.target.value)} value={preheader} /></label></div>
    <EmailBuilder document={design} onChange={setDesign} projectId={projectId} />
  </Drawer>;
}

function SuppressionList({ items, loading, projectId }: { items: Array<{ createdAt: string; id: string; normalizedEmail: string; note: string | null; reason: string; source: string }>; loading: boolean; projectId?: string | undefined }) {
  const mutations = useEmailMutations(projectId);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  return <><div className="email-section-intro"><div><Typography.Title level={4}>Do-not-send addresses</Typography.Title><Typography.Text type="secondary">Permanent protection for unsubscribes, complaints, hard bounces and manual exclusions.</Typography.Text></div><Button icon={<PlusOutlined />} onClick={() => setOpen(true)}>Add address</Button></div><Table columns={[{ dataIndex: 'normalizedEmail', title: 'Email' }, { dataIndex: 'reason', render: (value) => <Tag>{titleCase(value)}</Tag>, title: 'Reason' }, { dataIndex: 'source', title: 'Source' }, { dataIndex: 'createdAt', render: (value) => dayjs(value).format('MMM D, YYYY HH:mm'), title: 'Added' }, { render: (_, record) => <Popconfirm onConfirm={() => void mutations.removeSuppression.mutateAsync(record.id)} title="Allow campaigns to send to this address again?"><Button danger icon={<DeleteOutlined />} size="small">Remove</Button></Popconfirm>, title: '' }]} dataSource={items} loading={loading} rowKey="id" /><Modal onCancel={() => setOpen(false)} onOk={() => form.validateFields().then(async (values) => { try { await mutations.addSuppression.mutateAsync(values); form.resetFields(); setOpen(false); void message.success('Address added to the suppression list.'); } catch (error) { void message.error(getUserErrorMessage(error, 'Address could not be suppressed.')); } })} open={open} title="Add a do-not-send address"><Form form={form} layout="vertical"><Form.Item label="Email" name="email" rules={[{ required: true, type: 'email' }]}><Input /></Form.Item><Form.Item initialValue="MANUAL" label="Reason" name="reason"><Select options={[{ label: 'Manual exclusion', value: 'MANUAL' }, { label: 'Unsubscribed', value: 'UNSUBSCRIBED' }]} /></Form.Item><Form.Item label="Internal note" name="note"><Input.TextArea rows={3} /></Form.Item></Form></Modal></>;
}

function SmsUnderConstruction() {
  return <div className="sms-construction"><div className="sms-orbit"><span /><span /><span /><SendOutlined /></div><Typography.Text className="email-hero-kicker">COMING NEXT</Typography.Text><Typography.Title level={2}>SMS campaigns are under construction</Typography.Title><Typography.Paragraph>Sender verification, providers, quiet hours and consent rules will be connected here without compromising the email and messenger delivery paths.</Typography.Paragraph><div className="sms-roadmap"><span><CheckCircleOutlined /> Product surface reserved</span><span><ClockCircleOutlined /> Provider selection pending</span><span><SafetyCertificateOutlined /> Consent-first architecture</span></div></div>;
}

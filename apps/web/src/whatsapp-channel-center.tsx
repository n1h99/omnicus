import {
  ExportOutlined,
  ReloadOutlined,
  WarningOutlined,
  WhatsAppOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';
import { Link } from 'react-router';
import { getUserErrorMessage } from './api';
import { humanizeStatus } from './humanize';
import { type WhatsAppChannel } from './channels-api';
import { WhatsAppHealthNotices } from './whatsapp-health-notices';
import {
  formatWhatsAppMoney,
  useWhatsAppBilling,
  useWhatsAppHealth,
} from './whatsapp-management-api';
import './whatsapp-management.css';

const date = (value: string | null) => (value ? new Date(value).toLocaleString() : 'Not recorded');
const statusTag = (status: string) => (
  <Tag
    color={
      status === 'AVAILABLE'
        ? 'green'
        : status === 'BLOCKED'
          ? 'red'
          : status === 'LIMITED'
            ? 'orange'
            : 'default'
    }
  >
    {humanizeStatus(status)}
  </Tag>
);

function ChannelStatusState({
  title,
  description,
  warning = false,
  action,
  actionLabel,
  loading = false,
  details,
}: {
  title: string;
  description: string;
  warning?: boolean;
  action?: (() => void) | undefined;
  actionLabel?: string;
  loading?: boolean;
  details?: string;
}) {
  return (
    <div className={`wa-center-state${warning ? ' wa-center-state--warning' : ''}`}>
      <div className="wa-center-state-icon" aria-hidden="true">
        {warning ? <WarningOutlined /> : <WhatsAppOutlined />}
      </div>
      <div className="wa-center-state-content">
        <span className="wa-center-state-eyebrow">
          {warning ? 'Connection needs attention' : 'Your WhatsApp channel'}
        </span>
        <h3>{title}</h3>
        <p>{description}</p>
        {!warning ? (
          <div className="wa-center-state-features">
            <span>Connection health</span>
            <span>Number quality</span>
            <span>Messaging limits</span>
          </div>
        ) : null}
        {action && actionLabel ? (
          <Button type="primary" loading={loading} onClick={action}>
            {actionLabel}
          </Button>
        ) : null}
        {details ? (
          <details className="wa-center-state-details">
            <summary>Technical details</summary>
            <p>{details}</p>
          </details>
        ) : null}
      </div>
    </div>
  );
}

export function WhatsAppChannelCenter({
  projectId,
  channel,
  canManage,
  onSetup,
  onOpenSettings,
}: {
  projectId: string | undefined;
  channel: WhatsAppChannel;
  canManage: boolean;
  onSetup: () => void;
  onOpenSettings: () => void;
}) {
  const [tab, setTab] = useState('health');
  const [days, setDays] = useState(30);
  const health = useWhatsAppHealth(projectId, channel.id, channel.configured);
  const billing = useWhatsAppBilling(
    projectId,
    channel.id,
    canManage && tab === 'billing' && channel.configured,
    days,
  );
  const h = health.data,
    b = billing.data;
  const managerUrl =
    h?.managerUrl ??
    `https://business.facebook.com/wa/manage/home/?waba_id=${encodeURIComponent(channel.businessAccountId ?? '')}`;
  const accessInvalid =
    h?.token.valid === false ||
    Object.values(h?.unavailable ?? {}).some((issue) => issue.code === 190);
  const numberUnavailable = Boolean(h?.unavailable.phone) && !h?.phone.number;
  const connectionAttention = accessInvalid || numberUnavailable;
  return (
    <Card className="wa-channel-center" title="WhatsApp channel center">
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'health',
            label: 'Status & quality',
            children: (
              <>
                <div className="wa-center-actions">
                  <Typography.Text type="secondary">
                    {h
                      ? `${health.isError ? 'Last successful check' : 'Checked'} ${date(h.checkedAt)}`
                      : 'Live connection and account checks'}
                  </Typography.Text>
                  <Button
                    icon={<ReloadOutlined />}
                    loading={health.isFetching}
                    disabled={!channel.configured}
                    onClick={() => void health.refetch()}
                  >
                    Refresh status
                  </Button>
                </div>
                {!channel.configured ? (
                  <ChannelStatusState
                    title="Connect your business number"
                    description={
                      canManage
                        ? 'Finish WhatsApp setup to see connection health, number quality and messaging limits in one place.'
                        : 'Ask a project administrator to finish WhatsApp setup. Your channel status and number details will appear here once connected.'
                    }
                    action={canManage ? onSetup : undefined}
                    actionLabel="Continue setup"
                  />
                ) : health.isLoading ? (
                  <div className="wa-center-loading" role="status">
                    <Spin />
                    <span>Checking your WhatsApp connection…</span>
                  </div>
                ) : health.isError && !h ? (
                  <ChannelStatusState
                    warning
                    title="We couldn’t check your channel"
                    description="Channel status is temporarily unavailable. Try refreshing in a moment; your connection settings have not been changed."
                    action={() => void health.refetch()}
                    actionLabel="Try again"
                    loading={health.isFetching}
                    details={getUserErrorMessage(health.error)}
                  />
                ) : connectionAttention ? (
                  <ChannelStatusState
                    warning
                    title={
                      accessInvalid
                        ? 'Restore your Meta connection'
                        : 'We couldn’t verify this number'
                    }
                    description={
                      accessInvalid
                        ? canManage
                          ? 'Meta access has expired or is no longer valid. Review the connection settings and update access to see live channel details again.'
                          : 'Meta access has expired or is no longer valid. Ask a project administrator to restore the connection.'
                        : canManage
                          ? 'Meta did not return details for this business number. Check the number and account settings, or refresh the status to try again.'
                          : 'Meta did not return details for this business number. Try refreshing, or ask a project administrator to check the connection.'
                    }
                    action={canManage ? onOpenSettings : undefined}
                    actionLabel="Review connection settings"
                  />
                ) : null}
                {channel.configured && health.isError && h ? (
                  <Alert
                    className="wa-center-refresh-error"
                    title="Could not refresh Meta status. Showing the last successful check."
                    description={getUserErrorMessage(health.error)}
                    showIcon
                    type="warning"
                  />
                ) : null}
                {channel.configured && h && !connectionAttention ? (
                  <>
                    <div className="wa-health-grid">
                      <div className="wa-health-tile">
                        <span>Meta sending status</span>
                        <strong>{statusTag(h.providerStatus)}</strong>
                        <small>Omnicus channel: {humanizeStatus(h.localStatus)}</small>
                      </div>
                      <div className="wa-health-tile">
                        <span>Number quality</span>
                        <strong>
                          {h.phone.quality ? humanizeStatus(h.phone.quality) : 'Unavailable'}
                        </strong>
                        <small>{h.phone.number ?? channel.displayPhoneNumber}</small>
                      </div>
                      <div className="wa-health-tile">
                        <span>Messaging limit</span>
                        <strong>{h.messagingLimit ?? 'Unavailable'}</strong>
                        <small>Shared by the business portfolio over a rolling 24 hours</small>
                      </div>
                    </div>
                    <Descriptions
                      column={{ xs: 1, md: 2 }}
                      items={[
                        {
                          key: 'token',
                          label: 'Meta access',
                          children:
                            h.token.valid === null
                              ? 'Unable to verify'
                              : h.token.valid
                                ? 'Token is valid'
                                : 'Reconnect required',
                        },
                        {
                          key: 'permissions',
                          label: 'WhatsApp permissions',
                          children:
                            h.token.missingPermissions === null
                              ? 'Unable to verify'
                              : h.token.missingPermissions.length
                                ? `Missing: ${h.token.missingPermissions.map((p) => (p === 'whatsapp_business_messaging' ? 'Sending messages' : 'Managing account')).join(', ')}`
                                : 'Granted',
                        },
                        {
                          key: 'expiry',
                          label: 'Token expiration',
                          children: h.token.expiresAt
                            ? date(h.token.expiresAt)
                            : h.token.valid === true
                              ? 'No expiry reported by Meta'
                              : 'Unavailable',
                        },
                        {
                          key: 'subscription',
                          label: 'Webhook subscription',
                          children:
                            h.webhook.subscribed === null
                              ? 'Unable to verify'
                              : h.webhook.subscribed
                                ? 'App subscribed'
                                : 'App not subscribed',
                        },
                        {
                          key: 'webhook',
                          label: 'Last webhook received',
                          children: date(h.webhook.lastReceivedAt),
                        },
                        {
                          key: 'inbound',
                          label: 'Last incoming message',
                          children: date(h.lastInboundAt),
                        },
                        {
                          key: 'outbound',
                          label: 'Last successful outgoing message',
                          children: date(h.lastSuccessfulOutboundAt),
                        },
                        {
                          key: 'verification',
                          label: 'Business verification',
                          children: h.businessVerification
                            ? humanizeStatus(h.businessVerification)
                            : 'Unavailable',
                        },
                        {
                          key: 'review',
                          label: 'Account review',
                          children: h.accountReview
                            ? humanizeStatus(h.accountReview)
                            : 'Unavailable',
                        },
                        {
                          key: 'templates',
                          label: 'Templates',
                          children: (
                            <Space wrap>
                              {Object.entries(h.templates).map(([status, count]) => (
                                <Tag key={status}>
                                  {humanizeStatus(status)}: {count}
                                </Tag>
                              ))}
                              <Link to={`/projects/${projectId}/templates?provider=WHATSAPP`}>
                                Manage templates
                              </Link>
                            </Space>
                          ),
                        },
                      ]}
                    />
                  </>
                ) : null}
                {channel.configured && h ? (
                  <WhatsAppHealthNotices health={h} connectionAttention={connectionAttention} />
                ) : null}
              </>
            ),
          },
          ...(canManage
            ? [
                {
                  key: 'billing',
                  label: 'Meta payments & costs',
                  children: (
                    <>
                      <Typography.Paragraph>
                        Message charges are paid directly to Meta using the payment method on your
                        WhatsApp Business Account.
                      </Typography.Paragraph>
                      <div className="wa-center-actions">
                        <Space wrap>
                          <Button
                            type="primary"
                            icon={<ExportOutlined />}
                            href={managerUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Set up payments in Meta
                          </Button>
                          <Button
                            href="https://www.facebook.com/business/help/488291839463771"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Payment help
                          </Button>
                        </Space>
                        <Tag>Payment method: check in Meta</Tag>
                      </div>
                      <ol className="wa-billing-instructions">
                        <li>
                          Open Meta and select this account:{' '}
                          <strong>{channel.businessAccountId}</strong>.
                        </li>
                        <li>
                          In Overview, choose <strong>Add payment method</strong>. Manage an
                          existing card and invoices in Meta billing settings.
                        </li>
                        <li>
                          Complete the steps in Meta, return here and refresh the cost report.
                        </li>
                      </ol>
                      <Typography.Paragraph type="secondary">
                        A successful connection check or a zero cost report does not confirm that a
                        card is attached. Card details and payment confirmation remain in Meta.
                      </Typography.Paragraph>
                      <div className="wa-center-actions">
                        <Select
                          aria-label="Cost report period"
                          value={days}
                          onChange={setDays}
                          options={[7, 30, 90].map((value) => ({
                            value,
                            label: `Last ${value} days`,
                          }))}
                        />
                        <Button
                          icon={<ReloadOutlined />}
                          loading={billing.isFetching}
                          disabled={!channel.configured}
                          onClick={() => void billing.refetch()}
                        >
                          Refresh cost report
                        </Button>
                      </div>
                      {billing.isLoading ? <Spin /> : null}
                      {billing.isError ? (
                        <Alert
                          className="form-alert"
                          showIcon
                          type="warning"
                          title="Meta cost report unavailable"
                          description={getUserErrorMessage(billing.error)}
                        />
                      ) : null}
                      {b ? (
                        <>
                          <div className="wa-health-grid">
                            <div className="wa-health-tile">
                              <span>Meta-reported message cost</span>
                              <strong>{formatWhatsAppMoney(b.reportedCost, b.currency)}</strong>
                              <small>For this number, in the account billing currency</small>
                            </div>
                            <div className="wa-health-tile">
                              <span>Delivered messages in report</span>
                              <strong>{b.volume ?? 'Unavailable'}</strong>
                              <small>Includes paid and free messages</small>
                            </div>
                            <div className="wa-health-tile">
                              <span>Last refreshed</span>
                              <strong style={{ fontSize: 14 }}>{date(b.checkedAt)}</strong>
                              <small>Meta data may arrive with a delay</small>
                            </div>
                          </div>
                          {Object.entries(b.unavailable).map(([key, issue]) => (
                            <Alert
                              className="form-alert"
                              key={key}
                              title={`${humanizeStatus(key)} unavailable`}
                              description={issue.reason}
                              showIcon
                              type="warning"
                            />
                          ))}
                          <Table
                            size="small"
                            rowKey={(_, index) => String(index)}
                            dataSource={b.breakdown}
                            pagination={{ pageSize: 10, hideOnSinglePage: true }}
                            scroll={{ x: 640 }}
                            columns={[
                              {
                                title: 'Date',
                                dataIndex: 'start',
                                render: (value: number | null) =>
                                  value ? new Date(value * 1000).toLocaleDateString() : '—',
                              },
                              { title: 'Country', dataIndex: 'country' },
                              {
                                title: 'Category',
                                dataIndex: 'category',
                                render: (value: string | null) =>
                                  humanizeStatus(value ?? 'UNKNOWN'),
                              },
                              {
                                title: 'Pricing',
                                dataIndex: 'pricingType',
                                render: (value: string | null) =>
                                  humanizeStatus(value ?? 'UNKNOWN'),
                              },
                              { title: 'Delivered', dataIndex: 'volume' },
                              {
                                title: 'Cost',
                                dataIndex: 'cost',
                                render: (value: number | null) =>
                                  formatWhatsAppMoney(value, b.currency),
                              },
                            ]}
                          />
                        </>
                      ) : null}
                      <Typography.Paragraph type="secondary" style={{ marginTop: 16 }}>
                        Meta analytics are approximate and can differ from the final invoice.
                        Discounts and free entry points may apply.{' '}
                        <a
                          href="https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Official Meta pricing
                        </a>
                      </Typography.Paragraph>
                    </>
                  ),
                },
              ]
            : []),
        ]}
      />
    </Card>
  );
}

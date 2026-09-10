import { ExportOutlined, ReloadOutlined } from '@ant-design/icons';
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

export function WhatsAppChannelCenter({
  projectId,
  channel,
  canManage,
}: {
  projectId: string | undefined;
  channel: WhatsAppChannel;
  canManage: boolean;
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
                    {h ? `Checked ${date(h.checkedAt)}` : 'Live connection and account checks'}
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
                  <Alert title="Finish channel setup to check Meta status." type="info" showIcon />
                ) : health.isLoading ? (
                  <Spin />
                ) : null}
                {health.isError ? (
                  <Alert
                    title="Could not check Meta"
                    description={getUserErrorMessage(health.error)}
                    showIcon
                    type="warning"
                  />
                ) : null}
                {h ? (
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
                    <div className="wa-center-details">
                      {h.entities
                        .filter((e) => e.status !== 'AVAILABLE')
                        .map((entity, index) => (
                          <Alert
                            key={index}
                            showIcon
                            type={entity.status === 'BLOCKED' ? 'error' : 'warning'}
                            title={`${humanizeStatus(entity.type ?? 'Account')}: ${humanizeStatus(entity.status)}`}
                            description={
                              <>
                                {entity.info.map((info, i) => (
                                  <p key={i}>{info}</p>
                                ))}
                                {entity.errors.map((error, i) => (
                                  <p key={i}>
                                    {error.description} {error.solution}{' '}
                                    {error.code ? `(Meta ${error.code})` : ''}
                                  </p>
                                ))}
                              </>
                            }
                          />
                        ))}
                      {h.lastError ? (
                        <Alert
                          showIcon
                          type="warning"
                          title={`Last delivery error: ${h.lastError.code ?? 'Unknown'} · ${date(h.lastError.at)}`}
                          description={h.lastError.guidance}
                        />
                      ) : null}
                      {Object.entries(h.unavailable).map(([key, issue]) => (
                        <Alert
                          key={key}
                          showIcon
                          type="info"
                          title={`${humanizeStatus(key)} check unavailable`}
                          description={issue.reason}
                        />
                      ))}
                    </div>
                  </>
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

import { ReloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Select, Space, Spin, Table, Typography } from 'antd';
import { useState } from 'react';
import { apiRequest, getUserErrorMessage } from './api';
import { useAuth } from './auth';
import { type WhatsAppCostEstimate, formatWhatsAppMoney } from './whatsapp-management-api';
import './whatsapp-management.css';

export function WhatsAppBroadcastCost({
  projectId,
  broadcastId,
  updatedAt,
}: {
  projectId: string | undefined;
  broadcastId: string;
  updatedAt: string;
}) {
  const { accessToken } = useAuth();
  const [currency, setCurrency] = useState('USD');
  const query = useQuery({
    queryKey: ['whatsapp-broadcast-cost', projectId, broadcastId, currency, updatedAt],
    enabled: Boolean(projectId),
    staleTime: 60_000,
    retry: false,
    queryFn: () =>
      apiRequest<{ eligibleRecipients: number; cost?: WhatsAppCostEstimate }>(
        `/api/v1/projects/${projectId}/broadcasts/${broadcastId}/estimate?currency=${currency}`,
        { method: 'POST' },
        accessToken,
      ),
  });
  const cost = query.data?.cost;
  return (
    <Card
      className="wa-cost-estimate"
      title="Estimated Meta message cost"
      extra={
        <Space wrap>
          <Select
            aria-label="Estimate currency"
            value={currency}
            onChange={setCurrency}
            options={(cost?.rateCard.currencies ?? ['USD', 'EUR', 'GBP']).map((value) => ({
              value,
              label: value,
            }))}
          />
          <Button
            icon={<ReloadOutlined />}
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Recalculate
          </Button>
        </Space>
      }
    >
      {query.isLoading ? <Spin /> : null}
      {query.isError ? (
        <Alert
          type="warning"
          showIcon
          title="Estimate unavailable"
          description={getUserErrorMessage(query.error)}
        />
      ) : null}
      {cost ? (
        <>
          <div className="wa-health-grid">
            <div className="wa-health-tile">
              <span>Estimated list-rate cost</span>
              <strong>{formatWhatsAppMoney(cost.estimatedCost, currency)}</strong>
              <small>Meta charges only for delivered messages</small>
            </div>
            <div className="wa-health-tile">
              <span>Expected paid / free</span>
              <strong>
                {cost.paid} / {cost.free}
              </strong>
              <small>
                {cost.unknown
                  ? `${cost.unknown} recipients could not be priced`
                  : `${cost.eligibleRecipients} eligible recipients`}
              </small>
            </div>
            <div className="wa-health-tile">
              <span>Template category</span>
              <strong>{cost.category}</strong>
              <small>Estimated for {new Date(cost.sendAt).toLocaleString()}</small>
            </div>
          </div>
          {cost.unavailableReason ? (
            <Alert
              type="warning"
              showIcon
              title="A complete estimate is unavailable"
              description={
                cost.unavailableReason === 'RATE_CARD_EXPIRED'
                  ? `The verified rate card covers ${cost.rateCard.effectiveFrom} through ${cost.rateCard.effectiveUntil} (exclusive). Meta prices and free-message rules change from October 1, 2026; update the rate card before using an estimate for that date.`
                  : cost.unavailableReason === 'CURRENCY_UNSUPPORTED'
                    ? 'Choose a supported estimate currency.'
                    : cost.unavailableReason === 'CATEGORY_UNSUPPORTED'
                      ? 'This template is unavailable or its category is not supported by the estimator.'
                      : 'Some recipient numbers could not be priced. They are not treated as free.'
              }
            />
          ) : null}
          <Table
            size="small"
            rowKey="market"
            dataSource={cost.breakdown}
            pagination={false}
            scroll={{ x: 620 }}
            columns={[
              { title: 'Recipient market', dataIndex: 'market' },
              { title: 'Recipients', dataIndex: 'recipients' },
              { title: 'Paid', dataIndex: 'paid' },
              { title: 'Free', dataIndex: 'free' },
              {
                title: 'Rate / message',
                dataIndex: 'unitPrice',
                render: (value: number | null) => formatWhatsAppMoney(value, currency),
              },
              {
                title: 'Estimate',
                render: (_, row) =>
                  row.unknown ? 'Incomplete' : formatWhatsAppMoney(row.subtotal, currency),
              },
            ]}
          />
          <Typography.Paragraph type="secondary">
            Planning estimate in {currency}, using the official list rates verified on{' '}
            {cost.rateCard.verifiedAt}. Select your Meta account currency for comparison. It assumes
            delivery to every eligible recipient; volume discounts and free entry points can reduce
            the charge. Customer service windows may expire before delivery. Taxes are excluded.
          </Typography.Paragraph>
          <Typography.Text type="secondary">
            Recalculated {new Date(cost.estimatedAt).toLocaleString()}.{' '}
            <a href={cost.rateCard.source} target="_blank" rel="noopener noreferrer">
              View Meta rates
            </a>
          </Typography.Text>
        </>
      ) : null}
    </Card>
  );
}

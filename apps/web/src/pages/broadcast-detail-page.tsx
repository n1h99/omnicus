import { CopyOutlined, InboxOutlined } from '@ant-design/icons';
import { Alert, Button, Descriptions, Modal, Space, Spin, Table, Typography, message } from 'antd';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { getUserErrorMessage } from '../api';
import {
  type BroadcastRecipient,
  useBroadcast,
  useBroadcastMutations,
  useBroadcastRecipients,
} from '../broadcasts-api';
import { channelAccountLabel, channelProviderLabel } from '../channel-provider';
import { useChannels } from '../channels-api';
import { hasProjectPermission, useProjectAccess } from '../project-access';
import { StatusText } from '../status-text';
import { WhatsAppBroadcastCost } from '../whatsapp-broadcast-cost';

export function BroadcastDetailPage() {
  const { projectId, broadcastId } = useParams();
  const navigate = useNavigate();
  const [removing, setRemoving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const query = useBroadcast(projectId, broadcastId);
  const channels = useChannels(projectId);
  const recipients = useBroadcastRecipients(projectId, broadcastId);
  const access = useProjectAccess(projectId);
  const mutations = useBroadcastMutations(projectId);
  if (query.isLoading) return <Spin className="route-loading" size="large" />;
  if (query.isError || !query.data)
    return (
      <Alert
        message={getUserErrorMessage(query.error, 'Broadcast could not be loaded.')}
        showIcon
        type="error"
      />
    );
  const broadcast = query.data;
  const channel = (channels.data ?? []).find(
    (candidate) => candidate.id === broadcast.connectionId,
  );
  const provider = channel ? channelProviderLabel(channel.type) : 'Channel';
  const canLaunch = hasProjectPermission(access.data, 'broadcasts:launch');
  const canCreate = hasProjectPermission(access.data, 'broadcasts:create');
  const canPause = hasProjectPermission(access.data, 'broadcasts:pause');
  const canCancel = hasProjectPermission(access.data, 'broadcasts:cancel');
  const action = async (
    operation: () => Promise<unknown>,
    success: string,
    fallback = 'The broadcast action could not be completed.',
  ) => {
    try {
      await operation();
      void message.success(success);
      return true;
    } catch (error) {
      void message.error(getUserErrorMessage(error, fallback));
      return false;
    }
  };
  return (
    <section>
      <div className="page-heading-row broadcast-detail-heading">
        <div>
          <Typography.Title level={2}>{broadcast.name}</Typography.Title>
          <Typography.Text type="secondary">
            Delivery configuration and immutable recipient history.
          </Typography.Text>
        </div>
        <Space wrap>
          {canCreate &&
          ['COMPLETED', 'CANCELLED', 'FAILED', 'ARCHIVED'].includes(broadcast.status) ? (
            <Button icon={<CopyOutlined />} onClick={() => setRestarting(true)} type="primary">
              Run again
            </Button>
          ) : null}
          {canCancel &&
          !['PREPARING', 'RUNNING', 'PAUSED', 'ARCHIVED'].includes(broadcast.status) ? (
            <Button danger icon={<InboxOutlined />} onClick={() => setRemoving(true)}>
              Archive
            </Button>
          ) : null}
        </Space>
      </div>
      <Descriptions
        bordered
        column={1}
        items={[
          { key: 'status', label: 'Status', children: <StatusText status={broadcast.status} /> },
          { key: 'audience', label: 'Audience', children: broadcast.audience.mode },
          {
            key: 'provider',
            label: 'Provider',
            children: channel
              ? `${provider} — ${channel.name} (${channelAccountLabel(channel)})`
              : '—',
          },
          {
            key: 'text',
            label: channel?.type === 'WHATSAPP' ? 'Approved template' : 'Message',
            children:
              channel?.type === 'WHATSAPP'
                ? broadcast.whatsAppTemplate?.name
                  ? `${broadcast.whatsAppTemplate.name} — ${broadcast.whatsAppTemplate.languageCode ?? 'language saved at creation'}`
                  : 'WhatsApp template snapshot'
                : broadcast.text,
          },
          { key: 'total', label: 'Recipients', children: broadcast.recipientCount },
          {
            key: 'errorCode',
            label: 'Safe error',
            children: broadcast.errorCode ?? '—',
          },
        ]}
      />
      {channel?.type === 'WHATSAPP' && ['DRAFT', 'SCHEDULED'].includes(broadcast.status) ? (
        <WhatsAppBroadcastCost
          projectId={projectId}
          broadcastId={broadcast.id}
          updatedAt={broadcast.updatedAt}
        />
      ) : null}
      <Space wrap style={{ marginTop: 16 }}>
        {canLaunch && ['DRAFT', 'SCHEDULED'].includes(broadcast.status) ? (
          <Button
            loading={mutations.launch.isPending}
            type="primary"
            onClick={() =>
              void action(() => mutations.launch.mutateAsync(broadcast.id), 'Broadcast queued.')
            }
          >
            Launch
          </Button>
        ) : null}
        {canPause && broadcast.status === 'RUNNING' ? (
          <Button
            onClick={() =>
              void action(() => mutations.pause.mutateAsync(broadcast.id), 'Broadcast paused.')
            }
          >
            Pause
          </Button>
        ) : null}
        {canLaunch && broadcast.status === 'PAUSED' ? (
          <Button
            onClick={() =>
              void action(() => mutations.resume.mutateAsync(broadcast.id), 'Broadcast resumed.')
            }
          >
            Resume
          </Button>
        ) : null}
        {canLaunch && broadcast.status === 'RUNNING' ? (
          <Button
            onClick={() =>
              void action(
                () => mutations.retryFailed.mutateAsync(broadcast.id),
                'Failed recipients queued again.',
              )
            }
          >
            Retry failed
          </Button>
        ) : null}
        {canCancel &&
        ['DRAFT', 'SCHEDULED', 'PREPARING', 'RUNNING', 'PAUSED'].includes(broadcast.status) ? (
          <Button danger onClick={() => setCancelling(true)}>
            Cancel
          </Button>
        ) : null}
      </Space>
      <Typography.Title level={4}>Recipients</Typography.Title>
      {recipients.isError ? (
        <Alert message="Broadcast recipients could not be loaded." showIcon type="error" />
      ) : null}
      <Table<BroadcastRecipient>
        rowKey="id"
        loading={recipients.isLoading}
        dataSource={recipients.data?.items ?? []}
        pagination={false}
        columns={[
          { title: 'Contact', dataIndex: ['contact', 'displayName'] },
          {
            title: provider,
            render: (_, recipient) =>
              channel?.type === 'WHATSAPP'
                ? recipient.channelIdentity.externalUserId
                : (recipient.channelIdentity.username ?? '—'),
          },
          {
            title: 'Status',
            dataIndex: 'status',
            render: (value) => <StatusText status={value} />,
          },
          { title: 'Error code', dataIndex: 'lastError', render: (value) => value ?? '—' },
          ...(channel?.type === 'WHATSAPP'
            ? [
                {
                  title: 'Meta pricing',
                  key: 'pricing',
                  render: (_: unknown, recipient: { pricing?: { billable: boolean } }) =>
                    recipient.pricing
                      ? recipient.pricing.billable
                        ? 'Paid'
                        : 'Free'
                      : 'Not reported',
                },
              ]
            : []),
        ]}
      />
      <Modal
        className="account-confirm-modal"
        footer={null}
        onCancel={() => setCancelling(false)}
        open={cancelling}
        title="Cancel this broadcast?"
        width={460}
      >
        <Typography.Paragraph type="secondary">
          This broadcast will be cancelled and can no longer send new recipients.
        </Typography.Paragraph>
        <div className="modal-form-actions">
          <Button onClick={() => setCancelling(false)}>Keep broadcast</Button>
          <Button
            danger
            loading={mutations.cancel.isPending}
            onClick={async () => {
              const succeeded = await action(
                () => mutations.cancel.mutateAsync(broadcast.id),
                'Broadcast cancelled.',
              );
              if (succeeded) setCancelling(false);
            }}
          >
            Cancel broadcast
          </Button>
        </div>
      </Modal>
      <Modal
        cancelText="Keep broadcast"
        centered
        okButtonProps={{ danger: true, loading: mutations.remove.isPending }}
        okText="Archive broadcast"
        onCancel={() => setRemoving(false)}
        onOk={async () => {
          const succeeded = await action(
            () => mutations.remove.mutateAsync(broadcast.id),
            'Broadcast archived.',
            'Broadcast could not be archived.',
          );
          if (!succeeded) return;
          setRemoving(false);
          void navigate(`/projects/${projectId}/broadcasts`, { replace: true });
        }}
        open={removing}
        title="Archive this broadcast?"
      >
        The broadcast will be archived and removed from the project list. Recipient history remains
        protected for audit.
      </Modal>
      <Modal
        cancelText="Cancel"
        centered
        okButtonProps={{ loading: mutations.runAgain.isPending }}
        okText="Create new draft"
        onCancel={() => setRestarting(false)}
        onOk={async () => {
          try {
            const copy = await mutations.runAgain.mutateAsync(broadcast.id);
            setRestarting(false);
            void message.success('A new broadcast draft was created.');
            void navigate(`/projects/${projectId}/broadcasts/${copy.id}`);
          } catch (error) {
            void message.error(
              getUserErrorMessage(error, 'A new broadcast draft could not be created.'),
            );
          }
        }}
        open={restarting}
        title="Run this broadcast again?"
      >
        A new draft with the same content and audience rules will be created. Recipients will be
        recalculated when you launch it, while this delivery history remains unchanged.
      </Modal>
    </section>
  );
}

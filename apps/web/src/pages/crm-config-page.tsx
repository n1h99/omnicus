import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Result,
  Spin,
  Switch,
  Table,
  Typography,
  message,
} from 'antd';
import { type KeyboardEvent, useState } from 'react';
import { useParams } from 'react-router';

import { getUserErrorMessage } from '../api';
import { StatusText } from '../status-text';
import { MetaLeadsPanel } from '../meta-leads-panel';
import {
  type CrmOperation,
  type CrmPairing,
  useCrmConnectionMutations,
  useCrmOperations,
  useCrmProjectConfig,
  useRetryCrmOperation,
  useSaveCrmProjectConfig,
} from '../crm-api';
import { hasProjectPermission, useProjectAccess } from '../project-access';
import {
  TechnicalRecordDrawer,
  type TechnicalRecordSection,
  type TechnicalRecordTopField,
} from '../technical-record-drawer';

export function CrmConfigPage() {
  const { projectId } = useParams();
  const access = useProjectAccess(projectId);
  const config = useCrmProjectConfig(projectId);
  const [crmOperationsPage, setCrmOperationsPage] = useState(1);
  const operations = useCrmOperations(projectId, crmOperationsPage);
  const retry = useRetryCrmOperation(projectId);
  const save = useSaveCrmProjectConfig(projectId);
  const connectionMutations = useCrmConnectionMutations(projectId);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [retryOperation, setRetryOperation] = useState<CrmOperation>();
  const [disconnecting, setDisconnecting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [pairing, setPairing] = useState<CrmPairing>();
  const [selectedOperation, setSelectedOperation] = useState<CrmOperation>();

  const activateRow = (callback: () => void) => (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      callback();
    }
  };
  const crmOperationLabel = (type: CrmOperation['type']) =>
    ({
      CREATE_OR_UPDATE_LEAD: 'Create or update lead',
      FORWARD_INBOUND_MESSAGE: 'Forward inbound message',
      FORWARD_OUTBOUND_MESSAGE: 'Forward outbound message',
      FORWARD_REACTION_EVENT: 'Forward reaction event',
    })[type] ?? type;
  const crmTop = (row: CrmOperation): TechnicalRecordTopField[] => [
    { label: 'Type', value: crmOperationLabel(row.type) },
    { label: 'Status', value: <StatusText status={row.status} /> },
    { label: 'Updated', value: new Date(row.updatedAt).toLocaleString() },
  ];
  const crmSections = (row: CrmOperation): TechnicalRecordSection[] => [
    {
      fields: [
        { label: 'Attempts', value: row.attempts },
        {
          label: 'Safe error',
          value: row.lastError ?? 'No safe error',
        },
      ],
      title: 'Processing',
    },
    {
      fields: [
        { label: 'Operation type', value: crmOperationLabel(row.type) },
        { label: 'Created', value: new Date(row.createdAt).toLocaleString() },
      ],
      title: 'Entity',
    },
    {
      fields: [{ label: 'Operation ID', value: row.id, copy: true }],
      title: 'Identifiers',
    },
    ...(row.resultSafe === null || row.resultSafe === undefined
      ? []
      : [{ fields: [{ label: 'Result', value: row.resultSafe }], title: 'Additional details' }]),
  ];
  if (access.isLoading || config.isLoading) return <Spin className="route-loading" size="large" />;
  if (!hasProjectPermission(access.data, 'integrations:manage'))
    return (
      <Result
        status="403"
        title="Access denied"
        subTitle="Integration management permission is required."
      />
    );
  const initialValues = config.data
    ? { ...config.data, fieldMapping: JSON.stringify(config.data.fieldMapping, null, 2) }
    : { enabled: true, fieldMapping: '{}' };
  const isConnected = Boolean(config.data?.paired && config.data.status !== 'DISABLED');
  const generatePairingCode = async () => {
    const crmProjectId = config.data?.crmProjectId;
    if (!crmProjectId) {
      void message.error('Save the CRM project ID first.');
      return;
    }
    try {
      setPairing(await connectionMutations.pairing.mutateAsync(crmProjectId));
    } catch (error) {
      void message.error(getUserErrorMessage(error, 'A CRM pairing code could not be created.'));
    }
  };

  return (
    <section>
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>CRM integration</Typography.Title>
          <Typography.Text type="secondary">
            Secure project routing, field mapping and delivery diagnostics.
          </Typography.Text>
        </div>
      </div>
      {isConnected ? (
        <Card className="crm-connection-card" title="Project CRM connection">
          <Descriptions
            column={2}
            items={[
              {
                key: 'status',
                label: 'Status',
                children: <StatusText status={config.data?.status} />,
              },
              {
                key: 'provider',
                label: 'Provider',
                children: config.data?.provider,
              },
              { key: 'baseUrl', label: 'CRM URL', children: config.data?.baseUrl },
              {
                key: 'tested',
                label: 'Last test',
                children: config.data?.lastTestedAt
                  ? new Date(config.data.lastTestedAt).toLocaleString()
                  : 'Never',
              },
            ]}
            size="small"
          />
          <div className="crm-connection-actions">
            <Button
              loading={connectionMutations.test.isPending}
              onClick={async () => {
                try {
                  const result = await connectionMutations.test.mutateAsync();
                  if (result.ok) void message.success('CRM connection verified.');
                  else void message.error('CRM connection test failed. Check the CRM endpoint.');
                } catch (error) {
                  void message.error(
                    getUserErrorMessage(error, 'CRM connection test could not be completed.'),
                  );
                }
              }}
            >
              Test connection
            </Button>
            <Button danger onClick={() => setDisconnectOpen(true)}>
              Disconnect
            </Button>
          </div>
        </Card>
      ) : null}
      <Form
        className="settings-form surface crm-routing-form"
        disabled={isConnected}
        initialValues={initialValues}
        layout="vertical"
        onFinish={async (values: {
          crmProjectId: string;
          defaultPipeline?: string;
          defaultStage?: string;
          enabled: boolean;
          fieldMapping: string;
        }) => {
          let fieldMapping: Record<string, unknown>;
          try {
            fieldMapping = values.fieldMapping
              ? (JSON.parse(values.fieldMapping) as Record<string, unknown>)
              : {};
          } catch {
            void message.error(
              'CRM configuration could not be saved. Field mapping is not valid JSON.',
            );
            return;
          }
          try {
            await save.mutateAsync({
              crmProjectId: values.crmProjectId,
              defaultPipeline: values.defaultPipeline || null,
              defaultStage: values.defaultStage || null,
              enabled: values.enabled,
              fieldMapping,
            });
            void message.success('CRM configuration saved.');
          } catch (error) {
            void message.error(getUserErrorMessage(error, 'CRM configuration could not be saved.'));
          }
        }}
      >
        <Form.Item label="CRM project ID" name="crmProjectId" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item label="Default pipeline" name="defaultPipeline">
          <Input />
        </Form.Item>
        <Form.Item label="Default stage" name="defaultStage">
          <Input />
        </Form.Item>
        <Form.Item label="Field mapping (JSON)" name="fieldMapping" normalize={(value) => value}>
          <Input.TextArea autoSize={{ minRows: 5 }} />
        </Form.Item>
        <Form.Item label="Enable CRM integration" name="enabled" valuePropName="checked">
          <Switch />
        </Form.Item>
        <div className="crm-config-actions">
          <Button disabled={isConnected} htmlType="submit" loading={save.isPending} type="primary">
            Save configuration
          </Button>
          {!isConnected ? (
            <Button
              htmlType="button"
              loading={connectionMutations.pairing.isPending}
              onClick={() => void generatePairingCode()}
            >
              Generate pairing code
            </Button>
          ) : null}
        </div>
        {!isConnected && pairing ? (
          <Alert
            className="crm-pairing-note"
            description={
              <>
                <div>Omnicus API URL: {pairing.omnicusApiUrl}</div>
                <div>Pairing code: {pairing.pairingCode}</div>
                <div>Expires: {new Date(pairing.expiresAt).toLocaleString()}</div>
              </>
            }
            message="Copy these values to CRM"
            showIcon
            type="success"
          />
        ) : null}
      </Form>
      <Typography.Title className="section-heading-title" level={3}>
        CRM operation journal
      </Typography.Title>
      <Table<CrmOperation>
        dataSource={operations.data?.items ?? []}
        loading={operations.isLoading}
        locale={{
          emptyText: operations.isError
            ? 'The CRM operation journal could not be loaded.'
            : 'No CRM operations yet.',
        }}
        pagination={{
          current: crmOperationsPage,
          onChange: setCrmOperationsPage,
          pageSize: 10,
          showSizeChanger: false,
          total: operations.data?.total ?? 0,
        }}
        rowKey="id"
        columns={[
          { dataIndex: 'type', key: 'type', title: 'Operation' },
          {
            dataIndex: 'status',
            key: 'status',
            render: (status: CrmOperation['status']) => <StatusText status={status} />,
            title: 'Status',
          },
          { dataIndex: 'attempts', key: 'attempts', title: 'Attempts' },
          { dataIndex: 'lastError', key: 'lastError', title: 'Safe error' },
          {
            key: 'retry',
            render: (_value: unknown, record: CrmOperation) =>
              record.status === 'FAILED' || record.status === 'UNKNOWN' ? (
                <Button
                  className="crm-operation-retry-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setRetryOperation(record);
                  }}
                  loading={retry.isPending && retryOperation?.id === record.id}
                  size="small"
                >
                  Retry
                </Button>
              ) : null,
            title: 'Action',
          },
        ]}
        onRow={(row) => ({
          className: 'clickable-table-row',
          onClick: () => setSelectedOperation(row),
          onKeyDown: activateRow(() => setSelectedOperation(row)),
          tabIndex: 0,
        })}
        rowClassName="clickable-table-row"
      />
      {projectId && isConnected ? <MetaLeadsPanel projectId={projectId} /> : null}
      <TechnicalRecordDrawer
        onClose={() => setSelectedOperation(undefined)}
        open={Boolean(selectedOperation)}
        sections={selectedOperation ? crmSections(selectedOperation) : []}
        title="CRM operation details"
        top={selectedOperation ? crmTop(selectedOperation) : []}
      />
      <Modal
        className="account-confirm-modal"
        footer={null}
        onCancel={() => setDisconnectOpen(false)}
        open={disconnectOpen}
        title="Disconnect this CRM?"
        width={460}
      >
        <Typography.Paragraph type="secondary">
          Configuration values will remain available for a future reconnection.
        </Typography.Paragraph>
        <div className="modal-form-actions">
          <Button onClick={() => setDisconnectOpen(false)}>Cancel</Button>
          <Button
            danger
            loading={disconnecting}
            onClick={async () => {
              setDisconnecting(true);
              try {
                await connectionMutations.disable.mutateAsync();
                setPairing(undefined);
                void message.success('CRM disconnected.');
                setDisconnectOpen(false);
              } catch (error) {
                void message.error(getUserErrorMessage(error, 'CRM could not be disconnected.'));
              } finally {
                setDisconnecting(false);
              }
            }}
          >
            Disconnect
          </Button>
        </div>
      </Modal>
      <Modal
        className="account-confirm-modal"
        footer={null}
        onCancel={() => setRetryOperation(undefined)}
        open={Boolean(retryOperation)}
        title="Retry CRM operation?"
        width={460}
      >
        <Typography.Paragraph type="secondary">
          {retryOperation
            ? retryOperation.status === 'UNKNOWN'
              ? 'Check the CRM first. Retrying an operation that already completed can create a duplicate.'
              : 'Requeue this failed CRM operation?'
            : ''}
        </Typography.Paragraph>
        <div className="modal-form-actions">
          <Button onClick={() => setRetryOperation(undefined)}>Cancel</Button>
          <Button
            loading={retrying}
            onClick={async () => {
              if (!retryOperation) return;
              setRetrying(true);
              try {
                await retry.mutateAsync({
                  confirmUnknownDelivery: retryOperation.status === 'UNKNOWN',
                  operationId: retryOperation.id,
                });
                void message.success('CRM operation queued for retry.');
                setRetryOperation(undefined);
              } catch (error) {
                void message.error(
                  getUserErrorMessage(error, 'The CRM operation could not be retried.'),
                );
              } finally {
                setRetrying(false);
              }
            }}
          >
            Retry operation
          </Button>
        </div>
      </Modal>
    </section>
  );
}

import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  List,
  Modal,
  Form,
  Input,
  Row,
  Select,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';

import { apiRequest, getUserErrorMessage } from '../api';
import { useAuth } from '../auth';
import { hasProjectPermission, useProjectAccess } from '../project-access';
import { StatusText } from '../status-text';

interface Contact {
  id: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  phone: string | null;
  email: string | null;
  status: 'ACTIVE' | 'BLOCKED' | 'UNSUBSCRIBED' | 'ARCHIVED' | 'MERGED';
  automationMode: 'ENABLED' | 'DISABLED';
  crmLeadId: string | null;
  crmContactId: string | null;
  customFields: Record<string, unknown>;
  whatsAppConsentAt: string | null;
  whatsAppConsentSource: string | null;
  whatsAppConsentStatus: 'UNKNOWN' | 'GRANTED' | 'REVOKED';
  whatsAppOptOutAt: string | null;
  channelIdentities: {
    id: string;
    channel: string;
    externalUserId: string;
    username: string | null;
    whatsAppLastErrorCode: string | null;
    whatsAppReachability: 'UNKNOWN' | 'PENDING' | 'AVAILABLE' | 'UNAVAILABLE' | 'BLOCKED' | null;
    whatsAppReachabilityCheckedAt: string | null;
  }[];
  tags: { tag: { id: string; name: string; color: string | null } }[];
}

interface TagItem {
  id: string;
  name: string;
  color: string | null;
}

interface ContactTimeline {
  trackedLinkClicks: Array<{
    id: string;
    isLikelyBot: boolean;
    nodeId: string;
    occurredAt: string;
    scenario: { id: string; name: string } | null;
    scenarioExecutionId: string;
    targetUrl: string;
    trackedLinkId: string;
    triggerType: string | null;
  }>;
}

function formatIdentityValue(identity: Contact['channelIdentities'][number]): string {
  return identity.username ? `@${identity.username}` : (identity.externalUserId ?? '\u2014');
}

function triggerTypeLabel(triggerType: string | null): string {
  if (triggerType === 'TELEGRAM_DEEP_LINK') return 'Telegram link';
  if (triggerType === 'WEBSITE_REGISTRATION') return 'Website registration';
  if (triggerType === 'INCOMING_MESSAGE') return 'Incoming message';
  return 'Automation';
}

export function ContactDetailPage() {
  const { contactId, projectId } = useParams();
  const { accessToken } = useAuth();
  const cache = useQueryClient();
  const access = useProjectAccess(projectId);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletingContact, setDeletingContact] = useState(false);
  const contact = useQuery({
    enabled: Boolean(projectId && contactId),
    queryFn: () =>
      apiRequest<Contact>(`/api/v1/projects/${projectId}/contacts/${contactId}`, {}, accessToken),
    queryKey: ['contact', projectId, contactId, accessToken],
  });
  const tags = useQuery({
    enabled: Boolean(projectId),
    queryFn: () => apiRequest<TagItem[]>(`/api/v1/projects/${projectId}/tags`, {}, accessToken),
    queryKey: ['tags', projectId, accessToken],
  });
  const timeline = useQuery({
    enabled: Boolean(projectId && contactId),
    queryFn: () =>
      apiRequest<ContactTimeline>(
        `/api/v1/projects/${projectId}/contacts/${contactId}/timeline`,
        {},
        accessToken,
      ),
    queryKey: ['contact-timeline', projectId, contactId, accessToken],
  });

  if (contact.isLoading) return <Spin className="route-loading" />;
  if (contact.isError || !contact.data)
    return (
      <Alert
        message={getUserErrorMessage(contact.error, 'Contact could not be loaded.')}
        showIcon
        type="error"
      />
    );

  const reload = async () =>
    cache.invalidateQueries({ queryKey: ['contact', projectId, contactId] });
  const value = contact.data;
  const canUpdate = hasProjectPermission(access.data, 'contacts:update');
  const telegramIdentity = value.channelIdentities.find(
    (identity) => identity.channel.toLowerCase() === 'telegram',
  );
  const whatsappIdentity = value.channelIdentities.find(
    (identity) => identity.channel.toLowerCase() === 'whatsapp',
  );
  const whatsAppReachability = whatsappIdentity?.whatsAppReachability ?? 'UNKNOWN';
  const whatsAppMailingEligible =
    value.whatsAppConsentStatus === 'GRANTED' && whatsAppReachability === 'AVAILABLE';
  const deleteContact = async () => {
    try {
      await apiRequest(
        `/api/v1/projects/${projectId}/contacts/${contactId}`,
        { body: JSON.stringify({ status: 'ARCHIVED' }), method: 'PATCH' },
        accessToken,
      );
      void message.success('Contact deleted.');
      window.location.assign(`/projects/${projectId}/contacts`);
    } catch (error) {
      void message.error(getUserErrorMessage(error, 'Contact could not be deleted.'));
    }
  };

  return (
    <section>
      <div className="entity-hero">
        <div className="entity-hero-copy">
          <Typography.Title level={2}>{value.displayName}</Typography.Title>
        </div>
      </div>

      <Row className="balanced-card-row" gutter={[18, 18]}>
        <Col lg={9} xs={24}>
          <Card className="contact-summary-card" title="Contact summary">
            <div className="contact-summary-main">
              <div className="contact-summary-grid">
                <div className="contact-summary-row">
                  <div className="contact-summary-label">CRM lead:</div>
                  <div className="contact-summary-value">{value.crmLeadId ?? '\u2014'}</div>
                </div>
                <div className="contact-summary-row">
                  <div className="contact-summary-label">Contact ID:</div>
                  <div className="contact-summary-value">{value.id}</div>
                </div>
                <div className="contact-summary-row">
                  <div className="contact-summary-label">Telegram:</div>
                  <div className="contact-summary-value">
                    {telegramIdentity ? formatIdentityValue(telegramIdentity) : '\u2014'}
                  </div>
                </div>
                <div className="contact-summary-row">
                  <div className="contact-summary-label">WhatsApp:</div>
                  <div className="contact-summary-value">
                    {whatsappIdentity
                      ? whatsAppReachability.charAt(0) + whatsAppReachability.slice(1).toLowerCase()
                      : 'Unknown'}
                  </div>
                </div>
                <div className="contact-summary-row">
                  <div className="contact-summary-label">WA consent:</div>
                  <div className="contact-summary-value">
                    {value.whatsAppConsentStatus.charAt(0) +
                      value.whatsAppConsentStatus.slice(1).toLowerCase()}
                  </div>
                </div>
                <div className="contact-summary-row">
                  <div className="contact-summary-label">WA mailing:</div>
                  <div className="contact-summary-value">
                    {whatsAppMailingEligible ? 'Active' : 'Not eligible'}
                  </div>
                </div>
                <div className="contact-summary-row">
                  <div className="contact-summary-label">Status:</div>
                  <div className="contact-summary-value">
                    <StatusText status={value.status} />
                  </div>
                </div>
                <div className="contact-summary-row">
                  <div className="contact-summary-label">Automation:</div>
                  <div className="contact-summary-value">
                    <StatusText status={value.automationMode} />
                  </div>
                </div>
                <div className="contact-summary-row">
                  <div className="contact-summary-label">Tags:</div>
                  <div className="contact-summary-value contact-summary-tags">
                    {value.tags.length
                      ? value.tags.map((item) => (
                          <Tag
                            closable={canUpdate}
                            {...(item.tag.color ? { color: item.tag.color } : {})}
                            key={item.tag.id}
                            onClose={(event) => {
                              event.preventDefault();
                              void (async () => {
                                try {
                                  await apiRequest(
                                    `/api/v1/projects/${projectId}/contacts/${contactId}/tags/${item.tag.id}`,
                                    { method: 'DELETE' },
                                    accessToken,
                                  );
                                  await reload();
                                  void message.success('Tag removed from contact.');
                                } catch (error) {
                                  void message.error(
                                    getUserErrorMessage(
                                      error,
                                      'Tag could not be removed from contact.',
                                    ),
                                  );
                                }
                              })();
                            }}
                          >
                            {item.tag.name}
                          </Tag>
                        ))
                      : 'No tags'}
                  </div>
                </div>
              </div>
            </div>
            <div className="contact-summary-actions">
              <Form
                className="contact-tag-form"
                layout="vertical"
                onFinish={async (values) => {
                  try {
                    await apiRequest(
                      `/api/v1/projects/${projectId}/contacts/${contactId}/tags`,
                      { body: JSON.stringify(values), method: 'POST' },
                      accessToken,
                    );
                    await reload();
                    void message.success('Tag added to contact.');
                  } catch (error) {
                    void message.error(
                      getUserErrorMessage(error, 'Tag could not be added to contact.'),
                    );
                  }
                }}
              >
                <Form.Item label="Add tag" name="tagId">
                  <Select
                    className="contact-tag-select"
                    options={(tags.data ?? []).map((tag) => ({ label: tag.name, value: tag.id }))}
                    placeholder="Choose a tag"
                  />
                </Form.Item>
                <Button block className="contact-tag-button" htmlType="submit">
                  Add tag
                </Button>
              </Form>
            </div>
          </Card>
        </Col>
        <Col lg={15} xs={24}>
          <Card title="Contact details">
            <Form
              initialValues={value}
              layout="vertical"
              onFinish={async (values) => {
                try {
                  await apiRequest(
                    `/api/v1/projects/${projectId}/contacts/${contactId}`,
                    { body: JSON.stringify(values), method: 'PATCH' },
                    accessToken,
                  );
                  await reload();
                  void message.success('Contact saved.');
                } catch (error) {
                  void message.error(getUserErrorMessage(error, 'Contact could not be saved.'));
                }
              }}
            >
              <Row gutter={14}>
                <Col md={12} xs={24}>
                  <Form.Item label="Display name" name="displayName" rules={[{ required: true }]}>
                    <Input />
                  </Form.Item>
                </Col>
                <Col md={6} xs={12}>
                  <Form.Item label="First name" name="firstName">
                    <Input />
                  </Form.Item>
                </Col>
                <Col md={6} xs={12}>
                  <Form.Item label="Last name" name="lastName">
                    <Input />
                  </Form.Item>
                </Col>
                <Col md={12} xs={24}>
                  <Form.Item label="Phone" name="phone">
                    <Input />
                  </Form.Item>
                </Col>
                <Col md={12} xs={24}>
                  <Form.Item label="Email" name="email">
                    <Input />
                  </Form.Item>
                </Col>
                <Col md={12} xs={24}>
                  <Form.Item label="Status" name="status">
                    <Select
                      options={[
                        { label: 'Active', value: 'ACTIVE' },
                        { label: 'Blocked', value: 'BLOCKED' },
                        { label: 'Unsubscribed', value: 'UNSUBSCRIBED' },
                        { label: 'Archived', value: 'ARCHIVED' },
                      ]}
                    />
                  </Form.Item>
                </Col>
                <Col md={12} xs={24}>
                  <Form.Item label="Automation mode" name="automationMode">
                    <Select
                      options={[
                        { label: 'Enabled', value: 'ENABLED' },
                        { label: 'Disabled', value: 'DISABLED' },
                      ]}
                    />
                  </Form.Item>
                </Col>
                <Col md={12} xs={24}>
                  <Form.Item
                    extra="Marketing broadcasts require Granted consent and an Available WhatsApp recipient."
                    label="WhatsApp marketing consent"
                    name="whatsAppConsentStatus"
                  >
                    <Select
                      options={[
                        { label: 'Unknown', value: 'UNKNOWN' },
                        { label: 'Granted', value: 'GRANTED' },
                        { label: 'Revoked', value: 'REVOKED' },
                      ]}
                    />
                  </Form.Item>
                </Col>
              </Row>
              <Button htmlType="submit" type="primary">
                Save changes
              </Button>
            </Form>
          </Card>
        </Col>
      </Row>

      <Card
        className="tracked-link-activity-card"
        extra={
          timeline.data?.trackedLinkClicks.length ? (
            <Tag color="green">
              {timeline.data.trackedLinkClicks.filter((click) => !click.isLikelyBot).length} contact
              clicks
            </Tag>
          ) : null
        }
        title="Tracked link activity"
      >
        {timeline.isLoading ? (
          <Spin size="small" />
        ) : timeline.isError ? (
          <Alert
            message={getUserErrorMessage(
              timeline.error,
              'Tracked link activity could not be loaded.',
            )}
            showIcon
            type="error"
          />
        ) : timeline.data?.trackedLinkClicks.length ? (
          <List
            dataSource={timeline.data.trackedLinkClicks}
            renderItem={(click) => (
              <List.Item className="tracked-link-activity-item" key={click.id}>
                <div className="tracked-link-activity-content">
                  <Typography.Link
                    className="tracked-link-activity-url"
                    href={click.targetUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {click.targetUrl}
                  </Typography.Link>
                  <div className="tracked-link-activity-meta">
                    <time>{new Date(click.occurredAt).toLocaleString()}</time>
                    <span>{click.scenario?.name ?? 'Deleted automation'}</span>
                    <span>{triggerTypeLabel(click.triggerType)}</span>
                    <Tag color={click.isLikelyBot ? 'default' : 'green'}>
                      {click.isLikelyBot ? 'Bot preview' : 'Contact click'}
                    </Tag>
                  </div>
                </div>
              </List.Item>
            )}
          />
        ) : (
          <Empty
            description="No tracked links have been opened by this contact yet."
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        )}
      </Card>

      <Row className="balanced-card-row contact-secondary-row" gutter={[18, 18]}>
        <Col lg={hasProjectPermission(access.data, 'contacts:merge') ? 15 : 24} xs={24}>
          <Card title="Custom field values">
            <Form
              initialValues={{ values: JSON.stringify(value.customFields, null, 2) }}
              layout="vertical"
              onFinish={async (values) => {
                let customFields: Record<string, unknown>;
                try {
                  customFields = JSON.parse(values.values) as Record<string, unknown>;
                } catch {
                  void message.error(
                    'Custom fields could not be saved. Values are not valid JSON.',
                  );
                  return;
                }
                try {
                  await apiRequest(
                    `/api/v1/projects/${projectId}/contacts/${contactId}`,
                    {
                      body: JSON.stringify({ customFields }),
                      method: 'PATCH',
                    },
                    accessToken,
                  );
                  await reload();
                  void message.success('Custom fields saved.');
                } catch (error) {
                  void message.error(
                    getUserErrorMessage(error, 'Custom fields could not be saved.'),
                  );
                }
              }}
            >
              <Form.Item
                className="contact-custom-fields-note"
                extra="Keys and values are validated against active definitions."
                label="Values (JSON)"
                name="values"
                rules={[{ required: true }]}
              >
                <Input.TextArea className="contact-custom-fields-textarea" />
              </Form.Item>
              <Button htmlType="submit">Save custom fields</Button>
            </Form>
          </Card>
        </Col>
        {hasProjectPermission(access.data, 'contacts:merge') ? (
          <Col lg={9} xs={24}>
            <Card className="danger-card" title="Contact Settings">
              <Form
                layout="vertical"
                onFinish={async (values: { primaryContactId: string }) => {
                  try {
                    await apiRequest(
                      `/api/v1/projects/${projectId}/contacts/merge`,
                      {
                        body: JSON.stringify({
                          primaryContactId: values.primaryContactId,
                          secondaryContactId: contactId,
                        }),
                        method: 'POST',
                      },
                      accessToken,
                    );
                    window.location.assign(
                      `/projects/${projectId}/contacts/${values.primaryContactId}`,
                    );
                  } catch (error) {
                    void message.error(getUserErrorMessage(error, 'Contacts could not be merged.'));
                  }
                }}
              >
                <Form.Item label="Contact ID" name="primaryContactId" rules={[{ required: true }]}>
                  <Input />
                </Form.Item>
                <div className="contact-settings-actions">
                  <div className="contact-settings-action-group">
                    <Typography.Paragraph className="contact-settings-note" type="secondary">
                      Move this record into another contact. This action cannot be undone from the
                      UI.
                    </Typography.Paragraph>
                    <Button block danger htmlType="submit">
                      Merge contacts
                    </Button>
                  </div>
                  <div className="contact-settings-action-group">
                    <Typography.Paragraph className="contact-settings-note" type="secondary">
                      Delete this contact from the project. This action cannot be undone from the
                      UI.
                    </Typography.Paragraph>
                    <Button block danger onClick={() => setDeleteOpen(true)}>
                      Delete contact
                    </Button>
                  </div>
                </div>
              </Form>
            </Card>
          </Col>
        ) : null}
      </Row>

      <Modal
        className="account-confirm-modal"
        footer={null}
        onCancel={() => setDeleteOpen(false)}
        open={deleteOpen}
        title="Delete this contact?"
        width={460}
      >
        <Typography.Paragraph type="secondary">
          This contact will be archived and removed from active contact lists.
        </Typography.Paragraph>
        <div className="modal-form-actions">
          <Button onClick={() => setDeleteOpen(false)}>Cancel</Button>
          <Button
            danger
            loading={deletingContact}
            onClick={async () => {
              setDeletingContact(true);
              try {
                await deleteContact();
                setDeleteOpen(false);
              } finally {
                setDeletingContact(false);
              }
            }}
          >
            Delete contact
          </Button>
        </div>
      </Modal>
    </section>
  );
}

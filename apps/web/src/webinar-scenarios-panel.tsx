import { App, Alert, Button, Form, Input, Select, Space, Typography } from 'antd';
import { useNavigate } from 'react-router';
import { useChannels } from './channels-api';
import { useScenarioMutations } from './automation-api';
import { useAutomationTags } from './automation-studio-api';
import { getUserErrorMessage } from './api';
import { hasProjectPermission, useProjectAccess } from './project-access';
import { webinarScenarioGraph, webinarScenarioPresets } from './webinar-scenario-presets';

interface Session {
  id: string;
  title: string;
  cancelledAt: string | null;
}
export function WebinarScenariosPanel(props: { projectId: string; sessions: Session[] }) {
  const access = useProjectAccess(props.projectId);
  return hasProjectPermission(access.data, 'automation:manage') ? (
    <ScenarioBuilder {...props} />
  ) : (
    <Alert
      type="info"
      showIcon
      title="Automation access required"
      description="A project automation manager can create and publish webinar scenarios in Automation Studio."
    />
  );
}
function ScenarioBuilder({ projectId, sessions }: { projectId: string; sessions: Session[] }) {
  const { message } = App.useApp(),
    navigate = useNavigate();
  const channels = useChannels(projectId),
    tags = useAutomationTags(projectId),
    mutations = useScenarioMutations(projectId);
  const [form] = Form.useForm<{
    eventId: string;
    preset: string;
    connectionId: string;
    text: string;
    tagId?: string;
  }>();
  return (
    <div className="webinar-workflow-stack">
      <div>
        <Typography.Title level={4}>Customer webinar scenarios</Typography.Title>
        <Typography.Paragraph type="secondary">
          Choose a session and a customer-facing message. A saved draft opens in Automation Studio
          for review and publication. Report statistics stay in Results.
        </Typography.Paragraph>
      </div>
      <Form
        className="webinar-form"
        form={form}
        layout="vertical"
        initialValues={{
          preset: webinarScenarioPresets[0].id,
          text: webinarScenarioPresets[0].text,
        }}
        onFinish={async (values) => {
          const preset = webinarScenarioPresets.find((row) => row.id === values.preset);
          const event = sessions.find((row) => row.id === values.eventId);
          if (!preset || !event) return;
          try {
            const created = await mutations.create.mutateAsync({
              name: `${event.title} — ${preset.label}`,
              description: `Customer webinar scenario for session ${event.id}. Created from Webinar Stars.`,
              graph: webinarScenarioGraph({
                eventId: event.id,
                eventType: preset.event,
                connectionId: values.connectionId,
                text: values.text,
                ...(values.tagId ? { tagId: values.tagId } : {}),
              }),
            });
            navigate(`/projects/${projectId}/scenarios/${created.id}`);
          } catch (error) {
            void message.error(getUserErrorMessage(error));
          }
        }}
      >
        <div className="webinar-form-grid">
          <Form.Item name="eventId" label="Webinar session" rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={sessions
                .filter((row) => !row.cancelledAt)
                .map((row) => ({ value: row.id, label: row.title }))}
            />
          </Form.Item>
          <Form.Item name="preset" label="When to send" rules={[{ required: true }]}>
            <Select
              options={webinarScenarioPresets.map((row) => ({ value: row.id, label: row.label }))}
              onChange={(value) =>
                form.setFieldValue(
                  'text',
                  webinarScenarioPresets.find((row) => row.id === value)?.text,
                )
              }
            />
          </Form.Item>
          <Form.Item name="connectionId" label="Telegram bot" rules={[{ required: true }]}>
            <Select
              loading={channels.isFetching}
              options={(channels.data ?? [])
                .filter((row) => row.type === 'TELEGRAM' && row.status === 'ACTIVE')
                .map((row) => ({ value: row.id, label: row.name }))}
            />
          </Form.Item>
          <Form.Item name="tagId" label="Add a contact tag (optional)">
            <Select
              allowClear
              loading={tags.isFetching}
              options={(tags.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
            />
          </Form.Item>
        </div>
        <Form.Item
          name="text"
          label="Message to the participant"
          rules={[{ required: true, whitespace: true }, { max: 4096 }]}
        >
          <Input.TextArea autoSize={{ minRows: 4, maxRows: 12 }} maxLength={4096} />
        </Form.Item>
        {channels.isError || tags.isError ? (
          <Alert
            type="error"
            showIcon
            title="Scenario resources could not be loaded"
            description={getUserErrorMessage(channels.error ?? tags.error)}
          />
        ) : null}
        <Space wrap>
          <Button type="primary" htmlType="submit" loading={mutations.create.isPending}>
            Create draft in Automation Studio
          </Button>
          <Typography.Text type="secondary">
            Publishing activates the scenario for this session.
          </Typography.Text>
        </Space>
      </Form>
    </div>
  );
}

import { ArrowLeftOutlined } from '@ant-design/icons';
import { Alert, App, Button, Spin, Typography } from 'antd';
import { Link, useParams, useSearchParams } from 'react-router';

import { useMailboxes } from '../email-inbox-api';
import { EmailInboxSettings } from '../email-inbox-settings';
import '../email-inbox.css';

export function EmailSettingsPage() {
  const { projectId } = useParams();
  return projectId ? (
    <App component={false}>
      <EmailSettingsWorkspace key={projectId} projectId={projectId} />
    </App>
  ) : null;
}

function EmailSettingsWorkspace({ projectId }: { projectId: string }) {
  const [params] = useSearchParams();
  const mailboxes = useMailboxes(projectId);
  const inboxParams = new URLSearchParams(params);
  inboxParams.delete('view');
  return (
    <section className="email-workspace">
      <div className="page-heading-row">
        <div>
          <Typography.Title level={2}>Email setup</Typography.Title>
          <Typography.Paragraph type="secondary">
            Manage sending domains, email addresses and receiving health.
          </Typography.Paragraph>
        </div>
        <Link
          to={{ pathname: `/projects/${projectId}/email-inbox`, search: inboxParams.toString() }}
        >
          <Button icon={<ArrowLeftOutlined />}>Back to inbox</Button>
        </Link>
      </div>
      {mailboxes.isLoading ? (
        <Spin aria-label="Loading email setup" />
      ) : mailboxes.isError ? (
        <Alert
          type="error"
          showIcon
          title="Mailboxes could not be loaded"
          action={<Button onClick={() => void mailboxes.refetch()}>Retry</Button>}
        />
      ) : (
        <EmailInboxSettings projectId={projectId} mailboxes={mailboxes.data ?? []} />
      )}
    </section>
  );
}

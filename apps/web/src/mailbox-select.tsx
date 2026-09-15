import { Alert, Select } from 'antd';
import { useMailboxes } from './email-inbox-api';
import { useProjectAccess, hasProjectPermission } from './project-access';

export function MailboxSelect({
  projectId,
  value,
  onChange,
  disabled = false,
  receiving = false,
}: {
  projectId: string | undefined;
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  receiving?: boolean;
}) {
  const access = useProjectAccess(projectId);
  const allowed = hasProjectPermission(access.data, 'email:read');
  const mailboxes = useMailboxes(projectId, allowed);
  if (mailboxes.isError)
    return (
      <Alert
        type="warning"
        title="Sender addresses could not be loaded. Refresh before changing the sender."
      />
    );
  return (
    <Select
      style={{ width: '100%' }}
      value={value ?? ''}
      loading={mailboxes.isLoading && allowed}
      disabled={disabled}
      onChange={(id: string) => onChange(id || null)}
      options={[
        ...(!receiving
          ? [{ value: '', label: 'Project default (legacy sender if no mailbox is configured)' }]
          : []),
        ...(mailboxes.data ?? []).map((mailbox) => ({
          value: mailbox.id,
          label: mailbox.address,
          disabled: receiving ? !mailbox.receivingReady : !mailbox.sendingReady,
        })),
      ]}
      placeholder={receiving ? 'Choose a receiving address' : 'Choose a sender'}
    />
  );
}

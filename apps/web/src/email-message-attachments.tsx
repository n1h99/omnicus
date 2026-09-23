import { EmailAttachmentList } from './email-files';
import { useInboxActions, type MailMessage } from './email-inbox-api';

export function EmailMessageAttachments({
  projectId,
  email,
}: {
  projectId: string;
  email: MailMessage;
}) {
  const actions = useInboxActions(projectId);
  const outgoing =
    email.outgoingAttachments ??
    (email.delivery?.attachmentAssetIds ?? []).map((id, index) => ({
      id,
      filename: `Attachment ${index + 1}`,
      sizeBytes: 0,
      status: 'AVAILABLE',
    }));
  return (
    <EmailAttachmentList
      files={[
        ...email.attachments.map((file) => ({ ...file, path: `attachments/${file.id}` })),
        ...outgoing.map((file) => ({ ...file, path: `messages/${email.id}/assets/${file.id}` })),
      ]}
      load={actions.attachment}
    />
  );
}

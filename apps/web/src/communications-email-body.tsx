import { Segmented, Tooltip } from 'antd';
import { useState } from 'react';

import { EmailHtmlFrame } from './email-html-frame';
import type { MailMessage } from './email-inbox-api';

export function CommunicationsEmailBody({
  email,
}: {
  email: Pick<MailMessage, 'fromAddress' | 'htmlBody' | 'textBody'>;
}) {
  const [mode, setMode] = useState('Formatted');
  const hasHtml = Boolean(email.htmlBody.trim());

  return (
    <div className="communications-email-message-body">
      {hasHtml ? (
        <Tooltip title="External images and links are disabled for safety.">
          <Segmented
            className="communications-email-format-toggle"
            aria-label="Email display format"
            size="small"
            options={['Formatted', 'Plain text']}
            value={mode}
            onChange={setMode}
          />
        </Tooltip>
      ) : null}
      {hasHtml && mode === 'Formatted' ? (
        <EmailHtmlFrame html={email.htmlBody} title={`Email from ${email.fromAddress}`} />
      ) : (
        <p className="communications-email-plain-text">
          {email.textBody || 'No plain-text content.'}
        </p>
      )}
    </div>
  );
}

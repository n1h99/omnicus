import { Alert, Select } from 'antd';
import { useState } from 'react';
import type { CommunicationContact } from '../../communications-api';
import { TelegramChat } from './telegram-chat';

export function TelegramPanel({
  projectId,
  contact,
  active,
  canSend,
  canManage,
}: {
  projectId: string;
  contact: CommunicationContact;
  active: boolean;
  canSend: boolean;
  canManage: boolean;
}) {
  const identities = contact.identities.filter(
    (identity) =>
      identity.channel === 'TELEGRAM' &&
      identity.status === 'ACTIVE' &&
      identity.connection.status === 'ACTIVE',
  );
  const [selected, setSelected] = useState<string>();
  const identity = identities.find((value) => value.id === selected) ?? identities[0];
  if (!active) return null;
  if (!identity)
    return (
      <div className="communications-empty">
        <Alert
          type="info"
          showIcon
          title="Telegram chat is not connected"
          description={
            <>
              {contact.username ? <>Profile: @{contact.username.replace(/^@/, '')}. </> : null}
              The contact needs to start this project's Telegram bot first. A username alone does
              not grant the bot permission to send messages.
            </>
          }
        />
      </div>
    );
  return (
    <div className="communications-telegram-panel">
      {identities.length > 1 ? (
        <Select
          aria-label="Telegram bot conversation"
          value={identity.id}
          onChange={setSelected}
          options={identities.map((value) => ({
            value: value.id,
            label: `${value.connection.name} · ${value.username ? `@${value.username}` : value.externalUserId}`,
          }))}
        />
      ) : null}
      <div className="communications-telegram-content">
        <TelegramChat
          key={`${projectId}:${contact.id}:${identity.id}`}
          projectId={projectId}
          identityId={identity.id}
          canSend={canSend}
          canManage={canManage}
          open={active}
          leadId={contact.id}
          clientName={contact.displayName}
          initialChannel="telegram"
          onClose={() => undefined}
        />
      </div>
    </div>
  );
}

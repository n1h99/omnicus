import type { ReactElement } from 'react';

/** Typed boundary around the ported CRM JSX renderer. The host application stays strict. */
export interface TelegramChatProps {
  projectId: string;
  identityId: string;
  canSend: boolean;
  canManage: boolean;
  open: boolean;
  leadId: string;
  clientName: string;
  initialChannel?: 'telegram';
  onClose: () => void;
}

export declare function TelegramChat(props: TelegramChatProps): ReactElement;

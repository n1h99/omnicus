import { describe, expect, it, vi } from 'vitest';
import { AutomationRuntimeService } from '../automation/automation-runtime.service';

function fixture() {
  const conversation = {
    id: 'private-chat',
    contactId: 'contact',
    status: 'ACTIVE',
    automationModeOverride: null as string | null,
  };
  const tx = {
    channelConnection: {
      findUnique: vi.fn(async () => ({ id: 'bot', type: 'TELEGRAM', status: 'ACTIVE' })),
    },
    channelIdentity: { findFirst: vi.fn(async () => ({ id: 'identity', externalUserId: '123' })) },
    conversation: { findUnique: vi.fn(async () => conversation as typeof conversation | null) },
    scenarioExecution: { updateMany: vi.fn() },
    message: {
      create: vi.fn(async ({ data }: { data: { conversationId: string } }) => {
        if (data.conversationId !== 'private-chat')
          throw new Error('conversation foreign key missing');
        return { id: 'message' };
      }),
    },
    outboxRecord: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'outbox' })),
    },
  };
  const service = new AutomationRuntimeService({} as never) as unknown as {
    applyNode(
      tx: unknown,
      node: unknown,
      edges: unknown[],
      context: unknown,
      execution: string,
    ): Promise<unknown>;
  };
  const context = {
    projectId: 'project',
    contactId: 'contact',
    connectionId: '',
    conversationId: '',
    normalizedEventId: '',
    contactVariables: {},
    customFields: {},
    variables: {},
    subflowDepth: 0,
    eventPayload: {
      type: 'WEBINAR_REGISTERED',
      webinar: { title: 'Test' },
      invitation: { participantUrl: 'https://api.example.test/public/webinar-invitations/opaque' },
    },
  };
  const node = {
    id: 'send',
    type: 'SEND_MESSAGE',
    config: {
      deliveryTarget: 'TELEGRAM',
      telegramConnectionId: 'bot',
      text: 'Invitation: {{event.invitation.participantUrl}}',
    },
  };
  const run = () => service.applyNode(tx, node, [], context, 'execution');
  return { tx, context, conversation, run };
}
describe('Explicit Telegram delivery from webinar events', () => {
  it('resolves the private conversation when the trigger has no inbound chat and preserves its event variables', async () => {
    const f = fixture();
    await f.run();
    expect(f.tx.conversation.findUnique).toHaveBeenCalledWith({
      where: {
        projectId_connectionId_externalChatId: {
          projectId: 'project',
          connectionId: 'bot',
          externalChatId: '123',
        },
      },
    });
    expect(f.tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conversationId: 'private-chat',
        connectionId: 'bot',
        contactId: 'contact',
        content: { text: 'Invitation: https://api.example.test/public/webinar-invitations/opaque' },
      }),
    });
    expect(f.tx.scenarioExecution.updateMany).toHaveBeenCalledWith({
      where: { id: 'execution', projectId: 'project' },
      data: { conversationId: 'private-chat' },
    });
    expect(f.context.conversationId).toBe('private-chat');
    expect(f.tx.outboxRecord.create).toHaveBeenCalledTimes(1);
  });
  it('uses the selected bot route even when the trigger originates in another conversation', async () => {
    const f = fixture();
    f.context.connectionId = 'other-bot';
    f.context.conversationId = 'other-chat';
    await f.run();
    expect(f.tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ conversationId: 'private-chat', connectionId: 'bot' }),
    });
  });
  it.each(['missing', 'another-contact', 'disabled', 'closed'])(
    'does not queue a delivery for a %s private conversation',
    async (state) => {
      const f = fixture();
      if (state === 'missing') f.tx.conversation.findUnique.mockResolvedValue(null);
      if (state === 'another-contact') f.conversation.contactId = 'another';
      if (state === 'disabled') f.conversation.automationModeOverride = 'DISABLED';
      if (state === 'closed') f.conversation.status = 'CLOSED';
      await expect(f.run()).rejects.toThrow(
        state === 'disabled'
          ? 'automation_conversation_disabled'
          : 'automation_channel_conversation_unavailable',
      );
      expect(f.tx.message.create).not.toHaveBeenCalled();
      expect(f.tx.outboxRecord.create).not.toHaveBeenCalled();
    },
  );
});

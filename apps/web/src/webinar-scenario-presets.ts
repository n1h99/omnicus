import type { ScenarioGraph } from './automation-api';

export const webinarScenarioPresets = [
  {
    id: 'registration',
    label: 'Registration invitation',
    event: 'WEBINAR_REGISTERED',
    text: 'Вы зарегистрированы на «{{event.webinar.title}}».\n\nВаша персональная ссылка:\n{{event.invitation.participantUrl}}',
  },
  {
    id: 'reminder',
    label: 'Scheduled reminder',
    event: 'WEBINAR_REMINDER',
    text: 'Скоро начнётся вебинар «{{event.webinar.title}}».\n\nВойти:\n{{event.invitation.participantUrl}}',
  },
  {
    id: 'attended',
    label: 'Thank attendees',
    event: 'WEBINAR_ATTENDED',
    text: 'Спасибо за участие в вебинаре «{{event.webinar.title}}»! Если остались вопросы, ответьте на это сообщение.',
  },
  {
    id: 'missed',
    label: 'Follow up with absent registrants',
    event: 'WEBINAR_MISSED',
    text: 'Вы регистрировались на вебинар «{{event.webinar.title}}», но не смогли присоединиться. Ответьте на это сообщение — поможем узнать о следующей встрече.',
  },
  {
    id: 'cta',
    label: 'Follow up after a CTA click',
    event: 'WEBINAR_CTA_CLICKED',
    text: 'Спасибо за интерес к предложению на вебинаре «{{event.webinar.title}}»! Ответьте на это сообщение, чтобы задать вопрос.',
  },
] as const;

export function webinarScenarioGraph(input: {
  eventId: string;
  eventType: string;
  connectionId: string;
  text: string;
  tagId?: string;
}): ScenarioGraph {
  const nodes: ScenarioGraph['nodes'] = [
    {
      id: 'incoming',
      type: 'INCOMING_MESSAGE',
      position: { x: 0, y: 0 },
      config: {
        triggerType: 'WEBINAR_EVENT',
        webinarEventType: input.eventType,
        webinarEventId: input.eventId,
      },
    },
  ];
  if (input.tagId)
    nodes.push({
      id: 'tag',
      type: 'ADD_TAG',
      position: { x: 0, y: 180 },
      config: { tagId: input.tagId },
    });
  nodes.push(
    {
      id: 'message',
      type: 'SEND_MESSAGE',
      position: { x: 0, y: 360 },
      config: {
        text: input.text,
        deliveryTarget: 'TELEGRAM',
        telegramConnectionId: input.connectionId,
      },
    },
    { id: 'stop', type: 'STOP', position: { x: 0, y: 540 }, config: {} },
  );
  return {
    nodes,
    edges: nodes
      .slice(0, -1)
      .map((node, index) => ({ from: node.id, to: nodes[index + 1]!.id, output: 'default' })),
  };
}

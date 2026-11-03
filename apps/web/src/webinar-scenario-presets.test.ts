import { describe, expect, it } from 'vitest';
import { validateScenarioGraph } from '@omnicus/automation-core';
import { webinarScenarioGraph, webinarScenarioPresets } from './webinar-scenario-presets';

describe('Customer webinar scenario presets', () => {
  it.each(webinarScenarioPresets)(
    'creates a valid session-specific $label draft without diagnostic metrics or CRM writes',
    (preset) => {
      const graph = webinarScenarioGraph({
        eventId: 'session-a',
        eventType: preset.event,
        connectionId: 'bot-a',
        text: preset.text,
      });
      expect(validateScenarioGraph(graph).errors).toEqual([]);
      expect(graph.nodes[0]?.config).toMatchObject({
        triggerType: 'WEBINAR_EVENT',
        webinarEventId: 'session-a',
        webinarEventType: preset.event,
      });
      const serialized = JSON.stringify(graph);
      expect(serialized).not.toMatch(
        /WEBINAR_REPORT_RECEIVED|watchedPercentage|commentsCount|WEBINAR_CRM_ACTION/,
      );
      expect(graph.nodes.find((node) => node.type === 'SEND_MESSAGE')?.config).toMatchObject({
        deliveryTarget: 'TELEGRAM',
        telegramConnectionId: 'bot-a',
      });
    },
  );
  it('tags a contact before the follow-up when a tag is selected', () => {
    const graph = webinarScenarioGraph({
      eventId: 'session-a',
      eventType: 'WEBINAR_CTA_CLICKED',
      connectionId: 'bot-a',
      text: 'Thank you',
      tagId: 'tag-hot',
    });
    expect(validateScenarioGraph(graph).errors).toEqual([]);
    expect(graph.edges).toEqual([
      { from: 'incoming', to: 'tag', output: 'default' },
      { from: 'tag', to: 'message', output: 'default' },
      { from: 'message', to: 'stop', output: 'default' },
    ]);
  });
});

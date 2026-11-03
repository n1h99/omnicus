import { describe, expect, it } from 'vitest';
import {
  defaultWebinarSettings,
  fingerprint,
  groupVisits,
  localToUtc,
  normalizeAttendance,
  participantDestination,
  watchedSeconds,
  type ProviderVisit,
  type ProviderReport,
} from './index';
const visit = (input: Partial<ProviderVisit> = {}): ProviderVisit => ({
  rowKey: '0',
  visitorId: '-7',
  name: 'Test viewer',
  email: 'viewer@example.test',
  phone: null,
  joinedAtLocal: '2026-11-03 10:00:00',
  leftAtLocal: '2026-11-03 10:10:00',
  device: null,
  country: null,
  city: null,
  utm: null,
  comments: [],
  actions: [],
  ...input,
});
const interval = {
  timezone: 'Asia/Baku',
  scheduledAt: new Date('2026-11-03T06:00:00Z'),
  endsAt: new Date('2026-11-03T06:15:00Z'),
};
describe('webinar normalization and opaque links', () => {
  it('interprets an explicit timezone and rejects invalid or ambiguous local dates', () => {
    expect(localToUtc('2026-11-03 10:00:00', 'Asia/Baku')).toBe(Date.parse('2026-11-03T06:00:00Z'));
    expect(localToUtc('2026-02-30 10:00:00', 'Asia/Baku')).toBeNull();
    expect(localToUtc('2026-11-01 01:30:00', 'America/New_York')).toBeNull();
    expect(localToUtc('2026-03-08 02:30:00', 'America/New_York')).toBeNull();
    expect(localToUtc('2026-11-03 10:00:00', 'invalid/zone')).toBeNull();
  });
  it('unions overlapping visits rather than double-counting watched time', () => {
    const visits = [
      visit(),
      visit({
        rowKey: '1',
        joinedAtLocal: '2026-11-03 10:05:00',
        leftAtLocal: '2026-11-03 10:15:00',
      }),
    ];
    expect(watchedSeconds(visits, interval.timezone, interval.scheduledAt, interval.endsAt)).toBe(
      900,
    );
    expect(normalizeAttendance(visits, defaultWebinarSettings, interval)).toMatchObject({
      watchedMinutes: 15,
      watchedPercentage: 100,
      completed: true,
      status: 'COMPLETED',
    });
  });
  it('keeps absent evidence unknown', () => {
    expect(
      normalizeAttendance([visit({ leftAtLocal: null })], defaultWebinarSettings, interval),
    ).toMatchObject({
      attended: true,
      watchedMinutes: null,
      completed: null,
      ctaClicked: null,
      isReplay: null,
    });
  });
  it('does not change normalized results when report rows are reordered', () => {
    const visits = [
      visit({ rowKey: '1', comments: [{ atLocal: null, text: 'Second' }] }),
      visit({ rowKey: '0', comments: [{ atLocal: null, text: 'First' }] }),
    ];
    expect(fingerprint(normalizeAttendance(visits, defaultWebinarSettings, interval))).toBe(
      fingerprint(normalizeAttendance([...visits].reverse(), defaultWebinarSettings, interval)),
    );
  });
  it('groups repeated visitors even when one visit omits email and tracking', () => {
    const report = {
      participants: [
        visit({ email: null }),
        visit({ rowKey: '1', utm: 'cv=opaque' }),
        visit({ rowKey: '2', utm: 'cv=opaque' }),
      ],
    } as ProviderReport;
    const groups = groupVisits(report, { ...defaultWebinarSettings, trackingParameter: 'cv' });
    expect(groups.size).toBe(1);
    expect([...groups.values()][0]).toHaveLength(2);
    expect(
      normalizeAttendance([...groups.values()][0]!, {
        ...defaultWebinarSettings,
        trackingParameter: 'cv',
      }).trackingToken,
    ).toBe('opaque');
  });
  it('only classifies clicks with an explicit verified mapping', () => {
    const visits = [
      visit({
        actions: [{ type: 'button_1', status: 'provider-click', label: 'Click', showNumber: 1 }],
      }),
    ];
    expect(normalizeAttendance(visits, defaultWebinarSettings).ctaClicked).toBeNull();
    expect(
      normalizeAttendance(visits, { ...defaultWebinarSettings, clickStatuses: ['provider-click'] })
        .ctaClicked,
    ).toBe(true);
  });
  it('builds only explicitly configured provider query parameters on the fixed host', () => {
    const url = new URL(
      participantDestination(
        'https://efir.webinar-stars.com/webinar/abc/',
        {
          ...defaultWebinarSettings,
          parameters: { cv: 'trackingToken', visitor: 'name' },
          constants: { enter: '1' },
        },
        { trackingToken: 'random-opaque', name: 'A & B' },
        { utm_source: 'test' },
      ),
    );
    expect(url.searchParams.get('visitor')).toBe('A & B');
    expect(url.searchParams.get('cv')).toBe('random-opaque');
    expect(url.searchParams.get('email')).toBeNull();
    expect(() =>
      participantDestination('https://evil.example/webinar/abc', defaultWebinarSettings, {}, {}),
    ).toThrow();
  });
  it('keeps unknown button statuses and absent CTA evidence distinct from a confirmed non-click', () => {
    const config = {
      ...defaultWebinarSettings,
      clickStatuses: ['clicked'],
      seenStatuses: ['seen'],
    };
    const normalize = (type: string, status: string) =>
      normalizeAttendance(
        [visit({ actions: [{ type, status, label: null, showNumber: 1 }] })],
        config,
      );
    expect(normalize('button_1', 'unrecognized').ctaClicked).toBeNull();
    expect(normalize('button_1', 'seen').ctaClicked).toBe(false);
    expect(normalize('banner', 'clicked')).toMatchObject({
      bannerClicked: true,
      ctaClicked: null,
      ctaViewed: null,
    });
  });
});

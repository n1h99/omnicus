import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AccessService } from '../src/access/access.service';
import { AuditService } from '../src/audit/audit.service';
import { WebinarStarsController } from '../src/webinar-stars/webinar-stars.controller';
import { WebinarStarsService } from '../src/webinar-stars/webinar-stars.service';
import {
  WebinarLifecycleController,
  WebinarPublicController,
} from '../src/webinar-stars/webinar-lifecycle.controller';
import { WebinarLifecycleService } from '../src/webinar-stars/webinar-lifecycle.service';
import { LeadCaptureService } from '../src/automation/lead-capture.service';
import { configureApiApplication } from '../src/platform/configure-api-application';

describe('Webinar Stars HTTP boundary', () => {
  let app: INestApplication;
  let token: string;
  const service = {
    config: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockResolvedValue({ id: 'connection', revision: 1 }),
    test: jest.fn().mockResolvedValue({ ok: true }),
    disconnect: jest.fn().mockResolvedValue({ disconnected: true }),
    webinars: jest.fn().mockResolvedValue({ items: [], hasMore: false }),
    reports: jest.fn().mockResolvedValue({ items: [], hasMore: false }),
    report: jest.fn().mockResolvedValue({ participants: [] }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const lifecycle = {
    receive: jest.fn().mockResolvedValue({ ok: true }),
    createParticipantContact: jest.fn(),
  };
  const access = {
    isSessionActive: jest.fn().mockResolvedValue(true),
    getGlobalAccess: jest.fn().mockResolvedValue({ permissions: [], roleNames: [] }),
    hasProjectPermission: jest.fn(
      async (_user: string, project: string, permission: string) =>
        project === 'a' && permission === 'integrations:manage',
    ),
  };
  const paths = [
    ['get', ''],
    ['put', ''],
    ['delete', ''],
    ['post', '/test'],
    ['get', '/webinars'],
    ['get', '/reports'],
    ['get', '/reports/123'],
    ['put', '/processing'],
    ['post', '/webhook/rotate'],
    ['get', '/events'],
    ['post', '/events'],
    ['post', '/events/session/cancel'],
    ['put', '/events/session/settings'],
    ['get', '/events/session/registration-config'],
    ['post', '/events/session/invitations'],
    ['get', '/events/session/invitations'],
    ['post', '/imports'],
    ['get', '/imports'],
    ['post', '/imports/report/retry'],
    ['get', '/participants'],
    ['post', '/participants/participant/match'],
    ['post', '/participants/participant/contact'],
    ['get', '/actions'],
    ['post', '/actions/action/retry'],
    ['get', '/contact-options'],
  ] as const;
  beforeAll(async () => {
    const secret = 'synthetic-jwt-secret-for-webinar-tests';
    const module = await Test.createTestingModule({
      imports: [JwtModule.register({ secret })],
      controllers: [WebinarStarsController, WebinarLifecycleController, WebinarPublicController],
      providers: [
        { provide: WebinarStarsService, useValue: service },
        { provide: WebinarLifecycleService, useValue: lifecycle },
        { provide: LeadCaptureService, useValue: {} },
        { provide: AuditService, useValue: audit },
        { provide: AccessService, useValue: access },
        { provide: ConfigService, useValue: new ConfigService({ JWT_ACCESS_SECRET: secret }) },
      ],
    }).compile();
    app = module.createNestApplication();
    configureApiApplication(app, { swaggerEnabled: false });
    await app.init();
    token = module
      .get(JwtService)
      .sign({ sub: 'manager', sid: 'session', email: 'manager@example.test' });
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => jest.clearAllMocks());

  it('accepts JSON and nested form webhook bodies at the authenticated domain boundary', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/webinar-stars/a/test-secret')
      .send({ action: 'webinar_end', data: { id: '12' } })
      .expect(200);
    expect(lifecycle.receive).toHaveBeenLastCalledWith('a', 'test-secret', {
      action: 'webinar_end',
      data: { id: '12' },
    });
    await request(app.getHttpServer())
      .post('/webhooks/webinar-stars/a/test-secret')
      .type('form')
      .send('action=webinar_end&data%5Bid%5D=12')
      .expect(200);
    expect(lifecycle.receive).toHaveBeenLastCalledWith('a', 'test-secret', {
      action: 'webinar_end',
      data: { id: '12' },
    });
  });
  it('requires contact creation permission in addition to integration management', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/projects/a/webinar-stars/participants/participant/contact')
      .set('Authorization', `Bearer ${token}`)
      .send({ displayName: 'Test viewer' })
      .expect(403);
    expect(lifecycle.createParticipantContact).not.toHaveBeenCalled();
  });

  it('requires authentication for every connection and report endpoint', async () => {
    for (const [method, suffix] of paths)
      await request(app.getHttpServer())
        [method](`/api/v1/projects/a/webinar-stars${suffix}`)
        .expect(401);
    expect(service.config).not.toHaveBeenCalled();
  });
  it('requires the selected project permission even with a valid session', async () => {
    for (const [method, suffix] of paths)
      await request(app.getHttpServer())
        [method](`/api/v1/projects/b/webinar-stars${suffix}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    expect(service.save).not.toHaveBeenCalled();
    expect(service.report).not.toHaveBeenCalled();
  });
  it('validates pagination and rejects unknown credential properties', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/projects/a/webinar-stars/webinars?limit=101')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    await request(app.getHttpServer())
      .put('/api/v1/projects/a/webinar-stars')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: 'synthetic-token', baseUrl: 'https://untrusted.test' })
      .expect(400);
    expect(service.webinars).not.toHaveBeenCalled();
    expect(service.save).not.toHaveBeenCalled();
  });
  it('audits connection changes without including the token', async () => {
    const response = await request(app.getHttpServer())
      .put('/api/v1/projects/a/webinar-stars')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: 'synthetic-token' })
      .expect(200);
    expect(service.save).toHaveBeenCalledWith('a', { token: 'synthetic-token' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'a',
        action: 'webinar-stars.connection.save',
        actorUserId: 'manager',
      }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('synthetic-token');
    expect(JSON.stringify(response.body)).not.toContain('synthetic-token');
  });
  it('passes transformed query parameters to the project-scoped adapter service', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/projects/a/webinar-stars/reports?limit=10&offset=20&from=2026-11-01')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(service.reports).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ limit: 10, offset: 20, from: '2026-11-01' }),
    );
  });
});

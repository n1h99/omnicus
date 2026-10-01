import 'reflect-metadata';
import {
  UnauthorizedException,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  MetaLeadsController,
  MetaLeadsWebhookController,
} from '../src/meta-leads/meta-leads.controller';
import { MetaLeadsService } from '../src/meta-leads/meta-leads.service';
import { AuditService } from '../src/audit/audit.service';
import { AccessService } from '../src/access/access.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '../src/auth/auth.types';
import { configureApiApplication } from '../src/platform/configure-api-application';

describe('Meta lead routes and authorization (isolated HTTP)', () => {
  let app: INestApplication;
  const service = {
    safeConfig: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockResolvedValue({ enabled: false }),
    start: jest.fn().mockResolvedValue({ enabled: true, deliveryEnabled: false }),
    receive: jest.fn().mockResolvedValue({ ok: true }),
    verify: jest.fn().mockResolvedValue('123'),
  };
  const access = { hasProjectPermission: jest.fn().mockResolvedValue(true) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MetaLeadsController, MetaLeadsWebhookController],
      providers: [
        { provide: MetaLeadsService, useValue: service },
        { provide: AccessService, useValue: access },
        { provide: AuditService, useValue: audit },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
          if (req.headers.authorization !== 'Bearer isolated-test-token')
            throw new UnauthorizedException();
          req.auth = {
            userId: 'tester',
            email: 'test@example.org',
            globalPermissions: [],
            globalRoleNames: [],
          };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication({ rawBody: true });
    configureApiApplication(app, { swaggerEnabled: false });
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    access.hasProjectPermission.mockResolvedValue(true);
  });
  const path = '/api/v1/projects/project/meta-leads';

  it('requires authentication for configuration', async () => {
    await request(app.getHttpServer()).get(path).expect(401);
    expect(service.safeConfig).not.toHaveBeenCalled();
  });
  it('requires integration-management permission in the requested project', async () => {
    access.hasProjectPermission.mockResolvedValue(false);
    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', 'Bearer isolated-test-token')
      .expect(403);
    expect(access.hasProjectPermission).toHaveBeenCalledWith(
      'tester',
      'project',
      'integrations:manage',
    );
    expect(service.safeConfig).not.toHaveBeenCalled();
  });
  it('validates concrete DTOs, not erased type-only metadata', async () => {
    await request(app.getHttpServer())
      .put(path)
      .set('Authorization', 'Bearer isolated-test-token')
      .send({ pageId: '../../me', formIds: ['1'], pageToken: 'secret' })
      .expect(400);
    await request(app.getHttpServer())
      .post(`${path}/start`)
      .set('Authorization', 'Bearer isolated-test-token')
      .send({ liveFrom: 'not-a-date', deliveryEnabled: 'false' })
      .expect(400);
    expect(service.save).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
  });
  it('saves valid secrets without including them in audit records or responses', async () => {
    const secret = 'test-secret-that-is-not-a-real-credential';
    const response = await request(app.getHttpServer())
      .put(path)
      .set('Authorization', 'Bearer isolated-test-token')
      .send({
        pageId: '333',
        formIds: ['222'],
        graphVersion: 'v26.0',
        pageToken: secret,
        appSecret: secret,
        verifyToken: secret,
      })
      .expect(200);
    expect(service.save).toHaveBeenCalledWith(
      'project',
      expect.objectContaining({ pageToken: secret }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(response.body)).not.toContain(secret);
  });
  it('keeps the webhook public and passes original bytes/signature to the verifier', async () => {
    const body = { object: 'page', entry: [] };
    await request(app.getHttpServer())
      .post('/webhooks/meta-leads/project')
      .set('X-Hub-Signature-256', 'sha256=test')
      .send(body)
      .expect(200, { ok: true });
    expect(service.receive).toHaveBeenCalledWith(
      'project',
      Buffer.from(JSON.stringify(body)),
      'sha256=test',
      body,
    );
    expect(access.hasProjectPermission).not.toHaveBeenCalled();
  });
  it('returns the webhook challenge as plain text', async () => {
    await request(app.getHttpServer())
      .get(
        '/webhooks/meta-leads/project?hub.mode=subscribe&hub.verify_token=test&hub.challenge=123',
      )
      .expect(200, '123');
    expect(service.verify).toHaveBeenCalledWith('project', 'subscribe', 'test', '123');
  });
});

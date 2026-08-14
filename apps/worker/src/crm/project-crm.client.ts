import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelSecretsService, type EncryptedSecretEnvelope } from '@omnicus/channel-secrets';
import type { WorkerEnvironment } from '@omnicus/config/server';
import {
  CrmClientError,
  HttpCrmClient,
  type CrmCallContext,
  type CrmClient,
  type CrmReconciliationResult,
  type CrmResult,
  type CreateOrUpdateLeadInput,
  type MergeContactsInput,
  type ForwardInboundMessageInput,
  type ForwardOutboundMessageInput,
  type ForwardReactionEventInput,
  type ForwardMessageEditInput,
  type ForwardContactShareInput,
  type ForwardAutomationStateInput,
  type ForwardMessageStatusInput,
  type ForwardTrackedLinkClickInput,
  type ForwardEmailEventInput,
} from '@omnicus/crm-core';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class ProjectCrmClient implements CrmClient {
  private readonly secrets: ChannelSecretsService;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<WorkerEnvironment, true>,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {
    this.secrets = new ChannelSecretsService(
      this.config.get('CHANNEL_SECRETS_KEY', { infer: true }),
    );
  }

  async createOrUpdateLead(
    context: CrmCallContext,
    input: CreateOrUpdateLeadInput,
  ): Promise<CrmResult> {
    return (await this.resolve(context)).createOrUpdateLead(context, input);
  }

  async mergeContacts(context: CrmCallContext, input: MergeContactsInput): Promise<CrmResult> {
    return (await this.resolve(context)).mergeContacts(context, input);
  }

  async forwardInboundMessage(
    context: CrmCallContext,
    input: ForwardInboundMessageInput,
  ): Promise<CrmResult> {
    return (await this.resolve(context)).forwardInboundMessage(context, input);
  }

  async forwardOutboundMessage(
    context: CrmCallContext,
    input: ForwardOutboundMessageInput,
  ): Promise<CrmResult> {
    return (await this.resolve(context)).forwardOutboundMessage(context, input);
  }

  async forwardReactionEvent(
    context: CrmCallContext,
    input: ForwardReactionEventInput,
  ): Promise<CrmResult> {
    return (await this.resolve(context)).forwardReactionEvent(context, input);
  }

  async forwardMessageEdit(
    context: CrmCallContext,
    input: ForwardMessageEditInput,
  ): Promise<CrmResult> {
    const client = await this.resolve(context);
    if (!client.forwardMessageEdit)
      throw new CrmClientError('PERMANENT_FAILURE', 'crm_message_edit_unsupported');
    return client.forwardMessageEdit(context, input);
  }

  async forwardContactShare(
    context: CrmCallContext,
    input: ForwardContactShareInput,
  ): Promise<CrmResult> {
    const client = await this.resolve(context);
    if (!client.forwardContactShare)
      throw new CrmClientError('PERMANENT_FAILURE', 'crm_contact_share_unsupported');
    return client.forwardContactShare(context, input);
  }

  async forwardAutomationState(
    context: CrmCallContext,
    input: ForwardAutomationStateInput,
  ): Promise<CrmResult> {
    const client = await this.resolve(context);
    if (!client.forwardAutomationState)
      throw new CrmClientError('PERMANENT_FAILURE', 'crm_automation_state_unsupported');
    return client.forwardAutomationState(context, input);
  }

  async forwardMessageStatus(
    context: CrmCallContext,
    input: ForwardMessageStatusInput,
  ): Promise<CrmResult> {
    const client = await this.resolve(context);
    if (!client.forwardMessageStatus)
      throw new CrmClientError('PERMANENT_FAILURE', 'crm_message_status_unsupported');
    return client.forwardMessageStatus(context, input);
  }

  async forwardEmailEvent(
    context: CrmCallContext,
    input: ForwardEmailEventInput,
  ): Promise<CrmResult> {
    const client = await this.resolve(context);
    if (!client.forwardEmailEvent)
      throw new CrmClientError('PERMANENT_FAILURE', 'crm_email_event_unsupported');
    return client.forwardEmailEvent(context, input);
  }

  async forwardTrackedLinkClick(
    context: CrmCallContext,
    input: ForwardTrackedLinkClickInput,
  ): Promise<CrmResult> {
    const client = await this.resolve(context);
    if (!client.forwardTrackedLinkClick)
      throw new CrmClientError('PERMANENT_FAILURE', 'crm_tracked_link_unsupported');
    return client.forwardTrackedLinkClick(context, input);
  }

  async reconcile(context: CrmCallContext): Promise<CrmReconciliationResult> {
    return (await this.resolve(context)).reconcile(context);
  }

  private async resolve(context: CrmCallContext): Promise<CrmClient> {
    const connection = await this.database.client.crmProjectConfig.findUnique({
      where: { projectId: context.projectId },
    });
    if (
      connection?.enabled &&
      connection.status === 'ACTIVE' &&
      connection.baseUrl &&
      connection.credentialsEncrypted
    ) {
      let authToken: string;
      try {
        authToken = this.secrets.decryptSecret({
          channelConnectionId: connection.id,
          channelType: 'crm',
          envelope: connection.credentialsEncrypted as unknown as EncryptedSecretEnvelope,
          field: 'authToken',
          projectId: connection.projectId,
        });
      } catch {
        throw new CrmClientError('PERMANENT_FAILURE', 'crm_credential_unavailable');
      }
      return new HttpCrmClient({
        authToken,
        baseUrl: connection.baseUrl,
        timeoutMs: this.config.get('CRM_REQUEST_TIMEOUT_MS', { infer: true }),
      });
    }

    const baseUrl = this.config.get('CRM_BASE_URL', { infer: true });
    const authToken = this.config.get('CRM_AUTH_TOKEN', { infer: true });
    if (
      this.config.get('CRM_INTEGRATION_ENABLED', { infer: true }) &&
      connection?.enabled &&
      baseUrl &&
      authToken
    )
      return new HttpCrmClient({
        authToken,
        baseUrl,
        timeoutMs: this.config.get('CRM_REQUEST_TIMEOUT_MS', { infer: true }),
      });
    throw new CrmClientError('PERMANENT_FAILURE', 'crm_connection_not_paired');
  }
}

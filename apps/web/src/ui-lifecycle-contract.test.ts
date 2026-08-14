import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('workspace lifecycle UI contracts', () => {
  it('keeps login validation while hiding required marks', () => {
    const login = source('./pages/login-page.tsx');
    expect(login).toContain('requiredMark={false}');
    expect(login).toContain("rules={[{ required: true, type: 'email' }]}");
    expect(login).toContain('rules={[{ required: true }]}');
  });

  it('locks canvas zoom together with editor interactivity', () => {
    const editor = source('./pages/scenario-editor-page.tsx');
    expect(editor).toContain('zoomOnScroll={isCanvasInteractive}');
    expect(editor).toContain('zoomOnPinch={isCanvasInteractive}');
    expect(editor).toContain('showZoom={isCanvasInteractive}');
  });

  it('saves automation drafts only after an explicit Save draft action', () => {
    const editor = source('./pages/scenario-editor-page.tsx');
    expect(editor).toContain('onFinish={save}');
    expect(editor).toContain('Unsaved changes');
    expect(editor).toContain('setManualSavePending(true)');
    expect(editor).not.toContain('updateDraftRef');
    expect(editor).not.toContain('Autosave stopped');
    expect(editor).not.toContain('}, 1_500)');
  });

  it('keeps Automation Studio discovery, locking and diagnostics operator-friendly', () => {
    const editor = source('./pages/scenario-editor-page.tsx');
    const testPanel = source('./automation-test-panel.tsx');
    expect(editor).toContain('const hydratedGraph = flowToScenarioGraph');
    expect(editor).toContain('placeholder="Find a step"');
    expect(editor).toContain('disabled={!isCanvasInteractive || !historyPast.length}');
    expect(editor).toContain(
      "deleteKeyCode={isCanvasInteractive ? ['Backspace', 'Delete'] : null}",
    );
    expect(editor).toContain('candidate.id !== scenarioId');
    expect(editor).toContain('<AutomationGraphPreview compact graph={version.graph} />');
    expect(editor).toContain('Channel delivery');
    expect(testPanel).toContain("nodeTypes.includes('WAIT_FOR_REPLY')");
    expect(testPanel).toContain("nodeTypes.includes('EXTERNAL_HTTP_REQUEST')");
    expect(testPanel).toContain('Fix the graph before testing');
  });

  it('uses an in-app template archive dialog and a deferred media selection', () => {
    const templates = source('./pages/templates-page.tsx');
    const media = source('./pages/media-assets-page.tsx');
    expect(templates).not.toContain('Modal.confirm');
    expect(templates).toContain('Archive template');
    expect(media).toContain('showUploadList={false}');
    expect(media).toContain('Remove selected file');
  });

  it('provides discoverable archive and restore views', () => {
    const fields = source('./pages/custom-fields-page.tsx');
    const templates = source('./pages/templates-page.tsx');
    const broadcasts = source('./pages/broadcasts-page.tsx');
    expect(templates).toContain("label: 'Archived'");
    expect(templates).toContain('Restore');
    expect(broadcasts).toContain("label: 'Archived'");
    expect(broadcasts).toContain('Restore');
    expect(fields).toContain('archive-state-table');
    expect(templates).toContain('archive-state-table');
    expect(broadcasts).toContain('archive-state-table');
    expect(fields).toContain('tableLayout="fixed"');
    expect(templates).toContain('tableLayout="fixed"');
    expect(broadcasts).toContain('tableLayout="fixed"');
  });

  it('keeps archive switches stable while the next view loads', () => {
    const broadcastsApi = source('./broadcasts-api.ts');
    const templatesApi = source('./templates-api.ts');
    const broadcasts = source('./pages/broadcasts-page.tsx');
    const templates = source('./pages/templates-page.tsx');
    const fields = source('./pages/custom-fields-page.tsx');
    const contacts = source('./pages/contacts-page.tsx');

    expect(broadcastsApi).toContain('placeholderData:');
    expect(templatesApi).toContain('placeholderData:');
    expect(broadcasts).toContain('query.isPlaceholderData ? null');
    expect(broadcasts).toContain("query.isPlaceholderData ? '' : 'clickable-row'");
    expect(broadcasts).toContain('aria-busy={query.isPlaceholderData}');
    expect(templates).toContain('templates.isPlaceholderData ? null');
    expect(fields).toContain('fields.isPlaceholderData ? null');
    expect(contacts).toContain('contacts.isPlaceholderData');
  });

  it('removes campaign labels and keeps stable scenario action widths', () => {
    const broadcasts = source('./pages/broadcasts-page.tsx');
    const scenarios = source('./pages/scenarios-page.tsx');
    expect(broadcasts.toLowerCase()).not.toContain('campaign');
    expect(scenarios).toContain('scenario-state-action');
    expect(scenarios).toContain('width: 250');
  });

  it('uses fully clickable project rows and removes page kickers', () => {
    const projects = source('./pages/projects-page.tsx');
    const shell = source('./app-shell.tsx');
    expect(projects).toContain('onRow={(project) =>');
    expect(projects).toContain('rowClassName="clickable-row"');
    expect(projects).toContain("role: 'link'");
    expect(projects).not.toContain('header-kicker');
    expect(shell).not.toContain('header-kicker');
  });

  it('keeps the account header compact and archive switches consistent', () => {
    const styles = source('./styles.css');
    const theme = source('./main.tsx');
    expect(styles).toMatch(/\.app-header\s*\{[^}]*line-height: normal;/s);
    expect(styles).toMatch(/\.account-identity-chip\s*\{[^}]*height: 38px;/s);
    expect(styles).toMatch(/\.account-identity-chip\s*\{[^}]*line-height: normal;/s);
    expect(styles).toContain('padding: 5px');
    expect(styles).toContain('border-radius: 18px');
    expect(styles).toContain('background: rgba(15, 118, 110, 0.1)');
    expect(theme).toContain('Segmented: {');
    expect(theme).toContain("itemSelectedColor: '#0f766e'");
  });

  it('uses a full-width connection overview and stacked channel controls', () => {
    const channel = source('./pages/channel-detail-page.tsx');
    const channelApi = source('./channels-api.ts');
    const provider = source('./channel-provider.ts');
    const styles = source('./styles.css');
    expect(channel).toContain('className="channel-overview-card"');
    expect(channel).toContain('className="channel-management-grid"');
    expect(channel).toContain('className="channel-management-stack"');
    expect(channel).toContain('className="channel-actions-card"');
    expect(channel).toContain('className="channel-test-message-card"');
    expect(provider).toContain('delivery has an unknown result');
    expect(provider).toContain('inbound processing failed');
    expect(channel).toContain('WhatsApp account settings');
    expect(channel).toContain('Connect WhatsApp');
    expect(channel).toContain(
      "connection.status !== 'ACTIVE' || connection.webhookStatus !== 'CONNECTED'",
    );
    expect(channelApi).toContain('onError: (_error, id) => refresh(id)');
    expect(channel.indexOf('Replace bot token')).toBeLessThan(
      channel.indexOf('Connection actions'),
    );
    expect(styles).toContain('grid-template-columns: minmax(320px, 0.85fr) minmax(420px, 1.15fr)');
    expect(styles).toContain('grid-template-rows: auto 1fr');
    expect(styles).toContain('align-items: stretch');
    expect(styles).toMatch(/\.channel-management-grid\s*\{\s*grid-template-columns: 1fr;/);
  });

  it('keeps WhatsApp onboarding official, capability-gated and provider-aware', () => {
    const channelsApi = source('./channels-api.ts');
    const create = source('./pages/channel-create-page.tsx');
    const detail = source('./pages/channel-detail-page.tsx');
    const embedded = source('./whatsapp-embedded-signup.ts');
    const broadcasts = source('./pages/broadcast-create-page.tsx');
    const automation = source('./automation-node-config.tsx');
    const composer = source('./whatsapp-template-composer.ts');
    const templates = source('./whatsapp-templates-panel.tsx');

    expect(channelsApi).toContain("type: 'WHATSAPP'");
    expect(channelsApi).toContain("'/whatsapp/setup/complete'");
    expect(channelsApi).toContain('connectionId?: string');
    expect(create).toContain('Continue with Meta');
    expect(create).toContain('6-digit two-step verification PIN');
    expect(create).not.toContain('name="appSecret"');
    expect(create).not.toContain('name="verifyToken"');
    expect(detail).toContain('const ready = channel.setupReady');
    expect(detail).toContain('connectionId: connection.id');
    expect(detail).toContain('activate this existing draft without creating a duplicate');
    expect(embedded).toContain("script.src = 'https://connect.facebook.net/en_US/sdk.js'");
    expect(embedded).toContain('preloadWhatsAppEmbeddedSignup');
    expect(embedded).toContain('session.cancel()');
    expect(embedded).toContain("window.removeEventListener('message', listener)");
    expect(broadcasts).toContain('WHATSAPP_TEMPLATE');
    expect(composer).toContain("image: 'PHOTO'");
    expect(broadcasts).toContain('whatsAppTemplateComposerIssue');
    expect(automation).toContain('whatsAppTemplate');
    expect(automation).toContain('whatsappConnectionId');
    expect(automation).toContain('whatsappButtons');
    expect(automation).toContain('Add reply button');
    expect(automation).not.toContain('whatsAppTemplateId');
    expect(automation).toContain(
      'Free-form WhatsApp messages require an open customer-service window',
    );
    expect(templates).toContain('Sync from Meta');
  });

  it('does not show internal unknown-delivery guidance as a page banner', () => {
    expect(source('./pages/crm-config-page.tsx')).not.toContain(
      'Unknown delivery requires confirmation',
    );
  });

  it('exposes the completed operations and account lifecycle surfaces safely', () => {
    const operations = source('./pages/operations-page.tsx');
    const settings = source('./pages/project-settings-page.tsx');
    const styles = source('./styles.css');
    const settingsGrid = styles.match(/\.project-settings-grid\s*\{(?<rules>[^}]*)\}/)?.groups
      ?.rules;
    const singleSettingsGrid = styles.match(
      /\.project-settings-grid\.is-single\s*\{(?<rules>[^}]*)\}/,
    )?.groups?.rules;
    const settingsHeading = styles.match(/\.project-settings-heading\s*\{(?<rules>[^}]*)\}/)?.groups
      ?.rules;
    const users = source('./pages/users-page.tsx');
    const health = source('./pages/system-health-page.tsx');
    expect(operations).toContain('Reconcile unknown outcome');
    expect(operations).toContain('Retry terminal operation');
    expect(operations).toContain('Audit log');
    expect(settings).toContain('Contacts, channels, credentials');
    expect(settings).toContain('canClone');
    expect(settings).not.toContain('project-settings-heading-actions');
    expect(settings).toContain('project-lifecycle-actions');
    expect(settings).toContain('Pause without losing data');
    expect(settings).toContain('Remove it from the workspace list');
    expect(settings).toContain('Pause project');
    expect(settings).toContain('Delete this project?');
    expect(settings).not.toContain('EditOutlined');
    expect(settings).not.toContain('<Tag');
    expect(settings).not.toContain('clone-project-icon');
    expect(settingsGrid).toContain('max-width: none');
    expect(settingsGrid).not.toContain('max-width: 1280px');
    expect(settingsHeading).toContain('max-width: none');
    expect(singleSettingsGrid).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(singleSettingsGrid).toContain('justify-content: stretch');
    expect(source('./pages/project-detail-page.tsx')).not.toContain('Pause project');
    expect(source('./pages/project-detail-page.tsx')).not.toContain('Delete this project?');
    expect(users).toContain('Create invitation');
    expect(users).toContain('password-reset-link');
    expect(health).toContain('System health');
    expect(health).toContain('Everything is working normally');
    expect(health).toContain('Older operation records');
    expect(health).toContain('operations?${query}');
    expect(health).not.toContain('No Sentry dependency');
  });

  it('keeps shared controls and status colors visually consistent', () => {
    const styles = source('./styles.css');
    expect(styles).toContain('.ant-picker:not(.ant-picker-disabled) input');
    expect(styles).toContain('cursor: pointer !important');
    expect(styles).toContain('.ant-input-affix-wrapper > input.ant-input');
    expect(styles).toContain(
      '.ant-input-affix-wrapper.ant-input-compact-item.ant-input-compact-first-item',
    );
    expect(styles).toContain('border-top-right-radius: 0 !important');
    expect(styles).toContain('border-bottom-right-radius: 0 !important');
    expect(styles).toContain('.ant-tag.ant-tag-success');
    expect(styles).toContain('background: #edf9f2 !important');
    expect(styles).toContain('.health-workspace-card .ant-tabs-body-holder');
    expect(styles).toContain('padding: 18px 20px 20px');
  });

  it('keeps automation activity and action controls human-facing', () => {
    const activity = source('./pages/automation-activity-page.tsx');
    const roles = source('./role-manager.tsx');
    const users = source('./pages/users-page.tsx');
    expect(activity).toContain('Contact journeys');
    expect(activity).toContain('Why runs stopped or paused');
    expect(activity).toContain('screens.lg === false ? { scroll: { x: 1_050 } } : {}');
    expect(source('./pages/project-detail-page.tsx')).toContain("label: 'Automation activity'");
    expect(source('./navigation.tsx')).not.toContain("key: 'automation-activity'");
    expect(roles).toContain('humanizePermission');
    expect(users).not.toContain('<Tooltip');
  });
});

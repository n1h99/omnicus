import { DeleteOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons';
import { Alert, Button, Form, Input, Modal, Select, Typography, Upload } from 'antd';
import { useState } from 'react';
import { ApiError, getUserErrorMessage } from './api';
import {
  type WhatsAppMessageTemplate,
  type WhatsAppTemplateDraft,
  useWhatsAppTemplateMutations,
} from './whatsapp-templates-api';
import './whatsapp-management.css';

type Values = Omit<WhatsAppTemplateDraft, 'header'> & {
  headerFormat: 'NONE' | 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  headerText?: string;
  headerExamples?: string[];
};

export function templateEditorInitial(
  template?: WhatsAppMessageTemplate,
  duplicate = false,
): Values {
  const body = template?.components.find((c) => c.type === 'BODY');
  const header = template?.components.find((c) => c.type === 'HEADER');
  return {
    name: template ? `${template.name}${duplicate ? '_copy' : ''}` : '',
    languageCode: template?.languageCode ?? 'en_US',
    category: template?.category === 'UTILITY' ? 'UTILITY' : 'MARKETING',
    body: body?.text ?? '',
    bodyExamples: body?.example?.body_text?.[0] ?? [],
    footer: template?.components.find((c) => c.type === 'FOOTER')?.text ?? '',
    headerFormat: header?.format && header.format !== 'LOCATION' ? header.format : 'NONE',
    headerText: header?.text ?? '',
    headerExamples: header?.example?.header_text ?? [],
    buttons:
      template?.components
        .find((c) => c.type === 'BUTTONS')
        ?.buttons?.map((b) => ({
          type: b.type,
          text: b.text,
          ...(b.url ? { url: b.url } : {}),
          ...(b.phoneNumber ? { phoneNumber: b.phoneNumber } : {}),
          ...(b.examples?.[0] ? { example: b.examples[0] } : {}),
        })) ?? [],
  };
}

const variables = (text = '') =>
  [...new Set([...text.matchAll(/\{\{([1-9]\d*)\}\}/g)].map((m) => Number(m[1])))]
    .filter((n) => n <= 100)
    .sort((a, b) => a - b);
const sampleText = (text = '', examples: string[] = []) =>
  text.replace(/\{\{(\d+)\}\}/g, (match, id: string) => examples[Number(id) - 1] || match);
const languages = [
  ['English (US)', 'en_US'],
  ['English (UK)', 'en_GB'],
  ['English', 'en'],
  ['Portuguese (Portugal)', 'pt_PT'],
  ['Portuguese (Brazil)', 'pt_BR'],
  ['Russian', 'ru'],
  ['Azerbaijani', 'az'],
  ['Turkish', 'tr'],
  ['Arabic', 'ar'],
  ['Spanish', 'es'],
  ['Spanish (Mexico)', 'es_MX'],
  ['French', 'fr'],
  ['German', 'de'],
  ['Italian', 'it'],
  ['Ukrainian', 'uk'],
  ['Polish', 'pl'],
  ['Romanian', 'ro'],
  ['Dutch', 'nl'],
  ['Hebrew', 'he'],
  ['Hindi', 'hi'],
  ['Indonesian', 'id'],
  ['Chinese (Simplified)', 'zh_CN'],
  ['Japanese', 'ja'],
  ['Korean', 'ko'],
].map(([label, value]) => ({ label: label!, value: value! }));

export function WhatsAppTemplateEditor({
  projectId,
  connectionId,
  template,
  duplicate = false,
  onClose,
}: {
  projectId: string | undefined;
  connectionId: string;
  template?: WhatsAppMessageTemplate;
  duplicate?: boolean;
  onClose: () => void;
}) {
  const [form] = Form.useForm<Values>();
  const values = Form.useWatch([], form) as Values | undefined;
  const mutations = useWhatsAppTemplateMutations(projectId, connectionId);
  const [sample, setSample] = useState<{ handle: string; format: string; name: string }>();
  const [error, setError] = useState<string>();
  const editing = Boolean(template && !duplicate);
  const format = values?.headerFormat ?? 'NONE';
  const busy = mutations.save.isPending || mutations.uploadSample.isPending;
  const save = async (values: Values) => {
    setError(undefined);
    const { headerFormat, headerText, headerExamples, ...draft } = values;
    if (
      headerFormat !== 'NONE' &&
      headerFormat !== 'TEXT' &&
      (!sample || sample.format !== headerFormat)
    ) {
      setError(
        'Upload a sample for the selected media header. Meta uses it to review the template.',
      );
      return;
    }
    const bodyExamples = variables(values.body).map((id) => values.bodyExamples?.[id - 1] ?? '');
    const input: WhatsAppTemplateDraft = {
      ...draft,
      bodyExamples,
      ...(headerFormat === 'NONE'
        ? {}
        : {
            header:
              headerFormat === 'TEXT'
                ? {
                    format: 'TEXT',
                    text: headerText ?? '',
                    examples: variables(headerText).map((id) => headerExamples?.[id - 1] ?? ''),
                  }
                : { format: headerFormat, handle: sample!.handle },
          }),
    };
    try {
      await mutations.save.mutateAsync({
        template: input,
        ...(editing ? { templateId: template!.id } : {}),
      });
      onClose();
    } catch (error) {
      const details =
        error instanceof ApiError
          ? (error.details as
              { reason?: string; providerCode?: number; providerSubcode?: number } | undefined)
          : undefined;
      setError(
        error instanceof ApiError && error.code === 'WHATSAPP_TEMPLATE_INVALID' && details?.reason
          ? details.reason
          : `${getUserErrorMessage(error, 'Template could not be submitted.')}${details?.providerCode ? ` Meta code: ${details.providerCode}${details.providerSubcode ? `/${details.providerSubcode}` : ''}. Sync templates before retrying.` : ''}`,
      );
    }
  };
  return (
    <Modal
      open
      title={editing ? 'Edit WhatsApp template' : 'New WhatsApp template'}
      onCancel={() => {
        if (!busy) onClose();
      }}
      footer={
        <div className="modal-form-actions">
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="primary"
            onClick={() => form.submit()}
            loading={mutations.save.isPending}
            disabled={mutations.uploadSample.isPending}
          >
            {editing ? 'Submit changes to Meta' : 'Submit to Meta'}
          </Button>
        </div>
      }
      width={1060}
      className="wa-template-editor"
      destroyOnHidden
    >
      <Form
        form={form}
        initialValues={templateEditorInitial(template, duplicate)}
        layout="vertical"
        onFinish={save}
        requiredMark={false}
        disabled={mutations.save.isPending}
      >
        <div className="wa-editor-grid">
          <div>
            {error ? (
              <Alert
                className="form-alert"
                title="Review template"
                description={error}
                showIcon
                type="error"
              />
            ) : null}
            <div className="wa-form-row">
              <Form.Item
                name="name"
                label="Template name"
                rules={[
                  {
                    required: true,
                    pattern: /^[a-z0-9_]+$/,
                    message: 'Use lowercase letters, numbers and underscores.',
                  },
                ]}
              >
                <Input disabled={editing} maxLength={512} placeholder="appointment_reminder" />
              </Form.Item>
              <Form.Item name="languageCode" label="Language" rules={[{ required: true }]}>
                <Select
                  disabled={editing}
                  showSearch
                  optionFilterProp="label"
                  options={
                    languages.some((l) => l.value === template?.languageCode) || !template
                      ? languages
                      : [
                          ...languages,
                          { label: template.languageCode, value: template.languageCode },
                        ]
                  }
                />
              </Form.Item>
            </div>
            <Form.Item
              name="category"
              label="Purpose"
              extra="Meta reviews the category and can change it. The approved category determines pricing."
              rules={[{ required: true }]}
            >
              <Select
                disabled={editing}
                options={[
                  { value: 'MARKETING', label: 'Marketing — offers and re-engagement' },
                  { value: 'UTILITY', label: 'Utility — requested updates and reminders' },
                ]}
              />
            </Form.Item>
            <Form.Item name="headerFormat" label="Header">
              <Select
                onChange={() => setSample(undefined)}
                options={['NONE', 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'].map((value) => ({
                  value,
                  label: value === 'NONE' ? 'No header' : value[0] + value.slice(1).toLowerCase(),
                }))}
              />
            </Form.Item>
            {format === 'TEXT' ? (
              <>
                <Form.Item name="headerText" label="Header text" rules={[{ required: true }]}>
                  <Input maxLength={60} showCount />
                </Form.Item>
                {variables(values?.headerText).map((id) => (
                  <Form.Item
                    key={id}
                    name={['headerExamples', id - 1]}
                    label={`Header example {{${id}}}`}
                    rules={[{ required: true, whitespace: true }]}
                  >
                    <Input maxLength={1024} placeholder="Example for Meta review" />
                  </Form.Item>
                ))}
              </>
            ) : format !== 'NONE' ? (
              <div className="wa-sample-upload">
                <Upload
                  accept={
                    format === 'IMAGE' ? '.jpg,.jpeg,.png' : format === 'VIDEO' ? '.mp4' : '.pdf'
                  }
                  showUploadList={false}
                  disabled={busy}
                  beforeUpload={async (file) => {
                    setError(undefined);
                    const limit = format === 'IMAGE' ? 5 : 16;
                    if (file.size > limit * 1024 * 1024) {
                      setError(`Choose a file smaller than ${limit} MB.`);
                      return false;
                    }
                    try {
                      const result = await mutations.uploadSample.mutateAsync(file);
                      setSample({ ...result, name: file.name });
                    } catch (error) {
                      setError(getUserErrorMessage(error, 'Sample could not be uploaded.'));
                    }
                    return false;
                  }}
                >
                  <Button icon={<UploadOutlined />} loading={mutations.uploadSample.isPending}>
                    Upload review sample
                  </Button>
                </Upload>
                <Typography.Text type="secondary">
                  {sample?.name ??
                    (format === 'IMAGE'
                      ? 'JPG or PNG, up to 5 MB'
                      : format === 'VIDEO'
                        ? 'MP4, up to 16 MB'
                        : 'PDF, up to 16 MB')}
                </Typography.Text>
              </div>
            ) : null}
            <Form.Item
              name="body"
              label="Message"
              extra="Use {{1}}, {{2}}… for personalized values. Supply fictional examples for review."
              rules={[{ required: true, whitespace: true }]}
            >
              <Input.TextArea
                rows={5}
                maxLength={1024}
                showCount
                placeholder="Hi {{1}}, your appointment is confirmed for {{2}}."
              />
            </Form.Item>
            <div className="wa-form-row">
              {variables(values?.body).map((id) => (
                <Form.Item
                  key={id}
                  name={['bodyExamples', id - 1]}
                  label={`Example {{${id}}}`}
                  rules={[{ required: true, whitespace: true }]}
                >
                  <Input maxLength={1024} placeholder={id === 1 ? 'Alex' : 'Example value'} />
                </Form.Item>
              ))}
            </div>
            <Form.Item name="footer" label="Footer (optional)">
              <Input maxLength={60} showCount />
            </Form.Item>
            <Form.List name="buttons">
              {(fields, { add, remove }) => (
                <div className="wa-editor-buttons">
                  <Typography.Text strong>Buttons</Typography.Text>
                  {fields.map((field) => (
                    <div className="wa-button-editor" key={field.key}>
                      <div className="wa-form-row">
                        <Form.Item
                          name={[field.name, 'type']}
                          label="Button type"
                          rules={[{ required: true }]}
                        >
                          <Select
                            options={[
                              { value: 'QUICK_REPLY', label: 'Quick reply' },
                              { value: 'URL', label: 'Open website' },
                              { value: 'PHONE_NUMBER', label: 'Call phone number' },
                            ]}
                          />
                        </Form.Item>
                        <Form.Item
                          name={[field.name, 'text']}
                          label="Button label"
                          rules={[{ required: true, whitespace: true }]}
                        >
                          <Input maxLength={25} />
                        </Form.Item>
                        <Button
                          aria-label={`Remove button ${field.name + 1}`}
                          icon={<DeleteOutlined />}
                          onClick={() => remove(field.name)}
                        />
                      </div>
                      {values?.buttons?.[field.name]?.type === 'URL' ? (
                        <>
                          <Form.Item
                            name={[field.name, 'url']}
                            label="Website URL"
                            rules={[{ required: true }]}
                          >
                            <Input
                              placeholder="https://example.com/booking/{{1}}"
                              maxLength={2000}
                            />
                          </Form.Item>
                          {values.buttons[field.name]?.url?.includes('{{') ? (
                            <Form.Item
                              name={[field.name, 'example']}
                              label="Example complete URL"
                              rules={[{ required: true, type: 'url' }]}
                            >
                              <Input placeholder="https://example.com/booking/123" />
                            </Form.Item>
                          ) : null}
                        </>
                      ) : values?.buttons?.[field.name]?.type === 'PHONE_NUMBER' ? (
                        <Form.Item
                          name={[field.name, 'phoneNumber']}
                          label="Phone number"
                          rules={[
                            {
                              required: true,
                              pattern: /^\+[1-9]\d{6,14}$/,
                              message: 'Include the country code, e.g. +351…',
                            },
                          ]}
                        >
                          <Input placeholder="+351…" />
                        </Form.Item>
                      ) : null}
                    </div>
                  ))}
                  <Button
                    icon={<PlusOutlined />}
                    disabled={fields.length >= 10}
                    onClick={() => add({ type: 'QUICK_REPLY', text: '' })}
                  >
                    Add button
                  </Button>
                </div>
              )}
            </Form.List>
          </div>
          <aside className="wa-preview-pane">
            <Typography.Text strong>Message preview</Typography.Text>
            <div className="wa-preview-chat">
              <div className="wa-preview-bubble">
                {format === 'TEXT' ? (
                  <strong>{sampleText(values?.headerText, values?.headerExamples)}</strong>
                ) : format !== 'NONE' ? (
                  <div className="wa-preview-media">
                    {format} · {sample?.name ?? 'Review sample'}
                  </div>
                ) : null}
                <p>
                  {sampleText(values?.body, values?.bodyExamples) ||
                    'Your message will appear here.'}
                </p>
                {values?.footer ? <small>{values.footer}</small> : null}
                {values?.buttons?.map((button, index) => (
                  <div className="wa-preview-button" key={index}>
                    {button.text || 'Button'}
                  </div>
                ))}
              </div>
            </div>
            <Typography.Paragraph type="secondary">
              Meta reviews every submitted template. Only approved templates can be used in
              broadcasts and automations.
            </Typography.Paragraph>
            {editing ? (
              <Typography.Paragraph type="secondary">
                Editing may trigger another review. Existing automations using this template may
                pause until it is approved. Meta also limits how often templates can be edited.
              </Typography.Paragraph>
            ) : null}
          </aside>
        </div>
      </Form>
    </Modal>
  );
}

import {
  AlignCenterOutlined,
  AlignLeftOutlined,
  AlignRightOutlined,
  BoldOutlined,
  BorderHorizontalOutlined,
  ColumnHeightOutlined,
  CopyOutlined,
  DeleteOutlined,
  FontSizeOutlined,
  ItalicOutlined,
  LinkOutlined,
  PaperClipOutlined,
  PictureOutlined,
  ShareAltOutlined,
  UnderlineOutlined,
} from '@ant-design/icons';
import {
  Button,
  Divider,
  Input,
  InputNumber,
  Segmented,
  Select,
  Slider,
  Space,
  Tooltip,
  Typography,
  Upload,
  message,
} from 'antd';
import {
  renderEmailDocument,
  type EmailBlock,
  type EmailDocument,
} from '@omnicus/email-core';
import { useEffect, useMemo, useRef, useState } from 'react';

import { getUserErrorMessage } from './api';
import { useMediaMutations } from './media-api';

type EmailBuilderProps = {
  disabled?: boolean | undefined;
  document: EmailDocument;
  onChange: (document: EmailDocument) => void;
  projectId?: string | undefined;
};

const palette = [
  { icon: <FontSizeOutlined />, label: 'Heading', type: 'HEADING' },
  { icon: <BoldOutlined />, label: 'Text', type: 'TEXT' },
  { icon: <LinkOutlined />, label: 'Button', type: 'BUTTON' },
  { icon: <PictureOutlined />, label: 'Image', type: 'IMAGE' },
  { icon: <PaperClipOutlined />, label: 'File', type: 'ATTACHMENT' },
  { icon: <BorderHorizontalOutlined />, label: 'Divider', type: 'DIVIDER' },
  { icon: <ColumnHeightOutlined />, label: 'Space', type: 'SPACER' },
  { icon: <ShareAltOutlined />, label: 'Social', type: 'SOCIAL' },
] as const;

function id(type: string) {
  return `${type.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function blockFor(type: (typeof palette)[number]['type']): EmailBlock | null {
  if (type === 'HEADING')
    return { align: 'left', content: 'A clear headline', id: id(type), level: 2, type };
  if (type === 'TEXT')
    return {
      align: 'left',
      content: 'Write a useful message for {{contact.firstName|your reader}}.',
      fontSize: 16,
      id: id(type),
      lineHeight: 1.6,
      type,
    };
  if (type === 'BUTTON')
    return {
      align: 'center',
      backgroundColor: '#0f766e',
      borderRadius: 10,
      id: id(type),
      label: 'Open link',
      textColor: '#ffffff',
      type,
      url: 'https://example.com',
    };
  if (type === 'DIVIDER')
    return { color: '#e2e8f0', id: id(type), spacing: 24, type };
  if (type === 'SPACER') return { height: 24, id: id(type), type };
  if (type === 'SOCIAL')
    return {
      align: 'center',
      id: id(type),
      links: [{ label: 'Website', url: 'https://example.com' }],
      type,
    };
  return null;
}

function blockName(block: EmailBlock) {
  return palette.find((item) => item.type === block.type)?.label ?? block.type;
}

export function EmailBuilder({ disabled = false, document, onChange, projectId }: EmailBuilderProps) {
  const media = useMediaMutations(projectId);
  const [selectedId, setSelectedId] = useState(document.blocks[0]?.id);
  const [mode, setMode] = useState<'design' | 'preview'>('design');
  const [draggedId, setDraggedId] = useState<string>();
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const requestedPreviewIds = useRef(new Set<string>());
  const selected = document.blocks.find((block) => block.id === selectedId);

  useEffect(() => {
    if (!selected && document.blocks[0]) setSelectedId(document.blocks[0].id);
  }, [document.blocks, selected]);

  useEffect(() => {
    const missing = document.blocks
      .filter((block): block is Extract<EmailBlock, { type: 'IMAGE' }> => block.type === 'IMAGE')
      .map((block) => block.assetId)
      .filter((assetId) => !previewUrls[assetId] && !requestedPreviewIds.current.has(assetId));
    for (const assetId of missing) {
      requestedPreviewIds.current.add(assetId);
      void media.signedUrl
        .mutateAsync(assetId)
        .then(({ url }) => setPreviewUrls((current) => ({ ...current, [assetId]: url })))
        .catch(() => requestedPreviewIds.current.delete(assetId));
    }
  }, [document.blocks, media.signedUrl, previewUrls]);

  const previewHtml = useMemo(() => {
    const images = document.blocks.filter(
      (block): block is Extract<EmailBlock, { type: 'IMAGE' }> => block.type === 'IMAGE',
    );
    const contentIds = Object.fromEntries(
      images.map((block) => [block.assetId, `preview-${block.assetId}`]),
    );
    try {
      let html = renderEmailDocument(
        document,
        {
          contact: {
            email: 'alex@example.com',
            firstName: 'Alex',
            fullName: 'Alex Morgan',
          },
        },
        { assetContentIds: contentIds, preheader: 'Inbox preview text' },
      ).html;
      for (const block of images) {
        const previewUrl = previewUrls[block.assetId];
        if (previewUrl) html = html.replaceAll(`cid:preview-${block.assetId}`, previewUrl);
      }
      return html;
    } catch {
      return '<!doctype html><body style="font-family:Arial,sans-serif;padding:40px;color:#9f1239;background:#fff1f2"><h2>Preview needs attention</h2><p>Complete the URL and required block fields to render this email.</p></body>';
    }
  }, [document, previewUrls]);

  const setBlocks = (blocks: EmailBlock[]) => onChange({ ...document, blocks });
  const updateSelected = (patch: Partial<EmailBlock>) => {
    if (!selected) return;
    setBlocks(
      document.blocks.map((block) =>
        block.id === selected.id ? ({ ...block, ...patch } as EmailBlock) : block,
      ),
    );
  };
  const add = (type: (typeof palette)[number]['type']) => {
    const block = blockFor(type);
    if (!block) return;
    setBlocks([...document.blocks, block]);
    setSelectedId(block.id);
  };
  const remove = (blockId: string) => {
    if (document.blocks.length === 1) {
      void message.warning('An email needs at least one content block.');
      return;
    }
    setBlocks(document.blocks.filter((block) => block.id !== blockId));
  };
  const duplicate = (block: EmailBlock) => {
    const copy = { ...block, id: id(block.type) } as EmailBlock;
    const index = document.blocks.findIndex((item) => item.id === block.id);
    const blocks = [...document.blocks];
    blocks.splice(index + 1, 0, copy);
    setBlocks(blocks);
    setSelectedId(copy.id);
  };
  const drop = (targetId: string) => {
    if (!draggedId || draggedId === targetId) return;
    const blocks = [...document.blocks];
    const source = blocks.findIndex((block) => block.id === draggedId);
    const target = blocks.findIndex((block) => block.id === targetId);
    const [moved] = blocks.splice(source, 1);
    if (!moved) return;
    blocks.splice(target, 0, moved);
    setBlocks(blocks);
    setDraggedId(undefined);
  };
  const addMarkup = (prefix: string, suffix: string, value: string) => {
    if (!selected || !['HEADING', 'TEXT'].includes(selected.type)) return;
    const content = 'content' in selected ? selected.content : '';
    updateSelected({ content: `${content}${content ? ' ' : ''}${prefix}${value}${suffix}` } as never);
  };
  const uploadImage = async (file: File) => {
    try {
      const asset = await media.upload.mutateAsync({ channel: 'EMAIL', file, kind: 'PHOTO' });
      const block: EmailBlock = {
        align: 'center',
        alt: file.name.replace(/\.[^.]+$/, ''),
        assetId: asset.id,
        id: id('IMAGE'),
        type: 'IMAGE',
        widthPercent: 100,
      };
      setBlocks([...document.blocks, block]);
      setSelectedId(block.id);
      const signed = await media.signedUrl.mutateAsync(asset.id);
      setPreviewUrls((current) => ({ ...current, [asset.id]: signed.url }));
    } catch (error) {
      void message.error(getUserErrorMessage(error, 'Image could not be uploaded.'));
    }
  };
  const uploadAttachment = async (file: File) => {
    try {
      const asset = await media.upload.mutateAsync({ channel: 'EMAIL', file, kind: 'DOCUMENT' });
      const block: EmailBlock = {
        assetId: asset.id,
        fileName: asset.originalFilename || file.name,
        id: id('ATTACHMENT'),
        label: asset.originalFilename || file.name,
        type: 'ATTACHMENT',
      };
      setBlocks([...document.blocks, block]);
      setSelectedId(block.id);
    } catch (error) {
      void message.error(getUserErrorMessage(error, 'File could not be uploaded.'));
    }
  };

  return (
    <div className="email-builder">
      <aside className="email-builder-palette">
        <Typography.Text className="email-builder-kicker">CONTENT</Typography.Text>
        <Typography.Title level={5}>Add a block</Typography.Title>
        <div className="email-block-palette-grid">
          {palette.map((item) =>
            item.type === 'IMAGE' ? (
              <Upload
                accept="image/jpeg,image/png,image/gif,image/webp"
                beforeUpload={(file) => {
                  void uploadImage(file);
                  return Upload.LIST_IGNORE;
                }}
                disabled={disabled}
                key={item.type}
                showUploadList={false}
              >
                <button className="email-palette-item" disabled={disabled} type="button">
                  {item.icon}<span>{item.label}</span>
                </button>
              </Upload>
            ) : item.type === 'ATTACHMENT' ? (
              <Upload
                accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"
                beforeUpload={(file) => {
                  void uploadAttachment(file);
                  return Upload.LIST_IGNORE;
                }}
                disabled={disabled}
                key={item.type}
                showUploadList={false}
              >
                <button className="email-palette-item" disabled={disabled} type="button">
                  {item.icon}<span>{item.label}</span>
                </button>
              </Upload>
            ) : (
              <button
                className="email-palette-item"
                disabled={disabled}
                key={item.type}
                onClick={() => add(item.type)}
                type="button"
              >
                {item.icon}<span>{item.label}</span>
              </button>
            ),
          )}
        </div>
        <Divider />
        <Typography.Text className="email-builder-kicker">STYLE</Typography.Text>
        <div className="email-field-heading">
          <label className="email-field-label">Email width</label>
          <span>{document.settings.width}px</span>
        </div>
        <Slider
          disabled={disabled}
          max={720}
          min={480}
          onChange={(width) =>
            onChange({ ...document, settings: { ...document.settings, width } })
          }
          value={document.settings.width}
        />
        <label className="email-field-label">Font family</label>
        <Select
          disabled={disabled}
          onChange={(fontFamily) =>
            onChange({
              ...document,
              settings: {
                ...document.settings,
                fontFamily: fontFamily as EmailDocument['settings']['fontFamily'],
              },
            })
          }
          options={['Arial', 'Georgia', 'Tahoma', 'Trebuchet MS', 'Verdana'].map((value) => ({
            label: value,
            value,
          }))}
          value={document.settings.fontFamily}
        />
        <div className="email-color-row">
          <ColorField
            label="Background"
            onChange={(backgroundColor) =>
              onChange({ ...document, settings: { ...document.settings, backgroundColor } })
            }
            value={document.settings.backgroundColor}
          />
          <ColorField
            label="Content"
            onChange={(contentColor) =>
              onChange({ ...document, settings: { ...document.settings, contentColor } })
            }
            value={document.settings.contentColor}
          />
        </div>
      </aside>

      <main className="email-builder-stage">
        <div className="email-builder-stage-toolbar">
          <div>
            <Typography.Text strong>Email canvas</Typography.Text>
            <Typography.Text type="secondary"> Drag blocks to reorder</Typography.Text>
          </div>
          <Segmented
            onChange={(value) => setMode(value as 'design' | 'preview')}
            options={[
              { label: 'Design', value: 'design' },
              { label: 'Inbox preview', value: 'preview' },
            ]}
            value={mode}
          />
        </div>
        {mode === 'preview' ? (
          <div className="email-preview-frame-shell">
            <iframe className="email-preview-frame" srcDoc={previewHtml} title="Email preview" />
          </div>
        ) : (
          <div className="email-design-canvas" style={{ background: document.settings.backgroundColor }}>
            <div
              className="email-design-sheet"
              style={{
                background: document.settings.contentColor,
                color: document.settings.textColor,
                fontFamily: document.settings.fontFamily,
                maxWidth: document.settings.width,
              }}
            >
              {document.blocks.map((block) => (
                <div
                  className={`email-canvas-block${block.id === selectedId ? ' is-selected' : ''}${block.id === draggedId ? ' is-dragging' : ''}`}
                  draggable={!disabled}
                  key={block.id}
                  onClick={() => setSelectedId(block.id)}
                  onDragEnd={() => setDraggedId(undefined)}
                  onDragOver={(event) => event.preventDefault()}
                  onDragStart={() => setDraggedId(block.id)}
                  onDrop={() => drop(block.id)}
                >
                  <div className="email-canvas-block-label">{blockName(block)}</div>
                  <BlockVisual block={block} imageUrl={block.type === 'IMAGE' ? previewUrls[block.assetId] : undefined} />
                  <div className="email-canvas-block-actions">
                    <Tooltip title="Duplicate">
                      <Button
                        icon={<CopyOutlined />}
                        onClick={(event) => {
                          event.stopPropagation();
                          duplicate(block);
                        }}
                        size="small"
                      />
                    </Tooltip>
                    <Tooltip title="Delete">
                      <Button
                        danger
                        icon={<DeleteOutlined />}
                        onClick={(event) => {
                          event.stopPropagation();
                          remove(block.id);
                        }}
                        size="small"
                      />
                    </Tooltip>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      <aside className="email-builder-properties">
        <Typography.Text className="email-builder-kicker">PROPERTIES</Typography.Text>
        <Typography.Title level={5}>{selected ? blockName(selected) : 'Select a block'}</Typography.Title>
        {selected ? (
          <BlockProperties
            addMarkup={addMarkup}
            block={selected}
            disabled={disabled}
            update={updateSelected}
          />
        ) : null}
      </aside>
    </div>
  );
}

function Alignment({
  disabled = false,
  onChange,
  value,
}: {
  disabled?: boolean | undefined;
  onChange: (value: 'left' | 'center' | 'right') => void;
  value: 'left' | 'center' | 'right';
}) {
  return (
    <Segmented
      block
      disabled={disabled}
      onChange={(next) => onChange(next as 'left' | 'center' | 'right')}
      options={[
        { icon: <AlignLeftOutlined />, value: 'left' },
        { icon: <AlignCenterOutlined />, value: 'center' },
        { icon: <AlignRightOutlined />, value: 'right' },
      ]}
      value={value}
    />
  );
}

function ColorField({ label, onChange, value }: { label: string; onChange: (value: string) => void; value: string }) {
  return (
    <label className="email-color-field">
      <span>{label}</span>
      <span className="email-color-control">
        <input onChange={(event) => onChange(event.target.value)} type="color" value={value} />
        <code>{value}</code>
      </span>
    </label>
  );
}

function BlockProperties({
  addMarkup,
  block,
  disabled = false,
  update,
}: {
  addMarkup: (prefix: string, suffix: string, value: string) => void;
  block: EmailBlock;
  disabled?: boolean | undefined;
  update: (patch: Partial<EmailBlock>) => void;
}) {
  if (block.type === 'HEADING' || block.type === 'TEXT')
    return (
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <div className="email-format-toolbar">
          <Button disabled={disabled} icon={<BoldOutlined />} onClick={() => addMarkup('**', '**', 'bold text')} />
          <Button disabled={disabled} icon={<ItalicOutlined />} onClick={() => addMarkup('_', '_', 'italic text')} />
          <Button disabled={disabled} icon={<UnderlineOutlined />} onClick={() => addMarkup('__', '__', 'underlined text')} />
          <Button disabled={disabled} icon={<LinkOutlined />} onClick={() => addMarkup('[', '](https://example.com)', 'link text')} />
        </div>
        <label className="email-field-label">Content</label>
        <Input.TextArea
          autoSize={{ minRows: 7, maxRows: 14 }}
          disabled={disabled}
          onChange={(event) => update({ content: event.target.value } as never)}
          value={block.content}
        />
        <Typography.Text className="email-variable-hint" type="secondary">
          Personalize with {'{{contact.firstName}}'}, {'{{contact.fullName}}'} or {'{{contact.email}}'}.
        </Typography.Text>
        {block.type === 'HEADING' ? (
          <>
            <label className="email-field-label">Heading size</label>
            <Select
              disabled={disabled}
              onChange={(level) => update({ level } as never)}
              options={[
                { label: 'Large heading', value: 1 },
                { label: 'Medium heading', value: 2 },
                { label: 'Small heading', value: 3 },
              ]}
              value={block.level}
            />
          </>
        ) : (
          <div className="email-two-fields">
            <label>Font size<InputNumber disabled={disabled} max={32} min={11} onChange={(fontSize) => update({ fontSize: fontSize ?? 16 } as never)} value={block.fontSize} /></label>
            <label>Line height<InputNumber disabled={disabled} max={2.5} min={1} onChange={(lineHeight) => update({ lineHeight: lineHeight ?? 1.6 } as never)} step={0.1} value={block.lineHeight} /></label>
          </div>
        )}
        <label className="email-field-label">Alignment</label>
        <Alignment disabled={disabled} onChange={(align) => update({ align } as never)} value={block.align} />
        <ColorField label="Text color" onChange={(color) => update({ color } as never)} value={block.color ?? '#172033'} />
      </Space>
    );
  if (block.type === 'BUTTON')
    return (
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <label className="email-field-label">Button label</label>
        <Input disabled={disabled} onChange={(event) => update({ label: event.target.value } as never)} value={block.label} />
        <label className="email-field-label">Destination URL</label>
        <Input disabled={disabled} onChange={(event) => update({ url: event.target.value } as never)} value={block.url} />
        <label className="email-field-label">Alignment</label>
        <Alignment disabled={disabled} onChange={(align) => update({ align } as never)} value={block.align} />
        <ColorField label="Button" onChange={(backgroundColor) => update({ backgroundColor } as never)} value={block.backgroundColor} />
        <ColorField label="Label" onChange={(textColor) => update({ textColor } as never)} value={block.textColor} />
        <label className="email-field-label">Corner radius</label>
        <Slider disabled={disabled} max={32} min={0} onChange={(borderRadius) => update({ borderRadius } as never)} value={block.borderRadius} />
      </Space>
    );
  if (block.type === 'IMAGE')
    return (
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <label className="email-field-label">Alternative text</label>
        <Input disabled={disabled} onChange={(event) => update({ alt: event.target.value } as never)} value={block.alt} />
        <label className="email-field-label">Caption</label>
        <Input disabled={disabled} onChange={(event) => update({ caption: event.target.value || undefined } as never)} value={block.caption ?? ''} />
        <label className="email-field-label">Click-through URL</label>
        <Input disabled={disabled} onChange={(event) => update({ linkUrl: event.target.value || undefined } as never)} value={block.linkUrl ?? ''} />
        <label className="email-field-label">Width</label>
        <Slider disabled={disabled} max={100} min={10} onChange={(widthPercent) => update({ widthPercent } as never)} value={block.widthPercent} />
        <Alignment disabled={disabled} onChange={(align) => update({ align } as never)} value={block.align} />
      </Space>
    );
  if (block.type === 'ATTACHMENT')
    return (
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <label className="email-field-label">Attachment label</label>
        <Input disabled={disabled} onChange={(event) => update({ label: event.target.value } as never)} value={block.label} />
        <label className="email-field-label">Description</label>
        <Input.TextArea disabled={disabled} onChange={(event) => update({ description: event.target.value || undefined } as never)} rows={4} value={block.description ?? ''} />
        <div className="email-file-reference"><PaperClipOutlined /><span>{block.fileName}</span></div>
      </Space>
    );
  if (block.type === 'DIVIDER')
    return (
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <ColorField label="Divider" onChange={(color) => update({ color } as never)} value={block.color} />
        <label className="email-field-label">Vertical spacing</label>
        <Slider disabled={disabled} max={64} min={4} onChange={(spacing) => update({ spacing } as never)} value={block.spacing} />
      </Space>
    );
  if (block.type === 'SPACER')
    return <Slider disabled={disabled} max={120} min={4} onChange={(height) => update({ height } as never)} value={block.height} />;
  if (block.type === 'SOCIAL')
    return (
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {block.links.map((link, index) => (
          <div className="email-social-row" key={`${link.label}-${index}`}>
            <Input
              disabled={disabled}
              onChange={(event) => {
                const links = [...block.links];
                links[index] = { ...link, label: event.target.value };
                update({ links } as never);
              }}
              placeholder="Label"
              value={link.label}
            />
            <Input
              disabled={disabled}
              onChange={(event) => {
                const links = [...block.links];
                links[index] = { ...link, url: event.target.value };
                update({ links } as never);
              }}
              placeholder="https://"
              value={link.url}
            />
            <Button danger disabled={disabled || block.links.length === 1} icon={<DeleteOutlined />} onClick={() => update({ links: block.links.filter((_, itemIndex) => itemIndex !== index) } as never)} />
          </div>
        ))}
        <Button disabled={disabled || block.links.length >= 8} onClick={() => update({ links: [...block.links, { label: 'Social', url: 'https://example.com' }] } as never)}>
          Add social link
        </Button>
        <Alignment disabled={disabled} onChange={(align) => update({ align } as never)} value={block.align} />
      </Space>
    );
  return null;
}

function BlockVisual({ block, imageUrl }: { block: EmailBlock; imageUrl?: string | undefined }) {
  if (block.type === 'HEADING') {
    const style = { color: block.color, textAlign: block.align };
    if (block.level === 1) return <h1 style={style}>{block.content}</h1>;
    if (block.level === 3) return <h3 style={style}>{block.content}</h3>;
    return <h2 style={style}>{block.content}</h2>;
  }
  if (block.type === 'TEXT')
    return <p style={{ color: block.color, fontSize: block.fontSize, lineHeight: block.lineHeight, textAlign: block.align, whiteSpace: 'pre-wrap' }}>{block.content}</p>;
  if (block.type === 'BUTTON')
    return <div style={{ textAlign: block.align }}><span className="email-visual-button" style={{ background: block.backgroundColor, borderRadius: block.borderRadius, color: block.textColor }}>{block.label}</span></div>;
  if (block.type === 'IMAGE')
    return imageUrl ? <div style={{ textAlign: block.align }}><img alt={block.alt} src={imageUrl} style={{ maxWidth: `${block.widthPercent}%` }} />{block.caption ? <small>{block.caption}</small> : null}</div> : <div className="email-image-placeholder"><PictureOutlined /> Image is loading</div>;
  if (block.type === 'ATTACHMENT')
    return <div className="email-file-reference"><PaperClipOutlined /><span><strong>{block.label}</strong><small>{block.fileName}</small></span></div>;
  if (block.type === 'DIVIDER') return <div style={{ borderTop: `1px solid ${block.color}`, margin: `${block.spacing}px 0` }} />;
  if (block.type === 'SPACER') return <div className="email-spacer-visual" style={{ height: block.height }}><span>{block.height}px</span></div>;
  return <div style={{ textAlign: block.align }}>{block.links.map((link) => <span className="email-social-pill" key={link.label}>{link.label}</span>)}</div>;
}

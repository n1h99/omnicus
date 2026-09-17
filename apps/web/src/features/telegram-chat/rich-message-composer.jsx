// Ported from the CRM conversation renderer; Omnicus API and layout are isolated here.
import { CodeOutlined, FileTextOutlined } from '@ant-design/icons';
import { Alert, Button, Input, Typography } from 'antd';
import {
  appendRichMessageBlock,
  RICH_MESSAGE_EXAMPLE,
  richMessagePreviewBlocks,
} from './rich-message-content';
function renderInline(text = '') {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith('**') && part.endsWith('**'))
        return <strong key={`${part}-${index}`}>{part.slice(2, -2)}</strong>;
      if (part.startsWith('`') && part.endsWith('`'))
        return <code key={`${part}-${index}`}>{part.slice(1, -1)}</code>;
      return part;
    });
}
function RichMessagePreview({ value }) {
  const blocks = richMessagePreviewBlocks(value);
  if (!blocks.length)
    return <div className="chat-rich-preview-empty">Your Telegram preview will appear here.</div>;
  return (
    <div className="chat-rich-preview-content">
      {blocks.map((block, index) => {
        if (block.type === 'heading')
          return (
            <strong className="chat-rich-preview-heading" key={index}>
              {renderInline(block.text)}
            </strong>
          );
        if (block.type === 'quote')
          return <blockquote key={index}>{renderInline(block.text)}</blockquote>;
        if (block.type === 'list') return <div key={index}>• {renderInline(block.text)}</div>;
        if (block.type === 'code') return <pre key={index}>{block.text}</pre>;
        if (block.type === 'table')
          return (
            <div className="chat-rich-preview-table-row" key={index}>
              {block.cells?.map((cell, cellIndex) => (
                <span key={`${cell}-${cellIndex}`}>{renderInline(cell)}</span>
              ))}
            </div>
          );
        return <p key={index}>{renderInline(block.text)}</p>;
      })}
    </div>
  );
}
export function RichMessageComposer({ onChange, value }) {
  return (
    <div className="chat-rich-editor">
      <Alert
        className="chat-rich-message-hint"
        showIcon
        type="info"
        message="Create a richer Telegram message"
        description="Add a title, list, quote or table in one click. Telegram handles the final rendering."
      />
      <div className="chat-rich-block-toolbar">
        <Typography.Text strong>Insert a block</Typography.Text>
        {[
          ['heading', 'Title'],
          ['list', 'Bullet list'],
          ['quote', 'Quote'],
          ['table', 'Table'],
          ['code', 'Code'],
        ].map(([kind, label]) => (
          <Button
            key={kind}
            size="small"
            icon={kind === 'code' ? <CodeOutlined /> : undefined}
            onClick={() => onChange(appendRichMessageBlock(value, kind))}
          >
            {label}
          </Button>
        ))}
        {!value.trim() ? (
          <Button
            size="small"
            icon={<FileTextOutlined />}
            onClick={() => onChange(RICH_MESSAGE_EXAMPLE)}
          >
            Load example
          </Button>
        ) : null}
      </div>
      <div className="chat-rich-editor-grid">
        <label className="chat-rich-input">
          <Typography.Text strong>Message content</Typography.Text>
          <Input.TextArea
            autoSize={{ minRows: 12, maxRows: 20 }}
            maxLength={32768}
            value={value}
            placeholder="Write your message here, or load an example above."
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
        <div className="chat-rich-preview">
          <Typography.Text strong>Preview</Typography.Text>
          <RichMessagePreview value={value} />
        </div>
      </div>
      <Typography.Text type="secondary">
        Regular links are allowed. Remote image, audio and video URLs are blocked; attach CRM-owned
        media separately.
      </Typography.Text>
    </div>
  );
}

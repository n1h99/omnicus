// Ported from the CRM conversation renderer; Omnicus API and layout are isolated here.
export const RICH_MESSAGE_EXAMPLE = `# Customer update

> Everything is ready for the next step.

| Item | Status |
|---|---|
| Documents | **Ready** |

- Review the details
- Confirm the next step`;
const snippets = {
  code: '```\nCode or formula\n```',
  heading: '# Section title',
  list: '- First item\n- Second item',
  quote: '> Important note',
  table: '| Item | Value |\n|---|---|\n| Example | Ready |',
};
export function appendRichMessageBlock(value, kind) {
  const current = value.trimEnd();
  return `${current}${current ? '\n\n' : ''}${snippets[kind]}`;
}
export function richMessagePreviewBlocks(markdown) {
  const blocks = [];
  let code;
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.trim().startsWith('```')) {
      if (code) {
        blocks.push({ type: 'code', text: code.join('\n') });
        code = undefined;
      } else code = [];
      continue;
    }
    if (code) {
      code.push(rawLine);
      continue;
    }
    if (!line.trim()) continue;
    if (/^#{1,3}\s+/.test(line)) {
      blocks.push({ type: 'heading', text: line.replace(/^#{1,3}\s+/, '') });
      continue;
    }
    if (/^>\s?/.test(line)) {
      blocks.push({ type: 'quote', text: line.replace(/^>\s?/, '') });
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      blocks.push({ type: 'list', text: line.replace(/^[-*]\s+/, '') });
      continue;
    }
    if (/^\|.*\|$/.test(line)) {
      const cells = line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim());
      if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
      blocks.push({ cells, type: 'table' });
      continue;
    }
    blocks.push({ type: 'paragraph', text: line });
  }
  if (code) blocks.push({ type: 'code', text: code.join('\n') });
  return blocks;
}

// Ported from the CRM conversation renderer; Omnicus API and layout are isolated here.
const GROUP_WINDOW_MS = 5 * 60 * 1000;
export function messageTimestamp(message) {
  const value = message.occurredAt ?? message.createdAt;
  const timestamp = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}
export function mergeConversationMessages(...groups) {
  const byId = new Map();
  for (const message of groups.flat()) byId.set(message._id, message);
  return [...byId.values()].sort(
    (left, right) =>
      messageTimestamp(left) - messageTimestamp(right) || left._id.localeCompare(right._id),
  );
}
export function conversationHistoryDateRange(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const start = new Date(`${date}T00:00:00`);
  if (!Number.isFinite(start.getTime())) return undefined;
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  end.setMilliseconds(end.getMilliseconds() - 1);
  return { dateFrom: start.toISOString(), dateTo: end.toISOString() };
}
export function buildConversationTimeline(messages, now = new Date(), notes = []) {
  const result = [];
  let previousDay = '';
  const entries = [
    ...messages.map((message) => ({
      type: 'message',
      timestamp: messageTimestamp(message),
      message,
    })),
    ...notes.map((note) => ({
      type: 'note',
      timestamp: noteTimestamp(note),
      note,
    })),
  ].sort((left, right) => left.timestamp - right.timestamp);
  entries.forEach((entry, index) => {
    const day = timestampDayKey(entry.timestamp);
    if (day !== previousDay) {
      result.push({
        type: 'day',
        key: `day-${day}-${index}`,
        label: formatConversationDay(entry.timestamp, now),
      });
      previousDay = day;
    }
    if (entry.type === 'note') {
      result.push({
        type: 'note',
        key: `note-${entry.note._id}`,
        note: entry.note,
      });
      return;
    }
    const message = entry.message;
    const previous = entries[index - 1];
    const next = entries[index + 1];
    const previousMessage = previous?.type === 'message' ? previous.message : null;
    const nextMessage = next?.type === 'message' ? next.message : null;
    const joinsPrevious = Boolean(previousMessage && canGroupMessages(previousMessage, message));
    const joinsNext = Boolean(nextMessage && canGroupMessages(message, nextMessage));
    const groupPosition = joinsPrevious
      ? joinsNext
        ? 'middle'
        : 'last'
      : joinsNext
        ? 'first'
        : 'single';
    const mediaGroupId = message.attachment?.mediaGroupId;
    const joinsPreviousMedia = Boolean(
      mediaGroupId &&
      message.direction === 'inbound' &&
      previousMessage?.direction === 'inbound' &&
      previousMessage.attachment?.mediaGroupId === mediaGroupId,
    );
    const joinsNextMedia = Boolean(
      mediaGroupId &&
      message.direction === 'inbound' &&
      nextMessage?.direction === 'inbound' &&
      nextMessage.attachment?.mediaGroupId === mediaGroupId,
    );
    const mediaGroupPosition = joinsPreviousMedia
      ? joinsNextMedia
        ? 'middle'
        : 'last'
      : joinsNextMedia
        ? 'first'
        : 'single';
    result.push({
      type: 'message',
      key: message._id,
      message,
      groupPosition,
      mediaGroupPosition,
      showSender: !joinsPrevious,
    });
  });
  return result;
}
export function parseTelegramMessageEffects(response) {
  const raw = response?.capabilities.messageEffects?.limits?.availableEffects;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return [];
    }
    const effect = candidate;
    if (typeof effect.id !== 'string' || typeof effect.label !== 'string') {
      return [];
    }
    return [
      {
        id: effect.id,
        label: effect.label,
        ...(typeof effect.emoji === 'string' ? { emoji: effect.emoji } : {}),
      },
    ];
  });
}
export function filterConversationMessages(messages, query, filter = 'all', date) {
  const normalized = query.trim().toLocaleLowerCase();
  return messages.filter((message) => {
    if (date && messageDateKey(message) !== date) return false;
    if (!matchesHistoryFilter(message, filter)) return false;
    if (!normalized) return true;
    return [
      message.text,
      message.senderName,
      message.attachment?.fileName,
      message.attachment?.kind,
      message.interactive?.displayText,
      message.interactive?.data,
      message.source,
    ]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalized);
  });
}
export function noteMatchesHistorySearch(note, query, filter, date) {
  if (filter !== 'all') return false;
  if (date && noteDateKey(note) !== date) return false;
  const normalized = query.trim().toLocaleLowerCase();
  return !normalized || `${note.authorName} ${note.text}`.toLocaleLowerCase().includes(normalized);
}
function matchesHistoryFilter(message, filter) {
  switch (filter) {
    case 'media':
      return Boolean(message.attachment && message.attachment.kind !== 'DOCUMENT');
    case 'documents':
      return message.attachment?.kind === 'DOCUMENT';
    case 'links':
      return extractConversationLinks([message]).length > 0;
    case 'automation':
      return ['AUTOMATION', 'BROADCAST', 'SYSTEM'].includes(message.source ?? '');
    case 'manager':
      return message.direction === 'outbound' && message.source === 'CRM';
    case 'failed':
      return message.status === 'failed' || message.status === 'unknown';
    default:
      return true;
  }
}
function messageDateKey(message) {
  const timestamp = messageTimestamp(message);
  return timestamp ? localDateKey(new Date(timestamp)) : '';
}
function noteDateKey(note) {
  const timestamp = noteTimestamp(note);
  return timestamp ? localDateKey(new Date(timestamp)) : '';
}
function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
export function extractConversationLinks(messages) {
  const links = new Set();
  for (const message of messages) {
    const candidates = message.text.match(
      /(?:https?:\/\/|www\.|t\.me\/|(?:[a-z0-9-]+\.)+[a-z]{2,})(?:[^\s<>()]*)?/gi,
    );
    for (const candidate of candidates ?? []) {
      const normalized = normalizeConversationLink(candidate);
      if (normalized) links.add(normalized);
    }
    const previewUrl = normalizeConversationLink(message.linkPreviewOptions?.url ?? '');
    if (previewUrl) links.add(previewUrl);
    for (const row of message.inlineKeyboard ?? []) {
      for (const button of row) {
        const normalized = normalizeConversationLink(button.url ?? '');
        if (normalized) links.add(normalized);
      }
    }
  }
  return [...links];
}
function normalizeConversationLink(value) {
  const trimmed = value.trim().replace(/[.,!?;:'"\]}]+$/, '');
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}
export function interpolateQuickReply(content, values) {
  const unresolved = new Set();
  const text = content.replace(/\{\{\s*([a-z0-9_.-]+)\s*\}\}/gi, (_match, key) => {
    const value = values[key];
    if (value === undefined || value === '') {
      unresolved.add(key);
      return `{{${key}}}`;
    }
    return value;
  });
  return { text, unresolved: [...unresolved] };
}
function canGroupMessages(left, right) {
  if (messageDayKey(left) !== messageDayKey(right)) return false;
  if (left.direction !== right.direction) return false;
  if ((left.source ?? '') !== (right.source ?? '')) return false;
  if ((left.senderUserId ?? '') !== (right.senderUserId ?? '')) return false;
  if ((left.senderName ?? '') !== (right.senderName ?? '')) return false;
  const leftTime = messageTimestamp(left);
  const rightTime = messageTimestamp(right);
  return Boolean(leftTime && rightTime && rightTime - leftTime <= GROUP_WINDOW_MS);
}
function messageDayKey(message) {
  return timestampDayKey(messageTimestamp(message));
}
function noteTimestamp(note) {
  const value = note.createdAt ?? note.updatedAt;
  const timestamp = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}
function timestampDayKey(timestamp) {
  if (!timestamp) return 'unknown';
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}
function formatConversationDay(timestamp, now) {
  if (!timestamp) return 'Unknown date';
  const date = new Date(timestamp);
  const today = startOfDay(now).getTime();
  const target = startOfDay(date).getTime();
  const difference = Math.round((today - target) / 86_400_000);
  if (difference === 0) return 'Today';
  if (difference === 1) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'long',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  }).format(date);
}
function startOfDay(value) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

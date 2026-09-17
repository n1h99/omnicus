// Ported from the CRM conversation renderer; Omnicus API and layout are isolated here.
export function isTelegramCapabilitySupported(response, name) {
  return response?.capabilities[name]?.supported === true;
}
export function toggleComposerEntity(entities, type, start, end) {
  if (start < 0 || end <= start) return entities;
  const existingIndex = entities.findIndex(
    (entity) => entity.type === type && entity.offset === start && entity.length === end - start,
  );
  if (existingIndex >= 0) {
    return entities.filter((_entity, index) => index !== existingIndex);
  }
  return [...entities, { type, offset: start, length: end - start }].sort(
    (left, right) => left.offset - right.offset || left.length - right.length,
  );
}
export function latestMessageOperation(operations, omnicusMessageId) {
  if (!omnicusMessageId) return undefined;
  return operations.find((operation) => operation.omnicusMessageId === omnicusMessageId);
}
export function isProviderOperationPending(operation) {
  return Boolean(operation && ['processing', 'queued', 'unknown'].includes(operation.status));
}
export function canRetryProviderOperation(operation, explicitRetrySupported) {
  return Boolean(
    explicitRetrySupported && operation?.status === 'failed' && operation.providerOperationId,
  );
}
export function getStableRetryClientRequestId(requests, operationId, createId) {
  const existing = requests.get(operationId);
  if (existing) return existing;
  const created = createId();
  requests.set(operationId, created);
  return created;
}

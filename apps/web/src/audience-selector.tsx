import { Select, Typography } from 'antd';

import type { AudienceOptions, AudienceSelection } from './audience-api';

export function AudienceSelector({
  allLabel,
  description,
  disabled = false,
  loading = false,
  onChange,
  options,
  value,
}: {
  allLabel: string;
  description: string;
  disabled?: boolean;
  loading?: boolean;
  onChange: (value: AudienceSelection) => void;
  options?: AudienceOptions;
  value: AudienceSelection;
}) {
  const changeMode = (mode: AudienceSelection['mode']) =>
    onChange({
      mode,
      ...(value.excludeTagIds?.length ? { excludeTagIds: value.excludeTagIds } : {}),
      ...(value.includeTagIds?.length ? { includeTagIds: value.includeTagIds } : {}),
    });

  return (
    <div className="audience-selector">
      <div className="audience-selector-grid">
        <label>
          Recipients
          <Select
            disabled={disabled}
            onChange={changeMode}
            options={[
              { label: allLabel, value: 'ALL_ACTIVE' },
              { label: 'Contact group', value: 'SEGMENT' },
              { label: 'Individual contacts', value: 'CONTACTS' },
            ]}
            value={value.mode}
          />
        </label>
        {value.mode === 'SEGMENT' ? (
          <label>
            Contact group
            <Select<string>
              disabled={disabled}
              loading={loading}
              onChange={(segmentId) => onChange({ ...value, segmentId })}
              optionFilterProp="label"
              options={(options?.segments ?? []).map((item) => ({
                label:
                  item.memberCount === undefined
                    ? item.name
                    : `${item.name} · ${item.memberCount} contact${item.memberCount === 1 ? '' : 's'}`,
                value: item.id,
              }))}
              placeholder="Choose a saved group"
              showSearch
              value={value.segmentId ?? null}
            />
          </label>
        ) : null}
        {value.mode === 'CONTACTS' ? (
          <label className="audience-selector-contacts">
            Individual contacts
            <Select<string[]>
              disabled={disabled}
              loading={loading}
              maxTagCount="responsive"
              mode="multiple"
              onChange={(contactIds) => onChange({ ...value, contactIds })}
              optionFilterProp="label"
              options={(options?.contacts ?? []).map((item) => ({
                label: contactLabel(item),
                ...(item.eligibilityReason ? { title: item.eligibilityReason } : {}),
                value: item.id,
              }))}
              placeholder="Search and select contacts"
              showSearch
              value={value.contactIds ?? []}
            />
          </label>
        ) : null}
        <label>
          Must have tags
          <Select<string[]>
            allowClear
            disabled={disabled}
            maxTagCount="responsive"
            mode="multiple"
            onChange={(includeTagIds) =>
              onChange({
                ...value,
                includeTagIds,
                excludeTagIds: (value.excludeTagIds ?? []).filter(
                  (tagId) => !includeTagIds.includes(tagId),
                ),
              })
            }
            options={(options?.tags ?? []).map((item) => ({
              disabled: Boolean(value.excludeTagIds?.includes(item.id)),
              label: item.name,
              value: item.id,
            }))}
            placeholder="Optional"
            value={value.includeTagIds ?? []}
          />
        </label>
        <label>
          Exclude tags
          <Select<string[]>
            allowClear
            disabled={disabled}
            maxTagCount="responsive"
            mode="multiple"
            onChange={(excludeTagIds) =>
              onChange({
                ...value,
                excludeTagIds,
                includeTagIds: (value.includeTagIds ?? []).filter(
                  (tagId) => !excludeTagIds.includes(tagId),
                ),
              })
            }
            options={(options?.tags ?? []).map((item) => ({
              disabled: Boolean(value.includeTagIds?.includes(item.id)),
              label: item.name,
              value: item.id,
            }))}
            placeholder="Optional"
            value={value.excludeTagIds ?? []}
          />
        </label>
      </div>
      {value.mode === 'SEGMENT' && !value.segmentId ? (
        <Typography.Text type="danger">Choose a contact group.</Typography.Text>
      ) : null}
      {value.mode === 'CONTACTS' && !value.contactIds?.length ? (
        <Typography.Text type="danger">Choose at least one contact.</Typography.Text>
      ) : null}
      <Typography.Text type="secondary">{description}</Typography.Text>
    </div>
  );
}

function contactLabel(contact: AudienceOptions['contacts'][number]) {
  const address = contact.email ?? contact.phone ?? contact.username;
  const label = address ? `${contact.displayName} · ${address}` : contact.displayName;
  return contact.eligibilityReason ? `${label} — ${contact.eligibilityReason}` : label;
}

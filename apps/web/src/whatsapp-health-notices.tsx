import { InfoCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { Button, Collapse, Tag } from 'antd';
import { humanizeStatus } from './humanize';
import { type WhatsAppHealth } from './whatsapp-management-api';

export function WhatsAppHealthNotices({
  health,
  connectionAttention,
}: {
  health: WhatsAppHealth;
  connectionAttention: boolean;
}) {
  const checks = new Map<string, { code: number | null; reason: string; names: string[] }>();
  for (const [name, issue] of Object.entries(health.unavailable)) {
    const key = JSON.stringify([issue.code, issue.reason]);
    const group = checks.get(key);
    if (group) group.names.push(humanizeStatus(name));
    else checks.set(key, { ...issue, names: [humanizeStatus(name)] });
  }

  const issues = new Map<
    string,
    {
      status: string;
      code: number | null;
      description: string;
      solution: string | null;
      names: Set<string>;
      info: Set<string>;
    }
  >();
  for (const entity of health.entities.filter((item) => item.status !== 'AVAILABLE')) {
    const errors = entity.errors.length
      ? entity.errors
      : [{ code: null, description: entity.info.join(' '), solution: null }];
    for (const error of errors) {
      const description = error.description || 'Review this item in WhatsApp Manager.';
      const key = JSON.stringify([entity.status, error.code, description, error.solution]);
      const group = issues.get(key) ?? {
        status: entity.status,
        code: error.code,
        description,
        solution: error.solution,
        names: new Set<string>(),
        info: new Set<string>(),
      };
      group.names.add(humanizeStatus(entity.type ?? 'Account'));
      entity.info.forEach((info) => group.info.add(info));
      issues.set(key, group);
    }
  }

  if (!issues.size && !checks.size && !health.lastError) return null;

  const checkCount = Object.keys(health.unavailable).length;
  return (
    <div className="wa-health-notices">
      {issues.size ? (
        <div className="wa-health-issues">
          {[...issues].map(([key, issue]) => (
            <div
              className={`wa-health-issue${issue.status === 'BLOCKED' ? ' wa-health-issue--blocked' : ''}`}
              key={key}
            >
              <WarningOutlined />
              <div>
                <div className="wa-health-issue-heading">
                  <strong>{[...issue.names].join(', ')}</strong>
                  <Tag color={issue.status === 'BLOCKED' ? 'red' : 'orange'}>
                    {humanizeStatus(issue.status)}
                  </Tag>
                </div>
                <p>{issue.description}</p>
                {issue.solution ? <p className="wa-health-next-step">{issue.solution}</p> : null}
              </div>
            </div>
          ))}
          <Button href={health.managerUrl} target="_blank" rel="noopener noreferrer">
            Open WhatsApp Manager
          </Button>
        </div>
      ) : null}
      {checks.size && !connectionAttention ? (
        <div className="wa-health-check-summary">
          <InfoCircleOutlined />
          <div>
            <strong>Some Meta checks are unavailable</strong>
            <p>
              {checks.size === 1
                ? [...checks.values()][0]!.reason
                : 'Meta could not confirm all channel details. Expand the diagnostics to see which checks need attention.'}
            </p>
          </div>
        </div>
      ) : null}
      <Collapse
        ghost
        className="wa-health-diagnostics"
        items={[
          ...(checks.size || issues.size
            ? [
                {
                  key: 'diagnostics',
                  label: 'Diagnostic details',
                  extra: checkCount ? (
                    <span className="wa-diagnostic-count">
                      {checkCount} {checkCount === 1 ? 'check' : 'checks'} unavailable
                    </span>
                  ) : undefined,
                  children: (
                    <ul className="wa-diagnostic-list">
                      {[...checks].map(([key, issue]) => (
                        <li key={key}>
                          <strong>{issue.names.join(', ')}</strong>
                          <p>{issue.reason}</p>
                          {issue.code !== null ? <small>Meta code: {issue.code}</small> : null}
                        </li>
                      ))}
                      {[...issues].map(([key, issue]) => (
                        <li key={key}>
                          <strong>{[...issue.names].join(', ')}</strong>
                          <p>{issue.description}</p>
                          {[...issue.info]
                            .filter((info) => info !== issue.description)
                            .map((info) => (
                              <p key={info}>{info}</p>
                            ))}
                          {issue.code !== null ? <small>Meta code: {issue.code}</small> : null}
                        </li>
                      ))}
                    </ul>
                  ),
                },
              ]
            : []),
          ...(health.lastError
            ? [
                {
                  key: 'last-delivery-error',
                  label: 'Last recorded delivery error',
                  children: (
                    <div className="wa-delivery-history">
                      <span>
                        {new Date(health.lastError.at).toLocaleString()} ·{' '}
                        {health.lastError.code ?? 'Unknown code'}
                      </span>
                      <p>{health.lastError.guidance}</p>
                      <small>This is a past delivery event, not the current channel status.</small>
                    </div>
                  ),
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}

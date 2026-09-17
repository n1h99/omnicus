import {
  ApiOutlined,
  ContactsOutlined,
  DatabaseOutlined,
  FileImageOutlined,
  MailOutlined,
  RobotOutlined,
  SendOutlined,
  SettingOutlined,
  SafetyCertificateOutlined,
  ToolOutlined,
  TagsOutlined,
  TeamOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Alert, Card, Spin, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';

import { apiRequest, getUserErrorMessage } from '../api';
import { useAuth } from '../auth';
import { hasProjectPermission, useProjectAccess } from '../project-access';
import { StatusText } from '../status-text';
import type { Project } from './projects-page';

interface ProjectDestination {
  description: string;
  icon: ReactNode;
  label: string;
  path: string;
  visible?: boolean;
}

function localeLabel(locale: string) {
  return locale === 'ru' ? 'Russian' : locale === 'en' ? 'English' : locale;
}

export function ProjectDetailPage() {
  const { projectId } = useParams();
  const { accessToken } = useAuth();
  const access = useProjectAccess(projectId);
  const query = useQuery({
    enabled: Boolean(projectId),
    queryFn: () => apiRequest<Project>(`/api/v1/projects/${projectId}`, {}, accessToken),
    queryKey: ['project', projectId, accessToken],
  });
  if (query.isLoading) return <Spin className="route-loading" />;
  if (query.isError || !query.data)
    return (
      <Alert
        message={getUserErrorMessage(query.error, 'Project could not be loaded.')}
        showIcon
        type="error"
      />
    );

  const project = query.data;
  const canManage = hasProjectPermission(access.data, 'project:manage');
  const destinations: ProjectDestination[] = [
    {
      description: 'Roles and project access',
      icon: <TeamOutlined />,
      label: 'Members',
      path: `/projects/${project.id}/members`,
    },
    {
      description: 'Custom roles and permissions',
      icon: <SafetyCertificateOutlined />,
      label: 'Roles',
      path: `/projects/${project.id}/roles`,
    },
    {
      description: 'People and channel identities',
      icon: <ContactsOutlined />,
      label: 'Contacts',
      path: `/projects/${project.id}/contacts`,
    },
    {
      description: 'Project-specific contact labels',
      icon: <TagsOutlined />,
      label: 'Tags',
      path: `/projects/${project.id}/tags`,
    },
    {
      description: 'Manual lists and dynamic broadcast audiences',
      icon: <TeamOutlined />,
      label: 'Contact groups',
      path: `/projects/${project.id}/segments`,
    },
    {
      description: 'Project-specific contact data',
      icon: <DatabaseOutlined />,
      label: 'Custom fields',
      path: `/projects/${project.id}/custom-fields`,
    },
    {
      description: 'Scenarios, versions and executions',
      icon: <RobotOutlined />,
      label: 'Automation',
      path: `/projects/${project.id}/scenarios`,
      visible: hasProjectPermission(access.data, 'automation:read'),
    },
    {
      description: 'Live journeys, outcomes and drop-off reasons',
      icon: <ThunderboltOutlined />,
      label: 'Automation activity',
      path: `/projects/${project.id}/automation-activity`,
      visible: hasProjectPermission(access.data, 'automation:read'),
    },
    {
      description: 'External customer platform connection',
      icon: <ApiOutlined />,
      label: 'CRM integration',
      path: `/projects/${project.id}/crm-config`,
      visible: hasProjectPermission(access.data, 'integrations:manage'),
    },
    {
      description: 'Telegram and WhatsApp connections',
      icon: <SendOutlined />,
      label: 'Channels',
      path: `/projects/${project.id}/channels`,
      visible: hasProjectPermission(access.data, 'channels:read'),
    },
    {
      description: 'Channel broadcasts and delivery',
      icon: <SendOutlined />,
      label: 'Broadcasts',
      path: `/projects/${project.id}/broadcasts`,
      visible: hasProjectPermission(access.data, 'broadcasts:read'),
    },
    {
      description: 'Reusable message content',
      icon: <FileImageOutlined />,
      label: 'Templates',
      path: `/projects/${project.id}/templates`,
      visible: hasProjectPermission(access.data, 'templates:read'),
    },
    {
      description: 'Project media library',
      icon: <FileImageOutlined />,
      label: 'Media',
      path: `/projects/${project.id}/media-assets`,
      visible: hasProjectPermission(access.data, 'media:read'),
    },
    {
      description: 'Email and SMS campaign delivery',
      icon: <MailOutlined />,
      label: 'Email & SMS Broadcast',
      path: `/projects/${project.id}/email-sms-broadcast`,
      visible: hasProjectPermission(access.data, 'broadcasts:read'),
    },
    {
      description: 'Incoming email, conversations and sender addresses',
      icon: <MailOutlined />,
      label: 'Email Inbox',
      path: `/projects/${project.id}/email-inbox`,
      visible: hasProjectPermission(access.data, 'email:read'),
    },
    {
      description: 'Delivery journals, recovery and audit',
      icon: <ToolOutlined />,
      label: 'Operations',
      path: `/projects/${project.id}/operations`,
    },
    {
      description: 'Workspace identity, locale and cloning',
      icon: <SettingOutlined />,
      label: 'Settings',
      path: `/projects/${project.id}/settings`,
      visible: canManage,
    },
  ];
  return (
    <section>
      <div className="page-heading-row">
        <div>
          <Typography.Title level={2}>{project.name}</Typography.Title>
          <Typography.Text type="secondary">{project.slug}</Typography.Text>
        </div>
      </div>

      <Card className="project-overview-card" title="Project overview">
        <div className="project-information-grid">
          <div className="project-information-item">
            <span>Workspace status</span>
            <StatusText status={project.status} />
          </div>
          <div className="project-information-item">
            <span>Project slug</span>
            <strong>{project.slug}</strong>
          </div>
          <div className="project-information-item">
            <span>Timezone</span>
            <strong>{project.timezone}</strong>
          </div>
          <div className="project-information-item">
            <span>Language</span>
            <strong>{localeLabel(project.locale)}</strong>
          </div>
          <div className="project-information-item">
            <span>Created</span>
            <strong>{new Date(project.createdAt).toLocaleDateString()}</strong>
          </div>
          <div className="project-information-item">
            <span>Last updated</span>
            <strong>{new Date(project.updatedAt).toLocaleString()}</strong>
          </div>
          <div className="project-information-item project-information-description">
            <span>Description</span>
            <p>{project.description || 'No project description has been added yet.'}</p>
          </div>
        </div>
      </Card>

      <div className="page-heading project-sections-heading">
        <div>
          <Typography.Title level={3}>Project sections</Typography.Title>
          <Typography.Text type="secondary">
            Open the workspace area you want to manage.
          </Typography.Text>
        </div>
      </div>
      <div className="project-navigation-grid">
        {destinations
          .filter((destination) => destination.visible !== false)
          .map((destination) => (
            <Link className="project-navigation-card" key={destination.path} to={destination.path}>
              <span className="project-navigation-icon">{destination.icon}</span>
              <span>
                <strong>{destination.label}</strong>
                <small>{destination.description}</small>
              </span>
            </Link>
          ))}
      </div>
    </section>
  );
}

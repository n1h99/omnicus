import { Alert, Card, Spin, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';

import { apiRequest, getUserErrorMessage } from '../api';
import { useAuth } from '../auth';
import { useProjectAccess } from '../project-access';
import {
  availableProjectSections,
  projectSectionPath,
  type ProjectSection,
} from '../project-sections';
import { projectSectionIcons } from '../project-section-icons';
import { StatusText } from '../status-text';
import type { Project } from './projects-page';

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
  const sections = availableProjectSections(access.data);
  const sectionCards = (items: ProjectSection[]) => (
    <div className="project-navigation-grid">
      {items.map((section) => (
        <Link
          className="project-navigation-card"
          key={section.key}
          to={projectSectionPath(project.id, section)}
        >
          <span className="project-navigation-icon">{projectSectionIcons[section.key]}</span>
          <span>
            <strong>{section.label}</strong>
            <small>{section.description}</small>
          </span>
        </Link>
      ))}
    </div>
  );
  const administration = sections.filter((section) => section.area === 'administration');
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
          <Typography.Text type="secondary">Your everyday tools, grouped by task.</Typography.Text>
        </div>
      </div>
      {access.isLoading ? (
        <Spin aria-label="Loading project sections" />
      ) : (
        sectionCards(sections.filter((section) => section.area === 'workspace'))
      )}
      {access.isError ? (
        <Alert type="error" showIcon message="Project sections could not be loaded." />
      ) : null}
      {administration.length ? (
        <div className="project-administration">
          <div className="project-administration-heading">Administration</div>
          {sectionCards(administration)}
        </div>
      ) : null}
    </section>
  );
}

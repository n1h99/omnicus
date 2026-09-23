import { Link } from 'react-router';

import type { ProjectSection } from './project-sections';

export function ProjectSectionNav({
  projectId,
  section,
  pathname,
  search,
}: {
  projectId: string;
  section: ProjectSection;
  pathname: string;
  search: string;
}) {
  return (
    <nav className="project-section-tabs" aria-label={`${section.label} sections`}>
      {section.tabs.map((tab) => {
        const path = `/projects/${projectId}/${tab.path}`;
        const active = pathname === path || pathname.startsWith(path + '/');
        return (
          <Link
            key={tab.path}
            // Preserve filters on the list itself; from a detail/editor page the tab returns to its list.
            to={pathname === path ? pathname + search : path}
            aria-current={active ? 'page' : undefined}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

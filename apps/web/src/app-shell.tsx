import {
  AppstoreOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuOutlined,
  MenuUnfoldOutlined,
  RightOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import {
  Breadcrumb,
  Button,
  Drawer,
  Grid,
  Layout,
  Menu,
  Tag,
  Typography,
  type MenuProps,
} from 'antd';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDispatch, useSelector } from 'react-redux';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';

import { useAuth } from './auth';
import { apiRequest } from './api';
import { breadcrumbsFor } from './breadcrumbs';
import { navigationItems } from './navigation';
import { ProfileSettingsModal } from './profile-settings-modal';
import { useProjectAccess } from './project-access';
import { projectSectionIcons } from './project-section-icons';
import { ProjectSectionNav } from './project-section-nav';
import {
  availableProjectSections,
  projectSectionFor,
  projectSectionPath,
} from './project-sections';
import { shellActions, type AppDispatch, type RootState } from './store';
import './project-navigation.css';

const { Content, Header, Sider } = Layout;
const { useBreakpoint } = Grid;

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? 'brand brand--compact' : 'brand'}>
      <span className="brand-mark" aria-hidden="true">
        OM
      </span>
      {!compact && (
        <span className="brand-copy">
          <strong>Omnicus</strong>
          <small>Customer platform</small>
        </span>
      )}
    </div>
  );
}

export function AppShell() {
  const collapsed = useSelector((state: RootState) => state.shell.sidebarCollapsed);
  const dispatch = useDispatch<AppDispatch>();
  const location = useLocation();
  const navigate = useNavigate();
  const { accessToken, identity, logout } = useAuth();
  const screens = useBreakpoint();
  const isMobile = screens.lg === false;
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const projectId = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const projectAccess = useProjectAccess(projectId);
  const sections = useMemo(
    () => availableProjectSections(projectAccess.data),
    [projectAccess.data],
  );
  const currentSection = projectSectionFor(location.pathname);
  const visibleSection = sections.find((section) => section.key === currentSection?.key);
  const availableNavigation = useMemo(() => {
    return navigationItems.filter(
      (item) =>
        !item.permission ||
        identity?.globalRoleNames.includes('super-admin') ||
        identity?.globalPermissions.includes(item.permission),
    );
  }, [identity]);
  const selectedKey = useMemo(
    () =>
      [...availableNavigation]
        .sort((left, right) => right.path.length - left.path.length)
        .find((item) => location.pathname.startsWith(item.path))?.key ?? 'projects',
    [availableNavigation, location.pathname],
  );
  const selectedItem = availableNavigation.find((item) => item.key === selectedKey);
  const accountName =
    [identity?.firstName, identity?.lastName].filter(Boolean).join(' ') || 'Account';
  const accountRole = identity?.globalRoleNames[0]
    ?.split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
  const globalItems = availableNavigation.map(({ icon, key, label, path }) => ({
    icon,
    key,
    label: <Link to={path}>{label}</Link>,
  }));
  const menuPaths = new Map(availableNavigation.map((item) => [item.key, item.path]));
  if (projectId) {
    menuPaths.set('project-overview', `/projects/${projectId}`);
    for (const section of sections) {
      menuPaths.set(
        `section:${section.key}`,
        currentSection?.key === section.key
          ? location.pathname + location.search
          : projectSectionPath(projectId, section),
      );
    }
  }
  const menuItems: MenuProps['items'] = projectId
    ? [
        globalItems.find((item) => item.key === 'projects')!,
        {
          icon: <AppstoreOutlined />,
          key: 'project-overview',
          label: <Link to={`/projects/${projectId}`}>Overview</Link>,
        },
        ...(['workspace', 'administration'] as const).flatMap((area) => {
          const items = sections.filter((section) => section.area === area);
          return items.length
            ? [
                {
                  type: 'group' as const,
                  key: area,
                  label: area === 'workspace' ? 'Workspace' : 'Administration',
                  children: items.map((section) => ({
                    key: `section:${section.key}`,
                    icon: projectSectionIcons[section.key],
                    label: (
                      <Link to={menuPaths.get(`section:${section.key}`)!}>{section.label}</Link>
                    ),
                  })),
                },
              ]
            : [];
        }),
        ...(globalItems.length > 1
          ? [
              {
                key: 'system',
                icon: <SettingOutlined />,
                label: 'System administration',
                children: globalItems.filter((item) => item.key !== 'projects'),
              },
            ]
          : []),
      ]
    : globalItems;
  const project = useQuery({
    enabled: Boolean(projectId),
    queryFn: () => apiRequest<{ name: string }>(`/api/v1/projects/${projectId}`, {}, accessToken),
    queryKey: ['project', projectId, accessToken],
  });
  const breadcrumbs = breadcrumbsFor(location.pathname, project.data?.name, sections);

  const navigation = (
    <>
      <Brand compact={!isMobile && collapsed} />
      <Menu
        aria-label={projectId ? 'Project navigation' : 'Application navigation'}
        className="app-navigation"
        items={menuItems}
        mode="inline"
        onClick={({ key, domEvent }) => {
          setMobileNavigationOpen(false);
          // Links handle pointer clicks/new tabs themselves. Menu rows also need
          // to activate from the keyboard or when their icon is clicked.
          if (domEvent.target instanceof Element && domEvent.target.closest('a')) return;
          const path = menuPaths.get(key);
          if (path) void navigate(path);
        }}
        selectedKeys={[
          projectId
            ? visibleSection
              ? `section:${visibleSection.key}`
              : 'project-overview'
            : selectedKey,
        ]}
      />
      <div className="sidebar-footer">
        {!collapsed || isMobile ? (
          <>
            <span className="sidebar-footer-dot" />
            <span>System online</span>
          </>
        ) : (
          <span className="sidebar-footer-dot" aria-label="System online" />
        )}
      </div>
    </>
  );

  return (
    <Layout className="app-shell">
      {!isMobile && (
        <Sider
          className="app-sidebar"
          collapsed={collapsed}
          collapsedWidth={84}
          collapsible
          trigger={null}
          theme="light"
          width={248}
        >
          {navigation}
        </Sider>
      )}
      <Drawer
        className="mobile-navigation"
        closable={false}
        onClose={() => setMobileNavigationOpen(false)}
        open={isMobile && mobileNavigationOpen}
        placement="left"
        width={280}
      >
        {navigation}
      </Drawer>
      <Layout className="app-main">
        <Header className="app-header">
          <div className="app-header-context">
            <Button
              aria-label={
                isMobile
                  ? 'Open navigation'
                  : collapsed
                    ? 'Expand navigation'
                    : 'Collapse navigation'
              }
              className="navigation-toggle"
              icon={
                isMobile ? (
                  <MenuOutlined />
                ) : collapsed ? (
                  <MenuUnfoldOutlined />
                ) : (
                  <MenuFoldOutlined />
                )
              }
              onClick={() =>
                isMobile ? setMobileNavigationOpen(true) : dispatch(shellActions.toggleSidebar())
              }
              type="text"
            />
            <div>
              <Typography.Text className="header-title">
                {projectId
                  ? (currentSection?.label ?? project.data?.name ?? 'Project')
                  : (selectedItem?.label ?? 'Omnicus')}
              </Typography.Text>
            </div>
          </div>
          <div className="account-toolbar">
            <div className="account-identity-chip">
              <strong>{accountName}</strong>
              {accountRole ? <Tag>{accountRole}</Tag> : null}
            </div>
            <Button icon={<SettingOutlined />} onClick={() => setProfileOpen(true)}>
              Profile
            </Button>
            <Button
              className="sign-out-button"
              icon={<LogoutOutlined />}
              onClick={() => void logout()}
            >
              Sign out
            </Button>
          </div>
        </Header>
        <Content className="app-content">
          <div className="page-frame">
            {breadcrumbs.length > 1 ? (
              <nav aria-label="Breadcrumb" className="app-breadcrumbs">
                <Breadcrumb
                  items={breadcrumbs.map((breadcrumb) => ({
                    title: breadcrumb.path ? (
                      <Link to={breadcrumb.path}>{breadcrumb.label}</Link>
                    ) : (
                      breadcrumb.label
                    ),
                  }))}
                  separator={<RightOutlined />}
                />
              </nav>
            ) : null}
            {projectId && visibleSection ? (
              <ProjectSectionNav
                projectId={projectId}
                section={visibleSection}
                pathname={location.pathname}
                search={location.search}
              />
            ) : null}
            <Outlet />
          </div>
        </Content>
        <ProfileSettingsModal onClose={() => setProfileOpen(false)} open={profileOpen} />
      </Layout>
    </Layout>
  );
}

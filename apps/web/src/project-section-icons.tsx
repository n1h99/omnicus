import {
  ApiOutlined,
  ContactsOutlined,
  FileImageOutlined,
  MessageOutlined,
  RobotOutlined,
  SendOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import type { ReactNode } from 'react';

import type { ProjectSectionKey } from './project-sections';

export const projectSectionIcons: Record<ProjectSectionKey, ReactNode> = {
  conversations: <MessageOutlined />,
  contacts: <ContactsOutlined />,
  broadcasts: <SendOutlined />,
  automation: <RobotOutlined />,
  content: <FileImageOutlined />,
  connections: <ApiOutlined />,
  settings: <SettingOutlined />,
};

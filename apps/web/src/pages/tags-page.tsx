import { DeleteOutlined, EditOutlined, PlusOutlined, TeamOutlined } from '@ant-design/icons';
import { Alert, Button, Drawer, Form, Input, Space, Table, Typography, message } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';

import { apiRequest, getUserErrorMessage } from '../api';
import { useAuth } from '../auth';

interface TagItem {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
}

export function TagsPage() {
  const { projectId } = useParams();
  const { accessToken } = useAuth();
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<TagItem>();
  const [form] = Form.useForm();
  const tags = useQuery({
    enabled: Boolean(projectId),
    queryFn: () => apiRequest<TagItem[]>(`/api/v1/projects/${projectId}/tags`, {}, accessToken),
    queryKey: ['tags', projectId, accessToken],
  });
  const reload = () => cache.invalidateQueries({ queryKey: ['tags', projectId] });
  return (
    <section>
      <div className="page-heading-row">
        <div>
          <Typography.Title level={2}>Tags</Typography.Title>
          <Typography.Text type="secondary">
            Organize contacts with project-specific labels.
          </Typography.Text>
        </div>
        <Space>
          <Link to={`/projects/${projectId}/segments`}>
            <Button icon={<TeamOutlined />}>Contact groups</Button>
          </Link>
          <Button
            icon={<PlusOutlined />}
            onClick={() => {
              form.resetFields();
              setEditing(undefined);
              setOpen(true);
            }}
            type="primary"
          >
            Create tag
          </Button>
        </Space>
      </div>
      {tags.isError ? (
        <Alert
          message={getUserErrorMessage(tags.error, 'Tags could not be loaded.')}
          showIcon
          type="error"
        />
      ) : null}
      <Table<TagItem>
        columns={[
          {
            dataIndex: 'name',
            render: (name, row) => (
              <span className="tag-name-label">
                <span
                  className="tag-color-dot"
                  style={{ backgroundColor: row.color ?? 'var(--primary)' }}
                />
                <strong>{name}</strong>
              </span>
            ),
            title: 'Name',
            width: '30%',
          },
          {
            dataIndex: 'description',
            render: (description: string | null) => (
              <Typography.Text type="secondary">{description || 'No description'}</Typography.Text>
            ),
            title: 'Description',
          },
          {
            align: 'right',
            render: (_, row) => (
              <Space size={8}>
                <Button
                  icon={<EditOutlined />}
                  onClick={() => {
                    form.setFieldsValue(row);
                    setEditing(row);
                    setOpen(true);
                  }}
                  size="small"
                >
                  Edit
                </Button>
                <Button
                  danger
                  icon={<DeleteOutlined />}
                  onClick={async () => {
                    try {
                      await apiRequest(
                        `/api/v1/projects/${projectId}/tags/${row.id}`,
                        { method: 'DELETE' },
                        accessToken,
                      );
                      await reload();
                      void message.success('Tag deleted.');
                    } catch (error) {
                      void message.error(getUserErrorMessage(error, 'Tag could not be deleted.'));
                    }
                  }}
                  size="small"
                >
                  Delete
                </Button>
              </Space>
            ),
            title: 'Actions',
            width: 190,
          },
        ]}
        dataSource={tags.data ?? []}
        loading={tags.isLoading}
        pagination={false}
        rowKey="id"
      />
      <Drawer
        destroyOnHidden
        onClose={() => setOpen(false)}
        open={open}
        title={editing ? 'Edit tag' : 'Create tag'}
        width={440}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values) => {
            try {
              await apiRequest(
                `/api/v1/projects/${projectId}/tags${editing ? `/${editing.id}` : ''}`,
                { body: JSON.stringify(values), method: editing ? 'PATCH' : 'POST' },
                accessToken,
              );
              form.resetFields();
              setOpen(false);
              await reload();
              void message.success(editing ? 'Tag updated.' : 'Tag created.');
            } catch (error) {
              void message.error(getUserErrorMessage(error, 'Tag could not be saved.'));
            }
          }}
        >
          <Form.Item label="Name" name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="Color" name="color" rules={[{ pattern: /^#[0-9A-Fa-f]{6}$/ }]}>
            <Input placeholder="#1677ff" />
          </Form.Item>
          <Form.Item label="Description" name="description">
            <Input.TextArea />
          </Form.Item>
          <Button block htmlType="submit" type="primary">
            {editing ? 'Save changes' : 'Create'}
          </Button>
        </Form>
      </Drawer>
    </section>
  );
}

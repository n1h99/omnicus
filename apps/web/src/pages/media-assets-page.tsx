import { DeleteOutlined, FileOutlined } from '@ant-design/icons';
import { Alert, Button, Modal, Select, Space, Table, Typography, Upload, message } from 'antd';
import { useState } from 'react';
import { useParams } from 'react-router';

import { getUserErrorMessage } from '../api';
import {
  type MediaAsset,
  type MediaKind,
  type MediaValidationChannel,
  useMediaAssets,
  useMediaMutations,
} from '../media-api';
import { hasProjectPermission, useProjectAccess } from '../project-access';
import { StatusText } from '../status-text';

export function MediaAssetsPage() {
  const { projectId } = useParams();
  const assets = useMediaAssets(projectId);
  const mutations = useMediaMutations(projectId);
  const access = useProjectAccess(projectId);
  const canManage = hasProjectPermission(access.data, 'media:manage');
  const [deleteAsset, setDeleteAsset] = useState<MediaAsset>();
  const [deletingAsset, setDeletingAsset] = useState(false);
  const [file, setFile] = useState<File>();
  const [kind, setKind] = useState<MediaKind>('PHOTO');
  const [channel, setChannel] = useState<MediaValidationChannel>('TELEGRAM');
  const upload = async () => {
    if (!file) return;
    try {
      await mutations.upload.mutateAsync({ channel, file, kind });
      setFile(undefined);
      void message.success('File added to the content library.');
    } catch (error) {
      void message.error(getUserErrorMessage(error, 'File could not be added to the content library.'));
    }
  };
  return (
    <section>
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>Content library</Typography.Title>
          <Typography.Text type="secondary">
            Reusable lead magnets, webinar files and campaign materials for email, Telegram,
            WhatsApp broadcasts and automations.
          </Typography.Text>
        </div>
      </div>
      {canManage ? (
        <div className="media-upload-panel surface">
          <div className="media-upload-left-group">
            <Select
              aria-label="Validate media for"
              onChange={(value: MediaValidationChannel) => {
                setChannel(value);
                setFile(undefined);
                if (value === 'WHATSAPP' && ['ANIMATION', 'VIDEO_NOTE'].includes(kind)) {
                  setKind('PHOTO');
                }
              }}
              options={[
                { label: 'For Telegram', value: 'TELEGRAM' },
                { label: 'For WhatsApp', value: 'WHATSAPP' },
              ]}
              value={channel}
            />
            <Select
              onChange={(value: MediaKind) => {
                setKind(value);
                setFile(undefined);
              }}
              options={
                channel === 'WHATSAPP'
                  ? [
                      { label: 'Photo (JPEG/PNG)', value: 'PHOTO' },
                      { label: 'Document (TXT/PDF/Office)', value: 'DOCUMENT' },
                      { label: 'Video (MP4/3GP)', value: 'VIDEO' },
                      { label: 'Audio (AAC/AMR/MP3/M4A/OGG)', value: 'AUDIO' },
                      { label: 'Voice message (OGG/Opus)', value: 'VOICE' },
                      { label: 'Static sticker (WebP)', value: 'STICKER' },
                    ]
                  : [
                      { label: 'Photo (JPEG/PNG/WebP)', value: 'PHOTO' },
                      { label: 'Document (PDF/ZIP)', value: 'DOCUMENT' },
                      { label: 'Video (MP4)', value: 'VIDEO' },
                      { label: 'Audio (MP3/M4A)', value: 'AUDIO' },
                      { label: 'Voice (OGG/MP3/M4A)', value: 'VOICE' },
                      { label: 'Video note (square MP4)', value: 'VIDEO_NOTE' },
                      { label: 'Animation (GIF/MP4)', value: 'ANIMATION' },
                      { label: 'Sticker (WebP/TGS/WebM)', value: 'STICKER' },
                    ]
              }
              value={kind}
            />
            <Upload
              accept={
                kind === 'PHOTO'
                  ? channel === 'WHATSAPP'
                    ? '.jpg,.jpeg,.png'
                    : '.jpg,.jpeg,.png,.webp'
                  : kind === 'DOCUMENT'
                    ? channel === 'WHATSAPP'
                      ? '.txt,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx'
                      : '.pdf,.zip'
                    : kind === 'VOICE'
                      ? channel === 'WHATSAPP'
                        ? '.ogg'
                        : '.ogg,.mp3,.m4a,.mp4'
                      : kind === 'AUDIO'
                        ? channel === 'WHATSAPP'
                          ? '.aac,.amr,.mp3,.m4a,.mp4,.ogg'
                          : '.mp3,.m4a,.mp4'
                        : kind === 'ANIMATION'
                          ? '.gif,.mp4'
                          : kind === 'STICKER'
                            ? channel === 'WHATSAPP'
                              ? '.webp'
                              : '.webp,.tgs,.webm'
                            : channel === 'WHATSAPP'
                              ? '.mp4,.3gp'
                              : '.mp4'
              }
              beforeUpload={(next) => {
                setFile(next);
                return false;
              }}
              maxCount={1}
              showUploadList={false}
            >
              <Button>Select file</Button>
            </Upload>
            {file ? (
              <div className="media-selected-file">
                <FileOutlined />
                <span>{file.name}</span>
                <small>{Math.ceil(file.size / 1024)} KB</small>
                <Button
                  aria-label="Remove selected file"
                  icon={<DeleteOutlined />}
                  onClick={() => setFile(undefined)}
                  size="small"
                  type="text"
                />
              </div>
            ) : null}
            <Button
              disabled={!file}
              loading={mutations.upload.isPending}
              onClick={() => void upload()}
              type="primary"
            >
              Upload
            </Button>
          </div>
          <Typography.Text className="media-upload-limit-note" type="secondary">
            Up to 20 MB per upload
          </Typography.Text>
        </div>
      ) : null}
      {assets.isError ? (
        <Alert
          message={getUserErrorMessage(assets.error, 'Content library could not be loaded.')}
          showIcon
          type="error"
        />
      ) : null}
      <Table<MediaAsset>
        dataSource={assets.data ?? []}
        loading={assets.isLoading}
        rowKey="id"
        columns={[
          {
            dataIndex: 'originalFilename',
            title: 'File',
            render: (value, asset) =>
              value ?? (asset.source === 'WHATSAPP' ? 'WhatsApp media' : 'Telegram media'),
          },
          { dataIndex: 'kind', title: 'Kind' },
          { dataIndex: 'source', title: 'Source' },
          {
            dataIndex: 'validationChannel',
            title: 'Validated for',
            render: (value) =>
              value === 'whatsapp' ? 'WhatsApp' : value === 'telegram' ? 'Telegram' : '—',
          },
          {
            dataIndex: 'status',
            title: 'Status',
            render: (value) => <StatusText status={value} />,
          },
          {
            dataIndex: 'sizeBytes',
            title: 'Size',
            render: (value) => (value ? `${Math.ceil(Number(value) / 1024)} KB` : '—'),
          },
          {
            key: 'actions',
            render: (_, asset) => (
              <Space>
                {asset.status === 'AVAILABLE' ? (
                  <Button
                    onClick={async () => {
                      try {
                        const result = await mutations.signedUrl.mutateAsync(asset.id);
                        window.open(result.url, '_blank', 'noopener,noreferrer');
                      } catch (error) {
                        void message.error(
                          getUserErrorMessage(error, 'Media preview could not be opened.'),
                        );
                      }
                    }}
                    size="small"
                  >
                    Open
                  </Button>
                ) : null}
                {canManage && asset.status === 'PROVIDER_REFERENCE' ? (
                  <Button
                    loading={mutations.materialize.isPending}
                    onClick={async () => {
                      try {
                        await mutations.materialize.mutateAsync(asset.id);
                        void message.success(
                          `Media downloaded from ${asset.source === 'WHATSAPP' ? 'WhatsApp' : 'Telegram'}.`,
                        );
                      } catch (error) {
                        void message.error(
                          getUserErrorMessage(
                            error,
                            `Media could not be downloaded from ${asset.source === 'WHATSAPP' ? 'WhatsApp' : 'Telegram'}.`,
                          ),
                        );
                      }
                    }}
                    size="small"
                  >
                    Download from {asset.source === 'WHATSAPP' ? 'WhatsApp' : 'Telegram'}
                  </Button>
                ) : null}
                {canManage ? (
                  <Button danger onClick={() => setDeleteAsset(asset)} size="small">
                    Delete
                  </Button>
                ) : null}
              </Space>
            ),
            title: 'Actions',
          },
        ]}
      />
      <Modal
        className="account-confirm-modal"
        footer={null}
        onCancel={() => setDeleteAsset(undefined)}
        open={Boolean(deleteAsset)}
        title="Delete this media asset?"
        width={460}
      >
        <Typography.Paragraph type="secondary">
          {deleteAsset
            ? `The selected ${deleteAsset.kind.toLowerCase()} file will be permanently removed.`
            : ''}
        </Typography.Paragraph>
        <div className="modal-form-actions">
          <Button onClick={() => setDeleteAsset(undefined)}>Cancel</Button>
          <Button
            danger
            loading={deletingAsset}
            onClick={async () => {
              if (!deleteAsset) return;
              setDeletingAsset(true);
              try {
                await mutations.remove.mutateAsync(deleteAsset.id);
                void message.success('File deleted from the content library.');
                setDeleteAsset(undefined);
              } catch (error) {
                void message.error(
                  getUserErrorMessage(error, 'File could not be deleted from the content library.'),
                );
              } finally {
                setDeletingAsset(false);
              }
            }}
          >
            Delete media asset
          </Button>
        </div>
      </Modal>
    </section>
  );
}

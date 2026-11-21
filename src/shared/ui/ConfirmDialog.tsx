import React from 'react';
import { Modal, PrimaryButton, TextButton } from 'src/shared/ui/primitives';

interface ConfirmDialogProps {
  isOpen: boolean;
  title?: string;
  message: string;
  type?: 'warning' | 'danger' | 'info';
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

const ConfirmDialog = ({
  isOpen,
  title = 'Confirm action',
  message,
  type = 'warning',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) => (
  <Modal
    open={isOpen}
    onClose={onCancel}
    title={title}
    danger={type === 'danger'}
    closeLabel={cancelText}
    zIndexClass="z-confirm!"
    footer={
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'center' }}>
        <PrimaryButton onClick={onConfirm} danger={type === 'danger'}>
          {confirmText}
        </PrimaryButton>
        <TextButton muted onClick={onCancel}>
          {cancelText}
        </TextButton>
      </div>
    }
  >
    <p
      style={{
        fontSize: '12px',
        color: 'var(--fg-2)',
        lineHeight: 1.55,
        margin: 0,
        whiteSpace: 'pre-wrap',
      }}
    >
      {message}
    </p>
  </Modal>
);

export default React.memo(ConfirmDialog);

import React from 'react';
import { withTranslation, WithTranslation } from 'src/i18n/react';
import { logger } from 'src/utils/logger';

interface ErrorBoundaryProps extends WithTranslation {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.error('ErrorBoundary caught:', error, errorInfo);
  }

  handleReload = () => {
    chrome.runtime.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            padding: 24,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            backgroundColor: 'var(--bg-main)',
            color: 'var(--text-main)',
            fontFamily: 'system-ui, sans-serif',
            textAlign: 'center',
          }}
        >
          <h2 style={{ color: 'var(--error)', marginBottom: 12 }}>
            {this.props.t('error.somethingWrong')}
          </h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 8, fontSize: 13 }}>
            {this.props.t('error.unexpected')}
          </p>
          {this.state.error && (
            <pre
              style={{
                color: 'var(--color-accent)',
                fontSize: 11,
                maxWidth: '90%',
                overflow: 'auto',
                padding: 12,
                backgroundColor: 'var(--bg-card)',
                borderRadius: 8,
                marginBottom: 16,
              }}
            >
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={this.handleReload}
            style={{
              padding: '10px 24px',
              backgroundColor: 'var(--primary)',
              color: 'var(--primary-fg)',
              border: 'none',
              borderRadius: 8,
              fontWeight: 600,
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            {this.props.t('error.reloadExtension')}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default withTranslation()(ErrorBoundary);

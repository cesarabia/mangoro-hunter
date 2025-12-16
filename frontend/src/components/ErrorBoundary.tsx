import React from 'react';

type Props = {
  title?: string;
  children: React.ReactNode;
};

type State = {
  hasError: boolean;
  errorMessage: string | null;
};

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, errorMessage: null };

  static getDerivedStateFromError(error: unknown): State {
    const message = error instanceof Error ? error.message : 'Error inesperado';
    return { hasError: true, errorMessage: message };
  }

  componentDidCatch(error: unknown) {
    // eslint-disable-next-line no-console
    console.error('UI ErrorBoundary caught error', error);
  }

  handleReload = () => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 24 }}>
          <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 8 }}>
            {this.props.title || 'Ocurrió un error en la UI'}
          </div>
          <div style={{ fontSize: 13, color: '#666', marginBottom: 12 }}>
            {this.state.errorMessage || 'Intenta recargar la página.'}
          </div>
          <button
            onClick={this.handleReload}
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid #ccc',
              background: '#fff',
              cursor: 'pointer'
            }}
          >
            Recargar
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}


import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from './api/client';
import { LoginPage } from './pages/LoginPage';
import { InboxPage } from './pages/InboxPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { AgendaPage } from './pages/AgendaPage';
import { ConfigPage } from './pages/ConfigPage';
import { SimulatorPage } from './pages/SimulatorPage';
import { ReviewPage } from './pages/ReviewPage';
import { ErrorBoundary } from './components/ErrorBoundary';
import { CopilotWidget } from './components/CopilotWidget';

type View = 'inbox' | 'inactive' | 'simulator' | 'agenda' | 'config' | 'review';

const decodeUserRole = (token: string | null): string | null => {
  if (!token) return null;
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const decoded = JSON.parse(atob(payload));
    return decoded.role || null;
  } catch {
    return null;
  }
};

export const App: React.FC = () => {
  const [hydrated, setHydrated] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<View>('inbox');
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string; isSandbox?: boolean; role?: string | null }>>([]);
  const [workspaceId, setWorkspaceId] = useState<string>('default');
  const [outboundPolicy, setOutboundPolicy] = useState<string | null>(null);
  const [versionInfo, setVersionInfo] = useState<any | null>(null);
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '';

  useEffect(() => {
    setHydrated(true);
    try {
      const stored = localStorage.getItem('token');
      if (stored) {
        setToken(stored);
      }
      const storedWorkspace = localStorage.getItem('workspaceId');
      if (storedWorkspace) {
        setWorkspaceId(storedWorkspace);
      }
    } catch {
      setToken(null);
    }
  }, []);

  useEffect(() => {
    apiClient
      .get('/api/health')
      .then((data: any) => setVersionInfo(data))
      .catch(() => setVersionInfo(null));
  }, []);

  const userRole = decodeUserRole(token);
  const workspaceRole = useMemo(() => {
    const found = workspaces.find((w) => String(w.id) === String(workspaceId));
    return found?.role || null;
  }, [workspaces, workspaceId]);
  const isAdmin = userRole === 'ADMIN' || ['OWNER', 'ADMIN'].includes(String(workspaceRole || '').toUpperCase());

  useEffect(() => {
    if ((view === 'config' || view === 'agenda' || view === 'simulator' || view === 'review') && !isAdmin) {
      setView('inbox');
    }
  }, [view, isAdmin]);

  const loadWorkspaces = useCallback(async () => {
    if (!token) return;
    try {
      const data = await apiClient.get('/api/workspaces');
      if (Array.isArray(data)) {
        setWorkspaces(data);
        const ids = new Set(data.map((w: any) => String(w.id)));
        if (!ids.has(workspaceId) && data.length > 0) {
          const next = String(data[0].id);
          localStorage.setItem('workspaceId', next);
          setWorkspaceId(next);
        }
      }
    } catch {
      // ignore; workspace switcher will fallback to default
    }
  }, [token, workspaceId]);

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  useEffect(() => {
    if (!token) {
      setOutboundPolicy(null);
      return;
    }
    if (!isAdmin) {
      setOutboundPolicy(null);
      return;
    }
    apiClient
      .get('/api/config/outbound-safety')
      .then((data: any) => setOutboundPolicy(data?.outboundPolicy || null))
      .catch(() => setOutboundPolicy(null));
  }, [token, isAdmin, view]);

  const handleReplayInSimulator = useCallback(
    async (conversationId: string) => {
      if (!isAdmin) return;
      if (!token) return;
      try {
        const res = await apiClient.post(`/api/simulate/replay/${conversationId}`, { sanitizePii: true });
        if (res?.id) {
          localStorage.setItem('simulatorSelectedSessionId', String(res.id));
        }
      } catch (err) {
        console.error(err);
      } finally {
        setView('simulator');
      }
    },
    [isAdmin, token]
  );

  if (!hydrated) {
    return <div style={{ padding: 32 }}>Cargando CRM...</div>;
  }

  if (pathname.startsWith('/privacy')) {
    return <PrivacyPage />;
  }

  const handleLogin = (newToken: string) => {
    localStorage.setItem('token', newToken);
    setToken(newToken);
    if (!localStorage.getItem('workspaceId')) {
      localStorage.setItem('workspaceId', 'default');
      setWorkspaceId('default');
    }
    setView('inbox');
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setToken(null);
    setView('inbox');
  };

  if (!token) {
    return <LoginPage onLogin={handleLogin} />;
  }

  const handleOpenAgenda = () => {
    if (isAdmin) {
      setView('agenda');
    }
  };

  if (view === 'agenda' && isAdmin) {
    return (
      <Layout
        view={view}
        setView={setView}
        onLogout={handleLogout}
        isAdmin={isAdmin}
        workspaces={workspaces}
        workspaceId={workspaceId}
        setWorkspaceId={setWorkspaceId}
        outboundPolicy={outboundPolicy}
        versionInfo={versionInfo}
      >
        <AgendaPage onBack={() => setView('inbox')} />
      </Layout>
    );
  }

  if (view === 'config' && isAdmin) {
    return (
      <Layout
        view={view}
        setView={setView}
        onLogout={handleLogout}
        isAdmin={isAdmin}
        workspaces={workspaces}
        workspaceId={workspaceId}
        setWorkspaceId={setWorkspaceId}
        outboundPolicy={outboundPolicy}
        versionInfo={versionInfo}
      >
        <ConfigPage />
      </Layout>
    );
  }

  if (view === 'simulator' && isAdmin) {
    return (
      <Layout
        view={view}
        setView={setView}
        onLogout={handleLogout}
        isAdmin={isAdmin}
        workspaces={workspaces}
        workspaceId={workspaceId}
        setWorkspaceId={setWorkspaceId}
        outboundPolicy={outboundPolicy}
        versionInfo={versionInfo}
      >
        <SimulatorPage onOpenConversation={(id) => setView('inbox')} />
      </Layout>
    );
  }

  if (view === 'review' && isAdmin) {
    return (
      <Layout
        view={view}
        setView={setView}
        onLogout={handleLogout}
        isAdmin={isAdmin}
        workspaces={workspaces}
        workspaceId={workspaceId}
        setWorkspaceId={setWorkspaceId}
        outboundPolicy={outboundPolicy}
        versionInfo={versionInfo}
      >
        <ReviewPage
          onGoInbox={() => setView('inbox')}
          onGoInactive={() => setView('inactive')}
          onGoAgenda={() => setView('agenda')}
          onGoConfig={() => setView('config')}
          onGoSimulator={(sessionId?: string) => {
            try {
              if (sessionId) localStorage.setItem('simulatorSelectedSessionId', String(sessionId));
            } catch {
              // ignore
            }
            setView('simulator');
          }}
        />
      </Layout>
    );
  }

  return (
    <Layout
      view={view}
      setView={setView}
      onLogout={handleLogout}
      isAdmin={isAdmin}
      workspaces={workspaces}
      workspaceId={workspaceId}
      setWorkspaceId={setWorkspaceId}
      outboundPolicy={outboundPolicy}
      versionInfo={versionInfo}
    >
      <InboxPage
        mode={view === 'inactive' ? 'INACTIVE' : 'INBOX'}
        workspaceId={workspaceId}
        onOpenAgenda={handleOpenAgenda}
        onOpenSimulator={() => setView('simulator')}
        onOpenConfig={() => setView('config')}
        onReplayInSimulator={handleReplayInSimulator}
      />
    </Layout>
  );
};

const Layout: React.FC<{
  view: View;
  setView: (v: View) => void;
  onLogout: () => void;
  isAdmin: boolean;
  workspaces: Array<{ id: string; name: string; isSandbox?: boolean; role?: string | null }>;
  workspaceId: string;
  setWorkspaceId: (id: string) => void;
  outboundPolicy?: string | null;
  versionInfo?: any | null;
  children: React.ReactNode;
}> = ({ view, setView, onLogout, isAdmin, workspaces, workspaceId, setWorkspaceId, outboundPolicy, versionInfo, children }) => {
  const [isNarrow, setIsNarrow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < 980;
  });
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < 980);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const workspaceOptions = useMemo(() => {
    if (workspaces.length > 0) return workspaces;
    return [{ id: 'default', name: 'Hunter Internal' }];
  }, [workspaces]);

  const handleWorkspaceChange = (next: string) => {
    localStorage.setItem('workspaceId', next);
    setWorkspaceId(next);
  };

  const navButton = (target: View, label: string) => (
    <button
      onClick={() => setView(target)}
      style={{
        padding: '4px 10px',
        borderRadius: 6,
        border: '1px solid #ccc',
        background: view === target ? '#111' : '#fff',
        color: view === target ? '#fff' : '#111',
        cursor: 'pointer'
      }}
    >
      {label}
    </button>
  );

  const navItems = useMemo(() => {
    const items: Array<{ view?: View; label: string; adminOnly?: boolean; action?: () => void }> = [
      { view: 'inbox', label: 'Inbox' },
      { view: 'inactive', label: 'Inactivos' },
      { view: 'review', label: 'Ayuda / QA', adminOnly: true },
      { view: 'simulator', label: 'Simulador', adminOnly: true },
      { view: 'agenda', label: 'Agenda', adminOnly: true },
      { view: 'config', label: 'Configuración', adminOnly: true },
      { label: 'Salir', action: onLogout },
    ];
    return items.filter((i) => !i.adminOnly || isAdmin);
  }, [isAdmin, onLogout]);

  const versionStamp = useMemo(() => {
    const sha = typeof versionInfo?.gitSha === 'string' ? versionInfo.gitSha : null;
    const startedAt = typeof versionInfo?.startedAt === 'string' ? versionInfo.startedAt : null;
    const dirty = typeof versionInfo?.repoDirty === 'boolean' ? versionInfo.repoDirty : null;
    const ver = typeof versionInfo?.backendVersion === 'string' ? versionInfo.backendVersion : null;
    const stamp = sha ? `${sha}${dirty ? '*' : ''}` : null;
    const startedLabel = startedAt ? new Date(startedAt).toLocaleString('es-CL') : null;
    const label = stamp ? `build ${stamp}` : ver ? `v${ver}` : null;
    const titleParts = [
      label ? `Version: ${label}` : null,
      startedLabel ? `Started: ${startedLabel}` : null
    ].filter(Boolean);
    return {
      label: label && startedLabel ? `${label} · ${startedLabel}` : label || startedLabel || null,
      title: titleParts.join(' | ') || ''
    };
  }, [versionInfo]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', minHeight: 0 }}>
      <header
        style={{
          padding: '8px 16px',
          borderBottom: '1px solid #eee',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 220 }}>
          <select
            value={workspaceId}
            onChange={(e) => handleWorkspaceChange(e.target.value)}
            style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc', maxWidth: 220 }}
            aria-label="Workspace"
          >
            {workspaceOptions.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          {outboundPolicy ? (
            <button
              type="button"
              onClick={() => {
                if (!isAdmin) return;
                try {
                  localStorage.setItem('configSelectedTab', 'workspace');
                } catch {
                  // ignore
                }
                setView('config');
              }}
              style={{
                padding: '4px 8px',
                borderRadius: 8,
                border: '1px solid #b93800',
                background: outboundPolicy === 'ALLOW_ALL' ? '#fff7f1' : '#b93800',
                color: '#fff',
                fontSize: 12,
                fontWeight: 700,
                whiteSpace: 'nowrap',
                cursor: isAdmin ? 'pointer' : 'default'
              }}
              title="Outbound policy: click para abrir SAFE MODE (Configuración → Workspace)."
            >
              <span style={{ color: outboundPolicy === 'ALLOW_ALL' ? '#b93800' : '#fff' }}>
                {outboundPolicy === 'ALLOW_ALL'
                  ? 'SAFE MODE OFF (allow all)'
                  : `SAFE MODE: ${outboundPolicy === 'BLOCK_ALL' ? 'block all' : 'allowlist only'}`}
              </span>
            </button>
          ) : null}
          {versionStamp.label ? (
            <div
              style={{
                padding: '4px 8px',
                borderRadius: 8,
                border: '1px solid #ddd',
                background: '#fff',
                color: '#111',
                fontSize: 12,
                fontWeight: 600,
                whiteSpace: 'nowrap'
              }}
              title={versionStamp.title}
            >
              {versionStamp.label}
            </div>
          ) : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {!isNarrow ? (
            <>
              {navButton('inbox', 'Inbox')}
              {navButton('inactive', 'Inactivos')}
              {isAdmin && navButton('review', 'Ayuda / QA')}
              {isAdmin && navButton('simulator', 'Simulador')}
              {isAdmin && navButton('agenda', 'Agenda')}
              {isAdmin && navButton('config', 'Configuración')}
              <button
                onClick={onLogout}
                style={{
                  padding: '4px 10px',
                  borderRadius: 6,
                  border: '1px solid #ccc',
                  background: '#fff',
                  cursor: 'pointer'
                }}
              >
                Salir
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setMenuOpen(true)}
                style={{
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: '1px solid #111',
                  background: '#111',
                  color: '#fff',
                  cursor: 'pointer',
                  fontWeight: 800
                }}
                aria-label="Abrir menú"
              >
                Menú
              </button>
              {menuOpen ? (
                <div
                  style={{
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(0,0,0,0.25)',
                    zIndex: 80,
                    display: 'flex',
                    justifyContent: 'flex-end'
                  }}
                  onClick={() => setMenuOpen(false)}
                >
                  <div
                    style={{
                      width: 'min(320px, 92vw)',
                      background: '#fff',
                      borderLeft: '1px solid #eee',
                      padding: 12,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <div style={{ fontWeight: 900 }}>Navegación</div>
                      <button
                        onClick={() => setMenuOpen(false)}
                        style={{ padding: '4px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}
                      >
                        Cerrar
                      </button>
                    </div>
                    {navItems.map((i) => (
                      <button
                        key={i.label}
                        onClick={() => {
                          setMenuOpen(false);
                          if (i.action) return i.action();
                          if (i.view) return setView(i.view);
                        }}
                        style={{
                          textAlign: 'left',
                          padding: '10px 12px',
                          borderRadius: 10,
                          border: '1px solid #eee',
                          background: i.view && view === i.view ? '#111' : '#fff',
                          color: i.view && view === i.view ? '#fff' : '#111',
                          fontWeight: i.view && view === i.view ? 800 : 600,
                          cursor: 'pointer'
                        }}
                      >
                        {i.label}
                      </button>
                    ))}
                    <div style={{ marginTop: 6, fontSize: 12, color: '#666' }}>
                      Workspace: <strong>{workspaceOptions.find((w) => w.id === workspaceId)?.name || workspaceId}</strong>
                    </div>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ErrorBoundary title="No se pudo renderizar la vista">
          {children}
        </ErrorBoundary>
      </div>
      <CopilotWidget
        currentView={view}
        isAdmin={isAdmin}
        onNavigate={(action, ctx) => {
          try {
            if (action.type === 'NAVIGATE' && action.view === 'config' && action.configTab) {
              localStorage.setItem('configSelectedTab', action.configTab);
            }
            if (action.type === 'NAVIGATE' && action.view === 'review') {
              const wantsQa = Boolean(ctx?.conversationId) || /log/i.test(action.label || '');
              localStorage.setItem('reviewTab', wantsQa ? 'qa' : 'help');
              if (ctx?.conversationId) {
                localStorage.setItem('reviewLogTab', 'outbound');
                localStorage.setItem('reviewConversationId', String(ctx.conversationId));
              }
            }
          } catch {
            // ignore
          }
          setView(action.view as any);
        }}
      />
    </div>
  );
};

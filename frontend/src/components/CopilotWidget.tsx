import React, { useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '../api/client';

type GuideStep = { guideId: string; title?: string | null; body?: string | null };

type CopilotAction =
  | {
      type: 'NAVIGATE';
      view: 'inbox' | 'inactive' | 'simulator' | 'agenda' | 'config' | 'review';
      configTab?: string;
      label?: string;
      focusKind?: 'program' | 'automation' | 'phoneLine';
      focusId?: string;
    }
  | {
      type: 'GUIDE';
      title?: string | null;
      steps: GuideStep[];
      label?: string;
    };

type CopilotCommand =
  | { type: 'CREATE_PROGRAM'; name: string; description?: string | null; agentSystemPrompt: string; ref?: string | null; slug?: string | null }
  | { type: 'CREATE_AUTOMATION'; name: string; trigger: string; scopeProgramRef?: string | null; scopeProgramSlug?: string | null; scopeProgramId?: string | null }
  | { type: 'TEMP_OFF_OUTBOUND'; minutes: number }
  | { type: 'RUN_SMOKE_SCENARIOS'; scenarioIds?: string[]; sanitizePii?: boolean }
  | { type: 'DOWNLOAD_REVIEW_PACK' }
  | { type: 'CREATE_PHONE_LINE'; alias: string; waPhoneNumberId: string }
  | { type: 'SET_PHONE_LINE_DEFAULT_PROGRAM'; phoneLineId?: string | null; waPhoneNumberId?: string | null; programId?: string | null; programSlug?: string | null }
  | { type: 'CREATE_OR_UPDATE_USER_MEMBERSHIP'; email: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER'; assignedOnly?: boolean }
  | { type: 'INVITE_USER_BY_EMAIL'; email: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER'; expiresDays?: number };

type CopilotProposal = {
  id: string;
  title: string;
  summary?: string | null;
  commands: CopilotCommand[];
};

type DockSide = 'left' | 'right';
type SizePreset = 'S' | 'M' | 'L';

type CopilotThreadSummary = {
  id: string;
  title?: string | null;
  updatedAt?: string;
  lastRunAt?: string | null;
  lastUserText?: string | null;
};

type CopilotMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  actions?: CopilotAction[];
  proposals?: CopilotProposal[];
  runId?: string | null;
  status?: string | null;
  createdAt: number;
};

export const CopilotWidget: React.FC<{
  currentView: string;
  isAdmin: boolean;
  onNavigate: (action: CopilotAction, context?: { conversationId?: string | null }) => void;
}> = ({ currentView, isAdmin, onNavigate }) => {
  const [open, setOpen] = useState(false);
  const [dockSide, setDockSide] = useState<DockSide>(() => {
    try {
      const stored = localStorage.getItem('copilotDockSide');
      return stored === 'left' || stored === 'right' ? stored : 'right';
    } catch {
      return 'right';
    }
  });
  const [sizePreset, setSizePreset] = useState<SizePreset>(() => {
    try {
      const stored = localStorage.getItem('copilotSizePreset');
      return stored === 'S' || stored === 'M' || stored === 'L' ? stored : 'M';
    } catch {
      return 'M';
    }
  });
  const [showHistory, setShowHistory] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusyRunId, setActionBusyRunId] = useState<string | null>(null);
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [threads, setThreads] = useState<CopilotThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const selectedConversationId = (() => {
    try {
      return localStorage.getItem('selectedConversationId');
    } catch {
      return null;
    }
  })();

  useEffect(() => {
    const update = () => {
      try {
        setIsMobile(window.innerWidth < 820);
      } catch {
        setIsMobile(false);
      }
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [open, messages.length]);

  const loadThreads = async () => {
    setThreadsLoading(true);
    try {
      const res: any = await apiClient.get('/api/copilot/threads');
      const list: CopilotThreadSummary[] = Array.isArray(res) ? res : [];
      setThreads(list);
      const stored = (() => {
        try {
          return localStorage.getItem('copilotThreadId');
        } catch {
          return null;
        }
      })();
      const preferred = stored && list.some((t) => t.id === stored) ? stored : null;
      const next = preferred || (list[0]?.id ?? null);
      if (!threadId && next) setThreadId(next);
    } catch (err: any) {
      setThreads([]);
    } finally {
      setThreadsLoading(false);
    }
  };

  const createThread = async () => {
    try {
      const res: any = await apiClient.post('/api/copilot/threads', { title: null });
      const nextId = typeof res?.id === 'string' ? res.id : null;
      if (nextId) {
        setThreadId(nextId);
        setShowHistory(false);
        await loadThreads();
        await loadThread(nextId);
      } else {
        setThreadId(null);
        setMessages([]);
      }
    } catch (err: any) {
      setError(err.message || 'No se pudo crear un nuevo hilo');
    }
  };

  const archiveThread = async (id: string) => {
    try {
      await apiClient.patch(`/api/copilot/threads/${id}`, { archived: true });
      if (threadId === id) {
        setThreadId(null);
        setMessages([]);
      }
      await loadThreads();
      setShowHistory(true);
    } catch (err: any) {
      setError(err.message || 'No se pudo archivar el hilo');
    }
  };

  const loadThread = async (id: string) => {
    try {
      const detail: any = await apiClient.get(`/api/copilot/threads/${id}`);
      const runs = Array.isArray(detail?.runs) ? detail.runs : [];
      const nextMessages: CopilotMessage[] = [];
      for (const r of runs) {
        const createdAt = r?.createdAt ? new Date(r.createdAt).getTime() : Date.now();
        nextMessages.push({
          id: `run-${r.id}-u`,
          role: 'user',
          text: String(r.inputText || ''),
          createdAt,
        });
        if (r.responseText) {
          const status = typeof r.status === 'string' ? r.status : null;
          nextMessages.push({
            id: `run-${r.id}-a`,
            role: 'assistant',
            text: String(r.responseText || ''),
            actions: Array.isArray(r.actions) ? r.actions : undefined,
            proposals: status === 'PENDING_CONFIRMATION' && Array.isArray(r.proposals) ? r.proposals : undefined,
            runId: typeof r.id === 'string' ? r.id : null,
            status,
            createdAt: createdAt + 1,
          });
        }
      }
      setMessages(nextMessages);
      setError(null);
      try {
        localStorage.setItem('copilotThreadId', id);
      } catch {
        // ignore
      }
    } catch (err: any) {
      setError(err.message || 'No se pudo cargar el historial');
      setMessages([]);
    }
  };

  useEffect(() => {
    if (!open) return;
    loadThreads().catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!threadId) {
      setMessages([]);
      return;
    }
    loadThread(threadId).catch(() => {});
  }, [open, threadId]);

  const pushMessage = (m: Omit<CopilotMessage, 'id' | 'createdAt'>) => {
    setMessages((prev) => [
      ...prev,
      {
        ...m,
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        createdAt: Date.now(),
      },
    ]);
  };

  const downloadWithAuth = async (url: string) => {
    const token = localStorage.getItem('token');
    const workspaceId = localStorage.getItem('workspaceId') || 'default';
    if (!token) throw new Error('No hay sesión.');
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Workspace-Id': workspaceId,
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const dispo = res.headers.get('Content-Disposition') || '';
    const match = dispo.match(/filename=\"?([^\";]+)\"?/i);
    const filename = match?.[1] || 'download.zip';
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(objectUrl);
  };

  const handleAutoNavigate = (res: any, actions: CopilotAction[] | undefined) => {
    if (!res?.autoNavigate) return;
    const list = Array.isArray(actions) ? actions : [];
    if (list.length === 0) return;
    const nav = list.find((a) => a.type === 'NAVIGATE');
    if (nav) onNavigate(nav, { conversationId: selectedConversationId });
    for (const a of list) {
      if (a.type === 'NAVIGATE') continue;
      onNavigate(a, { conversationId: selectedConversationId });
    }
  };

  const confirmProposal = async (runId: string, proposalId: string) => {
    if (!runId || actionBusyRunId) return;
    setActionBusyRunId(runId);
    setError(null);
    try {
      const res: any = await apiClient.post(`/api/copilot/runs/${runId}/confirm`, { proposalId });
      const actions: CopilotAction[] | undefined = Array.isArray(res?.actions) ? res.actions : undefined;
      const resultItems = res?.results?.results;
      const download = Array.isArray(resultItems)
        ? resultItems.find((r: any) => r && r.ok && r.type === 'DOWNLOAD_REVIEW_PACK' && r.downloadUrl)
        : null;
      if (download?.downloadUrl) {
        await downloadWithAuth(String(download.downloadUrl));
      }
      const nextThreadId = typeof res?.threadId === 'string' ? res.threadId : threadId;
      if (nextThreadId) await loadThread(nextThreadId);
      handleAutoNavigate(res, actions);
      await loadThreads();
    } catch (err: any) {
      setError(err.message || 'No se pudo confirmar la acción');
    } finally {
      setActionBusyRunId(null);
    }
  };

  const cancelProposal = async (runId: string) => {
    if (!runId || actionBusyRunId) return;
    setActionBusyRunId(runId);
    setError(null);
    try {
      const res: any = await apiClient.post(`/api/copilot/runs/${runId}/cancel`, {});
      const nextThreadId = typeof res?.threadId === 'string' ? res.threadId : threadId;
      if (nextThreadId) await loadThread(nextThreadId);
      await loadThreads();
    } catch (err: any) {
      setError(err.message || 'No se pudo cancelar la acción');
    } finally {
      setActionBusyRunId(null);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setError(null);
    setLoading(true);
    pushMessage({ role: 'user', text });
    setInput('');
    try {
      const res: any = await apiClient.post('/api/copilot/chat', {
        text,
        view: currentView,
        conversationId: selectedConversationId,
        threadId,
      });
      const replyText = typeof res?.reply === 'string' ? res.reply : 'Ok.';
      const actions: CopilotAction[] | undefined = Array.isArray(res?.actions) ? res.actions : undefined;
      const proposals: CopilotProposal[] | undefined = Array.isArray(res?.proposals) ? res.proposals : undefined;
      const runId = typeof res?.runId === 'string' ? res.runId : null;
      const nextThreadId = typeof res?.threadId === 'string' ? res.threadId : threadId;
      pushMessage({
        role: 'assistant',
        text: replyText,
        ...(actions ? { actions } : {}),
        ...(proposals ? { proposals } : {}),
        runId,
      });
      if (nextThreadId && nextThreadId !== threadId) {
        setThreadId(nextThreadId);
        setShowHistory(false);
      } else if (nextThreadId) {
        // Refresh thread from server to persist actions/logs.
        loadThread(nextThreadId).catch(() => {});
      }
      handleAutoNavigate(res, actions);
      loadThreads().catch(() => {});
    } catch (err: any) {
      setError(err.message || 'No se pudo contactar al Copilot');
      pushMessage({
        role: 'assistant',
        text: 'Tuve un problema para responder. Intenta de nuevo o abre Ayuda / QA para ver logs.',
        actions: isAdmin ? [{ type: 'NAVIGATE', view: 'review', label: 'Abrir Ayuda / QA' }] : undefined,
      });
    } finally {
      setLoading(false);
    }
  };

  const bubbleStyle = (role: 'user' | 'assistant'): React.CSSProperties => ({
    maxWidth: '92%',
    alignSelf: role === 'user' ? 'flex-end' : 'flex-start',
    background: role === 'user' ? '#111' : '#fff',
    color: role === 'user' ? '#fff' : '#111',
    border: role === 'user' ? '1px solid #111' : '1px solid #eee',
    borderRadius: 12,
    padding: '10px 12px',
    fontSize: 13,
    lineHeight: 1.35,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  });

  const widthPx = useMemo(() => {
    if (sizePreset === 'S') return 360;
    if (sizePreset === 'L') return 540;
    return 420;
  }, [sizePreset]);

  const panelStyle: React.CSSProperties = useMemo(() => {
    if (isMobile) {
      return {
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        height: '72vh',
        background: '#fafafa',
        borderTop: '1px solid #eee',
        borderRadius: '14px 14px 0 0',
        zIndex: 59,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      };
    }
    const shared: React.CSSProperties = {
      position: 'fixed',
      top: 56,
      bottom: 0,
      width: `min(${widthPx}px, 92vw)`,
      background: '#fafafa',
      zIndex: 49,
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      overflowX: 'hidden',
    };
    if (dockSide === 'left') {
      return { ...shared, left: 0, borderRight: '1px solid #eee' };
    }
    return { ...shared, right: 0, borderLeft: '1px solid #eee' };
  }, [dockSide, isMobile, widthPx]);

  const floatingButtonStyle: React.CSSProperties = useMemo(() => {
    const isChatView = currentView === 'inbox' || currentView === 'inactive';
    const bottom = isChatView
      ? isMobile
        ? 'calc(env(safe-area-inset-bottom, 0px) + 140px)'
        : 108
      : isMobile
        ? 'calc(env(safe-area-inset-bottom, 0px) + 88px)'
        : 16;
    return {
      position: 'fixed',
      ...(isMobile && isChatView ? { left: 16 } : { right: 16 }),
      bottom,
      zIndex: 60,
      padding: '10px 12px',
      borderRadius: 999,
      border: '1px solid #111',
      background: open ? '#fff' : '#111',
      color: open ? '#111' : '#fff',
      fontWeight: 800,
      cursor: 'pointer',
      boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
    };
  }, [isMobile, open, currentView]);

  const formatThreadWhen = (iso?: string | null) => {
    if (!iso) return '';
    const dt = new Date(iso);
    if (!Number.isFinite(dt.getTime())) return '';
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const thatMidnight = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
    const diffDays = Math.round((midnight - thatMidnight) / (24 * 60 * 60 * 1000));
    const time = dt.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 0) return `Hoy ${time}`;
    if (diffDays === 1) return `Ayer ${time}`;
    return `${dt.toLocaleDateString('es-CL')} ${time}`;
  };

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        style={floatingButtonStyle}
        aria-label="Copilot"
      >
        Copilot
      </button>

      {open ? (
        <div
          style={panelStyle}
        >
          <div style={{ padding: 12, borderBottom: '1px solid #eee', background: '#fff' }}>
            {isMobile ? (
              <div style={{ width: 40, height: 4, borderRadius: 999, background: '#ddd', margin: '0 auto 10px' }} />
            ) : null}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 900, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>Copilot</span>
                  <span style={{ fontSize: 11, color: '#666', fontWeight: 700 }}>(CRM)</span>
                </div>
                <div style={{ fontSize: 12, color: '#666', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {selectedConversationId ? (
                    <span>
                      Contexto: <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{selectedConversationId}</span>
                    </span>
                  ) : (
                    <span>Contexto: (sin conversación seleccionada)</span>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {!isMobile ? (
                  <button
                    onClick={() => {
                      const next = dockSide === 'right' ? 'left' : 'right';
                      setDockSide(next);
                      try {
                        localStorage.setItem('copilotDockSide', next);
                      } catch {
                        // ignore
                      }
                    }}
                    style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                    title="Cambiar lado"
                  >
                    Dock: {dockSide === 'right' ? 'Der' : 'Izq'}
                  </button>
                ) : null}
                {!isMobile ? (
                  <select
                    value={sizePreset}
                    onChange={(e) => {
                      const v = e.target.value as SizePreset;
                      if (v !== 'S' && v !== 'M' && v !== 'L') return;
                      setSizePreset(v);
                      try {
                        localStorage.setItem('copilotSizePreset', v);
                      } catch {
                        // ignore
                      }
                    }}
                    style={{ padding: '6px 8px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                    aria-label="Tamaño Copilot"
                    title="Tamaño"
                  >
                    <option value="S">S</option>
                    <option value="M">M</option>
                    <option value="L">L</option>
                  </select>
                ) : null}
                <button
                  onClick={() => setShowHistory((v) => !v)}
                  style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                  title="Historial"
                >
                  Historial
                </button>
                <button
                  onClick={() => setOpen(false)}
                  style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                >
                  Cerrar
                </button>
              </div>
            </div>

            <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button
                onClick={() => createThread().catch(() => {})}
                style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #111', background: '#111', color: '#fff', fontSize: 12, fontWeight: 800 }}
                title="Nuevo hilo"
              >
                Nuevo
              </button>
              {threadId ? (
                <>
                  <button
                    onClick={() => archiveThread(threadId).catch(() => {})}
                    style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                    title="Archivar hilo (no se borra)"
                  >
                    Archivar
                  </button>
                  <button
                    onClick={async () => {
                      try {
                        const detail: any = await apiClient.get(`/api/copilot/threads/${threadId}`);
                        const blob = new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `copilot-thread-${threadId}.json`;
                        a.click();
                        URL.revokeObjectURL(url);
                      } catch (err: any) {
                        setError(err.message || 'No se pudo exportar el hilo');
                      }
                    }}
                    style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                  >
                    Exportar
                  </button>
                </>
              ) : null}
              <button
                onClick={() => {
                  pushMessage({
                    role: 'assistant',
                    text: 'Puedo ayudarte con Programs, Automations, Simulator y diagnóstico (“¿por qué no respondió?”).',
                    actions: isAdmin ? [{ type: 'NAVIGATE', view: 'review', label: 'Abrir Ayuda / QA' }] : undefined,
                  });
                }}
                style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
              >
                Ayuda rápida
              </button>
              {isAdmin ? (
                <button
                  onClick={() => {
                    const action: CopilotAction = { type: 'NAVIGATE', view: 'review', label: 'Abrir Ayuda / QA' };
                    onNavigate(action, { conversationId: selectedConversationId });
                  }}
                  style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                >
                  Ver logs
                </button>
              ) : null}
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
            {showHistory ? (
              <div
                style={{
                  width: isMobile ? '100%' : 220,
                  borderRight: isMobile ? undefined : '1px solid #eee',
                  borderBottom: isMobile ? '1px solid #eee' : undefined,
                  background: '#fff',
                  overflowY: 'auto',
                  padding: 10,
                }}
              >
                <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
                  {threadsLoading ? 'Cargando…' : `${threads.length} hilos`}
                </div>
                {threads.length === 0 ? (
                  <div style={{ fontSize: 13, color: '#666' }}>Aún no hay hilos. Crea uno con “Nuevo”.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {threads.map((t) => {
                      const active = threadId === t.id;
                      return (
                        <div
                          key={t.id}
                          style={{
                            border: active ? '1px solid #111' : '1px solid #eee',
                            borderRadius: 10,
                            padding: 8,
                            cursor: 'pointer',
                            background: active ? '#fafafa' : '#fff',
                          }}
                          onClick={() => {
                            setThreadId(t.id);
                            setShowHistory(false);
                          }}
                          title={t.title || t.lastUserText || t.id}
                        >
                          <div style={{ fontWeight: 800, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {(t.title || t.lastUserText || 'Sin título').slice(0, 60)}
                          </div>
                          <div style={{ marginTop: 4, fontSize: 12, color: '#666', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <span>{formatThreadWhen(t.updatedAt || t.lastRunAt || null)}</span>
                            <button
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                archiveThread(t.id).catch(() => {});
                              }}
                              style={{ padding: '2px 6px', borderRadius: 8, border: '1px solid #ccc', background: '#fff', fontSize: 11 }}
                              title="Archivar (no se borra)"
                            >
                              Archivar
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}

            {isMobile && showHistory ? null : (
              <div
                ref={listRef}
                style={{
                  flex: 1,
                  overflowY: 'auto',
                  padding: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  overflowX: 'hidden',
                }}
              >
                {messages.length === 0 ? (
                  <div style={{ color: '#666', fontSize: 13 }}>
                    Pregunta algo como:
                    <div style={{ marginTop: 6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                      - ¿Cómo creo un Program?
                      <br />- Llévame a Usuarios
                      <br />- ¿Por qué no respondió?
                    </div>
                  </div>
                ) : null}
                {messages.map((m) => (
                  <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                    <div style={bubbleStyle(m.role)}>{m.text}</div>
                    {m.actions && m.actions.length > 0 ? (
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                        {m.actions.map((a, idx) => (
                          <button
                            key={`${m.id}-a-${idx}`}
                            onClick={() => onNavigate(a, { conversationId: selectedConversationId })}
                            style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                          >
                            {a.label || (a.type === 'GUIDE' ? 'Iniciar guía' : `Ir a ${a.view}`)}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {isAdmin && m.role === 'assistant' && m.proposals && m.proposals.length > 0 && m.runId ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 'min(560px, 92vw)' }}>
                        {m.proposals.map((p) => (
                          <div key={`${m.id}-p-${p.id}`} style={{ border: '1px solid #e5e5e5', borderRadius: 12, padding: 10, background: '#fff' }}>
                            <div style={{ fontWeight: 900, fontSize: 13 }}>{p.title}</div>
                            {p.summary ? <div style={{ marginTop: 6, fontSize: 12, color: '#555', whiteSpace: 'pre-wrap' }}>{p.summary}</div> : null}
                            <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>
                              Comandos: {(Array.isArray(p.commands) ? p.commands : []).map((c) => c.type).join(', ') || '—'}
                            </div>
                            <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                              <button
                                onClick={() => confirmProposal(m.runId || '', p.id).catch(() => {})}
                                disabled={Boolean(actionBusyRunId)}
                                style={{
                                  padding: '6px 10px',
                                  borderRadius: 10,
                                  border: '1px solid #111',
                                  background: '#111',
                                  color: '#fff',
                                  fontSize: 12,
                                  fontWeight: 800,
                                  cursor: actionBusyRunId ? 'not-allowed' : 'pointer',
                                }}
                              >
                                {actionBusyRunId === m.runId ? 'Confirmando…' : 'Confirmar'}
                              </button>
                              <button
                                onClick={() => cancelProposal(m.runId || '').catch(() => {})}
                                disabled={Boolean(actionBusyRunId)}
                                style={{
                                  padding: '6px 10px',
                                  borderRadius: 10,
                                  border: '1px solid #ccc',
                                  background: '#fff',
                                  fontSize: 12,
                                  cursor: actionBusyRunId ? 'not-allowed' : 'pointer',
                                }}
                              >
                                Cancelar
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ padding: 12, borderTop: '1px solid #eee', background: '#fff' }}>
            {error ? <div style={{ marginBottom: 8, color: '#b93800', fontSize: 12 }}>{error}</div> : null}
            <div style={{ display: 'flex', gap: 8 }}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Escribe…"
                style={{ flex: 1, padding: 10, borderRadius: 10, border: '1px solid #ddd', minHeight: 42, maxHeight: 120 }}
                disabled={showHistory}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    send().catch(() => {});
                  }
                }}
              />
              <button
                onClick={() => send().catch(() => {})}
                disabled={loading || !input.trim() || showHistory}
                style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #111', background: '#111', color: '#fff', fontWeight: 800 }}
              >
                {loading ? '…' : 'Enviar'}
              </button>
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: '#777' }}>
              Tip: Ctrl/⌘ + Enter para enviar. {showHistory ? 'Cierra “Historial” para chatear.' : ''}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
};

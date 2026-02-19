import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '../api/client';
import { ConversationList } from '../components/ConversationList';
import { ConversationView } from '../components/ConversationView';

interface Props {
  mode: 'INBOX' | 'INACTIVE';
  workspaceId: string;
  canAssignConversation?: boolean;
  onOpenAgenda?: () => void;
  onOpenSimulator?: () => void;
  onOpenConfig?: () => void;
  onReplayInSimulator?: (conversationId: string) => void;
}

export const InboxPage: React.FC<Props> = ({
  mode,
  workspaceId,
  canAssignConversation,
  onReplayInSimulator
}) => {
  const MOBILE_BREAKPOINT = 768;
  const POLLING_INTERVAL = 7000;
  const STATUS_LABELS: Record<string, string> = {
    NEW: 'Nuevo',
    OPEN: 'En seguimiento',
    CLOSED: 'Cerrado'
  };
  const INACTIVE_STAGES = new Set(['STALE_NO_RESPONSE', 'ARCHIVED', 'DISQUALIFIED']);

  const [conversations, setConversations] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedConversation, setSelectedConversation] = useState<any | null>(null);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newPhone, setNewPhone] = useState('');
  const [newContactName, setNewContactName] = useState('');
  const [newMode, setNewMode] = useState<'RECRUIT' | 'INTERVIEW' | 'OFF'>('RECRUIT');
  const [newStatus, setNewStatus] = useState<'NEW' | 'OPEN' | 'CLOSED'>('NEW');
  const [sendTemplateNow, setSendTemplateNow] = useState(true);
  const [templateOptions, setTemplateOptions] = useState<
    Array<{ name: string; category?: string | null; language?: string | null; status?: string | null; source?: string | null }>
  >([]);
  const [templateOptionsLoading, setTemplateOptionsLoading] = useState(false);
  const [templateOptionsError, setTemplateOptionsError] = useState<string | null>(null);
  const [selectedTemplateName, setSelectedTemplateName] = useState('');
  const [templateDefaults, setTemplateDefaults] = useState<{ recruit?: string; interview?: string }>({});
  const [templateSyncInfo, setTemplateSyncInfo] = useState<{ synced?: boolean; syncError?: string | null }>({});
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [programs, setPrograms] = useState<any[]>([]);
  const selectedIdRef = useRef<string | null>(null);
  const initialSelectionDone = useRef(false);
  const lastBackendErrorRef = useRef<string | null>(null);
  const lastBackendLogAtRef = useRef(0);
  const [isNarrow, setIsNarrow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < MOBILE_BREAKPOINT;
  });
  const [mobilePane, setMobilePane] = useState<'LIST' | 'CHAT'>(() => {
    if (typeof window === 'undefined') return 'CHAT';
    return window.innerWidth < MOBILE_BREAKPOINT ? 'LIST' : 'CHAT';
  });

  const selectionStorageKey = `selectedConversationId:${workspaceId}:${mode}`;
  const draftsStorageKey = `conversationDrafts:${workspaceId}`;

  const [draftsByConversationId, setDraftsByConversationId] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem(draftsStorageKey);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, any>)) {
        if (typeof value === 'string') out[String(key)] = value;
      }
      return out;
    } catch {
      return {};
    }
  });

  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < MOBILE_BREAKPOINT);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [MOBILE_BREAKPOINT]);

  useEffect(() => {
    setMobilePane((prev) => {
      if (!isNarrow) return 'CHAT';
      if (prev === 'CHAT') return 'CHAT';
      return selectedIdRef.current ? 'CHAT' : 'LIST';
    });
  }, [isNarrow]);

  const recordBackendError = useCallback((err: unknown) => {
    const message = err instanceof Error ? err.message : 'Backend no disponible';
    setBackendError('Backend no disponible. Reintentando…');
    const now = Date.now();
    if (message !== lastBackendErrorRef.current || now - lastBackendLogAtRef.current > 60_000) {
      console.error(err);
      lastBackendErrorRef.current = message;
      lastBackendLogAtRef.current = now;
    }
  }, []);

  const clearBackendError = useCallback(() => {
    setBackendError(null);
    lastBackendErrorRef.current = null;
  }, []);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    try {
      if (selectedId) {
        localStorage.setItem(selectionStorageKey, selectedId);
        localStorage.setItem('selectedConversationId', selectedId);
      }
    } catch {
      // ignore
    }
  }, [selectedId, selectionStorageKey]);

  useEffect(() => {
    try {
      localStorage.setItem(draftsStorageKey, JSON.stringify(draftsByConversationId));
    } catch {
      // ignore
    }
  }, [draftsByConversationId, draftsStorageKey]);

  const loadConversations = useCallback(async () => {
    try {
      const data = await apiClient.get('/api/conversations');
      clearBackendError();
      const list = Array.isArray(data) ? data : [];
      const filtered = list.filter((c: any) => {
        const stage = String(c?.conversationStage || c?.stage || '').toUpperCase();
        const isInactive = Boolean(c?.archivedAt) || INACTIVE_STAGES.has(stage);
        return mode === 'INACTIVE' ? isInactive : !isInactive;
      });
      setConversations(filtered);

      const currentSelected = selectedIdRef.current;
      const storedSelected = (() => {
        try {
          return localStorage.getItem(selectionStorageKey) || localStorage.getItem('selectedConversationId');
        } catch {
          return null;
        }
      })();

      if (!initialSelectionDone.current && filtered.length > 0) {
        const preferred =
          storedSelected && filtered.some((c: any) => String(c.id) === String(storedSelected)) ? String(storedSelected) : null;
        if (preferred) {
          initialSelectionDone.current = true;
          selectedIdRef.current = preferred;
          setSelectedId(preferred);
        } else if (!isNarrow) {
          const firstId = filtered[0].id;
          initialSelectionDone.current = true;
          selectedIdRef.current = firstId;
          setSelectedId(firstId);
          setMobilePane('CHAT');
        } else {
          // Mobile: start on list view; user taps a conversation.
          initialSelectionDone.current = true;
          selectedIdRef.current = null;
          setSelectedId(null);
          setMobilePane('LIST');
        }
      }

      if (currentSelected && !filtered.some((conversation: any) => conversation.id === currentSelected)) {
        if (filtered.length > 0 && !isNarrow) {
          const nextId = filtered[0].id;
          initialSelectionDone.current = true;
          selectedIdRef.current = nextId;
          setSelectedId(nextId);
          setMobilePane('CHAT');
        } else {
          selectedIdRef.current = null;
          setSelectedId(null);
          setSelectedConversation(null);
          initialSelectionDone.current = false;
          setMobilePane('LIST');
        }
      }
    } catch (err) {
      recordBackendError(err);
    }
  }, [clearBackendError, recordBackendError, mode, isNarrow, selectionStorageKey]);

  const loadConversation = useCallback(async (id: string) => {
    try {
      const data = await apiClient.get(`/api/conversations/${id}`);
      clearBackendError();
      setSelectedConversation(data);
    } catch (err) {
      recordBackendError(err);
    }
  }, [clearBackendError, recordBackendError]);

  const markConversationRead = useCallback(async (id: string) => {
    try {
      await apiClient.post(`/api/conversations/${id}/mark-read`, {});
    } catch (err) {
      recordBackendError(err);
    }
  }, [recordBackendError]);

  useEffect(() => {
    let isMounted = true;

    const run = async () => {
      if (!isMounted) return;
      await loadConversations();
      const current = selectedIdRef.current;
      if (current) {
        await loadConversation(current);
      }
    };

    run();
    const interval = setInterval(run, POLLING_INTERVAL);
    return () => clearInterval(interval);
  }, [loadConversations, loadConversation]);

  useEffect(() => {
    apiClient
      .get('/api/programs')
      .then((data: any) => setPrograms(Array.isArray(data) ? data : []))
      .catch(() => setPrograms([]));
  }, []);

  useEffect(() => {
    const current = selectedId;
    if (!current) {
      setSelectedConversation(null);
      return;
    }

    markConversationRead(current);
    loadConversation(current);
  }, [selectedId, markConversationRead, loadConversation]);

  const handleSelect = (id: string) => {
    initialSelectionDone.current = true;
    selectedIdRef.current = id;
    setSelectedId(id);
    if (isNarrow) setMobilePane('CHAT');
    try {
      localStorage.setItem(selectionStorageKey, id);
      localStorage.setItem('selectedConversationId', id);
    } catch {
      // ignore
    }
  };

  const handleMessageSent = async () => {
    if (selectedId) {
      await loadConversation(selectedId);
      await loadConversations();
    }
  };

  const resetAddModal = () => {
    setNewPhone('');
    setNewContactName('');
    setNewMode('RECRUIT');
    setNewStatus('NEW');
    setSendTemplateNow(true);
    setTemplateOptions([]);
    setTemplateOptionsError(null);
    setTemplateOptionsLoading(false);
    setSelectedTemplateName('');
    setTemplateDefaults({});
    setTemplateSyncInfo({});
    setCreateError(null);
  };

  const loadTemplateOptions = useCallback(async (mode: 'RECRUIT' | 'INTERVIEW' | 'OFF') => {
    if (mode === 'OFF') {
      setTemplateOptions([]);
      setSelectedTemplateName('');
      setTemplateDefaults({});
      setTemplateSyncInfo({});
      setTemplateOptionsError(null);
      return;
    }
    setTemplateOptionsLoading(true);
    setTemplateOptionsError(null);
    try {
      const data: any = await apiClient.get(`/api/conversations/template-options?mode=${encodeURIComponent(mode)}`);
      const list = Array.isArray(data?.templates) ? data.templates : [];
      setTemplateOptions(list);
      setTemplateDefaults({
        recruit: typeof data?.defaults?.recruit === 'string' ? data.defaults.recruit : '',
        interview: typeof data?.defaults?.interview === 'string' ? data.defaults.interview : '',
      });
      setTemplateSyncInfo({
        synced: Boolean(data?.sync?.synced),
        syncError: typeof data?.sync?.syncError === 'string' ? data.sync.syncError : null,
      });
      const preferred =
        typeof data?.selectedDefault === 'string' && data.selectedDefault.trim()
          ? data.selectedDefault.trim()
          : '';
      setSelectedTemplateName(() => {
        if (preferred && list.some((t: any) => String(t?.name || '').trim() === preferred)) {
          return preferred;
        }
        return list.length > 0 ? String(list[0]?.name || '').trim() : '';
      });
      if (list.length === 0) {
        setTemplateOptionsError('No hay plantillas disponibles/sincronizadas para este workspace.');
      }
    } catch (err: any) {
      setTemplateOptions([]);
      setSelectedTemplateName('');
      setTemplateDefaults({});
      setTemplateSyncInfo({});
      setTemplateOptionsError(err?.message || 'No se pudieron cargar las plantillas.');
    } finally {
      setTemplateOptionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!showAddModal || !sendTemplateNow) return;
    loadTemplateOptions(newMode).catch(() => {});
  }, [showAddModal, sendTemplateNow, newMode, loadTemplateOptions]);

  const handleCreateConversation = async () => {
    if (!newPhone.trim()) {
      setCreateError('Ingresa un número en formato E.164');
      return;
    }
    if (sendTemplateNow && newMode !== 'OFF') {
      const selected = String(selectedTemplateName || '').trim();
      if (!selected) {
        setCreateError('Selecciona una plantilla real para enviar ahora.');
        return;
      }
      if (!templateOptions.some((t) => String(t?.name || '').trim() === selected)) {
        setCreateError('La plantilla seleccionada no está disponible/sincronizada.');
        return;
      }
    }
    setCreatingConversation(true);
    setCreateError(null);
    try {
      const res = await apiClient.post('/api/conversations/create-and-send', {
        phoneE164: newPhone.trim(),
        contactName: newContactName.trim() || null,
        mode: newMode,
        status: newStatus,
        sendTemplateNow,
        templateName: sendTemplateNow && newMode !== 'OFF' ? String(selectedTemplateName || '').trim() : null,
      });
      const convoId = res?.conversationId;
      await loadConversations();
      if (convoId) {
        selectedIdRef.current = convoId;
        setSelectedId(convoId);
        await loadConversation(convoId);
      }
      setShowAddModal(false);
      resetAddModal();
    } catch (err: any) {
      setCreateError(err.message || 'No se pudo crear la conversación');
    } finally {
      setCreatingConversation(false);
    }
  };

  const handleStatusChange = async (status: string) => {
    if (!selectedConversation || selectedConversation.isAdmin || selectedConversation.status === status) return;
    setStatusUpdating(true);
    try {
      await apiClient.patch(`/api/conversations/${selectedConversation.id}/status`, { status });
      await loadConversation(selectedConversation.id);
      await loadConversations();
    } catch (err) {
      console.error(err);
    } finally {
      setStatusUpdating(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflowX: 'hidden' }}>
      <div style={{ padding: isNarrow ? '8px 12px' : '8px 16px', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: isNarrow ? 'wrap' : 'nowrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <strong>{mode === 'INACTIVE' ? 'Inactivos' : 'Inbox'}</strong>
          {backendError && <span style={{ fontSize: 12, color: '#b93800' }}>{backendError}</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setShowAddModal(true)} style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ccc', background: '#fff' }}>
            + Agregar número
          </button>
        </div>
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflowX: 'hidden' }}>
        {isNarrow ? (
          mobilePane === 'CHAT' ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflowX: 'hidden' }}>
              <div style={{ padding: '10px 12px', borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  onClick={() => {
                    setMobilePane('LIST');
                  }}
                  style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff' }}
                >
                  Volver
                </button>
                <div style={{ fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {selectedConversation?.isAdmin ? 'Administrador' : (selectedConversation?.contact?.candidateNameManual || selectedConversation?.contact?.candidateName || selectedConversation?.contact?.displayName || selectedConversation?.contact?.waId || 'Conversación')}
                </div>
              </div>
              {selectedConversation && !selectedConversation.isAdmin ? (
                <div style={{ padding: '10px 12px', borderBottom: '1px solid #eee', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <strong>Estado:</strong>{' '}
                    <span>{STATUS_LABELS[selectedConversation.status] || selectedConversation.status || 'Sin estado'}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      style={{ padding: '4px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}
                      disabled={statusUpdating || selectedConversation.status === 'OPEN'}
                      onClick={() => handleStatusChange('OPEN')}
                    >
                      Seguimiento
                    </button>
                    <button
                      style={{ padding: '4px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}
                      disabled={statusUpdating || selectedConversation.status === 'CLOSED'}
                      onClick={() => handleStatusChange('CLOSED')}
                    >
                      Cerrado
                    </button>
                    <button
                      style={{ padding: '4px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}
                      disabled={statusUpdating || selectedConversation.status === 'NEW'}
                      onClick={() => handleStatusChange('NEW')}
                    >
                      Nuevo
                    </button>
                  </div>
                </div>
              ) : null}
              {selectedId && selectedConversation ? (
                <ConversationView
                  conversation={selectedConversation}
                  onMessageSent={handleMessageSent}
                  programs={programs}
                  onReplayInSimulator={onReplayInSimulator}
                  canAssignConversation={Boolean(canAssignConversation)}
                  draftText={draftsByConversationId[selectedId] || ''}
                  onDraftChange={(value) => {
                    setDraftsByConversationId((prev) => ({
                      ...prev,
                      [selectedId]: value
                    }));
                  }}
                />
              ) : (
                <div style={{ padding: 16, color: '#666' }}>Cargando conversación…</div>
              )}
            </div>
          ) : (
            <ConversationList
              conversations={conversations}
              selectedId={selectedId}
              onSelect={handleSelect}
              fullWidth
            />
          )
        ) : (
          <>
            <ConversationList
              conversations={conversations}
              selectedId={selectedId}
              onSelect={handleSelect}
            />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              {selectedConversation && !selectedConversation.isAdmin && (
                <div style={{ padding: '10px 16px', borderBottom: '1px solid #eee', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <strong>Estado:</strong>{' '}
                    <span>{STATUS_LABELS[selectedConversation.status] || selectedConversation.status || 'Sin estado'}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid #ccc', background: '#fff' }}
                      disabled={statusUpdating || selectedConversation.status === 'OPEN'}
                      onClick={() => handleStatusChange('OPEN')}
                    >
                      Marcar como en seguimiento
                    </button>
                    <button
                      style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid #ccc', background: '#fff' }}
                      disabled={statusUpdating || selectedConversation.status === 'CLOSED'}
                      onClick={() => handleStatusChange('CLOSED')}
                    >
                      Marcar como cerrado
                    </button>
                    <button
                      style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid #ccc', background: '#fff' }}
                      disabled={statusUpdating || selectedConversation.status === 'NEW'}
                      onClick={() => handleStatusChange('NEW')}
                    >
                      Marcar como nuevo
                    </button>
                  </div>
                </div>
              )}
              <ConversationView
                conversation={selectedConversation}
                onMessageSent={handleMessageSent}
                programs={programs}
                onReplayInSimulator={onReplayInSimulator}
                canAssignConversation={Boolean(canAssignConversation)}
                draftText={selectedId ? draftsByConversationId[selectedId] || '' : ''}
                onDraftChange={(value) => {
                  if (!selectedId) return;
                  setDraftsByConversationId((prev) => ({
                    ...prev,
                    [selectedId]: value
                  }));
                }}
              />
            </div>
          </>
        )}
      </div>
      {showAddModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 20
          }}
        >
          <div style={{ background: '#fff', borderRadius: 10, padding: 20, width: 'min(520px, 90vw)', boxShadow: '0 10px 30px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>Agregar número</h3>
              <button onClick={() => { setShowAddModal(false); resetAddModal(); }} style={{ border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer' }}>×</button>
            </div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
              Teléfono (E.164)
              <input
                type="text"
                value={newPhone}
                onChange={e => setNewPhone(e.target.value)}
                placeholder="Ej: 56982345846"
                style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
              Nombre visible (opcional)
              <input
                type="text"
                value={newContactName}
                onChange={e => setNewContactName(e.target.value)}
                placeholder="Ej: Juan Pérez"
                style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
              />
            </label>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, flex: '1 1 200px' }}>
                Modo inicial
                <select
                  value={newMode}
                  onChange={e => setNewMode(e.target.value as 'RECRUIT' | 'INTERVIEW' | 'OFF')}
                  style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                >
                  <option value="RECRUIT">Reclutamiento</option>
                  <option value="INTERVIEW">Entrevista</option>
                  <option value="OFF">Manual</option>
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, flex: '1 1 200px' }}>
                Estado
                <select
                  value={newStatus}
                  onChange={e => setNewStatus(e.target.value as 'NEW' | 'OPEN' | 'CLOSED')}
                  style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                >
                  <option value="NEW">Nuevo</option>
                  <option value="OPEN">Seguimiento</option>
                  <option value="CLOSED">Cerrado</option>
                </select>
              </label>
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={sendTemplateNow}
                onChange={e => {
                  const checked = e.target.checked;
                  setSendTemplateNow(checked);
                  if (checked) {
                    loadTemplateOptions(newMode).catch(() => {});
                  }
                }}
              />
              Enviar plantilla ahora
            </label>
            {sendTemplateNow && newMode !== 'OFF' ? (
              <div style={{ display: 'grid', gap: 8 }}>
                <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
                  Plantilla a enviar (nombre real en Meta)
                  <select
                    value={selectedTemplateName}
                    onChange={(e) => setSelectedTemplateName(e.target.value)}
                    style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                    disabled={templateOptionsLoading || templateOptions.length === 0}
                  >
                    {templateOptions.length === 0 ? (
                      <option value="">
                        {templateOptionsLoading ? 'Cargando plantillas…' : 'Sin plantillas disponibles'}
                      </option>
                    ) : (
                      templateOptions.map((opt) => (
                        <option key={opt.name} value={opt.name}>
                          {opt.name} · {opt.category || 'Sin categoría'} · {opt.language || '—'} · {opt.status || '—'}
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <div style={{ fontSize: 12, color: '#555' }}>
                  Default reclutamiento: <strong>{templateDefaults.recruit || '—'}</strong> · Default entrevista:{' '}
                  <strong>{templateDefaults.interview || '—'}</strong>
                </div>
                {!templateOptionsLoading && templateSyncInfo.synced === false && templateSyncInfo.syncError ? (
                  <div style={{ fontSize: 12, color: '#7a3b00' }}>
                    Catálogo Meta no sincronizado ahora: {templateSyncInfo.syncError}
                  </div>
                ) : null}
                {templateOptionsError ? (
                  <div style={{ fontSize: 12, color: '#b93800' }}>{templateOptionsError}</div>
                ) : null}
              </div>
            ) : null}
            {createError && <div style={{ color: '#b93800', fontSize: 13 }}>{createError}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => { setShowAddModal(false); resetAddModal(); }}
                style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', background: '#fff' }}
                disabled={creatingConversation}
              >
                Cancelar
              </button>
              <button
                onClick={handleCreateConversation}
                disabled={creatingConversation}
                style={{ padding: '8px 14px', borderRadius: 6, border: 'none', background: '#111', color: '#fff' }}
              >
                {creatingConversation ? 'Creando...' : sendTemplateNow ? 'Crear y enviar' : 'Crear'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

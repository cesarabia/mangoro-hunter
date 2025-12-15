import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '../api/client';
import { ConversationList } from '../components/ConversationList';
import { ConversationView } from '../components/ConversationView';

interface Props {
  onLogout: () => void;
  showSettings?: boolean;
  onOpenSettings?: () => void;
  showAgenda?: boolean;
  onOpenAgenda?: () => void;
  enableSimulator?: boolean;
}

export const InboxPage: React.FC<Props> = ({
  onLogout,
  showSettings,
  onOpenSettings,
  showAgenda,
  onOpenAgenda,
  enableSimulator
}) => {
  const POLLING_INTERVAL = 7000;
  const isLocalhost =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
  const STATUS_LABELS: Record<string, string> = {
    NEW: 'Nuevo',
    OPEN: 'En seguimiento',
    CLOSED: 'Cerrado'
  };

  const [conversations, setConversations] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedConversation, setSelectedConversation] = useState<any | null>(null);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [simNumber, setSimNumber] = useState('56982345846');
  const [simMessage, setSimMessage] = useState('Hola, estoy interesad@ en la vacante');
  const [simStatus, setSimStatus] = useState<string | null>(null);
  const [simError, setSimError] = useState<string | null>(null);
  const [simLoading, setSimLoading] = useState(false);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newPhone, setNewPhone] = useState('');
  const [newMode, setNewMode] = useState<'RECRUIT' | 'INTERVIEW' | 'SELLER' | 'OFF'>('RECRUIT');
  const [newStatus, setNewStatus] = useState<'NEW' | 'OPEN' | 'CLOSED'>('NEW');
  const [sendTemplateNow, setSendTemplateNow] = useState(true);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const initialSelectionDone = useRef(false);
  const lastBackendErrorRef = useRef<string | null>(null);
  const lastBackendLogAtRef = useRef(0);

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

  const loadConversations = useCallback(async () => {
    try {
      const data = await apiClient.get('/api/conversations');
      clearBackendError();
      setConversations(data);

      const currentSelected = selectedIdRef.current;

      if (!initialSelectionDone.current && data.length > 0) {
        const firstId = data[0].id;
        initialSelectionDone.current = true;
        selectedIdRef.current = firstId;
        setSelectedId(firstId);
      }

      if (currentSelected && !data.some((conversation: any) => conversation.id === currentSelected)) {
        selectedIdRef.current = null;
        setSelectedId(null);
        setSelectedConversation(null);
        initialSelectionDone.current = false;
      }
    } catch (err) {
      recordBackendError(err);
    }
  }, [clearBackendError, recordBackendError]);

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
  };

  const handleMessageSent = async () => {
    if (selectedId) {
      await loadConversation(selectedId);
      await loadConversations();
    }
  };

  const resetAddModal = () => {
    setNewPhone('');
    setNewMode('RECRUIT');
    setNewStatus('NEW');
    setSendTemplateNow(true);
    setCreateError(null);
  };

  const handleCreateConversation = async () => {
    if (!newPhone.trim()) {
      setCreateError('Ingresa un número en formato E.164');
      return;
    }
    setCreatingConversation(true);
    setCreateError(null);
    try {
      const res = await apiClient.post('/api/conversations/create-and-send', {
        phoneE164: newPhone.trim(),
        mode: newMode,
        status: newStatus,
        sendTemplateNow
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

  const handleSimulate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!simNumber.trim() || !simMessage.trim()) return;
    setSimLoading(true);
    setSimStatus(null);
    setSimError(null);
    try {
      const res = await apiClient.post('/api/simulate/whatsapp', {
        from: simNumber.trim(),
        text: simMessage.trim()
      });
      setSimStatus('Mensaje simulado correctamente');
      setSimMessage('');
      await loadConversations();
      if (res?.conversationId) {
        setSelectedId(res.conversationId);
        await loadConversation(res.conversationId);
      } else if (selectedId) {
        await loadConversation(selectedId);
      }
    } catch (err: any) {
      setSimError(err.message || 'No se pudo simular el mensaje');
    } finally {
      setSimLoading(false);
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', minHeight: 0 }}>
      <header style={{ padding: '8px 16px', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <strong>Hunter CRM v2.5.2</strong>
          {backendError && <span style={{ fontSize: 12, color: '#b93800' }}>{backendError}</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setShowAddModal(true)} style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #ccc' }}>
            + Agregar número
          </button>
          {showAgenda && (
            <button onClick={onOpenAgenda} style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #ccc' }}>
              Agenda
            </button>
          )}
          {showSettings && (
            <button onClick={onOpenSettings} style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #ccc' }}>
              Configuración
            </button>
          )}
          <button onClick={onLogout} style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #ccc' }}>
            Salir
          </button>
        </div>
      </header>
      {enableSimulator && isLocalhost && (
        <section style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', background: '#fafafa', flexShrink: 0 }}>
          <form onSubmit={handleSimulate} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <strong>Simular mensaje de candidato (solo local)</strong>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                type="text"
                value={simNumber}
                onChange={e => setSimNumber(e.target.value)}
                placeholder="Número WhatsApp (ej: 56982345846)"
                style={{ flex: '1 1 180px', minWidth: 160, padding: 8, borderRadius: 4, border: '1px solid #ccc' }}
              />
              <input
                type="text"
                value={simMessage}
                onChange={e => setSimMessage(e.target.value)}
                placeholder="Mensaje del candidato"
                style={{ flex: '2 1 240px', minWidth: 220, padding: 8, borderRadius: 4, border: '1px solid #ccc' }}
              />
              <button
                type="submit"
                disabled={simLoading}
                style={{ padding: '8px 16px', borderRadius: 4, border: 'none', background: '#111', color: '#fff' }}
              >
                {simLoading ? 'Simulando...' : 'Simular mensaje'}
              </button>
            </div>
            <small style={{ color: '#666' }}>
              Usa este panel para generar conversaciones sin depender del webhook de Meta.
            </small>
            {simStatus && <span style={{ color: 'green' }}>{simStatus}</span>}
            {simError && <span style={{ color: 'red' }}>{simError}</span>}
          </form>
        </section>
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
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
          <ConversationView conversation={selectedConversation} onMessageSent={handleMessageSent} />
        </div>
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
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, flex: '1 1 200px' }}>
                Modo inicial
                <select
                  value={newMode}
                  onChange={e => setNewMode(e.target.value as 'RECRUIT' | 'INTERVIEW' | 'SELLER' | 'OFF')}
                  style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                >
                  <option value="RECRUIT">Reclutamiento</option>
                  <option value="INTERVIEW">Entrevista</option>
                  <option value="SELLER">Ventas</option>
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
                onChange={e => setSendTemplateNow(e.target.checked)}
              />
              Enviar plantilla ahora
            </label>
            <div style={{ fontSize: 12, color: '#555' }}>
              Reclutamiento envía <strong>postulacion_completar_1</strong> con el título por defecto. Entrevista envía <strong>entrevista_confirmacion_1</strong> con día/hora/lugar configurados.
            </div>
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

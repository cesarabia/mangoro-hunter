import React, { useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '../api/client';

type CopilotAction =
  | { type: 'NAVIGATE'; view: 'inbox' | 'inactive' | 'simulator' | 'agenda' | 'config' | 'review'; configTab?: string; label?: string };

type CopilotMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  actions?: CopilotAction[];
  createdAt: number;
};

export const CopilotWidget: React.FC<{
  currentView: string;
  isAdmin: boolean;
  onNavigate: (action: CopilotAction, context?: { conversationId?: string | null }) => void;
}> = ({ currentView, isAdmin, onNavigate }) => {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);

  const selectedConversationId = useMemo(() => {
    try {
      return localStorage.getItem('selectedConversationId');
    } catch {
      return null;
    }
  }, [currentView]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [open, messages.length]);

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
      });
      const replyText = typeof res?.reply === 'string' ? res.reply : 'Ok.';
      const actions: CopilotAction[] | undefined = Array.isArray(res?.actions) ? res.actions : undefined;
      pushMessage({ role: 'assistant', text: replyText, ...(actions ? { actions } : {}) });
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

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          position: 'fixed',
          right: 16,
          bottom: 16,
          zIndex: 50,
          padding: '10px 12px',
          borderRadius: 999,
          border: '1px solid #111',
          background: open ? '#fff' : '#111',
          color: open ? '#111' : '#fff',
          fontWeight: 800,
          cursor: 'pointer',
          boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
        }}
        aria-label="Copilot"
      >
        Copilot
      </button>

      {open ? (
        <div
          style={{
            position: 'fixed',
            top: 56,
            right: 0,
            bottom: 0,
            width: 'min(420px, 92vw)',
            background: '#fafafa',
            borderLeft: '1px solid #eee',
            zIndex: 49,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          <div style={{ padding: 12, borderBottom: '1px solid #eee', background: '#fff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <div style={{ fontWeight: 900 }}>Copilot (CRM)</div>
                <div style={{ fontSize: 12, color: '#666' }}>
                  {selectedConversationId ? (
                    <span>
                      Contexto: <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{selectedConversationId}</span>
                    </span>
                  ) : (
                    <span>Contexto: (sin conversación seleccionada)</span>
                  )}
                </div>
              </div>
              <button
                onClick={() => {
                  setMessages([]);
                  setError(null);
                }}
                style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                title="Limpiar chat"
              >
                Limpiar
              </button>
            </div>
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                onClick={() => {
                  pushMessage({
                    role: 'assistant',
                    text: 'Puedo ayudarte con: Programs, Automations, Simulator y diagnóstico (“¿por qué no respondió?”).',
                    actions: isAdmin ? [{ type: 'NAVIGATE', view: 'review', label: 'Abrir Ayuda / QA' }] : undefined,
                  });
                }}
                style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
              >
                ¿Qué puedes hacer?
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

          <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {messages.length === 0 ? (
              <div style={{ color: '#666', fontSize: 13 }}>
                Pregunta algo como:
                <div style={{ marginTop: 6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                  - ¿Cómo creo un Program?
                  <br />- Llévame a Automations
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
                        {a.label || `Ir a ${a.view}`}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <div style={{ padding: 12, borderTop: '1px solid #eee', background: '#fff' }}>
            {error ? <div style={{ marginBottom: 8, color: '#b93800', fontSize: 12 }}>{error}</div> : null}
            <div style={{ display: 'flex', gap: 8 }}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Escribe…"
                style={{ flex: 1, padding: 10, borderRadius: 10, border: '1px solid #ddd', minHeight: 42, maxHeight: 120 }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    send().catch(() => {});
                  }
                }}
              />
              <button
                onClick={() => send().catch(() => {})}
                disabled={loading || !input.trim()}
                style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #111', background: '#111', color: '#fff', fontWeight: 800 }}
              >
                {loading ? '…' : 'Enviar'}
              </button>
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: '#777' }}>Tip: Ctrl/⌘ + Enter para enviar.</div>
          </div>
        </div>
      ) : null}
    </>
  );
};


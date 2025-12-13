import React, { useEffect, useRef, useState } from 'react';
import { apiClient } from '../api/client';

interface ConversationViewProps {
  conversation: any | null;
  onMessageSent: () => void;
}

export const ConversationView: React.FC<ConversationViewProps> = ({ conversation, onMessageSent }) => {
  const [text, setText] = useState('');
  const [loadingSend, setLoadingSend] = useState(false);
  const [loadingAi, setLoadingAi] = useState(false);
  const [modeSaving, setModeSaving] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [templateSending, setTemplateSending] = useState(false);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const previousCountRef = useRef(0);

  useEffect(() => {
    if (!conversation) return;
    setAutoScrollEnabled(true);
    scrollToBottom();
    previousCountRef.current = conversation.messages?.length ?? 0;
    setModeSaving(false);
    setSendError(null);
  }, [conversation?.id]);

  useEffect(() => {
    if (!conversation) return;
    const currentCount = conversation.messages?.length ?? 0;
    if (autoScrollEnabled || previousCountRef.current === 0) {
      scrollToBottom();
    }
    previousCountRef.current = currentCount;
  }, [conversation, conversation?.messages?.length, autoScrollEnabled]);

  const scrollToBottom = () => {
    const container = messagesRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  };

  const handleScroll = () => {
    const container = messagesRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - (container.scrollTop + container.clientHeight);
    setAutoScrollEnabled(distanceFromBottom <= 120);
  };

  const handleSend = async () => {
    if (!conversation || !text.trim()) return;
    setLoadingSend(true);
    try {
      const result = await apiClient.post(`/api/conversations/${conversation.id}/messages`, { text });
      if (result?.sendResult && !result.sendResult.success) {
        alert(
          `Mensaje guardado, pero el envío a WhatsApp falló: ${
            result.sendResult.error || 'Error desconocido'
          }`
        );
      }
      setText('');
      onMessageSent();
      setSendError(null);
    } catch (err: any) {
      setSendError(err.message || 'No se pudo enviar el mensaje');
    } finally {
      setLoadingSend(false);
    }
  };

  const handleModeChange = async (mode: 'RECRUIT' | 'INTERVIEW' | 'OFF') => {
    if (!conversation || conversation.aiMode === mode || modeSaving) return;
    setModeSaving(true);
    try {
      await apiClient.patch(`/api/conversations/${conversation.id}/ai-mode`, { mode });
      onMessageSent();
    } catch (err) {
      console.error(err);
    } finally {
      setModeSaving(false);
    }
  };

  const handleSuggest = async () => {
    if (!conversation) return;
    setLoadingAi(true);
    setSendError(null);
    try {
      const res = await apiClient.post(`/api/conversations/${conversation.id}/ai-suggest`, { draft: text });
      if (res.suggestion) {
        setText(res.suggestion);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudo sugerir';
      setSendError(message);
    } finally {
      setLoadingAi(false);
    }
  };

  if (!conversation) {
    return <div style={{ flex: 1, padding: 16 }}>Selecciona una conversación</div>;
  }

  const isAdmin = Boolean(conversation.isAdmin);
  const displayName = isAdmin
    ? 'Administrador'
    : conversation.contact?.name || conversation.contact?.phone || conversation.contact?.waId;
  const aiMode: 'RECRUIT' | 'INTERVIEW' | 'OFF' = conversation.aiMode || 'RECRUIT';
  const isManualMode = aiMode === 'OFF';
  const within24h = conversation.within24h !== false;
  const templateInterviewInvite = conversation.templates?.templateInterviewInvite || null;
  const templateGeneralFollowup = conversation.templates?.templateGeneralFollowup || null;
  const requiredTemplate =
    aiMode === 'INTERVIEW' ? templateInterviewInvite : templateGeneralFollowup;
  const requiredTemplateLabel =
    aiMode === 'INTERVIEW' ? 'entrevista' : 'seguimiento';
  const modeOptions: Array<{ key: 'RECRUIT' | 'INTERVIEW' | 'OFF'; label: string }> = [
    { key: 'RECRUIT', label: 'Reclutamiento' },
    { key: 'INTERVIEW', label: 'Entrevista' },
    { key: 'OFF', label: 'Manual' }
  ];

  const handleSendTemplate = async () => {
    if (!conversation || !requiredTemplate) return;
    setTemplateSending(true);
    setSendError(null);
    try {
      await apiClient.post(`/api/conversations/${conversation.id}/send-template`, {
        templateName: requiredTemplate
      });
      onMessageSent();
    } catch (err: any) {
      setSendError(err.message || 'No se pudo enviar la plantilla');
    } finally {
      setTemplateSending(false);
    }
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
        <strong>{displayName}</strong>
        {!isAdmin && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 13, marginBottom: 4 }}>Modo del candidato:</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {modeOptions.map(option => (
                <button
                  key={option.key}
                  onClick={() => handleModeChange(option.key)}
                  disabled={modeSaving || aiMode === option.key}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 999,
                    border: aiMode === option.key ? '1px solid #111' : '1px solid #ccc',
                    background: aiMode === option.key ? '#111' : '#fff',
                    color: aiMode === option.key ? '#fff' : '#333',
                    cursor: modeSaving ? 'not-allowed' : 'pointer',
                    fontSize: 12
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div
        ref={messagesRef}
        onScroll={handleScroll}
        style={{ flex: 1, padding: 16, overflowY: 'auto', background: '#fafafa', minHeight: 0 }}
      >
        {conversation.messages.map((m: any) => (
          <div
            key={m.id}
            style={{
              marginBottom: 8,
              display: 'flex',
              justifyContent: m.direction === 'OUTBOUND' ? 'flex-end' : 'flex-start'
            }}
          >
            <div
              style={{
                maxWidth: '70%',
                padding: '8px 10px',
                borderRadius: 12,
                background: m.direction === 'OUTBOUND' ? '#d1e7dd' : '#fff',
                border: '1px solid #eee',
                fontSize: 14
              }}
            >
              {m.text}
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          padding: 12,
          borderTop: '1px solid #eee',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          flexShrink: 0,
          background: '#fff'
        }}
      >
        {!within24h && !isAdmin && (
          <div style={{ fontSize: 13, color: '#b93800' }}>Fuera de ventana 24h. Debes usar una plantilla.</div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <textarea
            style={{ flex: 1, padding: 8, borderRadius: 4, border: '1px solid #ccc', minHeight: 40 }}
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Escribe una respuesta..."
          />
          <button
            onClick={handleSuggest}
            disabled={loadingAi || (isManualMode && !text.trim())}
            style={{ padding: '8px 10px', borderRadius: 4, border: '1px solid #ccc', background: '#eee' }}
          >
            {loadingAi ? 'IA...' : isManualMode ? 'Mejorar' : 'Sugerir'}
          </button>
          <button
            onClick={handleSend}
            disabled={loadingSend || (!within24h && !isAdmin)}
            style={{ padding: '8px 10px', borderRadius: 4, border: 'none', background: '#000', color: '#fff' }}
          >
            {loadingSend ? 'Enviando...' : 'Enviar'}
          </button>
        </div>
        {sendError && <div style={{ color: '#b93800', fontSize: 13 }}>{sendError}</div>}
        {!isAdmin && !within24h && (
          <>
            {requiredTemplate ? (
              <button
                onClick={handleSendTemplate}
                disabled={templateSending}
                style={{ alignSelf: 'flex-start', padding: '6px 12px', borderRadius: 4, border: '1px solid #111', background: '#fff' }}
              >
                {templateSending ? 'Enviando plantilla...' : `Enviar plantilla de ${requiredTemplateLabel}`}
              </button>
            ) : (
              <div style={{ fontSize: 13, color: '#b93800' }}>
                No hay plantilla configurada para {requiredTemplateLabel}. Ve a Configuración → Plantillas WhatsApp.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

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
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const previousCountRef = useRef(0);

  useEffect(() => {
    if (!conversation) return;
    setAutoScrollEnabled(true);
    scrollToBottom();
    previousCountRef.current = conversation.messages?.length ?? 0;
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
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingSend(false);
    }
  };

  const handleSuggest = async () => {
    if (!conversation) return;
    setLoadingAi(true);
    try {
      const res = await apiClient.post(`/api/conversations/${conversation.id}/ai-suggest`, {});
      if (res.suggestion) {
        setText(res.suggestion);
      }
    } catch (err) {
      console.error(err);
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

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
        <strong>{displayName}</strong>
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
      <div style={{ padding: 12, borderTop: '1px solid #eee', display: 'flex', gap: 8, flexShrink: 0, background: '#fff' }}>
        <textarea
          style={{ flex: 1, padding: 8, borderRadius: 4, border: '1px solid #ccc', minHeight: 40 }}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Escribe una respuesta..."
        />
        <button
          onClick={handleSuggest}
          disabled={loadingAi}
          style={{ padding: '8px 10px', borderRadius: 4, border: '1px solid #ccc', background: '#eee' }}
        >
          {loadingAi ? 'IA...' : 'Sugerir'}
        </button>
        <button
          onClick={handleSend}
          disabled={loadingSend}
          style={{ padding: '8px 10px', borderRadius: 4, border: 'none', background: '#000', color: '#fff' }}
        >
          {loadingSend ? 'Enviando...' : 'Enviar'}
        </button>
      </div>
    </div>
  );
};

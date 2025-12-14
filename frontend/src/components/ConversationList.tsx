import React, { useMemo, useState } from 'react';

interface ConversationListProps {
  conversations: any[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const statusLabels: Record<string, string> = {
  NEW: 'Nuevo',
  OPEN: 'En seguimiento',
  CLOSED: 'Cerrado'
};

const statusStyles: Record<string, { background: string; border: string; color: string }> = {
  NEW: { background: '#e6f7ff', border: '#91d5ff', color: '#0958d9' },
  OPEN: { background: '#fffbe6', border: '#ffe58f', color: '#ad6800' },
  CLOSED: { background: '#f6ffed', border: '#b7eb8f', color: '#237804' },
  DEFAULT: { background: '#f5f5f5', border: '#d9d9d9', color: '#333' }
};

const isSuspiciousCandidateName = (value?: string | null) => {
  if (!value) return true;
  const lower = value.toLowerCase();
  const patterns = [
    'hola quiero postular',
    'quiero postular',
    'postular',
    'hola',
    'buenas',
    'no puedo',
    'no me sirve',
    'confirmo',
    'medio dia',
    'mediodia',
    'confirmar',
    'inmediata',
    'inmediato',
    'gracias'
  ];
  if (patterns.some(p => lower.includes(p))) return true;
  if (/\b(cancelar|cancelaci[oó]n|reagend|reprogram|cambiar|modificar|mover)\b/i.test(lower)) return true;
  if (/\b(cv|cb|curric|curr[íi]cul|vitae|adjunt|archivo|documento|imagen|foto|pdf|word|docx)\b/i.test(lower)) return true;
  if (/\b(tengo|adjunto|envio|envi[ée]|enviar|mando|mand[ée]|subo)\b/i.test(lower)) return true;
  if (/(lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)/i.test(value)) return true;
  if (/medio ?d[ií]a/i.test(value)) return true;
  return false;
};

export const ConversationList: React.FC<ConversationListProps> = ({
  conversations,
  selectedId,
  onSelect
}) => {
  const [filter, setFilter] = useState<'ALL' | 'NEW' | 'OPEN' | 'CLOSED'>('ALL');
  const filteredConversations = useMemo(() => {
    if (filter === 'ALL') return conversations;
    return conversations.filter(c => c.status === filter);
  }, [conversations, filter]);

  const filters: Array<{ key: 'ALL' | 'NEW' | 'OPEN' | 'CLOSED'; label: string }> = [
    { key: 'ALL', label: 'Todos' },
    { key: 'NEW', label: 'Nuevos' },
    { key: 'OPEN', label: 'En seguimiento' },
    { key: 'CLOSED', label: 'Cerrados' }
  ];

  return (
    <div
      style={{
        borderRight: '1px solid #eee',
        width: 320,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: '#fff'
      }}
    >
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
        <h2 style={{ margin: 0 }}>Conversaciones</h2>
      </div>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #f2f2f2', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {filters.map(item => (
          <button
            key={item.key}
            onClick={() => setFilter(item.key)}
            style={{
              padding: '4px 10px',
              borderRadius: 999,
              border: filter === item.key ? '1px solid #111' : '1px solid #dcdcdc',
              background: filter === item.key ? '#111' : '#fff',
              color: filter === item.key ? '#fff' : '#333',
              fontSize: 12,
              cursor: 'pointer'
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filteredConversations.length === 0 && (
          <div style={{ padding: '16px', color: '#777', fontSize: 13 }}>No hay conversaciones en este estado.</div>
        )}
        {filteredConversations.map(c => {
          const lastMessage = c.messages?.[0];
          const unreadCount = c.unreadCount || 0;
          const hasUnread = unreadCount > 0;
          const isAdmin = Boolean(c.isAdmin);
          const rawCandidate = c.contact?.candidateName || null;
          const validCandidate = !isAdmin && rawCandidate && !isSuspiciousCandidateName(rawCandidate);
          const waId = c.contact?.waId || c.contact?.phone || '';
          const profileDisplay = c.contact?.displayName || c.contact?.name || '';
          const primaryName = isAdmin
            ? 'Administrador'
            : validCandidate
            ? rawCandidate
            : profileDisplay || waId || 'Sin nombre';
          const statusLabel = statusLabels[c.status] || c.status || 'Sin estado';
          const statusStyle = (statusStyles[c.status] || statusStyles.DEFAULT);
          const previewSource = lastMessage?.transcriptText || lastMessage?.text;
          const preview = previewSource ? previewSource.slice(0, 70) : 'Sin mensajes';
          const showStatus = !isAdmin;
          const noContact = Boolean(c.contact?.noContact);
          return (
            <div
              key={c.id}
              onClick={() => onSelect(c.id)}
              style={{
                padding: '8px 12px',
                cursor: 'pointer',
                background: selectedId === c.id ? '#f0f0f0' : 'transparent',
                borderBottom: '1px solid #f5f5f5'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: hasUnread ? 700 : 600 }}>{primaryName}</span>
                {hasUnread && (
                  <span
                    style={{
                      background: '#ff4d4f',
                      color: '#fff',
                      borderRadius: 999,
                      fontSize: 11,
                      minWidth: 18,
                      height: 18,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '0 6px'
                    }}
                  >
                    {unreadCount}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: '#555' }}>
                {profileDisplay ? `${profileDisplay}` : ''}
                {profileDisplay && waId ? ' · ' : ''}
                {waId ? `+${waId}` : ''}
              </div>
              <div style={{ fontSize: 12, color: hasUnread ? '#111' : '#666', fontWeight: hasUnread ? 600 : 400 }}>
                {preview}
              </div>
              {showStatus && (
                <div style={{ marginTop: 6 }}>
                  {noContact && (
                    <span style={{ background: '#fff1f0', border: '1px solid #ff7875', color: '#a8071a', borderRadius: 999, fontSize: 11, padding: '2px 8px', marginRight: 6 }}>
                      NO CONTACTAR
                    </span>
                  )}
                  <span
                    style={{
                      background: statusStyle.background,
                      border: `1px solid ${statusStyle.border}`,
                      color: statusStyle.color,
                      borderRadius: 999,
                      fontSize: 11,
                      padding: '2px 8px',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {statusLabel}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

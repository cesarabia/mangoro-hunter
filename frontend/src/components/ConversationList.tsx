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
          const displayName = isAdmin ? 'Administrador' : c.contact?.name || c.contact?.waId || c.contact?.phone;
          const waId = !isAdmin && c.contact?.name ? c.contact?.waId || c.contact?.phone : null;
          const statusLabel = isAdmin ? 'Admin' : statusLabels[c.status] || c.status || 'Sin estado';
          const preview = lastMessage?.text ? lastMessage.text.slice(0, 50) : 'Sin mensajes';
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
              <span style={{ fontWeight: hasUnread ? 700 : 600 }}>{displayName}</span>
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
            {waId && <div style={{ fontSize: 11, color: '#777' }}>{waId}</div>}
            <div style={{ fontSize: 12, color: hasUnread ? '#111' : '#666', fontWeight: hasUnread ? 600 : 400 }}>
              {preview} · {statusLabel}
            </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

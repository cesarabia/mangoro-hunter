import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '../api/client';

type NotificationItem = {
  id: string;
  createdAt: string;
  readAt: string | null;
  type: string;
  title: string;
  body: string | null;
  conversationId: string | null;
  conversation?: { id: string; label: string; stage?: string | null; status?: string | null } | null;
};

export const NotificationBell: React.FC<{
  workspaceId: string;
  onOpenConversation?: (conversationId: string) => void;
}> = ({ workspaceId, onOpenConversation }) => {
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data: any = await apiClient.get('/api/notifications?limit=30&includeRead=true');
      setUnreadCount(typeof data?.unreadCount === 'number' ? data.unreadCount : 0);
      setItems(Array.isArray(data?.notifications) ? (data.notifications as NotificationItem[]) : []);
    } catch (err: any) {
      setUnreadCount(0);
      setItems([]);
      setError(err?.message || 'No se pudieron cargar notificaciones');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, workspaceId]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const node = panelRef.current;
      if (!node) return;
      if (node.contains(e.target as any)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const label = useMemo(() => {
    if (unreadCount <= 0) return null;
    if (unreadCount > 99) return '99+';
    return String(unreadCount);
  }, [unreadCount]);

  const markRead = async (id: string) => {
    try {
      await apiClient.patch(`/api/notifications/${encodeURIComponent(id)}/read`, {});
    } catch {
      // ignore
    } finally {
      refresh();
    }
  };

  const markAllRead = async () => {
    try {
      await apiClient.post('/api/notifications/read-all', {});
    } catch {
      // ignore
    } finally {
      refresh();
    }
  };

  const openConversation = async (item: NotificationItem) => {
    if (!item?.id) return;
    await markRead(item.id);
    const conversationId = item.conversationId || item.conversation?.id || null;
    if (conversationId && onOpenConversation) {
      onOpenConversation(conversationId);
      setOpen(false);
    }
  };

  return (
    <div style={{ position: 'relative' }} ref={panelRef}>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          refresh();
        }}
        style={{
          position: 'relative',
          padding: '6px 10px',
          borderRadius: 10,
          border: '1px solid #ddd',
          background: '#fff',
          cursor: 'pointer',
          fontWeight: 800,
          lineHeight: 1,
        }}
        title="Notificaciones"
        aria-label="Notificaciones"
      >
        🔔
        {label ? (
          <span
            style={{
              position: 'absolute',
              top: -6,
              right: -6,
              background: '#b93800',
              color: '#fff',
              borderRadius: 999,
              padding: '2px 6px',
              fontSize: 11,
              fontWeight: 800,
              border: '1px solid #fff',
            }}
          >
            {label}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 8px)',
            width: 'min(420px, 92vw)',
            maxHeight: 'min(520px, 70vh)',
            overflowY: 'auto',
            border: '1px solid #e6e6e6',
            borderRadius: 12,
            background: '#fff',
            boxShadow: '0 10px 30px rgba(0,0,0,0.10)',
            zIndex: 120,
          }}
        >
          <div style={{ padding: 12, borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ fontWeight: 900 }}>Notificaciones</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={refresh}
                style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ddd', background: '#fff', cursor: 'pointer', fontWeight: 800 }}
              >
                Actualizar
              </button>
              <button
                type="button"
                onClick={markAllRead}
                disabled={unreadCount <= 0}
                style={{
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: '1px solid #111',
                  background: unreadCount > 0 ? '#111' : '#f4f4f4',
                  color: unreadCount > 0 ? '#fff' : '#888',
                  cursor: unreadCount > 0 ? 'pointer' : 'default',
                  fontWeight: 900,
                }}
              >
                Marcar todo leído
              </button>
            </div>
          </div>

          <div style={{ padding: 12 }}>
            {loading ? <div style={{ color: '#666' }}>Cargando…</div> : null}
            {error ? <div style={{ color: '#b93800', fontWeight: 700 }}>{error}</div> : null}
            {!loading && !error && items.length === 0 ? <div style={{ color: '#666' }}>No hay notificaciones.</div> : null}

            {!loading && !error ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {items.map((n) => {
                  const unread = !n.readAt;
                  const when = (() => {
                    try {
                      return new Date(n.createdAt).toLocaleString('es-CL');
                    } catch {
                      return n.createdAt;
                    }
                  })();
                  const label = n.conversation?.label || (n.conversationId ? n.conversationId.slice(0, 8) : null) || 'Conversación';
                  return (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => openConversation(n)}
                      style={{
                        textAlign: 'left',
                        padding: 12,
                        borderRadius: 10,
                        border: unread ? '1px solid #b93800' : '1px solid #eee',
                        background: unread ? '#fff7f1' : '#fff',
                        cursor: n.conversationId && onOpenConversation ? 'pointer' : 'default',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                        <div style={{ fontWeight: 900, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {n.title || 'Notificación'}
                        </div>
                        <div style={{ fontSize: 12, color: '#666', whiteSpace: 'nowrap' }}>{when}</div>
                      </div>
                      <div style={{ marginTop: 6, fontWeight: 800 }}>{label}</div>
                      {n.body ? (
                        <div style={{ marginTop: 6, fontSize: 12, color: '#444', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                          {n.body}
                        </div>
                      ) : null}
                      {!n.conversationId ? (
                        <div style={{ marginTop: 6, fontSize: 12, color: '#666' }}>Sin conversación asociada</div>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
};

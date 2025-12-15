import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '../api/client';

interface AgendaPageProps {
  onBack: () => void;
}

type ReservationItem = {
  id: string;
  conversationId: string;
  contactId: string;
  contactWaId: string | null;
  contactName: string | null;
  startAt: string;
  endAt: string;
  timezone: string;
  location: string;
  status: string;
  active: boolean;
  interviewStatus: string | null;
};

type ReservationsResponse = {
  timezone: string;
  slotMinutes: number;
  from: string;
  to: string;
  includeInactive: boolean;
  reservations: ReservationItem[];
};

const toDate = (value: any): Date | null => {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const formatPartsDateKey = (date: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const y = parts.find(p => p.type === 'year')?.value || '';
  const m = parts.find(p => p.type === 'month')?.value || '';
  const d = parts.find(p => p.type === 'day')?.value || '';
  return `${y}-${m}-${d}`;
};

const formatDayLabel = (date: Date, timeZone: string) => {
  return new Intl.DateTimeFormat('es-CL', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: '2-digit'
  }).format(date);
};

const formatTimeLabel = (date: Date, timeZone: string) => {
  return new Intl.DateTimeFormat('es-CL', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
};

export const AgendaPage: React.FC<AgendaPageProps> = ({ onBack }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [data, setData] = useState<ReservationsResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = includeInactive ? '?includeInactive=true' : '';
      const res = (await apiClient.get(`/api/agenda/reservations${qs}`)) as ReservationsResponse;
      setData(res);
    } catch (err: any) {
      setError(err.message || 'No se pudo cargar la agenda');
    } finally {
      setLoading(false);
    }
  }, [includeInactive]);

  useEffect(() => {
    load();
  }, [load]);

  const grouped = useMemo(() => {
    const tz = data?.timezone || 'America/Santiago';
    const reservations = (data?.reservations || []).map(item => ({
      ...item,
      startDate: toDate(item.startAt),
      endDate: toDate(item.endAt)
    }));
    const groups: Array<{ key: string; label: string; items: typeof reservations }> = [];
    for (const reservation of reservations) {
      if (!reservation.startDate) continue;
      const key = formatPartsDateKey(reservation.startDate, tz);
      let group = groups.find(g => g.key === key);
      if (!group) {
        group = { key, label: formatDayLabel(reservation.startDate, tz), items: [] as any };
        groups.push(group);
      }
      group.items.push(reservation as any);
    }
    groups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const group of groups) {
      group.items.sort((a: any, b: any) => {
        const aTime = a.startDate ? a.startDate.getTime() : 0;
        const bTime = b.startDate ? b.startDate.getTime() : 0;
        return aTime - bTime;
      });
    }
    return groups;
  }, [data]);

  const tz = data?.timezone || 'America/Santiago';

  return (
    <div style={{ minHeight: '100vh', background: '#f6f6f6' }}>
      <header
        style={{
          padding: '12px 20px',
          borderBottom: '1px solid #ddd',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <strong>Agenda de entrevistas</strong>
          <span style={{ fontSize: 12, color: '#666' }}>Timezone: {tz}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#333' }}>
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={e => setIncludeInactive(e.target.checked)}
            />
            Ver inactivos
          </label>
          <button
            onClick={load}
            style={{ padding: '6px 12px', borderRadius: 4, border: '1px solid #ccc', background: '#fff' }}
          >
            Refrescar
          </button>
          <button onClick={onBack} style={{ padding: '6px 12px', borderRadius: 4, border: '1px solid #ccc' }}>
            Volver
          </button>
        </div>
      </header>

      <main style={{ maxWidth: 980, margin: '24px auto', padding: '0 16px' }}>
        {loading ? (
          <div style={{ background: '#fff', padding: 20, borderRadius: 8 }}>Cargando agenda...</div>
        ) : error ? (
          <div style={{ background: '#fff', padding: 20, borderRadius: 8, color: '#b93800' }}>{error}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {grouped.length === 0 ? (
              <div style={{ background: '#fff', padding: 20, borderRadius: 8 }}>No hay reservas en el rango.</div>
            ) : (
              grouped.map(group => (
                <section key={group.key} style={{ background: '#fff', borderRadius: 8, overflow: 'hidden' }}>
                  <div style={{ padding: '10px 14px', background: '#fafafa', borderBottom: '1px solid #eee' }}>
                    <strong style={{ textTransform: 'capitalize' }}>{group.label}</strong>
                  </div>
                  <div style={{ width: '100%', overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                      <thead>
                        <tr style={{ textAlign: 'left', background: '#fff' }}>
                          <th style={{ padding: '10px 14px', borderBottom: '1px solid #eee' }}>Hora</th>
                          <th style={{ padding: '10px 14px', borderBottom: '1px solid #eee' }}>Candidato</th>
                          <th style={{ padding: '10px 14px', borderBottom: '1px solid #eee' }}>Lugar</th>
                          <th style={{ padding: '10px 14px', borderBottom: '1px solid #eee' }}>Estado</th>
                          <th style={{ padding: '10px 14px', borderBottom: '1px solid #eee' }}>Activo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.items.map((item: any) => {
                          const startDate = item.startDate as Date | null;
                          const endDate = item.endDate as Date | null;
                          const timeText = startDate ? formatTimeLabel(startDate, tz) : '--:--';
                          const endText = endDate ? formatTimeLabel(endDate, tz) : '';
                          const tooltip = startDate
                            ? `${startDate.toISOString()} (${item.timezone})`
                            : '';
                          const name =
                            item.contactName ||
                            (item.contactWaId ? `+${item.contactWaId}` : 'Sin nombre');
                          return (
                            <tr key={item.id}>
                              <td style={{ padding: '10px 14px', borderBottom: '1px solid #f1f1f1' }} title={tooltip}>
                                {timeText}
                                {endText ? `–${endText}` : ''}
                              </td>
                              <td style={{ padding: '10px 14px', borderBottom: '1px solid #f1f1f1' }}>
                                <div style={{ fontWeight: 600 }}>{name}</div>
                                {item.contactWaId && (
                                  <div style={{ fontSize: 12, color: '#666' }}>+{item.contactWaId}</div>
                                )}
                              </td>
                              <td style={{ padding: '10px 14px', borderBottom: '1px solid #f1f1f1' }}>
                                {item.location}
                              </td>
                              <td style={{ padding: '10px 14px', borderBottom: '1px solid #f1f1f1' }}>
                                <div>{item.status}</div>
                                {item.interviewStatus && (
                                  <div style={{ fontSize: 12, color: '#666' }}>Convo: {item.interviewStatus}</div>
                                )}
                              </td>
                              <td style={{ padding: '10px 14px', borderBottom: '1px solid #f1f1f1' }}>
                                {item.active ? 'Sí' : 'No'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              ))
            )}
          </div>
        )}
      </main>
    </div>
  );
};


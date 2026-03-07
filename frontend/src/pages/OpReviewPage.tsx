import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '../api/client';

type QueueItem = {
  conversationId: string;
  name: string;
  jobRole: string | null;
  roleLabel: string;
  comuna: string | null;
  availability: string | null;
  experience: string | null;
  phone: string | null;
  programName: string | null;
  stage: string;
  applicationState: string | null;
  aiPaused: boolean;
  updatedAt: string | null;
  docs: {
    cv: { required: boolean; count: number };
    carnet: { required: boolean; count: number };
    licencia: { required: boolean; count: number };
    vehiculo: { required: boolean; count: number };
  };
};

type Detail = {
  conversationId: string;
  stage: string;
  applicationState: string | null;
  aiPaused: boolean;
  name: string;
  phone: string | null;
  email: string | null;
  comuna: string | null;
  availability: string | null;
  experience: string | null;
  programName: string | null;
  roleLabel: string;
  docs: {
    cv: { required: boolean; count: number };
    carnet: { required: boolean; count: number };
    licencia: { required: boolean; count: number };
    vehiculo: { required: boolean; count: number };
  };
  documents: Array<{ kind: string; fileName: string; link: string; uploadedAt: string }>;
  summary: string | null;
  summaryUpdatedAt: string | null;
  updatedAt: string | null;
};

const cell: React.CSSProperties = {
  borderBottom: '1px solid #f0f0f0',
  padding: '8px 10px',
  fontSize: 13,
  verticalAlign: 'top',
};

const badge = (ok: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  borderRadius: 999,
  padding: '2px 8px',
  fontSize: 11,
  fontWeight: 700,
  border: ok ? '1px solid #b7eb8f' : '1px solid #ffccc7',
  background: ok ? '#f6ffed' : '#fff1f0',
  color: ok ? '#237804' : '#a8071a',
});

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('token');
  const workspaceId = localStorage.getItem('workspaceId');
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(workspaceId ? { 'X-Workspace-Id': workspaceId } : {}),
  };
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('es-CL');
  } catch {
    return String(value);
  }
}

function docLabel(key: 'cv' | 'carnet' | 'licencia' | 'vehiculo'): string {
  if (key === 'cv') return 'CV';
  if (key === 'carnet') return 'Carnet';
  if (key === 'licencia') return 'Licencia B';
  return 'Docs vehículo';
}

export const OpReviewPage: React.FC = () => {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const loadQueue = useCallback(async (q = '') => {
    setLoading(true);
    setError(null);
    try {
      const data: any = await apiClient.get(`/api/op-review/queue${q ? `?q=${encodeURIComponent(q)}` : ''}`);
      const next = Array.isArray(data?.items) ? data.items : [];
      setItems(next);
      if (!selectedId && next.length > 0) setSelectedId(String(next[0].conversationId));
      if (selectedId && !next.some((it: any) => String(it.conversationId) === String(selectedId))) {
        setSelectedId(next[0] ? String(next[0].conversationId) : null);
      }
    } catch (err: any) {
      setError(err?.message || 'No se pudo cargar la cola de revisión.');
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  const loadDetail = useCallback(async (conversationId: string | null) => {
    if (!conversationId) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    setError(null);
    try {
      const data: any = await apiClient.get(`/api/op-review/${encodeURIComponent(conversationId)}`);
      setDetail(data || null);
    } catch (err: any) {
      setError(err?.message || 'No se pudo cargar el detalle de revisión.');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    loadQueue(query).catch(() => {});
  }, [loadQueue, query]);

  useEffect(() => {
    loadDetail(selectedId).catch(() => {});
  }, [loadDetail, selectedId]);

  const runAction = useCallback(
    async (action: 'ACCEPT' | 'REJECT' | 'BACK_TO_SCREENING' | 'REQUEST_DOC' | 'REGENERATE_SUMMARY') => {
      if (!selectedId || actionLoading) return;
      setActionLoading(action);
      setStatus(null);
      setError(null);
      try {
        await apiClient.post(`/api/op-review/${encodeURIComponent(selectedId)}/action`, { action });
        setStatus(`Acción aplicada: ${action}`);
        await loadQueue(query);
        await loadDetail(selectedId);
      } catch (err: any) {
        setError(err?.message || `No se pudo ejecutar acción ${action}.`);
      } finally {
        setActionLoading(null);
      }
    },
    [selectedId, actionLoading, loadQueue, loadDetail, query],
  );

  const downloadPackage = useCallback(async () => {
    if (!selectedId) return;
    setActionLoading('DOWNLOAD');
    setError(null);
    setStatus(null);
    try {
      const res = await fetch(`/api/op-review/${encodeURIComponent(selectedId)}/package`, {
        headers: authHeaders(),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="?([^";]+)"?/i);
      const filename = match?.[1] || `op-review-${selectedId}.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus('Paquete descargado.');
    } catch (err: any) {
      setError(err?.message || 'No se pudo descargar el paquete.');
    } finally {
      setActionLoading(null);
    }
  }, [selectedId]);

  const docSummary = useMemo(() => {
    const d = detail?.docs;
    if (!d) return [] as string[];
    return (['cv', 'carnet', 'licencia', 'vehiculo'] as const).map((key) => {
      const item = d[key];
      const ok = !item.required || item.count > 0;
      return `${docLabel(key)}: ${ok ? 'OK' : 'Falta'}${item.count > 0 ? ` (${item.count})` : ''}`;
    });
  }, [detail]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', minHeight: 0, height: 'calc(100vh - 72px)' }}>
      <aside style={{ borderRight: '1px solid #ececec', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 16, borderBottom: '1px solid #efefef' }}>
          <div style={{ fontSize: 20, fontWeight: 800 }}>Revisión operación</div>
          <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
            Casos listos para validación operativa antes de entrevista.
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por nombre, teléfono o caseId"
            style={{ marginTop: 10, width: '100%', border: '1px solid #d9d9d9', borderRadius: 8, padding: '8px 10px' }}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? <div style={{ padding: 16, color: '#666' }}>Cargando...</div> : null}
          {!loading && items.length === 0 ? <div style={{ padding: 16, color: '#666' }}>No hay casos en OP_REVIEW.</div> : null}
          {items.map((item) => {
            const selected = String(selectedId || '') === String(item.conversationId);
            return (
              <button
                key={item.conversationId}
                onClick={() => setSelectedId(item.conversationId)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  border: 'none',
                  borderBottom: '1px solid #f3f3f3',
                  padding: '12px 14px',
                  background: selected ? '#f5faff' : '#fff',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontWeight: 700 }}>{item.name}</div>
                <div style={{ fontSize: 12, color: '#666' }}>{item.phone || 'Sin teléfono'} · {item.roleLabel}</div>
                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  <span style={badge(Boolean(!item.docs.cv.required || item.docs.cv.count > 0))}>CV {item.docs.cv.count}</span>
                  <span style={badge(Boolean(!item.docs.carnet.required || item.docs.carnet.count > 0))}>Carnet {item.docs.carnet.count}</span>
                  <span style={badge(Boolean(!item.docs.licencia.required || item.docs.licencia.count > 0))}>Licencia {item.docs.licencia.count}</span>
                </div>
                <div style={{ fontSize: 11, color: '#999', marginTop: 6 }}>Actualizado: {fmtDate(item.updatedAt)}</div>
              </button>
            );
          })}
        </div>
      </aside>

      <section style={{ minHeight: 0, overflow: 'auto', padding: 16 }}>
        {detailLoading ? <div style={{ color: '#666' }}>Cargando detalle…</div> : null}
        {!detailLoading && !detail ? <div style={{ color: '#666' }}>Selecciona un caso para revisar.</div> : null}

        {detail ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 24, fontWeight: 800 }}>{detail.name}</div>
                <div style={{ color: '#666', marginTop: 4 }}>
                  {detail.roleLabel} · {detail.phone || 'Sin teléfono'} · {detail.stage}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button onClick={() => runAction('REGENERATE_SUMMARY')} disabled={Boolean(actionLoading)} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #d9d9d9', background: '#fff' }}>Regenerar resumen</button>
                <button onClick={downloadPackage} disabled={Boolean(actionLoading)} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff' }}>Descargar paquete</button>
              </div>
            </div>

            <table style={{ borderCollapse: 'collapse', width: '100%', border: '1px solid #efefef', borderRadius: 10, overflow: 'hidden' }}>
              <tbody>
                <tr><td style={cell}><b>Cargo</b></td><td style={cell}>{detail.roleLabel}</td></tr>
                <tr><td style={cell}><b>Comuna</b></td><td style={cell}>{detail.comuna || '—'}</td></tr>
                <tr><td style={cell}><b>Disponibilidad</b></td><td style={cell}>{detail.availability || '—'}</td></tr>
                <tr><td style={cell}><b>Experiencia</b></td><td style={cell}>{detail.experience || '—'}</td></tr>
                <tr><td style={cell}><b>Correo</b></td><td style={cell}>{detail.email || '—'}</td></tr>
                <tr><td style={cell}><b>Program / Puesto</b></td><td style={cell}>{detail.programName || '—'}</td></tr>
                <tr><td style={cell}><b>Estado IA</b></td><td style={cell}>{detail.aiPaused ? 'Pausada (esperando operación)' : 'Activa'}</td></tr>
                <tr><td style={cell}><b>Documentos</b></td><td style={cell}>{docSummary.join(' · ') || '—'}</td></tr>
                <tr><td style={cell}><b>Última actualización</b></td><td style={cell}>{fmtDate(detail.updatedAt)}</td></tr>
              </tbody>
            </table>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={() => runAction('ACCEPT')} disabled={Boolean(actionLoading)} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #237804', background: '#f6ffed', color: '#237804', fontWeight: 700 }}>Marcar aceptado</button>
              <button onClick={() => runAction('REJECT')} disabled={Boolean(actionLoading)} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #a8071a', background: '#fff1f0', color: '#a8071a', fontWeight: 700 }}>Marcar rechazado</button>
              <button onClick={() => runAction('BACK_TO_SCREENING')} disabled={Boolean(actionLoading)} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #d9d9d9', background: '#fff' }}>Volver a Screening</button>
              <button onClick={() => runAction('REQUEST_DOC')} disabled={Boolean(actionLoading)} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #d9d9d9', background: '#fff' }}>Pedir documento faltante</button>
            </div>

            <div style={{ border: '1px solid #efefef', borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 8 }}>Resumen interno</div>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.45 }}>{detail.summary || 'Sin resumen interno.'}</pre>
            </div>

            <div style={{ border: '1px solid #efefef', borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 8 }}>Documentos detectados</div>
              {Array.isArray(detail.documents) && detail.documents.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {detail.documents.map((d, idx) => (
                    <a key={`${d.link}-${idx}`} href={d.link} style={{ color: '#1677ff', textDecoration: 'none' }}>
                      {d.kind} · {d.fileName} · {fmtDate(d.uploadedAt)}
                    </a>
                  ))}
                </div>
              ) : (
                <div style={{ color: '#666', fontSize: 13 }}>Sin documentos detectados.</div>
              )}
            </div>
          </div>
        ) : null}

        {status ? <div style={{ marginTop: 12, color: '#1a7f37', fontSize: 13 }}>{status}</div> : null}
        {error ? <div style={{ marginTop: 12, color: '#b93800', fontSize: 13 }}>{error}</div> : null}
      </section>
    </div>
  );
};

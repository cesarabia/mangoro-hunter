import React, { useEffect, useMemo, useState } from 'react';
import { apiClient } from '../api/client';

type WorkspaceOption = {
  id: string;
  name: string;
  role?: string | null;
};

type QaConversationRow = {
  id: string;
  status: string;
  stage: string;
  contact: {
    displayName?: string | null;
    candidateName?: string | null;
    waId?: string | null;
    phone?: string | null;
  };
  program?: { name?: string | null; slug?: string | null } | null;
  applicationRole?: string | null;
  applicationState?: string | null;
  aiPaused?: boolean;
  lastMessage?: {
    direction: string;
    text: string;
    timestamp: string;
  } | null;
  updatedAt: string;
};

type QaConversationDetail = {
  id: string;
  workspaceId: string;
  status: string;
  stage: string;
  channel: string;
  program?: { id: string; name: string; slug: string } | null;
  contact: {
    displayName?: string | null;
    candidateName?: string | null;
    waId?: string | null;
    phone?: string | null;
  };
  application?: {
    role?: string | null;
    state?: string | null;
    aiPaused?: boolean;
  };
  messages: Array<{
    id: string;
    direction: string;
    text: string;
    mediaType?: string | null;
    mediaMime?: string | null;
    mediaPath?: string | null;
    timestamp: string;
  }>;
  runtimeDebug?: Record<string, any>;
  automationDebug?: Record<string, any> | null;
};

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      const idx = value.indexOf(',');
      resolve(idx >= 0 ? value.slice(idx + 1) : value);
    };
    reader.onerror = () => reject(reader.error || new Error('No se pudo leer archivo'));
    reader.readAsDataURL(file);
  });
}

export const SimulatorPage: React.FC<{ onOpenConversation?: (conversationId: string) => void }> = ({ onOpenConversation }) => {
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>(() => {
    try {
      return localStorage.getItem('simulatorWorkspaceId') || localStorage.getItem('workspaceId') || 'default';
    } catch {
      return 'default';
    }
  });
  const [query, setQuery] = useState('');
  const [conversations, setConversations] = useState<QaConversationRow[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [detail, setDetail] = useState<QaConversationDetail | null>(null);

  const [createPhone, setCreatePhone] = useState('56994830202');
  const [createName, setCreateName] = useState('QA Local');
  const [createProgramSlug, setCreateProgramSlug] = useState('postulacion-intake-envio-rapido');

  const [inboundText, setInboundText] = useState('');
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const [attachmentNote, setAttachmentNote] = useState('');

  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentWorkspace = useMemo(
    () => workspaces.find((w) => String(w.id) === String(workspaceId)) || null,
    [workspaces, workspaceId],
  );

  const withWorkspace = (id: string) => {
    try {
      localStorage.setItem('workspaceId', id);
      localStorage.setItem('simulatorWorkspaceId', id);
    } catch {
      // ignore
    }
  };

  const loadWorkspaces = async () => {
    const data = await apiClient.get('/api/workspaces');
    const rows = Array.isArray(data) ? data : [];
    setWorkspaces(rows);
    if (!rows.some((w: any) => String(w.id) === String(workspaceId)) && rows[0]?.id) {
      const next = String(rows[0].id);
      setWorkspaceId(next);
      withWorkspace(next);
    }
  };

  const loadConversations = async () => {
    withWorkspace(workspaceId);
    const q = query.trim();
    const payload = await apiClient.get(`/api/simulate/local-qa/conversations?limit=120${q ? `&q=${encodeURIComponent(q)}` : ''}`);
    const rows = Array.isArray(payload?.conversations) ? payload.conversations : [];
    setConversations(rows);
    if (!selectedConversationId && rows[0]?.id) {
      setSelectedConversationId(String(rows[0].id));
    }
  };

  const loadDetail = async (conversationId: string) => {
    withWorkspace(workspaceId);
    const payload = await apiClient.get(`/api/simulate/local-qa/conversations/${conversationId}`);
    setDetail(payload);
  };

  useEffect(() => {
    loadWorkspaces().catch((err: any) => setError(err.message || 'No se pudo cargar workspaces'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    setSelectedConversationId(null);
    setDetail(null);
    loadConversations().catch((err: any) => setError(err.message || 'No se pudo cargar conversaciones QA'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useEffect(() => {
    if (!selectedConversationId) return;
    loadDetail(selectedConversationId).catch((err: any) => setError(err.message || 'No se pudo cargar detalle QA'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConversationId]);

  const runCreateConversation = async () => {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      withWorkspace(workspaceId);
      const payload = await apiClient.post('/api/simulate/local-qa/conversations', {
        phoneE164: createPhone,
        displayName: createName,
        programSlug: createProgramSlug || undefined,
      });
      if (payload?.id) {
        setSelectedConversationId(String(payload.id));
      }
      await loadConversations();
      if (payload?.id) await loadDetail(String(payload.id));
      setStatus('Conversación QA creada.');
    } catch (err: any) {
      setError(err.message || 'No se pudo crear conversación QA');
    } finally {
      setLoading(false);
    }
  };

  const runInbound = async () => {
    if (!selectedConversationId || !inboundText.trim()) return;
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      withWorkspace(workspaceId);
      const payload = await apiClient.post('/api/simulate/local-qa/run', {
        conversationId: selectedConversationId,
        inboundText,
      });
      setInboundText('');
      if (payload?.id) setSelectedConversationId(String(payload.id));
      setDetail(payload as QaConversationDetail);
      await loadConversations();
      setStatus('Inbound simulado ejecutado con runtime real (modo NULL transport).');
    } catch (err: any) {
      setError(err.message || 'No se pudo ejecutar inbound QA');
    } finally {
      setLoading(false);
    }
  };

  const runAttachment = async () => {
    if (!selectedConversationId || !attachmentFile) return;
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      withWorkspace(workspaceId);
      const dataBase64 = await fileToBase64(attachmentFile);
      const payload = await apiClient.post('/api/simulate/local-qa/attachment', {
        conversationId: selectedConversationId,
        fileName: attachmentFile.name,
        mimeType: attachmentFile.type || 'application/octet-stream',
        dataBase64,
        note: attachmentNote || undefined,
      });
      setAttachmentFile(null);
      setAttachmentNote('');
      if (payload?.id) setSelectedConversationId(String(payload.id));
      setDetail(payload as QaConversationDetail);
      await loadConversations();
      setStatus('Adjunto de prueba ingresado al chat QA y procesado por el runtime.');
    } catch (err: any) {
      setError(err.message || 'No se pudo adjuntar archivo QA');
    } finally {
      setLoading(false);
    }
  };

  const runResetState = async () => {
    if (!selectedConversationId) return;
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      withWorkspace(workspaceId);
      const payload = await apiClient.post('/api/simulate/local-qa/reset-state', {
        conversationId: selectedConversationId,
      });
      setDetail(payload as QaConversationDetail);
      await loadConversations();
      setStatus('QA_STATE_RESET aplicado (solo metadata de flujo).');
    } catch (err: any) {
      setError(err.message || 'No se pudo resetear QA state');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr 380px', gap: 12, padding: 12, minHeight: 0 }}>
      <div style={{ border: '1px solid #e5e5e5', borderRadius: 12, overflow: 'hidden', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 10, borderBottom: '1px solid #eee', background: '#fafafa', fontWeight: 700 }}>QA Simulator (Local)</div>
        <div style={{ padding: 10, display: 'grid', gap: 8 }}>
          <label style={{ fontSize: 12, color: '#555' }}>Workspace</label>
          <select
            value={workspaceId}
            onChange={(e) => {
              const next = e.target.value;
              setWorkspaceId(next);
              withWorkspace(next);
            }}
            style={{ padding: 8, borderRadius: 8, border: '1px solid #d9d9d9' }}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.role ? ` (${w.role})` : ''}
              </option>
            ))}
          </select>
          <div style={{ fontSize: 11, color: '#666' }}>
            Workspace actual: <b>{currentWorkspace?.name || workspaceId}</b>
          </div>

          <div style={{ borderTop: '1px solid #eee', marginTop: 4, paddingTop: 8, display: 'grid', gap: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 700 }}>Crear conversación QA</div>
            <input value={createPhone} onChange={(e) => setCreatePhone(e.target.value)} placeholder="Teléfono (ej: 5699...)" style={{ padding: 8, borderRadius: 8, border: '1px solid #d9d9d9' }} />
            <input value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="Nombre visible" style={{ padding: 8, borderRadius: 8, border: '1px solid #d9d9d9' }} />
            <input value={createProgramSlug} onChange={(e) => setCreateProgramSlug(e.target.value)} placeholder="Program slug inicial" style={{ padding: 8, borderRadius: 8, border: '1px solid #d9d9d9' }} />
            <button onClick={() => runCreateConversation().catch(() => {})} disabled={loading} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff' }}>
              + Crear QA
            </button>
          </div>

          <div style={{ borderTop: '1px solid #eee', marginTop: 4, paddingTop: 8 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar conversación QA" style={{ flex: 1, padding: 8, borderRadius: 8, border: '1px solid #d9d9d9' }} />
              <button onClick={() => loadConversations().catch(() => {})} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
                Buscar
              </button>
            </div>
          </div>
        </div>
        <div style={{ overflow: 'auto', borderTop: '1px solid #eee', flex: 1 }}>
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedConversationId(c.id)}
              style={{
                width: '100%',
                textAlign: 'left',
                border: 'none',
                borderBottom: '1px solid #f1f1f1',
                background: selectedConversationId === c.id ? '#eef4ff' : '#fff',
                padding: 10,
                cursor: 'pointer',
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 13 }}>{c.contact?.candidateName || c.contact?.displayName || c.contact?.waId || c.id.slice(0, 8)}</div>
              <div style={{ fontSize: 11, color: '#555' }}>{c.contact?.waId || c.contact?.phone || 'sin waId'}</div>
              <div style={{ fontSize: 11, color: '#777' }}>{c.program?.slug || 'sin program'} · {c.stage}</div>
              {c.lastMessage?.text ? <div style={{ fontSize: 11, color: '#444', marginTop: 2 }}>{c.lastMessage.text.slice(0, 80)}</div> : null}
            </button>
          ))}
          {conversations.length === 0 ? <div style={{ padding: 12, fontSize: 12, color: '#666' }}>Sin conversaciones QA para este workspace.</div> : null}
        </div>
      </div>

      <div style={{ border: '1px solid #e5e5e5', borderRadius: 12, overflow: 'hidden', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 10, borderBottom: '1px solid #eee', background: '#fafafa', fontWeight: 700 }}>Chat QA</div>
        <div style={{ padding: 10, borderBottom: '1px solid #eee', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => runResetState().catch(() => {})} disabled={loading || !selectedConversationId} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
            Reset QA state only
          </button>
          <button
            onClick={() => selectedConversationId && onOpenConversation?.(selectedConversationId)}
            disabled={!selectedConversationId || !onOpenConversation}
            style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}
          >
            Abrir en Inbox
          </button>
          <span style={{ fontSize: 11, color: '#666' }}>
            {detail ? `${detail.program?.slug || 'sin program'} · ${detail.stage}` : 'Selecciona conversación'}
          </span>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 12, background: '#fcfcfc' }}>
          {detail?.messages?.map((m) => (
            <div key={m.id} style={{ marginBottom: 10, display: 'flex', justifyContent: m.direction === 'OUTBOUND' ? 'flex-end' : 'flex-start' }}>
              <div style={{ maxWidth: '75%', border: '1px solid #e6e6e6', borderRadius: 10, padding: '8px 10px', background: m.direction === 'OUTBOUND' ? '#e8f7ea' : '#fff' }}>
                <div style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{m.text}</div>
                {(m.mediaType || m.mediaPath) ? (
                  <div style={{ marginTop: 6, fontSize: 11, color: '#555' }}>
                    📎 {m.mediaType || 'media'} {m.mediaPath ? `· ${m.mediaPath}` : ''}
                  </div>
                ) : null}
                <div style={{ marginTop: 4, fontSize: 10, color: '#888' }}>{new Date(m.timestamp).toLocaleString()}</div>
              </div>
            </div>
          ))}
          {!detail ? <div style={{ fontSize: 12, color: '#666' }}>Selecciona o crea una conversación QA para comenzar.</div> : null}
        </div>
        <div style={{ borderTop: '1px solid #eee', padding: 10, display: 'grid', gap: 8 }}>
          <textarea value={inboundText} onChange={(e) => setInboundText(e.target.value)} placeholder="Escribe inbound simulado (candidato)" rows={3} style={{ width: '100%', resize: 'vertical', padding: 8, borderRadius: 8, border: '1px solid #d9d9d9' }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => runInbound().catch(() => {})} disabled={loading || !selectedConversationId || !inboundText.trim()} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff' }}>
              Simular inbound
            </button>
          </div>
          <div style={{ borderTop: '1px solid #eee', paddingTop: 8, display: 'grid', gap: 6 }}>
            <input type="file" onChange={(e) => setAttachmentFile(e.target.files?.[0] || null)} />
            <input value={attachmentNote} onChange={(e) => setAttachmentNote(e.target.value)} placeholder="Nota opcional del adjunto" style={{ padding: 8, borderRadius: 8, border: '1px solid #d9d9d9' }} />
            <button onClick={() => runAttachment().catch(() => {})} disabled={loading || !selectedConversationId || !attachmentFile} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
              Adjuntar archivo de prueba
            </button>
          </div>
          {status ? <div style={{ fontSize: 12, color: '#1a7f37' }}>{status}</div> : null}
          {error ? <div style={{ fontSize: 12, color: '#b93800', whiteSpace: 'pre-wrap' }}>{error}</div> : null}
        </div>
      </div>

      <div style={{ border: '1px solid #e5e5e5', borderRadius: 12, overflow: 'auto', padding: 10 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Runtime debug</div>
        {detail?.runtimeDebug ? (
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, background: '#fafafa', border: '1px solid #eee', borderRadius: 8, padding: 8 }}>
{JSON.stringify(detail.runtimeDebug, null, 2)}
          </pre>
        ) : (
          <div style={{ fontSize: 12, color: '#666' }}>Sin datos de runtime todavía.</div>
        )}
        <div style={{ fontWeight: 700, margin: '12px 0 8px' }}>Automation debug</div>
        {detail?.automationDebug ? (
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, background: '#fafafa', border: '1px solid #eee', borderRadius: 8, padding: 8 }}>
{JSON.stringify(detail.automationDebug, null, 2)}
          </pre>
        ) : (
          <div style={{ fontSize: 12, color: '#666' }}>Sin automations recientes.</div>
        )}
      </div>
    </div>
  );
};

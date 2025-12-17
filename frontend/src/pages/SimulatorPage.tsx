import React, { useEffect, useMemo, useState } from 'react';
import { apiClient } from '../api/client';

type DebugTab = 'state' | 'lastRun' | 'tools' | 'automations' | 'transport';

export const SimulatorPage: React.FC<{ onOpenConversation?: (conversationId: string) => void }> = () => {
  const [sessions, setSessions] = useState<any[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('simulatorSelectedSessionId') || null;
    } catch {
      return null;
    }
  });
  const [session, setSession] = useState<any | null>(null);
  const [inboundText, setInboundText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debugTab, setDebugTab] = useState<DebugTab>('state');

  const [replayConversationId, setReplayConversationId] = useState('');
  const [sanitizePii, setSanitizePii] = useState(true);

  const [scenarios, setScenarios] = useState<any[]>([]);
  const [scenarioId, setScenarioId] = useState('');
  const [scenarioStatus, setScenarioStatus] = useState<string | null>(null);

  const [agentRuns, setAgentRuns] = useState<any[]>([]);
  const [agentRunDetail, setAgentRunDetail] = useState<any | null>(null);
  const [isNarrow, setIsNarrow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < 1200;
  });

  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < 1200);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const loadSessions = async () => {
    const data = await apiClient.get('/api/simulate/sessions');
    setSessions(Array.isArray(data) ? data : []);
    if (!selectedSessionId && Array.isArray(data) && data.length > 0) {
      setSelectedSessionId(String(data[0].id));
    }
  };

  const loadSession = async (id: string) => {
    const data = await apiClient.get(`/api/simulate/sessions/${id}`);
    setSession(data);
  };

  const loadAgentRuns = async () => {
    const data = await apiClient.get('/api/logs/agent-runs?limit=100');
    setAgentRuns(Array.isArray(data) ? data : []);
  };

  useEffect(() => {
    loadSessions().catch((e) => setError(e.message || 'No se pudo cargar sesiones'));
    loadAgentRuns().catch(() => {});
    apiClient
      .get('/api/simulate/scenarios')
      .then((data) => setScenarios(Array.isArray(data) ? data : []))
      .catch(() => setScenarios([]));
    try {
      localStorage.removeItem('simulatorSelectedSessionId');
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!selectedSessionId) return;
    loadSession(selectedSessionId).catch((e) => setError(e.message || 'No se pudo cargar sesión'));
  }, [selectedSessionId]);

  const lastRunForSession = useMemo(() => {
    if (!selectedSessionId) return null;
    const match = agentRuns.find((r) => r.conversationId === selectedSessionId);
    return match || null;
  }, [agentRuns, selectedSessionId]);

  useEffect(() => {
    if (!lastRunForSession?.id) {
      setAgentRunDetail(null);
      return;
    }
    apiClient
      .get(`/api/logs/agent-runs/${lastRunForSession.id}`)
      .then((data) => setAgentRunDetail(data))
      .catch(() => setAgentRunDetail(null));
  }, [lastRunForSession?.id]);

  const createSession = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.post('/api/simulate/sessions', {});
      await loadSessions();
      if (res?.id) {
        setSelectedSessionId(String(res.id));
        await loadSession(String(res.id));
      }
    } catch (err: any) {
      setError(err.message || 'No se pudo crear sesión');
    } finally {
      setLoading(false);
    }
  };

  const replayFromConversation = async () => {
    if (!replayConversationId.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.post(`/api/simulate/replay/${replayConversationId.trim()}`, { sanitizePii });
      await loadSessions();
      if (res?.id) {
        setSelectedSessionId(String(res.id));
        await loadSession(String(res.id));
      }
      setReplayConversationId('');
    } catch (err: any) {
      setError(err.message || 'No se pudo hacer replay');
    } finally {
      setLoading(false);
    }
  };

  const runInbound = async () => {
    if (!selectedSessionId || !inboundText.trim()) return;
    setLoading(true);
    setError(null);
    setScenarioStatus(null);
    try {
      const res = await apiClient.post('/api/simulate/run', { sessionId: selectedSessionId, inboundText });
      setInboundText('');
      if (res?.conversation) {
        setSession(res.conversation);
      } else {
        await loadSession(selectedSessionId);
      }
      await loadSessions();
      await loadAgentRuns();
    } catch (err: any) {
      setError(err.message || 'No se pudo ejecutar');
    } finally {
      setLoading(false);
    }
  };

  const runScenario = async () => {
    if (!scenarioId) return;
    setLoading(true);
    setError(null);
    setScenarioStatus(null);
    try {
      const res = await apiClient.post(`/api/simulate/scenario/${scenarioId}`, { sanitizePii });
      if (res?.sessionId) {
        setSelectedSessionId(String(res.sessionId));
        await loadSession(String(res.sessionId));
      }
      setScenarioStatus(res?.ok ? 'PASS' : 'FAIL');
      await loadSessions();
      await loadAgentRuns();
    } catch (err: any) {
      setError(err.message || 'No se pudo ejecutar scenario');
    } finally {
      setLoading(false);
    }
  };

  const exportReport = () => {
    const blob = new Blob([JSON.stringify({ session, lastRunForSession, agentRunDetail }, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `simulator-${selectedSessionId || 'session'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const debugTabs: Array<{ key: DebugTab; label: string }> = [
    { key: 'state', label: 'Estado actual' },
    { key: 'lastRun', label: 'Última corrida agente' },
    { key: 'tools', label: 'Tool calls' },
    { key: 'automations', label: 'Automations evaluadas' },
    { key: 'transport', label: 'Transporte' }
  ];

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: isNarrow ? '1fr' : '320px 1fr 420px',
        gap: 12,
        padding: 12,
        height: '100%',
        minHeight: 0,
      }}
    >
      <div style={{ border: '1px solid #eee', borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 10, borderBottom: '1px solid #eee', background: '#fafafa', fontWeight: 700 }}>Sesiones sandbox</div>
        <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button onClick={() => createSession().catch(() => {})} disabled={loading} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff' }}>
            + Nueva sesión
          </button>
          <div style={{ borderTop: '1px solid #eee', paddingTop: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Replay desde conversación real</div>
            <input value={replayConversationId} onChange={(e) => setReplayConversationId(e.target.value)} placeholder="conversationId" style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #ddd' }} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 12 }}>
              <input type="checkbox" checked={sanitizePii} onChange={(e) => setSanitizePii(e.target.checked)} />
              Sanitizar PII
            </label>
            <button onClick={() => replayFromConversation().catch(() => {})} disabled={loading} style={{ marginTop: 6, padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
              Replay
            </button>
          </div>
          <div style={{ borderTop: '1px solid #eee', paddingTop: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Run Scenario</div>
            <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #ddd' }}>
              <option value="">Selecciona…</option>
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => runScenario().catch(() => {})}
              disabled={loading || !scenarioId}
              style={{ marginTop: 6, padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff', width: '100%' }}
            >
              Ejecutar
            </button>
            {scenarioStatus ? (
              <div style={{ marginTop: 6, fontSize: 12, color: scenarioStatus === 'PASS' ? '#1a7f37' : '#b93800' }}>
                Resultado: {scenarioStatus}
              </div>
            ) : null}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', borderTop: '1px solid #eee' }}>
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedSessionId(String(s.id))}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: 10,
                border: 'none',
                borderBottom: '1px solid #f0f0f0',
                background: selectedSessionId === s.id ? '#f0f0f0' : '#fff',
                cursor: 'pointer'
              }}
            >
              <div style={{ fontSize: 12, color: '#666' }}>{s.createdAt}</div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{s.id}</div>
              <div style={{ fontSize: 12, color: '#666' }}>{s.sourceConversationId ? `source: ${s.sourceConversationId}` : 'new session'}</div>
            </button>
          ))}
        </div>
      </div>

      <div style={{ border: '1px solid #eee', borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 10, borderBottom: '1px solid #eee', background: '#fafafa', fontWeight: 700 }}>Chat</div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          {(session?.messages || []).map((m: any) => (
            <div key={m.id} style={{ marginBottom: 10, display: 'flex', justifyContent: m.direction === 'OUTBOUND' ? 'flex-end' : 'flex-start' }}>
              <div style={{ maxWidth: 520, background: m.direction === 'OUTBOUND' ? '#e6f4ea' : '#fff', border: '1px solid #eee', borderRadius: 12, padding: 10 }}>
                <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{m.text}</div>
                <div style={{ marginTop: 4, fontSize: 11, color: '#666' }}>{new Date(m.timestamp).toLocaleString('es-CL')}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ borderTop: '1px solid #eee', padding: 12, display: 'flex', gap: 8 }}>
          <input
            value={inboundText}
            onChange={(e) => setInboundText(e.target.value)}
            placeholder="Escribe mensaje del candidato…"
            style={{ flex: 1, padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
          />
          <button onClick={() => runInbound().catch(() => {})} disabled={loading} style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #111', background: '#111', color: '#fff' }}>
            Enviar
          </button>
        </div>
      </div>

      <div style={{ border: '1px solid #eee', borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 10, borderBottom: '1px solid #eee', background: '#fafafa', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <div style={{ fontWeight: 700 }}>Debug</div>
          <button onClick={exportReport} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
            Exportar reporte (md/json)
          </button>
        </div>
        <div style={{ padding: 10, borderBottom: '1px solid #eee', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {debugTabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setDebugTab(t.key)}
              style={{ padding: '4px 8px', borderRadius: 8, border: debugTab === t.key ? '1px solid #111' : '1px solid #ccc', background: debugTab === t.key ? '#111' : '#fff', color: debugTab === t.key ? '#fff' : '#111', cursor: 'pointer', fontSize: 12 }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div style={{ padding: 12, overflowY: 'auto', flex: 1 }}>
          {error ? <div style={{ marginBottom: 10, color: '#b93800' }}>{error}</div> : null}
          {debugTab === 'state' ? (
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{JSON.stringify({ session }, null, 2)}</pre>
          ) : null}
          {debugTab === 'lastRun' ? (
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{JSON.stringify({ lastRunForSession, agentRunDetail }, null, 2)}</pre>
          ) : null}
          {debugTab === 'tools' ? (
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{JSON.stringify(agentRunDetail?.toolCalls || [], null, 2)}</pre>
          ) : null}
          {debugTab === 'automations' ? (
            <div style={{ fontSize: 12, color: '#666' }}>Automations evaluadas: ver AutomationRunLog en Logs tab.</div>
          ) : null}
          {debugTab === 'transport' ? (
            <div style={{ fontSize: 12, color: '#666' }}>
              Transporte: NullTransport (no envía WhatsApp real).
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

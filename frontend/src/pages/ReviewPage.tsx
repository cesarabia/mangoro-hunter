import React, { useEffect, useMemo, useState } from 'react';
import { apiClient } from '../api/client';

type LogTab = 'agentRuns' | 'outbound' | 'automationRuns';

type ScenarioResult = {
  id: string;
  name: string;
  ok: boolean;
  sessionId?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
};

export const ReviewPage: React.FC<{
  onGoInbox: () => void;
  onGoInactive: () => void;
  onGoSimulator: (sessionId?: string) => void;
  onGoAgenda: () => void;
  onGoConfig: () => void;
}> = ({ onGoInbox, onGoInactive, onGoSimulator, onGoAgenda, onGoConfig }) => {
  const [health, setHealth] = useState<any | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [outbound, setOutbound] = useState<any | null>(null);
  const [outboundError, setOutboundError] = useState<string | null>(null);

  const [logTab, setLogTab] = useState<LogTab>('agentRuns');
  const [agentRuns, setAgentRuns] = useState<any[]>([]);
  const [automationRuns, setAutomationRuns] = useState<any[]>([]);
  const [outboundLogs, setOutboundLogs] = useState<any[]>([]);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);

  const [scenarios, setScenarios] = useState<any[]>([]);
  const [scenarioResults, setScenarioResults] = useState<ScenarioResult[]>([]);
  const [runningScenarios, setRunningScenarios] = useState(false);

  const allowedNumbers = useMemo(() => new Set(['56982345846', '56994830202']), []);

  const refreshHealth = async () => {
    setHealthError(null);
    try {
      const data = await apiClient.get('/api/health');
      setHealth(data);
    } catch (err: any) {
      setHealth(null);
      setHealthError(err.message || 'No se pudo cargar /api/health');
    }
  };

  const refreshOutbound = async () => {
    setOutboundError(null);
    try {
      const data = await apiClient.get('/api/config/outbound-safety');
      setOutbound(data);
    } catch (err: any) {
      setOutbound(null);
      setOutboundError(err.message || 'No se pudo cargar configuración de SAFE MODE');
    }
  };

  const refreshLogs = async () => {
    setLogsLoading(true);
    setLogsError(null);
    try {
      const [ar, or, au] = await Promise.all([
        apiClient.get('/api/logs/agent-runs?limit=20'),
        apiClient.get('/api/logs/outbound-messages?limit=20'),
        apiClient.get('/api/logs/automation-runs?limit=20')
      ]);
      setAgentRuns(Array.isArray(ar) ? ar : []);
      setOutboundLogs(Array.isArray(or) ? or : []);
      setAutomationRuns(Array.isArray(au) ? au : []);
    } catch (err: any) {
      setLogsError(err.message || 'No se pudieron cargar logs');
      setAgentRuns([]);
      setOutboundLogs([]);
      setAutomationRuns([]);
    } finally {
      setLogsLoading(false);
    }
  };

  useEffect(() => {
    refreshHealth().catch(() => {});
    refreshOutbound().catch(() => {});
    refreshLogs().catch(() => {});
    apiClient
      .get('/api/simulate/scenarios')
      .then((data) => setScenarios(Array.isArray(data) ? data : []))
      .catch(() => setScenarios([]));
  }, []);

  const effectiveAllowlist: string[] = Array.isArray(outbound?.effectiveAllowlist) ? outbound.effectiveAllowlist : [];
  const policy: string | null = typeof outbound?.outboundPolicy === 'string' ? outbound.outboundPolicy : null;
  const unexpectedAllowlist = useMemo(() => effectiveAllowlist.filter((n) => !allowedNumbers.has(String(n))), [effectiveAllowlist, allowedNumbers]);
  const safeModeOk = policy === 'ALLOWLIST_ONLY' && unexpectedAllowlist.length === 0;

  const runAllScenarios = async () => {
    setRunningScenarios(true);
    setScenarioResults([]);
    try {
      const list = Array.isArray(scenarios) ? scenarios : [];
      const results: ScenarioResult[] = [];
      for (const s of list) {
        try {
          const res = await apiClient.post(`/api/simulate/scenario/${s.id}`, { sanitizePii: true });
          results.push({
            id: s.id,
            name: s.name || s.id,
            ok: Boolean(res?.ok),
            sessionId: res?.sessionId,
            startedAt: res?.startedAt,
            finishedAt: res?.finishedAt
          });
        } catch (err: any) {
          results.push({ id: s.id, name: s.name || s.id, ok: false, error: err.message || 'Error al ejecutar' });
        }
      }
      setScenarioResults(results);
      await refreshLogs();
    } finally {
      setRunningScenarios(false);
    }
  };

  const renderLogTable = () => {
    if (logsLoading) {
      return <div style={{ padding: 10, color: '#666' }}>Cargando logs...</div>;
    }
    if (logsError) {
      return <div style={{ padding: 10, color: '#b93800' }}>{logsError}</div>;
    }

    const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 12 };
    const thStyle: React.CSSProperties = { textAlign: 'left', padding: '8px 6px', borderBottom: '1px solid #eee', color: '#555' };
    const tdStyle: React.CSSProperties = { padding: '8px 6px', borderBottom: '1px solid #f2f2f2', verticalAlign: 'top' };

    if (logTab === 'agentRuns') {
      return (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>createdAt</th>
              <th style={thStyle}>status</th>
              <th style={thStyle}>event</th>
              <th style={thStyle}>conversationId</th>
            </tr>
          </thead>
          <tbody>
            {(agentRuns || []).slice(0, 20).map((r: any) => (
              <tr key={r.id}>
                <td style={tdStyle}>{r.createdAt}</td>
                <td style={tdStyle}>{r.status}</td>
                <td style={tdStyle}>{r.eventType}</td>
                <td style={tdStyle} title={r.conversationId}>
                  {r.conversationId}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }

    if (logTab === 'automationRuns') {
      return (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>createdAt</th>
              <th style={thStyle}>status</th>
              <th style={thStyle}>event</th>
              <th style={thStyle}>conversationId</th>
            </tr>
          </thead>
          <tbody>
            {(automationRuns || []).slice(0, 20).map((r: any) => (
              <tr key={r.id}>
                <td style={tdStyle}>{r.createdAt}</td>
                <td style={tdStyle}>{r.status}</td>
                <td style={tdStyle}>{r.eventType}</td>
                <td style={tdStyle} title={r.conversationId || ''}>
                  {r.conversationId || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }

    return (
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>createdAt</th>
            <th style={thStyle}>blockedReason</th>
            <th style={thStyle}>type</th>
            <th style={thStyle}>conversationId</th>
          </tr>
        </thead>
        <tbody>
          {(outboundLogs || []).slice(0, 20).map((o: any) => (
            <tr key={o.id}>
              <td style={tdStyle}>{o.createdAt}</td>
              <td style={{ ...tdStyle, color: o.blockedReason ? '#b93800' : '#1a7f37' }}>{o.blockedReason || '—'}</td>
              <td style={tdStyle}>{o.type}</td>
              <td style={tdStyle} title={o.conversationId}>
                {o.conversationId}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  return (
    <div style={{ padding: 16, maxWidth: 1120, margin: '0 auto' }}>
      <h2 style={{ margin: '8px 0 16px' }}>Ayuda / QA (Owner Review Mode)</h2>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 12, background: '#fff' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div style={{ fontWeight: 800 }}>Build / Health</div>
            <button onClick={() => refreshHealth().catch(() => {})} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
              Refresh
            </button>
          </div>
          {healthError ? <div style={{ marginTop: 8, color: '#b93800' }}>{healthError}</div> : null}
          <div style={{ marginTop: 8, fontSize: 12, color: '#555' }}>
            <div>
              status: <strong>{health?.ok ? 'OK' : '—'}</strong>
            </div>
            <div>
              gitSha: <strong>{health?.gitSha || '—'}</strong>
            </div>
            <div>
              startedAt: <strong>{health?.startedAt || '—'}</strong>
            </div>
            <div>
              repoDirty: <strong>{typeof health?.repoDirty === 'boolean' ? String(health.repoDirty) : '—'}</strong>
            </div>
            <div>
              backendVersion: <strong>{health?.backendVersion || '—'}</strong>
            </div>
          </div>
        </div>

        <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 12, background: '#fff' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div style={{ fontWeight: 800 }}>SAFE MODE (DEV)</div>
            <button onClick={() => refreshOutbound().catch(() => {})} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
              Refresh
            </button>
          </div>
          {outboundError ? <div style={{ marginTop: 8, color: '#b93800' }}>{outboundError}</div> : null}
          <div style={{ marginTop: 8, fontSize: 12, color: '#555' }}>
            <div>
              Policy: <strong style={{ color: safeModeOk ? '#1a7f37' : '#b93800' }}>{policy || '—'}</strong>
            </div>
            <div style={{ marginTop: 8, fontWeight: 700 }}>Allowlist efectiva (debe ser SOLO 2 números):</div>
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {effectiveAllowlist.length === 0 ? (
                <span style={{ color: '#666' }}>— (vacío)</span>
              ) : (
                effectiveAllowlist.map((n) => (
                  <span key={String(n)} style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                    {String(n)}
                  </span>
                ))
              )}
            </div>
            {unexpectedAllowlist.length > 0 ? (
              <div style={{ marginTop: 8, color: '#b93800' }}>
                ⚠️ Hay números fuera de la allowlist autorizada: {unexpectedAllowlist.join(', ')}
              </div>
            ) : null}
            <div style={{ marginTop: 8, color: '#666' }}>
              Autorizados: <strong>56982345846</strong> (admin) y <strong>56994830202</strong> (test)
            </div>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 16, border: '1px solid #eee', borderRadius: 12, padding: 12, background: '#fff' }}>
        <div style={{ fontWeight: 800, marginBottom: 10 }}>Checklist (click-only)</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px', gap: 10, alignItems: 'center' }}>
          <div>Inbox abre y el chat se ve (sin scroll horizontal / sin crash).</div>
          <button onClick={onGoInbox} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
            Abrir Inbox
          </button>
          <div>Inactivos abre.</div>
          <button onClick={onGoInactive} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
            Abrir Inactivos
          </button>
          <div>Simulador abre y corre una sesión.</div>
          <button onClick={() => onGoSimulator()} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
            Abrir Simulador
          </button>
          <div>Agenda abre sin romper.</div>
          <button onClick={onGoAgenda} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
            Abrir Agenda
          </button>
          <div>Configuración abre (Workspace/Usuarios/PhoneLines/Programs/Automations/Logs).</div>
          <button onClick={onGoConfig} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
            Abrir Config
          </button>
        </div>
      </div>

      <div style={{ marginTop: 16, border: '1px solid #eee', borderRadius: 12, padding: 12, background: '#fff' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div style={{ fontWeight: 800 }}>Logs recientes</div>
          <button onClick={() => refreshLogs().catch(() => {})} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
            Refresh
          </button>
        </div>
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setLogTab('agentRuns')} style={{ padding: '4px 10px', borderRadius: 999, border: logTab === 'agentRuns' ? '1px solid #111' : '1px solid #ccc', background: logTab === 'agentRuns' ? '#111' : '#fff', color: logTab === 'agentRuns' ? '#fff' : '#333', fontSize: 12 }}>
            Agent Runs
          </button>
          <button onClick={() => setLogTab('outbound')} style={{ padding: '4px 10px', borderRadius: 999, border: logTab === 'outbound' ? '1px solid #111' : '1px solid #ccc', background: logTab === 'outbound' ? '#111' : '#fff', color: logTab === 'outbound' ? '#fff' : '#333', fontSize: 12 }}>
            Outbound
          </button>
          <button onClick={() => setLogTab('automationRuns')} style={{ padding: '4px 10px', borderRadius: 999, border: logTab === 'automationRuns' ? '1px solid #111' : '1px solid #ccc', background: logTab === 'automationRuns' ? '#111' : '#fff', color: logTab === 'automationRuns' ? '#fff' : '#333', fontSize: 12 }}>
            Automation Runs
          </button>
          <button onClick={onGoConfig} style={{ marginLeft: 'auto', padding: '4px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}>
            Ver en Config → Logs
          </button>
        </div>
        <div style={{ marginTop: 10, overflowX: 'auto' }}>{renderLogTable()}</div>
      </div>

      <div style={{ marginTop: 16, border: '1px solid #eee', borderRadius: 12, padding: 12, background: '#fff' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div style={{ fontWeight: 800 }}>Run Smoke Scenarios (Sandbox / NullTransport)</div>
          <button
            onClick={() => runAllScenarios().catch(() => {})}
            disabled={runningScenarios || scenarios.length === 0}
            style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff' }}
          >
            {runningScenarios ? 'Ejecutando…' : 'Run'}
          </button>
        </div>
        {scenarios.length === 0 ? <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>No hay escenarios disponibles.</div> : null}
        {scenarioResults.length > 0 ? (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {scenarioResults.map((r) => (
              <div key={r.id} style={{ border: '1px solid #eee', borderRadius: 10, padding: 10, background: '#fafafa' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ fontWeight: 800 }}>
                    {r.name}{' '}
                    <span style={{ marginLeft: 6, color: r.ok ? '#1a7f37' : '#b93800' }}>{r.ok ? 'PASS' : 'FAIL'}</span>
                  </div>
                  {r.sessionId ? (
                    <button
                      onClick={() => onGoSimulator(r.sessionId)}
                      style={{ padding: '4px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                    >
                      Abrir en Simulador
                    </button>
                  ) : null}
                </div>
                <div style={{ marginTop: 6, fontSize: 12, color: '#555' }}>
                  {r.sessionId ? (
                    <div>
                      sessionId: <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{r.sessionId}</span>
                    </div>
                  ) : null}
                  {r.error ? <div style={{ color: '#b93800' }}>{r.error}</div> : null}
                  {r.startedAt ? <div>startedAt: {r.startedAt}</div> : null}
                  {r.finishedAt ? <div>finishedAt: {r.finishedAt}</div> : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
};


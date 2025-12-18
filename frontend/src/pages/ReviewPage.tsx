import React, { useEffect, useMemo, useState } from 'react';
import { apiClient } from '../api/client';

type PageTab = 'help' | 'qa';
type LogTab = 'agentRuns' | 'outbound' | 'automationRuns' | 'copilotRuns' | 'configChanges' | 'connectorCalls';

type DodStatus = 'PASS' | 'FAIL' | 'PENDING';

type ScenarioResult = {
  id: string;
  name: string;
  ok: boolean;
  sessionId?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  failedAssertions?: string[];
};

type ReleaseNotes = {
  changed: string[];
  todo: string[];
  risks: string[];
  dod?: Record<string, DodStatus>;
  dodEvaluatedAt?: string;
};

const normalizeSearch = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim();

const joinLines = (arr: string[] | null | undefined) => (Array.isArray(arr) ? arr.join('\n') : '');
const splitLines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

type DodItem = { id: string; label: string; kind: 'auto' | 'manual' };
const DOD_ITEMS: DodItem[] = [
  { id: 'safeMode', label: 'SAFE MODE: default ALLOWLIST_ONLY + allowlist efectiva solo admin/test', kind: 'auto' },
  { id: 'smokeScenarios', label: 'Simulator/Smoke Scenarios: PASS (admin/test/loop/safe_mode/program_switch/ssclinical)', kind: 'auto' },
  { id: 'reviewPack', label: 'Review Pack ZIP: descarga OK y contiene docs + logs + scenarios', kind: 'auto' },
  { id: 'programConsistency', label: 'Program consistency: Sugerir + RUN_AGENT + Automations usan Program correcto', kind: 'auto' },
  { id: 'inboxUx', label: 'Inbox UX: chat-first + responsive sin perder estado', kind: 'manual' },
  { id: 'copilotLv2', label: 'Copilot Nivel 2: propuestas Confirmar/Cancelar sin estados inconsistentes', kind: 'manual' },
  { id: 'programsPro', label: 'Programs PRO: Knowledge Pack + Prompt Builder + auditoría + Tools por Program', kind: 'manual' }
];

const normalizeDodStatus = (value: unknown): DodStatus | null => {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  if (upper === 'PASS' || upper === 'FAIL' || upper === 'PENDING') return upper as DodStatus;
  return null;
};

const dodColor = (status: DodStatus): string => {
  if (status === 'PASS') return '#1a7f37';
  if (status === 'FAIL') return '#b93800';
  return '#666';
};

export const ReviewPage: React.FC<{
  onGoInbox: () => void;
  onGoInactive: () => void;
  onGoSimulator: (sessionId?: string) => void;
  onGoAgenda: () => void;
  onGoConfig: () => void;
  onGoPlatform?: () => void;
}> = ({ onGoInbox, onGoInactive, onGoSimulator, onGoAgenda, onGoConfig, onGoPlatform }) => {
  const currentWorkspaceId = useMemo(() => {
    try {
      return localStorage.getItem('workspaceId') || 'default';
    } catch {
      return 'default';
    }
  }, []);
  const [activeTab, setActiveTab] = useState<PageTab>('help');
  const [helpSearch, setHelpSearch] = useState('');

  const [health, setHealth] = useState<any | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [outbound, setOutbound] = useState<any | null>(null);
  const [outboundError, setOutboundError] = useState<string | null>(null);

  const [phoneLines, setPhoneLines] = useState<any[]>([]);
  const [programs, setPrograms] = useState<any[]>([]);
  const [automations, setAutomations] = useState<any[]>([]);
  const [workspaceConnectors, setWorkspaceConnectors] = useState<any[]>([]);
  const [workspaceConnectorsError, setWorkspaceConnectorsError] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);

  const [release, setRelease] = useState<any | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [savingRelease, setSavingRelease] = useState(false);
  const [releaseChanged, setReleaseChanged] = useState('');
  const [releaseTodo, setReleaseTodo] = useState('');
  const [releaseRisks, setReleaseRisks] = useState('');
  const [releaseDod, setReleaseDod] = useState<Record<string, DodStatus>>({});
  const [dodEvaluatedAt, setDodEvaluatedAt] = useState<string | null>(null);
  const [evaluatingDod, setEvaluatingDod] = useState(false);
  const [evaluateDodError, setEvaluateDodError] = useState<string | null>(null);

  const [logTab, setLogTab] = useState<LogTab>('agentRuns');
  const [outboundConversationId, setOutboundConversationId] = useState<string>('');
  const [agentRuns, setAgentRuns] = useState<any[]>([]);
  const [automationRuns, setAutomationRuns] = useState<any[]>([]);
  const [outboundLogs, setOutboundLogs] = useState<any[]>([]);
  const [copilotRuns, setCopilotRuns] = useState<any[]>([]);
  const [configChanges, setConfigChanges] = useState<any[]>([]);
  const [connectorCalls, setConnectorCalls] = useState<any[]>([]);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);

  const [scenarios, setScenarios] = useState<any[]>([]);
  const [scenarioResults, setScenarioResults] = useState<ScenarioResult[]>([]);
  const [runningScenarios, setRunningScenarios] = useState(false);

  const [reviewPackLoading, setReviewPackLoading] = useState(false);
  const [reviewPackError, setReviewPackError] = useState<string | null>(null);
  const [reviewPackStatus, setReviewPackStatus] = useState<string | null>(null);

  const allowedNumbers = useMemo(() => new Set(['56982345846', '56994830202']), []);

  const openConfigTab = (tab: string) => {
    try {
      localStorage.setItem('configSelectedTab', tab);
    } catch {
      // ignore
    }
    onGoConfig();
  };

  const getDodHelp = (id: string): { steps: string[]; actions: Array<{ label: string; onClick: () => void }> } => {
    switch (id) {
      case 'safeMode':
        return {
          steps: [
            'Ir a Configuración → Workspace.',
            'Ver “SAFE OUTBOUND MODE”: policy = ALLOWLIST_ONLY y allowlist efectiva solo admin/test.',
            'En logs, un intento a número fuera allowlist debe quedar como bloqueado (blockedReason).'
          ],
          actions: [
            { label: 'Abrir Workspace', onClick: () => openConfigTab('workspace') },
            { label: 'Abrir Logs', onClick: () => setLogTab('outbound') }
          ]
        };
      case 'smokeScenarios':
        return {
          steps: ['Ir a QA → Smoke Scenarios.', 'Ejecutar “Run Smoke Scenarios”.', 'Ver PASS/FAIL y revisar asserts si falla.'],
          actions: [{ label: 'Abrir Simulator', onClick: () => onGoSimulator() }]
        };
      case 'reviewPack':
        return {
          steps: ['Ir a QA → Review Pack.', 'Click “Download Review Pack (zip)”.', 'El zip debe contener docs + logs + scenarios.'],
          actions: [{ label: 'Ir a QA', onClick: () => setActiveTab('qa') }]
        };
      case 'programConsistency':
        return {
          steps: [
            'Ir a Inbox y abrir una conversación.',
            'Cambiar Program en Detalles.',
            'Click “Sugerir” y/o enviar “hola” por WhatsApp test: debe usar el Program elegido.',
            'Ver en Logs que el run registra programSlug/programId correcto.'
          ],
          actions: [
            { label: 'Abrir Inbox', onClick: onGoInbox },
            { label: 'Abrir Programs', onClick: () => openConfigTab('programs') },
            { label: 'Abrir Logs', onClick: () => setLogTab('agentRuns') }
          ]
        };
      case 'inboxUx':
        return {
          steps: [
            'Abrir Inbox, seleccionar una conversación.',
            'Redimensionar ventana: no debe perderse la conversación ni el draft.',
            'No debe haber scroll horizontal; el input queda fijo abajo.'
          ],
          actions: [{ label: 'Abrir Inbox', onClick: onGoInbox }]
        };
      case 'copilotLv2':
        return {
          steps: [
            'Abrir Copilot.',
            'Pedir “Crea un Program …” y confirmar.',
            'La tarjeta debe pasar a ✅ Ejecutado (sin quedar colgada) y quedar auditado en Copilot Runs.'
          ],
          actions: [
            { label: 'Abrir Inbox', onClick: onGoInbox },
            { label: 'Ver Copilot Runs', onClick: () => setLogTab('copilotRuns') }
          ]
        };
      case 'programsPro':
        return {
          steps: [
            'Ir a Configuración → Programs.',
            'Editar un Program y agregar Knowledge Pack (links/texto).',
            'Probar “Generar/Mejorar instrucciones con IA” y guardar.'
          ],
          actions: [{ label: 'Abrir Programs', onClick: () => openConfigTab('programs') }]
        };
      default:
        return { steps: [], actions: [] };
    }
  };

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

  const refreshSetup = async () => {
    setSetupError(null);
    setWorkspaceConnectorsError(null);
    try {
      const [lines, progs, autos, conns] = await Promise.all([
        apiClient.get('/api/phone-lines'),
        apiClient.get('/api/programs'),
        apiClient.get('/api/automations'),
        apiClient.get('/api/connectors').catch((err) => {
          setWorkspaceConnectorsError(err?.message || 'No se pudieron cargar connectors (requiere OWNER)');
          return null;
        }),
      ]);
      setPhoneLines(Array.isArray(lines) ? lines : []);
      setPrograms(Array.isArray(progs) ? progs : []);
      setAutomations(Array.isArray(autos) ? autos : []);
      setWorkspaceConnectors(Array.isArray(conns) ? conns : []);
    } catch (err: any) {
      setPhoneLines([]);
      setPrograms([]);
      setAutomations([]);
      setWorkspaceConnectors([]);
      setSetupError(err.message || 'No se pudo cargar configuración');
    }
  };

  const refreshReleaseNotes = async () => {
    setReleaseError(null);
    try {
      const data = await apiClient.get('/api/release-notes');
      setRelease(data);
      const notes: ReleaseNotes | null = data?.notes || null;
      setReleaseChanged(joinLines(notes?.changed));
      setReleaseTodo(joinLines(notes?.todo));
      setReleaseRisks(joinLines(notes?.risks));
      const nextDod: Record<string, DodStatus> = {};
      if (notes?.dod && typeof notes.dod === 'object') {
        for (const [k, v] of Object.entries(notes.dod)) {
          const normalized = normalizeDodStatus(v);
          if (!normalized) continue;
          nextDod[String(k)] = normalized;
        }
      }
      setReleaseDod(nextDod);
      setDodEvaluatedAt(typeof notes?.dodEvaluatedAt === 'string' ? notes.dodEvaluatedAt : null);
    } catch (err: any) {
      setRelease(null);
      setReleaseError(err.message || 'No se pudieron cargar Release Notes');
    }
  };

  const refreshLogs = async (conversationIdOverride?: string) => {
    setLogsLoading(true);
    setLogsError(null);
    try {
      const conversationFilter = (typeof conversationIdOverride === 'string' ? conversationIdOverride : outboundConversationId).trim();
      const outboundPath = conversationFilter
        ? `/api/logs/outbound-messages?limit=20&conversationId=${encodeURIComponent(conversationFilter)}`
        : '/api/logs/outbound-messages?limit=20';
      const [ar, or, au, cc, kc] = await Promise.all([
        apiClient.get('/api/logs/agent-runs?limit=20'),
        apiClient.get(outboundPath),
        apiClient.get('/api/logs/automation-runs?limit=20'),
        apiClient.get('/api/logs/config-changes?limit=20'),
        apiClient.get('/api/logs/connector-calls?limit=20'),
      ]);
      setAgentRuns(Array.isArray(ar) ? ar : []);
      setOutboundLogs(Array.isArray(or) ? or : []);
      setAutomationRuns(Array.isArray(au) ? au : []);
      setConfigChanges(Array.isArray(cc) ? cc : []);
      setConnectorCalls(Array.isArray(kc) ? kc : []);
      apiClient
        .get('/api/logs/copilot-runs?limit=20')
        .then((cr) => setCopilotRuns(Array.isArray(cr) ? cr : []))
        .catch(() => setCopilotRuns([]));
    } catch (err: any) {
      setLogsError(err.message || 'No se pudieron cargar logs');
      setAgentRuns([]);
      setOutboundLogs([]);
      setAutomationRuns([]);
      setCopilotRuns([]);
      setConfigChanges([]);
      setConnectorCalls([]);
    } finally {
      setLogsLoading(false);
    }
  };

  const saveReleaseNotes = async () => {
    setSavingRelease(true);
    setReleaseError(null);
    try {
      const payload = {
        notes: {
          changed: splitLines(releaseChanged),
          todo: splitLines(releaseTodo),
          risks: splitLines(releaseRisks),
          dod: releaseDod
        }
      };
      await apiClient.put('/api/release-notes', payload);
      await refreshReleaseNotes();
    } catch (err: any) {
      setReleaseError(err.message || 'No se pudieron guardar Release Notes');
    } finally {
      setSavingRelease(false);
    }
  };

  const evaluateDod = async () => {
    setEvaluatingDod(true);
    setEvaluateDodError(null);
    try {
      await apiClient.post('/api/release-notes/evaluate-dod', {});
      await refreshReleaseNotes();
      await refreshOutbound();
    } catch (err: any) {
      setEvaluateDodError(err.message || 'No se pudo re-evaluar el DoD');
    } finally {
      setEvaluatingDod(false);
    }
  };

  useEffect(() => {
    let preloadConversationId: string | undefined;
    try {
      const storedTab = localStorage.getItem('reviewTab');
      if (storedTab === 'help' || storedTab === 'qa') {
        setActiveTab(storedTab);
      }
      const storedLogTab = localStorage.getItem('reviewLogTab');
      if (storedLogTab === 'agentRuns' || storedLogTab === 'outbound' || storedLogTab === 'automationRuns' || storedLogTab === 'copilotRuns' || storedLogTab === 'configChanges' || storedLogTab === 'connectorCalls') {
        setLogTab(storedLogTab);
        setActiveTab('qa');
      }
      const storedConversationId = localStorage.getItem('reviewConversationId');
      if (storedConversationId) {
        preloadConversationId = storedConversationId;
        setOutboundConversationId(storedConversationId);
        setLogTab('outbound');
        setActiveTab('qa');
      }
      localStorage.removeItem('reviewTab');
      localStorage.removeItem('reviewLogTab');
      localStorage.removeItem('reviewConversationId');
    } catch {
      // ignore
    }

    refreshHealth().catch(() => {});
    refreshOutbound().catch(() => {});
    refreshSetup().catch(() => {});
    refreshReleaseNotes().catch(() => {});
    refreshLogs(preloadConversationId).catch(() => {});
    apiClient
      .get('/api/simulate/scenarios')
      .then((data) => setScenarios(Array.isArray(data) ? data : []))
      .catch(() => setScenarios([]));
  }, []);

  const effectiveAllowlist: string[] = Array.isArray(outbound?.effectiveAllowlist) ? outbound.effectiveAllowlist : [];
  const policy: string | null = typeof outbound?.outboundPolicy === 'string' ? outbound.outboundPolicy : null;
  const unexpectedAllowlist = useMemo(
    () => effectiveAllowlist.filter((n) => !allowedNumbers.has(String(n))),
    [effectiveAllowlist, allowedNumbers]
  );
  const safeModeOk = policy === 'ALLOWLIST_ONLY' && unexpectedAllowlist.length === 0;

  const phoneLineOk = useMemo(() => (phoneLines || []).some((l: any) => Boolean(l?.isActive) && l?.waPhoneNumberId), [phoneLines]);
  const programsOk = useMemo(() => (programs || []).some((p: any) => Boolean(p?.isActive) && !p?.archivedAt), [programs]);
  const ssclinicalWorkspaceOk = currentWorkspaceId === 'ssclinical';
  const ssclinicalProgramsOk = useMemo(() => {
    if (!ssclinicalWorkspaceOk) return false;
    const required = [
      'coordinadora-salud-suero-hidratante-y-terapia',
      'enfermera-lider-coordinadora',
      'enfermera-domicilio',
      'medico-orden-medica',
    ];
    const set = new Set((programs || []).filter((p: any) => !p?.archivedAt).map((p: any) => String(p?.slug || '').trim()));
    return required.every((slug) => set.has(slug));
  }, [programs, ssclinicalWorkspaceOk]);
  const medilinkOk = useMemo(() => {
    const med = (workspaceConnectors || []).find((c: any) => String(c?.slug || '').toLowerCase() === 'medilink') || null;
    return Boolean(med?.hasToken) && Boolean(String(med?.baseUrl || '').trim());
  }, [workspaceConnectors]);
  const automationsOk = useMemo(
    () =>
      (automations || []).some(
        (r: any) =>
          Boolean(r?.enabled) &&
          String(r?.trigger || '').toUpperCase() === 'INBOUND_MESSAGE' &&
          (Array.isArray(r?.actions)
            ? (r.actions || []).some((a: any) => String(a?.type || '').toUpperCase() === 'RUN_AGENT')
            : String((r as any)?.actionsJson || '').toUpperCase().includes('RUN_AGENT'))
      ),
    [automations]
  );
  const lastQaOk = Boolean(release?.lastQa?.ok);

  const [firstStepsEvaluatedAt, setFirstStepsEvaluatedAt] = useState<string | null>(null);
  const reevaluateFirstSteps = async () => {
    await Promise.all([refreshOutbound(), refreshSetup()]);
    setFirstStepsEvaluatedAt(new Date().toISOString());
  };

  const [ensuringAutomation, setEnsuringAutomation] = useState(false);
  const [ensureAutomationStatus, setEnsureAutomationStatus] = useState<string | null>(null);
  const [ensureAutomationError, setEnsureAutomationError] = useState<string | null>(null);

  const ensureDefaultInboundAutomation = async () => {
    setEnsuringAutomation(true);
    setEnsureAutomationStatus(null);
    setEnsureAutomationError(null);
    try {
      const res: any = await apiClient.post('/api/automations/ensure-default', {});
      const created = res?.existing === false;
      setEnsureAutomationStatus(created ? 'Automation creada.' : 'Ya existía una automation inbound → RUN_AGENT.');
      await refreshSetup();
      setFirstStepsEvaluatedAt(new Date().toISOString());
    } catch (err: any) {
      setEnsureAutomationError(err.message || 'No se pudo crear/asegurar la automation');
    } finally {
      setEnsuringAutomation(false);
    }
  };

  const runAllScenarios = async () => {
    setRunningScenarios(true);
    setScenarioResults([]);
    try {
      const list = Array.isArray(scenarios) ? scenarios : [];
      const results: ScenarioResult[] = [];
      for (const s of list) {
        try {
          const res = await apiClient.post(`/api/simulate/scenario/${s.id}`, { sanitizePii: true });
          const steps = Array.isArray(res?.steps) ? res.steps : [];
          const failedAssertions = steps
            .flatMap((st: any) =>
              (Array.isArray(st?.assertions) ? st.assertions : [])
                .filter((a: any) => a && a.ok === false)
                .map((a: any) => `Paso ${st?.step || '?'}: ${a.message || 'assert falló'}`)
            )
            .slice(0, 8);
          results.push({
            id: s.id,
            name: s.name || s.id,
            ok: Boolean(res?.ok),
            sessionId: res?.sessionId,
            startedAt: res?.startedAt,
            finishedAt: res?.finishedAt,
            failedAssertions: failedAssertions.length > 0 ? failedAssertions : undefined,
          });
        } catch (err: any) {
          results.push({ id: s.id, name: s.name || s.id, ok: false, error: err.message || 'Error al ejecutar' });
        }
      }
      setScenarioResults(results);
      await refreshReleaseNotes();
      await refreshLogs();
    } finally {
      setRunningScenarios(false);
    }
  };

  const startedAtLabel = useMemo(() => {
    const iso = typeof (health as any)?.startedAt === 'string' ? String((health as any).startedAt) : '';
    if (!iso) return { local: '—', utc: '—', iso: '' };
    const d = new Date(iso);
    const local = Number.isNaN(d.getTime()) ? iso : d.toLocaleString('es-CL');
    const utc = Number.isNaN(d.getTime()) ? iso : d.toISOString();
    return { local, utc, iso };
  }, [health?.startedAt]);

  const downloadReviewPack = async () => {
    setReviewPackLoading(true);
    setReviewPackError(null);
    setReviewPackStatus(null);
    try {
      const token = localStorage.getItem('token');
      const workspaceId = localStorage.getItem('workspaceId') || 'default';
      if (!token) throw new Error('No hay sesión.');

      const res = await fetch('/api/review-pack/', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Workspace-Id': workspaceId,
        },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const dispo = res.headers.get('Content-Disposition') || '';
      const match = dispo.match(/filename=\"?([^\";]+)\"?/i);
      const filename = match?.[1] || `review-pack-${workspaceId}.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setReviewPackStatus(`Descargado: ${filename}`);
    } catch (err: any) {
      setReviewPackError(err.message || 'No se pudo descargar el Review Pack');
    } finally {
      setReviewPackLoading(false);
    }
  };

  const renderLogTable = () => {
    if (logsLoading) {
      return <div style={{ padding: 10, color: '#666' }}>Cargando logs...</div>;
    }
    if (logsError) {
      return <div style={{ padding: 10, color: '#b93800' }}>{logsError}</div>;
    }

    const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 12, tableLayout: 'fixed' };
    const thStyle: React.CSSProperties = { textAlign: 'left', padding: '8px 6px', borderBottom: '1px solid #eee', color: '#555' };
    const tdStyle: React.CSSProperties = {
      padding: '8px 6px',
      borderBottom: '1px solid #f2f2f2',
      verticalAlign: 'top',
      overflowWrap: 'anywhere',
      wordBreak: 'break-word'
    };
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

    if (logTab === 'copilotRuns') {
      return (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>createdAt</th>
              <th style={thStyle}>status</th>
              <th style={thStyle}>view</th>
              <th style={thStyle}>threadId</th>
              <th style={thStyle}>error</th>
            </tr>
          </thead>
          <tbody>
            {(copilotRuns || []).slice(0, 20).map((r: any) => (
              <tr key={r.id}>
                <td style={tdStyle}>{r.createdAt}</td>
                <td style={tdStyle}>{r.status}</td>
                <td style={tdStyle}>{r.view || '—'}</td>
                <td style={tdStyle} title={r.threadId || ''}>
                  {r.threadId || '—'}
                </td>
                <td style={{ ...tdStyle, color: r.status === 'ERROR' ? '#b93800' : '#555' }}>{r.error || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }

    if (logTab === 'configChanges') {
      return (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>createdAt</th>
              <th style={thStyle}>type</th>
              <th style={thStyle}>user</th>
              <th style={thStyle}>after</th>
            </tr>
          </thead>
          <tbody>
            {(configChanges || []).slice(0, 20).map((c: any) => (
              <tr key={c.id}>
                <td style={tdStyle}>{c.createdAt}</td>
                <td style={tdStyle}>{c.type}</td>
                <td style={tdStyle}>{c.user?.email || c.user?.id || '—'}</td>
                <td style={tdStyle}>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {c.after ? JSON.stringify(c.after, null, 2) : '—'}
                  </pre>
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

    if (logTab === 'connectorCalls') {
      return (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>createdAt</th>
              <th style={thStyle}>connector</th>
              <th style={thStyle}>kind</th>
              <th style={thStyle}>ok</th>
              <th style={thStyle}>statusCode</th>
              <th style={thStyle}>error</th>
            </tr>
          </thead>
          <tbody>
            {(connectorCalls || []).slice(0, 20).map((c: any) => (
              <tr key={c.id}>
                <td style={tdStyle}>{c.createdAt}</td>
                <td style={tdStyle}>
                  {c.connector?.name || '—'}{' '}
                  <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: '#666' }}>
                    {c.connector?.slug ? `(${c.connector.slug})` : ''}
                  </span>
                </td>
                <td style={tdStyle}>{c.kind}</td>
                <td style={{ ...tdStyle, color: c.ok ? '#1a7f37' : '#b93800', fontWeight: 800 }}>{c.ok ? 'PASS' : 'FAIL'}</td>
                <td style={tdStyle}>{typeof c.statusCode === 'number' ? c.statusCode : '—'}</td>
                <td style={{ ...tdStyle, color: c.error ? '#b93800' : '#666' }}>{c.error || '—'}</td>
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

  const helpQuery = normalizeSearch(helpSearch);

  const concepts = [
    {
      key: 'workspace',
      title: 'Workspace',
      body: 'Cliente/cuenta. Aquí vive la configuración y acceso.',
      actionLabel: 'Ir a Workspace',
      onGo: () => openConfigTab('workspace'),
    },
    {
      key: 'phoneline',
      title: 'PhoneLine',
      body: 'Número WhatsApp conectado (línea) y su Program por defecto.',
      actionLabel: 'Ir a Números WhatsApp',
      onGo: () => openConfigTab('phoneLines'),
    },
    {
      key: 'program',
      title: 'Program',
      body: 'Agente/experiencia que gobierna una conversación (reclutamiento, ventas, etc.).',
      actionLabel: 'Ir a Programs',
      onGo: () => openConfigTab('programs'),
    },
    {
      key: 'automations',
      title: 'Automations',
      body: 'Reglas que disparan agentes/acciones (ej: inbound → RUN_AGENT).',
      actionLabel: 'Ir a Automations',
      onGo: () => openConfigTab('automations'),
    },
    {
      key: 'simulator',
      title: 'Simulator',
      body: 'Pruebas sin WhatsApp real (NullTransport) con logs y replay.',
      actionLabel: 'Abrir Simulador',
      onGo: () => onGoSimulator(),
    },
    {
      key: 'safe',
      title: 'SAFE MODE (DEV)',
      body: 'Protección: allowlist-only para no molestar números reales.',
      actionLabel: 'Ver SAFE MODE',
      onGo: () => openConfigTab('workspace'),
    },
  ];

  const helpSteps = [
    {
      title: 'Paso 1: Confirmar SAFE MODE (DEV)',
      ok: safeModeOk,
      detail: safeModeOk ? 'ALLOWLIST_ONLY con 2 números autorizados.' : 'Revisa policy/allowlist.',
      action: () => openConfigTab('workspace'),
      actionLabel: 'Ir a Config',
    },
    {
      title: 'Paso 2: Confirmar PhoneLine',
      ok: phoneLineOk,
      detail: phoneLineOk ? 'Hay al menos 1 línea activa.' : 'No hay líneas activas.',
      action: () => openConfigTab('phoneLines'),
      actionLabel: 'Ir a Números WhatsApp',
    },
    {
      title: 'Paso 3: Crear/confirmar Programs',
      ok: programsOk,
      detail: programsOk ? 'Hay al menos 1 Program activo.' : 'No hay Programs activos.',
      action: () => openConfigTab('programs'),
      actionLabel: 'Ir a Programs',
    },
    {
      title: 'Paso 4: Activar automation básica (RUN_AGENT)',
      ok: automationsOk,
      detail: automationsOk ? 'Hay una regla inbound → RUN_AGENT.' : 'Falta regla básica RUN_AGENT.',
      action: () => openConfigTab('automations'),
      actionLabel: 'Ir a Automations',
    },
    {
      title: 'Paso 5 (recomendado): Probar en Simulator',
      ok: lastQaOk,
      detail: lastQaOk ? 'Último QA: PASS.' : 'Aún no hay QA reciente o falló.',
      action: () => setActiveTab('qa'),
      actionLabel: 'Ir a QA',
    },
  ];

  const moduleGuides = [
    {
      key: 'inbox',
      title: 'Inbox',
      text: 'Aquí gestionas conversaciones. Usa “Detalles” para ver Program/Stage/ventana WhatsApp y acciones.',
      example: 'Ejemplo: selecciona una conversación → abre “Detalles” → cambia Program si corresponde.',
      onGo: onGoInbox,
    },
    {
      key: 'inactive',
      title: 'Inactivos',
      text: 'Conversaciones archivadas o sin respuesta. Sirve para retomar, revisar o auditar.',
      example: 'Ejemplo: abre Inactivos → revisa “sin respuesta” → decide siguiente acción.',
      onGo: onGoInactive,
    },
    {
      key: 'sim',
      title: 'Simulador',
      text: 'Sesiones sandbox para probar agentes y reglas sin WhatsApp real. Incluye replay y scenarios.',
      example: 'Ejemplo: crea sesión → envía “✅ PUENTE ALTO…” → revisa logs y respuesta.',
      onGo: () => onGoSimulator(),
    },
    {
      key: 'agenda',
      title: 'Agenda',
      text: 'Reserva/gestiona entrevistas y evita double-booking con disponibilidad.',
      example: 'Ejemplo: abre Agenda → revisa reservas → ajusta disponibilidad en Config.',
      onGo: onGoAgenda,
    },
    {
      key: 'config',
      title: 'Configuración',
      text: 'Workspace, Usuarios, Números WhatsApp, Programs, Automations y Logs.',
      example: 'Ejemplo: crea un Program → activa automation inbound → prueba en Simulator.',
      onGo: onGoConfig,
    },
  ];

  const troubleshooting = [
    {
      key: 'no_reply',
      title: 'No respondió',
      text: 'Causas comunes: SAFE MODE bloqueó, NO_CONTACTAR, fuera de ventana 24h, error del agente.',
      actionLabel: 'Ver logs',
      onGo: () => {
        setActiveTab('qa');
        setLogTab('outbound');
      },
    },
    {
      key: 'repeated',
      title: 'Se repitió',
      text: 'Anti-loop y dedupe evitan duplicados. Si ves repetición, revisa Outbound blockedReason y dedupeKey.',
      actionLabel: 'Ver outbound',
      onGo: () => {
        setActiveTab('qa');
        setLogTab('outbound');
      },
    },
    {
      key: 'outside_24h',
      title: 'Fuera de ventana 24h',
      text: 'WhatsApp limita mensajes fuera de 24h: se deben usar plantillas.',
      actionLabel: 'Abrir Inbox',
      onGo: onGoInbox,
    },
    {
      key: 'safe_mode_block',
      title: 'No se envía por SAFE MODE',
      text: 'En DEV, allowlist-only bloquea cualquier número fuera de admin/test. El bloqueo queda logueado.',
      actionLabel: 'Ver SAFE MODE',
      onGo: () => openConfigTab('workspace'),
    },
  ];

  const matchHelp = (obj: { title: string; body?: string; text?: string; example?: string }) => {
    if (!helpQuery) return true;
    const hay = [obj.title, obj.body, obj.text, obj.example].filter(Boolean).join(' ');
    return normalizeSearch(hay).includes(helpQuery);
  };

  const tabButton = (tab: PageTab, label: string) => (
    <button
      onClick={() => setActiveTab(tab)}
      style={{
        padding: '6px 12px',
        borderRadius: 999,
        border: activeTab === tab ? '1px solid #111' : '1px solid #ccc',
        background: activeTab === tab ? '#111' : '#fff',
        color: activeTab === tab ? '#fff' : '#111',
        fontSize: 13,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ padding: 16, maxWidth: 1120, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: '8px 0 2px' }}>{activeTab === 'help' ? 'Ayuda — Agent OS' : 'QA / Owner Review'}</h2>
          <div style={{ fontSize: 12, color: '#666' }}>
            {activeTab === 'help'
              ? 'Crea Programs (agentes) y reglas (Automations) para operar conversaciones.'
              : 'Health, SAFE MODE, logs y smoke scenarios (sin WhatsApp real).'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {tabButton('help', 'Ayuda')}
          {tabButton('qa', 'QA / Owner Review')}
        </div>
      </div>

      {activeTab === 'help' ? (
        <>
          <div style={{ marginTop: 14, border: '1px solid #eee', borderRadius: 12, padding: 12, background: '#fff' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                value={helpSearch}
                onChange={(e) => setHelpSearch(e.target.value)}
                placeholder="Buscar en la ayuda…"
                style={{ flex: '1 1 260px', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
              />
              <button
                onClick={() => {
                  setHelpSearch('');
                  refreshSetup().catch(() => {});
                  refreshOutbound().catch(() => {});
                }}
                style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 13 }}
              >
                Refresh
              </button>
            </div>
            {setupError ? <div style={{ marginTop: 8, color: '#b93800' }}>{setupError}</div> : null}
          </div>

          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>Conceptos clave</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {concepts.filter(matchHelp).map((c) => (
                <div key={c.key} style={{ border: '1px solid #eee', borderRadius: 12, padding: 12, background: '#fff' }}>
                  <div style={{ fontWeight: 800 }}>{c.title}</div>
                  <div style={{ marginTop: 6, fontSize: 13, color: '#555' }}>{c.body}</div>
                  <button
                    onClick={c.onGo}
                    style={{ marginTop: 10, padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                  >
                    {c.actionLabel}
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 14, border: '1px solid #eee', borderRadius: 12, padding: 12, background: '#fff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ fontWeight: 900 }}>Primeros pasos (click-only)</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {firstStepsEvaluatedAt ? (
                  <div style={{ fontSize: 12, color: '#666' }}>
                    Evaluado: {new Date(firstStepsEvaluatedAt).toLocaleString('es-CL')}
                  </div>
                ) : null}
                <button
                  onClick={() => reevaluateFirstSteps().catch(() => {})}
                  style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12, fontWeight: 800 }}
                >
                  Re-evaluar Primeros Pasos
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {helpSteps.filter(matchHelp).map((s) => (
                <div key={s.title} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontWeight: 800 }}>
                      <span style={{ color: s.ok ? '#1a7f37' : '#b93800' }}>{s.ok ? '✅' : '⚠️'}</span>{' '}
                      {s.title}
                    </div>
                    <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>{s.detail}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    {s.title.includes('Paso 4') && !automationsOk ? (
                      <button
                        onClick={() => ensureDefaultInboundAutomation().catch(() => {})}
                        disabled={ensuringAutomation}
                        style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #111', background: '#111', color: '#fff', fontSize: 12, fontWeight: 800 }}
                      >
                        {ensuringAutomation ? 'Creando…' : 'Crear automation RUN_AGENT'}
                      </button>
                    ) : null}
                    <button onClick={s.action} style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}>
                      {s.actionLabel}
                    </button>
                    {s.title.includes('Paso 4') && !automationsOk && ensureAutomationStatus ? (
                      <span style={{ fontSize: 12, color: '#1a7f37' }}>{ensureAutomationStatus}</span>
                    ) : null}
                    {s.title.includes('Paso 4') && !automationsOk && ensureAutomationError ? (
                      <span style={{ fontSize: 12, color: '#b93800' }}>{ensureAutomationError}</span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>Guía por módulo</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {moduleGuides.filter(matchHelp).map((m) => (
                <details key={m.key} style={{ border: '1px solid #eee', borderRadius: 12, padding: 10, background: '#fff' }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 800 }}>{m.title}</summary>
                  <div style={{ marginTop: 8, fontSize: 13, color: '#555' }}>{m.text}</div>
                  <div style={{ marginTop: 6, fontSize: 12, color: '#666' }}>
                    <strong>Ejemplo:</strong> {m.example}
                  </div>
                  <button onClick={m.onGo} style={{ marginTop: 10, padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}>
                    Ir a {m.title}
                  </button>
                </details>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>Solución de problemas</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {troubleshooting.filter(matchHelp).map((t) => (
                <div key={t.key} style={{ border: '1px solid #eee', borderRadius: 12, padding: 12, background: '#fff' }}>
                  <div style={{ fontWeight: 800 }}>{t.title}</div>
                  <div style={{ marginTop: 6, fontSize: 13, color: '#555' }}>{t.text}</div>
                  <button onClick={t.onGo} style={{ marginTop: 10, padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}>
                    {t.actionLabel}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
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
                  startedAt (local):{' '}
                  <strong title={startedAtLabel.iso ? `UTC: ${startedAtLabel.utc}` : ''}>{startedAtLabel.local}</strong>
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

          <div style={{ marginTop: 14, border: '1px solid #eee', borderRadius: 12, padding: 12, background: '#fff' }}>
            <div style={{ fontWeight: 900, marginBottom: 6 }}>Release Notes (DEV)</div>
            <div style={{ fontSize: 12, color: '#666' }}>
              Build: <strong>{health?.gitSha || '—'}</strong> · startedAt: <strong title={startedAtLabel.iso || ''}>{startedAtLabel.local}</strong>
            </div>
            {releaseError ? <div style={{ marginTop: 8, color: '#b93800' }}>{releaseError}</div> : null}
            <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
              <div>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>Qué cambió</div>
                <textarea value={releaseChanged} onChange={(e) => setReleaseChanged(e.target.value)} style={{ width: '100%', minHeight: 120, padding: 8, borderRadius: 10, border: '1px solid #ddd', fontSize: 12 }} placeholder="- item 1\n- item 2" />
              </div>
              <div>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>Qué falta / próximos pasos</div>
                <textarea value={releaseTodo} onChange={(e) => setReleaseTodo(e.target.value)} style={{ width: '100%', minHeight: 120, padding: 8, borderRadius: 10, border: '1px solid #ddd', fontSize: 12 }} placeholder="- next 1\n- next 2" />
              </div>
              <div>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>Riesgos conocidos</div>
                <textarea value={releaseRisks} onChange={(e) => setReleaseRisks(e.target.value)} style={{ width: '100%', minHeight: 120, padding: 8, borderRadius: 10, border: '1px solid #ddd', fontSize: 12 }} placeholder="- risk 1\n- risk 2" />
              </div>
            </div>

            <div style={{ marginTop: 12, borderTop: '1px solid #eee', paddingTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 800 }}>v1 DoD</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  {dodEvaluatedAt ? (
                    <div style={{ fontSize: 12, color: '#666' }}>
                      evaluado: <strong>{dodEvaluatedAt}</strong>
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: '#666' }}>evaluado: —</div>
                  )}
                  <button
                    onClick={() => evaluateDod().catch(() => {})}
                    disabled={evaluatingDod}
                    style={{
                      padding: '6px 10px',
                      borderRadius: 10,
                      border: '1px solid #111',
                      background: '#111',
                      color: '#fff',
                      fontSize: 12,
                      cursor: evaluatingDod ? 'not-allowed' : 'pointer'
                    }}
                  >
                    {evaluatingDod ? 'Re-evaluando…' : 'Re-evaluar DoD'}
                  </button>
                </div>
              </div>
              {evaluateDodError ? <div style={{ marginTop: 8, color: '#b93800', fontSize: 12 }}>{evaluateDodError}</div> : null}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {DOD_ITEMS.map((item) => {
                  const status: DodStatus = releaseDod?.[item.id] || 'PENDING';
                  const help = getDodHelp(item.id);
                  return (
                    <div key={item.id} style={{ border: '1px solid #f0f0f0', borderRadius: 12, padding: 10, background: '#fff' }}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12, flexWrap: 'wrap' }}>
                        {item.kind === 'manual' ? (
                          <select
                            value={status}
                            onChange={(e) => {
                              const next = normalizeDodStatus(e.target.value) || 'PENDING';
                              setReleaseDod((prev) => ({ ...(prev || {}), [item.id]: next }));
                            }}
                            style={{ padding: '6px 8px', borderRadius: 10, border: '1px solid #ddd', fontSize: 12 }}
                          >
                            <option value="PASS">PASS</option>
                            <option value="PENDING">PENDIENTE</option>
                            <option value="FAIL">FAIL</option>
                          </select>
                        ) : (
                          <div style={{ width: 88, textAlign: 'center', padding: '6px 8px', borderRadius: 10, border: '1px solid #eee', background: '#fafafa', fontSize: 12 }}>
                            Auto
                          </div>
                        )}
                        <span style={{ fontWeight: 800, color: dodColor(status), width: 70 }}>
                          {status === 'PENDING' ? 'PEND.' : status}
                        </span>
                        <span style={{ color: '#111', fontWeight: 700 }}>{item.label}</span>
                      </div>
                      {help.steps.length > 0 ? (
                        <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>
                          <div style={{ fontWeight: 800, marginBottom: 4 }}>Cómo validar</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {help.steps.map((s) => (
                              <div key={s}>• {s}</div>
                            ))}
                          </div>
                          {help.actions.length > 0 ? (
                            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                              {help.actions.map((a) => (
                                <button
                                  key={a.label}
                                  onClick={a.onClick}
                                  style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                                >
                                  {a.label}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>
                Tip: ítems Auto se calculan con “Re-evaluar DoD”. Ítems manuales parten en PENDIENTE por defecto.
              </div>
            </div>
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button
                onClick={() => saveReleaseNotes().catch(() => {})}
                disabled={savingRelease}
                style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #111', background: '#111', color: '#fff', fontSize: 12 }}
              >
                {savingRelease ? 'Guardando…' : 'Guardar'}
              </button>
              <button
                onClick={() => refreshReleaseNotes().catch(() => {})}
                style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
              >
                Recargar
              </button>
              <div style={{ fontSize: 12, color: '#666' }}>
                Último QA: <strong style={{ color: release?.lastQa?.ok ? '#1a7f37' : '#b93800' }}>{release?.lastQa ? (release.lastQa.ok ? 'PASS' : 'FAIL') : '—'}</strong>{' '}
                {release?.lastQa?.createdAt ? `(${release.lastQa.createdAt})` : ''}
              </div>
              <div style={{ marginLeft: 'auto', fontSize: 12, color: '#666' }}>
                updatedAt: <strong>{release?.updatedAt || '—'}</strong>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 14, border: '1px solid #eee', borderRadius: 12, padding: 12, background: '#fff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontWeight: 900 }}>Review Pack (zip)</div>
                <div style={{ fontSize: 12, color: '#666' }}>
                  Descarga un paquete con docs + snapshots de logs + escenarios (sin terminal).
                </div>
              </div>
              <button
                onClick={() => downloadReviewPack().catch(() => {})}
                disabled={reviewPackLoading}
                style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #111', background: '#111', color: '#fff', fontSize: 12 }}
              >
                {reviewPackLoading ? 'Generando…' : 'Download Review Pack'}
              </button>
            </div>
            {reviewPackStatus ? <div style={{ marginTop: 8, fontSize: 12, color: '#1a7f37' }}>{reviewPackStatus}</div> : null}
            {reviewPackError ? <div style={{ marginTop: 8, fontSize: 12, color: '#b93800' }}>{reviewPackError}</div> : null}
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
              <div>Configuración abre (Workspace/Usuarios/PhoneLines/Programs/Automations/Logs/Uso & Costos).</div>
              <button onClick={onGoConfig} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
                Abrir Config
              </button>
              {onGoPlatform ? (
                <>
                  <div>Clientes (Plataforma) abre y permite crear/archivar workspaces.</div>
                  <button onClick={onGoPlatform} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
                    Abrir Clientes
                  </button>
                </>
              ) : null}
            </div>
          </div>

          <div style={{ marginTop: 16, border: '1px solid #eee', borderRadius: 12, padding: 12, background: '#fff' }}>
            <div style={{ fontWeight: 800, marginBottom: 10 }}>Pilot SSClinical (MVP) — checklist</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px', gap: 10, alignItems: 'center' }}>
              <div>
                <span style={{ color: ssclinicalWorkspaceOk ? '#1a7f37' : '#b93800' }}>{ssclinicalWorkspaceOk ? '✅' : '⚠️'}</span>{' '}
                Estás en el workspace <strong>SSClinical</strong> (usa el selector arriba para cambiar).
              </div>
              <button
                onClick={() => {
                  window.alert('Usa el selector de Workspace en la barra superior (arriba a la izquierda).');
                }}
                style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}
              >
                Cómo cambiar
              </button>

              <div>
                <span style={{ color: safeModeOk ? '#1a7f37' : '#b93800' }}>{safeModeOk ? '✅' : '⚠️'}</span> SAFE MODE allowlist-only (solo admin/test).
              </div>
              <button onClick={() => openConfigTab('workspace')} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
                Ver SAFE MODE
              </button>

              <div>
                <span style={{ color: automationsOk ? '#1a7f37' : '#b93800' }}>{automationsOk ? '✅' : '⚠️'}</span> Automation básica INBOUND_MESSAGE → RUN_AGENT habilitada.
              </div>
              <button onClick={() => openConfigTab('automations')} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
                Ver Automations
              </button>

              <div>
                <span style={{ color: ssclinicalProgramsOk ? '#1a7f37' : '#b93800' }}>{ssclinicalProgramsOk ? '✅' : '⚠️'}</span>{' '}
                Programs SSClinical seed (coordinadora / enfermera líder / enfermera domicilio / médico).
              </div>
              <button onClick={() => openConfigTab('programs')} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
                Ver Programs
              </button>

              <div>
                <span style={{ color: medilinkOk ? '#1a7f37' : '#b93800' }}>{medilinkOk ? '✅' : '⚠️'}</span> Medilink API configurada (base URL + token).
              </div>
              <button onClick={() => openConfigTab('integrations')} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
                Ver Integraciones
              </button>

              <div>
                <span style={{ color: '#666' }}>🧭</span> Owner/Admin: asigna conversaciones desde Inbox → Detalles → “Asignado a”.
              </div>
              <button onClick={onGoInbox} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
                Abrir Inbox
              </button>

              <div>
                <span style={{ color: '#666' }}>🧪</span> MEMBER assignedOnly: debería ver <strong>solo</strong> conversaciones asignadas (validación manual + scenario).
              </div>
              <button onClick={() => openConfigTab('users')} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
                Ver Usuarios
              </button>
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: '#666', lineHeight: 1.35 }}>
              Recomendado: corre “Run Smoke Scenarios” y verifica que <strong>ssclinical_onboarding</strong> y <strong>ssclinical_assignment_flow</strong> estén en PASS.
            </div>
            <details style={{ marginTop: 10, border: '1px solid #f0f0f0', borderRadius: 10, padding: 10, background: '#fafafa' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 800 }}>Checklist por rol (click-only)</summary>
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, color: '#333' }}>
                <div>
                  <div style={{ fontWeight: 800 }}>OWNER (csarabia@ssclinical.cl)</div>
                  <div style={{ fontSize: 12, color: '#666', marginTop: 4, lineHeight: 1.35 }}>
                    1) Config → Usuarios: verifica invites y roles (MEMBER con assignedOnly).<br />
                    2) Inbox: abre una conversación real, abre Detalles y asigna a “contacto@ssclinical.cl”.<br />
                    3) QA → Logs: filtra por conversationId y revisa AgentRuns / Outbound blockedReason.
                  </div>
                  <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button onClick={() => openConfigTab('users')} style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}>
                      Abrir Usuarios
                    </button>
                    <button onClick={onGoInbox} style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}>
                      Abrir Inbox
                    </button>
                    <button onClick={() => { setLogTab('agentRuns'); setActiveTab('qa'); }} style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}>
                      Abrir Logs (QA)
                    </button>
                  </div>
                </div>

                <div>
                  <div style={{ fontWeight: 800 }}>ADMIN (gestion.ejecutivos.ventas@gmail.com)</div>
                  <div style={{ fontSize: 12, color: '#666', marginTop: 4, lineHeight: 1.35 }}>
                    1) Inbox: ver conversaciones y usar “Sugerir” respetando Program.<br />
                    2) QA: revisar errores y bloqueos (SAFE MODE / OUTSIDE_24H / NO_CONTACTAR).
                  </div>
                  <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button onClick={onGoInbox} style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}>
                      Abrir Inbox
                    </button>
                    <button onClick={() => setActiveTab('qa')} style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}>
                      Abrir QA
                    </button>
                  </div>
                </div>

                <div>
                  <div style={{ fontWeight: 800 }}>MEMBER assignedOnly (contacto@ssclinical.cl)</div>
                  <div style={{ fontSize: 12, color: '#666', marginTop: 4, lineHeight: 1.35 }}>
                    1) Inicia sesión y confirma que ves SOLO conversaciones asignadas.<br />
                    2) Si no ves nada, pídele al OWNER que asigne una conversación desde Detalles.
                  </div>
                </div>
              </div>
            </details>
            {workspaceConnectorsError ? <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>{workspaceConnectorsError}</div> : null}
          </div>

          <div style={{ marginTop: 16, border: '1px solid #eee', borderRadius: 12, padding: 12, background: '#fff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ fontWeight: 800 }}>Logs recientes</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <input
                  data-guide-id="review-logs-filter"
                  value={outboundConversationId}
                  onChange={(e) => setOutboundConversationId(e.target.value)}
                  placeholder="Filtro conversationId (opcional)"
                  style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 12, width: 260 }}
                />
                <button onClick={() => refreshLogs().catch(() => {})} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
                  Refresh
                </button>
              </div>
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
              <button onClick={() => setLogTab('copilotRuns')} style={{ padding: '4px 10px', borderRadius: 999, border: logTab === 'copilotRuns' ? '1px solid #111' : '1px solid #ccc', background: logTab === 'copilotRuns' ? '#111' : '#fff', color: logTab === 'copilotRuns' ? '#fff' : '#333', fontSize: 12 }}>
                Copilot Runs
              </button>
              <button onClick={() => setLogTab('configChanges')} style={{ padding: '4px 10px', borderRadius: 999, border: logTab === 'configChanges' ? '1px solid #111' : '1px solid #ccc', background: logTab === 'configChanges' ? '#111' : '#fff', color: logTab === 'configChanges' ? '#fff' : '#333', fontSize: 12 }}>
                Config Changes
              </button>
              <button onClick={() => setLogTab('connectorCalls')} style={{ padding: '4px 10px', borderRadius: 999, border: logTab === 'connectorCalls' ? '1px solid #111' : '1px solid #ccc', background: logTab === 'connectorCalls' ? '#111' : '#fff', color: logTab === 'connectorCalls' ? '#fff' : '#333', fontSize: 12 }}>
                Connector Calls
              </button>
              <button onClick={() => openConfigTab('logs')} style={{ marginLeft: 'auto', padding: '4px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}>
                Ver en Config → Logs
              </button>
            </div>
            <div style={{ marginTop: 10, overflowX: 'hidden' }}>{renderLogTable()}</div>
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
                      {!r.ok && r.failedAssertions && r.failedAssertions.length > 0 ? (
                        <div style={{ marginTop: 6, color: '#b93800' }}>
                          {r.failedAssertions.map((a, idx) => (
                            <div key={`${r.id}-fa-${idx}`}>• {a}</div>
                          ))}
                        </div>
                      ) : null}
                      {r.startedAt ? <div>startedAt: {r.startedAt}</div> : null}
                      {r.finishedAt ? <div>finishedAt: {r.finishedAt}</div> : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
};

import React, { useEffect, useMemo, useState } from 'react';
import { apiClient } from '../api/client';

type TabKey = 'workspace' | 'users' | 'phoneLines' | 'programs' | 'automations' | 'usage' | 'logs';
type LogsTabKey = 'agentRuns' | 'automationRuns';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'workspace', label: 'Workspace' },
  { key: 'users', label: 'Usuarios' },
  { key: 'phoneLines', label: 'Números WhatsApp' },
  { key: 'programs', label: 'Programs' },
  { key: 'automations', label: 'Automations' },
  { key: 'usage', label: 'Uso & Costos' },
  { key: 'logs', label: 'Logs' }
];

const triggerOptions = ['INBOUND_MESSAGE', 'INACTIVITY', 'STAGE_CHANGED', 'PROFILE_UPDATED'];
const conditionFields = [
  'conversation.status',
  'conversation.stage',
  'conversation.programId',
  'conversation.phoneLineId',
  'contact.noContactar',
  'whatsapp.windowStatus',
  'inbound.textContains'
];
const conditionOps = ['equals', 'not_equals', 'in', 'contains'];
const agentOptions = ['orchestrator', 'program_default'];

const downloadJson = (filename: string, data: any) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

export const ConfigPage: React.FC = () => {
  const [tab, setTab] = useState<TabKey>('workspace');
  const [logsTab, setLogsTab] = useState<LogsTabKey>('agentRuns');

  const workspaceId = useMemo(() => localStorage.getItem('workspaceId') || 'default', []);
  const isDev = typeof import.meta !== 'undefined' ? import.meta.env.MODE !== 'production' : true;

  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const currentWorkspace = useMemo(
    () => workspaces.find((w) => String(w.id) === String(localStorage.getItem('workspaceId') || 'default')) || null,
    [workspaces]
  );

  const [outboundSafety, setOutboundSafety] = useState<any | null>(null);
  const [outboundPolicy, setOutboundPolicy] = useState<string>('ALLOWLIST_ONLY');
  const [outboundAllowlistText, setOutboundAllowlistText] = useState<string>('');
  const [outboundStatus, setOutboundStatus] = useState<string | null>(null);
  const [outboundError, setOutboundError] = useState<string | null>(null);

  const [users, setUsers] = useState<any[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('MEMBER');
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const [phoneLines, setPhoneLines] = useState<any[]>([]);
  const [phoneLineEditor, setPhoneLineEditor] = useState<any | null>(null);

  const [programs, setPrograms] = useState<any[]>([]);
  const [programEditor, setProgramEditor] = useState<any | null>(null);
  const [programStatus, setProgramStatus] = useState<string | null>(null);
  const [programError, setProgramError] = useState<string | null>(null);

  const [automations, setAutomations] = useState<any[]>([]);
  const [automationEditor, setAutomationEditor] = useState<any | null>(null);
  const [automationRuns, setAutomationRuns] = useState<any[]>([]);
  const [automationStatus, setAutomationStatus] = useState<string | null>(null);
  const [automationError, setAutomationError] = useState<string | null>(null);

  const [agentRuns, setAgentRuns] = useState<any[]>([]);
  const [automationRunLogs, setAutomationRunLogs] = useState<any[]>([]);
  const [selectedAgentRun, setSelectedAgentRun] = useState<any | null>(null);

  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageOverviewByDays, setUsageOverviewByDays] = useState<Record<string, any>>({});
  const [usageTopPrograms, setUsageTopPrograms] = useState<any[]>([]);
  const [usageTopConversations, setUsageTopConversations] = useState<any[]>([]);
  const [pricingModels, setPricingModels] = useState<Array<{ model: string; promptUsdPer1k: string; completionUsdPer1k: string }>>([]);
  const [waSessionUsd, setWaSessionUsd] = useState<string>('0');
  const [waTemplateUsd, setWaTemplateUsd] = useState<string>('0');
  const [waOverridesText, setWaOverridesText] = useState<string>('');
  const [pricingStatus, setPricingStatus] = useState<string | null>(null);
  const [pricingError, setPricingError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('configSelectedTab');
      const keys = new Set(TABS.map((t) => t.key));
      if (stored && keys.has(stored as any)) {
        setTab(stored as TabKey);
      }
      localStorage.removeItem('configSelectedTab');
    } catch {
      // ignore
    }
  }, []);

  const loadWorkspaces = async () => {
    const data = await apiClient.get('/api/workspaces');
    setWorkspaces(Array.isArray(data) ? data : []);
  };
  const loadUsers = async () => {
    const data = await apiClient.get('/api/users');
    setUsers(Array.isArray(data) ? data : []);
  };
  const loadPhoneLines = async () => {
    const data = await apiClient.get('/api/phone-lines');
    setPhoneLines(Array.isArray(data) ? data : []);
  };
  const loadPrograms = async () => {
    const data = await apiClient.get('/api/programs');
    setPrograms(Array.isArray(data) ? data : []);
  };
  const loadAutomations = async () => {
    const data = await apiClient.get('/api/automations');
    setAutomations(Array.isArray(data) ? data : []);
  };
  const loadAgentRuns = async () => {
    const data = await apiClient.get('/api/logs/agent-runs');
    setAgentRuns(Array.isArray(data) ? data : []);
  };
  const loadAutomationRuns = async () => {
    const data = await apiClient.get('/api/logs/automation-runs');
    setAutomationRunLogs(Array.isArray(data) ? data : []);
  };

  const loadOutboundSafety = async () => {
    const data = await apiClient.get('/api/config/outbound-safety');
    setOutboundSafety(data);
    const stored = data?.outboundPolicyStored || data?.outboundPolicy || 'ALLOWLIST_ONLY';
    setOutboundPolicy(String(stored));
    const allow = Array.isArray(data?.outboundAllowlist) ? data.outboundAllowlist : [];
    setOutboundAllowlistText(allow.join('\n'));
  };

  const applyPricingToState = (data: any) => {
    const openAi = data?.openAiModelPricing && typeof data.openAiModelPricing === 'object' ? data.openAiModelPricing : null;
    const rows: Array<{ model: string; promptUsdPer1k: string; completionUsdPer1k: string }> = [];
    if (openAi) {
      for (const [model, v] of Object.entries(openAi)) {
        const prompt = (v as any)?.promptUsdPer1k;
        const completion = (v as any)?.completionUsdPer1k;
        if (typeof model !== 'string') continue;
        rows.push({
          model,
          promptUsdPer1k: typeof prompt === 'number' ? String(prompt) : '',
          completionUsdPer1k: typeof completion === 'number' ? String(completion) : ''
        });
      }
    }
    setPricingModels(rows.sort((a, b) => a.model.localeCompare(b.model)));

    const wa = data?.whatsappPricing && typeof data.whatsappPricing === 'object' ? data.whatsappPricing : null;
    setWaSessionUsd(typeof wa?.sessionTextUsd === 'number' ? String(wa.sessionTextUsd) : '0');
    setWaTemplateUsd(typeof wa?.templateUsd === 'number' ? String(wa.templateUsd) : '0');
    setWaOverridesText(
      wa?.templateByNameUsd && typeof wa.templateByNameUsd === 'object'
        ? JSON.stringify(wa.templateByNameUsd, null, 2)
        : ''
    );
  };

  const loadUsage = async () => {
    setUsageLoading(true);
    setUsageError(null);
    try {
      const [pricing, d1, d7, d30, topP, topC] = await Promise.all([
        apiClient.get('/api/usage/pricing'),
        apiClient.get('/api/usage/overview?days=1'),
        apiClient.get('/api/usage/overview?days=7'),
        apiClient.get('/api/usage/overview?days=30'),
        apiClient.get('/api/usage/top-programs?days=30'),
        apiClient.get('/api/usage/top-conversations?days=30')
      ]);
      applyPricingToState(pricing);
      setUsageOverviewByDays({ '1': d1, '7': d7, '30': d30 });
      setUsageTopPrograms(Array.isArray(topP?.rows) ? topP.rows : []);
      setUsageTopConversations(Array.isArray(topC?.rows) ? topC.rows : []);
    } catch (err: any) {
      setUsageError(err.message || 'No se pudo cargar uso/costos');
      setUsageOverviewByDays({});
      setUsageTopPrograms([]);
      setUsageTopConversations([]);
    } finally {
      setUsageLoading(false);
    }
  };

  const saveUsagePricing = async () => {
    setPricingStatus(null);
    setPricingError(null);
    try {
      const modelObj: any = {};
      for (const row of pricingModels) {
        const model = row.model.trim();
        if (!model) continue;
        const prompt = Number(row.promptUsdPer1k);
        const completion = Number(row.completionUsdPer1k);
        if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) {
          throw new Error(`Precio inválido para modelo: ${model}`);
        }
        modelObj[model] = { promptUsdPer1k: prompt, completionUsdPer1k: completion };
      }

      let overrides: any = undefined;
      const overridesRaw = waOverridesText.trim();
      if (overridesRaw) {
        try {
          overrides = JSON.parse(overridesRaw);
        } catch {
          throw new Error('templateByNameUsd debe ser JSON válido');
        }
      }

      const sessionTextUsd = Number(waSessionUsd);
      const templateUsd = Number(waTemplateUsd);
      if (!Number.isFinite(sessionTextUsd) || sessionTextUsd < 0) throw new Error('sessionTextUsd inválido');
      if (!Number.isFinite(templateUsd) || templateUsd < 0) throw new Error('templateUsd inválido');

      const payload: any = {
        openAiModelPricing: modelObj,
        whatsappPricing: {
          sessionTextUsd,
          templateUsd,
          ...(overrides ? { templateByNameUsd: overrides } : {})
        }
      };
      const updated = await apiClient.put('/api/usage/pricing', payload);
      applyPricingToState(updated);
      setPricingStatus('Guardado.');
      await loadUsage();
    } catch (err: any) {
      setPricingError(err.message || 'No se pudo guardar pricing');
    }
  };

  useEffect(() => {
    loadWorkspaces().catch(() => {});
    loadPrograms().catch(() => {});
    loadPhoneLines().catch(() => {});
    loadAutomations().catch(() => {});
    loadOutboundSafety().catch(() => {});
  }, []);

  useEffect(() => {
    if (tab === 'users') loadUsers().catch(() => {});
    if (tab === 'logs') {
      loadAgentRuns().catch(() => {});
      loadAutomationRuns().catch(() => {});
    }
    if (tab === 'automations') loadAutomations().catch(() => {});
    if (tab === 'programs') loadPrograms().catch(() => {});
    if (tab === 'phoneLines') loadPhoneLines().catch(() => {});
    if (tab === 'usage') loadUsage().catch(() => {});
  }, [tab]);

  const usedAsDefaultCountByProgramId = useMemo(() => {
    const map: Record<string, number> = {};
    for (const line of phoneLines) {
      const pid = line.defaultProgramId;
      if (!pid) continue;
      map[pid] = (map[pid] || 0) + 1;
    }
    return map;
  }, [phoneLines]);

  const exportConfig = async () => {
    const [lines, progs, autos] = await Promise.all([
      apiClient.get('/api/phone-lines'),
      apiClient.get('/api/programs'),
      apiClient.get('/api/automations')
    ]);
    downloadJson(`workspace-${workspaceId}-config.json`, { phoneLines: lines, programs: progs, automations: autos });
  };

  const saveUserRole = async (membershipId: string, role: string) => {
    await apiClient.patch(`/api/users/${membershipId}`, { role });
    await loadUsers();
  };
  const toggleUserArchived = async (membershipId: string, archived: boolean) => {
    await apiClient.patch(`/api/users/${membershipId}`, { archived });
    await loadUsers();
  };

  const inviteUser = async () => {
    setInviteStatus(null);
    setInviteError(null);
    try {
      const res = await apiClient.post('/api/users/invite', { email: inviteEmail, role: inviteRole });
      if (res?.tempPassword) {
        setInviteStatus(`Usuario creado. Password temporal: ${res.tempPassword}`);
      } else {
        setInviteStatus('Usuario invitado / rol actualizado.');
      }
      setInviteEmail('');
      setInviteOpen(false);
      await loadUsers();
    } catch (err: any) {
      setInviteError(err.message || 'No se pudo invitar');
    }
  };

  const savePhoneLine = async () => {
    if (!phoneLineEditor) return;
    const payload = {
      alias: phoneLineEditor.alias,
      phoneE164: phoneLineEditor.phoneE164 || null,
      waPhoneNumberId: phoneLineEditor.waPhoneNumberId,
      wabaId: phoneLineEditor.wabaId || null,
      defaultProgramId: phoneLineEditor.defaultProgramId || null,
      isActive: Boolean(phoneLineEditor.isActive)
    };
    if (phoneLineEditor.id) {
      await apiClient.patch(`/api/phone-lines/${phoneLineEditor.id}`, payload);
    } else {
      await apiClient.post('/api/phone-lines', payload);
    }
    setPhoneLineEditor(null);
    await loadPhoneLines();
  };

  const saveProgram = async () => {
    if (!programEditor) return;
    setProgramStatus(null);
    setProgramError(null);
    try {
      const payload = {
        name: programEditor.name,
        slug: programEditor.slug,
        description: programEditor.description || null,
        isActive: Boolean(programEditor.isActive),
        agentSystemPrompt: programEditor.agentSystemPrompt
      };
      if (programEditor.id) {
        await apiClient.patch(`/api/programs/${programEditor.id}`, payload);
      } else {
        await apiClient.post('/api/programs', payload);
      }
      setProgramStatus('Guardado.');
      setProgramEditor(null);
      await loadPrograms();
    } catch (err: any) {
      setProgramError(err.message || 'No se pudo guardar');
    }
  };

  const archiveProgram = async () => {
    if (!programEditor?.id) return;
    setProgramStatus(null);
    setProgramError(null);
    const ok = window.confirm('¿Archivar Program? (no se elimina)');
    if (!ok) return;
    try {
      await apiClient.patch(`/api/programs/${programEditor.id}`, { archivedAt: new Date().toISOString() });
      setProgramEditor(null);
      await loadPrograms();
    } catch (err: any) {
      setProgramError(err.message || 'No se pudo archivar');
    }
  };

  const duplicateProgram = async () => {
    if (!programEditor) return;
    const name = `${programEditor.name} (copia)`;
    const slug = `${programEditor.slug}-copy`;
    await apiClient.post('/api/programs', {
      name,
      slug,
      description: programEditor.description || null,
      isActive: true,
      agentSystemPrompt: programEditor.agentSystemPrompt
    });
    await loadPrograms();
  };

  const saveAutomation = async () => {
    if (!automationEditor) return;
    setAutomationStatus(null);
    setAutomationError(null);
    try {
      const payload: any = {
        name: automationEditor.name,
        enabled: Boolean(automationEditor.enabled),
        priority: Number(automationEditor.priority || 100),
        trigger: automationEditor.trigger,
        scopePhoneLineId: automationEditor.scopePhoneLineId || null,
        scopeProgramId: automationEditor.scopeProgramId || null
      };
      const hasAdvanced =
        typeof automationEditor.conditionsJson === 'string' || typeof automationEditor.actionsJson === 'string';
      if (hasAdvanced) {
        if (typeof automationEditor.conditionsJson === 'string') payload.conditionsJson = automationEditor.conditionsJson;
        if (typeof automationEditor.actionsJson === 'string') payload.actionsJson = automationEditor.actionsJson;
      } else {
        payload.conditions = automationEditor.conditions || [];
        payload.actions = automationEditor.actions || [];
      }

      if (automationEditor.id) {
        await apiClient.patch(`/api/automations/${automationEditor.id}`, payload);
      } else {
        await apiClient.post('/api/automations', payload);
      }
      setAutomationStatus('Guardado.');
      setAutomationEditor(null);
      await loadAutomations();
    } catch (err: any) {
      setAutomationError(err.message || 'No se pudo guardar');
    }
  };

  const loadRunsForAutomation = async (ruleId: string) => {
    const data = await apiClient.get(`/api/automations/${ruleId}/runs?limit=20`);
    setAutomationRuns(Array.isArray(data) ? data : []);
  };

  const loadAgentRunDetail = async (id: string) => {
    const data = await apiClient.get(`/api/logs/agent-runs/${id}`);
    setSelectedAgentRun(data);
  };

  const saveOutboundSafety = async () => {
    setOutboundStatus(null);
    setOutboundError(null);
    try {
      const allowlist = outboundAllowlistText
        .split(/[\n,]/g)
        .map((v) => v.trim())
        .filter(Boolean);
      const res = await apiClient.put('/api/config/outbound-safety', {
        outboundPolicy,
        outboundAllowlist: allowlist,
      });
      setOutboundSafety(res);
      setOutboundStatus('Guardado.');
    } catch (err: any) {
      setOutboundError(err.message || 'No se pudo guardar');
    }
  };

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '6px 10px',
              borderRadius: 8,
              border: tab === t.key ? '1px solid #111' : '1px solid #ccc',
              background: tab === t.key ? '#111' : '#fff',
              color: tab === t.key ? '#fff' : '#111',
              cursor: 'pointer'
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'workspace' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 720 }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Workspace</div>
          <div style={{ border: '1px solid #eee', borderRadius: 10, padding: 12 }}>
            <div style={{ fontSize: 12, color: '#666' }}>Workspace Name</div>
            <div style={{ fontWeight: 600 }}>{currentWorkspace?.name || '—'}</div>
            <div style={{ marginTop: 10, fontSize: 12, color: '#666' }}>Workspace ID</div>
            <div style={{ fontFamily: 'monospace' }}>{currentWorkspace?.id || '—'}</div>
            <div style={{ marginTop: 10, fontSize: 12, color: '#666' }}>isSandbox</div>
            <div>
              <input type="checkbox" checked={Boolean(currentWorkspace?.isSandbox)} readOnly={!isDev} disabled />
              <span style={{ marginLeft: 8, fontSize: 12, color: '#666' }}>
                {isDev ? '(toggle disponible en dev; backend v1: solo lectura)' : '(solo lectura en production)'}
              </span>
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: '#666' }}>CreatedAt</div>
            <div>{currentWorkspace?.createdAt || '—'}</div>
          </div>
          <button
            onClick={() => exportConfig().catch(() => {})}
            style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #111', background: '#111', color: '#fff', width: 240 }}
          >
            Exportar configuración
          </button>

          <div style={{ marginTop: 14, borderTop: '1px solid #eee', paddingTop: 14 }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>SAFE OUTBOUND MODE</div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 10 }}>
              Protege DEV: bloquea envíos WhatsApp a números fuera de allowlist (admin + test + lista adicional).
            </div>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ fontSize: 12, color: '#666' }}>Policy</div>
              <select
                value={outboundPolicy}
                onChange={(e) => setOutboundPolicy(e.target.value)}
                style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid #ccc' }}
              >
                <option value="ALLOWLIST_ONLY">ALLOWLIST_ONLY (Safe Mode)</option>
                {outboundSafety?.defaultPolicy === 'ALLOW_ALL' ? <option value="ALLOW_ALL">ALLOW_ALL</option> : null}
                <option value="BLOCK_ALL">BLOCK_ALL</option>
              </select>
              {outboundSafety?.defaultPolicy ? (
                <div style={{ fontSize: 12, color: '#666' }}>
                  Default env: <span style={{ fontFamily: 'monospace' }}>{outboundSafety.defaultPolicy}</span>
                </div>
              ) : null}
            </div>

            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>
                Allowlist adicional (1 número por línea, formato E.164 sin espacios)
              </div>
              <textarea
                value={outboundAllowlistText}
                onChange={(e) => setOutboundAllowlistText(e.target.value)}
                placeholder="Ej:\n56982345846\n56994830202"
                rows={4}
                style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
              />
            </div>

            {outboundSafety?.effectiveAllowlist ? (
              <div style={{ marginTop: 10, fontSize: 12, color: '#666' }}>
                Effective allowlist (incluye admin/test):{' '}
                <span style={{ fontFamily: 'monospace' }}>
                  {(outboundSafety.effectiveAllowlist || []).join(', ') || '—'}
                </span>
              </div>
            ) : null}

            <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
              <button
                onClick={() => saveOutboundSafety().catch(() => {})}
                style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #111', background: '#111', color: '#fff' }}
              >
                Guardar
              </button>
              {outboundStatus ? <div style={{ fontSize: 12, color: '#1a7f37' }}>{outboundStatus}</div> : null}
              {outboundError ? <div style={{ fontSize: 12, color: '#b93800' }}>{outboundError}</div> : null}
            </div>
          </div>
        </div>
      ) : null}

      {tab === 'users' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Usuarios</div>
            <button
              onClick={() => {
                setInviteOpen(true);
                setInviteStatus(null);
                setInviteError(null);
              }}
              style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff' }}
            >
              Invitar usuario
            </button>
          </div>

          <div style={{ border: '1px solid #eee', borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Email</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Name</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Role</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>AddedAt</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.membershipId} style={{ borderTop: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 10, fontSize: 13 }}>{u.email}</td>
                    <td style={{ padding: 10, fontSize: 13 }}>{u.name}</td>
                    <td style={{ padding: 10, fontSize: 13 }}>
                      <select
                        value={u.role}
                        onChange={(e) => saveUserRole(u.membershipId, e.target.value).catch(() => {})}
                        style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ccc' }}
                      >
                        {['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'].map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ padding: 10, fontSize: 13 }}>{u.addedAt}</td>
                    <td style={{ padding: 10, fontSize: 13 }}>
                      <button
                        onClick={() => toggleUserArchived(u.membershipId, !u.archivedAt).catch(() => {})}
                        style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ccc', background: '#fff' }}
                      >
                        {u.archivedAt ? 'Reactivar' : 'Desactivar'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {inviteOpen ? (
            <div style={{ border: '1px solid #eee', borderRadius: 10, padding: 12, maxWidth: 520 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Invitar usuario</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="email@dominio.com"
                  style={{ flex: 1, padding: 8, borderRadius: 8, border: '1px solid #ddd' }}
                />
                <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }}>
                  {['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'].map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                <button onClick={() => inviteUser().catch(() => {})} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff' }}>
                  Guardar
                </button>
                <button onClick={() => setInviteOpen(false)} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
                  Cancelar
                </button>
              </div>
              {inviteStatus ? <div style={{ marginTop: 8, fontSize: 12, color: 'green' }}>{inviteStatus}</div> : null}
              {inviteError ? <div style={{ marginTop: 8, fontSize: 12, color: '#b93800' }}>{inviteError}</div> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === 'phoneLines' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Números WhatsApp</div>
            <button
              onClick={() => setPhoneLineEditor({ alias: '', phoneE164: '', waPhoneNumberId: '', wabaId: '', defaultProgramId: '', isActive: true })}
              style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff' }}
            >
              + Agregar número
            </button>
          </div>

          <div style={{ border: '1px solid #eee', borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Alias</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>phoneE164</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>waPhoneNumberId</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>wabaId</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Default Program</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Status</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Last inbound at</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Last outbound at</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {phoneLines.map((l) => (
                  <tr key={l.id} style={{ borderTop: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 10, fontSize: 13 }}>{l.alias}</td>
                    <td style={{ padding: 10, fontSize: 13 }}>{l.phoneE164 || '—'}</td>
                    <td style={{ padding: 10, fontSize: 13 }}>
                      <span style={{ fontFamily: 'monospace' }}>{l.waPhoneNumberId}</span>
                      <button
                        onClick={() => navigator.clipboard.writeText(String(l.waPhoneNumberId || '')).catch(() => {})}
                        style={{ marginLeft: 8, padding: '2px 6px', borderRadius: 6, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                      >
                        Copiar
                      </button>
                    </td>
                    <td style={{ padding: 10, fontSize: 13 }}>{l.wabaId || '—'}</td>
                    <td style={{ padding: 10, fontSize: 13 }}>
                      <select
                        value={l.defaultProgramId || ''}
                        onChange={(e) => apiClient.patch(`/api/phone-lines/${l.id}`, { defaultProgramId: e.target.value || null }).then(loadPhoneLines)}
                        style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ccc' }}
                      >
                        <option value="">—</option>
                        {programs.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ padding: 10, fontSize: 13 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={Boolean(l.isActive)}
                          onChange={(e) => apiClient.patch(`/api/phone-lines/${l.id}`, { isActive: e.target.checked }).then(loadPhoneLines)}
                        />
                        {l.isActive ? 'Active' : 'Inactive'}
                      </label>
                    </td>
                    <td style={{ padding: 10, fontSize: 13 }}>{l.lastInboundAt || '—'}</td>
                    <td style={{ padding: 10, fontSize: 13 }}>{l.lastOutboundAt || '—'}</td>
                    <td style={{ padding: 10, fontSize: 13 }}>
                      <button
                        onClick={() => setPhoneLineEditor({ ...l })}
                        style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ccc', background: '#fff' }}
                      >
                        Editar
                      </button>
                      <button
                        onClick={() => apiClient.patch(`/api/phone-lines/${l.id}`, { isActive: false }).then(loadPhoneLines)}
                        style={{ marginLeft: 8, padding: '4px 8px', borderRadius: 6, border: '1px solid #ccc', background: '#fff' }}
                      >
                        Desactivar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {phoneLineEditor ? (
            <div style={{ border: '1px solid #eee', borderRadius: 10, padding: 12, maxWidth: 720 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>{phoneLineEditor.id ? 'Editar número' : 'Agregar número'}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <input value={phoneLineEditor.alias} onChange={(e) => setPhoneLineEditor({ ...phoneLineEditor, alias: e.target.value })} placeholder="alias (required)" style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }} />
                <input value={phoneLineEditor.phoneE164 || ''} onChange={(e) => setPhoneLineEditor({ ...phoneLineEditor, phoneE164: e.target.value })} placeholder="phoneE164" style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }} />
                <input value={phoneLineEditor.waPhoneNumberId} onChange={(e) => setPhoneLineEditor({ ...phoneLineEditor, waPhoneNumberId: e.target.value })} placeholder="waPhoneNumberId (required)" style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }} />
                <input value={phoneLineEditor.wabaId || ''} onChange={(e) => setPhoneLineEditor({ ...phoneLineEditor, wabaId: e.target.value })} placeholder="wabaId" style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }} />
                <select value={phoneLineEditor.defaultProgramId || ''} onChange={(e) => setPhoneLineEditor({ ...phoneLineEditor, defaultProgramId: e.target.value })} style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }}>
                  <option value="">Default Program</option>
                  {programs.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={Boolean(phoneLineEditor.isActive)} onChange={(e) => setPhoneLineEditor({ ...phoneLineEditor, isActive: e.target.checked })} />
                  Active
                </label>
              </div>
              <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                <button onClick={() => savePhoneLine().catch(() => {})} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff' }}>
                  Guardar
                </button>
                <button onClick={() => setPhoneLineEditor(null)} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
                  Cancelar
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === 'programs' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Programs</div>
            <button
              onClick={() => setProgramEditor({ name: '', slug: '', description: '', isActive: true, agentSystemPrompt: '' })}
              style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff' }}
            >
              + Crear Program
            </button>
          </div>

          <div style={{ border: '1px solid #eee', borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Name</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Slug</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Active</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Used as default in X lines</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>UpdatedAt</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {programs.map((p) => (
                  <tr key={p.id} style={{ borderTop: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 10, fontSize: 13 }}>{p.name}</td>
                    <td style={{ padding: 10, fontSize: 13, fontFamily: 'monospace' }}>{p.slug}</td>
                    <td style={{ padding: 10, fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={Boolean(p.isActive)}
                        onChange={(e) => apiClient.patch(`/api/programs/${p.id}`, { isActive: e.target.checked }).then(loadPrograms)}
                      />
                    </td>
                    <td style={{ padding: 10, fontSize: 13 }}>{usedAsDefaultCountByProgramId[p.id] || 0}</td>
                    <td style={{ padding: 10, fontSize: 13 }}>{p.updatedAt}</td>
                    <td style={{ padding: 10, fontSize: 13 }}>
                      <button onClick={() => setProgramEditor({ ...p })} style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ccc', background: '#fff' }}>
                        Editar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {programEditor ? (
            <div style={{ border: '1px solid #eee', borderRadius: 10, padding: 12, maxWidth: 900 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>{programEditor.id ? 'Editar Program' : 'Crear Program'}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <input value={programEditor.name} onChange={(e) => setProgramEditor({ ...programEditor, name: e.target.value })} placeholder="name (required)" style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }} />
                <input value={programEditor.slug} onChange={(e) => setProgramEditor({ ...programEditor, slug: e.target.value })} placeholder="slug (unique)" style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }} />
                <input value={programEditor.description || ''} onChange={(e) => setProgramEditor({ ...programEditor, description: e.target.value })} placeholder="description" style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }} />
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={Boolean(programEditor.isActive)} onChange={(e) => setProgramEditor({ ...programEditor, isActive: e.target.checked })} />
                  Active
                </label>
              </div>
              <div style={{ marginTop: 10, fontSize: 12, color: '#666' }}>
                Hint: Define objetivo, datos a recolectar, tono, y cómo decidir SET_STAGE/SET_STATUS/SEND_MESSAGE.
              </div>
              <textarea
                value={programEditor.agentSystemPrompt || ''}
                onChange={(e) => setProgramEditor({ ...programEditor, agentSystemPrompt: e.target.value })}
                rows={12}
                style={{ width: '100%', marginTop: 8, padding: 10, borderRadius: 10, border: '1px solid #ddd', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 12 }}
              />
              <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={() => saveProgram().catch(() => {})} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff' }}>
                  Guardar
                </button>
                <button onClick={() => duplicateProgram().catch(() => {})} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
                  Duplicar Program
                </button>
                {programEditor.id ? (
                  <button onClick={() => archiveProgram().catch(() => {})} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
                    Archivar
                  </button>
                ) : null}
                <button onClick={() => setProgramEditor(null)} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
                  Cancelar
                </button>
              </div>
              {programStatus ? <div style={{ marginTop: 8, fontSize: 12, color: 'green' }}>{programStatus}</div> : null}
              {programError ? <div style={{ marginTop: 8, fontSize: 12, color: '#b93800' }}>{programError}</div> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === 'automations' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Automations</div>
            <button
              onClick={() =>
                setAutomationEditor({
                  name: '',
                  enabled: true,
                  priority: 100,
                  trigger: 'INBOUND_MESSAGE',
                  scopePhoneLineId: '',
                  scopeProgramId: '',
                  conditions: [],
                  actions: [{ type: 'RUN_AGENT', agent: 'program_default' }]
                })
              }
              style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff' }}
            >
              + Nueva regla
            </button>
          </div>

          <div style={{ border: '1px solid #eee', borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Enabled</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Name</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Trigger</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Scope</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Priority</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Last run status</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Last run at</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {automations.map((r) => (
                  <tr key={r.id} style={{ borderTop: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 10, fontSize: 13 }}>
                      <input type="checkbox" checked={Boolean(r.enabled)} onChange={(e) => apiClient.patch(`/api/automations/${r.id}`, { enabled: e.target.checked }).then(loadAutomations)} />
                    </td>
                    <td style={{ padding: 10, fontSize: 13 }}>{r.name}</td>
                    <td style={{ padding: 10, fontSize: 13 }}>{r.trigger}</td>
                    <td style={{ padding: 10, fontSize: 13 }}>
                      {(r.scopePhoneLineId ? `Line:${r.scopePhoneLineId}` : 'Any') + ' / ' + (r.scopeProgramId ? `Program:${r.scopeProgramId}` : 'Any')}
                    </td>
                    <td style={{ padding: 10, fontSize: 13 }}>{r.priority}</td>
                    <td style={{ padding: 10, fontSize: 13 }}>{r.lastRunStatus || '—'}</td>
                    <td style={{ padding: 10, fontSize: 13 }}>{r.lastRunAt || '—'}</td>
                    <td style={{ padding: 10, fontSize: 13 }}>
                      <button
                        onClick={() => {
                          setAutomationEditor({ ...r });
                          if (r.id) loadRunsForAutomation(r.id).catch(() => {});
                        }}
                        style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ccc', background: '#fff' }}
                      >
                        Editar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {automationEditor ? (
            <div style={{ border: '1px solid #eee', borderRadius: 10, padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Rule editor</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <input value={automationEditor.name || ''} onChange={(e) => setAutomationEditor({ ...automationEditor, name: e.target.value })} placeholder="name (required)" style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }} />
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={Boolean(automationEditor.enabled)} onChange={(e) => setAutomationEditor({ ...automationEditor, enabled: e.target.checked })} />
                  Enabled
                </label>
                <input value={automationEditor.priority ?? 100} onChange={(e) => setAutomationEditor({ ...automationEditor, priority: Number(e.target.value) })} type="number" style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }} />
                <select value={automationEditor.trigger || 'INBOUND_MESSAGE'} onChange={(e) => setAutomationEditor({ ...automationEditor, trigger: e.target.value })} style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }}>
                  {triggerOptions.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <select value={automationEditor.scopePhoneLineId || ''} onChange={(e) => setAutomationEditor({ ...automationEditor, scopePhoneLineId: e.target.value })} style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }}>
                  <option value="">Any (PhoneLine)</option>
                  {phoneLines.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.alias}
                    </option>
                  ))}
                </select>
                <select value={automationEditor.scopeProgramId || ''} onChange={(e) => setAutomationEditor({ ...automationEditor, scopeProgramId: e.target.value })} style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }}>
                  <option value="">Any (Program)</option>
                  {programs.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ marginTop: 12 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>conditions (AND)</div>
                {(automationEditor.conditions || []).map((row: any, idx: number) => (
                  <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 8, marginBottom: 6 }}>
                    <select value={row.field} onChange={(e) => {
                      const next = [...automationEditor.conditions];
                      next[idx] = { ...row, field: e.target.value };
                      setAutomationEditor({ ...automationEditor, conditions: next });
                    }} style={{ padding: 6, borderRadius: 8, border: '1px solid #ddd' }}>
                      {conditionFields.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                    <select value={row.op} onChange={(e) => {
                      const next = [...automationEditor.conditions];
                      next[idx] = { ...row, op: e.target.value };
                      setAutomationEditor({ ...automationEditor, conditions: next });
                    }} style={{ padding: 6, borderRadius: 8, border: '1px solid #ddd' }}>
                      {conditionOps.map((op) => (
                        <option key={op} value={op}>
                          {op}
                        </option>
                      ))}
                    </select>
                    <input value={row.value ?? ''} onChange={(e) => {
                      const next = [...automationEditor.conditions];
                      next[idx] = { ...row, value: e.target.value };
                      setAutomationEditor({ ...automationEditor, conditions: next });
                    }} style={{ padding: 6, borderRadius: 8, border: '1px solid #ddd' }} />
                    <button onClick={() => {
                      const next = (automationEditor.conditions || []).filter((_r: any, i: number) => i !== idx);
                      setAutomationEditor({ ...automationEditor, conditions: next });
                    }} style={{ padding: '4px 8px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
                      -
                    </button>
                  </div>
                ))}
                <button onClick={() => setAutomationEditor({ ...automationEditor, conditions: [...(automationEditor.conditions || []), { field: 'conversation.status', op: 'equals', value: 'NEW' }] })} style={{ padding: '4px 8px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
                  + Agregar condición
                </button>
              </div>

              <div style={{ marginTop: 12 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>actions</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: '#555' }}>RUN_AGENT</span>
                  <select
                    value={(automationEditor.actions?.find((a: any) => a.type === 'RUN_AGENT')?.agent || 'program_default') as string}
                    onChange={(e) => {
                      const nextActions = (automationEditor.actions || []).filter((a: any) => a.type !== 'RUN_AGENT');
                      nextActions.unshift({ type: 'RUN_AGENT', agent: e.target.value });
                      setAutomationEditor({ ...automationEditor, actions: nextActions });
                    }}
                    style={{ padding: 6, borderRadius: 8, border: '1px solid #ddd' }}
                  >
                    {agentOptions.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <details style={{ marginTop: 12 }}>
                <summary style={{ cursor: 'pointer' }}>Advanced JSON</summary>
                <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <textarea value={automationEditor.conditionsJson || ''} onChange={(e) => setAutomationEditor({ ...automationEditor, conditionsJson: e.target.value })} placeholder="conditionsJson" rows={8} style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd', fontFamily: 'monospace', fontSize: 12 }} />
                  <textarea value={automationEditor.actionsJson || ''} onChange={(e) => setAutomationEditor({ ...automationEditor, actionsJson: e.target.value })} placeholder="actionsJson" rows={8} style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd', fontFamily: 'monospace', fontSize: 12 }} />
                </div>
                <div style={{ fontSize: 12, color: '#666', marginTop: 6 }}>Si editas JSON, se enviará tal cual al backend.</div>
              </details>

              <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={() => saveAutomation().catch(() => {})} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff' }}>
                  Guardar
                </button>
                <button onClick={() => setAutomationEditor(null)} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
                  Cancelar
                </button>
              </div>
              {automationStatus ? <div style={{ marginTop: 8, fontSize: 12, color: 'green' }}>{automationStatus}</div> : null}
              {automationError ? <div style={{ marginTop: 8, fontSize: 12, color: '#b93800' }}>{automationError}</div> : null}

              <div style={{ marginTop: 14, borderTop: '1px solid #eee', paddingTop: 10 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Run Logs</div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Últimos 20</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {automationRuns.map((r) => (
                    <div key={r.id} style={{ fontSize: 12, border: '1px solid #eee', borderRadius: 8, padding: 8, background: '#fafafa' }}>
                      <div>
                        <strong>{r.status}</strong> · {r.createdAt} · {r.eventType} · {r.conversationId || '—'}
                      </div>
                      {r.error ? <div style={{ color: '#b93800' }}>{r.error}</div> : null}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === 'usage' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <div style={{ fontSize: 18, fontWeight: 800 }}>Uso & Costos</div>
            <button
              onClick={() => loadUsage().catch(() => {})}
              style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}
            >
              Refresh
            </button>
          </div>

          {usageLoading ? <div style={{ fontSize: 12, color: '#666' }}>Cargando…</div> : null}
          {usageError ? <div style={{ fontSize: 12, color: '#b93800' }}>{usageError}</div> : null}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            {[
              { days: '1', label: 'Hoy' },
              { days: '7', label: '7 días' },
              { days: '30', label: '30 días' }
            ].map((w) => {
              const data = usageOverviewByDays[w.days];
              const openai = data?.openai || {};
              const wa = data?.whatsapp || {};
              const costOpenai = typeof openai?.costUsdKnown === 'number' ? `$${openai.costUsdKnown.toFixed(4)}` : '—';
              const costWa = typeof wa?.costUsdKnown === 'number' ? `$${wa.costUsdKnown.toFixed(4)}` : '—';
              return (
                <div key={w.days} style={{ border: '1px solid #eee', borderRadius: 12, padding: 12, background: '#fff' }}>
                  <div style={{ fontWeight: 900 }}>{w.label}</div>
                  <div style={{ marginTop: 8, fontSize: 12, color: '#555' }}>
                    <div>
                      OpenAI tokens: <strong>{openai?.totalTokens ?? '—'}</strong> · costo: <strong>{costOpenai}</strong>
                    </div>
                    <div style={{ marginTop: 4 }}>
                      WhatsApp: <strong>{wa?.sentSessionText ?? '—'}</strong> session · <strong>{wa?.sentTemplate ?? '—'}</strong> templates ·{' '}
                      <strong style={{ color: wa?.blocked ? '#b93800' : '#555' }}>{wa?.blocked ?? '—'}</strong> bloqueados · costo:{' '}
                      <strong>{costWa}</strong>
                    </div>
                    {openai?.missingPricingModels?.length ? (
                      <div style={{ marginTop: 6, color: '#b93800' }}>Falta pricing para: {openai.missingPricingModels.join(', ')}</div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 12, background: '#fff' }}>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>Pricing (editable)</div>

            <div style={{ fontWeight: 800, marginBottom: 6 }}>OpenAI (USD por 1k tokens)</div>
            <div style={{ border: '1px solid #f0f0f0', borderRadius: 10, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Modelo</th>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Prompt</th>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Completion</th>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Acción</th>
                  </tr>
                </thead>
                <tbody>
                  {pricingModels.length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ padding: 10, fontSize: 12, color: '#666' }}>
                        No hay pricing configurado (aún). Agrega modelos para estimar costo.
                      </td>
                    </tr>
                  ) : null}
                  {pricingModels.map((row, idx) => (
                    <tr key={`${row.model}-${idx}`} style={{ borderTop: '1px solid #f0f0f0' }}>
                      <td style={{ padding: 10 }}>
                        <input
                          value={row.model}
                          onChange={(e) => {
                            const next = [...pricingModels];
                            next[idx] = { ...row, model: e.target.value };
                            setPricingModels(next);
                          }}
                          style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #ddd', fontFamily: 'monospace', fontSize: 12 }}
                          placeholder="gpt-4.1-mini"
                        />
                      </td>
                      <td style={{ padding: 10 }}>
                        <input
                          value={row.promptUsdPer1k}
                          onChange={(e) => {
                            const next = [...pricingModels];
                            next[idx] = { ...row, promptUsdPer1k: e.target.value };
                            setPricingModels(next);
                          }}
                          style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #ddd', fontSize: 12 }}
                          placeholder="0.0004"
                        />
                      </td>
                      <td style={{ padding: 10 }}>
                        <input
                          value={row.completionUsdPer1k}
                          onChange={(e) => {
                            const next = [...pricingModels];
                            next[idx] = { ...row, completionUsdPer1k: e.target.value };
                            setPricingModels(next);
                          }}
                          style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #ddd', fontSize: 12 }}
                          placeholder="0.0016"
                        />
                      </td>
                      <td style={{ padding: 10 }}>
                        <button
                          onClick={() => setPricingModels(pricingModels.filter((_r, i) => i !== idx))}
                          style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                        >
                          Quitar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              onClick={() => setPricingModels([...pricingModels, { model: '', promptUsdPer1k: '', completionUsdPer1k: '' }])}
              style={{ marginTop: 10, padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
            >
              + Agregar modelo
            </button>

            <div style={{ marginTop: 14, fontWeight: 800, marginBottom: 6 }}>WhatsApp (estimación simple)</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, maxWidth: 720 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#555' }}>
                SESSION_TEXT (USD por mensaje)
                <input value={waSessionUsd} onChange={(e) => setWaSessionUsd(e.target.value)} style={{ padding: 8, borderRadius: 10, border: '1px solid #ddd' }} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#555' }}>
                TEMPLATE (USD por mensaje)
                <input value={waTemplateUsd} onChange={(e) => setWaTemplateUsd(e.target.value)} style={{ padding: 8, borderRadius: 10, border: '1px solid #ddd' }} />
              </label>
            </div>
            <div style={{ marginTop: 10, maxWidth: 720 }}>
              <div style={{ fontSize: 12, color: '#555', marginBottom: 6 }}>Overrides por templateName (JSON opcional)</div>
              <textarea
                value={waOverridesText}
                onChange={(e) => setWaOverridesText(e.target.value)}
                placeholder='{\n  "postulacion_completar_1": 0.01\n}'
                rows={6}
                style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd', fontFamily: 'monospace', fontSize: 12 }}
              />
            </div>

            <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                onClick={() => saveUsagePricing().catch(() => {})}
                style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #111', background: '#111', color: '#fff', fontSize: 12 }}
              >
                Guardar pricing
              </button>
              {pricingStatus ? <div style={{ fontSize: 12, color: '#1a7f37' }}>{pricingStatus}</div> : null}
              {pricingError ? <div style={{ fontSize: 12, color: '#b93800' }}>{pricingError}</div> : null}
            </div>
          </div>

          <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 12, background: '#fff' }}>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>Top Programs (30 días)</div>
            <div style={{ border: '1px solid #f0f0f0', borderRadius: 10, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Program</th>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Tokens</th>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Costo (USD)</th>
                  </tr>
                </thead>
                <tbody>
                  {usageTopPrograms.slice(0, 15).map((r: any) => (
                    <tr key={r.programId} style={{ borderTop: '1px solid #f0f0f0' }}>
                      <td style={{ padding: 10, fontSize: 13 }}>{r.program?.name || r.programId}</td>
                      <td style={{ padding: 10, fontSize: 13 }}>{r.totalTokens}</td>
                      <td style={{ padding: 10, fontSize: 13 }}>
                        {typeof r.costUsdKnown === 'number' ? `$${r.costUsdKnown.toFixed(4)}` : '—'}
                      </td>
                    </tr>
                  ))}
                  {usageTopPrograms.length === 0 ? (
                    <tr>
                      <td colSpan={3} style={{ padding: 10, fontSize: 12, color: '#666' }}>
                        Sin datos.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 12, background: '#fff' }}>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>Top Conversaciones por tokens (30 días)</div>
            <div style={{ border: '1px solid #f0f0f0', borderRadius: 10, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>conversationId</th>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {usageTopConversations.slice(0, 15).map((r: any) => (
                    <tr key={r.conversationId} style={{ borderTop: '1px solid #f0f0f0' }}>
                      <td style={{ padding: 10, fontSize: 12, fontFamily: 'monospace' }}>{r.conversationId}</td>
                      <td style={{ padding: 10, fontSize: 13 }}>{r.totalTokens}</td>
                    </tr>
                  ))}
                  {usageTopConversations.length === 0 ? (
                    <tr>
                      <td colSpan={2} style={{ padding: 10, fontSize: 12, color: '#666' }}>
                        Sin datos.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      {tab === 'logs' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setLogsTab('agentRuns')} style={{ padding: '6px 10px', borderRadius: 8, border: logsTab === 'agentRuns' ? '1px solid #111' : '1px solid #ccc', background: logsTab === 'agentRuns' ? '#111' : '#fff', color: logsTab === 'agentRuns' ? '#fff' : '#111' }}>
              Agent Runs
            </button>
            <button onClick={() => setLogsTab('automationRuns')} style={{ padding: '6px 10px', borderRadius: 8, border: logsTab === 'automationRuns' ? '1px solid #111' : '1px solid #ccc', background: logsTab === 'automationRuns' ? '#111' : '#fff', color: logsTab === 'automationRuns' ? '#fff' : '#111' }}>
              Automation Runs
            </button>
          </div>

          {logsTab === 'agentRuns' ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, minHeight: 0 }}>
              <div style={{ border: '1px solid #eee', borderRadius: 10, overflow: 'hidden', minHeight: 0 }}>
                <div style={{ padding: 10, background: '#fafafa', borderBottom: '1px solid #eee', fontWeight: 700 }}>Agent Runs</div>
                <div style={{ overflowY: 'auto', maxHeight: 520 }}>
                  {agentRuns.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => loadAgentRunDetail(r.id).catch(() => {})}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: 10, border: 'none', borderBottom: '1px solid #f0f0f0', background: '#fff', cursor: 'pointer' }}
                    >
                      <div style={{ fontSize: 12, color: '#666' }}>{r.createdAt}</div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{r.eventType} · {r.status}</div>
                      <div style={{ fontSize: 12, color: '#666' }}>{r.conversationId || '—'}</div>
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ border: '1px solid #eee', borderRadius: 10, padding: 12, minHeight: 0 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Agent Run detail</div>
                {selectedAgentRun ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ fontSize: 12, color: '#666' }}>
                      {selectedAgentRun.createdAt} · {selectedAgentRun.eventType} · {selectedAgentRun.status}
                    </div>
                    <details open>
                      <summary style={{ cursor: 'pointer' }}>InputContext</summary>
                      <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{JSON.stringify(selectedAgentRun.inputContext, null, 2)}</pre>
                    </details>
                    <details>
                      <summary style={{ cursor: 'pointer' }}>Commands</summary>
                      <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{JSON.stringify(selectedAgentRun.commands, null, 2)}</pre>
                    </details>
                    <details>
                      <summary style={{ cursor: 'pointer' }}>Execution Results</summary>
                      <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{JSON.stringify(selectedAgentRun.results, null, 2)}</pre>
                    </details>
                    <details>
                      <summary style={{ cursor: 'pointer' }}>Tool calls</summary>
                      <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{JSON.stringify(selectedAgentRun.toolCalls, null, 2)}</pre>
                    </details>
                    <details>
                      <summary style={{ cursor: 'pointer' }}>Outbound messages</summary>
                      <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{JSON.stringify(selectedAgentRun.outboundMessages, null, 2)}</pre>
                    </details>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: '#666' }}>Selecciona un Agent Run.</div>
                )}
              </div>
            </div>
          ) : null}

          {logsTab === 'automationRuns' ? (
            <div style={{ border: '1px solid #eee', borderRadius: 10, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>createdAt</th>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>workspace</th>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>conversationId</th>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>eventType</th>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>status</th>
                  </tr>
                </thead>
                <tbody>
                  {automationRunLogs.map((r) => (
                    <tr key={r.id} style={{ borderTop: '1px solid #f0f0f0' }}>
                      <td style={{ padding: 10, fontSize: 13 }}>{r.createdAt}</td>
                      <td style={{ padding: 10, fontSize: 13 }}>{r.workspaceId}</td>
                      <td style={{ padding: 10, fontSize: 13 }}>{r.conversationId || '—'}</td>
                      <td style={{ padding: 10, fontSize: 13 }}>{r.eventType}</td>
                      <td style={{ padding: 10, fontSize: 13 }}>{r.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

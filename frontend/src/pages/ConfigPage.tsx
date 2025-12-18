import React, { useEffect, useMemo, useState } from 'react';
import { apiClient } from '../api/client';

type TabKey = 'workspace' | 'integrations' | 'users' | 'phoneLines' | 'programs' | 'automations' | 'usage' | 'logs';
type LogsTabKey = 'agentRuns' | 'automationRuns';

const looksLikeSecretOrToken = (value: string): boolean => {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (/^EAAB/i.test(raw)) return true;
  if (/[A-Za-z]/.test(raw)) return true;
  if (raw.length >= 30 && /[A-Za-z0-9_-]{30,}/.test(raw)) return true;
  return false;
};

const normalizeChilePhoneE164 = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  let raw = value.trim();
  if (!raw) return null;
  if (looksLikeSecretOrToken(raw)) {
    throw new Error('phoneE164 parece un token/credencial. Debe ser un número en formato E.164 (ej: +56994830202).');
  }
  raw = raw.replace(/[()\s-]+/g, '');
  if (/^\d+$/.test(raw)) raw = `+${raw}`;
  if (!/^\+56\d{9}$/.test(raw)) {
    throw new Error('phoneE164 inválido. Usa formato E.164 Chile: +56 seguido de 9 dígitos (ej: +56994830202).');
  }
  return raw;
};

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'workspace', label: 'Workspace' },
  { key: 'integrations', label: 'Integraciones' },
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
  'conversation.stageTags',
  'conversation.programId',
  'conversation.phoneLineId',
  'contact.noContactar',
  'contact.hasCandidateName',
  'contact.hasLocation',
  'contact.hasRut',
  'contact.hasEmail',
  'contact.hasAvailability',
  'contact.hasExperience',
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

export const ConfigPage: React.FC<{ workspaceRole: string | null; isOwner: boolean }> = ({ workspaceRole, isOwner }) => {
  const roleUpper = String(workspaceRole || '').toUpperCase();
  const isWorkspaceAdmin = isOwner || roleUpper === 'ADMIN';
  const visibleTabs = useMemo(() => {
    if (isOwner) return TABS;
    if (isWorkspaceAdmin) {
      return TABS.filter((t) => !['workspace', 'integrations', 'users'].includes(t.key));
    }
    return [];
  }, [isOwner, isWorkspaceAdmin]);

  const [tab, setTab] = useState<TabKey>(() => {
    const fallback: TabKey = isOwner ? 'workspace' : 'programs';
    try {
      const stored = localStorage.getItem('configSelectedTab');
      const allowed = new Set(visibleTabs.map((t) => t.key));
      if (stored && allowed.has(stored as any)) return stored as TabKey;
    } catch {
      // ignore
    }
    return fallback;
  });
  const [logsTab, setLogsTab] = useState<LogsTabKey>('agentRuns');
  const [isNarrow, setIsNarrow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < 900;
  });
  const [focusedProgramId, setFocusedProgramId] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem('configSelectedTab', tab);
    } catch {
      // ignore
    }
    try {
      const desired = tab ? `/config/${encodeURIComponent(tab)}` : '/config';
      if (typeof window !== 'undefined' && window.location.pathname !== desired) {
        window.history.replaceState({}, '', desired);
      }
    } catch {
      // ignore
    }
  }, [tab]);

  const workspaceId = useMemo(() => localStorage.getItem('workspaceId') || 'default', []);
  const isDev = typeof import.meta !== 'undefined' ? import.meta.env.MODE !== 'production' : true;

  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const currentWorkspace = useMemo(
    () => workspaces.find((w) => String(w.id) === String(localStorage.getItem('workspaceId') || 'default')) || null,
    [workspaces]
  );

  const [cloneSourceWorkspaceId, setCloneSourceWorkspaceId] = useState<string>('');
  const [clonePrograms, setClonePrograms] = useState<boolean>(true);
  const [cloneAutomations, setCloneAutomations] = useState<boolean>(true);
  const [cloneConnectors, setCloneConnectors] = useState<boolean>(true);
  const [cloneStatus, setCloneStatus] = useState<string | null>(null);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [cloneResult, setCloneResult] = useState<any | null>(null);

  const [outboundSafety, setOutboundSafety] = useState<any | null>(null);
  const [outboundPolicy, setOutboundPolicy] = useState<string>('ALLOWLIST_ONLY');
  const [outboundAllowlistText, setOutboundAllowlistText] = useState<string>('');
  const [outboundStatus, setOutboundStatus] = useState<string | null>(null);
  const [outboundError, setOutboundError] = useState<string | null>(null);
  const [tempOffMinutes, setTempOffMinutes] = useState<number>(30);
  const [tempOffStatus, setTempOffStatus] = useState<string | null>(null);
  const [tempOffError, setTempOffError] = useState<string | null>(null);

  const [integrationsAi, setIntegrationsAi] = useState<any | null>(null);
  const [integrationsAiModel, setIntegrationsAiModel] = useState<string>('');
  const [integrationsAiKey, setIntegrationsAiKey] = useState<string>('');
  const [integrationsAiStatus, setIntegrationsAiStatus] = useState<string | null>(null);
  const [integrationsAiError, setIntegrationsAiError] = useState<string | null>(null);
  const [integrationsAiTest, setIntegrationsAiTest] = useState<string | null>(null);

  const [integrationsWa, setIntegrationsWa] = useState<any | null>(null);
  const [integrationsWaBaseUrl, setIntegrationsWaBaseUrl] = useState<string>('');
  const [integrationsWaPhoneId, setIntegrationsWaPhoneId] = useState<string>('');
  const [integrationsWaToken, setIntegrationsWaToken] = useState<string>('');
  const [integrationsWaVerifyToken, setIntegrationsWaVerifyToken] = useState<string>('');
  const [integrationsWaStatus, setIntegrationsWaStatus] = useState<string | null>(null);
  const [integrationsWaError, setIntegrationsWaError] = useState<string | null>(null);
  const [integrationsWaTest, setIntegrationsWaTest] = useState<string | null>(null);

  const [connectors, setConnectors] = useState<any[]>([]);
  const [connectorEditor, setConnectorEditor] = useState<any | null>(null);
  const [connectorStatus, setConnectorStatus] = useState<string | null>(null);
  const [connectorError, setConnectorError] = useState<string | null>(null);
  const [connectorTestStatus, setConnectorTestStatus] = useState<Record<string, string>>({});

  const medilinkConnector = useMemo(
    () => (Array.isArray(connectors) ? connectors : []).find((c: any) => String(c?.slug || '').toLowerCase() === 'medilink') || null,
    [connectors],
  );
  const [medilinkBaseUrl, setMedilinkBaseUrl] = useState<string>('');
  const [medilinkToken, setMedilinkToken] = useState<string>('');
  const [medilinkTestPath, setMedilinkTestPath] = useState<string>('/health');
  const [medilinkTestMethod, setMedilinkTestMethod] = useState<string>('GET');
  const [medilinkStatus, setMedilinkStatus] = useState<string | null>(null);
  const [medilinkError, setMedilinkError] = useState<string | null>(null);

  const [authorizedAdminNumbersText, setAuthorizedAdminNumbersText] = useState<string>('');
  const [authorizedTestNumbersText, setAuthorizedTestNumbersText] = useState<string>('');
  const [authorizedNumbersStatus, setAuthorizedNumbersStatus] = useState<string | null>(null);
  const [authorizedNumbersError, setAuthorizedNumbersError] = useState<string | null>(null);

  const [users, setUsers] = useState<any[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('MEMBER');
  const [inviteAssignedOnly, setInviteAssignedOnly] = useState(false);
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [invites, setInvites] = useState<any[]>([]);
  const [invitesIncludeArchived, setInvitesIncludeArchived] = useState(false);
  const [invitesError, setInvitesError] = useState<string | null>(null);
  const [inviteUrlById, setInviteUrlById] = useState<Record<string, string>>({});

  const [phoneLines, setPhoneLines] = useState<any[]>([]);
  const [phoneLinesIncludeArchived, setPhoneLinesIncludeArchived] = useState(false);
  const [phoneLinesStatus, setPhoneLinesStatus] = useState<string | null>(null);
  const [phoneLinesError, setPhoneLinesError] = useState<string | null>(null);
  const [phoneLineEditor, setPhoneLineEditor] = useState<any | null>(null);
  const [phoneLineSaveStatus, setPhoneLineSaveStatus] = useState<string | null>(null);
  const [phoneLineSaveError, setPhoneLineSaveError] = useState<string | null>(null);

  const [programs, setPrograms] = useState<any[]>([]);
  const [programEditor, setProgramEditor] = useState<any | null>(null);
  const [programStatus, setProgramStatus] = useState<string | null>(null);
  const [programError, setProgramError] = useState<string | null>(null);
  const [programKnowledge, setProgramKnowledge] = useState<any[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [newAssetType, setNewAssetType] = useState<'LINK' | 'TEXT'>('LINK');
  const [newAssetTitle, setNewAssetTitle] = useState('');
  const [newAssetUrl, setNewAssetUrl] = useState('');
  const [newAssetContent, setNewAssetContent] = useState('');
  const [newAssetTags, setNewAssetTags] = useState('');

  const [programConnectors, setProgramConnectors] = useState<any[]>([]);
  const [programToolSelections, setProgramToolSelections] = useState<Record<string, { enabled: boolean; allowed: Record<string, boolean> }>>({});
  const [toolsSaving, setToolsSaving] = useState(false);
  const [toolsStatus, setToolsStatus] = useState<string | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);

  const [promptGenerating, setPromptGenerating] = useState(false);
  const [promptSuggestion, setPromptSuggestion] = useState<string | null>(null);
  const [promptGenError, setPromptGenError] = useState<string | null>(null);

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
      const keys = new Set(visibleTabs.map((t) => t.key));
      if (stored && keys.has(stored as any)) {
        setTab(stored as TabKey);
      } else if (!keys.has(tab)) {
        setTab(isOwner ? 'workspace' : 'programs');
      }
    } catch {
      // ignore
    }
  }, [visibleTabs, tab, isOwner]);

  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < 900);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const loadWorkspaces = async () => {
    const data = await apiClient.get('/api/workspaces');
    setWorkspaces(Array.isArray(data) ? data : []);
  };
  const loadUsers = async () => {
    const data = await apiClient.get('/api/users');
    setUsers(Array.isArray(data) ? data : []);
  };
  const loadInvites = async (opts?: { includeArchived?: boolean }) => {
    setInvitesError(null);
    try {
      const includeArchived = typeof opts?.includeArchived === 'boolean' ? opts.includeArchived : invitesIncludeArchived;
      const data = await apiClient.get(includeArchived ? '/api/invites?includeArchived=1' : '/api/invites');
      setInvites(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setInvites([]);
      setInvitesError(err.message || 'No se pudieron cargar invitaciones');
    }
  };
  const loadPhoneLines = async (opts?: { includeArchived?: boolean }) => {
    setPhoneLinesError(null);
    try {
      const includeArchived =
        typeof opts?.includeArchived === 'boolean' ? opts.includeArchived : phoneLinesIncludeArchived;
      const data = await apiClient.get(includeArchived ? '/api/phone-lines?includeArchived=1' : '/api/phone-lines');
      setPhoneLines(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setPhoneLines([]);
      setPhoneLinesError(err.message || 'No se pudieron cargar números WhatsApp');
    }
  };
  const loadPrograms = async () => {
    const data = await apiClient.get('/api/programs');
    setPrograms(Array.isArray(data) ? data : []);
  };

  const loadProgramKnowledge = async (programId: string) => {
    setKnowledgeLoading(true);
    setKnowledgeError(null);
    try {
      const data = await apiClient.get(`/api/programs/${programId}/knowledge`);
      setProgramKnowledge(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setProgramKnowledge([]);
      setKnowledgeError(err.message || 'No se pudo cargar Knowledge Pack');
    } finally {
      setKnowledgeLoading(false);
    }
  };

  const loadProgramTools = async (programId: string) => {
    setToolsStatus(null);
    setToolsError(null);
    try {
      const data: any = await apiClient.get(`/api/programs/${programId}/tools`);
      const connectors = Array.isArray(data?.connectors) ? data.connectors : [];
      const permissions = Array.isArray(data?.permissions) ? data.permissions : [];
      setProgramConnectors(connectors);
      const next: Record<string, { enabled: boolean; allowed: Record<string, boolean> }> = {};
      for (const c of connectors) {
        next[String(c.id)] = { enabled: false, allowed: {} };
        const actions = Array.isArray(c.actions) ? c.actions : [];
        actions.forEach((a: any) => {
          next[String(c.id)].allowed[String(a)] = false;
        });
      }
      for (const p of permissions) {
        const cid = String(p.connectorId || '').trim();
        if (!cid || !next[cid]) continue;
        next[cid].enabled = true;
        const allowed = Array.isArray(p.allowedActions) ? p.allowedActions : [];
        if (allowed.length === 0) continue; // empty => allow all
        // Reset and then enable explicit ones
        Object.keys(next[cid].allowed).forEach((k) => {
          next[cid].allowed[k] = false;
        });
        allowed.forEach((a: any) => {
          const key = String(a);
          if (key in next[cid].allowed) next[cid].allowed[key] = true;
        });
      }
      setProgramToolSelections(next);
    } catch (err: any) {
      setProgramConnectors([]);
      setProgramToolSelections({});
      setToolsError(err.message || 'No se pudo cargar Tools del Program');
    }
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

  const loadIntegrations = async () => {
    const [ai, wa, auth, conns] = await Promise.all([
      apiClient.get('/api/config/ai'),
      apiClient.get('/api/config/whatsapp'),
      apiClient.get('/api/config/authorized-numbers'),
      apiClient.get('/api/connectors'),
    ]);
    setIntegrationsAi(ai);
    setIntegrationsAiModel(typeof ai?.aiModel === 'string' ? ai.aiModel : '');
    setIntegrationsAiTest(null);
    setIntegrationsAiStatus(null);
    setIntegrationsAiError(null);

    setIntegrationsWa(wa);
    setIntegrationsWaBaseUrl(typeof wa?.whatsappBaseUrl === 'string' ? wa.whatsappBaseUrl : '');
    setIntegrationsWaPhoneId(typeof wa?.whatsappPhoneId === 'string' ? wa.whatsappPhoneId : '');
    setIntegrationsWaTest(null);
    setIntegrationsWaStatus(null);
    setIntegrationsWaError(null);

    const adminNumbers = Array.isArray(auth?.adminNumbers) ? auth.adminNumbers : [];
    const testNumbers = Array.isArray(auth?.testNumbers) ? auth.testNumbers : [];
    setAuthorizedAdminNumbersText(adminNumbers.join('\n'));
    setAuthorizedTestNumbersText(testNumbers.join('\n'));
    setAuthorizedNumbersStatus(null);
    setAuthorizedNumbersError(null);

    const connList = Array.isArray(conns) ? conns : [];
    setConnectors(connList);
    const med = connList.find((c: any) => String(c?.slug || '').toLowerCase() === 'medilink') || null;
    setMedilinkBaseUrl(typeof med?.baseUrl === 'string' ? med.baseUrl : '');
    setMedilinkTestPath(typeof med?.testPath === 'string' ? med.testPath : '/health');
    setMedilinkTestMethod(typeof med?.testMethod === 'string' ? med.testMethod : 'GET');
    setMedilinkToken('');
    setMedilinkStatus(null);
    setMedilinkError(null);
    setConnectorEditor(null);
    setConnectorStatus(null);
    setConnectorError(null);
  };

  const saveAiIntegration = async () => {
    setIntegrationsAiStatus(null);
    setIntegrationsAiError(null);
    setIntegrationsAiTest(null);
    try {
      const payload: any = {};
      const model = integrationsAiModel.trim();
      if (model) payload.aiModel = model;
      const key = integrationsAiKey.trim();
      if (key) payload.openAiApiKey = key;
      await apiClient.put('/api/config/ai', payload);
      setIntegrationsAiKey('');
      setIntegrationsAiStatus('Guardado.');
      await loadIntegrations();
    } catch (err: any) {
      setIntegrationsAiError(err.message || 'No se pudo guardar');
    }
  };

  const clearAiKey = async () => {
    const ok = window.confirm('¿Eliminar la API Key de OpenAI? (Copilot/Agentes dejarán de funcionar)');
    if (!ok) return;
    setIntegrationsAiStatus(null);
    setIntegrationsAiError(null);
    setIntegrationsAiTest(null);
    try {
      await apiClient.put('/api/config/ai', { openAiApiKey: null });
      setIntegrationsAiKey('');
      setIntegrationsAiStatus('API Key eliminada.');
      await loadIntegrations();
    } catch (err: any) {
      setIntegrationsAiError(err.message || 'No se pudo eliminar');
    }
  };

  const testAiIntegration = async () => {
    setIntegrationsAiTest(null);
    setIntegrationsAiError(null);
    try {
      const res: any = await apiClient.post('/api/config/ai/test', {});
      setIntegrationsAiTest(`OK (${res?.model || 'model'})`);
    } catch (err: any) {
      setIntegrationsAiTest(null);
      setIntegrationsAiError(err.message || 'Test falló');
    }
  };

  const saveWhatsAppIntegration = async () => {
    setIntegrationsWaStatus(null);
    setIntegrationsWaError(null);
    setIntegrationsWaTest(null);
    try {
      const payload: any = {
        whatsappBaseUrl: integrationsWaBaseUrl.trim() || null,
        whatsappPhoneId: integrationsWaPhoneId.trim() || null,
      };
      const token = integrationsWaToken.trim();
      const verifyToken = integrationsWaVerifyToken.trim();
      if (token) payload.whatsappToken = token;
      if (verifyToken) payload.whatsappVerifyToken = verifyToken;
      await apiClient.put('/api/config/whatsapp', payload);
      setIntegrationsWaToken('');
      setIntegrationsWaVerifyToken('');
      setIntegrationsWaStatus('Guardado.');
      await loadIntegrations();
    } catch (err: any) {
      setIntegrationsWaError(err.message || 'No se pudo guardar');
    }
  };

  const testWhatsAppIntegration = async () => {
    setIntegrationsWaTest(null);
    setIntegrationsWaError(null);
    try {
      const payload: any = {};
      if (integrationsWaPhoneId.trim()) payload.phoneNumberId = integrationsWaPhoneId.trim();
      const res: any = await apiClient.post('/api/config/whatsapp/test', payload);
      const label = res?.displayPhoneNumber ? `${res.displayPhoneNumber}` : res?.phoneNumberId ? res.phoneNumberId : 'OK';
      setIntegrationsWaTest(`OK (${label})`);
    } catch (err: any) {
      setIntegrationsWaTest(null);
      setIntegrationsWaError(err.message || 'Test falló');
    }
  };

  const parseNumbersText = (value: string): string[] =>
    value
      .split(/[\n,]/g)
      .map((v) => v.trim())
      .filter(Boolean);

  const saveAuthorizedNumbers = async () => {
    setAuthorizedNumbersStatus(null);
    setAuthorizedNumbersError(null);
    try {
      const adminNumbers = parseNumbersText(authorizedAdminNumbersText);
      const testNumbers = parseNumbersText(authorizedTestNumbersText);
      await apiClient.put('/api/config/authorized-numbers', { adminNumbers, testNumbers });
      setAuthorizedNumbersStatus('Guardado.');
      await loadIntegrations();
    } catch (err: any) {
      setAuthorizedNumbersError(err.message || 'No se pudo guardar');
    }
  };

  const openNewConnector = () => {
    setConnectorStatus(null);
    setConnectorError(null);
    setConnectorEditor({
      id: null,
      name: '',
      slug: '',
      description: '',
      baseUrl: '',
      testPath: '/health',
      testMethod: 'GET',
      authType: 'BEARER_TOKEN',
      authHeaderName: 'Authorization',
      authToken: '',
      allowedDomainsText: '',
      actionsText: 'search_patient\ncreate_appointment\ncreate_payment',
      timeoutMs: 8000,
      maxPayloadBytes: 200000,
      isActive: true,
    });
  };

  const editConnector = (c: any) => {
    setConnectorStatus(null);
    setConnectorError(null);
    setConnectorEditor({
      id: c.id,
      name: c.name || '',
      slug: c.slug || '',
      description: c.description || '',
      baseUrl: c.baseUrl || '',
      testPath: c.testPath || '/health',
      testMethod: c.testMethod || 'GET',
      authType: c.authType || 'BEARER_TOKEN',
      authHeaderName: c.authHeaderName || 'Authorization',
      authToken: '',
      allowedDomainsText: Array.isArray(c.allowedDomains) ? c.allowedDomains.join('\n') : '',
      actionsText: Array.isArray(c.actions) ? c.actions.join('\n') : '',
      timeoutMs: typeof c.timeoutMs === 'number' ? c.timeoutMs : 8000,
      maxPayloadBytes: typeof c.maxPayloadBytes === 'number' ? c.maxPayloadBytes : 200000,
      isActive: Boolean(c.isActive),
    });
  };

  const parseLines = (value: string): string[] =>
    value
      .split(/[\n,]/g)
      .map((v) => v.trim())
      .filter(Boolean);

  const saveConnector = async () => {
    if (!connectorEditor) return;
    setConnectorStatus(null);
    setConnectorError(null);
    try {
      const payload: any = {
        name: String(connectorEditor.name || '').trim(),
        slug: String(connectorEditor.slug || '').trim() || null,
        description: String(connectorEditor.description || '').trim() || null,
        baseUrl: String(connectorEditor.baseUrl || '').trim() || null,
        testPath: String(connectorEditor.testPath || '').trim() || null,
        testMethod: String(connectorEditor.testMethod || '').trim() || null,
        authType: String(connectorEditor.authType || '').trim() || null,
        authHeaderName: String(connectorEditor.authHeaderName || '').trim() || null,
        allowedDomains: parseLines(String(connectorEditor.allowedDomainsText || '')),
        actions: parseLines(String(connectorEditor.actionsText || '')),
        timeoutMs: Number(connectorEditor.timeoutMs),
        maxPayloadBytes: Number(connectorEditor.maxPayloadBytes),
        isActive: Boolean(connectorEditor.isActive),
      };
      const token = String(connectorEditor.authToken || '').trim();
      if (token) payload.authToken = token;

      if (connectorEditor.id) {
        await apiClient.patch(`/api/connectors/${connectorEditor.id}`, payload);
      } else {
        await apiClient.post('/api/connectors', payload);
      }
      setConnectorStatus('Guardado.');
      await loadIntegrations();
    } catch (err: any) {
      setConnectorError(err.message || 'No se pudo guardar');
    }
  };

  const archiveConnector = async (id: string) => {
    const ok = window.confirm('¿Archivar connector? (no se borra)');
    if (!ok) return;
    setConnectorStatus(null);
    setConnectorError(null);
    try {
      await apiClient.patch(`/api/connectors/${id}`, { archived: true });
      setConnectorStatus('Archivado.');
      await loadIntegrations();
    } catch (err: any) {
      setConnectorError(err.message || 'No se pudo archivar');
    }
  };

  const testConnector = async (id: string) => {
    setConnectorTestStatus((prev) => ({ ...prev, [id]: 'Testeando…' }));
    try {
      const res: any = await apiClient.post(`/api/connectors/${id}/test`, {});
      const ok = Boolean(res?.ok);
      const code = typeof res?.statusCode === 'number' ? String(res.statusCode) : '—';
      const duration = typeof res?.durationMs === 'number' ? `${res.durationMs}ms` : '';
      const method = typeof res?.tested?.method === 'string' ? res.tested.method : 'GET';
      const path = typeof res?.tested?.path === 'string' ? res.tested.path : '/';
      const label = ok
        ? `OK (${code}${duration ? ` · ${duration}` : ''})`
        : `FAIL (${res?.error || code}${duration ? ` · ${duration}` : ''}) · ${method} ${path}`;
      setConnectorTestStatus((prev) => ({ ...prev, [id]: label }));
      await loadIntegrations();
    } catch (err: any) {
      setConnectorTestStatus((prev) => ({ ...prev, [id]: err.message || 'FAIL' }));
    }
  };

  const saveMedilink = async () => {
    setMedilinkStatus(null);
    setMedilinkError(null);
    try {
      const baseUrl = medilinkBaseUrl.trim() || null;
      const token = medilinkToken.trim();
      const testPath = medilinkTestPath.trim() || null;
      const testMethod = medilinkTestMethod.trim() || null;
      const existingId = medilinkConnector?.id ? String(medilinkConnector.id) : null;
      if (existingId) {
        const payload: any = { baseUrl };
        payload.testPath = testPath;
        payload.testMethod = testMethod;
        if (token) payload.authToken = token;
        await apiClient.patch(`/api/connectors/${existingId}`, payload);
      } else {
        const payload: any = {
          name: 'Medilink',
          slug: 'medilink',
          description: 'Medilink API (SSClinical)',
          baseUrl,
          testPath,
          testMethod,
          authType: 'BEARER_TOKEN',
          authHeaderName: 'Authorization',
          actions: ['search_patient', 'create_appointment', 'create_payment'],
          timeoutMs: 8000,
          maxPayloadBytes: 200000,
          isActive: true,
        };
        if (token) payload.authToken = token;
        await apiClient.post('/api/connectors', payload);
      }
      setMedilinkToken('');
      setMedilinkStatus('Guardado.');
      await loadIntegrations();
    } catch (err: any) {
      setMedilinkError(err.message || 'No se pudo guardar Medilink');
    }
  };

  const testMedilink = async () => {
    const id = medilinkConnector?.id ? String(medilinkConnector.id) : null;
    if (!id) {
      setMedilinkError('Crea el connector Medilink primero.');
      return;
    }
    await testConnector(id);
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
    if (tab === 'users') {
      loadUsers().catch(() => {});
      loadInvites().catch(() => {});
    }
    if (tab === 'logs') {
      loadAgentRuns().catch(() => {});
      loadAutomationRuns().catch(() => {});
    }
    if (tab === 'automations') loadAutomations().catch(() => {});
    if (tab === 'programs') loadPrograms().catch(() => {});
    if (tab === 'phoneLines') loadPhoneLines().catch(() => {});
    if (tab === 'integrations') loadIntegrations().catch(() => {});
    if (tab === 'usage') loadUsage().catch(() => {});
  }, [tab]);

  useEffect(() => {
    if (tab !== 'programs') return;
    let id: string | null = null;
    try {
      id = localStorage.getItem('configFocusProgramId');
      if (id) localStorage.removeItem('configFocusProgramId');
    } catch {
      id = null;
    }
    if (!id) return;
    setFocusedProgramId(id);
    setTimeout(() => setFocusedProgramId(null), 8000);
    setTimeout(() => {
      try {
        document.getElementById(`program-row-${id}`)?.scrollIntoView({ block: 'center' });
      } catch {
        // ignore
      }
    }, 250);
  }, [tab, programs.length]);

  useEffect(() => {
    const id = programEditor?.id ? String(programEditor.id) : null;
    setPromptSuggestion(null);
    setPromptGenError(null);
    setKnowledgeError(null);
    setToolsError(null);
    setToolsStatus(null);
    if (!id) {
      setProgramKnowledge([]);
      setProgramConnectors([]);
      setProgramToolSelections({});
      return;
    }
    loadProgramKnowledge(id).catch(() => {});
    loadProgramTools(id).catch(() => {});
  }, [programEditor?.id]);

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

  const cloneFromWorkspace = async () => {
    setCloneStatus(null);
    setCloneError(null);
    setCloneResult(null);
    try {
      const sourceWorkspaceId = String(cloneSourceWorkspaceId || '').trim();
      if (!sourceWorkspaceId) throw new Error('Selecciona un workspace origen.');
      const res: any = await apiClient.post('/api/workspaces/clone-from', {
        sourceWorkspaceId,
        clonePrograms: Boolean(clonePrograms),
        cloneAutomations: Boolean(cloneAutomations),
        cloneConnectors: Boolean(cloneConnectors)
      });
      setCloneResult(res);
      setCloneStatus('Clonado. Revisa Programs/Automations/Integraciones.');
      await Promise.all([loadPrograms(), loadAutomations(), loadPhoneLines()]);
      loadIntegrations().catch(() => {});
    } catch (err: any) {
      setCloneError(err.message || 'No se pudo clonar');
    }
  };

  const saveUserRole = async (membershipId: string, role: string) => {
    await apiClient.patch(`/api/users/${membershipId}`, { role });
    await loadUsers();
  };
  const toggleUserArchived = async (membershipId: string, archived: boolean) => {
    await apiClient.patch(`/api/users/${membershipId}`, { archived });
    await loadUsers();
  };
  const setUserAssignedOnly = async (membershipId: string, assignedOnly: boolean) => {
    await apiClient.patch(`/api/users/${membershipId}`, { assignedOnly });
    await loadUsers();
  };

  const inviteUser = async () => {
    setInviteStatus(null);
    setInviteError(null);
    try {
      const payload: any = { email: inviteEmail, role: inviteRole };
      if (String(inviteRole).toUpperCase() === 'MEMBER') {
        payload.assignedOnly = Boolean(inviteAssignedOnly);
      }
      const res: any = await apiClient.post('/api/invites', payload);
      const url = typeof res?.inviteUrl === 'string' ? res.inviteUrl : null;
      if (url) {
        try {
          await navigator.clipboard.writeText(url);
          setInviteStatus(`Invite creado. Link copiado al portapapeles.`);
        } catch {
          setInviteStatus(`Invite creado. Copia el link: ${url}`);
        }
      } else {
        setInviteStatus('Invite creado.');
      }
      setInviteEmail('');
      setInviteOpen(false);
      setInviteAssignedOnly(false);
      await loadUsers();
      await loadInvites();
    } catch (err: any) {
      setInviteError(err.message || 'No se pudo invitar');
    }
  };

  const copyInviteLink = async (inviteId: string) => {
    setInviteUrlById((prev) => ({ ...prev, [inviteId]: 'Cargando…' }));
    try {
      const res: any = await apiClient.post(`/api/invites/${inviteId}/url`, {});
      const url = typeof res?.inviteUrl === 'string' ? res.inviteUrl : null;
      if (!url) throw new Error('No se pudo obtener el link.');
      try {
        await navigator.clipboard.writeText(url);
        setInviteUrlById((prev) => ({ ...prev, [inviteId]: '✅ Copiado' }));
      } catch {
        setInviteUrlById((prev) => ({ ...prev, [inviteId]: url }));
      }
    } catch (err: any) {
      setInviteUrlById((prev) => ({ ...prev, [inviteId]: err.message || 'Error' }));
    }
  };

  const buildInviteInstructions = (params: { workspaceName: string; inviteUrl: string; email: string; role: string; assignedOnly?: boolean }) => {
    const roleUpper = String(params.role || '').toUpperCase();
    const scope =
      roleUpper === 'MEMBER' && params.assignedOnly
        ? 'Scope: solo conversaciones asignadas.'
        : null;
    return [
      `Te invitaron a Hunter CRM.`,
      `Workspace: ${params.workspaceName}`,
      `Email: ${params.email}`,
      `Rol: ${roleUpper}${scope ? ` (${scope})` : ''}`,
      '',
      `1) Abre este link:`,
      params.inviteUrl,
      '',
      `2) Si ya tienes cuenta: inicia sesión con tu email y acepta la invitación.`,
      `   Si NO tienes cuenta: crea tu acceso (nombre + contraseña).`,
      `3) Entra al CRM y confirma que estás en el workspace correcto.`,
    ].join('\n');
  };

  const copyInviteInstructions = async (invite: any) => {
    const inviteId = String(invite?.id || '').trim();
    if (!inviteId) return;
    try {
      const res: any = await apiClient.post(`/api/invites/${inviteId}/url`, {});
      const url = typeof res?.inviteUrl === 'string' ? res.inviteUrl : null;
      if (!url) throw new Error('No se pudo obtener el link.');
      const text = buildInviteInstructions({
        workspaceName: currentWorkspace?.name || workspaceId,
        inviteUrl: url,
        email: String(invite?.email || ''),
        role: String(invite?.role || ''),
        assignedOnly: Boolean(res?.assignedOnly ?? invite?.assignedOnly),
      });
      await navigator.clipboard.writeText(text);
      setInviteUrlById((prev) => ({ ...prev, [inviteId]: '✅ Instrucciones copiadas' }));
    } catch (err: any) {
      setInviteUrlById((prev) => ({ ...prev, [inviteId]: err.message || 'Error' }));
    }
  };

  const archiveInvite = async (inviteId: string, archived: boolean) => {
    const ok = window.confirm(
      archived
        ? `¿Archivar esta invitación?\n\nEsto NO borra historial. Puedes re-emitir una nueva invitación si corresponde.`
        : `¿Restaurar esta invitación?`
    );
    if (!ok) return;
    await apiClient.patch(`/api/invites/${inviteId}`, { archived });
    await loadInvites();
  };

  const reissueInvite = async (inviteId: string) => {
    const ok = window.confirm(
      `¿Re-emitir link de invitación?\n\nSe archivará el invite actual y se creará uno nuevo con link distinto.`
    );
    if (!ok) return;
    const res: any = await apiClient.post(`/api/invites/${inviteId}/reissue`, {});
    const url = typeof res?.inviteUrl === 'string' ? res.inviteUrl : null;
    await loadInvites();
    if (url) {
      try {
        await navigator.clipboard.writeText(url);
        setInviteUrlById((prev) => ({ ...prev, [String(res?.inviteId || inviteId)]: '✅ Nuevo link copiado' }));
      } catch {
        setInviteUrlById((prev) => ({ ...prev, [String(res?.inviteId || inviteId)]: url }));
      }
    }
  };

  const savePhoneLine = async () => {
    if (!phoneLineEditor) return;
    setPhoneLineSaveStatus(null);
    setPhoneLineSaveError(null);
    try {
      const normalizedPhone = normalizeChilePhoneE164(phoneLineEditor.phoneE164 || '');
      const payload = {
        alias: String(phoneLineEditor.alias || '').trim(),
        phoneE164: normalizedPhone,
        waPhoneNumberId: String(phoneLineEditor.waPhoneNumberId || '').trim(),
        wabaId: phoneLineEditor.wabaId ? String(phoneLineEditor.wabaId).trim() : null,
        defaultProgramId: phoneLineEditor.defaultProgramId ? String(phoneLineEditor.defaultProgramId).trim() : null,
        isActive: Boolean(phoneLineEditor.isActive)
      };
      if (!payload.alias) throw new Error('alias es requerido');
      if (!payload.waPhoneNumberId) throw new Error('waPhoneNumberId es requerido');

      if (phoneLineEditor.id) {
        await apiClient.patch(`/api/phone-lines/${phoneLineEditor.id}`, payload);
      } else {
        await apiClient.post('/api/phone-lines', payload);
      }
      setPhoneLineSaveStatus('Guardado.');
      setPhoneLineEditor(null);
      await loadPhoneLines();
    } catch (err: any) {
      setPhoneLineSaveError(err.message || 'No se pudo guardar');
    }
  };

  const patchPhoneLine = async (phoneLineId: string, patch: any) => {
    setPhoneLinesStatus(null);
    setPhoneLinesError(null);
    try {
      await apiClient.patch(`/api/phone-lines/${phoneLineId}`, patch);
      setPhoneLinesStatus('Actualizado.');
      await loadPhoneLines();
    } catch (err: any) {
      setPhoneLinesError(err.message || 'No se pudo actualizar');
    }
  };

  const archivePhoneLine = async (phoneLineId: string, archived: boolean) => {
    const ok = window.confirm(
      archived
        ? `¿Archivar este número?\n\nEsto NO borra data. Se desactivará y quedará oculto por defecto.`
        : `¿Restaurar este número archivado?`
    );
    if (!ok) return;
    await patchPhoneLine(phoneLineId, { archived });
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
        goal: programEditor.goal || null,
        audience: programEditor.audience || null,
        tone: programEditor.tone || null,
        language: programEditor.language || null,
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
      goal: programEditor.goal || null,
      audience: programEditor.audience || null,
      tone: programEditor.tone || null,
      language: programEditor.language || null,
      isActive: true,
      agentSystemPrompt: programEditor.agentSystemPrompt
    });
    await loadPrograms();
  };

  const addProgramAsset = async () => {
    if (!programEditor?.id) return;
    setKnowledgeError(null);
    try {
      const payload: any = {
        type: newAssetType,
        title: newAssetTitle.trim(),
        tags: newAssetTags.trim() ? newAssetTags.trim() : null,
      };
      if (newAssetType === 'LINK') payload.url = newAssetUrl.trim();
      if (newAssetType === 'TEXT') payload.contentText = newAssetContent.trim();
      await apiClient.post(`/api/programs/${programEditor.id}/knowledge`, payload);
      setNewAssetTitle('');
      setNewAssetUrl('');
      setNewAssetContent('');
      setNewAssetTags('');
      await loadProgramKnowledge(String(programEditor.id));
    } catch (err: any) {
      setKnowledgeError(err.message || 'No se pudo agregar el asset');
    }
  };

  const setAssetArchived = async (assetId: string, archived: boolean) => {
    if (!programEditor?.id) return;
    setKnowledgeError(null);
    try {
      await apiClient.patch(`/api/programs/${programEditor.id}/knowledge/${assetId}`, { archived });
      await loadProgramKnowledge(String(programEditor.id));
    } catch (err: any) {
      setKnowledgeError(err.message || 'No se pudo actualizar el asset');
    }
  };

  const saveProgramTools = async () => {
    if (!programEditor?.id) return;
    setToolsSaving(true);
    setToolsStatus(null);
    setToolsError(null);
    try {
      const permissions: Array<{ connectorId: string; allowedActions: string[] }> = [];
      for (const [connectorId, sel] of Object.entries(programToolSelections)) {
        if (!sel?.enabled) continue;
        const allowed = Object.entries(sel.allowed || {})
          .filter(([, v]) => Boolean(v))
          .map(([k]) => k);
        permissions.push({ connectorId, allowedActions: allowed });
      }
      await apiClient.put(`/api/programs/${programEditor.id}/tools`, { permissions });
      setToolsStatus('Guardado.');
      await loadProgramTools(String(programEditor.id));
    } catch (err: any) {
      setToolsError(err.message || 'No se pudo guardar Tools');
    } finally {
      setToolsSaving(false);
    }
  };

  const generateProgramPrompt = async () => {
    if (!programEditor?.id || promptGenerating) return;
    setPromptGenerating(true);
    setPromptGenError(null);
    setPromptSuggestion(null);
    try {
      const res: any = await apiClient.post(`/api/programs/${programEditor.id}/generate-prompt`, {});
      const suggestion = typeof res?.suggestion === 'string' ? res.suggestion.trim() : '';
      if (!suggestion) throw new Error('La IA devolvió un prompt vacío.');
      setPromptSuggestion(suggestion);
    } catch (err: any) {
      setPromptGenError(err.message || 'No se pudo generar el prompt');
    } finally {
      setPromptGenerating(false);
    }
  };

  const applyProgramPrompt = async () => {
    if (!programEditor?.id || !promptSuggestion) return;
    const ok = window.confirm('¿Aplicar estas instrucciones al Program? (se audita, no se borra nada)');
    if (!ok) return;
    setProgramStatus(null);
    setProgramError(null);
    try {
      await apiClient.patch(`/api/programs/${programEditor.id}`, { agentSystemPrompt: promptSuggestion });
      setProgramEditor({ ...programEditor, agentSystemPrompt: promptSuggestion });
      setPromptSuggestion(null);
      setProgramStatus('Prompt aplicado.');
      await loadPrograms();
    } catch (err: any) {
      setProgramError(err.message || 'No se pudo aplicar el prompt');
    }
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
    setTempOffStatus(null);
    setTempOffError(null);
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

  const enableTempOff = async (minutes: number) => {
    setTempOffStatus(null);
    setTempOffError(null);
    setOutboundStatus(null);
    setOutboundError(null);
    const mins = Number.isFinite(minutes) ? Math.max(1, Math.min(180, Math.floor(minutes))) : 30;
    const ok = window.confirm(
      `⚠️ Esto desactiva SAFE MODE temporalmente y permite enviar WhatsApp a cualquier número por ${mins} minutos.\n\n¿Continuar?`
    );
    if (!ok) return;
    try {
      const res: any = await apiClient.post('/api/config/outbound-safety/temp-off', { minutes: mins });
      setOutboundSafety(res);
      const stored = res?.outboundPolicyStored || outboundPolicy;
      setOutboundPolicy(String(stored || 'ALLOWLIST_ONLY'));
      const allow = Array.isArray(res?.outboundAllowlist) ? res.outboundAllowlist : [];
      setOutboundAllowlistText(allow.join('\n'));
      setTempOffStatus(`TEMP_OFF activado por ${mins} min.`);
    } catch (err: any) {
      setTempOffError(err.message || 'No se pudo activar TEMP_OFF');
    }
  };

  const clearTempOff = async () => {
    setTempOffStatus(null);
    setTempOffError(null);
    const ok = window.confirm('¿Reactivar SAFE MODE ahora (cancelar TEMP_OFF)?');
    if (!ok) return;
    try {
      const res: any = await apiClient.post('/api/config/outbound-safety/clear-temp-off', {});
      setOutboundSafety(res);
      const stored = res?.outboundPolicyStored || outboundPolicy;
      setOutboundPolicy(String(stored || 'ALLOWLIST_ONLY'));
      const allow = Array.isArray(res?.outboundAllowlist) ? res.outboundAllowlist : [];
      setOutboundAllowlistText(allow.join('\n'));
      setTempOffStatus('TEMP_OFF cancelado. SAFE MODE reactivado.');
    } catch (err: any) {
      setTempOffError(err.message || 'No se pudo cancelar TEMP_OFF');
    }
  };

  const tempOffUntilIso =
    outboundSafety && typeof outboundSafety?.outboundAllowAllUntil === 'string'
      ? outboundSafety.outboundAllowAllUntil
      : null;
  const tempOffUntil = tempOffUntilIso ? new Date(tempOffUntilIso) : null;
  const tempOffActive = Boolean(tempOffUntil && Number.isFinite(tempOffUntil.getTime()) && tempOffUntil.getTime() > Date.now());
  const tempOffRemainingMinutes = tempOffActive && tempOffUntil
    ? Math.max(1, Math.ceil((tempOffUntil.getTime() - Date.now()) / (60 * 1000)))
    : null;

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
      {isNarrow ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ fontSize: 12, color: '#666', fontWeight: 700 }}>Sección</div>
          <select
            value={tab}
            onChange={(e) => setTab(e.target.value as TabKey)}
            style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #ccc', minWidth: 240, maxWidth: '100%' }}
            aria-label="Seleccionar sección"
          >
            {visibleTabs.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {visibleTabs.map((t) => (
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
      )}

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

          <div style={{ border: '1px solid #eee', borderRadius: 10, padding: 12, background: '#fff' }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Clonar desde otro workspace (template/copy)</div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 10 }}>
              Copia configuración al workspace actual: Programs, Automations y Connectors. <b>No copia secretos/tokens</b>: deberás re‑ingresarlos en Integraciones.
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <select
                value={cloneSourceWorkspaceId}
                onChange={(e) => setCloneSourceWorkspaceId(e.target.value)}
                style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid #ccc', minWidth: 240 }}
              >
                <option value="">Selecciona workspace origen…</option>
                {workspaces
                  .filter((w) => String(w.id) !== String(localStorage.getItem('workspaceId') || 'default'))
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} ({w.role})
                    </option>
                  ))}
              </select>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#555' }}>
                <input type="checkbox" checked={clonePrograms} onChange={(e) => setClonePrograms(e.target.checked)} />
                Programs
              </label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#555' }}>
                <input type="checkbox" checked={cloneAutomations} onChange={(e) => setCloneAutomations(e.target.checked)} />
                Automations
              </label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#555' }}>
                <input type="checkbox" checked={cloneConnectors} onChange={(e) => setCloneConnectors(e.target.checked)} />
                Connectors
              </label>
              <button
                onClick={() => cloneFromWorkspace().catch(() => {})}
                style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #111', background: '#111', color: '#fff', fontSize: 12, fontWeight: 800 }}
              >
                Clonar
              </button>
            </div>
            {cloneStatus ? <div style={{ marginTop: 8, fontSize: 12, color: '#1a7f37' }}>{cloneStatus}</div> : null}
            {cloneError ? <div style={{ marginTop: 8, fontSize: 12, color: '#b93800' }}>{cloneError}</div> : null}
            {cloneResult ? (
              <pre style={{ marginTop: 10, fontSize: 11, background: '#fafafa', border: '1px solid #eee', borderRadius: 10, padding: 10, overflowX: 'auto' }}>
                {JSON.stringify(cloneResult, null, 2)}
              </pre>
            ) : null}
          </div>

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
              {tempOffActive ? (
                <div style={{ border: '1px solid #f3c4a6', background: '#fff7f1', borderRadius: 10, padding: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 12, color: '#7a3b00', fontWeight: 800 }}>
                    ⚠️ TEMP_OFF activo: envíos a cualquier número por {tempOffRemainingMinutes} min (hasta {tempOffUntil ? tempOffUntil.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }) : '—'}).
                  </div>
                  <button
                    onClick={() => clearTempOff().catch(() => {})}
                    style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #7a3b00', background: '#fff', fontSize: 12, fontWeight: 800 }}
                  >
                    Reactivar SAFE MODE ahora
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 12, color: '#666' }}>TEMP_OFF (permite envíos a todos por minutos)</div>
                  <input
                    type="number"
                    min={1}
                    max={180}
                    value={tempOffMinutes}
                    onChange={(e) => setTempOffMinutes(Number(e.target.value))}
                    style={{ width: 90, padding: '6px 8px', borderRadius: 8, border: '1px solid #ccc' }}
                  />
                  <button
                    onClick={() => enableTempOff(tempOffMinutes).catch(() => {})}
                    style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #b93800', background: '#fff', fontSize: 12, fontWeight: 800 }}
                  >
                    Permitir temporalmente
                  </button>
                </div>
              )}
              {tempOffStatus ? <div style={{ marginTop: 8, fontSize: 12, color: '#1a7f37' }}>{tempOffStatus}</div> : null}
              {tempOffError ? <div style={{ marginTop: 8, fontSize: 12, color: '#b93800' }}>{tempOffError}</div> : null}
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

      {tab === 'integrations' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 820 }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Integraciones</div>
          <div style={{ fontSize: 12, color: '#666' }}>
            Configura credenciales de IA y WhatsApp. Solo OWNER/ADMIN puede editar. Los secretos se muestran enmascarados.
          </div>

          <div style={{ border: '1px solid #eee', borderRadius: 10, padding: 12, background: '#fff' }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>OpenAI / LLM</div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 10 }}>
              Estado: {integrationsAi?.hasOpenAiKey ? <span style={{ color: '#1a7f37' }}>✅ API Key configurada</span> : <span style={{ color: '#b93800' }}>⚠️ Sin API Key</span>}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, alignItems: 'start' }}>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Default model</div>
                <input
                  value={integrationsAiModel}
                  onChange={(e) => setIntegrationsAiModel(e.target.value)}
                  placeholder="Ej: gpt-4.1-mini"
                  style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                />
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>API Key (masked)</div>
                <input
                  value={integrationsAiKey}
                  onChange={(e) => setIntegrationsAiKey(e.target.value)}
                  placeholder="Pegga aquí para actualizar (dejar vacío = no cambia)"
                  type="password"
                  style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                />
              </div>
            </div>
            <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                onClick={() => saveAiIntegration().catch(() => {})}
                style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #111', background: '#111', color: '#fff' }}
              >
                Guardar
              </button>
              <button
                onClick={() => testAiIntegration().catch(() => {})}
                style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #ccc', background: '#fff' }}
              >
                Test conexión
              </button>
              <button
                onClick={() => clearAiKey().catch(() => {})}
                style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', color: '#b93800' }}
              >
                Eliminar API Key
              </button>
              {integrationsAiStatus ? <div style={{ fontSize: 12, color: '#1a7f37' }}>{integrationsAiStatus}</div> : null}
              {integrationsAiTest ? <div style={{ fontSize: 12, color: '#1a7f37' }}>{integrationsAiTest}</div> : null}
              {integrationsAiError ? <div style={{ fontSize: 12, color: '#b93800' }}>{integrationsAiError}</div> : null}
            </div>
          </div>

          <div style={{ border: '1px solid #eee', borderRadius: 10, padding: 12, background: '#fff' }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>WhatsApp Cloud API</div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 10 }}>
              Estado: {integrationsWa?.hasToken ? <span style={{ color: '#1a7f37' }}>✅ Token configurado</span> : <span style={{ color: '#b93800' }}>⚠️ Sin token</span>} ·{' '}
              {integrationsWa?.hasVerifyToken ? <span style={{ color: '#1a7f37' }}>✅ Verify token</span> : <span style={{ color: '#b93800' }}>⚠️ Sin verify token</span>}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Base URL</div>
                <input
                  value={integrationsWaBaseUrl}
                  onChange={(e) => setIntegrationsWaBaseUrl(e.target.value)}
                  placeholder="https://graph.facebook.com/v20.0"
                  style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                />
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Default phone_number_id (legacy)</div>
                <input
                  value={integrationsWaPhoneId}
                  onChange={(e) => setIntegrationsWaPhoneId(e.target.value)}
                  placeholder="1511895116748404"
                  style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                />
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Access token (masked)</div>
                <input
                  value={integrationsWaToken}
                  onChange={(e) => setIntegrationsWaToken(e.target.value)}
                  placeholder="Pegga aquí para actualizar (dejar vacío = no cambia)"
                  type="password"
                  style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                />
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Verify token (masked)</div>
                <input
                  value={integrationsWaVerifyToken}
                  onChange={(e) => setIntegrationsWaVerifyToken(e.target.value)}
                  placeholder="Pegga aquí para actualizar (dejar vacío = no cambia)"
                  type="password"
                  style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                />
              </div>
            </div>

            <div style={{ marginTop: 10, fontSize: 12, color: '#666' }}>
              Webhook URL:{' '}
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                {typeof window !== 'undefined' ? `${window.location.origin}/whatsapp/webhook` : '/whatsapp/webhook'}
              </span>
            </div>

            <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                onClick={() => saveWhatsAppIntegration().catch(() => {})}
                style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #111', background: '#111', color: '#fff' }}
              >
                Guardar
              </button>
              <button
                onClick={() => testWhatsAppIntegration().catch(() => {})}
                style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #ccc', background: '#fff' }}
              >
                Test token
              </button>
              {integrationsWaStatus ? <div style={{ fontSize: 12, color: '#1a7f37' }}>{integrationsWaStatus}</div> : null}
              {integrationsWaTest ? <div style={{ fontSize: 12, color: '#1a7f37' }}>{integrationsWaTest}</div> : null}
              {integrationsWaError ? <div style={{ fontSize: 12, color: '#b93800' }}>{integrationsWaError}</div> : null}
            </div>
          </div>

          <div style={{ border: '1px solid #eee', borderRadius: 10, padding: 12, background: '#fff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontWeight: 800, marginBottom: 4 }}>Connectors / APIs externas</div>
                <div style={{ fontSize: 12, color: '#666' }}>
                  Guarda credenciales y prueba conectividad. Luego puedes habilitar el connector por Program (Tools).
                </div>
              </div>
              <button
                onClick={openNewConnector}
                style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #111', background: '#111', color: '#fff' }}
              >
                + Agregar connector
              </button>
            </div>
            {connectorStatus ? <div style={{ marginTop: 8, fontSize: 12, color: '#1a7f37' }}>{connectorStatus}</div> : null}
            {connectorError ? <div style={{ marginTop: 8, fontSize: 12, color: '#b93800' }}>{connectorError}</div> : null}

            <div style={{ marginTop: 10, border: '1px solid #f0f0f0', borderRadius: 10, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Name</th>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Base URL</th>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Auth</th>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Último test</th>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {(Array.isArray(connectors) ? connectors : []).length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ padding: 10, fontSize: 13, color: '#666' }}>
                        — Sin connectors. Agrega uno (ej: Medilink).
                      </td>
                    </tr>
                  ) : (
                    (connectors || []).map((c: any) => (
                      <tr key={c.id} style={{ borderTop: '1px solid #f0f0f0' }}>
                        <td style={{ padding: 10, fontSize: 13 }}>
                          <div style={{ fontWeight: 800 }}>{c.name}</div>
                          <div style={{ fontSize: 12, color: '#666', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                            {c.slug}
                          </div>
                          <div style={{ marginTop: 4, fontSize: 12, color: c.hasToken ? '#1a7f37' : '#b93800' }}>
                            {c.hasToken ? '✅ token configurado' : '⚠️ sin token'}
                          </div>
                        </td>
                        <td style={{ padding: 10, fontSize: 13, color: '#111' }}>
                          <div style={{ maxWidth: 260, overflowWrap: 'anywhere' }}>{c.baseUrl || '—'}</div>
                          {Array.isArray(c.allowedDomains) && c.allowedDomains.length > 0 ? (
                            <div style={{ marginTop: 4, fontSize: 12, color: '#666' }}>
                              allowlist: {c.allowedDomains.join(', ')}
                            </div>
                          ) : null}
                        </td>
                        <td style={{ padding: 10, fontSize: 13 }}>
                          <div style={{ fontSize: 12, color: '#666' }}>{c.authType || '—'}</div>
                          <div style={{ fontSize: 12, color: '#666' }}>{c.authHeaderName ? `header: ${c.authHeaderName}` : ''}</div>
                        </td>
                        <td style={{ padding: 10, fontSize: 13 }}>
                          <div style={{ fontSize: 12, color: c.lastTestOk ? '#1a7f37' : c.lastTestOk === false ? '#b93800' : '#666' }}>
                            {c.lastTestOk === true ? 'PASS' : c.lastTestOk === false ? 'FAIL' : '—'}
                            {c.lastTestedAt ? ` · ${c.lastTestedAt}` : ''}
                          </div>
                          {c.lastTestError ? <div style={{ fontSize: 12, color: '#b93800' }}>{String(c.lastTestError).slice(0, 80)}</div> : null}
                          {connectorTestStatus[c.id] ? (
                            <div style={{ marginTop: 4, fontSize: 12, color: connectorTestStatus[c.id].startsWith('OK') ? '#1a7f37' : '#666' }}>
                              {connectorTestStatus[c.id]}
                            </div>
                          ) : null}
                        </td>
                        <td style={{ padding: 10, fontSize: 13 }}>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <button
                              onClick={() => editConnector(c)}
                              style={{ padding: '4px 8px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}
                            >
                              Editar
                            </button>
                            <button
                              onClick={() => testConnector(c.id).catch(() => {})}
                              style={{ padding: '4px 8px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}
                            >
                              Test
                            </button>
                            <button
                              onClick={() => archiveConnector(c.id).catch(() => {})}
                              style={{ padding: '4px 8px', borderRadius: 8, border: '1px solid #ccc', background: '#fff', color: '#b93800' }}
                            >
                              Archivar
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {connectorEditor ? (
              <div style={{ marginTop: 12, borderTop: '1px solid #eee', paddingTop: 12 }}>
                <div style={{ fontWeight: 800, marginBottom: 8 }}>
                  {connectorEditor.id ? 'Editar connector' : 'Nuevo connector'}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Name</div>
                    <input
                      value={connectorEditor.name}
                      onChange={(e) => setConnectorEditor((prev: any) => ({ ...prev, name: e.target.value }))}
                      style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Slug</div>
                    <input
                      value={connectorEditor.slug}
                      onChange={(e) => setConnectorEditor((prev: any) => ({ ...prev, slug: e.target.value }))}
                      placeholder="ej: medilink"
                      style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                    />
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Descripción</div>
                    <input
                      value={connectorEditor.description}
                      onChange={(e) => setConnectorEditor((prev: any) => ({ ...prev, description: e.target.value }))}
                      style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                    />
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Base URL (http/https)</div>
                    <input
                      value={connectorEditor.baseUrl}
                      onChange={(e) => setConnectorEditor((prev: any) => ({ ...prev, baseUrl: e.target.value }))}
                      placeholder="https://api.example.com"
                      style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Test method</div>
                    <select
                      value={connectorEditor.testMethod || 'GET'}
                      onChange={(e) => setConnectorEditor((prev: any) => ({ ...prev, testMethod: e.target.value }))}
                      style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                    >
                      <option value="GET">GET</option>
                      <option value="HEAD">HEAD</option>
                    </select>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Test endpoint path</div>
                    <input
                      value={connectorEditor.testPath || ''}
                      onChange={(e) => setConnectorEditor((prev: any) => ({ ...prev, testPath: e.target.value }))}
                      placeholder="/health"
                      style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Auth type</div>
                    <select
                      value={connectorEditor.authType}
                      onChange={(e) => setConnectorEditor((prev: any) => ({ ...prev, authType: e.target.value }))}
                      style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                    >
                      <option value="BEARER_TOKEN">BEARER_TOKEN</option>
                      <option value="HEADER">HEADER</option>
                    </select>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Header name</div>
                    <input
                      value={connectorEditor.authHeaderName}
                      onChange={(e) => setConnectorEditor((prev: any) => ({ ...prev, authHeaderName: e.target.value }))}
                      placeholder="Authorization"
                      style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                    />
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Token/Secret (masked)</div>
                    <input
                      value={connectorEditor.authToken}
                      onChange={(e) => setConnectorEditor((prev: any) => ({ ...prev, authToken: e.target.value }))}
                      placeholder="Pegar aquí para actualizar (dejar vacío = no cambia)"
                      type="password"
                      style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Timeout (ms)</div>
                    <input
                      value={connectorEditor.timeoutMs}
                      onChange={(e) => setConnectorEditor((prev: any) => ({ ...prev, timeoutMs: e.target.value }))}
                      type="number"
                      min={1000}
                      max={60000}
                      style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Max payload (bytes)</div>
                    <input
                      value={connectorEditor.maxPayloadBytes}
                      onChange={(e) => setConnectorEditor((prev: any) => ({ ...prev, maxPayloadBytes: e.target.value }))}
                      type="number"
                      min={1024}
                      max={5000000}
                      style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Allowlist dominios (1 por línea)</div>
                    <textarea
                      value={connectorEditor.allowedDomainsText}
                      onChange={(e) => setConnectorEditor((prev: any) => ({ ...prev, allowedDomainsText: e.target.value }))}
                      rows={4}
                      placeholder="api.example.com"
                      style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Acciones disponibles (1 por línea)</div>
                    <textarea
                      value={connectorEditor.actionsText}
                      onChange={(e) => setConnectorEditor((prev: any) => ({ ...prev, actionsText: e.target.value }))}
                      rows={4}
                      style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                    />
                  </div>
                  <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#666' }}>
                      <input
                        type="checkbox"
                        checked={Boolean(connectorEditor.isActive)}
                        onChange={(e) => setConnectorEditor((prev: any) => ({ ...prev, isActive: e.target.checked }))}
                      />
                      Activo
                    </label>
                    <button
                      onClick={() => saveConnector().catch(() => {})}
                      style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #111', background: '#111', color: '#fff' }}
                    >
                      Guardar connector
                    </button>
                    <button
                      onClick={() => setConnectorEditor(null)}
                      style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #ccc', background: '#fff' }}
                    >
                      Cancelar
                    </button>
                    {connectorEditor.id ? (
                      <button
                        onClick={() => testConnector(connectorEditor.id).catch(() => {})}
                        style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #ccc', background: '#fff' }}
                      >
                        Test conexión
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <div style={{ border: '1px solid #eee', borderRadius: 10, padding: 12, background: '#fff' }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Medilink API</div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 10 }}>
              Estado:{' '}
              {medilinkConnector?.hasToken ? (
                <span style={{ color: '#1a7f37' }}>✅ Token configurado ({medilinkConnector.tokenMasked || 'masked'})</span>
              ) : (
                <span style={{ color: '#b93800' }}>⚠️ Sin token</span>
              )}{' '}
              · Base URL:{' '}
              {medilinkConnector?.baseUrl ? <span style={{ color: '#1a7f37' }}>✅</span> : <span style={{ color: '#b93800' }}>⚠️</span>}
              {medilinkConnector?.lastTestedAt ? (
                <span style={{ marginLeft: 6 }}>
                  · Último test:{' '}
                  {medilinkConnector?.lastTestOk ? (
                    <span style={{ color: '#1a7f37' }}>OK</span>
                  ) : (
                    <span style={{ color: '#b93800' }}>FAIL</span>
                  )}
                </span>
              ) : null}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, alignItems: 'start' }}>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Base URL</div>
                <input
                  value={medilinkBaseUrl}
                  onChange={(e) => setMedilinkBaseUrl(e.target.value)}
                  placeholder="https://api.medilink.cl"
                  style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                />
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Token (masked)</div>
                <input
                  value={medilinkToken}
                  onChange={(e) => setMedilinkToken(e.target.value)}
                  placeholder="Pega aquí para actualizar (vacío = no cambia)"
                  type="password"
                  style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                />
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Test endpoint path</div>
                <input
                  value={medilinkTestPath}
                  onChange={(e) => setMedilinkTestPath(e.target.value)}
                  placeholder="/health"
                  style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                />
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Test method</div>
                <select
                  value={medilinkTestMethod}
                  onChange={(e) => setMedilinkTestMethod(e.target.value)}
                  style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                >
                  <option value="GET">GET</option>
                  <option value="HEAD">HEAD</option>
                </select>
              </div>
            </div>
            <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                onClick={() => saveMedilink().catch(() => {})}
                style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #111', background: '#111', color: '#fff' }}
              >
                Guardar Medilink
              </button>
              <button
                onClick={() => testMedilink().catch(() => {})}
                style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #ccc', background: '#fff' }}
              >
                Test conexión
              </button>
              {medilinkConnector?.id && connectorTestStatus[String(medilinkConnector.id)] ? (
                <div
                  style={{
                    fontSize: 12,
                    color: String(connectorTestStatus[String(medilinkConnector.id)]).startsWith('OK') ? '#1a7f37' : '#666',
                  }}
                >
                  {connectorTestStatus[String(medilinkConnector.id)]}
                </div>
              ) : null}
              {medilinkStatus ? <div style={{ fontSize: 12, color: '#1a7f37' }}>{medilinkStatus}</div> : null}
              {medilinkError ? <div style={{ fontSize: 12, color: '#b93800' }}>{medilinkError}</div> : null}
              {medilinkConnector?.lastTestError ? (
                <div style={{ fontSize: 12, color: '#b93800' }}>Último error: {String(medilinkConnector.lastTestError)}</div>
              ) : null}
            </div>
          </div>

          <div style={{ border: '1px solid #eee', borderRadius: 10, padding: 12, background: '#fff' }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Números autorizados (roles)</div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 10 }}>
              Estos números se consideran ADMIN o TEST para guardrails y simulación. En DEV, mantén solo los autorizados.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Admin numbers (E.164 sin +)</div>
                <textarea
                  value={authorizedAdminNumbersText}
                  onChange={(e) => setAuthorizedAdminNumbersText(e.target.value)}
                  rows={4}
                  style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                />
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Test numbers (E.164 sin +)</div>
                <textarea
                  value={authorizedTestNumbersText}
                  onChange={(e) => setAuthorizedTestNumbersText(e.target.value)}
                  rows={4}
                  style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                />
              </div>
            </div>
            <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                onClick={() => saveAuthorizedNumbers().catch(() => {})}
                style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #111', background: '#111', color: '#fff' }}
              >
                Guardar
              </button>
              {authorizedNumbersStatus ? <div style={{ fontSize: 12, color: '#1a7f37' }}>{authorizedNumbersStatus}</div> : null}
              {authorizedNumbersError ? <div style={{ fontSize: 12, color: '#b93800' }}>{authorizedNumbersError}</div> : null}
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
          <div style={{ fontSize: 12, color: '#666' }}>
            Todas las acciones aquí aplican <strong>solo a este workspace</strong>. No se borra ninguna cuenta global ni historial.
          </div>

          <div style={{ border: '1px solid #eee', borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Email</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Name</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Role</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Scope</th>
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
                    <td style={{ padding: 10, fontSize: 13 }}>
                      {u.role === 'MEMBER' ? (
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <input
                            type="checkbox"
                            checked={Boolean(u.assignedOnly)}
                            onChange={(e) => setUserAssignedOnly(u.membershipId, e.target.checked).catch(() => {})}
                          />
                          <span style={{ fontSize: 12, color: '#555' }}>Solo asignadas</span>
                        </label>
                      ) : (
                        <span style={{ fontSize: 12, color: '#999' }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: 10, fontSize: 13 }}>{u.addedAt}</td>
                    <td style={{ padding: 10, fontSize: 13 }}>
                      <button
                        onClick={() => {
                          const nextArchived = !u.archivedAt;
                          const ok = window.confirm(
                            nextArchived
                              ? `¿Desactivar a ${u.email} en este workspace?\n\nEsto NO borra datos. El usuario no podrá acceder a ESTE workspace hasta reactivarlo.`
                              : `¿Reactivar a ${u.email} en este workspace?\n\nEsto solo afecta ESTE workspace.`
                          );
                          if (!ok) return;
                          toggleUserArchived(u.membershipId, nextArchived).catch(() => {});
                        }}
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
                <select
                  value={inviteRole}
                  onChange={(e) => {
                    const next = e.target.value;
                    setInviteRole(next);
                    if (String(next).toUpperCase() !== 'MEMBER') setInviteAssignedOnly(false);
                  }}
                  style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }}
                >
                  {['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'].map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              {String(inviteRole).toUpperCase() === 'MEMBER' ? (
                <label style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#555' }}>
                  <input type="checkbox" checked={inviteAssignedOnly} onChange={(e) => setInviteAssignedOnly(e.target.checked)} />
                  Solo conversaciones asignadas (assignedOnly)
                </label>
              ) : null}
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

          <div style={{ marginTop: 12, border: '1px solid #eee', borderRadius: 10, padding: 12, background: '#fff' }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Invitaciones (links)</div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 10 }}>
              Para invitar a alguien, comparte el link. No se borra: se archiva/expira y puedes re-emitir un link nuevo.
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#555' }}>
                <input
                  type="checkbox"
                  checked={invitesIncludeArchived}
                  onChange={(e) => {
                    setInvitesIncludeArchived(e.target.checked);
                    loadInvites({ includeArchived: e.target.checked }).catch(() => {});
                  }}
                />
                Mostrar archivadas
              </label>
              <button
                onClick={() => loadInvites().catch(() => {})}
                style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
              >
                Refresh
              </button>
            </div>
            {invitesError ? <div style={{ marginBottom: 8, fontSize: 12, color: '#b93800' }}>{invitesError}</div> : null}
            <div style={{ border: '1px solid #f0f0f0', borderRadius: 10, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Email</th>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Role</th>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Scope</th>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Expires</th>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Accepted at</th>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Accepted by</th>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Estado</th>
                    <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {(invites || []).length === 0 ? (
                    <tr>
                      <td colSpan={8} style={{ padding: 10, fontSize: 13, color: '#666' }}>
                        — Sin invitaciones.
                      </td>
                    </tr>
                  ) : (
                    invites.map((i: any) => (
                      <tr key={i.id} style={{ borderTop: '1px solid #f0f0f0' }}>
                        <td style={{ padding: 10, fontSize: 13 }}>{i.email}</td>
                        <td style={{ padding: 10, fontSize: 13 }}>{i.role}</td>
                        <td style={{ padding: 10, fontSize: 12, color: '#555' }}>
                          {String(i.role || '').toUpperCase() === 'MEMBER' && i.assignedOnly ? 'Solo asignadas' : '—'}
                        </td>
                        <td style={{ padding: 10, fontSize: 13 }}>{i.expiresAt ? String(i.expiresAt).slice(0, 19).replace('T', ' ') : '—'}</td>
                        <td style={{ padding: 10, fontSize: 13 }}>{i.acceptedAt ? String(i.acceptedAt).slice(0, 19).replace('T', ' ') : '—'}</td>
                        <td style={{ padding: 10, fontSize: 12, color: '#555' }}>
                          {i.acceptedBy?.email ? String(i.acceptedBy.email) : '—'}
                        </td>
                        <td style={{ padding: 10, fontSize: 12, color: i.archivedAt ? '#b93800' : '#1a7f37' }}>
                          {(() => {
                            const expired = i.expiresAt ? new Date(String(i.expiresAt)).getTime() <= Date.now() : false;
                            if (i.archivedAt) return 'Archivada';
                            if (i.acceptedAt) return 'Aceptada';
                            if (expired) return 'Expirada';
                            return 'Pendiente';
                          })()}
                        </td>
                        <td style={{ padding: 10, fontSize: 13 }}>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                            <button
                              onClick={() => copyInviteLink(i.id).catch(() => {})}
                              style={{ padding: '4px 8px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}
                            >
                              Copiar link
                            </button>
                            <button
                              onClick={() => copyInviteInstructions(i).catch(() => {})}
                              style={{ padding: '4px 8px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}
                            >
                              Copiar instrucciones
                            </button>
                            {!i.archivedAt ? (
                              <button
                                onClick={() => reissueInvite(i.id).catch(() => {})}
                                style={{ padding: '4px 8px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}
                              >
                                Re-emitir link
                              </button>
                            ) : null}
                            <button
                              onClick={() => archiveInvite(i.id, !i.archivedAt).catch(() => {})}
                              style={{ padding: '4px 8px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}
                            >
                              {i.archivedAt ? 'Restaurar' : 'Archivar'}
                            </button>
                            {inviteUrlById[i.id] ? <span style={{ fontSize: 12, color: '#666' }}>{inviteUrlById[i.id]}</span> : null}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      {tab === 'phoneLines' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>Números WhatsApp</div>
              <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                Tip: <span style={{ fontFamily: 'monospace' }}>phoneE164</span> es solo el número (ej: <span style={{ fontFamily: 'monospace' }}>+56994830202</span>). Nunca pegues tokens/credenciales aquí.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#555' }}>
                <input
                  type="checkbox"
                  checked={phoneLinesIncludeArchived}
                  onChange={(e) => {
                    setPhoneLinesIncludeArchived(e.target.checked);
                    loadPhoneLines({ includeArchived: e.target.checked }).catch(() => {});
                  }}
                />
                Mostrar archivados
              </label>
              <button
                onClick={() => loadPhoneLines().catch(() => {})}
                style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
              >
                Refresh
              </button>
              <button
                onClick={() =>
                  setPhoneLineEditor({ alias: '', phoneE164: '', waPhoneNumberId: '', wabaId: '', defaultProgramId: '', isActive: true })
                }
                style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff' }}
              >
                + Agregar número
              </button>
            </div>
          </div>

          {phoneLinesError ? <div style={{ fontSize: 12, color: '#b93800' }}>{phoneLinesError}</div> : null}
          {phoneLinesStatus ? <div style={{ fontSize: 12, color: '#1a7f37' }}>{phoneLinesStatus}</div> : null}

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
                    {(() => {
                      const isArchived = Boolean(l.archivedAt);
                      const isActive = Boolean(l.isActive) && !isArchived;
                      const statusLabel = isArchived ? 'Archived' : isActive ? 'Active' : 'Inactive';
                      return (
                        <>
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
                        disabled={isArchived}
                        onChange={(e) => patchPhoneLine(String(l.id), { defaultProgramId: e.target.value || null }).catch(() => {})}
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
                          disabled={isArchived}
                          checked={isActive}
                          onChange={(e) => patchPhoneLine(String(l.id), { isActive: e.target.checked }).catch(() => {})}
                        />
                        {statusLabel}
                      </label>
                      {isArchived && l.archivedAt ? (
                        <div style={{ marginTop: 4, fontSize: 11, color: '#666' }}>
                          Archivado: {String(l.archivedAt).slice(0, 19).replace('T', ' ')}
                        </div>
                      ) : null}
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
                        onClick={() => archivePhoneLine(String(l.id), !isArchived).catch(() => {})}
                        style={{ marginLeft: 8, padding: '4px 8px', borderRadius: 6, border: '1px solid #ccc', background: '#fff' }}
                      >
                        {isArchived ? 'Restaurar' : 'Archivar'}
                      </button>
                    </td>
                        </>
                      );
                    })()}
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
                <input
                  value={phoneLineEditor.phoneE164 || ''}
                  onChange={(e) => {
                    setPhoneLineSaveError(null);
                    setPhoneLineSaveStatus(null);
                    setPhoneLineEditor({ ...phoneLineEditor, phoneE164: e.target.value });
                  }}
                  placeholder="phoneE164 (E.164 Chile, ej: +56994830202)"
                  style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }}
                />
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
              <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>
                Regla: no reutilices el mismo <span style={{ fontFamily: 'monospace' }}>waPhoneNumberId</span> en dos workspaces activos a la vez.
                Si necesitas mover la línea a otro workspace, primero desactívala/archívala en el workspace anterior.
              </div>
              <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                <button onClick={() => savePhoneLine().catch(() => {})} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff' }}>
                  Guardar
                </button>
                <button onClick={() => setPhoneLineEditor(null)} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff' }}>
                  Cancelar
                </button>
              </div>
              {phoneLineSaveStatus ? <div style={{ marginTop: 8, fontSize: 12, color: '#1a7f37' }}>{phoneLineSaveStatus}</div> : null}
              {phoneLineSaveError ? <div style={{ marginTop: 8, fontSize: 12, color: '#b93800' }}>{phoneLineSaveError}</div> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === 'programs' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Programs</div>
            <button
              onClick={() => setProgramEditor({ name: '', slug: '', description: '', goal: '', audience: '', tone: '', language: 'ES', isActive: true, agentSystemPrompt: '' })}
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
                  <tr
                    key={p.id}
                    id={`program-row-${p.id}`}
                    style={{
                      borderTop: '1px solid #f0f0f0',
                      background: focusedProgramId === p.id ? '#fff7cc' : '#fff',
                      transition: 'background 220ms ease'
                    }}
                  >
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
                <select
                  value={programEditor.language || 'ES'}
                  onChange={(e) => setProgramEditor({ ...programEditor, language: e.target.value })}
                  style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }}
                  aria-label="Idioma"
                >
                  <option value="ES">Idioma: ES</option>
                  <option value="EN">Idioma: EN</option>
                </select>
                <input value={programEditor.audience || ''} onChange={(e) => setProgramEditor({ ...programEditor, audience: e.target.value })} placeholder="Público (opcional)" style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }} />
                <input value={programEditor.tone || ''} onChange={(e) => setProgramEditor({ ...programEditor, tone: e.target.value })} placeholder="Tono (opcional)" style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }} />
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={Boolean(programEditor.isActive)} onChange={(e) => setProgramEditor({ ...programEditor, isActive: e.target.checked })} />
                  Active
                </label>
              </div>

              <textarea
                value={programEditor.goal || ''}
                onChange={(e) => setProgramEditor({ ...programEditor, goal: e.target.value })}
                rows={3}
                placeholder="Objetivo del Program (opcional). Ej: informar, calificar y agendar."
                style={{ width: '100%', marginTop: 10, padding: 10, borderRadius: 10, border: '1px solid #ddd', fontSize: 12 }}
              />

              <div style={{ marginTop: 10, fontSize: 12, color: '#666' }}>
                Hint: Define objetivo, datos a recolectar, tono, y cómo decidir SET_STAGE/SET_STATUS/SEND_MESSAGE.
              </div>

              <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 800, fontSize: 13 }}>Instrucciones del Agente</div>
                <button
                  onClick={() => generateProgramPrompt().catch(() => {})}
                  disabled={!programEditor.id || promptGenerating}
                  style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff', fontSize: 12 }}
                  title={!programEditor.id ? 'Guarda el Program primero' : 'Genera una propuesta de prompt usando IA'}
                >
                  {promptGenerating ? 'Generando…' : 'Generar / Mejorar con IA'}
                </button>
              </div>
              {promptGenError ? <div style={{ marginTop: 6, fontSize: 12, color: '#b93800' }}>{promptGenError}</div> : null}
              <textarea
                value={programEditor.agentSystemPrompt || ''}
                onChange={(e) => setProgramEditor({ ...programEditor, agentSystemPrompt: e.target.value })}
                rows={12}
                style={{ width: '100%', marginTop: 8, padding: 10, borderRadius: 10, border: '1px solid #ddd', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 12 }}
              />
              {promptSuggestion ? (
                <div style={{ marginTop: 10, border: '1px solid #eee', borderRadius: 10, padding: 10, background: '#fafafa' }}>
                  <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>Propuesta (preview)</div>
                  <textarea value={promptSuggestion} readOnly rows={10} style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 12 }} />
                  <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button onClick={() => applyProgramPrompt().catch(() => {})} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff', fontSize: 12, fontWeight: 800 }}>
                      Aplicar
                    </button>
                    <button onClick={() => setPromptSuggestion(null)} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}>
                      Cerrar
                    </button>
                  </div>
                </div>
              ) : null}

              <div style={{ marginTop: 12, border: '1px solid #eee', borderRadius: 10, padding: 10 }}>
                <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>Knowledge Pack (archive-only)</div>
                {!programEditor.id ? (
                  <div style={{ fontSize: 12, color: '#666' }}>Guarda el Program para poder agregar assets.</div>
                ) : (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 8, alignItems: 'center' }}>
                      <select value={newAssetType} onChange={(e) => setNewAssetType(e.target.value as any)} style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }}>
                        <option value="LINK">Link</option>
                        <option value="TEXT">Texto</option>
                      </select>
                      <input value={newAssetTitle} onChange={(e) => setNewAssetTitle(e.target.value)} placeholder="Título (required)" style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }} />
                      {newAssetType === 'LINK' ? (
                        <>
                          <div style={{ fontSize: 12, color: '#666' }}>URL</div>
                          <input value={newAssetUrl} onChange={(e) => setNewAssetUrl(e.target.value)} placeholder="https://..." style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }} />
                        </>
                      ) : (
                        <>
                          <div style={{ fontSize: 12, color: '#666' }}>Texto</div>
                          <textarea value={newAssetContent} onChange={(e) => setNewAssetContent(e.target.value)} rows={4} placeholder="Pega aquí texto/FAQ/políticas..." style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }} />
                        </>
                      )}
                      <div style={{ fontSize: 12, color: '#666' }}>Tags</div>
                      <input value={newAssetTags} onChange={(e) => setNewAssetTags(e.target.value)} placeholder="tags (opcional, separados por coma)" style={{ padding: 8, borderRadius: 8, border: '1px solid #ddd' }} />
                    </div>
                    <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        onClick={() => addProgramAsset().catch(() => {})}
                        disabled={knowledgeLoading || !newAssetTitle.trim() || (newAssetType === 'LINK' ? !newAssetUrl.trim() : !newAssetContent.trim())}
                        style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff', fontSize: 12 }}
                      >
                        Agregar asset
                      </button>
                      <button onClick={() => loadProgramKnowledge(String(programEditor.id)).catch(() => {})} disabled={knowledgeLoading} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}>
                        {knowledgeLoading ? 'Cargando…' : 'Recargar'}
                      </button>
                    </div>
                    {knowledgeError ? <div style={{ marginTop: 8, fontSize: 12, color: '#b93800' }}>{knowledgeError}</div> : null}
                    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {programKnowledge.length === 0 ? (
                        <div style={{ fontSize: 12, color: '#666' }}>— Sin assets aún.</div>
                      ) : (
                        programKnowledge.slice(0, 30).map((a: any) => (
                          <details key={a.id} style={{ border: '1px solid #eee', borderRadius: 10, padding: 10, background: '#fff' }}>
                            <summary style={{ cursor: 'pointer', fontWeight: 800 }}>
                              [{a.type}] {a.title} {a.archivedAt ? '(ARCHIVADO)' : ''}
                            </summary>
                            {a.url ? <div style={{ marginTop: 6, fontSize: 12 }}><a href={a.url} target="_blank" rel="noreferrer">{a.url}</a></div> : null}
                            {a.contentText ? <pre style={{ marginTop: 8, whiteSpace: 'pre-wrap', fontSize: 12 }}>{a.contentText}</pre> : null}
                            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                              <button
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setAssetArchived(a.id, !a.archivedAt).catch(() => {});
                                }}
                                style={{ padding: '4px 8px', borderRadius: 8, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                              >
                                {a.archivedAt ? 'Reactivar' : 'Archivar'}
                              </button>
                              <span style={{ fontSize: 12, color: '#666' }}>{a.createdAt ? `creado: ${a.createdAt}` : ''}</span>
                            </div>
                          </details>
                        ))
                      )}
                    </div>
                  </>
                )}
              </div>

              <div style={{ marginTop: 12, border: '1px solid #eee', borderRadius: 10, padding: 10 }}>
                <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>Integraciones / Tools del Program</div>
                {!programEditor.id ? (
                  <div style={{ fontSize: 12, color: '#666' }}>Guarda el Program para configurar Tools.</div>
                ) : (
                  <>
                    {toolsError ? <div style={{ marginBottom: 8, fontSize: 12, color: '#b93800' }}>{toolsError}</div> : null}
                    {programConnectors.length === 0 ? (
                      <div style={{ fontSize: 12, color: '#666' }}>
                        — No hay conectores en el workspace. Puedes crear uno en Integraciones (o espera el bootstrap).
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {programConnectors.map((c: any) => {
                          const sel = programToolSelections[String(c.id)] || { enabled: false, allowed: {} };
                          const actions = Array.isArray(c.actions) ? c.actions : [];
                          const enabled = Boolean(sel.enabled);
                          const allowAll = enabled && actions.length > 0 && Object.values(sel.allowed || {}).every((v) => !v);
                          return (
                            <div key={c.id} style={{ border: '1px solid #eee', borderRadius: 10, padding: 10, background: '#fff' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                <div>
                                  <div style={{ fontWeight: 800 }}>{c.name} <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#666' }}>({c.slug})</span></div>
                                  {c.description ? <div style={{ fontSize: 12, color: '#666' }}>{c.description}</div> : null}
                                </div>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                                  <input
                                    type="checkbox"
                                    checked={enabled}
                                    onChange={(e) => {
                                      const nextEnabled = e.target.checked;
                                      setProgramToolSelections((prev) => ({
                                        ...prev,
                                        [String(c.id)]: { ...(prev[String(c.id)] || { enabled: false, allowed: {} }), enabled: nextEnabled },
                                      }));
                                    }}
                                  />
                                  Habilitar
                                </label>
                              </div>
                              {enabled ? (
                                <div style={{ marginTop: 8 }}>
                                  {actions.length === 0 ? (
                                    <div style={{ fontSize: 12, color: '#666' }}>Este conector no declara acciones (se permite todo).</div>
                                  ) : (
                                    <>
                                      <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>
                                        Acciones permitidas (si no marcas ninguna, se interpreta como “todas”).
                                      </div>
                                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                        {actions.map((a: any) => {
                                          const key = String(a);
                                          const checked = Boolean(sel.allowed?.[key]);
                                          return (
                                            <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid #eee', borderRadius: 999, padding: '4px 10px', fontSize: 12 }}>
                                              <input
                                                type="checkbox"
                                                checked={checked}
                                                onChange={(e) => {
                                                  const nextChecked = e.target.checked;
                                                  setProgramToolSelections((prev) => ({
                                                    ...prev,
                                                    [String(c.id)]: {
                                                      ...(prev[String(c.id)] || { enabled: true, allowed: {} }),
                                                      enabled: true,
                                                      allowed: { ...(prev[String(c.id)]?.allowed || {}), [key]: nextChecked },
                                                    },
                                                  }));
                                                }}
                                              />
                                              {key}
                                            </label>
                                          );
                                        })}
                                      </div>
                                      {allowAll ? <div style={{ marginTop: 6, fontSize: 12, color: '#666' }}>Modo: permitir todas las acciones.</div> : null}
                                    </>
                                  )}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        onClick={() => saveProgramTools().catch(() => {})}
                        disabled={toolsSaving}
                        style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff', fontSize: 12 }}
                      >
                        {toolsSaving ? 'Guardando…' : 'Guardar Tools'}
                      </button>
                      <button
                        onClick={() => loadProgramTools(String(programEditor.id)).catch(() => {})}
                        disabled={toolsSaving}
                        style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                      >
                        Recargar
                      </button>
                      {toolsStatus ? <span style={{ fontSize: 12, color: '#1a7f37' }}>{toolsStatus}</span> : null}
                    </div>
                  </>
                )}
              </div>

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
              data-guide-id="config-automations-new-rule"
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
                      {(() => {
                        const line = r.scopePhoneLineId
                          ? phoneLines.find((l) => String(l.id) === String(r.scopePhoneLineId))
                          : null;
                        const prog = r.scopeProgramId
                          ? programs.find((p) => String(p.id) === String(r.scopeProgramId))
                          : null;
                        const lineLabel = r.scopePhoneLineId ? (line?.alias ? `Line:${line.alias}` : `Line:${r.scopePhoneLineId}`) : 'Any';
                        const progLabel = r.scopeProgramId ? (prog?.name ? `Program:${prog.name}` : `Program:${r.scopeProgramId}`) : 'Any';
                        return `${lineLabel} / ${progLabel}`;
                      })()}
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
                    {(() => {
                      const field = String(row.field || '');
                      const value = typeof row.value === 'undefined' || row.value === null ? '' : String(row.value);
                      const setValue = (nextValue: any) => {
                        const next = [...automationEditor.conditions];
                        next[idx] = { ...row, value: nextValue };
                        setAutomationEditor({ ...automationEditor, conditions: next });
                      };
                      const style: React.CSSProperties = { padding: 6, borderRadius: 8, border: '1px solid #ddd' };

                      if (field === 'conversation.status') {
                        return (
                          <select value={value || 'NEW'} onChange={(e) => setValue(e.target.value)} style={style}>
                            {['NEW', 'OPEN', 'CLOSED'].map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                        );
                      }
                      if (field === 'whatsapp.windowStatus') {
                        return (
                          <select value={value || 'IN_24H'} onChange={(e) => setValue(e.target.value)} style={style}>
                            {['IN_24H', 'OUTSIDE_24H'].map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                        );
                      }
                      if (field === 'contact.noContactar' || field.startsWith('contact.has')) {
                        return (
                          <select value={value || 'false'} onChange={(e) => setValue(e.target.value)} style={style}>
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </select>
                        );
                      }

                      return (
                        <input
                          value={value}
                          onChange={(e) => setValue(e.target.value)}
                          style={style}
                        />
                      );
                    })()}
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

                <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#555' }}>
                    <input
                      type="checkbox"
                      checked={Boolean((automationEditor.actions || []).find((a: any) => a.type === 'SET_STATUS'))}
                      onChange={(e) => {
                        const enabled = e.target.checked;
                        const rest = (automationEditor.actions || []).filter((a: any) => a.type !== 'SET_STATUS');
                        const next = enabled ? [...rest, { type: 'SET_STATUS', status: 'OPEN' }] : rest;
                        setAutomationEditor({ ...automationEditor, actions: next });
                      }}
                    />
                    SET_STATUS
                  </label>
                  {(automationEditor.actions || []).find((a: any) => a.type === 'SET_STATUS') ? (
                    <select
                      value={(automationEditor.actions || []).find((a: any) => a.type === 'SET_STATUS')?.status || 'OPEN'}
                      onChange={(e) => {
                        const rest = (automationEditor.actions || []).filter((a: any) => a.type !== 'SET_STATUS');
                        const next = [...rest, { type: 'SET_STATUS', status: e.target.value }];
                        setAutomationEditor({ ...automationEditor, actions: next });
                      }}
                      style={{ padding: 6, borderRadius: 8, border: '1px solid #ddd' }}
                    >
                      {['NEW', 'OPEN', 'CLOSED'].map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>

                <div style={{ marginTop: 10 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#555' }}>
                    <input
                      type="checkbox"
                      checked={Boolean((automationEditor.actions || []).find((a: any) => a.type === 'ADD_NOTE'))}
                      onChange={(e) => {
                        const enabled = e.target.checked;
                        const rest = (automationEditor.actions || []).filter((a: any) => a.type !== 'ADD_NOTE');
                        const next = enabled ? [...rest, { type: 'ADD_NOTE', note: 'Nota del sistema' }] : rest;
                        setAutomationEditor({ ...automationEditor, actions: next });
                      }}
                    />
                    ADD_NOTE
                  </label>
                  {(automationEditor.actions || []).find((a: any) => a.type === 'ADD_NOTE') ? (
                    <textarea
                      value={(automationEditor.actions || []).find((a: any) => a.type === 'ADD_NOTE')?.note || ''}
                      onChange={(e) => {
                        const rest = (automationEditor.actions || []).filter((a: any) => a.type !== 'ADD_NOTE');
                        const next = [...rest, { type: 'ADD_NOTE', note: e.target.value }];
                        setAutomationEditor({ ...automationEditor, actions: next });
                      }}
                      rows={3}
                      style={{ width: '100%', marginTop: 6, padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                      placeholder="Nota visible como mensaje SYSTEM en la conversación (CRM)."
                    />
                  ) : null}
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
                      <div style={{ fontSize: 12, color: '#666' }}>
                        {(r.program?.name ? `${r.program.name}${r.program.slug ? ` (${r.program.slug})` : ''}` : 'Program: —')} · {r.conversationId || '—'}
                      </div>
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

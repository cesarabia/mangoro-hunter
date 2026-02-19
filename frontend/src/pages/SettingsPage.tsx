import React, { useEffect, useState } from 'react';
import { apiClient } from '../api/client';
import { defaultAiPrompt } from '../constants/defaultAiPrompt';

interface SettingsPageProps {
  onBack: () => void;
}

interface WhatsappConfigResponse {
  whatsappBaseUrl: string | null;
  whatsappPhoneId: string | null;
  botAutoReply: boolean;
  hasToken: boolean;
  hasVerifyToken?: boolean;
  adminWaId?: string | null;
}

interface AuthorizedNumbersConfigResponse {
  adminNumbers: string[];
  testNumbers: string[];
}

interface AiConfigResponse {
  hasOpenAiKey: boolean;
  aiModel?: string;
}

interface AdminAccountResponse {
  adminEmail: string | null;
}

interface AiPromptResponse {
  aiPrompt: string;
  aiModel?: string;
  jobSheet?: string | null;
  faq?: string | null;
}

interface AdminAiConfigResponse {
  prompt: string;
  hasCustomPrompt: boolean;
  model: string;
}

interface InterviewAiConfigResponse {
  prompt: string;
  hasCustomPrompt: boolean;
  model: string;
}

interface InterviewScheduleConfigResponse {
  interviewTimezone: string;
  interviewSlotMinutes: number;
  interviewWeeklyAvailability: string;
  interviewExceptions: string;
  interviewLocations: string;
}

type InterviewLocationForm = {
  label: string;
  exactAddress: string;
  instructions: string;
};

interface TemplatesConfigResponse {
  templateInterviewInvite: string;
  templateGeneralFollowup: string;
  templateLanguageCode: string;
  defaultJobTitle: string;
  defaultInterviewDay: string;
  defaultInterviewTime: string;
  defaultInterviewLocation: string;
  testPhoneNumber: string | null;
}

interface SalesAiConfigResponse {
  prompt: string;
  knowledgeBase: string;
  hasCustomPrompt: boolean;
  hasCustomKnowledgeBase: boolean;
}

interface AdminNotificationsConfigResponse {
  detailLevel: string;
  templates: Record<string, string>;
  enabledEvents?: string[];
  detailLevelsByEvent?: Record<string, string>;
}

interface WorkflowConfigResponse {
  inactivityDays: number;
  archiveDays: number;
  rules: any[];
}

type WeekdayKey = 'lunes' | 'martes' | 'miercoles' | 'jueves' | 'viernes' | 'sabado' | 'domingo';
type TimeInterval = { start: string; end: string };
type WeeklyAvailability = Record<WeekdayKey, TimeInterval[]>;

const WEEKDAYS: Array<{ key: WeekdayKey; label: string }> = [
  { key: 'lunes', label: 'Lunes' },
  { key: 'martes', label: 'Martes' },
  { key: 'miercoles', label: 'Miércoles' },
  { key: 'jueves', label: 'Jueves' },
  { key: 'viernes', label: 'Viernes' },
  { key: 'sabado', label: 'Sábado' },
  { key: 'domingo', label: 'Domingo' }
];

const emptyWeeklyAvailability = (): WeeklyAvailability => ({
  lunes: [],
  martes: [],
  miercoles: [],
  jueves: [],
  viernes: [],
  sabado: [],
  domingo: []
});

const stripAccents = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const normalizeDayKey = (raw: string): WeekdayKey | null => {
  const key = stripAccents(String(raw || '').trim().toLowerCase());
  if (!key) return null;
  if (key === 'lunes') return 'lunes';
  if (key === 'martes') return 'martes';
  if (key === 'miercoles' || key === 'miércoles') return 'miercoles';
  if (key === 'jueves') return 'jueves';
  if (key === 'viernes') return 'viernes';
  if (key === 'sabado' || key === 'sábado') return 'sabado';
  if (key === 'domingo') return 'domingo';
  return null;
};

const parseJson = (value: string): any => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const parseLocationForms = (raw: string): InterviewLocationForm[] => {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  const out: InterviewLocationForm[] = [];
  for (const item of parsed) {
    if (typeof item === 'string') {
      const label = item.trim().replace(/\s+/g, ' ');
      if (!label) continue;
      out.push({ label, exactAddress: '', instructions: '' });
      continue;
    }
    if (item && typeof item === 'object') {
      const labelRaw = typeof (item as any).label === 'string' ? String((item as any).label) : '';
      const exactAddressRaw = typeof (item as any).exactAddress === 'string' ? String((item as any).exactAddress) : '';
      const instructionsRaw = typeof (item as any).instructions === 'string' ? String((item as any).instructions) : '';
      const label = labelRaw.trim().replace(/\s+/g, ' ');
      if (!label) continue;
      out.push({ label, exactAddress: exactAddressRaw.trim(), instructions: instructionsRaw.trim() });
    }
  }
  return out;
};

const parseExceptions = (raw: string): string[] => {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  const dates = parsed
    .map(entry => {
      if (typeof entry === 'string') return entry.trim();
      if (entry && typeof entry === 'object' && typeof (entry as any).date === 'string') return String((entry as any).date).trim();
      return '';
    })
    .filter(Boolean)
    .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date));
  return Array.from(new Set(dates));
};

const parseWeeklyAvailability = (raw: string): WeeklyAvailability => {
  const base = emptyWeeklyAvailability();
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base;
  for (const [dayRaw, intervals] of Object.entries(parsed as Record<string, any>)) {
    const dayKey = normalizeDayKey(dayRaw);
    if (!dayKey) continue;
    if (!Array.isArray(intervals)) continue;
    const next: TimeInterval[] = [];
    for (const interval of intervals) {
      const start = typeof interval?.start === 'string' ? interval.start.trim() : '';
      const end = typeof interval?.end === 'string' ? interval.end.trim() : '';
      if (!start || !end) continue;
      next.push({ start, end });
    }
    base[dayKey] = next;
  }
  return base;
};

export const SettingsPage: React.FC<SettingsPageProps> = ({ onBack }) => {
  const [loading, setLoading] = useState(true);

  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminStatus, setAdminStatus] = useState<string | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [savingAdmin, setSavingAdmin] = useState(false);

  const [whatsappBaseUrl, setWhatsappBaseUrl] = useState('');
  const [whatsappPhoneId, setWhatsappPhoneId] = useState('');
  const [whatsappToken, setWhatsappToken] = useState('');
  const [botAutoReply, setBotAutoReply] = useState(true);
  const [hasToken, setHasToken] = useState(false);
  const [hasVerifyToken, setHasVerifyToken] = useState(false);
  const [waStatus, setWaStatus] = useState<string | null>(null);
  const [waError, setWaError] = useState<string | null>(null);
  const [savingWa, setSavingWa] = useState(false);
  const [whatsappVerifyToken, setWhatsappVerifyToken] = useState('');
  const [verifyTokenDirty, setVerifyTokenDirty] = useState(false);
  const [adminWaId, setAdminWaId] = useState('');
  const [isEditingAdminWa, setIsEditingAdminWa] = useState(false);
  const [adminWaDraft, setAdminWaDraft] = useState('');
  const [adminNumbers, setAdminNumbers] = useState<string[]>([]);
  const [testNumbers, setTestNumbers] = useState<string[]>([]);
  const [savingNumbers, setSavingNumbers] = useState(false);
  const [numbersStatus, setNumbersStatus] = useState<string | null>(null);
  const [numbersError, setNumbersError] = useState<string | null>(null);

  const [openAiKey, setOpenAiKey] = useState('');
  const [hasOpenAiKey, setHasOpenAiKey] = useState(false);
  const [aiModel, setAiModel] = useState('gpt-4.1-mini');
  const [aiStatus, setAiStatus] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [savingAi, setSavingAi] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiPromptStatus, setAiPromptStatus] = useState<string | null>(null);
  const [aiPromptError, setAiPromptError] = useState<string | null>(null);
  const [savingAiPrompt, setSavingAiPrompt] = useState(false);
  const [recruitJobSheet, setRecruitJobSheet] = useState('');
  const [recruitFaq, setRecruitFaq] = useState('');
  const [adminAiPrompt, setAdminAiPrompt] = useState('');
  const [adminAiModel, setAdminAiModel] = useState('gpt-4.1-mini');
  const [savingAdminAi, setSavingAdminAi] = useState(false);
  const [adminAiStatus, setAdminAiStatus] = useState<string | null>(null);
  const [adminAiError, setAdminAiError] = useState<string | null>(null);
  const [interviewAiPrompt, setInterviewAiPrompt] = useState('');
  const [interviewAiModel, setInterviewAiModel] = useState('gpt-4.1-mini');
  const [savingInterviewAi, setSavingInterviewAi] = useState(false);
  const [interviewAiStatus, setInterviewAiStatus] = useState<string | null>(null);
  const [interviewAiError, setInterviewAiError] = useState<string | null>(null);
  const [templateInterviewInvite, setTemplateInterviewInvite] = useState('');
  const [templateGeneralFollowup, setTemplateGeneralFollowup] = useState('');
  const [templateLanguageCode, setTemplateLanguageCode] = useState('es_CL');
  const [defaultJobTitle, setDefaultJobTitle] = useState('Vendedor/a');
  const [defaultInterviewDay, setDefaultInterviewDay] = useState('Lunes');
  const [defaultInterviewTime, setDefaultInterviewTime] = useState('10:00');
  const [defaultInterviewLocation, setDefaultInterviewLocation] = useState('Online');
  const [testPhoneNumber, setTestPhoneNumber] = useState('');
  const [savingTemplates, setSavingTemplates] = useState(false);
  const [templateStatus, setTemplateStatus] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [testSendStatus, setTestSendStatus] = useState<string | null>(null);
  const [testSendError, setTestSendError] = useState<string | null>(null);
  const [sendingTest, setSendingTest] = useState(false);
  const [resetStatus, setResetStatus] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [interviewTimezone, setInterviewTimezone] = useState('America/Santiago');
  const [interviewSlotMinutes, setInterviewSlotMinutes] = useState(30);
  const [interviewLocationsList, setInterviewLocationsList] = useState<InterviewLocationForm[]>([]);
  const [weeklyAvailability, setWeeklyAvailability] = useState<WeeklyAvailability>(emptyWeeklyAvailability());
  const [exceptionDates, setExceptionDates] = useState<string[]>([]);
  const [showAdvancedSchedule, setShowAdvancedSchedule] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleStatus, setScheduleStatus] = useState<string | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const [salesAiPrompt, setSalesAiPrompt] = useState('');
  const [salesKnowledgeBase, setSalesKnowledgeBase] = useState('');
  const [savingSalesAi, setSavingSalesAi] = useState(false);
  const [salesAiStatus, setSalesAiStatus] = useState<string | null>(null);
  const [salesAiError, setSalesAiError] = useState<string | null>(null);

  const [adminNotifDetailLevel, setAdminNotifDetailLevel] = useState('MEDIUM');
  const [adminNotifEnabledEvents, setAdminNotifEnabledEvents] = useState<string[]>([]);
  const [adminNotifDetailLevelsByEvent, setAdminNotifDetailLevelsByEvent] = useState<Record<string, string>>({});
  const [notifRecruitReady, setNotifRecruitReady] = useState('');
  const [notifInterviewScheduled, setNotifInterviewScheduled] = useState('');
  const [notifInterviewConfirmed, setNotifInterviewConfirmed] = useState('');
  const [notifInterviewOnHold, setNotifInterviewOnHold] = useState('');
  const [notifSellerDailySummary, setNotifSellerDailySummary] = useState('');
  const [savingAdminNotifs, setSavingAdminNotifs] = useState(false);
  const [adminNotifsStatus, setAdminNotifsStatus] = useState<string | null>(null);
  const [adminNotifsError, setAdminNotifsError] = useState<string | null>(null);

  const [workflowInactivityDays, setWorkflowInactivityDays] = useState(7);
  const [workflowArchiveDays, setWorkflowArchiveDays] = useState(30);
  const [workflowEnableStale, setWorkflowEnableStale] = useState(true);
  const [workflowEnableArchive, setWorkflowEnableArchive] = useState(false);
  const [workflowRules, setWorkflowRules] = useState<any[]>([]);
  const [savingWorkflow, setSavingWorkflow] = useState(false);
  const [workflowStatus, setWorkflowStatus] = useState<string | null>(null);
  const [workflowError, setWorkflowError] = useState<string | null>(null);

  const [cleanupPanelOpen, setCleanupPanelOpen] = useState(false);
  const [cleanupConfirmText, setCleanupConfirmText] = useState('');
  const [cleaning, setCleaning] = useState(false);
  const [cleanupStatus, setCleanupStatus] = useState<string | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [cleanupResult, setCleanupResult] = useState<any>(null);
  const getModelOptions = (current: string) => {
    const base = ['gpt-4.1-mini', 'gpt-5-chat-latest'];
    return base.includes(current) ? base : [...base, current];
  };

  useEffect(() => {
    const loadAll = async () => {
      setLoading(true);
      try {
        const [wa, ai, admin, aiPromptRes, adminAi, interviewAi, salesAi, adminNotifs, workflow, schedule, templates, numbers] = await Promise.all([
          apiClient.get('/api/config/whatsapp') as Promise<WhatsappConfigResponse>,
          apiClient.get('/api/config/ai') as Promise<AiConfigResponse>,
          apiClient.get('/api/config/admin-account') as Promise<AdminAccountResponse>,
          apiClient.get('/api/config/ai-prompt') as Promise<AiPromptResponse>,
          apiClient.get('/api/config/admin-ai') as Promise<AdminAiConfigResponse>,
          apiClient.get('/api/config/interview-ai') as Promise<InterviewAiConfigResponse>,
          apiClient.get('/api/config/sales-ai') as Promise<SalesAiConfigResponse>,
          apiClient.get('/api/config/admin-notifications') as Promise<AdminNotificationsConfigResponse>,
          apiClient.get('/api/config/workflow') as Promise<WorkflowConfigResponse>,
          apiClient.get('/api/config/interview-schedule') as Promise<InterviewScheduleConfigResponse>,
          apiClient.get('/api/config/templates') as Promise<TemplatesConfigResponse>,
          apiClient.get('/api/config/authorized-numbers') as Promise<AuthorizedNumbersConfigResponse>
        ]);

        setWhatsappBaseUrl(wa.whatsappBaseUrl || 'https://graph.facebook.com/v20.0');
        setWhatsappPhoneId(wa.whatsappPhoneId || '1511895116748404');
        setBotAutoReply(wa.botAutoReply ?? true);
        setHasToken(wa.hasToken);
        setHasVerifyToken(wa.hasVerifyToken ?? false);
        setAdminWaId(wa.adminWaId || '');
        setIsEditingAdminWa(false);
        setAdminWaDraft('');
        setWhatsappVerifyToken('');
        setVerifyTokenDirty(false);
        setHasOpenAiKey(ai.hasOpenAiKey);
        setAiModel(ai.aiModel || 'gpt-4.1-mini');
        setAdminEmail(admin.adminEmail || 'admin@example.com');
        setAiPrompt(aiPromptRes.aiPrompt || defaultAiPrompt);
        setAiModel(aiPromptRes.aiModel || ai.aiModel || 'gpt-4.1-mini');
        setRecruitJobSheet((aiPromptRes.jobSheet || '').toString());
        setRecruitFaq((aiPromptRes.faq || '').toString());
        setAdminAiPrompt(adminAi.prompt || '');
        setAdminAiModel(adminAi.model || 'gpt-4.1-mini');
        setInterviewAiPrompt(interviewAi.prompt || '');
        setInterviewAiModel(interviewAi.model || 'gpt-4.1-mini');
        setSalesAiPrompt(salesAi.prompt || '');
        setSalesKnowledgeBase(salesAi.knowledgeBase || '');
        setAdminNotifDetailLevel((adminNotifs.detailLevel || 'MEDIUM').toUpperCase());
        setNotifRecruitReady(adminNotifs.templates?.RECRUIT_READY || '');
        setNotifInterviewScheduled(adminNotifs.templates?.INTERVIEW_SCHEDULED || '');
        setNotifInterviewConfirmed(adminNotifs.templates?.INTERVIEW_CONFIRMED || '');
        setNotifInterviewOnHold(adminNotifs.templates?.INTERVIEW_ON_HOLD || '');
        setNotifSellerDailySummary(adminNotifs.templates?.SELLER_DAILY_SUMMARY || '');
        setAdminNotifEnabledEvents(Array.isArray(adminNotifs.enabledEvents) ? adminNotifs.enabledEvents : []);
        setAdminNotifDetailLevelsByEvent(
          adminNotifs.detailLevelsByEvent && typeof adminNotifs.detailLevelsByEvent === 'object' ? adminNotifs.detailLevelsByEvent : {}
        );
        setWorkflowInactivityDays(typeof workflow.inactivityDays === 'number' ? workflow.inactivityDays : 7);
        setWorkflowArchiveDays(typeof workflow.archiveDays === 'number' ? workflow.archiveDays : 30);
        const rules = Array.isArray(workflow.rules) ? workflow.rules : [];
        setWorkflowRules(rules);
        const findEnabled = (id: string, fallback: boolean) =>
          rules.find(r => String((r as any)?.id || '') === id)?.enabled ?? fallback;
        setWorkflowEnableStale(Boolean(findEnabled('stale_no_response', true)));
        setWorkflowEnableArchive(Boolean(findEnabled('auto_archive', false)));
        setInterviewTimezone(schedule.interviewTimezone || 'America/Santiago');
        setInterviewSlotMinutes(schedule.interviewSlotMinutes || 30);
        setInterviewLocationsList(parseLocationForms(schedule.interviewLocations || ''));
        setWeeklyAvailability(parseWeeklyAvailability(schedule.interviewWeeklyAvailability || ''));
        setExceptionDates(parseExceptions(schedule.interviewExceptions || '[]'));
        setTemplateInterviewInvite(templates.templateInterviewInvite || '');
        setTemplateGeneralFollowup(templates.templateGeneralFollowup || '');
        setTemplateLanguageCode(templates.templateLanguageCode || 'es_CL');
        setDefaultJobTitle(templates.defaultJobTitle || 'Vendedor/a');
        setDefaultInterviewDay(templates.defaultInterviewDay || 'Lunes');
        setDefaultInterviewTime(templates.defaultInterviewTime || '10:00');
        setDefaultInterviewLocation(templates.defaultInterviewLocation || 'Online');
        setTestPhoneNumber(templates.testPhoneNumber || '');
        setAdminNumbers(Array.isArray(numbers.adminNumbers) ? numbers.adminNumbers : wa.adminWaId ? [wa.adminWaId] : []);
        setTestNumbers(Array.isArray(numbers.testNumbers) ? numbers.testNumbers : templates.testPhoneNumber ? [templates.testPhoneNumber] : []);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };

    loadAll();
  }, []);

  const handleSaveAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingAdmin(true);
    setAdminError(null);
    setAdminStatus(null);
    try {
      await apiClient.put('/api/config/admin-account', {
        email: adminEmail,
        password: adminPassword
      });
      setAdminStatus('Cuenta actualizada');
      setAdminPassword('');
    } catch (err: any) {
      setAdminError(err.message || 'No se pudo guardar la cuenta');
    } finally {
      setSavingAdmin(false);
    }
  };

  const handleSaveWhatsapp = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingWa(true);
    setWaStatus(null);
    setWaError(null);
    try {
      const payload: Record<string, any> = {
        whatsappBaseUrl,
        whatsappPhoneId,
        botAutoReply
      };
      const normalizedDraft = adminWaDraft.replace(/\D/g, '');
      const desiredAdminNumber = isEditingAdminWa ? normalizedDraft : adminWaId;
      payload.adminWaId = desiredAdminNumber ? desiredAdminNumber : null;
      if (whatsappToken.trim()) {
        payload.whatsappToken = whatsappToken.trim();
      } else {
        payload.whatsappToken = undefined;
      }
      if (verifyTokenDirty) {
        const trimmed = whatsappVerifyToken.trim();
        payload.whatsappVerifyToken = trimmed.length > 0 ? trimmed : null;
      }
      const data = (await apiClient.put('/api/config/whatsapp', payload)) as WhatsappConfigResponse;
      setHasToken(data.hasToken);
      setHasVerifyToken(data.hasVerifyToken ?? false);
      setAdminWaId(data.adminWaId || '');
      setIsEditingAdminWa(false);
      setAdminWaDraft('');
      setWaStatus('Configuración de WhatsApp guardada');
      setWhatsappToken('');
      setWhatsappVerifyToken('');
      setVerifyTokenDirty(false);
    } catch (err: any) {
      setWaError(err.message || 'No se pudo guardar WhatsApp');
    } finally {
      setSavingWa(false);
    }
  };

  const handleSaveAuthorizedNumbers = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingNumbers(true);
    setNumbersStatus(null);
    setNumbersError(null);
    try {
      const admins = adminNumbers.map(v => v.replace(/\D/g, '')).filter(Boolean);
      const tests = testNumbers.map(v => v.replace(/\D/g, '')).filter(Boolean);
      if (admins.length === 0) {
        setNumbersError('Define al menos 1 número admin.');
        return;
      }
      const res = (await apiClient.put('/api/config/authorized-numbers', {
        adminNumbers: admins,
        testNumbers: tests
      })) as AuthorizedNumbersConfigResponse;
      setAdminNumbers(res.adminNumbers || []);
      setTestNumbers(res.testNumbers || []);
      setAdminWaId((res.adminNumbers && res.adminNumbers[0]) || adminWaId);
      setTestPhoneNumber((res.testNumbers && res.testNumbers[0]) || testPhoneNumber);
      setNumbersStatus('Números autorizados guardados');
    } catch (err: any) {
      setNumbersError(err.message || 'No se pudieron guardar los números');
    } finally {
      setSavingNumbers(false);
    }
  };

  const handleSaveAi = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingAi(true);
    setAiError(null);
    setAiStatus(null);
    try {
      const res = (await apiClient.put('/api/config/ai', {
        openAiApiKey: openAiKey.trim() || null,
        aiModel
      })) as AiConfigResponse;
      setHasOpenAiKey(res.hasOpenAiKey);
      setAiModel(res.aiModel || aiModel);
      setAiStatus('Configuración de IA guardada');
      setOpenAiKey('');
    } catch (err: any) {
      setAiError(err.message || 'No se pudo guardar la clave');
    } finally {
      setSavingAi(false);
    }
  };

  const handleSaveAiPrompt = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingAiPrompt(true);
    setAiPromptStatus(null);
    setAiPromptError(null);
    try {
      const res = (await apiClient.put('/api/config/ai-prompt', {
        aiPrompt: aiPrompt.trim() || null,
        aiModel,
        jobSheet: recruitJobSheet.trim() || null,
        faq: recruitFaq.trim() || null
      })) as AiPromptResponse;
      setAiPrompt(res.aiPrompt);
      if (res.aiModel) {
        setAiModel(res.aiModel);
      }
      setRecruitJobSheet((res.jobSheet || '').toString());
      setRecruitFaq((res.faq || '').toString());
      setAiPromptStatus('Prompt actualizado');
    } catch (err: any) {
      setAiPromptError(err.message || 'No se pudo guardar el prompt');
    } finally {
      setSavingAiPrompt(false);
    }
  };

  const handleResetTestConversation = async () => {
    if (!testPhoneNumber) {
      setResetError('Configura primero el Número de pruebas.');
      return;
    }
    if (!window.confirm('¿Seguro que quieres archivar y reiniciar la conversación del número de pruebas (sin borrar historial)?')) {
      return;
    }
    setResetting(true);
    setResetStatus(null);
    setResetError(null);
    try {
      const res = (await apiClient.post('/api/config/reset-test-conversation', {})) as any;
      setResetStatus(res?.message || 'Conversación de prueba archivada y reiniciada.');
    } catch (err: any) {
      setResetError(err.message || 'No se pudo resetear la conversación de prueba');
    } finally {
      setResetting(false);
    }
  };

  const handleCleanupTestData = async () => {
    const normalizedTest = (testPhoneNumber || '').replace(/\D/g, '');
    const normalizedInput = cleanupConfirmText.trim().replace(/\D/g, '');
    const ok =
      cleanupConfirmText.trim().toUpperCase() === 'LIMPIAR' ||
      (normalizedTest && normalizedInput === normalizedTest);
    if (!ok) {
      setCleanupError('Confirma escribiendo LIMPIAR o el número de pruebas.');
      return;
    }
    setCleaning(true);
    setCleanupStatus(null);
    setCleanupError(null);
    setCleanupResult(null);
    try {
      const res = (await apiClient.post('/api/config/cleanup-test-data', {})) as any;
      setCleanupResult(res);
      setCleanupStatus('Datos de prueba limpiados. Recarga el inbox para ver cambios.');
      setCleanupPanelOpen(false);
      setCleanupConfirmText('');
    } catch (err: any) {
      setCleanupError(err.message || 'No se pudo limpiar datos de prueba');
    } finally {
      setCleaning(false);
    }
  };

  const handleSaveWorkflow = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingWorkflow(true);
    setWorkflowStatus(null);
    setWorkflowError(null);

    const nextRules = Array.isArray(workflowRules) ? workflowRules.map(rule => ({ ...(rule || {}) })) : [];
    const ensureRule = (id: string, fallback: any) => {
      if (nextRules.some(r => String((r as any)?.id || '') === id)) return;
      nextRules.push(fallback);
    };
    ensureRule('stale_no_response', {
      id: 'stale_no_response',
      enabled: true,
      trigger: 'onInactivity',
      conditions: { inactivityDaysGte: 7, stagesIn: ['NEW_INTAKE', 'WAITING_CANDIDATE'] },
      actions: { setStage: 'STALE_NO_RESPONSE' }
    });
    ensureRule('auto_archive', {
      id: 'auto_archive',
      enabled: false,
      trigger: 'onInactivity',
      conditions: { inactivityDaysGte: 30, stagesIn: ['STALE_NO_RESPONSE'] },
      actions: { setStage: 'ARCHIVED', setStatus: 'CLOSED' }
    });

    for (const rule of nextRules) {
      if (String((rule as any)?.id || '') === 'stale_no_response') {
        (rule as any).enabled = Boolean(workflowEnableStale);
        (rule as any).conditions = {
          ...((rule as any).conditions || {}),
          inactivityDaysGte: Number(workflowInactivityDays) || 7
        };
      }
      if (String((rule as any)?.id || '') === 'auto_archive') {
        (rule as any).enabled = Boolean(workflowEnableArchive);
        (rule as any).conditions = {
          ...((rule as any).conditions || {}),
          inactivityDaysGte: Number(workflowArchiveDays) || 30
        };
      }
    }

    try {
      const res = (await apiClient.put('/api/config/workflow', {
        inactivityDays: workflowInactivityDays,
        archiveDays: workflowArchiveDays,
        rules: nextRules
      })) as WorkflowConfigResponse;
      setWorkflowInactivityDays(typeof res.inactivityDays === 'number' ? res.inactivityDays : 7);
      setWorkflowArchiveDays(typeof res.archiveDays === 'number' ? res.archiveDays : 30);
      const rules = Array.isArray(res.rules) ? res.rules : [];
      setWorkflowRules(rules);
      const findEnabled = (id: string, fallback: boolean) =>
        rules.find(r => String((r as any)?.id || '') === id)?.enabled ?? fallback;
      setWorkflowEnableStale(Boolean(findEnabled('stale_no_response', true)));
      setWorkflowEnableArchive(Boolean(findEnabled('auto_archive', false)));
      setWorkflowStatus('Workflow guardado');
    } catch (err: any) {
      setWorkflowError(err.message || 'No se pudo guardar workflow');
    } finally {
      setSavingWorkflow(false);
    }
  };

  const toggleAdminNotifEvent = (eventType: string) => {
    setAdminNotifEnabledEvents(prev => {
      const normalized = String(eventType || '').trim();
      if (!normalized) return prev;
      return prev.includes(normalized) ? prev.filter(e => e !== normalized) : [...prev, normalized];
    });
  };

  const setAdminNotifEventDetail = (eventType: string, level: string) => {
    const normalizedEvent = String(eventType || '').trim();
    const normalizedLevel = String(level || '').trim().toUpperCase();
    setAdminNotifDetailLevelsByEvent(prev => {
      const next = { ...(prev || {}) };
      if (!normalizedEvent) return next;
      if (!normalizedLevel) {
        delete next[normalizedEvent];
        return next;
      }
      next[normalizedEvent] = normalizedLevel;
      return next;
    });
  };

  const handleSaveAdminNotifications = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingAdminNotifs(true);
    setAdminNotifsStatus(null);
    setAdminNotifsError(null);
    try {
      const res = (await apiClient.put('/api/config/admin-notifications', {
        detailLevel: adminNotifDetailLevel,
        enabledEvents: adminNotifEnabledEvents,
        detailLevelsByEvent: adminNotifDetailLevelsByEvent,
        templates: {
          RECRUIT_READY: notifRecruitReady,
          INTERVIEW_SCHEDULED: notifInterviewScheduled,
          INTERVIEW_CONFIRMED: notifInterviewConfirmed,
          INTERVIEW_ON_HOLD: notifInterviewOnHold,
          SELLER_DAILY_SUMMARY: notifSellerDailySummary
        }
      })) as AdminNotificationsConfigResponse;
      setAdminNotifDetailLevel((res.detailLevel || 'MEDIUM').toUpperCase());
      setNotifRecruitReady(res.templates?.RECRUIT_READY || '');
      setNotifInterviewScheduled(res.templates?.INTERVIEW_SCHEDULED || '');
      setNotifInterviewConfirmed(res.templates?.INTERVIEW_CONFIRMED || '');
      setNotifInterviewOnHold(res.templates?.INTERVIEW_ON_HOLD || '');
      setNotifSellerDailySummary(res.templates?.SELLER_DAILY_SUMMARY || '');
      setAdminNotifEnabledEvents(Array.isArray(res.enabledEvents) ? res.enabledEvents : []);
      setAdminNotifDetailLevelsByEvent(
        res.detailLevelsByEvent && typeof res.detailLevelsByEvent === 'object' ? res.detailLevelsByEvent : {}
      );
      setAdminNotifsStatus('Notificaciones guardadas');
    } catch (err: any) {
      setAdminNotifsError(err.message || 'No se pudo guardar la configuración');
    } finally {
      setSavingAdminNotifs(false);
    }
  };

  const handleSaveAdminAi = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingAdminAi(true);
    setAdminAiStatus(null);
    setAdminAiError(null);
    try {
      await apiClient.put('/api/config/admin-ai', {
        prompt: adminAiPrompt.trim() || null,
        model: adminAiModel
      });
      setAdminAiStatus('IA Admin actualizada');
    } catch (err: any) {
      setAdminAiError(err.message || 'No se pudo guardar la IA admin');
    } finally {
      setSavingAdminAi(false);
    }
  };

  const handleSaveInterviewAi = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingInterviewAi(true);
    setInterviewAiStatus(null);
    setInterviewAiError(null);
    try {
      await apiClient.put('/api/config/interview-ai', {
        prompt: interviewAiPrompt.trim() || null,
        model: interviewAiModel
      });
      setInterviewAiStatus('IA Entrevistador actualizada');
    } catch (err: any) {
      setInterviewAiError(err.message || 'No se pudo guardar la IA entrevistador');
    } finally {
      setSavingInterviewAi(false);
    }
  };

  const handleSaveInterviewSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    const isValidTime = (value: string) => /^(\d{1,2}):(\d{2})$/.test(value.trim());
    const toMinutes = (value: string) => {
      const [hhRaw, mmRaw] = value.split(':');
      const hh = parseInt(hhRaw, 10);
      const mm = parseInt(mmRaw, 10);
      if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
      if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
      return hh * 60 + mm;
    };
    const validateSchedule = (): string | null => {
      if (!interviewTimezone.trim()) return 'Timezone inválida.';
      if (!Number.isFinite(interviewSlotMinutes) || interviewSlotMinutes < 5 || interviewSlotMinutes > 240) {
        return 'Duración de slot inválida (5–240 min).';
      }
      const labels = interviewLocationsList.map(loc => loc.label.trim()).filter(Boolean);
      if (labels.length === 0) return 'Define al menos 1 ubicación.';
      const seen = new Set<string>();
      for (const label of labels) {
        const key = stripAccents(label).toLowerCase();
        if (seen.has(key)) return `Ubicación duplicada: "${label}".`;
        seen.add(key);
      }
      for (const { key, label } of WEEKDAYS) {
        const intervals = weeklyAvailability[key] || [];
        const normalized = intervals
          .map(interval => ({ start: interval.start.trim(), end: interval.end.trim() }))
          .filter(interval => interval.start && interval.end);
        for (const interval of normalized) {
          if (!isValidTime(interval.start) || !isValidTime(interval.end)) {
            return `Hora inválida en ${label} (usa HH:MM).`;
          }
          const startM = toMinutes(interval.start);
          const endM = toMinutes(interval.end);
          if (startM === null || endM === null) return `Hora inválida en ${label}.`;
          if (startM >= endM) return `Intervalo inválido en ${label} (start debe ser menor que end).`;
        }
        const sorted = normalized
          .map(interval => ({ ...interval, startM: toMinutes(interval.start)!, endM: toMinutes(interval.end)! }))
          .sort((a, b) => a.startM - b.startM);
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i].startM < sorted[i - 1].endM) {
            return `Intervalos solapados en ${label}.`;
          }
        }
      }
      const exceptions = exceptionDates.map(value => value.trim()).filter(Boolean);
      for (const date of exceptions) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return `Fecha inválida en excepciones: ${date}`;
      }
      return null;
    };
    const validationError = validateSchedule();
    if (validationError) {
      setScheduleError(validationError);
      setScheduleStatus(null);
      return;
    }
    setSavingSchedule(true);
    setScheduleStatus(null);
    setScheduleError(null);
    try {
      const locations = interviewLocationsList
        .map(loc => ({
          label: loc.label.trim().replace(/\s+/g, ' '),
          exactAddress: loc.exactAddress.trim() || null,
          instructions: loc.instructions.trim() || null
        }))
        .filter(loc => Boolean(loc.label));
      const exceptions = Array.from(new Set(exceptionDates.map(value => value.trim()).filter(Boolean)));
      const weekly: Record<string, Array<{ start: string; end: string }>> = {};
      for (const { key } of WEEKDAYS) {
        weekly[key] = (weeklyAvailability[key] || [])
          .map(interval => ({ start: interval.start.trim(), end: interval.end.trim() }))
          .filter(interval => interval.start && interval.end);
      }
      await apiClient.put('/api/config/interview-schedule', {
        interviewTimezone: interviewTimezone.trim() || null,
        interviewSlotMinutes: Number.isFinite(interviewSlotMinutes) ? interviewSlotMinutes : null,
        interviewWeeklyAvailability: JSON.stringify(weekly),
        interviewExceptions: JSON.stringify(exceptions),
        interviewLocations: JSON.stringify(locations)
      });
      setScheduleStatus('Disponibilidad guardada');
    } catch (err: any) {
      setScheduleError(err.message || 'No se pudo guardar la disponibilidad');
    } finally {
      setSavingSchedule(false);
    }
  };

  const handleSaveSalesAi = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSalesAi(true);
    setSalesAiStatus(null);
    setSalesAiError(null);
    try {
      await apiClient.put('/api/config/sales-ai', {
        prompt: salesAiPrompt.trim() || null,
        knowledgeBase: salesKnowledgeBase.trim() || null
      });
      setSalesAiStatus('IA Ventas actualizada');
    } catch (err: any) {
      setSalesAiError(err.message || 'No se pudo guardar IA Ventas');
    } finally {
      setSavingSalesAi(false);
    }
  };

  const handleSaveTemplates = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingTemplates(true);
    setTemplateStatus(null);
    setTemplateError(null);
    try {
      await apiClient.put('/api/config/templates', {
        templateInterviewInvite: templateInterviewInvite.trim() || null,
        templateGeneralFollowup: templateGeneralFollowup.trim() || null,
        templateLanguageCode: templateLanguageCode.trim() || null,
        defaultJobTitle: defaultJobTitle.trim() || null,
        defaultInterviewDay: defaultInterviewDay.trim() || null,
        defaultInterviewTime: defaultInterviewTime.trim() || null,
        defaultInterviewLocation: defaultInterviewLocation.trim() || null,
        testPhoneNumber: testPhoneNumber.trim() || null
      });
      setTemplateStatus('Plantillas guardadas');
    } catch (err: any) {
      setTemplateError(err.message || 'No se pudieron guardar las plantillas');
    } finally {
      setSavingTemplates(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: '#f6f6f6' }}>
      <header style={{ padding: '12px 20px', borderBottom: '1px solid #ddd', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>Configuración del CRM</strong>
        <button onClick={onBack} style={{ padding: '6px 12px', borderRadius: 4, border: '1px solid #ccc' }}>
          Volver al inbox
        </button>
      </header>
      <main style={{ maxWidth: 720, margin: '32px auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
        {loading ? (
          <section style={{ background: '#fff', padding: 24, borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}>
            <p>Cargando configuración...</p>
          </section>
        ) : (
          <>
            <section style={{ background: '#fff', padding: 24, borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}>
              <h2>Cuenta admin</h2>
              <p style={{ color: '#666', marginBottom: 16 }}>Actualiza el correo y contraseña del acceso principal.</p>
              <form onSubmit={handleSaveAdmin} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label>
                  <div>Email</div>
                  <input
                    type="email"
                    value={adminEmail}
                    onChange={e => setAdminEmail(e.target.value)}
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                    required
                  />
                </label>
                <label>
                  <div>Nueva contraseña</div>
                  <input
                    type="password"
                    value={adminPassword}
                    onChange={e => setAdminPassword(e.target.value)}
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                    placeholder="Ingresa la nueva contraseña"
                    required
                  />
                </label>
                {adminStatus && <p style={{ color: 'green' }}>{adminStatus}</p>}
                {adminError && <p style={{ color: 'red' }}>{adminError}</p>}
                <button
                  type="submit"
                  disabled={savingAdmin}
                  style={{ alignSelf: 'flex-start', padding: '8px 16px', borderRadius: 6, border: 'none', background: '#111', color: '#fff' }}
                >
                  {savingAdmin ? 'Guardando...' : 'Guardar cuenta'}
                </button>
              </form>
            </section>

            <section style={{ background: '#fff', padding: 24, borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}>
              <h2>WhatsApp Cloud API</h2>
              <form onSubmit={handleSaveWhatsapp} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label>
                  <div>Base URL</div>
                  <input
                    type="text"
                    value={whatsappBaseUrl}
                    onChange={e => setWhatsappBaseUrl(e.target.value)}
                    placeholder="https://graph.facebook.com/v20.0"
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  />
                </label>
                <label>
                  <div>Phone Number ID</div>
                  <input
                    type="text"
                    value={whatsappPhoneId}
                    onChange={e => setWhatsappPhoneId(e.target.value)}
                    placeholder="1511895116748404"
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  />
                </label>
                <label>
                  <div>Access Token</div>
                  <textarea
                    value={whatsappToken}
                    onChange={e => setWhatsappToken(e.target.value)}
                    placeholder={hasToken ? 'Token ya configurado. Escribe uno nuevo para reemplazarlo.' : 'Pega el token generado en Meta.'}
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc', minHeight: 80 }}
                  />
                </label>
                <label>
                  <div>Verification Token (webhook)</div>
                  <input
                    type="text"
                    value={whatsappVerifyToken}
                    onChange={e => {
                      setWhatsappVerifyToken(e.target.value);
                      setVerifyTokenDirty(true);
                    }}
                    placeholder="Token de verificación que registrarás también en Meta"
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                    <small style={{ color: '#666' }}>
                      Token configurado: {hasVerifyToken ? 'Sí' : 'No'}
                      {hasVerifyToken ? '. Ingresa uno nuevo para reemplazarlo.' : ''}
                    </small>
                    {hasVerifyToken && (
                      <button
                        type="button"
                        onClick={() => {
                          setWhatsappVerifyToken('');
                          setVerifyTokenDirty(true);
                        }}
                        style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #ccc', background: '#f5f5f5' }}
                      >
                        Limpiar token
                      </button>
                    )}
                  </div>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={botAutoReply} onChange={e => setBotAutoReply(e.target.checked)} />
                  <span>Activar respuestas automáticas con IA</span>
                </label>
                <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, background: '#fafafa', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <div>
                      <strong>Admin configurado:</strong> {adminWaId ? 'Sí' : 'No'}
                    </div>
                    {!isEditingAdminWa && (
                      <button
                        type="button"
                        onClick={() => {
                          setIsEditingAdminWa(true);
                          setAdminWaDraft(adminWaId || '');
                        }}
                        style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid #ccc', background: '#fff' }}
                      >
                        Editar número admin
                      </button>
                    )}
                  </div>
                  {isEditingAdminWa && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <input
                        type="text"
                        value={adminWaDraft}
                        onChange={e => setAdminWaDraft(e.target.value.replace(/\D/g, ''))}
                        placeholder="56982345846"
                        style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                      />
                      <small style={{ color: '#666' }}>Usa solo dígitos, sin + ni espacios. Ese número enviará comandos (/pendientes).</small>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          type="submit"
                          style={{ padding: '6px 12px', borderRadius: 4, border: 'none', background: '#111', color: '#fff' }}
                        >
                          Guardar
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setIsEditingAdminWa(false);
                            setAdminWaDraft('');
                          }}
                          style={{ padding: '6px 12px', borderRadius: 4, border: '1px solid #ccc', background: '#fff' }}
                        >
                          Cancelar
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <small style={{ color: '#666' }}>Access token configurado: {hasToken ? 'Sí' : 'No'}</small>
                {waStatus && <p style={{ color: 'green' }}>{waStatus}</p>}
                {waError && <p style={{ color: 'red' }}>{waError}</p>}
                <button
                  type="submit"
                  disabled={savingWa}
                  style={{ alignSelf: 'flex-start', padding: '8px 16px', borderRadius: 6, border: 'none', background: '#111', color: '#fff' }}
                >
                  {savingWa ? 'Guardando...' : 'Guardar WhatsApp'}
                </button>
              </form>
            </section>

            <section style={{ background: '#fff', padding: 24, borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}>
              <h2>Números autorizados (Admin / Pruebas)</h2>
              <p style={{ color: '#666', marginBottom: 16 }}>
                Estos números controlan: (1) quién puede usar comandos/admin por WhatsApp, y (2) el allowlist de <code>/api/simulate/whatsapp</code>.
                En PROD, usa solo números autorizados (evita teléfonos sintéticos).
              </p>
              <form onSubmit={handleSaveAuthorizedNumbers} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Admin numbers</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {adminNumbers.length === 0 && <div style={{ fontSize: 12, color: '#777' }}>Agrega al menos 1 número admin.</div>}
                    {adminNumbers.map((value, idx) => (
                      <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          value={value}
                          onChange={e => {
                            const next = [...adminNumbers];
                            next[idx] = e.target.value.replace(/\D/g, '');
                            setAdminNumbers(next);
                          }}
                          placeholder={idx === 0 ? 'Admin principal (ej: 56982345846)' : 'Otro admin (ej: 56...)'}
                          style={{ flex: 1, padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                        />
                        <button
                          type="button"
                          onClick={() => setAdminNumbers(list => list.filter((_, i) => i !== idx))}
                          style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #ccc', background: '#fff' }}
                          disabled={adminNumbers.length <= 1}
                          title={adminNumbers.length <= 1 ? 'Debe existir al menos 1 admin' : 'Quitar'}
                        >
                          Quitar
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => setAdminNumbers(list => [...list, ''])}
                      style={{ alignSelf: 'flex-start', padding: '6px 10px', borderRadius: 6, border: '1px solid #111', background: '#fff' }}
                    >
                      + Agregar admin
                    </button>
                  </div>
                </div>

                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Test numbers (simulación)</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {testNumbers.length === 0 && <div style={{ fontSize: 12, color: '#777' }}>Opcional: agrega 1+ números de prueba.</div>}
                    {testNumbers.map((value, idx) => (
                      <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          value={value}
                          onChange={e => {
                            const next = [...testNumbers];
                            next[idx] = e.target.value.replace(/\D/g, '');
                            setTestNumbers(next);
                          }}
                          placeholder={idx === 0 ? 'Test (ej: 56994830202)' : 'Otro test'}
                          style={{ flex: 1, padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                        />
                        <button
                          type="button"
                          onClick={() => setTestNumbers(list => list.filter((_, i) => i !== idx))}
                          style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #ccc', background: '#fff' }}
                        >
                          Quitar
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => setTestNumbers(list => [...list, ''])}
                      style={{ alignSelf: 'flex-start', padding: '6px 10px', borderRadius: 6, border: '1px solid #111', background: '#fff' }}
                    >
                      + Agregar test
                    </button>
                  </div>
                </div>

                {numbersStatus && <p style={{ color: 'green' }}>{numbersStatus}</p>}
                {numbersError && <p style={{ color: 'red' }}>{numbersError}</p>}
                <button
                  type="submit"
                  disabled={savingNumbers}
                  style={{ alignSelf: 'flex-start', padding: '8px 16px', borderRadius: 6, border: 'none', background: '#111', color: '#fff' }}
                >
                  {savingNumbers ? 'Guardando...' : 'Guardar números autorizados'}
                </button>
                <small style={{ color: '#666' }}>Usa solo dígitos, sin + ni espacios.</small>
              </form>
            </section>

            <section style={{ background: '#fff', padding: 24, borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}>
              <h2>OpenAI</h2>
              <form onSubmit={handleSaveAi} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label>
                  <div>OpenAI API Key</div>
                  <input
                    type="text"
                    value={openAiKey}
                    onChange={e => setOpenAiKey(e.target.value)}
                    placeholder={hasOpenAiKey ? 'Key configurada. Ingresa otra para reemplazarla.' : 'sk-...'}
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  />
                </label>
                <small style={{ color: '#666' }}>Key configurada: {hasOpenAiKey ? 'Sí' : 'No'}</small>
                {aiStatus && <p style={{ color: 'green' }}>{aiStatus}</p>}
                {aiError && <p style={{ color: 'red' }}>{aiError}</p>}
                <button
                  type="submit"
                  disabled={savingAi}
                  style={{ alignSelf: 'flex-start', padding: '8px 16px', borderRadius: 6, border: 'none', background: '#111', color: '#fff' }}
                >
                  {savingAi ? 'Guardando...' : 'Guardar OpenAI'}
                </button>
              </form>
            </section>

            <section style={{ background: '#fff', padding: 24, borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}>
              <h2>IA de reclutamiento</h2>
              <form onSubmit={handleSaveAiPrompt} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label>
                  <div>Prompt personalizado</div>
                  <textarea
                    value={aiPrompt}
                    onChange={e => setAiPrompt(e.target.value)}
                    placeholder={defaultAiPrompt}
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc', minHeight: 120 }}
                  />
                </label>
                <label>
                  <div>Ficha del cargo (para responder “quiero info”)</div>
                  <textarea
                    value={recruitJobSheet}
                    onChange={e => setRecruitJobSheet(e.target.value)}
                    placeholder="Ej:\nCargo: Vendedor/a\n- Modalidad: terreno\n- Requisitos: experiencia en ventas\n- Proceso: revisamos y contactamos por WhatsApp"
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc', minHeight: 120 }}
                  />
                </label>
                <label>
                  <div>FAQ breve (opcional)</div>
                  <textarea
                    value={recruitFaq}
                    onChange={e => setRecruitFaq(e.target.value)}
                    placeholder="Ej:\n- ¿Cómo postulo?\n- ¿Qué necesito enviar?\n- ¿En cuánto responden?"
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc', minHeight: 90 }}
                  />
                </label>
                <label>
                  <div>Modelo</div>
                  <select
                    value={aiModel}
                    onChange={e => setAiModel(e.target.value)}
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  >
                    {getModelOptions(aiModel).map(model => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </label>
                <small style={{ color: '#666' }}>
                  Ajusta el tono, las instrucciones y las reglas de la IA que responde a los candidatos.
                </small>
                {aiPromptStatus && <p style={{ color: 'green' }}>{aiPromptStatus}</p>}
                {aiPromptError && <p style={{ color: 'red' }}>{aiPromptError}</p>}
                <button
                  type="submit"
                  disabled={savingAiPrompt}
                  style={{ alignSelf: 'flex-start', padding: '8px 16px', borderRadius: 6, border: 'none', background: '#111', color: '#fff' }}
                >
                  {savingAiPrompt ? 'Guardando...' : 'Guardar prompt'}
                </button>
              </form>
            </section>

            <section style={{ background: '#fff', padding: 24, borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}>
              <h2>IA Administrador</h2>
              <form onSubmit={handleSaveAdminAi} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label>
                  <div>Prompt Admin</div>
                  <textarea
                    value={adminAiPrompt}
                    onChange={e => setAdminAiPrompt(e.target.value)}
                    placeholder="Define cómo debe responder Hunter Admin."
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc', minHeight: 120 }}
                  />
                </label>
                <label>
                  <div>Modelo</div>
                  <select
                    value={adminAiModel}
                    onChange={e => setAdminAiModel(e.target.value)}
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  >
                    {getModelOptions(adminAiModel).map(model => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </label>
                {adminAiStatus && <p style={{ color: 'green' }}>{adminAiStatus}</p>}
                {adminAiError && <p style={{ color: 'red' }}>{adminAiError}</p>}
                <button
                  type="submit"
                  disabled={savingAdminAi}
                  style={{ alignSelf: 'flex-start', padding: '8px 16px', borderRadius: 6, border: 'none', background: '#111', color: '#fff' }}
                >
                  {savingAdminAi ? 'Guardando...' : 'Guardar IA Admin'}
                </button>
              </form>
            </section>

            <section style={{ background: '#fff', padding: 24, borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}>
              <h2>Notificaciones Admin</h2>
              <form onSubmit={handleSaveAdminNotifications} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label>
                  <div>Nivel de detalle</div>
                  <select
                    value={adminNotifDetailLevel}
                    onChange={e => setAdminNotifDetailLevel(e.target.value)}
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  >
                    <option value="SHORT">Corto</option>
                    <option value="MEDIUM">Medio</option>
                    <option value="DETAILED">Detallado</option>
                  </select>
                </label>
                <small style={{ color: '#666' }}>
                  Placeholders: {'{{name}}'}, {'{{phone}}'}, {'{{summary}}'}, {'{{when}}'}, {'{{interviewDay}}'}, {'{{interviewTime}}'}, {'{{interviewLocation}}'}, {'{{recommendation}}'},{' '}
                  {'{{location}}'}, {'{{rut}}'}, {'{{rutVigente}}'}, {'{{experienceYears}}'}, {'{{experienceTerrain}}'}, {'{{experienceRubros}}'}, {'{{availability}}'}, {'{{email}}'}, {'{{cv}}'}.
                </small>
                <label>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>Template RECRUIT_READY</span>
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={adminNotifEnabledEvents.includes('RECRUIT_READY')}
                        onChange={() => toggleAdminNotifEvent('RECRUIT_READY')}
                      />
                      Activo
                    </label>
                  </div>
                  <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: '#666' }}>Detalle evento</span>
                    <select
                      value={adminNotifDetailLevelsByEvent.RECRUIT_READY || ''}
                      onChange={e => setAdminNotifEventDetail('RECRUIT_READY', e.target.value)}
                      style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ccc' }}
                    >
                      <option value="">(usar global)</option>
                      <option value="SHORT">Corto</option>
                      <option value="MEDIUM">Medio</option>
                      <option value="DETAILED">Detallado</option>
                    </select>
                  </div>
                  <textarea
                    value={notifRecruitReady}
                    onChange={e => setNotifRecruitReady(e.target.value)}
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc', minHeight: 110 }}
                  />
                </label>
                <label>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>Template INTERVIEW_SCHEDULED</span>
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={adminNotifEnabledEvents.includes('INTERVIEW_SCHEDULED')}
                        onChange={() => toggleAdminNotifEvent('INTERVIEW_SCHEDULED')}
                      />
                      Activo
                    </label>
                  </div>
                  <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: '#666' }}>Detalle evento</span>
                    <select
                      value={adminNotifDetailLevelsByEvent.INTERVIEW_SCHEDULED || ''}
                      onChange={e => setAdminNotifEventDetail('INTERVIEW_SCHEDULED', e.target.value)}
                      style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ccc' }}
                    >
                      <option value="">(usar global)</option>
                      <option value="SHORT">Corto</option>
                      <option value="MEDIUM">Medio</option>
                      <option value="DETAILED">Detallado</option>
                    </select>
                  </div>
                  <textarea
                    value={notifInterviewScheduled}
                    onChange={e => setNotifInterviewScheduled(e.target.value)}
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc', minHeight: 90 }}
                  />
                </label>
                <label>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>Template INTERVIEW_CONFIRMED</span>
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={adminNotifEnabledEvents.includes('INTERVIEW_CONFIRMED')}
                        onChange={() => toggleAdminNotifEvent('INTERVIEW_CONFIRMED')}
                      />
                      Activo
                    </label>
                  </div>
                  <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: '#666' }}>Detalle evento</span>
                    <select
                      value={adminNotifDetailLevelsByEvent.INTERVIEW_CONFIRMED || ''}
                      onChange={e => setAdminNotifEventDetail('INTERVIEW_CONFIRMED', e.target.value)}
                      style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ccc' }}
                    >
                      <option value="">(usar global)</option>
                      <option value="SHORT">Corto</option>
                      <option value="MEDIUM">Medio</option>
                      <option value="DETAILED">Detallado</option>
                    </select>
                  </div>
                  <textarea
                    value={notifInterviewConfirmed}
                    onChange={e => setNotifInterviewConfirmed(e.target.value)}
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc', minHeight: 80 }}
                  />
                </label>
                <label>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>Template INTERVIEW_ON_HOLD</span>
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={adminNotifEnabledEvents.includes('INTERVIEW_ON_HOLD')}
                        onChange={() => toggleAdminNotifEvent('INTERVIEW_ON_HOLD')}
                      />
                      Activo
                    </label>
                  </div>
                  <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: '#666' }}>Detalle evento</span>
                    <select
                      value={adminNotifDetailLevelsByEvent.INTERVIEW_ON_HOLD || ''}
                      onChange={e => setAdminNotifEventDetail('INTERVIEW_ON_HOLD', e.target.value)}
                      style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ccc' }}
                    >
                      <option value="">(usar global)</option>
                      <option value="SHORT">Corto</option>
                      <option value="MEDIUM">Medio</option>
                      <option value="DETAILED">Detallado</option>
                    </select>
                  </div>
                  <textarea
                    value={notifInterviewOnHold}
                    onChange={e => setNotifInterviewOnHold(e.target.value)}
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc', minHeight: 80 }}
                  />
                </label>
                <label>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>Template SELLER_DAILY_SUMMARY</span>
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={adminNotifEnabledEvents.includes('SELLER_DAILY_SUMMARY')}
                        onChange={() => toggleAdminNotifEvent('SELLER_DAILY_SUMMARY')}
                      />
                      Activo
                    </label>
                  </div>
                  <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: '#666' }}>Detalle evento</span>
                    <select
                      value={adminNotifDetailLevelsByEvent.SELLER_DAILY_SUMMARY || ''}
                      onChange={e => setAdminNotifEventDetail('SELLER_DAILY_SUMMARY', e.target.value)}
                      style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ccc' }}
                    >
                      <option value="">(usar global)</option>
                      <option value="SHORT">Corto</option>
                      <option value="MEDIUM">Medio</option>
                      <option value="DETAILED">Detallado</option>
                    </select>
                  </div>
                  <textarea
                    value={notifSellerDailySummary}
                    onChange={e => setNotifSellerDailySummary(e.target.value)}
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc', minHeight: 110 }}
                  />
                </label>
                {adminNotifsStatus && <p style={{ color: 'green' }}>{adminNotifsStatus}</p>}
                {adminNotifsError && <p style={{ color: 'red' }}>{adminNotifsError}</p>}
                <button
                  type="submit"
                  disabled={savingAdminNotifs}
                  style={{ alignSelf: 'flex-start', padding: '8px 16px', borderRadius: 6, border: 'none', background: '#111', color: '#fff' }}
                >
                  {savingAdminNotifs ? 'Guardando...' : 'Guardar notificaciones'}
                </button>
              </form>
            </section>

            <section style={{ background: '#fff', padding: 24, borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}>
              <h2>Automations / Workflow</h2>
              <p style={{ color: '#666', marginBottom: 16 }}>
                Define etapas automáticas (sin borrar conversaciones). Las conversaciones inactivas se marcan/archivan y quedan visibles en el inbox.
              </p>
              <form onSubmit={handleSaveWorkflow} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div>Días sin respuesta → marcar “Sin respuesta”</div>
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={workflowInactivityDays}
                    onChange={e => setWorkflowInactivityDays(Number(e.target.value))}
                    style={{ width: 180, padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  />
                </label>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={workflowEnableStale}
                    onChange={e => setWorkflowEnableStale(e.target.checked)}
                  />
                  Habilitar regla “Sin respuesta”
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div>Días sin respuesta → archivar</div>
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={workflowArchiveDays}
                    onChange={e => setWorkflowArchiveDays(Number(e.target.value))}
                    style={{ width: 180, padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  />
                </label>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={workflowEnableArchive}
                    onChange={e => setWorkflowEnableArchive(e.target.checked)}
                  />
                  Habilitar regla “Archivar”
                </label>

                <details style={{ marginTop: 6 }}>
                  <summary style={{ cursor: 'pointer' }}>Ver reglas (avanzado)</summary>
                  <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', background: '#fafafa', border: '1px solid #eee', borderRadius: 8, padding: 10 }}>
                    {JSON.stringify(workflowRules, null, 2)}
                  </pre>
                </details>

                {workflowStatus && <p style={{ color: 'green' }}>{workflowStatus}</p>}
                {workflowError && <p style={{ color: 'red' }}>{workflowError}</p>}
                <button
                  type="submit"
                  disabled={savingWorkflow}
                  style={{ alignSelf: 'flex-start', padding: '8px 16px', borderRadius: 6, border: 'none', background: '#111', color: '#fff' }}
                >
                  {savingWorkflow ? 'Guardando...' : 'Guardar workflow'}
                </button>
              </form>
            </section>

            <section style={{ background: '#fff', padding: 24, borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}>
              <h2>IA Entrevistador</h2>
              <form onSubmit={handleSaveInterviewAi} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label>
                  <div>Prompt Entrevista</div>
                  <textarea
                    value={interviewAiPrompt}
                    onChange={e => setInterviewAiPrompt(e.target.value)}
                    placeholder="Define cómo debe entrevistar Hunter."
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc', minHeight: 120 }}
                  />
                </label>
                <label>
                  <div>Modelo</div>
                  <select
                    value={interviewAiModel}
                    onChange={e => setInterviewAiModel(e.target.value)}
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  >
                    {getModelOptions(interviewAiModel).map(model => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </label>
                {interviewAiStatus && <p style={{ color: 'green' }}>{interviewAiStatus}</p>}
                {interviewAiError && <p style={{ color: 'red' }}>{interviewAiError}</p>}
                <button
                  type="submit"
                  disabled={savingInterviewAi}
                  style={{ alignSelf: 'flex-start', padding: '8px 16px', borderRadius: 6, border: 'none', background: '#111', color: '#fff' }}
                >
                  {savingInterviewAi ? 'Guardando...' : 'Guardar IA Entrevista'}
                </button>
              </form>
            </section>

            <section style={{ background: '#fff', padding: 24, borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}>
              <h2>IA Ventas</h2>
              <p style={{ color: '#666', marginBottom: 16 }}>
                Configura el comportamiento del modo <strong>Ventas</strong> (prompt base + base de conocimiento).
              </p>
              <form onSubmit={handleSaveSalesAi} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label>
                  <div>Prompt base Ventas</div>
                  <textarea
                    value={salesAiPrompt}
                    onChange={e => setSalesAiPrompt(e.target.value)}
                    placeholder="Instrucciones para la IA Ventas (tono, objetivos, límites)."
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc', minHeight: 120 }}
                  />
                </label>
                <label>
                  <div>Base de conocimiento Ventas</div>
                  <textarea
                    value={salesKnowledgeBase}
                    onChange={e => setSalesKnowledgeBase(e.target.value)}
                    placeholder="Productos, packs, precios (si aplica), políticas, objeciones, guiones..."
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc', minHeight: 120 }}
                  />
                </label>
                {salesAiStatus && <p style={{ color: 'green' }}>{salesAiStatus}</p>}
                {salesAiError && <p style={{ color: 'red' }}>{salesAiError}</p>}
                <button
                  type="submit"
                  disabled={savingSalesAi}
                  style={{ alignSelf: 'flex-start', padding: '8px 16px', borderRadius: 6, border: 'none', background: '#111', color: '#fff' }}
                >
                  {savingSalesAi ? 'Guardando...' : 'Guardar IA Ventas'}
                </button>
              </form>
            </section>

            <section style={{ background: '#fff', padding: 24, borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}>
              <h2>Agenda / Disponibilidad</h2>
              <p style={{ color: '#666', marginBottom: 16 }}>
                Configura disponibilidad para evitar double-booking (sin editar JSON a mano).
              </p>
              <form onSubmit={handleSaveInterviewSchedule} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label>
                  <div>Timezone</div>
                  <input
                    type="text"
                    value={interviewTimezone}
                    onChange={e => setInterviewTimezone(e.target.value)}
                    placeholder="ej: America/Santiago"
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  />
                </label>
                <label>
                  <div>Duración slot (min)</div>
                  <input
                    type="number"
                    value={interviewSlotMinutes}
                    onChange={e => setInterviewSlotMinutes(parseInt(e.target.value, 10) || 0)}
                    min={5}
                    max={240}
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  />
                </label>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Ubicaciones</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {interviewLocationsList.length === 0 && (
                      <div style={{ fontSize: 12, color: '#777' }}>Agrega al menos 1 ubicación.</div>
                    )}
                    {interviewLocationsList.map((loc, idx) => (
                      <div key={idx} style={{ border: '1px solid #eee', borderRadius: 8, padding: 10, background: '#fafafa' }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <input
                            value={loc.label}
                            onChange={e => {
                              const next = [...interviewLocationsList];
                              next[idx] = { ...next[idx], label: e.target.value };
                              setInterviewLocationsList(next);
                            }}
                            placeholder={idx === 0 ? 'Label (antes de confirmar): Providencia (cerca de Metro Tobalaba)' : 'Label: Online'}
                            style={{ flex: 1, padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                          />
                          <button
                            type="button"
                            onClick={() => setInterviewLocationsList(list => list.filter((_, i) => i !== idx))}
                            style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #ccc', background: '#fff' }}
                          >
                            Quitar
                          </button>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                          <input
                            value={loc.exactAddress}
                            onChange={e => {
                              const next = [...interviewLocationsList];
                              next[idx] = { ...next[idx], exactAddress: e.target.value };
                              setInterviewLocationsList(next);
                            }}
                            placeholder="Dirección exacta (se envía tras confirmar): Av. ... #1234, Providencia"
                            style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                          />
                          <textarea
                            value={loc.instructions}
                            onChange={e => {
                              const next = [...interviewLocationsList];
                              next[idx] = { ...next[idx], instructions: e.target.value };
                              setInterviewLocationsList(next);
                            }}
                            placeholder="Indicaciones (opcional): piso/oficina, cómo llegar, referencia..."
                            style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc', minHeight: 56 }}
                          />
                          <div style={{ fontSize: 11, color: '#666' }}>
                            Antes de confirmar, el bot solo usa el <strong>label</strong>. Tras confirmar, envía la dirección exacta si está configurada.
                          </div>
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => setInterviewLocationsList(list => [...list, { label: '', exactAddress: '', instructions: '' }])}
                      style={{ alignSelf: 'flex-start', padding: '6px 10px', borderRadius: 6, border: '1px solid #111', background: '#fff' }}
                    >
                      + Agregar ubicación
                    </button>
                  </div>
                </div>

                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Disponibilidad semanal</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {WEEKDAYS.map(day => (
                      <div
                        key={day.key}
                        style={{ border: '1px solid #eee', borderRadius: 8, padding: 10, background: '#fafafa' }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <div style={{ fontWeight: 600 }}>{day.label}</div>
                          <button
                            type="button"
                            onClick={() =>
                              setWeeklyAvailability(prev => ({
                                ...prev,
                                [day.key]: [...(prev[day.key] || []), { start: '09:00', end: '18:00' }]
                              }))
                            }
                            style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #111', background: '#fff', fontSize: 12 }}
                          >
                            + Bloque
                          </button>
                        </div>
                        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {(weeklyAvailability[day.key] || []).length === 0 ? (
                            <div style={{ fontSize: 12, color: '#777' }}>Sin bloques.</div>
                          ) : (
                            (weeklyAvailability[day.key] || []).map((interval, idx) => (
                              <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                <input
                                  type="time"
                                  value={interval.start}
                                  onChange={e =>
                                    setWeeklyAvailability(prev => ({
                                      ...prev,
                                      [day.key]: (prev[day.key] || []).map((item, i) =>
                                        i === idx ? { ...item, start: e.target.value } : item
                                      )
                                    }))
                                  }
                                  style={{ padding: 6, borderRadius: 6, border: '1px solid #ccc' }}
                                />
                                <span style={{ fontSize: 12, color: '#666' }}>a</span>
                                <input
                                  type="time"
                                  value={interval.end}
                                  onChange={e =>
                                    setWeeklyAvailability(prev => ({
                                      ...prev,
                                      [day.key]: (prev[day.key] || []).map((item, i) =>
                                        i === idx ? { ...item, end: e.target.value } : item
                                      )
                                    }))
                                  }
                                  style={{ padding: 6, borderRadius: 6, border: '1px solid #ccc' }}
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    setWeeklyAvailability(prev => ({
                                      ...prev,
                                      [day.key]: (prev[day.key] || []).filter((_, i) => i !== idx)
                                    }))
                                  }
                                  style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                                >
                                  Quitar
                                </button>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Excepciones (días sin entrevistas)</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {exceptionDates.length === 0 && <div style={{ fontSize: 12, color: '#777' }}>Sin excepciones.</div>}
                    {exceptionDates.map((date, idx) => (
                      <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          type="date"
                          value={date}
                          onChange={e => {
                            const next = [...exceptionDates];
                            next[idx] = e.target.value;
                            setExceptionDates(next);
                          }}
                          style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                        />
                        <button
                          type="button"
                          onClick={() => setExceptionDates(list => list.filter((_, i) => i !== idx))}
                          style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #ccc', background: '#fff' }}
                        >
                          Quitar
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => setExceptionDates(list => [...list, ''])}
                      style={{ alignSelf: 'flex-start', padding: '6px 10px', borderRadius: 6, border: '1px solid #111', background: '#fff' }}
                    >
                      + Agregar excepción
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setShowAdvancedSchedule(v => !v)}
                  style={{ alignSelf: 'flex-start', padding: '6px 10px', borderRadius: 6, border: '1px solid #ccc', background: '#fff' }}
                >
                  {showAdvancedSchedule ? 'Ocultar JSON' : 'Ver JSON (avanzado)'}
                </button>
                {showAdvancedSchedule && (
                  <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 10, background: '#fafafa' }}>
                    <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Ubicaciones (JSON)</div>
                    <textarea
                      readOnly
                      value={JSON.stringify(
                        interviewLocationsList
                          .map(loc => ({
                            label: loc.label.trim().replace(/\s+/g, ' '),
                            exactAddress: loc.exactAddress.trim() || undefined,
                            instructions: loc.instructions.trim() || undefined
                          }))
                          .filter(loc => Boolean(loc.label)),
                        null,
                        2
                      )}
                      style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ddd', minHeight: 60 }}
                    />
                    <div style={{ fontSize: 12, color: '#666', marginTop: 10, marginBottom: 6 }}>Disponibilidad semanal (JSON)</div>
                    <textarea
                      readOnly
                      value={JSON.stringify(weeklyAvailability, null, 2)}
                      style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ddd', minHeight: 120 }}
                    />
                    <div style={{ fontSize: 12, color: '#666', marginTop: 10, marginBottom: 6 }}>Excepciones (JSON)</div>
                    <textarea
                      readOnly
                      value={JSON.stringify(exceptionDates.map(v => v.trim()).filter(Boolean), null, 2)}
                      style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ddd', minHeight: 60 }}
                    />
                  </div>
                )}
                {scheduleStatus && <p style={{ color: 'green' }}>{scheduleStatus}</p>}
                {scheduleError && <p style={{ color: 'red' }}>{scheduleError}</p>}
                <button
                  type="submit"
                  disabled={savingSchedule}
                  style={{ alignSelf: 'flex-start', padding: '8px 16px', borderRadius: 6, border: 'none', background: '#111', color: '#fff' }}
                >
                  {savingSchedule ? 'Guardando...' : 'Guardar disponibilidad'}
                </button>
              </form>
            </section>

            <section style={{ background: '#fff', padding: 24, borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}>
              <h2>Plantillas WhatsApp</h2>
              <form onSubmit={handleSaveTemplates} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label>
                  <div>templateConfirmacionEntrevistaName (nombre aprobado)</div>
                  <input
                    type="text"
                    value={templateInterviewInvite}
                    onChange={e => setTemplateInterviewInvite(e.target.value)}
                    placeholder="ej: enviorapido_confirma_entrevista_v1"
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  />
                </label>
                <label>
                  <div>templatePrimerContactoName (nombre aprobado)</div>
                  <input
                    type="text"
                    value={templateGeneralFollowup}
                    onChange={e => setTemplateGeneralFollowup(e.target.value)}
                    placeholder="ej: enviorapido_postulacion_inicio_v1"
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  />
                </label>
                <div style={{ fontSize: 12, color: '#666' }}>
                  Estos templates se usan automáticamente cuando un mensaje cae fuera de ventana 24h.
                </div>
                <label>
                  <div>Idioma plantilla (language code)</div>
                  <input
                    type="text"
                    value={templateLanguageCode}
                    onChange={e => setTemplateLanguageCode(e.target.value)}
                    placeholder="ej: es_CL"
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  />
                </label>
                <label>
                  <div>{'Default título de vacante ({{1}} seguimiento)'}</div>
                  <input
                    type="text"
                    value={defaultJobTitle}
                    onChange={e => setDefaultJobTitle(e.target.value)}
                    placeholder="ej: Ejecutivo/a de ventas"
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  />
                </label>
                <label>
                  <div>{'Default día entrevista ({{1}} entrevista_confirmacion_1)'}</div>
                  <input
                    type="text"
                    value={defaultInterviewDay}
                    onChange={e => setDefaultInterviewDay(e.target.value)}
                    placeholder="ej: Lunes"
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  />
                </label>
                <label>
                  <div>{'Default hora entrevista ({{2}} entrevista_confirmacion_1)'}</div>
                  <input
                    type="text"
                    value={defaultInterviewTime}
                    onChange={e => setDefaultInterviewTime(e.target.value)}
                    placeholder="ej: 10:00"
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  />
                </label>
                <label>
                  <div>{'Default lugar entrevista ({{3}} entrevista_confirmacion_1)'}</div>
                  <input
                    type="text"
                    value={defaultInterviewLocation}
                    onChange={e => setDefaultInterviewLocation(e.target.value)}
                    placeholder="ej: Online/Oficina"
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  />
                </label>
                <label>
                  <div>Número de pruebas (E.164)</div>
                  <input
                    type="text"
                    value={testPhoneNumber}
                    onChange={e => setTestPhoneNumber(e.target.value)}
                    placeholder="ej: 569XXXXXXXX"
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  />
                </label>
                <button
                  type="button"
                  onClick={handleResetTestConversation}
                  disabled={resetting}
                  style={{ alignSelf: 'flex-start', padding: '8px 12px', borderRadius: 6, border: '1px solid #111', background: '#fff' }}
                >
                  {resetting ? 'Reiniciando...' : 'Reiniciar conversación de prueba (archivar)'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCleanupPanelOpen(value => !value);
                    setCleanupConfirmText('');
                    setCleanupError(null);
                    setCleanupStatus(null);
                    setCleanupResult(null);
                  }}
                  disabled={cleaning}
                  style={{ alignSelf: 'flex-start', padding: '8px 12px', borderRadius: 6, border: '1px solid #ff4d4f', background: '#fff' }}
                >
                  {cleaning ? 'Limpiando...' : 'Limpiar datos de prueba'}
                </button>
                {cleanupPanelOpen && (
                  <div style={{ border: '1px solid #ffe58f', borderRadius: 8, padding: 10, background: '#fffbe6', maxWidth: 520 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Acción de limpieza (solo pruebas)</div>
                    <div style={{ fontSize: 12, color: '#664d03', marginBottom: 8 }}>
                      Esto archiva conversaciones de <strong>testPhoneNumber</strong> y corrige duplicados del <strong>adminWaId</strong>. No toca números reales ni borra historial.
                    </div>
                    <div style={{ fontSize: 12, color: '#333', marginBottom: 6 }}>
                      Para confirmar, escribe <strong>LIMPIAR</strong> o el número de pruebas.
                    </div>
                    <input
                      value={cleanupConfirmText}
                      onChange={e => setCleanupConfirmText(e.target.value)}
                      placeholder="LIMPIAR o 569XXXXXXXX"
                      style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #d9d9d9' }}
                    />
                    <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        onClick={handleCleanupTestData}
                        disabled={cleaning}
                        style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #ff4d4f', background: '#ff4d4f', color: '#fff' }}
                      >
                        {cleaning ? 'Limpiando...' : 'Confirmar limpieza'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setCleanupPanelOpen(false);
                          setCleanupConfirmText('');
                        }}
                        disabled={cleaning}
                        style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #ccc', background: '#fff' }}
                      >
                        Cancelar
                      </button>
                    </div>
                    {cleanupError && <div style={{ marginTop: 8, fontSize: 12, color: '#b93800' }}>{cleanupError}</div>}
                  </div>
                )}
                {resetStatus && <p style={{ color: 'green' }}>{resetStatus}</p>}
                {resetError && <p style={{ color: 'red' }}>{resetError}</p>}
                {cleanupStatus && <p style={{ color: 'green' }}>{cleanupStatus}</p>}
                {cleanupResult && (
                  <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', background: '#fafafa', border: '1px solid #eee', borderRadius: 8, padding: 10 }}>
                    {JSON.stringify(cleanupResult, null, 2)}
                  </pre>
                )}
                {templateStatus && <p style={{ color: 'green' }}>{templateStatus}</p>}
                {templateError && <p style={{ color: 'red' }}>{templateError}</p>}
                <button
                  type="submit"
                  disabled={savingTemplates}
                  style={{ alignSelf: 'flex-start', padding: '8px 16px', borderRadius: 6, border: 'none', background: '#111', color: '#fff' }}
                >
                  {savingTemplates ? 'Guardando...' : 'Guardar plantillas'}
                </button>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    disabled={sendingTest}
                    onClick={async () => {
                      setTestSendStatus(null);
                      setTestSendError(null);
                      setSendingTest(true);
                      try {
                        await apiClient.post('/api/config/templates/test-send', {});
                        setTestSendStatus('Enviado test al número configurado');
                      } catch (err: any) {
                        setTestSendError(err.message || 'No se pudo enviar el test');
                      } finally {
                        setSendingTest(false);
                      }
                    }}
                    style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #111', background: '#fff' }}
                  >
                    {sendingTest ? 'Enviando prueba...' : 'Enviar mensaje de prueba'}
                  </button>
                  {testSendStatus && <span style={{ color: 'green' }}>{testSendStatus}</span>}
                  {testSendError && <span style={{ color: 'red' }}>{testSendError}</span>}
                </div>
              </form>
            </section>
          </>
        )}
      </main>
    </div>
  );
};

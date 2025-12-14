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
  const getModelOptions = (current: string) => {
    const base = ['gpt-4.1-mini', 'gpt-5-chat-latest'];
    return base.includes(current) ? base : [...base, current];
  };

  useEffect(() => {
    const loadAll = async () => {
      setLoading(true);
      try {
        const [wa, ai, admin, aiPromptRes, adminAi, interviewAi, templates] = await Promise.all([
          apiClient.get('/api/config/whatsapp') as Promise<WhatsappConfigResponse>,
          apiClient.get('/api/config/ai') as Promise<AiConfigResponse>,
          apiClient.get('/api/config/admin-account') as Promise<AdminAccountResponse>,
          apiClient.get('/api/config/ai-prompt') as Promise<AiPromptResponse>,
          apiClient.get('/api/config/admin-ai') as Promise<AdminAiConfigResponse>,
          apiClient.get('/api/config/interview-ai') as Promise<InterviewAiConfigResponse>,
          apiClient.get('/api/config/templates') as Promise<TemplatesConfigResponse>
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
        setAdminAiPrompt(adminAi.prompt || '');
        setAdminAiModel(adminAi.model || 'gpt-4.1-mini');
        setInterviewAiPrompt(interviewAi.prompt || '');
        setInterviewAiModel(interviewAi.model || 'gpt-4.1-mini');
        setTemplateInterviewInvite(templates.templateInterviewInvite || '');
        setTemplateGeneralFollowup(templates.templateGeneralFollowup || '');
        setTemplateLanguageCode(templates.templateLanguageCode || 'es_CL');
        setDefaultJobTitle(templates.defaultJobTitle || 'Vendedor/a');
        setDefaultInterviewDay(templates.defaultInterviewDay || 'Lunes');
        setDefaultInterviewTime(templates.defaultInterviewTime || '10:00');
        setDefaultInterviewLocation(templates.defaultInterviewLocation || 'Online');
        setTestPhoneNumber(templates.testPhoneNumber || '');
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
        aiModel
      })) as AiPromptResponse;
      setAiPrompt(res.aiPrompt);
      if (res.aiModel) {
        setAiModel(res.aiModel);
      }
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
    if (!window.confirm('¿Seguro que quieres borrar la conversación del número de pruebas?')) {
      return;
    }
    setResetting(true);
    setResetStatus(null);
    setResetError(null);
    try {
      const res = (await apiClient.post('/api/config/reset-test-conversation', {})) as any;
      setResetStatus(res?.message || 'Conversación de prueba reseteada.');
    } catch (err: any) {
      setResetError(err.message || 'No se pudo resetear la conversación de prueba');
    } finally {
      setResetting(false);
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
              <h2>Plantillas WhatsApp</h2>
              <form onSubmit={handleSaveTemplates} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label>
                  <div>Template entrevista (nombre aprobado)</div>
                  <input
                    type="text"
                    value={templateInterviewInvite}
                    onChange={e => setTemplateInterviewInvite(e.target.value)}
                    placeholder="ej: entrevista_confirmacion_1"
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  />
                </label>
                <label>
                  <div>Template seguimiento general</div>
                  <input
                    type="text"
                    value={templateGeneralFollowup}
                    onChange={e => setTemplateGeneralFollowup(e.target.value)}
                    placeholder="ej: postulacion_completar_1"
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  />
                </label>
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
                  {resetting ? 'Reseteando...' : 'Reset conversación de prueba'}
                </button>
                {resetStatus && <p style={{ color: 'green' }}>{resetStatus}</p>}
                {resetError && <p style={{ color: 'red' }}>{resetError}</p>}
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

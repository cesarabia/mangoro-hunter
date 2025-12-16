import React, { useEffect, useRef, useState } from 'react';
import { apiClient } from '../api/client';

interface ConversationViewProps {
  conversation: any | null;
  onMessageSent: () => void;
  programs?: any[];
  onReplayInSimulator?: (conversationId: string) => void;
}

const safeParseJson = (value: any) => {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const toDate = (value: any): Date | null => {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const formatMessageTime = (value: any) => {
  const date = toDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat('es-CL', { hour: '2-digit', minute: '2-digit' }).format(date);
};

const formatMessageDayKey = (value: any) => {
  const date = toDate(value);
  if (!date) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const formatMessageDayLabel = (value: any) => {
  const date = toDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat('es-CL', {
    weekday: 'long',
    year: 'numeric',
    month: 'short',
    day: '2-digit'
  }).format(date);
};

const formatFullTimestamp = (value: any) => {
  const date = toDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat('es-CL', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
};

const isSuspiciousCandidateName = (value?: string | null) => {
  if (!value) return true;
  const lower = value.toLowerCase();
  const patterns = [
    'hola quiero postular',
    'quiero postular',
    'postular',
    'hola',
    'buenas',
    'no puedo',
    'no me sirve',
    'confirmo',
    'medio dia',
    'mediodia',
    'confirmar',
    'inmediata',
    'inmediato',
    'gracias'
  ];
  if (patterns.some(p => lower.includes(p))) return true;
  if (/\b(cancelar|cancelaci[oó]n|reagend|reprogram|cambiar|modificar|mover)\b/i.test(lower)) return true;
  if (/\b(resumen|reporte|generar|genera|registro|registrar|visita|venta|pitch|onboarding)\b/i.test(lower)) return true;
  if (/\b(cv|cb|curric|curr[íi]cul|vitae|adjunt|archivo|documento|imagen|foto|pdf|word|docx)\b/i.test(lower)) return true;
  if (/\b(tengo|adjunto|envio|envi[ée]|enviar|mando|mand[ée]|subo)\b/i.test(lower)) return true;
  if (/(lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)/i.test(value)) return true;
  if (/medio ?d[ií]a/i.test(value)) return true;
  return false;
};

export const ConversationView: React.FC<ConversationViewProps> = ({
  conversation,
  onMessageSent,
  programs,
  onReplayInSimulator
}) => {
  const [text, setText] = useState('');
  const [loadingSend, setLoadingSend] = useState(false);
  const [loadingAi, setLoadingAi] = useState(false);
  const [modeSaving, setModeSaving] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [templateSending, setTemplateSending] = useState(false);
  const [templateVariables, setTemplateVariables] = useState<string[]>([]);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const previousCountRef = useRef(0);
  const [aiPausedSaving, setAiPausedSaving] = useState(false);
  const [interviewDay, setInterviewDay] = useState('');
  const [interviewTime, setInterviewTime] = useState('');
  const [interviewLocation, setInterviewLocation] = useState('');
  const [interviewStatus, setInterviewStatus] = useState('');
  const [interviewSaving, setInterviewSaving] = useState(false);
  const [noContactPanelOpen, setNoContactPanelOpen] = useState(false);
  const [noContactReasonDraft, setNoContactReasonDraft] = useState('');
  const [noContactSaving, setNoContactSaving] = useState(false);
  const [noContactError, setNoContactError] = useState<string | null>(null);
  const [namePanelOpen, setNamePanelOpen] = useState(false);
  const [manualNameDraft, setManualNameDraft] = useState('');
  const [nameSaving, setNameSaving] = useState(false);
  const [nameStatus, setNameStatus] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [programId, setProgramId] = useState<string>('');
  const [programSaving, setProgramSaving] = useState(false);
  const [programError, setProgramError] = useState<string | null>(null);

  useEffect(() => {
    if (!conversation) {
      setSendError(null);
      setModeSaving(false);
      setTemplateVariables([]);
      setDownloadError(null);
      setInterviewDay('');
      setInterviewTime('');
      setInterviewLocation('');
      setInterviewStatus('');
      setNoContactPanelOpen(false);
      setNoContactReasonDraft('');
      setNoContactSaving(false);
      setNoContactError(null);
      setNamePanelOpen(false);
      setManualNameDraft('');
      setNameSaving(false);
      setNameStatus(null);
      setNameError(null);
      setProgramId('');
      setProgramSaving(false);
      setProgramError(null);
      return;
    }
    setAutoScrollEnabled(true);
    scrollToBottom();
    previousCountRef.current = conversation.messages?.length ?? 0;
    setModeSaving(false);
    setSendError(null);
    setDownloadError(null);
    setInterviewDay(conversation.interviewDay || '');
    setInterviewTime(conversation.interviewTime || '');
    setInterviewLocation(conversation.interviewLocation || '');
    setInterviewStatus(conversation.interviewStatus || '');
    setNoContactPanelOpen(false);
    setNoContactReasonDraft('');
    setNoContactSaving(false);
    setNoContactError(null);
    setNamePanelOpen(false);
    setManualNameDraft(conversation.contact?.candidateNameManual || '');
    setNameSaving(false);
    setNameStatus(null);
    setNameError(null);
    setProgramId(conversation.program?.id || conversation.programId || '');
    setProgramSaving(false);
    setProgramError(null);
  }, [conversation?.id]);

  useEffect(() => {
    if (!conversation) return;
    const currentCount = conversation.messages?.length ?? 0;
    if (autoScrollEnabled || previousCountRef.current === 0) {
      scrollToBottom();
    }
    previousCountRef.current = currentCount;
  }, [conversation, conversation?.messages?.length, autoScrollEnabled]);

  const scrollToBottom = () => {
    const container = messagesRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  };

  const handleScroll = () => {
    const container = messagesRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - (container.scrollTop + container.clientHeight);
    setAutoScrollEnabled(distanceFromBottom <= 120);
  };

  const handleSend = async () => {
    if (!conversation || !text.trim()) return;
    setLoadingSend(true);
    try {
      const result = await apiClient.post(`/api/conversations/${conversation.id}/messages`, { text });
      if (result?.sendResult && !result.sendResult.success) {
        alert(
          `Mensaje guardado, pero el envío a WhatsApp falló: ${
            result.sendResult.error || 'Error desconocido'
          }`
        );
      }
      setText('');
      onMessageSent();
      setSendError(null);
    } catch (err: any) {
      setSendError(err.message || 'No se pudo enviar el mensaje');
    } finally {
      setLoadingSend(false);
    }
  };

  const handleProgramUpdate = async (nextProgramId: string) => {
    if (!conversation || programSaving) return;
    setProgramSaving(true);
    setProgramError(null);
    try {
      await apiClient.patch(`/api/conversations/${conversation.id}/program`, {
        programId: nextProgramId || null
      });
      setProgramId(nextProgramId);
      onMessageSent();
    } catch (err: any) {
      setProgramError(err.message || 'No se pudo actualizar el Program');
    } finally {
      setProgramSaving(false);
    }
  };

  const handleSetNoContact = async () => {
    if (!conversation || noContactSaving) return;
    const reason = noContactReasonDraft.trim();
    if (reason.length < 3) {
      setNoContactError('Ingresa un motivo (mínimo 3 caracteres).');
      return;
    }
    const ok = window.confirm(`¿Confirmas marcar NO_CONTACTAR a ${primaryName}?`);
    if (!ok) return;
    setNoContactSaving(true);
    setNoContactError(null);
    try {
      await apiClient.patch(`/api/conversations/${conversation.id}/no-contact`, {
        noContact: true,
        reason
      });
      setNoContactPanelOpen(false);
      setNoContactReasonDraft('');
      onMessageSent();
    } catch (err: any) {
      setNoContactError(err.message || 'No se pudo marcar NO_CONTACTAR');
    } finally {
      setNoContactSaving(false);
    }
  };

  const handleReactivateContact = async () => {
    if (!conversation || noContactSaving) return;
    const ok = window.confirm(`¿Confirmas reactivar el contacto ${primaryName}?`);
    if (!ok) return;
    setNoContactSaving(true);
    setNoContactError(null);
    try {
      await apiClient.patch(`/api/conversations/${conversation.id}/no-contact`, { noContact: false });
      setNoContactPanelOpen(false);
      setNoContactReasonDraft('');
      onMessageSent();
    } catch (err: any) {
      setNoContactError(err.message || 'No se pudo reactivar el contacto');
    } finally {
      setNoContactSaving(false);
    }
  };

  const handleSaveManualName = async () => {
    if (!conversation || isAdmin || nameSaving) return;
    setNameSaving(true);
    setNameStatus(null);
    setNameError(null);
    try {
      const next = manualNameDraft.trim();
      await apiClient.patch(`/api/conversations/${conversation.id}/contact-name`, {
        manualName: next.length > 0 ? next : null
      });
      setNamePanelOpen(false);
      setNameStatus('Nombre guardado');
      onMessageSent();
    } catch (err: any) {
      setNameError(err.message || 'No se pudo guardar el nombre');
    } finally {
      setNameSaving(false);
    }
  };

  const handleClearManualName = async () => {
    if (!conversation || isAdmin || nameSaving) return;
    const ok = window.confirm('¿Eliminar el nombre manual y volver al nombre detectado?');
    if (!ok) return;
    setNameSaving(true);
    setNameStatus(null);
    setNameError(null);
    try {
      await apiClient.patch(`/api/conversations/${conversation.id}/contact-name`, {
        manualName: null
      });
      setManualNameDraft('');
      setNamePanelOpen(false);
      setNameStatus('Nombre manual eliminado');
      onMessageSent();
    } catch (err: any) {
      setNameError(err.message || 'No se pudo eliminar el nombre manual');
    } finally {
      setNameSaving(false);
    }
  };

  const handleModeChange = async (mode: 'RECRUIT' | 'INTERVIEW' | 'SELLER' | 'OFF') => {
    if (!conversation || conversation.aiMode === mode || modeSaving) return;
    setModeSaving(true);
    try {
      await apiClient.patch(`/api/conversations/${conversation.id}/ai-mode`, { mode });
      onMessageSent();
    } catch (err) {
      console.error(err);
    } finally {
      setModeSaving(false);
    }
  };

  const handleAiPauseToggle = async () => {
    if (!conversation) return;
    setAiPausedSaving(true);
    try {
      await apiClient.patch(`/api/conversations/${conversation.id}/ai-settings`, {
        aiPaused: !aiPaused
      });
      onMessageSent();
    } catch (err) {
      console.error(err);
    } finally {
      setAiPausedSaving(false);
    }
  };

  const handleInterviewSave = async () => {
    if (!conversation) return;
    setInterviewSaving(true);
    try {
      await apiClient.patch(`/api/conversations/${conversation.id}/interview`, {
        interviewDay,
        interviewTime,
        interviewLocation,
        interviewStatus
      });
      onMessageSent();
    } catch (err) {
      console.error(err);
    } finally {
      setInterviewSaving(false);
    }
  };

  const handleSuggest = async () => {
    if (!conversation) return;
    setLoadingAi(true);
    setSendError(null);
    try {
      const res = await apiClient.post(`/api/conversations/${conversation.id}/ai-suggest`, { draft: text });
      if (res.suggestion) {
        setText(res.suggestion);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudo sugerir';
      setSendError(message);
    } finally {
      setLoadingAi(false);
    }
  };

  const hasConversation = Boolean(conversation);
  const isAdmin = Boolean(conversation?.isAdmin);
  const waId = conversation?.contact?.waId || conversation?.contact?.phone || '';
  const manualName = !isAdmin ? (conversation?.contact?.candidateNameManual || '').trim() : '';
  const candidateRaw = conversation?.contact?.candidateName || null;
  const candidateNameDetected =
    !isAdmin && candidateRaw && !isSuspiciousCandidateName(candidateRaw) ? candidateRaw : null;
  const profileDisplay = conversation?.contact?.displayName || conversation?.contact?.name || '';
  const primaryName = isAdmin
    ? 'Administrador'
    : manualName || candidateNameDetected || profileDisplay || (waId ? `+${waId}` : '') || 'Sin nombre';
  const noContact = Boolean(conversation?.contact?.noContact);
  const noContactAt = conversation?.contact?.noContactAt || null;
  const noContactReason = conversation?.contact?.noContactReason || null;
  const noContactAtLabel = noContactAt ? formatFullTimestamp(noContactAt) : '';
  const secondaryLabel = [profileDisplay, waId ? `+${waId}` : ''].filter(Boolean).join(' · ');
  const aiMode: 'RECRUIT' | 'INTERVIEW' | 'SELLER' | 'OFF' = conversation?.aiMode || 'RECRUIT';
  const aiPaused = Boolean(conversation?.aiPaused);
  const isManualMode = aiMode === 'OFF' || aiPaused;
  const within24h = conversation?.within24h !== false;
  const templateConfig = conversation?.templates || {};
  const templateInterviewInvite = templateConfig.templateInterviewInvite || null;
  const templateGeneralFollowup = templateConfig.templateGeneralFollowup || null;
  const requiredTemplate =
    aiMode === 'INTERVIEW' ? templateInterviewInvite : templateGeneralFollowup;
  const requiredTemplateLabel =
    aiMode === 'INTERVIEW' ? 'entrevista' : 'seguimiento';
  const templateVariableCount =
    requiredTemplate === 'postulacion_completar_1'
      ? 1
      : requiredTemplate === 'entrevista_confirmacion_1'
      ? 3
      : 0;
  const modeOptions: Array<{ key: 'RECRUIT' | 'INTERVIEW' | 'SELLER' | 'OFF'; label: string }> = [
    { key: 'RECRUIT', label: 'Reclutamiento' },
    { key: 'INTERVIEW', label: 'Entrevista' },
    { key: 'SELLER', label: 'Ventas' },
    { key: 'OFF', label: 'Manual' }
  ];
  const programOptions = Array.isArray(programs) ? programs : [];

  useEffect(() => {
    if (!conversation) {
      setTemplateVariables([]);
      return;
    }
    if (!requiredTemplate || templateVariableCount === 0) {
      setTemplateVariables([]);
      return;
    }
    if (requiredTemplate === 'postulacion_completar_1') {
      setTemplateVariables([templateConfig.defaultJobTitle || '']);
      return;
    }
    if (requiredTemplate === 'entrevista_confirmacion_1') {
      setTemplateVariables([
        conversation?.interviewDay || templateConfig.defaultInterviewDay || '',
        conversation?.interviewTime || templateConfig.defaultInterviewTime || '',
        conversation?.interviewLocation || templateConfig.defaultInterviewLocation || ''
      ]);
      return;
    }
    setTemplateVariables(Array.from({ length: templateVariableCount }, () => ''));
  }, [
    conversation?.id,
    requiredTemplate,
    templateVariableCount,
    templateConfig.defaultJobTitle,
    templateConfig.defaultInterviewDay,
    templateConfig.defaultInterviewTime,
    templateConfig.defaultInterviewLocation,
    conversation?.interviewDay,
    conversation?.interviewTime,
    conversation?.interviewLocation
  ]);

  const handleSendTemplate = async () => {
    if (!conversation || !requiredTemplate) return;
    setTemplateSending(true);
    setSendError(null);
    try {
      await apiClient.post(`/api/conversations/${conversation.id}/send-template`, {
        templateName: requiredTemplate,
        variables: templateVariables.map(value => value.trim())
      });
      onMessageSent();
    } catch (err: any) {
      setSendError(err.message || 'No se pudo enviar la plantilla');
    } finally {
      setTemplateSending(false);
    }
  };

  const templateVariablesReady =
    templateVariableCount === 0 || templateVariables.every(value => value.trim().length > 0);

  const describeMedia = (message: any) => {
    if (!message?.mediaType) return null;
    if (message.mediaType === 'audio' || message.mediaType === 'voice') return 'Audio';
    if (message.mediaType === 'image') return 'Imagen';
    if (message.mediaType === 'document') return message.mediaMime?.includes('pdf') ? 'PDF' : 'Documento';
    if (message.mediaType === 'sticker') return 'Sticker';
    return 'Adjunto';
  };

  const handleDownload = async (message: any) => {
    if (!message?.id) return;
    setDownloadError(null);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/messages/${message.id}/download`, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      });
      if (!res.ok) {
        throw new Error('No se pudo descargar el archivo');
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const filename = (message.mediaPath && message.mediaPath.split('/').pop()) || 'archivo';
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      setDownloadError(err.message || 'No se pudo descargar el adjunto');
    }
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #eee', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {isAdmin ? (
                <span>{primaryName}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setNamePanelOpen(value => !value);
                    setNameStatus(null);
                    setNameError(null);
                    setManualNameDraft(conversation?.contact?.candidateNameManual || '');
                  }}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    padding: 0,
                    cursor: 'pointer',
                    fontSize: 18,
                    fontWeight: 700
                  }}
                  title="Editar nombre visible"
                >
                  {primaryName}
                  {manualName ? (
                    <span style={{ marginLeft: 6, fontSize: 12, color: '#666' }} title="Nombre manual (override)">
                      ✏️
                    </span>
                  ) : null}
                </button>
              )}
            </div>
            {secondaryLabel && <div style={{ fontSize: 12, color: '#666' }}>{secondaryLabel}</div>}
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: '#555' }}>
                Estado: <strong>{conversation?.status || 'NEW'}</strong>
              </span>
              <span style={{ fontSize: 12, color: '#555' }}>
                Stage: <strong>{conversation?.conversationStage || conversation?.stage || '—'}</strong>
              </span>
              <span style={{ fontSize: 12, color: '#555' }}>
                PhoneLine: <strong>{conversation?.phoneLine?.alias || conversation?.phoneLineId || '—'}</strong>
              </span>
              <span style={{ fontSize: 12, color: '#555' }}>
                Ventana WhatsApp:{' '}
                <strong>{conversation?.within24h === false ? 'OUTSIDE_24H' : 'IN_24H'}</strong>
              </span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#555' }}>
                Program:
                <select
                  value={programId}
                  onChange={(e) => {
                    const next = e.target.value;
                    setProgramId(next);
                    handleProgramUpdate(next);
                  }}
                  disabled={programSaving}
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ccc' }}
                >
                  <option value="">—</option>
                  {programOptions.map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              {onReplayInSimulator && !isAdmin ? (
                <button
                  type="button"
                  onClick={() => onReplayInSimulator(conversation.id)}
                  style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #ccc', background: '#fff', cursor: 'pointer' }}
                >
                  Abrir en Simulador (Replay)
                </button>
              ) : null}
              {programError ? <span style={{ fontSize: 12, color: '#b93800' }}>{programError}</span> : null}
            </div>
            {!isAdmin && namePanelOpen && (
              <div style={{ marginTop: 10, border: '1px solid #eee', borderRadius: 8, padding: 10, background: '#fafafa', maxWidth: 520 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Nombre visible (manual)</div>
                <input
                  value={manualNameDraft}
                  onChange={e => setManualNameDraft(e.target.value)}
                  placeholder="Ej: Ignacio González"
                  style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #ddd', fontSize: 13 }}
                />
                <div style={{ marginTop: 6, fontSize: 12, color: '#666' }}>
                  Detectado:{' '}
                  <strong>
                    {candidateNameDetected || profileDisplay || (waId ? `+${waId}` : 'Sin nombre')}
                  </strong>
                </div>
                <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={handleSaveManualName}
                    disabled={nameSaving}
                    style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff', fontSize: 12 }}
                  >
                    {nameSaving ? 'Guardando…' : 'Guardar'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setNamePanelOpen(false)}
                    disabled={nameSaving}
                    style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                  >
                    Cancelar
                  </button>
                  {manualName ? (
                    <button
                      type="button"
                      onClick={handleClearManualName}
                      disabled={nameSaving}
                      style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                    >
                      Limpiar override
                    </button>
                  ) : null}
                </div>
                {nameStatus && <div style={{ marginTop: 6, fontSize: 12, color: 'green' }}>{nameStatus}</div>}
                {nameError && <div style={{ marginTop: 6, fontSize: 12, color: '#b93800' }}>{nameError}</div>}
              </div>
            )}
            {noContact ? (
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 11, color: '#a8071a', background: '#fff1f0', border: '1px solid #ff7875', borderRadius: 8, padding: '6px 8px', display: 'inline-block', maxWidth: 520 }}>
                  <div style={{ fontWeight: 700, marginBottom: 2 }}>NO CONTACTAR</div>
                  <div style={{ color: '#a8071a' }}>
                    {noContactAt ? (
                      <span title={noContactAtLabel}>Activado: {formatMessageTime(noContactAt)}</span>
                    ) : (
                      <span>Activado: (sin timestamp)</span>
                    )}
                    {noContactReason ? ` · Motivo: ${noContactReason}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    onClick={handleReactivateContact}
                    disabled={noContactSaving}
                    style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #111', background: '#fff', fontSize: 12 }}
                  >
                    {noContactSaving ? 'Procesando…' : 'Reactivar contacto'}
                  </button>
                </div>
                {noContactError && <div style={{ fontSize: 12, color: '#b93800' }}>{noContactError}</div>}
              </div>
            ) : (
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    onClick={() => {
                      setNoContactPanelOpen(value => !value);
                      setNoContactError(null);
                    }}
                    disabled={noContactSaving}
                    style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                  >
                    Marcar NO_CONTACTAR
                  </button>
                </div>
                {noContactPanelOpen && (
                  <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 10, background: '#fafafa', maxWidth: 520 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Motivo (visible en CRM)</div>
                    <textarea
                      value={noContactReasonDraft}
                      onChange={e => setNoContactReasonDraft(e.target.value)}
                      rows={2}
                      style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #ddd', fontSize: 13, resize: 'vertical' }}
                      placeholder="Ej: solicitó no recibir mensajes / contacto erróneo / spam…"
                    />
                    <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        onClick={handleSetNoContact}
                        disabled={noContactSaving}
                        style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff', fontSize: 12 }}
                      >
                        {noContactSaving ? 'Procesando…' : 'Confirmar NO_CONTACTAR'}
                      </button>
                      <button
                        onClick={() => {
                          setNoContactPanelOpen(false);
                          setNoContactReasonDraft('');
                          setNoContactError(null);
                        }}
                        disabled={noContactSaving}
                        style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                      >
                        Cancelar
                      </button>
                    </div>
                    {noContactError && <div style={{ marginTop: 6, fontSize: 12, color: '#b93800' }}>{noContactError}</div>}
                  </div>
                )}
              </div>
            )}
          </div>
          {hasConversation && !isAdmin && (
            <button
              onClick={handleAiPauseToggle}
              disabled={aiPausedSaving}
              style={{
                padding: '6px 10px',
                borderRadius: 8,
                border: '1px solid #ccc',
                background: aiPaused ? '#ffe8cc' : '#f6f6f6',
                fontSize: 12
              }}
            >
              {aiPaused ? 'Silencio activado' : 'Silenciar IA'}
            </button>
          )}
        </div>
        {hasConversation && !isAdmin && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 13, marginBottom: 4 }}>Modo del candidato:</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {modeOptions.map(option => (
                <button
                  key={option.key}
                  onClick={() => handleModeChange(option.key)}
                  disabled={modeSaving || aiMode === option.key}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 999,
                    border: aiMode === option.key ? '1px solid #111' : '1px solid #ccc',
                    background: aiMode === option.key ? '#111' : '#fff',
                    color: aiMode === option.key ? '#fff' : '#333',
                    cursor: modeSaving ? 'not-allowed' : 'pointer',
                    fontSize: 12
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {aiMode === 'INTERVIEW' && (
              <div style={{ marginTop: 10, padding: 10, border: '1px solid #eee', borderRadius: 8, background: '#fafafa', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Entrevista</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <input
                    value={interviewDay}
                    onChange={e => setInterviewDay(e.target.value)}
                    placeholder="Día (ej: Lunes)"
                    style={{ flex: '1 1 140px', minWidth: 140, padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  />
                  <input
                    value={interviewTime}
                    onChange={e => setInterviewTime(e.target.value)}
                    placeholder="Hora (ej: 10:00)"
                    style={{ flex: '1 1 120px', minWidth: 120, padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  />
                  <input
                    value={interviewLocation}
                    onChange={e => setInterviewLocation(e.target.value)}
                    placeholder="Lugar (ej: Online)"
                    style={{ flex: '2 1 200px', minWidth: 160, padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  />
                  <select
                    value={interviewStatus}
                    onChange={e => setInterviewStatus(e.target.value)}
                    style={{ flex: '1 1 160px', minWidth: 140, padding: 8, borderRadius: 6, border: '1px solid #ccc' }}
                  >
                    <option value="">Estado entrevista</option>
                    <option value="PENDING">Pendiente</option>
                    <option value="CONFIRMED">Confirmada</option>
                    <option value="ON_HOLD">En pausa</option>
                    <option value="CANCELLED">Cancelada</option>
                  </select>
                </div>
                <button
                  onClick={handleInterviewSave}
                  disabled={interviewSaving}
                  style={{ alignSelf: 'flex-start', padding: '6px 12px', borderRadius: 6, border: '1px solid #111', background: '#fff' }}
                >
                  {interviewSaving ? 'Guardando...' : 'Guardar entrevista'}
                </button>
                <div style={{ fontSize: 11, color: '#666' }}>Las plantillas de entrevista usan estos valores; si están vacíos se usan los defaults de Configuración.</div>
              </div>
            )}
          </div>
        )}
      </div>
      <div
        ref={messagesRef}
        onScroll={handleScroll}
        style={{ flex: 1, padding: 16, overflowY: 'auto', background: '#fafafa', minHeight: 0 }}
      >
        {hasConversation ? (
          (() => {
            const items: React.ReactNode[] = [];
            let lastDayKey = '';
            for (const m of conversation?.messages || []) {
              const dayKey = formatMessageDayKey(m.timestamp);
              if (dayKey && dayKey !== lastDayKey) {
                lastDayKey = dayKey;
                items.push(
                  <div key={`day-${dayKey}`} style={{ display: 'flex', justifyContent: 'center', margin: '12px 0' }}>
                    <span style={{ fontSize: 12, color: '#666', background: '#fff', border: '1px solid #eee', borderRadius: 999, padding: '4px 10px' }}>
                      {formatMessageDayLabel(m.timestamp)}
                    </span>
                  </div>
                );
              }

              const payload = safeParseJson(m.rawPayload);
              const isSystem = Boolean(payload?.system);
              const time = formatMessageTime(m.timestamp);
              const full = formatFullTimestamp(m.timestamp);

              if (isSystem) {
                items.push(
                  <div key={m.id} style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
                    <div style={{ maxWidth: 520, textAlign: 'center' }}>
                      <div style={{ fontSize: 12, color: '#666', background: '#fff', border: '1px dashed #ddd', borderRadius: 10, padding: '8px 10px', whiteSpace: 'pre-wrap' }}>
                        {m.text || '(evento del sistema)'}
                      </div>
                      {time && (
                        <div style={{ marginTop: 4, fontSize: 11, color: '#888' }} title={full}>
                          {time}
                        </div>
                      )}
                    </div>
                  </div>
                );
                continue;
              }

              items.push(
                <div
                  key={m.id}
                  style={{
                    marginBottom: 8,
                    display: 'flex',
                    justifyContent: m.direction === 'OUTBOUND' ? 'flex-end' : 'flex-start'
                  }}
                >
                  <div
                    style={{
                      maxWidth: '70%',
                      padding: '8px 10px',
                      borderRadius: 12,
                      background: m.direction === 'OUTBOUND' ? '#d1e7dd' : '#fff',
                      border: '1px solid #eee',
                      fontSize: 14,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6
                    }}
                  >
                    <div style={{ whiteSpace: 'pre-wrap' }}>{m.text || describeMedia(m) || '(sin texto)'}</div>
                    {m.mediaType && (
                      <div style={{ fontSize: 12, color: '#555', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span>{describeMedia(m)}</span>
                        {m.mediaPath && (
                          <button
                            onClick={() => handleDownload(m)}
                            style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #ccc', background: '#f8f8f8', fontSize: 12 }}
                          >
                            Descargar
                          </button>
                        )}
                      </div>
                    )}
                    {m.transcriptText && (
                      <div style={{ fontSize: 12, color: '#333', background: '#f6f6f6', padding: '6px 8px', borderRadius: 8 }}>
                        Transcripción: {m.transcriptText}
                      </div>
                    )}
                    {time && (
                      <div
                        style={{
                          fontSize: 11,
                          color: '#666',
                          display: 'flex',
                          justifyContent: 'flex-end'
                        }}
                        title={full}
                      >
                        {time}
                      </div>
                    )}
                  </div>
                </div>
              );
            }
            return items;
          })()
        ) : (
          <div style={{ padding: 8, color: '#666' }}>Selecciona una conversación</div>
        )}
      </div>
      <div
        style={{
          padding: 12,
          borderTop: '1px solid #eee',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          flexShrink: 0,
          background: '#fff'
        }}
      >
        {hasConversation && !within24h && !isAdmin && (
          <div style={{ fontSize: 13, color: '#b93800' }}>Fuera de ventana 24h. Debes usar una plantilla.</div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <textarea
            style={{ flex: 1, padding: 8, borderRadius: 4, border: '1px solid #ccc', minHeight: 40 }}
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Escribe una respuesta..."
          />
          <button
            onClick={handleSuggest}
            disabled={!hasConversation || loadingAi || (isManualMode && !text.trim())}
            style={{ padding: '8px 10px', borderRadius: 4, border: '1px solid #ccc', background: '#eee' }}
          >
            {loadingAi ? 'IA...' : 'Sugerir'}
          </button>
          <button
            onClick={handleSend}
            disabled={!hasConversation || loadingSend || (!within24h && !isAdmin)}
            style={{ padding: '8px 10px', borderRadius: 4, border: 'none', background: '#000', color: '#fff' }}
          >
            {loadingSend ? 'Enviando...' : 'Enviar'}
          </button>
        </div>
        {sendError && <div style={{ color: '#b93800', fontSize: 13 }}>{sendError}</div>}
        {downloadError && <div style={{ color: '#b93800', fontSize: 13 }}>{downloadError}</div>}
        {hasConversation && !isAdmin && !within24h && (
          <>
            {requiredTemplate ? (
              <>
                {templateVariableCount > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ fontSize: 12, color: '#666' }}>Variables plantilla ({templateVariableCount}):</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {Array.from({ length: templateVariableCount }, (_, index) => (
                        <input
                          key={index}
                          value={templateVariables[index] || ''}
                          onChange={e => {
                            const next = [...templateVariables];
                            next[index] = e.target.value;
                            setTemplateVariables(next);
                          }}
                          placeholder={index === 0 ? 'Variable 1 (ej: nombre)' : `Variable ${index + 1}`}
                          style={{ flex: '1 1 160px', minWidth: 160, padding: 8, borderRadius: 4, border: '1px solid #ccc' }}
                        />
                      ))}
                    </div>
                  </div>
                )}
                <button
                  onClick={handleSendTemplate}
                  disabled={templateSending || !templateVariablesReady}
                  style={{ alignSelf: 'flex-start', padding: '6px 12px', borderRadius: 4, border: '1px solid #111', background: '#fff' }}
                >
                  {templateSending ? 'Enviando plantilla...' : `Enviar plantilla de ${requiredTemplateLabel}`}
                </button>
              </>
            ) : (
              <div style={{ fontSize: 13, color: '#b93800' }}>
                No hay plantilla configurada para {requiredTemplateLabel}. Ve a Configuración → Plantillas WhatsApp.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

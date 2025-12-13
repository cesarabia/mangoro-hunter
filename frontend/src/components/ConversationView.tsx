import React, { useEffect, useRef, useState } from 'react';
import { apiClient } from '../api/client';

interface ConversationViewProps {
  conversation: any | null;
  onMessageSent: () => void;
}

export const ConversationView: React.FC<ConversationViewProps> = ({ conversation, onMessageSent }) => {
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

  const handleModeChange = async (mode: 'RECRUIT' | 'INTERVIEW' | 'OFF') => {
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
  const candidateName = isAdmin
    ? 'Administrador'
    : conversation?.contact?.candidateName ||
      conversation?.contact?.name ||
      null;
  const profileDisplay =
    conversation?.contact?.displayName || conversation?.contact?.name || conversation?.contact?.waId || '';
  const displayName = candidateName || profileDisplay || 'Sin conversación';
  const aiMode: 'RECRUIT' | 'INTERVIEW' | 'OFF' = conversation?.aiMode || 'RECRUIT';
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
  const modeOptions: Array<{ key: 'RECRUIT' | 'INTERVIEW' | 'OFF'; label: string }> = [
    { key: 'RECRUIT', label: 'Reclutamiento' },
    { key: 'INTERVIEW', label: 'Entrevista' },
    { key: 'OFF', label: 'Manual' }
  ];

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
            <div style={{ fontSize: 18, fontWeight: 700 }}>{displayName}</div>
            {!isAdmin && profileDisplay && <div style={{ fontSize: 12, color: '#666' }}>{profileDisplay}</div>}
            {waId && (
              <div style={{ fontSize: 12, color: '#444', display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <span>+{waId}</span>
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
          conversation?.messages?.map((m: any) => (
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
                <div>{m.text || describeMedia(m) || '(sin texto)'}</div>
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
              </div>
            </div>
          ))
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

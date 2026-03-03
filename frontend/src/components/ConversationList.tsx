import React, { useMemo, useState } from 'react';

interface ConversationListProps {
  conversations: any[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  fullWidth?: boolean;
  mode?: 'INBOX' | 'INACTIVE';
}

const statusLabels: Record<string, string> = {
  NEW: 'Nuevo',
  OPEN: 'En seguimiento',
  CLOSED: 'Cerrado'
};

const statusStyles: Record<string, { background: string; border: string; color: string }> = {
  NEW: { background: '#e6f7ff', border: '#91d5ff', color: '#0958d9' },
  OPEN: { background: '#fffbe6', border: '#ffe58f', color: '#ad6800' },
  CLOSED: { background: '#f6ffed', border: '#b7eb8f', color: '#237804' },
  DEFAULT: { background: '#f5f5f5', border: '#d9d9d9', color: '#333' }
};

const isSuspiciousCandidateName = (value?: string | null) => {
  if (!value) return true;
  const lower = value.toLowerCase();
  const patterns = [
    'hola quiero postular',
    'quiero postular',
    'postular',
    'no puedo',
    'no me sirve',
    'confirmo',
    'medio dia',
    'mediodia',
    'confirmar'
  ];
  if (patterns.some(p => lower.includes(p))) return true;
  if (/(lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)/i.test(value)) return true;
  if (/medio ?d[ií]a/i.test(value)) return true;
  return false;
};

export const ConversationList: React.FC<ConversationListProps> = ({
  conversations,
  selectedId,
  onSelect,
  fullWidth = false,
  mode = 'INBOX',
}) => {
  const INBOX_IMPORT_BATCH_FILTER_KEY = 'inboxFilterImportBatchId';
  type StageViewKey =
    | 'NEW_INTAKE'
    | 'SCREENING'
    | 'INTERVIEW_PENDING'
    | 'INTERVIEW_SCHEDULED'
    | 'HIRED_DRIVER'
    | 'REJECTED'
    | 'STALE_NO_RESPONSE'
    | 'PROSPECTS_NO_MESSAGES'
    | 'LEGACY_NO_MESSAGES';
  type JobRoleFilter = 'ALL' | 'CONDUCTOR' | 'PEONETA';
  const [stageView, setStageView] = useState<StageViewKey>(mode === 'INACTIVE' ? 'STALE_NO_RESPONSE' : 'NEW_INTAKE');
  const [jobRoleFilter, setJobRoleFilter] = useState<JobRoleFilter>('ALL');
  const [importBatchFilter, setImportBatchFilter] = useState<string>(() => {
    try {
      return String(localStorage.getItem(INBOX_IMPORT_BATCH_FILTER_KEY) || '').trim();
    } catch {
      return '';
    }
  });
  const [query, setQuery] = useState('');

  const normalizeStage = (conversation: any): StageViewKey | string => {
    const raw = String(conversation?.conversationStage || conversation?.stage || '').trim().toUpperCase();
    if (!raw || raw === 'NUEVO') return 'NEW_INTAKE';
    if (raw === 'WAITING_CANDIDATE' || raw === 'INFO') return 'SCREENING';
    if (raw === 'AGENDADO' || raw === 'CONFIRMED') return 'INTERVIEW_SCHEDULED';
    if (raw === 'DESCARTADO') return 'REJECTED';
    return raw;
  };

  const stageLabel = (stage: string): string => {
    const key = String(stage || '').trim().toUpperCase();
    const map: Record<string, string> = {
      NEW_INTAKE: 'Nuevo',
      SCREENING: 'Screening',
      INTERVIEW_PENDING: 'Entrevista pendiente',
      INTERVIEW_SCHEDULED: 'Entrevista agendada',
      HIRED_DRIVER: 'Contratado',
      REJECTED: 'Rechazado',
      STALE_NO_RESPONSE: 'Sin respuesta',
    };
    return map[key] || key || 'Sin stage';
  };

  const stageViews: Array<{ key: StageViewKey; label: string }> = [
    { key: 'NEW_INTAKE', label: 'Nuevos' },
    { key: 'SCREENING', label: 'Screening' },
    { key: 'INTERVIEW_PENDING', label: 'Entrevista pendiente' },
    { key: 'INTERVIEW_SCHEDULED', label: 'Entrevista agendada' },
    { key: 'HIRED_DRIVER', label: 'Contratados' },
    { key: 'REJECTED', label: 'Rechazados' },
    { key: 'STALE_NO_RESPONSE', label: 'Sin respuesta' },
    { key: 'PROSPECTS_NO_MESSAGES', label: 'Prospectos (sin mensajes)' },
    { key: 'LEGACY_NO_MESSAGES', label: 'Importados históricos' },
  ];

  const candidateBucket = (conversation: any): 'NUEVO' | 'CONTACTADO' | 'CITADO' | 'DESCARTADO' => {
    const stage = String(normalizeStage(conversation) || '').toUpperCase();
    const status = String(conversation?.status || '').toUpperCase();
    if (status === 'CLOSED' || ['REJECTED', 'NO_CONTACTAR', 'DISQUALIFIED', 'CERRADO', 'ARCHIVED'].includes(stage)) {
      return 'DESCARTADO';
    }
    if (['INTERVIEW_PENDING', 'INTERVIEW_SCHEDULED', 'INTERVIEWED', 'AGENDADO', 'CONFIRMADO'].includes(stage)) {
      return 'CITADO';
    }
    if (status === 'OPEN' || ['SCREENING', 'INFO', 'CALIFICADO', 'QUALIFIED', 'EN_COORDINACION', 'INTERESADO'].includes(stage)) {
      return 'CONTACTADO';
    }
    return 'NUEVO';
  };

  const inferJobRoleFromConversation = (conversation: any): 'CONDUCTOR' | 'PEONETA' => {
    const explicit = String(conversation?.contact?.jobRole || '').trim().toUpperCase();
    if (explicit === 'PEONETA' || explicit === 'CONDUCTOR') return explicit;
    const source = `${String(conversation?.program?.slug || '')} ${String(conversation?.program?.name || '')}`.toLowerCase();
    if (
      source.includes('peoneta') ||
      source.includes('ayudante') ||
      source.includes('cargador')
    ) {
      return 'PEONETA';
    }
    return 'CONDUCTOR';
  };

  const passesJobRoleFilter = (conversation: any): boolean => {
    if (jobRoleFilter === 'ALL') return true;
    return inferJobRoleFromConversation(conversation) === jobRoleFilter;
  };

  const passesImportBatchFilter = (conversation: any): boolean => {
    if (!importBatchFilter) return true;
    return String(conversation?.contact?.importBatchId || '').trim() === importBatchFilter;
  };

  const countByView = useMemo(() => {
    const counts: Record<string, { total: number; unread: number }> = {};
    for (const view of stageViews) counts[view.key] = { total: 0, unread: 0 };
    for (const c of conversations) {
      if (!passesJobRoleFilter(c)) continue;
      if (!passesImportBatchFilter(c)) continue;
      const hasMessages = Array.isArray(c?.messages) && c.messages.length > 0;
      const st = normalizeStage(c);
      const unreadCount = Number(c?.unreadCount || 0);
      if (!hasMessages) {
        const bucket = candidateBucket(c);
        if (bucket === 'NUEVO' && st === 'NEW_INTAKE') {
          counts.PROSPECTS_NO_MESSAGES.total += 1;
          if (unreadCount > 0) counts.PROSPECTS_NO_MESSAGES.unread += 1;
        } else {
          counts.LEGACY_NO_MESSAGES.total += 1;
          if (unreadCount > 0) counts.LEGACY_NO_MESSAGES.unread += 1;
        }
      }
      if (counts[st] !== undefined) {
        counts[st].total += 1;
        if (unreadCount > 0) counts[st].unread += 1;
      }
    }
    return counts;
  }, [conversations, jobRoleFilter, importBatchFilter]);

  const filteredConversations = useMemo(() => {
    const needle = String(query || '').trim().toLowerCase();
    const filteredByRoleAndBatch = conversations.filter((c: any) => passesJobRoleFilter(c) && passesImportBatchFilter(c));
    const base = needle
      ? filteredByRoleAndBatch
      : filteredByRoleAndBatch.filter((c: any) => {
          const hasMessages = Array.isArray(c?.messages) && c.messages.length > 0;
          const st = normalizeStage(c);
          if (stageView === 'PROSPECTS_NO_MESSAGES') {
            return !hasMessages && candidateBucket(c) === 'NUEVO' && st === 'NEW_INTAKE';
          }
          if (stageView === 'LEGACY_NO_MESSAGES') {
            return !hasMessages && !(candidateBucket(c) === 'NUEVO' && st === 'NEW_INTAKE');
          }
          if (!hasMessages) return false;
          return st === stageView;
        });

    if (!needle) return base;
    return base.filter((c: any) => {
      const hay = [
        c?.id,
        c?.conversationStage,
        c?.stage,
        c?.contact?.waId,
        c?.contact?.phone,
        c?.contact?.candidateName,
        c?.contact?.candidateNameManual,
        c?.contact?.displayName,
        c?.contact?.name,
        c?.contact?.importBatchId,
      ]
        .map((v) => String(v || '').toLowerCase())
        .join(' ');
      return hay.includes(needle);
    });
  }, [conversations, stageView, query, jobRoleFilter, importBatchFilter]);

  return (
    <div
      style={{
        borderRight: fullWidth ? 'none' : '1px solid #eee',
        width: fullWidth ? '100%' : 320,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: '#fff'
      }}
    >
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
        <h2 style={{ margin: 0 }}>Conversaciones</h2>
      </div>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #f2f2f2', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {stageViews.map(item => (
          <button
            key={item.key}
            onClick={() => setStageView(item.key)}
            style={{
              padding: '4px 10px',
              borderRadius: 999,
              border: stageView === item.key ? '1px solid #111' : '1px solid #dcdcdc',
              background: stageView === item.key ? '#111' : '#fff',
              color: stageView === item.key ? '#fff' : '#333',
              fontSize: 12,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {item.label}
            <span
              style={{
                fontSize: 11,
                borderRadius: 999,
                padding: '0 6px',
                background: stageView === item.key ? 'rgba(255,255,255,0.2)' : '#f3f3f3',
                color: stageView === item.key ? '#fff' : '#444',
                minWidth: 16,
                textAlign: 'center',
              }}
            >
              {countByView[item.key]?.total || 0}
            </span>
            {(countByView[item.key]?.unread || 0) > 0 ? (
              <span
                title="Sin leer"
                style={{
                  fontSize: 11,
                  borderRadius: 999,
                  padding: '0 6px',
                  background: '#fff1f0',
                  color: '#a8071a',
                  border: '1px solid #ffa39e',
                  minWidth: 16,
                  textAlign: 'center',
                }}
              >
                {countByView[item.key]?.unread || 0}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #f2f2f2', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {[
          { key: 'ALL', label: 'Todos' },
          { key: 'CONDUCTOR', label: 'Conductores' },
          { key: 'PEONETA', label: 'Peonetas' },
        ].map((item) => (
          <button
            key={item.key}
            onClick={() => setJobRoleFilter(item.key as JobRoleFilter)}
            style={{
              padding: '4px 10px',
              borderRadius: 999,
              border: jobRoleFilter === item.key ? '1px solid #111' : '1px solid #dcdcdc',
              background: jobRoleFilter === item.key ? '#111' : '#fff',
              color: jobRoleFilter === item.key ? '#fff' : '#333',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {item.label}
          </button>
        ))}
        {importBatchFilter ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11,
              padding: '3px 8px',
              borderRadius: 999,
              background: '#e6f7ff',
              border: '1px solid #91d5ff',
              color: '#0958d9',
            }}
          >
            Batch: {importBatchFilter}
            <button
              onClick={() => {
                setImportBatchFilter('');
                try {
                  localStorage.removeItem(INBOX_IMPORT_BATCH_FILTER_KEY);
                } catch {
                  // ignore
                }
              }}
              style={{ border: 'none', background: 'transparent', color: '#0958d9', cursor: 'pointer', fontSize: 12, padding: 0 }}
            >
              ×
            </button>
          </span>
        ) : null}
      </div>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #f2f2f2' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por nombre, teléfono o caseId"
          style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 13 }}
        />
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filteredConversations.length === 0 && (
          <div style={{ padding: '16px', color: '#777', fontSize: 13 }}>
            {stageView === 'PROSPECTS_NO_MESSAGES'
              ? 'No hay prospectos sin mensajes.'
              : stageView === 'LEGACY_NO_MESSAGES'
                ? 'No hay importados históricos sin mensajes.'
              : 'No hay conversaciones en este stage.'}
          </div>
        )}
        {filteredConversations.map(c => {
          const lastMessage = c.messages?.[0];
          const unreadCount = c.unreadCount || 0;
          const hasUnread = unreadCount > 0;
          const isAdmin = Boolean(c.isAdmin);
          const kind = String(c.conversationKind || 'CLIENT').toUpperCase();
          const isStaff = kind === 'STAFF';
          const isPartner = kind === 'PARTNER';
          const rawCandidate = c.contact?.candidateName || null;
          const validCandidate = !isAdmin && rawCandidate && !isSuspiciousCandidateName(rawCandidate);
          const waId = c.contact?.waId || c.contact?.phone || '';
          const profileDisplay = c.contact?.displayName || c.contact?.name || '';
          const primaryName = isAdmin
            ? 'Administrador'
            : validCandidate
            ? rawCandidate
            : profileDisplay || waId || 'Sin nombre';
          const statusLabel = statusLabels[c.status] || c.status || 'Sin estado';
          const statusStyle = (statusStyles[c.status] || statusStyles.DEFAULT);
          const previewSource = lastMessage?.transcriptText || lastMessage?.text;
          const preview = previewSource ? previewSource.slice(0, 70) : 'Sin mensajes';
          const showStatus = !isAdmin;
          const noContact = Boolean(c.contact?.noContact);
          const programName = c.program?.name ? String(c.program.name) : '';
          const stage = String(normalizeStage(c));
          const stageText = stageLabel(stage);
          return (
            <div
              key={c.id}
              onClick={() => onSelect(c.id)}
              style={{
                padding: '8px 12px',
                cursor: 'pointer',
                background: selectedId === c.id ? '#f0f0f0' : 'transparent',
                borderBottom: '1px solid #f5f5f5'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: hasUnread ? 700 : 600 }}>{primaryName}</span>
                {hasUnread && (
                  <span
                    style={{
                      background: '#ff4d4f',
                      color: '#fff',
                      borderRadius: 999,
                      fontSize: 11,
                      minWidth: 18,
                      height: 18,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '0 6px'
                    }}
                  >
                    {unreadCount}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: '#555' }}>
                {profileDisplay ? `${profileDisplay}` : ''}
                {profileDisplay && waId ? ' · ' : ''}
                {waId ? `+${waId}` : ''}
              </div>
              <div style={{ fontSize: 12, color: hasUnread ? '#111' : '#666', fontWeight: hasUnread ? 600 : 400 }}>
                {preview}
              </div>
              {showStatus && (
                <div style={{ marginTop: 6 }}>
                  {isStaff && (
                    <span
                      title="Conversación del staff (WhatsApp)"
                      style={{
                        background: '#f6ffed',
                        border: '1px solid #b7eb8f',
                        color: '#237804',
                        borderRadius: 999,
                        fontSize: 11,
                        padding: '2px 8px',
                        marginRight: 6,
                        whiteSpace: 'nowrap'
                      }}
                    >
                      STAFF
                    </span>
                  )}
                  {isPartner && (
                    <span
                      title="Conversación de proveedor/partner (WhatsApp)"
                      style={{
                        background: '#fff7e6',
                        border: '1px solid #ffd591',
                        color: '#ad4e00',
                        borderRadius: 999,
                        fontSize: 11,
                        padding: '2px 8px',
                        marginRight: 6,
                        whiteSpace: 'nowrap'
                      }}
                    >
                      PROVEEDOR
                    </span>
                  )}
                  {noContact && (
                    <span style={{ background: '#fff1f0', border: '1px solid #ff7875', color: '#a8071a', borderRadius: 999, fontSize: 11, padding: '2px 8px', marginRight: 6 }}>
                      NO CONTACTAR
                    </span>
                  )}
                  {programName ? (
                    <span style={{ background: '#f0f5ff', border: '1px solid #adc6ff', color: '#10239e', borderRadius: 999, fontSize: 11, padding: '2px 8px', marginRight: 6, whiteSpace: 'nowrap' }}>
                      {programName}
                    </span>
                  ) : null}
                  <span
                    title="Puesto operativo inferido/guardado para este caso"
                    style={{
                      background: inferJobRoleFromConversation(c) === 'PEONETA' ? '#fff7e6' : '#e6fffb',
                      border: inferJobRoleFromConversation(c) === 'PEONETA' ? '1px solid #ffd591' : '1px solid #87e8de',
                      color: inferJobRoleFromConversation(c) === 'PEONETA' ? '#ad4e00' : '#006d75',
                      borderRadius: 999,
                      fontSize: 11,
                      padding: '2px 8px',
                      marginRight: 6,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {inferJobRoleFromConversation(c)}
                  </span>
                  <span
                    title={`Stage: ${stage}`}
                    style={{
                      background: '#f9f0ff',
                      border: '1px solid #d3adf7',
                      color: '#531dab',
                      borderRadius: 999,
                      fontSize: 11,
                      padding: '2px 8px',
                      marginRight: 6,
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {stageText}
                  </span>
                  <span
                    style={{
                      background: statusStyle.background,
                      border: `1px solid ${statusStyle.border}`,
                      color: statusStyle.color,
                      borderRadius: 999,
                      fontSize: 11,
                      padding: '2px 8px',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {statusLabel}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

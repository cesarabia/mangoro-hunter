import React, { useEffect, useMemo, useState } from 'react';

interface ConversationListProps {
  conversations: any[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  fullWidth?: boolean;
  mode?: 'INBOX' | 'INACTIVE';
  workspaceId?: string;
  workspaceStages?: Array<{ slug: string; labelEs?: string | null; isActive?: boolean }>;
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
  workspaceId = 'default',
  workspaceStages = [],
}) => {
  const INBOX_IMPORT_BATCH_FILTER_KEY = 'inboxFilterImportBatchId';
  const STAGE_VIEW_STORAGE_KEY = `inboxStageView:${workspaceId}:${mode}`;
  const JOB_ROLE_FILTER_STORAGE_KEY = `inboxJobRoleFilter:${workspaceId}:${mode}`;
  const ALL_STAGE_FILTER_STORAGE_KEY = `inboxAllStageFilter:${workspaceId}:${mode}`;
  const COMPACT_MODE_STORAGE_KEY = `inboxCompactMode:${workspaceId}:${mode}`;
  type StageViewKey =
    | 'ALL'
    | 'NEW_INTAKE'
    | 'SCREENING'
    | 'OP_REVIEW'
    | 'INTERVIEW_PENDING'
    | 'INTERVIEW_SCHEDULED'
    | 'HIRED_DRIVER'
    | 'REJECTED'
    | 'STALE_NO_RESPONSE'
    | 'PROSPECTS_NO_MESSAGES'
    | 'LEGACY_NO_MESSAGES';
  type JobRoleFilter = 'ALL' | 'CONDUCTOR' | 'PEONETA';
  const [stageView, setStageView] = useState<StageViewKey>(() => {
    try {
      const saved = String(localStorage.getItem(STAGE_VIEW_STORAGE_KEY) || '').trim().toUpperCase();
      if (
        saved === 'ALL' ||
        saved === 'NEW_INTAKE' ||
        saved === 'SCREENING' ||
        saved === 'OP_REVIEW' ||
        saved === 'INTERVIEW_PENDING' ||
        saved === 'INTERVIEW_SCHEDULED' ||
        saved === 'HIRED_DRIVER' ||
        saved === 'REJECTED' ||
        saved === 'STALE_NO_RESPONSE' ||
        saved === 'PROSPECTS_NO_MESSAGES' ||
        saved === 'LEGACY_NO_MESSAGES'
      ) {
        return saved as StageViewKey;
      }
    } catch {
      // ignore
    }
    return mode === 'INACTIVE' ? 'STALE_NO_RESPONSE' : 'ALL';
  });
  const [jobRoleFilter, setJobRoleFilter] = useState<JobRoleFilter>(() => {
    try {
      const saved = String(localStorage.getItem(JOB_ROLE_FILTER_STORAGE_KEY) || '').trim().toUpperCase();
      if (saved === 'CONDUCTOR' || saved === 'PEONETA' || saved === 'ALL') return saved as JobRoleFilter;
    } catch {
      // ignore
    }
    return 'ALL';
  });
  const [allStageFilter, setAllStageFilter] = useState<string>(() => {
    try {
      return String(localStorage.getItem(ALL_STAGE_FILTER_STORAGE_KEY) || '').trim().toUpperCase();
    } catch {
      return '';
    }
  });
  const [compactMode, setCompactMode] = useState<boolean>(() => {
    try {
      const saved = String(localStorage.getItem(COMPACT_MODE_STORAGE_KEY) || '').trim().toLowerCase();
      return saved === '1' || saved === 'true';
    } catch {
      return false;
    }
  });
  const [importBatchFilter, setImportBatchFilter] = useState<string>(() => {
    try {
      return String(localStorage.getItem(INBOX_IMPORT_BATCH_FILTER_KEY) || '').trim();
    } catch {
      return '';
    }
  });
  const [query, setQuery] = useState('');

  const normalizeStage = (conversation: any): string => {
    const raw = String(conversation?.conversationStage || conversation?.stage || '').trim().toUpperCase();
    if (!raw || raw === 'NUEVO') return 'NEW_INTAKE';
    if (raw === 'WAITING_CANDIDATE' || raw === 'INFO') return 'SCREENING';
    if (raw === 'AGENDADO' || raw === 'CONFIRMED') return 'INTERVIEW_SCHEDULED';
    if (raw === 'DESCARTADO') return 'REJECTED';
    return raw;
  };

  const mapStageToView = (stageRaw: string): StageViewKey | null => {
    const stage = String(stageRaw || '').trim().toUpperCase();
    if (!stage || stage === 'NEW_INTAKE' || stage === 'NUEVO') return 'NEW_INTAKE';
    if (stage === 'OP_REVIEW') return 'OP_REVIEW';
    if (['SCREENING', 'INFO', 'CALIFICADO', 'QUALIFIED', 'INTERESADO'].includes(stage)) return 'SCREENING';
    if (['INTERVIEW_PENDING', 'EN_COORDINACION'].includes(stage)) return 'INTERVIEW_PENDING';
    if (['INTERVIEW_SCHEDULED', 'AGENDADO', 'CONFIRMADO'].includes(stage)) return 'INTERVIEW_SCHEDULED';
    if (['HIRED_DRIVER', 'HIRED', 'COMPLETADO'].includes(stage)) return 'HIRED_DRIVER';
    if (['REJECTED', 'DISQUALIFIED'].includes(stage)) return 'REJECTED';
    if (stage === 'STALE_NO_RESPONSE') return 'STALE_NO_RESPONSE';
    return null;
  };

  const stageLabel = (stage: string): string => {
    const key = String(stage || '').trim().toUpperCase();
    const map: Record<string, string> = {
      NEW_INTAKE: 'Nuevo',
      SCREENING: 'Screening',
      OP_REVIEW: 'Revisión operación',
      INTERVIEW_PENDING: 'Entrevista pendiente',
      INTERVIEW_SCHEDULED: 'Entrevista agendada',
      HIRED_DRIVER: 'Contratado',
      REJECTED: 'Rechazado',
      STALE_NO_RESPONSE: 'Sin respuesta',
    };
    return map[key] || key || 'Sin stage';
  };

  const stageViews: Array<{ key: StageViewKey; label: string }> = [
    { key: 'ALL', label: 'Todos' },
    { key: 'NEW_INTAKE', label: 'Nuevos' },
    { key: 'SCREENING', label: 'Screening' },
    { key: 'OP_REVIEW', label: 'Revisión operación' },
    { key: 'INTERVIEW_PENDING', label: 'Entrevista pendiente' },
    { key: 'INTERVIEW_SCHEDULED', label: 'Entrevista agendada' },
    { key: 'HIRED_DRIVER', label: 'Contratados' },
    { key: 'REJECTED', label: 'Rechazados' },
    { key: 'STALE_NO_RESPONSE', label: 'Sin respuesta' },
    { key: 'PROSPECTS_NO_MESSAGES', label: 'Prospectos (sin mensajes)' },
    { key: 'LEGACY_NO_MESSAGES', label: 'Importados históricos' },
  ];

  useEffect(() => {
    try {
      localStorage.setItem(STAGE_VIEW_STORAGE_KEY, stageView);
    } catch {
      // ignore
    }
  }, [stageView, STAGE_VIEW_STORAGE_KEY]);

  useEffect(() => {
    try {
      localStorage.setItem(JOB_ROLE_FILTER_STORAGE_KEY, jobRoleFilter);
    } catch {
      // ignore
    }
  }, [jobRoleFilter, JOB_ROLE_FILTER_STORAGE_KEY]);

  useEffect(() => {
    try {
      if (allStageFilter) localStorage.setItem(ALL_STAGE_FILTER_STORAGE_KEY, allStageFilter);
      else localStorage.removeItem(ALL_STAGE_FILTER_STORAGE_KEY);
    } catch {
      // ignore
    }
  }, [allStageFilter, ALL_STAGE_FILTER_STORAGE_KEY]);

  useEffect(() => {
    try {
      localStorage.setItem(COMPACT_MODE_STORAGE_KEY, compactMode ? '1' : '0');
    } catch {
      // ignore
    }
    if (compactMode) setStageView('ALL');
  }, [compactMode, COMPACT_MODE_STORAGE_KEY]);

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
      const mappedView = mapStageToView(st);
      const isProspectNoMessages = !hasMessages && candidateBucket(c) === 'NUEVO' && st === 'NEW_INTAKE';
      const isLegacyNoMessages = !hasMessages && !isProspectNoMessages;

      if (hasMessages) {
        counts.ALL.total += 1;
        if (unreadCount > 0) counts.ALL.unread += 1;
      }

      if (isProspectNoMessages) {
        counts.PROSPECTS_NO_MESSAGES.total += 1;
        if (unreadCount > 0) counts.PROSPECTS_NO_MESSAGES.unread += 1;
      } else if (isLegacyNoMessages) {
        counts.LEGACY_NO_MESSAGES.total += 1;
        if (unreadCount > 0) counts.LEGACY_NO_MESSAGES.unread += 1;
      }

      if (hasMessages && mappedView && counts[mappedView] !== undefined) {
        counts[mappedView].total += 1;
        if (unreadCount > 0) counts[mappedView].unread += 1;
      }
    }
    return counts;
  }, [conversations, jobRoleFilter, importBatchFilter]);

  const allStageOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const stage of workspaceStages || []) {
      const slug = String(stage?.slug || '').trim().toUpperCase();
      if (!slug) continue;
      const label = String(stage?.labelEs || '').trim() || stageLabel(slug);
      map.set(slug, label);
    }
    for (const c of conversations) {
      const slug = normalizeStage(c);
      if (!slug) continue;
      if (!map.has(slug)) map.set(slug, stageLabel(slug));
    }
    return Array.from(map.entries())
      .map(([slug, label]) => ({ slug, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'es', { sensitivity: 'base' }));
  }, [workspaceStages, conversations]);

  const filteredConversations = useMemo(() => {
    const needle = String(query || '').trim().toLowerCase();
    const filteredByRoleAndBatch = conversations.filter((c: any) => passesJobRoleFilter(c) && passesImportBatchFilter(c));
    const base = (needle ? filteredByRoleAndBatch : filteredByRoleAndBatch.filter((c: any) => {
          const hasMessages = Array.isArray(c?.messages) && c.messages.length > 0;
          const st = normalizeStage(c);
          const mappedView = mapStageToView(st);
          if (stageView === 'PROSPECTS_NO_MESSAGES') {
            return !hasMessages && candidateBucket(c) === 'NUEVO' && st === 'NEW_INTAKE';
          }
          if (stageView === 'LEGACY_NO_MESSAGES') {
            return !hasMessages && !(candidateBucket(c) === 'NUEVO' && st === 'NEW_INTAKE');
          }
          if (stageView === 'ALL') {
            if (!hasMessages) return false;
            if (allStageFilter) return st === allStageFilter;
            return true;
          }
          if (!hasMessages) return false;
          return mappedView === stageView;
        }))
      .filter((c: any) => {
        if (stageView !== 'ALL' || !allStageFilter) return true;
        return normalizeStage(c) === allStageFilter;
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
        c?.program?.name,
        c?.program?.slug,
      ]
        .map((v) => String(v || '').toLowerCase())
        .join(' ');
      return hay.includes(needle);
    });
  }, [conversations, stageView, query, jobRoleFilter, importBatchFilter, allStageFilter]);

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
      {!compactMode ? (
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
      ) : (
        <div style={{ padding: '8px 12px', borderBottom: '1px solid #f2f2f2', fontSize: 12, color: '#666' }}>
          Modo compacto activo: mostrando <b>Todos</b>. Usa “Filtrar por stage” para afinar.
        </div>
      )}
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
        <button
          onClick={() => setCompactMode((prev) => !prev)}
          style={{
            marginLeft: 'auto',
            padding: '4px 10px',
            borderRadius: 999,
            border: compactMode ? '1px solid #111' : '1px solid #dcdcdc',
            background: compactMode ? '#111' : '#fff',
            color: compactMode ? '#fff' : '#333',
            fontSize: 12,
            cursor: 'pointer',
          }}
          title="Oculta la grilla de tabs por stage y deja filtros operativos"
        >
          {compactMode ? 'Compacto: ON' : 'Compacto: OFF'}
        </button>
      </div>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #f2f2f2' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por nombre, teléfono o caseId"
          style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 13 }}
        />
      </div>
      {stageView === 'ALL' ? (
        <div style={{ padding: '8px 12px', borderBottom: '1px solid #f2f2f2' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#666' }}>
            Filtrar por stage
            <select
              value={allStageFilter}
              onChange={(e) => setAllStageFilter(String(e.target.value || '').trim().toUpperCase())}
              style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 13 }}
            >
              <option value="">Todos los stages</option>
              {allStageOptions.map((opt) => (
                <option key={opt.slug} value={opt.slug}>
                  {opt.label} ({opt.slug})
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filteredConversations.length === 0 && (
          <div style={{ padding: '16px', color: '#777', fontSize: 13 }}>
            {query
              ? 'No hay resultados para esa búsqueda.'
              : stageView === 'PROSPECTS_NO_MESSAGES'
              ? 'No hay prospectos sin mensajes.'
              : stageView === 'LEGACY_NO_MESSAGES'
                ? 'No hay importados históricos sin mensajes.'
                : stageView === 'ALL' && allStageFilter
                  ? 'No hay conversaciones para ese stage.'
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

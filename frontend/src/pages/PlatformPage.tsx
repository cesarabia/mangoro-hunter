import React, { useEffect, useMemo, useState } from 'react';
import { apiClient } from '../api/client';

type WorkspaceRow = {
  id: string;
  name: string;
  isSandbox?: boolean;
  createdAt?: string;
  archivedAt?: string | null;
  owners?: Array<{ email: string; name: string | null }>;
  membersCount?: number;
};

type WorkspaceTemplateOption = {
  id: string;
  label: string;
  description?: string;
};

export const PlatformPage: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<WorkspaceRow[]>([]);
  const [showArchived, setShowArchived] = useState(false);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [creating, setCreating] = useState(false);
  const [createStatus, setCreateStatus] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [templates, setTemplates] = useState<WorkspaceTemplateOption[]>([]);
  const [template, setTemplate] = useState<string>('RECRUITING');
  const [seedStatusByWorkspace, setSeedStatusByWorkspace] = useState<Record<string, string>>({});

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiClient.get('/api/platform/workspaces');
      setRows(Array.isArray(data) ? (data as any) : []);
    } catch (err: any) {
      setRows([]);
      setError(err.message || 'No se pudieron cargar workspaces');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load().catch(() => {});
    apiClient
      .get('/api/platform/workspace-templates')
      .then((res: any) => {
        const list = Array.isArray(res) ? res : [];
        setTemplates(list);
        if (list.length > 0 && !list.some((t: any) => String(t?.id) === String(template))) {
          setTemplate(String(list[0]?.id || 'RECRUITING'));
        }
      })
      .catch(() => {
        setTemplates([]);
      });
  }, []);

  const archiveWorkspace = async (workspaceId: string, archived: boolean) => {
    const label = archived ? 'archivar' : 'restaurar';
    const ok = window.confirm(
      archived
        ? `¿Archivar el workspace "${workspaceId}"?\n\nEsto NO borra datos: solo lo oculta del selector por defecto.`
        : `¿Restaurar el workspace "${workspaceId}"?`
    );
    if (!ok) return;
    try {
      await apiClient.patch(`/api/platform/workspaces/${workspaceId}`, { archived });
      await load();
    } catch (err: any) {
      window.alert(err?.message || `No se pudo ${label} el workspace.`);
    }
  };

  const seedSsclinical = async (workspaceId: string) => {
    const ok = window.confirm(
      `¿Ejecutar seed SSClinical en "${workspaceId}"?\n\nCrea Programs + Automation RUN_AGENT + Connector Medilink scaffold + invita a usuarios piloto.\n\nNo borra data.`
    );
    if (!ok) return;
    setSeedStatusByWorkspace((prev) => ({ ...prev, [workspaceId]: 'Seedeando…' }));
    try {
      const res: any = await apiClient.post(`/api/platform/workspaces/${workspaceId}/seed-ssclinical`, {});
      const invites = Array.isArray(res?.ensuredInvites) ? res.ensuredInvites : [];
      const summary =
        invites.length > 0
          ? `Seed OK. Invites piloto:\n${invites.map((i: any) => `- ${i.email} (${i.role}) ${i.inviteUrl || ''}`).join('\n')}`
          : 'Seed OK.';
      setSeedStatusByWorkspace((prev) => ({ ...prev, [workspaceId]: summary }));
      await load();
    } catch (err: any) {
      setSeedStatusByWorkspace((prev) => ({ ...prev, [workspaceId]: `Error: ${err.message || 'falló'}` }));
    }
  };

  const createWorkspace = async () => {
    setCreating(true);
    setCreateStatus(null);
    setCreateError(null);
    setInviteUrl(null);
    try {
      const res: any = await apiClient.post('/api/platform/workspaces', {
        name,
        slug,
        ownerEmail,
        template,
      });
      const url = typeof res?.invite?.inviteUrl === 'string' ? res.invite.inviteUrl : null;
      setCreateStatus(`Workspace creado: ${res?.workspace?.id || slug}`);
      if (url) {
        setInviteUrl(url);
        try {
          await navigator.clipboard.writeText(url);
          setCreateStatus((prev) => `${prev} · Invite link copiado.`);
        } catch {
          // ignore; we still show it
        }
      }
      setName('');
      setSlug('');
      setOwnerEmail('');
      await load();

      // Si el usuario actual tiene acceso al workspace recién creado, abrir Config->Workspace y mostrar Setup Wizard.
      try {
        const createdWorkspaceId = String(res?.workspace?.id || '').trim();
        if (createdWorkspaceId) {
          const available = await apiClient.get('/api/workspaces');
          const canOpen = Array.isArray(available) && available.some((w: any) => String(w?.id) === createdWorkspaceId);
          if (canOpen) {
            localStorage.setItem('workspaceId', createdWorkspaceId);
            localStorage.setItem('configSelectedTab', 'workspace');
            localStorage.setItem('__openSetupWizardWorkspaceId', createdWorkspaceId);
            setCreateStatus((prev) => `${prev || ''} · Abriendo Setup Wizard…`);
            setTimeout(() => {
              window.location.assign('/config/workspace');
            }, 350);
          }
        }
      } catch {
        // ignore
      }
    } catch (err: any) {
      setCreateError(err.message || 'No se pudo crear workspace');
    } finally {
      setCreating(false);
    }
  };

  const visibleRows = useMemo(() => {
    const list = Array.isArray(rows) ? rows : [];
    if (showArchived) return list;
    return list.filter((w) => !w.archivedAt);
  }, [rows, showArchived]);

  return (
    <div style={{ padding: 16, maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ fontSize: 22, fontWeight: 900 }}>Plataforma — Clientes (Workspaces)</div>
      <div style={{ marginTop: 6, fontSize: 13, color: '#666' }}>
        Crea y administra clientes (multi-tenant). Visible solo para Platform Admin.
      </div>
      <div
        style={{
          marginTop: 10,
          padding: 10,
          borderRadius: 12,
          border: '1px solid #fde6d8',
          background: '#fff7f1',
          color: '#7a3a12',
          fontSize: 13,
          lineHeight: 1.35,
        }}
      >
        <strong>Modo Plataforma:</strong> aquí administras <strong>clientes</strong>.
        <div style={{ marginTop: 6 }}>
          <div>• <strong>Cliente</strong> = <strong>Workspace</strong> (contenedor aislado de datos).</div>
          <div>• Los roles <strong>OWNER/ADMIN/MEMBER/VIEWER</strong> aplican <strong>dentro</strong> de cada Workspace.</div>
          <div>• Al crear un Workspace, se genera un <strong>invite</strong> para el Owner inicial (no mezcla cuentas).</div>
          <div>• Archivar = ocultar (no borra data).</div>
        </div>
      </div>

      <div style={{ marginTop: 14, border: '1px solid #eee', borderRadius: 14, padding: 14, background: '#fff' }}>
        <div style={{ fontWeight: 900, marginBottom: 10 }}>Crear Workspace</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Nombre</div>
            <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }} placeholder="SSClinical" />
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Slug/ID</div>
            <input value={slug} onChange={(e) => setSlug(e.target.value)} style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }} placeholder="ssclinical" />
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Owner email</div>
            <input value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }} placeholder="csarabia@ssclinical.cl" />
          </div>
        </div>
        <div style={{ marginTop: 10, maxWidth: 420 }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Template inicial</div>
          <select
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
          >
            {(templates.length > 0 ? templates : [{ id: 'RECRUITING', label: 'Recruiting' }]).map((t) => (
              <option key={String(t.id)} value={String(t.id)}>
                {String(t.label || t.id)}
              </option>
            ))}
          </select>
          {templates.length > 0 ? (
            <div style={{ marginTop: 6, fontSize: 12, color: '#666', lineHeight: 1.35 }}>
              {(templates.find((t) => String(t.id) === String(template))?.description || '').trim() || 'Seed mínimo: stages + programs CLIENT/STAFF + automations base.'}
            </div>
          ) : null}
        </div>
        <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={() => createWorkspace().catch(() => {})}
            disabled={creating || !name.trim() || !slug.trim() || !ownerEmail.trim()}
            style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #111', background: '#111', color: '#fff', fontWeight: 800 }}
          >
            {creating ? 'Creando…' : 'Crear Workspace'}
          </button>
          <button onClick={() => load().catch(() => {})} style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #ccc', background: '#fff' }}>
            Refresh
          </button>
          {createStatus ? <span style={{ fontSize: 12, color: '#1a7f37' }}>{createStatus}</span> : null}
          {createError ? <span style={{ fontSize: 12, color: '#b93800' }}>{createError}</span> : null}
        </div>
        {inviteUrl ? (
          <div style={{ marginTop: 10, fontSize: 12, color: '#555' }}>
            Invite link (OWNER):{' '}
            <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{inviteUrl}</span>
          </div>
        ) : null}
      </div>

      <div style={{ marginTop: 14, border: '1px solid #eee', borderRadius: 14, padding: 14, background: '#fff' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 900 }}>Workspaces</div>
            <div style={{ fontSize: 12, color: '#666' }}>
              Administra clientes. Para operar conversaciones, entra al workspace con una cuenta invitada (OWNER/ADMIN).
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#555' }}>
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              Mostrar archivados
            </label>
            <button onClick={() => load().catch(() => {})} style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #ccc', background: '#fff' }}>
              Refresh
            </button>
          </div>
        </div>

        {loading ? <div style={{ marginTop: 12 }}>Cargando…</div> : null}
        {error ? <div style={{ marginTop: 12, color: '#b93800' }}>{error}</div> : null}

        {!loading && !error ? (
          <div style={{ marginTop: 12, border: '1px solid #f0f0f0', borderRadius: 12, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>ID</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Nombre</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Owners</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Miembros</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Creado</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Estado</th>
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((w) => (
                  <tr key={w.id} style={{ borderTop: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 10, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}>{w.id}</td>
                    <td style={{ padding: 10, fontSize: 13 }}>
                      <div style={{ fontWeight: 700 }}>{w.name}</div>
                      <div style={{ fontSize: 12, color: '#666' }}>{w.isSandbox ? 'Sandbox' : 'Prod/Dev'}</div>
                    </td>
                    <td style={{ padding: 10, fontSize: 12 }}>
                      {(w.owners || []).length === 0 ? (
                        <span style={{ color: '#666' }}>—</span>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {(w.owners || []).slice(0, 3).map((o) => (
                            <span key={o.email}>{o.email}</span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: 10, fontSize: 13 }}>{typeof w.membersCount === 'number' ? w.membersCount : '—'}</td>
                    <td style={{ padding: 10, fontSize: 12, color: '#666' }}>{w.createdAt ? String(w.createdAt).slice(0, 19).replace('T', ' ') : '—'}</td>
                    <td style={{ padding: 10, fontSize: 12, color: w.archivedAt ? '#b93800' : '#1a7f37' }}>
                      {w.archivedAt ? 'Archivado' : 'Activo'}
                    </td>
                    <td style={{ padding: 10 }}>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          onClick={() => archiveWorkspace(w.id, !w.archivedAt).catch(() => {})}
                          style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                        >
                          {w.archivedAt ? 'Restaurar' : 'Archivar'}
                        </button>
                        {w.id === 'ssclinical' && !w.archivedAt ? (
                          <button
                            onClick={() => seedSsclinical(w.id).catch(() => {})}
                            style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #111', background: '#111', color: '#fff', fontSize: 12, fontWeight: 800 }}
                          >
                            Seed SSClinical
                          </button>
                        ) : null}
                      </div>
                      {seedStatusByWorkspace[w.id] ? (
                        <div style={{ marginTop: 8, fontSize: 12, color: seedStatusByWorkspace[w.id].startsWith('Error') ? '#b93800' : '#666', whiteSpace: 'pre-wrap' }}>
                          {seedStatusByWorkspace[w.id]}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
};

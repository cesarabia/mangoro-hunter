import React, { useEffect, useMemo, useState } from 'react';
import { apiClient } from '../api/client';

type WorkspaceRow = {
  id: string;
  name: string;
  isSandbox?: boolean;
  createdAt?: string;
  owners?: Array<{ email: string; name: string | null }>;
  membersCount?: number;
};

export const PlatformPage: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<WorkspaceRow[]>([]);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [creating, setCreating] = useState(false);
  const [createStatus, setCreateStatus] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

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
  }, []);

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
    } catch (err: any) {
      setCreateError(err.message || 'No se pudo crear workspace');
    } finally {
      setCreating(false);
    }
  };

  const currentWorkspaceId = useMemo(() => {
    try {
      return localStorage.getItem('workspaceId') || 'default';
    } catch {
      return 'default';
    }
  }, []);

  const switchWorkspace = async (id: string) => {
    try {
      localStorage.setItem('workspaceId', id);
      window.location.href = '/';
    } catch {
      // ignore
    }
  };

  return (
    <div style={{ padding: 16, maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ fontSize: 22, fontWeight: 900 }}>Admin Console — Clientes (Workspaces)</div>
      <div style={{ marginTop: 6, fontSize: 13, color: '#666' }}>
        Crea y administra clientes (multi-tenant). Solo Platform Owner / ADMIN.
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
            <div style={{ fontSize: 12, color: '#666' }}>Workspace actual: <strong>{currentWorkspaceId}</strong></div>
          </div>
          <button onClick={() => load().catch(() => {})} style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #ccc', background: '#fff' }}>
            Refresh
          </button>
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
                  <th style={{ padding: 10, fontSize: 12, color: '#555' }}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => (
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
                    <td style={{ padding: 10 }}>
                      <button
                        onClick={() => switchWorkspace(w.id).catch(() => {})}
                        style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
                      >
                        Abrir
                      </button>
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


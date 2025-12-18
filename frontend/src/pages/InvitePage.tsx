import React, { useEffect, useMemo, useState } from 'react';
import { apiClient } from '../api/client';

export const InvitePage: React.FC = () => {
  const token = useMemo(() => {
    try {
      const path = window.location.pathname || '';
      const parts = path.split('/').filter(Boolean);
      const idx = parts.findIndex((p) => p === 'invite');
      if (idx >= 0 && parts[idx + 1]) return String(parts[idx + 1]);
    } catch {
      // ignore
    }
    return '';
  }, []);

  const [loading, setLoading] = useState(true);
  const [invite, setInvite] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setInvite(null);
      setError('Invite inválido.');
      return;
    }
    setLoading(true);
    setError(null);
    apiClient
      .get(`/api/invites/${encodeURIComponent(token)}`)
      .then((data: any) => {
        setInvite(data);
        setError(null);
      })
      .catch((err: any) => {
        setInvite(null);
        setError(err.message || 'No se pudo cargar el invite');
      })
      .finally(() => setLoading(false));
  }, [token]);

  const accept = async () => {
    if (!token) return;
    setSubmitError(null);
    if (!password || password.length < 8) {
      setSubmitError('Password demasiado corto (mínimo 8).');
      return;
    }
    if (password !== confirmPassword) {
      setSubmitError('Los passwords no coinciden.');
      return;
    }
    setSubmitting(true);
    try {
      const res: any = await apiClient.post(`/api/invites/${encodeURIComponent(token)}/accept`, {
        name: name.trim() || null,
        password
      });
      const jwt = typeof res?.token === 'string' ? res.token : null;
      const workspaceId = typeof res?.workspaceId === 'string' ? res.workspaceId : 'default';
      if (!jwt) throw new Error('No se recibió token.');
      localStorage.setItem('token', jwt);
      localStorage.setItem('workspaceId', workspaceId);
      window.location.href = '/';
    } catch (err: any) {
      setSubmitError(err.message || 'No se pudo aceptar la invitación');
    } finally {
      setSubmitting(false);
    }
  };

  const cardStyle: React.CSSProperties = {
    maxWidth: 520,
    margin: '40px auto',
    border: '1px solid #eee',
    borderRadius: 14,
    padding: 16,
    background: '#fff'
  };

  return (
    <div style={{ minHeight: '100vh', background: '#fafafa', padding: 16 }}>
      <div style={cardStyle}>
        <div style={{ fontWeight: 900, fontSize: 20 }}>Aceptar invitación</div>
        <div style={{ marginTop: 6, fontSize: 13, color: '#666' }}>
          Crea tu acceso a Hunter CRM (Agent OS). No compartas este link.
        </div>

        {loading ? <div style={{ marginTop: 16 }}>Cargando…</div> : null}
        {!loading && error ? <div style={{ marginTop: 16, color: '#b93800' }}>{error}</div> : null}

        {!loading && invite?.ok ? (
          <>
            <div style={{ marginTop: 14, fontSize: 13 }}>
              <div>
                Workspace: <strong>{invite.workspaceName || invite.workspaceId}</strong>
              </div>
              <div>
                Email: <strong>{invite.email}</strong>
              </div>
              <div>
                Rol: <strong>{invite.role}</strong>
              </div>
              {invite.expired ? (
                <div style={{ marginTop: 8, color: '#b93800' }}>Este invite expiró.</div>
              ) : invite.acceptedAt ? (
                <div style={{ marginTop: 8, color: '#b93800' }}>Este invite ya fue usado.</div>
              ) : null}
            </div>

            {!invite.expired && !invite.acceptedAt ? (
              <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Nombre (opcional)</div>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ej: Camila Pérez"
                    style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                  />
                </div>
                <div>
                  <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Password</div>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Mínimo 8 caracteres"
                    style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                  />
                </div>
                <div>
                  <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Confirmar password</div>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repite tu password"
                    style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd' }}
                  />
                </div>

                <button
                  onClick={() => accept().catch(() => {})}
                  disabled={submitting}
                  style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #111', background: '#111', color: '#fff', fontWeight: 800 }}
                >
                  {submitting ? 'Creando acceso…' : 'Aceptar y entrar'}
                </button>
                {submitError ? <div style={{ fontSize: 12, color: '#b93800' }}>{submitError}</div> : null}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
};


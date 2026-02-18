import React, { useState } from 'react';
import { apiClient } from '../api/client';

interface Props {
  onLogin: (token: string) => void;
}

export const LoginPage: React.FC<Props> = ({ onLogin }) => {
  const [email, setEmail] = useState('demo@example.com');
  const [password, setPassword] = useState('demo');
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'login' | 'requestReset' | 'confirmReset'>(() => {
    if (typeof window === 'undefined') return 'login';
    const token = new URLSearchParams(window.location.search).get('resetToken');
    return token ? 'confirmReset' : 'login';
  });
  const [resetEmail, setResetEmail] = useState('');
  const [resetStatus, setResetStatus] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetUrl, setResetUrl] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return new URLSearchParams(window.location.search).get('resetToken') || '';
  });
  const [newPassword, setNewPassword] = useState('');
  const [newPassword2, setNewPassword2] = useState('');
  const [confirmStatus, setConfirmStatus] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    try {
      const res = await apiClient.post('/api/auth/login', { email, password });
      onLogin(res.token);
    } catch (err: any) {
      setError(err.message || 'Error al iniciar sesión');
    }
  };

  const requestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetStatus(null);
    setResetError(null);
    setResetUrl(null);
    try {
      const res: any = await apiClient.post('/api/auth/password-reset/request', { email: resetEmail });
      setResetStatus(
        res?.message || 'Si existe una cuenta para ese correo, enviamos instrucciones.',
      );
      if (typeof res?.resetUrl === 'string' && res.resetUrl.trim()) {
        setResetUrl(res.resetUrl.trim());
      }
    } catch (err: any) {
      setResetError(err.message || 'No se pudo solicitar el reset.');
    }
  };

  const confirmReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setConfirmStatus(null);
    setConfirmError(null);
    if (!resetToken.trim()) {
      setConfirmError('Token requerido.');
      return;
    }
    if (newPassword.length < 8) {
      setConfirmError('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (newPassword !== newPassword2) {
      setConfirmError('Las contraseñas no coinciden.');
      return;
    }
    try {
      await apiClient.post('/api/auth/password-reset/confirm', {
        token: resetToken.trim(),
        password: newPassword,
      });
      setConfirmStatus('Contraseña actualizada. Ya puedes iniciar sesión.');
      setMode('login');
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('resetToken');
        window.history.replaceState({}, '', url.pathname + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : ''));
      } catch {
        // ignore
      }
      setResetToken('');
      setNewPassword('');
      setNewPassword2('');
    } catch (err: any) {
      setConfirmError(err.message || 'No se pudo actualizar la contraseña.');
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {mode === 'login' ? (
        <form onSubmit={handleSubmit} style={{ border: '1px solid #ddd', padding: 24, borderRadius: 8, width: 360, background: '#fff' }}>
          <h1 style={{ fontSize: 20, marginBottom: 16 }}>Ingreso Hunter CRM</h1>
          <label style={{ display: 'block', marginBottom: 8 }}>
            <span>Email</span>
            <input
              style={{ width: '100%', padding: 8, border: '1px solid #ccc', borderRadius: 4 }}
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
          </label>
          <label style={{ display: 'block', marginBottom: 8 }}>
            <span>Password</span>
            <input
              style={{ width: '100%', padding: 8, border: '1px solid #ccc', borderRadius: 4 }}
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </label>
          {error && <p style={{ color: 'red', marginBottom: 8 }}>{error}</p>}
          {confirmStatus ? <p style={{ color: '#1a7f37', marginBottom: 8 }}>{confirmStatus}</p> : null}
          <button style={{ width: '100%', padding: 8, background: '#000', color: '#fff', borderRadius: 4 }}>
            Entrar
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('requestReset');
              setResetEmail(email);
              setResetStatus(null);
              setResetError(null);
            }}
            style={{ marginTop: 10, width: '100%', padding: 8, borderRadius: 4, border: '1px solid #ccc', background: '#fff' }}
          >
            ¿Olvidaste tu contraseña?
          </button>
        </form>
      ) : null}

      {mode === 'requestReset' ? (
        <form onSubmit={requestReset} style={{ border: '1px solid #ddd', padding: 24, borderRadius: 8, width: 420, background: '#fff' }}>
          <h1 style={{ fontSize: 20, marginBottom: 12 }}>Reset de contraseña</h1>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 10 }}>
            Ingresa tu correo. Si existe cuenta, recibirás instrucciones.
          </div>
          <label style={{ display: 'block', marginBottom: 8 }}>
            <span>Email</span>
            <input
              style={{ width: '100%', padding: 8, border: '1px solid #ccc', borderRadius: 4 }}
              value={resetEmail}
              onChange={(e) => setResetEmail(e.target.value)}
            />
          </label>
          {resetStatus ? <p style={{ color: '#1a7f37', marginBottom: 8 }}>{resetStatus}</p> : null}
          {resetError ? <p style={{ color: 'red', marginBottom: 8 }}>{resetError}</p> : null}
          {resetUrl ? (
            <div style={{ marginBottom: 10, border: '1px solid #e5e7eb', borderRadius: 8, padding: 8, background: '#f9fafb' }}>
              <div style={{ fontSize: 12, color: '#555', marginBottom: 6 }}>DEV: enlace de recuperación</div>
              <div style={{ fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' }}>{resetUrl}</div>
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(resetUrl).catch(() => {})}
                style={{ marginTop: 8, padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc', background: '#fff', fontSize: 12 }}
              >
                Copiar link
              </button>
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={{ flex: 1, padding: 8, background: '#000', color: '#fff', borderRadius: 4 }}>Enviar instrucciones</button>
            <button
              type="button"
              onClick={() => setMode('login')}
              style={{ flex: 1, padding: 8, borderRadius: 4, border: '1px solid #ccc', background: '#fff' }}
            >
              Volver
            </button>
          </div>
        </form>
      ) : null}

      {mode === 'confirmReset' ? (
        <form onSubmit={confirmReset} style={{ border: '1px solid #ddd', padding: 24, borderRadius: 8, width: 420, background: '#fff' }}>
          <h1 style={{ fontSize: 20, marginBottom: 12 }}>Nueva contraseña</h1>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 10 }}>
            Ingresa una nueva contraseña para continuar.
          </div>
          <label style={{ display: 'block', marginBottom: 8 }}>
            <span>Token</span>
            <input
              style={{ width: '100%', padding: 8, border: '1px solid #ccc', borderRadius: 4 }}
              value={resetToken}
              onChange={(e) => setResetToken(e.target.value)}
            />
          </label>
          <label style={{ display: 'block', marginBottom: 8 }}>
            <span>Nueva contraseña</span>
            <input
              style={{ width: '100%', padding: 8, border: '1px solid #ccc', borderRadius: 4 }}
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </label>
          <label style={{ display: 'block', marginBottom: 8 }}>
            <span>Repite contraseña</span>
            <input
              style={{ width: '100%', padding: 8, border: '1px solid #ccc', borderRadius: 4 }}
              type="password"
              value={newPassword2}
              onChange={(e) => setNewPassword2(e.target.value)}
            />
          </label>
          {confirmError ? <p style={{ color: 'red', marginBottom: 8 }}>{confirmError}</p> : null}
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={{ flex: 1, padding: 8, background: '#000', color: '#fff', borderRadius: 4 }}>Actualizar</button>
            <button
              type="button"
              onClick={() => setMode('login')}
              style={{ flex: 1, padding: 8, borderRadius: 4, border: '1px solid #ccc', background: '#fff' }}
            >
              Volver
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
};

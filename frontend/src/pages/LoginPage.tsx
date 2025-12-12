import React, { useState } from 'react';
import { apiClient } from '../api/client';

interface Props {
  onLogin: (token: string) => void;
}

export const LoginPage: React.FC<Props> = ({ onLogin }) => {
  const [email, setEmail] = useState('demo@example.com');
  const [password, setPassword] = useState('demo');
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <form onSubmit={handleSubmit} style={{ border: '1px solid #ddd', padding: 24, borderRadius: 8, width: 320 }}>
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
        <button style={{ width: '100%', padding: 8, background: '#000', color: '#fff', borderRadius: 4 }}>
          Entrar
        </button>
      </form>
    </div>
  );
};

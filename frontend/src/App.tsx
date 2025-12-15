import React, { useEffect, useState } from 'react';
import { LoginPage } from './pages/LoginPage';
import { InboxPage } from './pages/InboxPage';
import { SettingsPage } from './pages/SettingsPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { AgendaPage } from './pages/AgendaPage';

type View = 'inbox' | 'settings' | 'agenda';

const decodeUserRole = (token: string | null): string | null => {
  if (!token) return null;
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const decoded = JSON.parse(atob(payload));
    return decoded.role || null;
  } catch {
    return null;
  }
};

export const App: React.FC = () => {
  const [hydrated, setHydrated] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<View>('inbox');
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '';

  useEffect(() => {
    setHydrated(true);
    try {
      const stored = localStorage.getItem('token');
      if (stored) {
        setToken(stored);
      }
    } catch {
      setToken(null);
    }
  }, []);

  const userRole = decodeUserRole(token);
  const isAdmin = userRole === 'ADMIN';

  useEffect(() => {
    if ((view === 'settings' || view === 'agenda') && !isAdmin) {
      setView('inbox');
    }
  }, [view, isAdmin]);

  if (!hydrated) {
    return <div style={{ padding: 32 }}>Cargando CRM...</div>;
  }

  if (pathname.startsWith('/privacy')) {
    return <PrivacyPage />;
  }

  const handleLogin = (newToken: string) => {
    localStorage.setItem('token', newToken);
    setToken(newToken);
    setView('inbox');
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setToken(null);
    setView('inbox');
  };

  if (!token) {
    return <LoginPage onLogin={handleLogin} />;
  }

  const handleOpenSettings = () => {
    if (isAdmin) {
      setView('settings');
    }
  };

  const handleOpenAgenda = () => {
    if (isAdmin) {
      setView('agenda');
    }
  };

  if (view === 'settings' && isAdmin) {
    return <SettingsPage onBack={() => setView('inbox')} />;
  }

  if (view === 'agenda' && isAdmin) {
    return <AgendaPage onBack={() => setView('inbox')} />;
  }

  return (
    <InboxPage
      onLogout={handleLogout}
      showSettings={isAdmin}
      onOpenSettings={handleOpenSettings}
      showAgenda={isAdmin}
      onOpenAgenda={handleOpenAgenda}
      enableSimulator
    />
  );
};

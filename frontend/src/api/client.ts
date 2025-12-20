export const apiClient = {
  async request(path: string, options: RequestInit = {}) {
    const token = localStorage.getItem('token');
    const workspaceId = localStorage.getItem('workspaceId');
    const method = (options.method || 'GET').toUpperCase();
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
    const workspaceHeader: HeadersInit = workspaceId ? { 'X-Workspace-Id': workspaceId } : {};

    const res = await fetch(path, {
      ...options,
      cache: method === 'GET' ? 'no-store' : options.cache,
      headers: {
        ...headers,
        ...workspaceHeader,
        ...(options.headers || {})
      }
    });

    if (res.status === 204) {
      if (!res.ok) {
        throw new Error(`Error HTTP ${res.status}`);
      }
      return null;
    }

    const text = await res.text();
    if (!res.ok) {
      let errorMessage = `Error HTTP ${res.status}`;
      let errorData: any = null;
      if (text) {
        try {
          const parsed = JSON.parse(text);
          errorData = parsed;
          if (parsed?.error) {
            errorMessage = parsed.error;
          } else if (typeof parsed === 'string') {
            errorMessage = parsed;
          }
        } catch {
          errorMessage = text;
        }
      }
      const error = new Error(errorMessage);
      (error as any).status = res.status;
      (error as any).data = errorData;
      throw error;
    }

    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  },

  get(path: string) {
    return this.request(path);
  },

  post(path: string, body: any) {
    return this.request(path, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  },

  put(path: string, body: any) {
    return this.request(path, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
  },

  patch(path: string, body: any) {
    return this.request(path, {
      method: 'PATCH',
      body: JSON.stringify(body)
    });
  }
};

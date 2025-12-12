export const apiClient = {
  async request(path: string, options: RequestInit = {}) {
    const token = localStorage.getItem('token');
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    };

    const res = await fetch(path, {
      ...options,
      headers: {
        ...headers,
        ...(options.headers || {})
      }
    });

    if (!res.ok) {
      throw new Error(`Error HTTP ${res.status}`);
    }

    return res.json();
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

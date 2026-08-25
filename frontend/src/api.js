const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5001/api';
const FILE_BASE = API_BASE.replace(/\/api\/?$/, '');
const TOKEN_KEY = 'adinnPlanningToken';
const USER_KEY = 'adinnPlanningUser';

function readStorage(key) {
  return localStorage.getItem(key) || sessionStorage.getItem(key);
}

export function getToken() {
  return readStorage(TOKEN_KEY);
}

export function setSession(token, user, rememberMe = false) {
  clearSession();
  const storage = rememberMe ? localStorage : sessionStorage;
  storage.setItem(TOKEN_KEY, token);
  storage.setItem(USER_KEY, JSON.stringify(user));
}

export function getSavedUser() {
  try {
    return JSON.parse(readStorage(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
}

export function fileUrl(path) {
  if (!path) return '#';
  if (path.startsWith('http')) return path;
  return `${FILE_BASE}${path}`;
}

async function parseResponse(response, path) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/csv') || contentType.includes('spreadsheetml') || contentType.includes('application/vnd.ms-excel')) return response.blob();
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.message || 'Something went wrong';
    if (response.status === 401 && path !== '/auth/login') {
      clearSession();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('adinn-auth-expired', { detail: { message } }));
      }
    }
    throw new Error(message);
  }
  return data;
}

export async function api(path, options = {}) {
  const token = getToken();
  const headers = options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  });
  return parseResponse(response, path);
}

export function uploadWithProgress(path, formData, { onProgress, signal } = {}) {
  const token = getToken();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}${path}`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = event => {
      if (onProgress && event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* non-JSON response */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
        return;
      }
      const message = data.message || 'Something went wrong';
      if (xhr.status === 401) {
        clearSession();
        window.dispatchEvent(new CustomEvent('adinn-auth-expired', { detail: { message } }));
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error('Network error while uploading'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener('abort', () => xhr.abort());
    }
    xhr.send(formData);
  });
}

export async function login(email, password, rememberMe = false) {
  const data = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
  setSession(data.token, data.user, rememberMe);
  return data.user;
}

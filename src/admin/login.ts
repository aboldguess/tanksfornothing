// login.ts
// @ts-nocheck
// Summary: Handles admin authentication from the standalone login page.
// Structure: submit handler -> fetch request -> redirect on success.
// Usage: Included by login.html.

async function handleLogin(e: Event): Promise<void> {
  e.preventDefault();
  const msg = document.getElementById('loginError');
  if (msg) msg.textContent = '';
  try {
    const passwordField = document.getElementById('password') as HTMLInputElement | null;
    if (!passwordField) throw new Error('Password field missing');
    const password = passwordField.value;
    const res = await fetch('/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ password })
    });
    console.debug('Admin login status', res.status);
    if (res.ok) {
      window.location.href = 'admin.html';
    } else {
      const data = await res.json().catch(() => ({}));
      if (msg) msg.textContent = data.error || 'Login failed';
    }
  } catch (err) {
    console.error('Login request failed', err);
    const message = err instanceof Error ? err.message : 'Login failed';
    if (msg) msg.textContent = message;
  }
}

const form = document.getElementById('loginForm');
if (form) form.addEventListener('submit', handleLogin);

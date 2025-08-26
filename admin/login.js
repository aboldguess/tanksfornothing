// login.js
// Summary: Handles admin authentication from the standalone login page.
// Structure: submit handler -> fetch request -> redirect on success.
// Usage: Included by login.html.

async function handleLogin(e) {
  e.preventDefault();
  const msg = document.getElementById('loginError');
  if (msg) msg.textContent = '';
  try {
    const password = document.getElementById('password').value;
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
    if (msg) msg.textContent = err.message || 'Login failed';
  }
}

document.getElementById('loginForm').addEventListener('submit', handleLogin);

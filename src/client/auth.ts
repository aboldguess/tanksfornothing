// auth.ts
// Summary: Handles signup and login form submissions plus navbar profile menu for Tanks for Nothing.
// Structure: detect which form is present -> attach submit handlers -> toggle profile menu -> optional sign-out.
// Usage: Included by login.html and signup.html pages.
// ---------------------------------------------------------------------------

function initMenu(): void {
  const menu = document.querySelector('.profile-menu');
  const pic = document.getElementById('profilePic');
  if (pic && menu instanceof HTMLElement) {
    pic.addEventListener('click', () => menu.classList.toggle('show'));
  }
  const signOut = document.getElementById('signOut');
  if (signOut)
    signOut.addEventListener('click', async (e) => {
      e.preventDefault();
      await fetch('/api/logout', { method: 'POST' });
    });
}

async function handleSignup(e: Event): Promise<void> {
  e.preventDefault();
  const usernameEl = document.getElementById('signupUser') as HTMLInputElement | null;
  const passwordEl = document.getElementById('signupPass') as HTMLInputElement | null;
  const messageEl = document.getElementById('authError');
  if (!usernameEl || !passwordEl || !messageEl) return;
  const username = usernameEl.value;
  const password = passwordEl.value;
  if (password.length < 6) {
    messageEl.textContent = 'Password must be at least 6 characters';
    return;
  }
  const res = await fetch('/api/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (res.ok) {
    messageEl.style.color = '#80ff80';
    messageEl.textContent = 'Signup successful. Please log in.';
  } else {
    const data = await res.json().catch(() => ({}));
    messageEl.textContent = data.error || 'Signup failed';
  }
}

async function handleLogin(e: Event): Promise<void> {
  e.preventDefault();
  const usernameEl = document.getElementById('loginUser') as HTMLInputElement | null;
  const passwordEl = document.getElementById('loginPass') as HTMLInputElement | null;
  const messageEl = document.getElementById('authError');
  if (!usernameEl || !passwordEl || !messageEl) return;
  const username = usernameEl.value;
  const password = passwordEl.value;
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (res.ok) {
    window.location.href = '/index.html';
  } else {
    const data = await res.json().catch(() => ({}));
    messageEl.textContent = data.error || 'Login failed';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initMenu();
  const signupForm = document.getElementById('signupForm');
  if (signupForm) signupForm.addEventListener('submit', handleSignup);
  const loginForm = document.getElementById('loginForm');
  if (loginForm) loginForm.addEventListener('submit', handleLogin);
});

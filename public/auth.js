// auth.js
// Summary: Handles signup and login form submissions plus navbar profile menu for Tanks for Nothing.
// Structure: detect which form is present -> attach submit handlers -> toggle profile menu -> optional sign-out.
// Usage: Included by login.html and signup.html pages.
// ---------------------------------------------------------------------------

function initMenu() {
  const menu = document.querySelector('.profile-menu');
  const pic = document.getElementById('profilePic');
  if (pic) pic.addEventListener('click', () => menu.classList.toggle('show'));
  const signOut = document.getElementById('signOut');
  if (signOut)
    signOut.addEventListener('click', async (e) => {
      e.preventDefault();
      await fetch('/api/logout', { method: 'POST' });
    });
}

async function handleSignup(e) {
  e.preventDefault();
  const username = document.getElementById('signupUser').value;
  const password = document.getElementById('signupPass').value;
  const res = await fetch('/api/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const msg = document.getElementById('authError');
  if (res.ok) {
    msg.style.color = '#80ff80';
    msg.textContent = 'Signup successful. Please log in.';
  } else {
    const data = await res.json().catch(() => ({}));
    msg.textContent = data.error || 'Signup failed';
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUser').value;
  const password = document.getElementById('loginPass').value;
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const msg = document.getElementById('authError');
  if (res.ok) {
    window.location.href = '/index.html';
  } else {
    const data = await res.json().catch(() => ({}));
    msg.textContent = data.error || 'Login failed';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initMenu();
  const signupForm = document.getElementById('signupForm');
  if (signupForm) signupForm.addEventListener('submit', handleSignup);
  const loginForm = document.getElementById('loginForm');
  if (loginForm) loginForm.addEventListener('submit', handleLogin);
});

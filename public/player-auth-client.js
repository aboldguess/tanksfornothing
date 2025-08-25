// player-auth-client.js
// Summary: Client-side authentication helper for Tanks for Nothing. Handles signup/login
//          flows, profile menu interactions and displays player statistics.
// Structure: DOM queries -> form handlers -> helper functions -> profile menu logic.
// Usage: Included by index.html; requires corresponding HTML elements with IDs used below.
// ---------------------------------------------------------------------------

const authPanel = document.getElementById('auth');
const signupForm = document.getElementById('signupForm');
const loginForm = document.getElementById('loginForm');
const authError = document.getElementById('authError');
const lobby = document.getElementById('lobby');
const navbar = document.getElementById('navbar');
const statsSpan = document.getElementById('stats');
const profileMenu = document.getElementById('profileMenu');
const profileBtn = document.getElementById('profileBtn');
const logoutLink = document.getElementById('logoutLink');

function showError(msg) {
  authError.textContent = msg;
  console.error(msg);
}

signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = signupForm.username.value.trim();
  const password = signupForm.password.value;
  try {
    const res = await fetch('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!res.ok) {
      const j = await res.json();
      showError(j.error || 'signup failed');
      return;
    }
    alert('Signup successful. Please log in.');
  } catch (err) {
    showError('network error');
  }
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = loginForm.username.value.trim();
  const password = loginForm.password.value;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!res.ok) {
      const j = await res.json();
      showError(j.error || 'login failed');
      return;
    }
    const data = await res.json();
    authPanel.style.display = 'none';
    lobby.style.display = 'block';
    statsSpan.textContent = `Games: ${data.games} | Kills: ${data.kills} | Deaths: ${data.deaths}`;
    navbar.style.display = 'block';
  } catch (err) {
    showError('network error');
  }
});

profileBtn.addEventListener('click', () => {
  profileMenu.classList.toggle('show');
});

logoutLink.addEventListener('click', async (e) => {
  e.preventDefault();
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
});

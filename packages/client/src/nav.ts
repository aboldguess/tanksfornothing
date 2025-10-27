// nav.ts
// Summary: Handles navbar profile menu interactions and enforces authentication for Tanks for Nothing pages.
// Structure: check auth -> update navbar -> attach menu toggle and sign-out handlers.
// Usage: Imported by pages requiring login; redirects to login.html if not authenticated.
// ---------------------------------------------------------------------------

interface StatsResponse {
  username: string;
}

async function initNav(): Promise<void> {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) throw new Error('not auth');
    const data = (await res.json()) as StatsResponse;
    const title = document.querySelector('#navbar span');
    if (title) title.textContent = `Tanks for Nothing - ${data.username}`;
  } catch {
    window.location.href = '/login.html';
    return;
  }

  const menu = document.querySelector('.profile-menu');
  const pic = document.getElementById('profilePic');
  if (pic && menu instanceof HTMLElement) {
    pic.addEventListener('click', () => menu.classList.toggle('show'));
  }

  const signOut = document.getElementById('signOut');
  if (signOut) {
    signOut.addEventListener('click', async (e) => {
      e.preventDefault();
      await fetch('/api/logout', { method: 'POST' });
      window.location.href = '/login.html';
    });
  }
}

document.addEventListener('DOMContentLoaded', initNav);

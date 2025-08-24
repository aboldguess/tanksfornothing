// admin.js
// Summary: Handles admin login and CRUD actions for Tanks for Nothing.
// Uses secure httpOnly cookie set by server and provides logout endpoint.
// Structure: auth helpers -> data loaders -> CRUD functions -> UI handlers.
// Usage: Included by admin.html.
// ---------------------------------------------------------------------------

function toggleMenu() {
  document.getElementById('profileMenu').classList.toggle('show');
}

async function signOut() {
  await fetch('/admin/logout', { method: 'POST' });
  location.reload();
}

async function login() {
  const password = document.getElementById('password').value;
  const res = await fetch('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
  if (res.ok) {
    // Cookie is set server-side; simply render dashboard
    showDashboard();
  } else alert('Login failed');
}

function showDashboard() {
  document.getElementById('login').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';
  loadData();
}

async function loadData() {
  const tanks = await fetch('/api/tanks').then(r => r.json());
  const ammo = await fetch('/api/ammo').then(r => r.json());
  const terrain = await fetch('/api/terrain').then(r => r.json());
  document.getElementById('tankList').innerText = JSON.stringify(tanks);
  document.getElementById('ammoList').innerText = JSON.stringify(ammo);
  document.getElementById('terrainName').innerText = terrain.terrain;
}

async function addTank() {
  await fetch('/api/tanks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: document.getElementById('tankName').value,
      nation: document.getElementById('tankNation').value,
      br: parseFloat(document.getElementById('tankBR').value)
    })
  });
  loadData();
}

async function addAmmo() {
  await fetch('/api/ammo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: document.getElementById('ammoName').value,
      type: document.getElementById('ammoType').value
    })
  });
  loadData();
}

async function setTerrain() {
  await fetch('/api/terrain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ terrain: document.getElementById('terrainInput').value })
  });
  loadData();
}

// Check on load if admin cookie is present via server endpoint
async function checkAdmin() {
  const res = await fetch('/admin/status');
  if (res.ok) showDashboard();
}
checkAdmin();

// admin.js
// Summary: Handles admin login and CRUD actions for Tanks for Nothing.
// Structure: auth helpers -> data loaders -> CRUD functions -> UI handlers.
// Usage: Included by admin.html.
// ---------------------------------------------------------------------------
function isAdmin() {
  return document.cookie.includes('admin=true');
}

function toggleMenu() {
  document.getElementById('profileMenu').classList.toggle('show');
}

function signOut() {
  document.cookie = 'admin=false; Max-Age=0';
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
    document.cookie = 'admin=true';
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

if (isAdmin()) showDashboard();

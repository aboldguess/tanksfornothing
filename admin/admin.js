// admin.js
// Summary: Handles admin login and CRUD actions for nations, tanks, ammo and terrain across
//          separate admin pages linked by a sidebar. Terrain management now uses a table with
//          3D thumbnails and an in-page editor.
// Uses secure httpOnly cookie set by server and provides logout and game restart endpoints.
// Structure: auth helpers -> data loaders -> CRUD functions -> restart helpers -> UI handlers.
// Usage: Included by all files in /admin.
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
  console.debug('Admin login response', res.status);
  if (res.ok) {
    // Cookie is set server-side; render the page
    showApp();
  } else alert('Login failed');
}

function showApp() {
  document.getElementById('login').style.display = 'none';
  const app = document.getElementById('app');
  if (app) app.style.display = 'flex';
  loadData();
}

// In-memory caches for editing
let nationsCache = [];
let tanksCache = [];
let ammoCache = [];
let terrainsCache = [];
let editingNationIndex = null;
let editingTankIndex = null;
let editingAmmoIndex = null;
let editingTerrainIndex = null;
let currentTerrainIndex = 0;
let tankNationChart = null;

async function loadData() {
  nationsCache = await fetch('/api/nations').then(r => r.json());
  tanksCache = await fetch('/api/tanks').then(r => r.json());
  ammoCache = await fetch('/api/ammo').then(r => r.json());
  const terrainData = await fetch('/api/terrains').then(r => r.json());
  terrainsCache = terrainData.terrains;
  currentTerrainIndex = terrainData.current ?? 0;

  // Populate nation selects for tank and ammo forms
  const nationOptions = nationsCache.map(n => `<option value="${n}">${n}</option>`).join('');
  const tankNation = document.getElementById('tankNation');
  if (tankNation) tankNation.innerHTML = nationOptions;
  const ammoNation = document.getElementById('ammoNation');
  if (ammoNation) ammoNation.innerHTML = nationOptions;

  // Render nation list
  const nationDiv = document.getElementById('nationList');
  if (nationDiv) {
    nationDiv.innerHTML = nationsCache.map((n, i) =>
      `<div>${n} <button data-i="${i}" class="edit-nation">Edit</button><button data-i="${i}" class="del-nation">Delete</button></div>`
    ).join('');
    nationDiv.querySelectorAll('.edit-nation').forEach(btn => btn.addEventListener('click', () => editNation(btn.dataset.i)));
    nationDiv.querySelectorAll('.del-nation').forEach(btn => btn.addEventListener('click', () => deleteNation(btn.dataset.i)));
  }

  const tankDiv = document.getElementById('tankList');
  if (tankDiv) {
    tankDiv.innerHTML = tanksCache.map((t, i) =>
      `<div>${t.name} (${t.nation}) BR ${t.br} <button data-i="${i}" class="edit-tank">Edit</button><button data-i="${i}" class="del-tank">Delete</button></div>`
    ).join('');
    tankDiv.querySelectorAll('.edit-tank').forEach(btn => btn.addEventListener('click', () => editTank(btn.dataset.i)));
    tankDiv.querySelectorAll('.del-tank').forEach(btn => btn.addEventListener('click', () => deleteTank(btn.dataset.i)));
  }

  const ammoDiv = document.getElementById('ammoList');
  if (ammoDiv) {
    ammoDiv.innerHTML = ammoCache.map((a, i) =>
      `<div>${a.name} (${a.nation} - ${a.type}) <button data-i="${i}" class="edit-ammo">Edit</button><button data-i="${i}" class="del-ammo">Delete</button></div>`
    ).join('');
    ammoDiv.querySelectorAll('.edit-ammo').forEach(btn => btn.addEventListener('click', () => editAmmo(btn.dataset.i)));
    ammoDiv.querySelectorAll('.del-ammo').forEach(btn => btn.addEventListener('click', () => deleteAmmo(btn.dataset.i)));
  }

  renderTerrainTable();

  if (document.getElementById('nationName')) clearNationForm();
  if (document.getElementById('tankName')) clearTankForm();
  if (document.getElementById('ammoName')) clearAmmoForm();
  if (document.getElementById('terrainName')) {
    clearTerrainForm();
    document.getElementById('editorCard').style.display = 'none';
  }
  updateStats();
}

function collectNationForm() {
  return { name: document.getElementById('nationName').value };
}

async function addNation() {
  const payload = collectNationForm();
  const method = editingNationIndex === null ? 'POST' : 'PUT';
  const url = editingNationIndex === null ? '/api/nations' : `/api/nations/${editingNationIndex}`;
  await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  editingNationIndex = null;
  document.getElementById('addNationBtn').innerText = 'Add Nation';
  clearNationForm();
  loadData();
}

function editNation(i) {
  const n = nationsCache[i];
  document.getElementById('nationName').value = n;
  editingNationIndex = i;
  document.getElementById('addNationBtn').innerText = 'Update Nation';
}

async function deleteNation(i) {
  await fetch(`/api/nations/${i}`, { method: 'DELETE' });
  loadData();
}

function clearNationForm() {
  document.getElementById('nationName').value = '';
}

function collectTankForm() {
  return {
    name: document.getElementById('tankName').value,
    nation: document.getElementById('tankNation').value,
    br: parseFloat(document.getElementById('tankBR').value),
    class: document.getElementById('tankClass').value,
    armor: parseInt(document.getElementById('tankArmor').value, 10),
    cannonCaliber: parseInt(document.getElementById('tankCaliber').value, 10),
    ammo: Array.from(document.querySelectorAll('input[name="tankAmmo"]:checked')).map(cb => cb.value),
    crew: parseInt(document.getElementById('tankCrew').value, 10),
    engineHp: parseInt(document.getElementById('tankHP').value, 10),
    maxSpeed: parseInt(document.getElementById('tankMaxSpeed').value, 10),
    maxReverseSpeed: parseFloat(document.getElementById('tankMaxReverse').value),
    incline: parseInt(document.getElementById('tankIncline').value, 10),
    bodyRotation: parseInt(document.getElementById('tankBodyRot').value, 10),
    turretRotation: parseInt(document.getElementById('tankTurretRot').value, 10)
  };
}

async function addTank() {
  const payload = collectTankForm();
  const method = editingTankIndex === null ? 'POST' : 'PUT';
  const url = editingTankIndex === null ? '/api/tanks' : `/api/tanks/${editingTankIndex}`;
  await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  editingTankIndex = null;
  document.getElementById('addTankBtn').innerText = 'Add Tank';
  clearTankForm();
  loadData();
}

function editTank(i) {
  const t = tanksCache[i];
  document.getElementById('tankName').value = t.name;
  document.getElementById('tankNation').value = t.nation;
  document.getElementById('tankBR').value = t.br; document.getElementById('brVal').innerText = t.br;
  document.getElementById('tankClass').value = t.class;
  document.getElementById('tankArmor').value = t.armor; document.getElementById('armorVal').innerText = t.armor;
  document.getElementById('tankCaliber').value = t.cannonCaliber; document.getElementById('caliberVal').innerText = t.cannonCaliber;
  document.querySelectorAll('input[name="tankAmmo"]').forEach(cb => { cb.checked = t.ammo.includes(cb.value); });
  document.getElementById('tankCrew').value = t.crew; document.getElementById('crewVal').innerText = t.crew;
  document.getElementById('tankHP').value = t.engineHp; document.getElementById('hpVal').innerText = t.engineHp;
  document.getElementById('tankMaxSpeed').value = t.maxSpeed ?? 10; document.getElementById('maxSpeedVal').innerText = t.maxSpeed ?? 10;
  document.getElementById('tankMaxReverse').value = t.maxReverseSpeed ?? 0; document.getElementById('maxReverseVal').innerText = t.maxReverseSpeed ?? 0;
  document.getElementById('tankIncline').value = t.incline; document.getElementById('inclineVal').innerText = t.incline;
  document.getElementById('tankBodyRot').value = t.bodyRotation; document.getElementById('bodyRotVal').innerText = t.bodyRotation;
  document.getElementById('tankTurretRot').value = t.turretRotation; document.getElementById('turretRotVal').innerText = t.turretRotation;
  editingTankIndex = i;
  document.getElementById('addTankBtn').innerText = 'Update Tank';
}

async function deleteTank(i) {
  await fetch(`/api/tanks/${i}`, { method: 'DELETE' });
  loadData();
}

function clearTankForm() {
  document.getElementById('tankName').value = '';
  document.getElementById('tankNation').value = nationsCache[0] || '';
  document.getElementById('tankBR').value = 1; document.getElementById('brVal').innerText = '';
  document.getElementById('tankClass').value = 'Light/Scout';
  document.getElementById('tankArmor').value = 10; document.getElementById('armorVal').innerText = '';
  document.getElementById('tankCaliber').value = 20; document.getElementById('caliberVal').innerText = '';
  document.querySelectorAll('input[name="tankAmmo"]').forEach(cb => { cb.checked = false; });
  document.getElementById('tankCrew').value = 1; document.getElementById('crewVal').innerText = '';
  document.getElementById('tankHP').value = 100; document.getElementById('hpVal').innerText = '';
  document.getElementById('tankMaxSpeed').value = 10; document.getElementById('maxSpeedVal').innerText = '';
  document.getElementById('tankMaxReverse').value = 0; document.getElementById('maxReverseVal').innerText = '';
  document.getElementById('tankIncline').value = 2; document.getElementById('inclineVal').innerText = '';
  document.getElementById('tankBodyRot').value = 1; document.getElementById('bodyRotVal').innerText = '';
  document.getElementById('tankTurretRot').value = 1; document.getElementById('turretRotVal').innerText = '';
}

function collectAmmoForm() {
  return {
    name: document.getElementById('ammoName').value,
    nation: document.getElementById('ammoNation').value,
    caliber: parseInt(document.getElementById('ammoCaliber').value, 10),
    armorPen: parseInt(document.getElementById('ammoPen').value, 10),
    type: document.getElementById('ammoType').value,
    explosionRadius: parseInt(document.getElementById('ammoRadius').value, 10),
    pen0: parseInt(document.getElementById('ammoPen0').value, 10),
    pen100: parseInt(document.getElementById('ammoPen100').value, 10)
  };
}

async function addAmmo() {
  const payload = collectAmmoForm();
  const method = editingAmmoIndex === null ? 'POST' : 'PUT';
  const url = editingAmmoIndex === null ? '/api/ammo' : `/api/ammo/${editingAmmoIndex}`;
  await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  editingAmmoIndex = null;
  document.getElementById('addAmmoBtn').innerText = 'Add Ammo';
  clearAmmoForm();
  loadData();
}

function editAmmo(i) {
  const a = ammoCache[i];
  document.getElementById('ammoName').value = a.name;
  document.getElementById('ammoNation').value = a.nation;
  document.getElementById('ammoCaliber').value = a.caliber; document.getElementById('ammoCaliberVal').innerText = a.caliber;
  document.getElementById('ammoPen').value = a.armorPen; document.getElementById('ammoPenVal').innerText = a.armorPen;
  document.getElementById('ammoType').value = a.type;
  document.getElementById('ammoRadius').value = a.explosionRadius; document.getElementById('ammoRadiusVal').innerText = a.explosionRadius;
  document.getElementById('ammoPen0').value = a.pen0; document.getElementById('ammoPen0Val').innerText = a.pen0;
  document.getElementById('ammoPen100').value = a.pen100; document.getElementById('ammoPen100Val').innerText = a.pen100;
  editingAmmoIndex = i;
  document.getElementById('addAmmoBtn').innerText = 'Update Ammo';
}

async function deleteAmmo(i) {
  await fetch(`/api/ammo/${i}`, { method: 'DELETE' });
  loadData();
}

function clearAmmoForm() {
  document.getElementById('ammoName').value = '';
  document.getElementById('ammoNation').value = nationsCache[0] || '';
  document.getElementById('ammoCaliber').value = 20; document.getElementById('ammoCaliberVal').innerText = '';
  document.getElementById('ammoPen').value = 20; document.getElementById('ammoPenVal').innerText = '';
  document.getElementById('ammoType').value = 'HE';
  document.getElementById('ammoRadius').value = 0; document.getElementById('ammoRadiusVal').innerText = '';
  document.getElementById('ammoPen0').value = 20; document.getElementById('ammoPen0Val').innerText = '';
  document.getElementById('ammoPen100').value = 20; document.getElementById('ammoPen100Val').innerText = '';
}

function collectTerrainForm() {
  return {
    name: document.getElementById('terrainName').value,
    type: document.getElementById('terrainType').value,
    size: {
      x: parseFloat(document.getElementById('sizeX').value),
      y: parseFloat(document.getElementById('sizeY').value)
    }
  };
}

async function saveTerrain() {
  const payload = collectTerrainForm();
  const method = editingTerrainIndex === null ? 'POST' : 'PUT';
  const url = editingTerrainIndex === null ? '/api/terrains' : `/api/terrains/${editingTerrainIndex}`;
  await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  editingTerrainIndex = null;
  document.getElementById('editorCard').style.display = 'none';
  clearTerrainForm();
  loadData();
}

function openTerrainEditor(i) {
  const card = document.getElementById('editorCard');
  card.style.display = 'flex';
  if (i === undefined) {
    editingTerrainIndex = null;
    clearTerrainForm();
    document.getElementById('saveTerrainBtn').innerText = 'Add Terrain';
  } else {
    editingTerrainIndex = Number(i);
    const t = terrainsCache[editingTerrainIndex];
    document.getElementById('terrainName').value = t.name;
    document.getElementById('terrainType').value = t.type;
    document.getElementById('sizeX').value = t.size.x;
    document.getElementById('sizeY').value = t.size.y;
    document.getElementById('saveTerrainBtn').innerText = 'Update Terrain';
  }
  document.dispatchEvent(new Event('terrain-editor-opened'));
}

async function deleteTerrain(i) {
  await fetch(`/api/terrains/${i}`, { method: 'DELETE' });
  loadData();
}

function clearTerrainForm() {
  document.getElementById('terrainName').value = '';
  document.getElementById('terrainType').value = 'snow';
  document.getElementById('sizeX').value = '1';
  document.getElementById('sizeY').value = '1';
}

function setCurrentTerrain(i) {
  currentTerrainIndex = Number(i);
  renderTerrainTable();
}

async function restartGame() {
  if (!terrainsCache[currentTerrainIndex]) {
    alert('Select a terrain first');
    return;
  }
  await fetch('/api/restart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index: currentTerrainIndex })
  });
  loadData();
}

function renderTerrainTable() {
  const tbody = document.getElementById('terrainList');
  if (!tbody) return;
  tbody.innerHTML = terrainsCache.map((t, i) =>
    `<tr class="${i == currentTerrainIndex ? 'current-row' : ''}">
      <td><div id="thumb-${i}" class="terrain-thumb"></div></td>
      <td>${t.type}</td>
      <td>${t.size.x}x${t.size.y}</td>
      <td>${t.name}</td>
      <td><button data-i="${i}" class="use-terrain">Use</button><button data-i="${i}" class="edit-terrain">Edit</button><button data-i="${i}" class="del-terrain">Delete</button></td>
    </tr>`
  ).join('');
  tbody.querySelectorAll('.edit-terrain').forEach(btn => btn.addEventListener('click', () => openTerrainEditor(btn.dataset.i)));
  tbody.querySelectorAll('.del-terrain').forEach(btn => btn.addEventListener('click', () => deleteTerrain(btn.dataset.i)));
  tbody.querySelectorAll('.use-terrain').forEach(btn => btn.addEventListener('click', () => setCurrentTerrain(btn.dataset.i)));
  terrainsCache.forEach((t, i) => renderThumbnail(`thumb-${i}`, t));
}

function renderThumbnail(id, terrain) {
  const el = document.getElementById(id);
  if (!el) return;
  const z = [
    [0, 0],
    [0, 0]
  ];
  Plotly.newPlot(el, [{ z, type: 'surface', showscale: false }], {
    margin: { l: 0, r: 0, t: 0, b: 0 },
    scene: { xaxis: { visible: false }, yaxis: { visible: false }, zaxis: { visible: false } }
  }, { displayModeBar: false });
}

function updateStats() {
  const summary = document.getElementById('summaryStats');
  const chartEl = document.getElementById('tankNationChart');
  if (!summary || !chartEl) return; // not on dashboard page
  const totalNations = nationsCache.length;
  const totalTanks = tanksCache.length;
  summary.innerText = `${totalNations} nations, ${totalTanks} tanks`;
  const ctx = chartEl.getContext('2d');
  const counts = nationsCache.map(n => tanksCache.filter(t => t.nation === n).length);
  if (tankNationChart) tankNationChart.destroy();
  tankNationChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: nationsCache,
      datasets: [{
        label: 'Tanks per Nation',
        data: counts,
        backgroundColor: '#4e79a7'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false
    }
  });
}

// Attach event listeners conditionally so pages without elements do not error
const profilePic = document.getElementById('profilePic');
if (profilePic) profilePic.addEventListener('click', toggleMenu);
const signOutLink = document.getElementById('signOutLink');
if (signOutLink) signOutLink.addEventListener('click', (e) => {
  e.preventDefault();
  signOut();
});
const loginBtn = document.getElementById('loginBtn');
if (loginBtn) loginBtn.addEventListener('click', login);
const addNationBtn = document.getElementById('addNationBtn');
if (addNationBtn) addNationBtn.addEventListener('click', addNation);
const addTankBtn = document.getElementById('addTankBtn');
if (addTankBtn) addTankBtn.addEventListener('click', addTank);
const addAmmoBtn = document.getElementById('addAmmoBtn');
if (addAmmoBtn) addAmmoBtn.addEventListener('click', addAmmo);
const newTerrainBtn = document.getElementById('newTerrainBtn');
if (newTerrainBtn) newTerrainBtn.addEventListener('click', () => openTerrainEditor());
const saveTerrainBtn = document.getElementById('saveTerrainBtn');
if (saveTerrainBtn) saveTerrainBtn.addEventListener('click', saveTerrain);
const cancelEditBtn = document.getElementById('cancelEditBtn');
if (cancelEditBtn) cancelEditBtn.addEventListener('click', () => {
  editingTerrainIndex = null;
  document.getElementById('editorCard').style.display = 'none';
});
const restartBtn = document.getElementById('restartBtn');
if (restartBtn) restartBtn.addEventListener('click', restartGame);

// Check on load if admin cookie is present via server endpoint
async function checkAdmin() {
  const res = await fetch('/admin/status');
  if (res.ok) showApp();
}
checkAdmin();

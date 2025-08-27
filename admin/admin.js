// admin.js
// Summary: Handles CRUD actions for nations, tanks, ammo and terrain across
//          separate admin pages linked by a sidebar. Terrain management now uses a table with
//          3D thumbnails and an in-page editor. The tank form renders a Three.js-powered 3D
//          preview with independently rotating chassis and turret based on rotation times,
//          and now includes an ammo capacity slider. Range inputs auto-populate mid-scale
//          defaults for consistent layout. Nation management
//          uses a drop-down list for choosing flag emojis.
// Uses secure httpOnly cookie set by server and provides logout and game restart endpoints.
// Structure: auth helpers -> data loaders -> CRUD functions -> restart helpers -> UI handlers.
// Usage: Included by all files in /admin.
// ---------------------------------------------------------------------------

import { getFlagList } from './flag-utils.js';

// Lazily load Three.js so admin features work even if the optional 3D library
// fails to download. This keeps the admin panel functional even when the
// preview renderer is unavailable.
let THREE = null;
async function ensureThree() {
  if (!THREE) {
    try {
      THREE = await import('../libs/three.module.js');
    } catch (err) {
      console.error('Failed to load Three.js', err);
    }
  }
  return THREE;
}

function toggleMenu() {
  document.getElementById('profileMenu').classList.toggle('show');
}

async function signOut() {
  await fetch('/admin/logout', { method: 'POST' });
  location.href = 'login.html';
}

// In-memory caches for editing
let nationsCache = [];
let tanksCache = [];
let ammoCache = [];
let terrainsCache = [];
let usersCache = [];
let editingNationIndex = null;
let editingTankIndex = null;
let editingAmmoIndex = null;
let editingTerrainIndex = null;
let currentTerrainIndex = 0;
let tankNationChart = null;

// Table sorting state
let tankSortKey = 'name';
let tankSortAsc = true;
let nationSortKey = 'name';
let nationSortAsc = true;
let ammoSortKey = 'name';
let ammoSortAsc = true;
let previewRenderer, previewScene, previewCamera, previewTankGroup, previewTurret, previewClock;
const FLAG_LIST = getFlagList();

async function loadData() {
  nationsCache = await fetch('/api/nations').then(r => r.json());
  tanksCache = await fetch('/api/tanks').then(r => r.json());
  ammoCache = await fetch('/api/ammo').then(r => r.json());
  usersCache = await fetch('/api/users').then(r => r.json());
  const terrainData = await fetch('/api/terrains').then(r => r.json());
  terrainsCache = terrainData.terrains;
  currentTerrainIndex = terrainData.current ?? 0;

  // Populate nation selects for tank and ammo forms
  const nationOptions = nationsCache.map(n => `<option value="${n.name}">${n.name}</option>`).join('');
  const tankNation = document.getElementById('tankNation');
  if (tankNation) tankNation.innerHTML = nationOptions;
  const ammoNation = document.getElementById('ammoNation');
  if (ammoNation) ammoNation.innerHTML = nationOptions;

  // Populate flag emoji dropdown for nation form. Each option's value is the
  // emoji itself so selecting a flag inserts the symbol directly.
  const flagSelect = document.getElementById('nationFlag');
  if (flagSelect) {
    flagSelect.innerHTML =
      '<option value="" disabled selected>Select a flag</option>' +
      FLAG_LIST.map(f => `<option value="${f.emoji}">${f.emoji} ${f.name}</option>`).join('');
  }

  // Render lists on each page
  const nationHeaders = document.querySelectorAll('#nationTable th[data-sort]');
  nationHeaders.forEach(th => th.onclick = () => {
    const key = th.dataset.sort;
    if (nationSortKey === key) nationSortAsc = !nationSortAsc; else { nationSortKey = key; nationSortAsc = true; }
    renderNationTable();
  });
  renderNationTable();

  // Set up tank sorting headers once then draw table
  const tankHeaders = document.querySelectorAll('#tanksTable th[data-sort]');
  tankHeaders.forEach(th => th.onclick = () => {
    const key = th.dataset.sort;
    if (tankSortKey === key) tankSortAsc = !tankSortAsc; else { tankSortKey = key; tankSortAsc = true; }
    renderTankTable();
  });
  renderTankTable();

  // Set up ammo sorting and render table
  const ammoHeaders = document.querySelectorAll('#ammoTable th[data-sort]');
  ammoHeaders.forEach(th => th.onclick = () => {
    const key = th.dataset.sort;
    if (ammoSortKey === key) ammoSortAsc = !ammoSortAsc; else { ammoSortKey = key; ammoSortAsc = true; }
    renderAmmoTable();
  });
  renderAmmoTable();

  // Populate user stats table when on Users page
  const userTable = document.getElementById('userTableBody');
  if (userTable) {
    userTable.innerHTML = usersCache.map(u =>
      `<tr><td>${u.username}</td><td>${u.stats.games}</td><td>${u.stats.kills}</td><td>${u.stats.deaths}</td></tr>`
    ).join('');
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

function renderNationTable() {
  const tbody = document.getElementById('nationList');
  if (!tbody) return;
  const rows = nationsCache.map((n, i) => ({ n, i }));
  rows.sort((a, b) => {
    let av = a.n[nationSortKey];
    let bv = b.n[nationSortKey];
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return nationSortAsc ? -1 : 1;
    if (av > bv) return nationSortAsc ? 1 : -1;
    return 0;
  });
  tbody.innerHTML = rows.map(({ n, i }) =>
    `<tr><td class="flag-cell">${n.flag || ''}</td><td>${n.name}</td>` +
    `<td><button data-i="${i}" class="edit-nation">Edit</button>` +
    `<button data-i="${i}" class="del-nation">Delete</button></td></tr>`
  ).join('');
  tbody.querySelectorAll('.edit-nation').forEach(btn => btn.addEventListener('click', () => editNation(btn.dataset.i)));
  tbody.querySelectorAll('.del-nation').forEach(btn => btn.addEventListener('click', () => deleteNation(btn.dataset.i)));
}

function collectNationForm() {
  const name = document.getElementById('nationName').value;
  // Dropdown stores emoji values directly, making submission straightforward.
  const flag = document.getElementById('nationFlag').value;
  return { name, flag };
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
  document.getElementById('nationName').value = n.name;
  // Select expects an emoji value so set the dropdown accordingly
  document.getElementById('nationFlag').value = n.flag;
  editingNationIndex = i;
  document.getElementById('addNationBtn').innerText = 'Update Nation';
}

async function deleteNation(i) {
  await fetch(`/api/nations/${i}`, { method: 'DELETE' });
  loadData();
}

function clearNationForm() {
  document.getElementById('nationName').value = '';
  // Reset dropdown to placeholder option.
  document.getElementById('nationFlag').selectedIndex = 0;
}

function collectTankForm() {
  const cls = document.getElementById('tankClass').value;
  return {
    name: document.getElementById('tankName').value,
    nation: document.getElementById('tankNation').value,
    br: parseFloat(document.getElementById('tankBR').value),
    class: cls,
    armor: parseInt(document.getElementById('tankChassisArmor').value, 10),
    turretArmor: parseInt(document.getElementById('tankTurretArmor').value, 10),
    cannonCaliber: parseInt(document.getElementById('tankCaliber').value, 10),
    ammo: Array.from(document.querySelectorAll('input[name="tankAmmo"]:checked')).map(cb => cb.value),
    ammoCapacity: parseInt(document.getElementById('tankAmmoCapacity').value, 10),
    crew: parseInt(document.getElementById('tankCrew').value, 10),
    engineHp: parseInt(document.getElementById('tankHP').value, 10),
    maxSpeed: parseInt(document.getElementById('tankMaxSpeed').value, 10),
    maxReverseSpeed: parseFloat(document.getElementById('tankMaxReverse').value),
    incline: parseInt(document.getElementById('tankIncline').value, 10),
    bodyRotation: parseInt(document.getElementById('tankBodyRot').value, 10),
    turretRotation: parseInt(document.getElementById('tankTurretRot').value, 10),
    // Only retain horizontal traverse input for tank destroyers; other classes rotate freely.
    horizontalTraverse: cls === 'Tank Destroyer'
      ? parseInt(document.getElementById('tankHorizontalTraverse').value, 10)
      : 0,
    maxTurretIncline: parseInt(document.getElementById('tankMaxTurretIncline').value, 10),
    maxTurretDecline: parseInt(document.getElementById('tankMaxTurretDecline').value, 10),
    bodyWidth: parseFloat(document.getElementById('tankBodyWidth').value),
    bodyLength: parseFloat(document.getElementById('tankBodyLength').value),
    bodyHeight: parseFloat(document.getElementById('tankBodyHeight').value),
    turretWidth: parseFloat(document.getElementById('tankTurretWidth').value),
    turretLength: parseFloat(document.getElementById('tankTurretLength').value),
    turretHeight: parseFloat(document.getElementById('tankTurretHeight').value)
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

function renderTankTable() {
  const tbody = document.getElementById('tanksTableBody');
  if (!tbody) return;
  const rows = tanksCache.map((t, i) => ({ t, i }));
  rows.sort((a, b) => {
    let av = a.t[tankSortKey];
    let bv = b.t[tankSortKey];
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return tankSortAsc ? -1 : 1;
    if (av > bv) return tankSortAsc ? 1 : -1;
    return 0;
  });
  tbody.innerHTML = rows.map(({ t, i }) =>
    `<tr>
      <td><canvas id="tank-thumb-${i}" class="tank-thumb" width="60" height="30" aria-label="Tank thumbnail"></canvas></td>
      <td>${t.name}</td>
      <td>${t.nation}</td>
      <td>${t.br}</td>
      <td>${t.class}</td>
      <td>${t.armor}</td>
      <td>${t.cannonCaliber}</td>
      <td>${t.ammoCapacity}</td>
      <td>${t.crew}</td>
      <td>${t.engineHp}</td>
      <td>${t.maxSpeed}</td>
      <td>${t.horizontalTraverse ?? 0}</td>
      <td>${t.bodyWidth}</td>
      <td>${t.bodyLength}</td>
      <td>${t.bodyHeight}</td>
      <td><button data-i="${i}" class="edit-tank">Edit</button><button data-i="${i}" class="del-tank">Delete</button></td>
    </tr>`
  ).join('');
  rows.forEach(({ t, i }) => {
    const canvas = document.getElementById(`tank-thumb-${i}`);
    if (canvas) drawTankThumb(canvas, t);
  });
  tbody.querySelectorAll('.edit-tank').forEach(btn => btn.addEventListener('click', () => editTank(btn.dataset.i)));
  tbody.querySelectorAll('.del-tank').forEach(btn => btn.addEventListener('click', () => deleteTank(btn.dataset.i)));
}

function drawTankThumb(canvas, t) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / (t.bodyLength || 1), canvas.height / (t.bodyWidth || 1));
  const bodyW = (t.bodyLength || 1) * scale;
  const bodyH = (t.bodyWidth || 1) * scale;
  const bodyX = (canvas.width - bodyW) / 2;
  const bodyY = (canvas.height - bodyH) / 2;
  ctx.fillStyle = '#556b2f';
  ctx.fillRect(bodyX, bodyY, bodyW, bodyH);
  const turretW = (t.turretLength || 1) * scale;
  const turretH = (t.turretWidth || 1) * scale;
  const turretX = canvas.width / 2 - turretW / 2;
  const turretY = canvas.height / 2 - turretH / 2;
  ctx.fillStyle = '#6b8e23';
  ctx.fillRect(turretX, turretY, turretW, turretH);
}

function editTank(i) {
  const t = tanksCache[i];
  document.getElementById('tankName').value = t.name;
  document.getElementById('tankNation').value = t.nation;
  document.getElementById('tankBR').value = t.br; document.getElementById('brVal').innerText = t.br;
  document.getElementById('tankClass').value = t.class;
  document.getElementById('tankChassisArmor').value = t.armor; document.getElementById('chassisArmorVal').innerText = t.armor;
  document.getElementById('tankTurretArmor').value = t.turretArmor ?? 80; document.getElementById('turretArmorVal').innerText = t.turretArmor ?? 80;
  document.getElementById('tankCaliber').value = t.cannonCaliber; document.getElementById('caliberVal').innerText = t.cannonCaliber;
  document.querySelectorAll('input[name="tankAmmo"]').forEach(cb => { cb.checked = t.ammo.includes(cb.value); });
  document.getElementById('tankAmmoCapacity').value = t.ammoCapacity ?? 40; document.getElementById('ammoCapVal').innerText = t.ammoCapacity ?? 40;
  document.getElementById('tankCrew').value = t.crew; document.getElementById('crewVal').innerText = t.crew;
  document.getElementById('tankHP').value = t.engineHp; document.getElementById('hpVal').innerText = t.engineHp;
  document.getElementById('tankMaxSpeed').value = t.maxSpeed ?? 10; document.getElementById('maxSpeedVal').innerText = t.maxSpeed ?? 10;
  document.getElementById('tankMaxReverse').value = t.maxReverseSpeed ?? 0; document.getElementById('maxReverseVal').innerText = t.maxReverseSpeed ?? 0;
  document.getElementById('tankIncline').value = t.incline; document.getElementById('inclineVal').innerText = t.incline;
  document.getElementById('tankBodyRot').value = t.bodyRotation; document.getElementById('bodyRotVal').innerText = t.bodyRotation;
  document.getElementById('tankTurretRot').value = t.turretRotation; document.getElementById('turretRotVal').innerText = t.turretRotation;
  document.getElementById('tankHorizontalTraverse').value = t.horizontalTraverse ?? 0; document.getElementById('horizontalTraverseVal').innerText = t.horizontalTraverse ?? 0;
  document.getElementById('tankMaxTurretIncline').value = t.maxTurretIncline ?? 0; document.getElementById('maxTurretInclineVal').innerText = t.maxTurretIncline ?? 0;
  document.getElementById('tankMaxTurretDecline').value = t.maxTurretDecline ?? 0; document.getElementById('maxTurretDeclineVal').innerText = t.maxTurretDecline ?? 0;
  document.getElementById('tankBodyWidth').value = t.bodyWidth ?? 1; document.getElementById('bodyWidthVal').innerText = t.bodyWidth ?? 1;
  document.getElementById('tankBodyLength').value = t.bodyLength ?? 1; document.getElementById('bodyLengthVal').innerText = t.bodyLength ?? 1;
  document.getElementById('tankBodyHeight').value = t.bodyHeight ?? 1; document.getElementById('bodyHeightVal').innerText = t.bodyHeight ?? 1;
  document.getElementById('tankTurretWidth').value = t.turretWidth ?? 1; document.getElementById('turretWidthVal').innerText = t.turretWidth ?? 1;
  document.getElementById('tankTurretLength').value = t.turretLength ?? 1; document.getElementById('turretLengthVal').innerText = t.turretLength ?? 1;
  document.getElementById('tankTurretHeight').value = t.turretHeight ?? 0.25; document.getElementById('turretHeightVal').innerText = t.turretHeight ?? 0.25;
  editingTankIndex = i;
  document.getElementById('addTankBtn').innerText = 'Update Tank';
  updatePreview();
}

async function deleteTank(i) {
  await fetch(`/api/tanks/${i}`, { method: 'DELETE' });
  loadData();
}

function resetSlider(el) {
  // Compute midpoint respecting step and display it so layout doesn't shift on first use
  const min = parseFloat(el.min);
  const max = parseFloat(el.max);
  const step = parseFloat(el.step) || 1;
  let value = (min + max) / 2;
  value = Math.round(value / step) * step;
  el.value = value;
  const span = el.nextElementSibling;
  if (span) span.innerText = value;
}

function clearTankForm() {
  document.getElementById('tankName').value = '';
  document.getElementById('tankNation').value = nationsCache[0]?.name || '';
  document.getElementById('tankClass').value = 'Light/Scout';
  document.querySelectorAll('#tankForm input[type="range"]').forEach(resetSlider);
  document.querySelectorAll('input[name="tankAmmo"]').forEach(cb => { cb.checked = false; });
  updatePreview();
}

async function initPreview(canvas) {
  const THREE = await ensureThree();
  if (!THREE) return;
  previewRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  previewRenderer.setSize(canvas.width, canvas.height);
  previewScene = new THREE.Scene();
  previewCamera = new THREE.PerspectiveCamera(45, canvas.width / canvas.height, 0.1, 1000);
  previewScene.add(new THREE.AmbientLight(0x404040));
  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.position.set(5, 10, 7.5);
  previewScene.add(light);
  previewClock = new THREE.Clock();
  console.debug('Initializing tank preview');
  animatePreview();
}

function animatePreview() {
  requestAnimationFrame(animatePreview);
  if (!previewRenderer || !previewScene || !previewCamera || !previewTankGroup) return;
  const dt = previewClock.getDelta();
  const bodyRot = parseFloat(document.getElementById('tankBodyRot').value) || 60;
  const turretRot = parseFloat(document.getElementById('tankTurretRot').value) || 60;
  previewTankGroup.rotation.y += (2 * Math.PI / bodyRot) * dt;
  if (previewTurret) previewTurret.rotation.y += (2 * Math.PI / turretRot) * dt;
  previewRenderer.render(previewScene, previewCamera);
}

async function updatePreview() {
  const canvas = document.getElementById('tankPreview');
  if (!canvas) return;
  if (!previewRenderer) await initPreview(canvas);
  if (!previewRenderer) return;

  const THREE = await ensureThree();
  if (!THREE) return;

  const bodyW = parseFloat(document.getElementById('tankBodyWidth').value) || 1;
  const bodyL = parseFloat(document.getElementById('tankBodyLength').value) || 1;
  const bodyH = parseFloat(document.getElementById('tankBodyHeight').value) || 1;
  const turretW = parseFloat(document.getElementById('tankTurretWidth').value) || 1;
  const turretL = parseFloat(document.getElementById('tankTurretLength').value) || 1;
  const turretH = parseFloat(document.getElementById('tankTurretHeight').value) || 0.25;

  if (previewTankGroup) previewScene.remove(previewTankGroup);
  previewTankGroup = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(bodyW, bodyH, bodyL),
    new THREE.MeshStandardMaterial({ color: 0x556b2f })
  );
  previewTankGroup.add(body);
  previewTurret = new THREE.Mesh(
    new THREE.BoxGeometry(turretW, turretH, turretL),
    new THREE.MeshStandardMaterial({ color: 0x6b8e23 })
  );
  previewTurret.position.y = bodyH / 2 + turretH / 2;
  previewTankGroup.add(previewTurret);
  previewScene.add(previewTankGroup);

  const maxDim = Math.max(bodyW, bodyL, bodyH) || 1;
  previewCamera.position.set(maxDim * 2, maxDim * 2, maxDim * 2);
  previewCamera.lookAt(0, bodyH / 2, 0);
}
window.updatePreview = updatePreview;

function renderAmmoTable() {
  const tbody = document.getElementById('ammoTableBody');
  if (!tbody) return;
  const rows = ammoCache.map((a, i) => ({ a, i }));
  rows.sort((x, y) => {
    let av = x.a[ammoSortKey];
    let bv = y.a[ammoSortKey];
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return ammoSortAsc ? -1 : 1;
    if (av > bv) return ammoSortAsc ? 1 : -1;
    return 0;
  });
  tbody.innerHTML = rows.map(({ a, i }) =>
    `<tr>
      <td>${a.image ? `<img src="${a.image}" alt="${a.name}" class="ammo-thumb">` : ''}</td>
      <td>${a.name}</td>
      <td>${a.nation}</td>
      <td>${a.type}</td>
      <td>${a.caliber}</td>
      <td>${a.armorPen}</td>
      <td>${a.explosionRadius}</td>
      <td><button data-i="${i}" class="edit-ammo">Edit</button><button data-i="${i}" class="del-ammo">Delete</button></td>
    </tr>`
  ).join('');
  tbody.querySelectorAll('.edit-ammo').forEach(btn => btn.addEventListener('click', () => editAmmo(btn.dataset.i)));
  tbody.querySelectorAll('.del-ammo').forEach(btn => btn.addEventListener('click', () => deleteAmmo(btn.dataset.i)));
}

function collectAmmoForm() {
  const fd = new FormData();
  fd.append('name', document.getElementById('ammoName').value);
  fd.append('nation', document.getElementById('ammoNation').value);
  fd.append('caliber', document.getElementById('ammoCaliber').value);
  fd.append('armorPen', document.getElementById('ammoPen').value);
  fd.append('type', document.getElementById('ammoType').value);
  fd.append('explosionRadius', document.getElementById('ammoRadius').value);
  fd.append('pen0', document.getElementById('ammoPen0').value);
  fd.append('pen100', document.getElementById('ammoPen100').value);
  const file = document.getElementById('ammoImage').files[0];
  if (file) fd.append('image', file);
  return fd;
}

async function addAmmo() {
  const payload = collectAmmoForm();
  const method = editingAmmoIndex === null ? 'POST' : 'PUT';
  const url = editingAmmoIndex === null ? '/api/ammo' : `/api/ammo/${editingAmmoIndex}`;
  await fetch(url, {
    method,
    body: payload
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
  document.getElementById('ammoImage').value = '';
  editingAmmoIndex = i;
  document.getElementById('addAmmoBtn').innerText = 'Update Ammo';
}

async function deleteAmmo(i) {
  await fetch(`/api/ammo/${i}`, { method: 'DELETE' });
  loadData();
}

function clearAmmoForm() {
  document.getElementById('ammoName').value = '';
  document.getElementById('ammoNation').value = nationsCache[0]?.name || '';
  document.getElementById('ammoCaliber').value = 20; document.getElementById('ammoCaliberVal').innerText = '';
  document.getElementById('ammoPen').value = 20; document.getElementById('ammoPenVal').innerText = '';
  document.getElementById('ammoType').value = 'HE';
  document.getElementById('ammoRadius').value = 0; document.getElementById('ammoRadiusVal').innerText = '';
  document.getElementById('ammoPen0').value = 20; document.getElementById('ammoPen0Val').innerText = '';
  document.getElementById('ammoPen100').value = 20; document.getElementById('ammoPen100Val').innerText = '';
  document.getElementById('ammoImage').value = '';
}

function collectTerrainForm() {
  return {
    name: document.getElementById('terrainName').value,
    type: document.getElementById('terrainType').value,
    size: {
      x: parseFloat(document.getElementById('sizeX').value),
      y: parseFloat(document.getElementById('sizeY').value)
    },
    flags: window.getTerrainFlags ? window.getTerrainFlags() : null,
    ground: window.getTerrainGround ? window.getTerrainGround() : null,
    elevation: window.getTerrainElevation ? window.getTerrainElevation() : null
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
    window.existingFlags = null;
    window.existingGround = null;
    window.existingElevation = null;
    document.getElementById('saveTerrainBtn').innerText = 'Add Terrain';
  } else {
    editingTerrainIndex = Number(i);
    const t = terrainsCache[editingTerrainIndex];
    document.getElementById('terrainName').value = t.name;
    document.getElementById('terrainType').value = t.type;
    document.getElementById('sizeX').value = t.size.x;
    document.getElementById('sizeY').value = t.size.y;
    window.existingFlags = t.flags || null;
    window.existingGround = t.ground || null;
    window.existingElevation = t.elevation || null;
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
  window.existingFlags = null;
  window.existingGround = null;
  window.existingElevation = null;
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
  // Plotly is loaded via CDN on terrain.html. If the network fails or the
  // library is missing, skip rendering to avoid a fatal ReferenceError that
  // would hide the entire terrain table.
  if (typeof Plotly === 'undefined') {
    el.textContent = 'preview unavailable';
    return;
  }
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
  const counts = nationsCache.map(n => tanksCache.filter(t => t.nation === n.name).length);
  if (tankNationChart) tankNationChart.destroy();
  tankNationChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: nationsCache.map(n => n.name),
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

// Initialise page once DOM is ready so event handlers always attach
function initAdmin() {
  const profilePic = document.getElementById('profilePic');
  if (profilePic) profilePic.addEventListener('click', toggleMenu);

  const signOutLink = document.getElementById('signOutLink');
  if (signOutLink) {
    signOutLink.addEventListener('click', (e) => {
      e.preventDefault();
      signOut();
    });
  }

  const addNationBtn = document.getElementById('addNationBtn');
  if (addNationBtn) addNationBtn.addEventListener('click', addNation);

  const tankFormEl = document.getElementById('tankForm');
  if (tankFormEl) tankFormEl.addEventListener('submit', (e) => { e.preventDefault(); addTank(); });

  const addAmmoBtn = document.getElementById('addAmmoBtn');
  if (addAmmoBtn) addAmmoBtn.addEventListener('click', addAmmo);

  const newTerrainBtn = document.getElementById('newTerrainBtn');
  if (newTerrainBtn) newTerrainBtn.addEventListener('click', () => openTerrainEditor());

  const saveTerrainBtn = document.getElementById('saveTerrainBtn');
  if (saveTerrainBtn) saveTerrainBtn.addEventListener('click', saveTerrain);

  const cancelEditBtn = document.getElementById('cancelEditBtn');
  if (cancelEditBtn) {
    cancelEditBtn.addEventListener('click', () => {
      editingTerrainIndex = null;
      document.getElementById('editorCard').style.display = 'none';
    });
  }

  const restartBtn = document.getElementById('restartBtn');
  if (restartBtn) restartBtn.addEventListener('click', restartGame);

  // Ensure the user is authenticated before loading any data
  checkAdmin();
}

// Check on load if admin cookie is present via server endpoint
async function checkAdmin() {
  try {
    const res = await fetch('/admin/status');
    if (res.ok) {
      loadData();
      return;
    }
  } catch (err) {
    console.warn('Admin status check failed', err);
  }
  // Not authenticated; redirect to login page
  window.location.href = 'login.html';
}

// Ensure admin logic always runs. When this module loads after the
// DOMContentLoaded event has already fired (e.g. cached module at the
// end of the body), adding a listener would never trigger. Check the
// document state and call immediately if necessary so the tank table
// and form handlers are reliably initialised.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAdmin);
} else {
  initAdmin();
}

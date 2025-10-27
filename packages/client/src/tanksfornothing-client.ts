// tanksfornothing-client.ts
// @ts-nocheck
// Summary: Browser client for Tanks for Nothing. Provides lobby flag, tabbed tank-class
//          and ammo selection, renders a dimensioned 3D tank based on server-supplied parameters,
//          handles user input, camera control and firing mechanics. Camera defaults
//          (height/distance) can be adjusted via the admin settings page. Uses Cannon.js for
//          simple collision physics, force-based tank movement and synchronizes state
//          with a server via Socket.IO. Camera immediately reflects mouse movement while
//          turret and gun lag behind to emulate realistic traverse. Projectiles now drop
//          under gravity. Remote players are represented with simple meshes that now
//          include a visible cannon barrel and update as network events arrive so
//          everyone shares the same battlefield. HUD displays current ammo selections
//          and remaining rounds.
// Structure: lobby data fetch -> scene setup -> physics setup -> input handling ->
//             firing helpers -> movement update -> animation loop -> optional networking.
// Usage: Included by index.html; requires Socket.IO for multiplayer networking and
//         loads Cannon.js from CDN for physics.
// ---------------------------------------------------------------------------
// Three.js is served from /public/libs rather than nested within /public/js, so we
// import it via a parent-relative path. The previous './libs/three.module.js'
// resolved to /js/libs/three.module.js once compiled, which does not exist and
// caused the "Failed to load game client" error after login because the module
// failed to download. Using '../libs/three.module.js' matches the actual static
// asset layout and restores the client bundle.
import * as THREE from '../libs/three.module.js';
// cannon-es provides lightweight rigid body physics with vehicle helpers.
// Imported from CDN to keep repository light while using the latest version.
import * as CANNON from 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';
import { initHUD, updateHUD, updateAmmoHUD, showCrosshair, updateCooldownHUD } from './hud.js';
import { buildGroundTexture } from './ground-textures.js';

declare global {
  interface Window {
    io?: (...args: unknown[]) => any;
  }
}

// Utility: render fatal errors directly on screen for easier debugging.
function showError(message) {
  console.error(message);
  const overlay = document.createElement('div');
  overlay.textContent = message;
  overlay.style.position = 'fixed';
  overlay.style.top = '50%';
  overlay.style.left = '50%';
  overlay.style.transform = 'translate(-50%, -50%)';
  overlay.style.background = 'rgba(0,0,0,0.8)';
  overlay.style.color = '#fff';
  overlay.style.padding = '10px 20px';
  overlay.style.borderRadius = '4px';
  overlay.style.zIndex = '1000';
  document.body.appendChild(overlay);
}

window.addEventListener('error', (e) => showError(`Error: ${e.message}`));
// Capture unhandled promise rejections to surface asynchronous errors.
window.addEventListener('unhandledrejection', (e) => {
  showError('Promise error: ' + e.reason);
});

// Render a brief explosion effect at the given world position for feedback
function renderExplosion(position) {
  if (!scene) return;
  const geom = new THREE.SphereGeometry(1, 16, 16);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffaa00 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.copy(position);
  scene.add(mesh);
  setTimeout(() => {
    scene.remove(mesh);
    geom.dispose();
    mat.dispose();
  }, 500);
}

// `io` is provided globally by the socket.io script tag in index.html. Create a
// socket when available and surface connection issues to the player.
let socket = null;
// Client-side ammo handling
let playerAmmo = [];
let selectedAmmo = null;
const projectiles = new Map(); // id -> { mesh, vx, vy, vz }
// Gravity acceleration for local projectile simulation (m/s^2)
const GRAVITY = -9.81;
let playerHealth = 100;
// Track other players in the session by their socket.id. Each entry stores the
// root mesh plus references to the turret and gun so orientation can be synced
// on network updates.
const otherPlayers = new Map(); // id -> { mesh, turret, gun }
const fallbackPalette = [
  { name: 'grass', color: '#3cb043', texture: 'grass' },
  { name: 'mud', color: '#6b4423', texture: 'mud' },
  { name: 'snow', color: '#ffffff', texture: 'snow' },
  { name: 'sand', color: '#c2b280', texture: 'sand' },
  { name: 'rock', color: '#80868b', texture: 'rock' }
];
const fallbackLighting = {
  sunPosition: { x: 200, y: 400, z: 200 },
  sunColor: '#ffe8a3',
  ambientColor: '#1f2a3c'
};
let ambientLight = null;
let sunLight = null;
let currentTerrainDefinition = null;
let groundTexture = null;

// Build a simplified tank mesh for remote players using dimensions from the
// server. These meshes are purely visual and have no physics bodies.
function createRemoteTank(t) {
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(
      t.bodyWidth ?? defaultTank.bodyWidth,
      t.bodyHeight ?? defaultTank.bodyHeight,
      t.bodyLength ?? defaultTank.bodyLength
    ),
    new THREE.MeshStandardMaterial({ color: 0x335533 })
  );
  const turt = new THREE.Mesh(
    new THREE.BoxGeometry(
      t.turretWidth ?? defaultTank.turretWidth,
      t.turretHeight ?? defaultTank.turretHeight,
      t.turretLength ?? defaultTank.turretLength
    ),
    new THREE.MeshStandardMaterial({ color: 0x556655 })
  );
  turt.position.set(
    (t.turretYPercent ?? defaultTank.turretYPercent) / 100 * (t.bodyWidth ?? defaultTank.bodyWidth) -
      (t.bodyWidth ?? defaultTank.bodyWidth) / 2,
    (t.bodyHeight ?? defaultTank.bodyHeight) / 2 +
      (t.turretHeight ?? defaultTank.turretHeight) / 2,
    (0.5 - (t.turretXPercent ?? defaultTank.turretXPercent) / 100) *
      (t.bodyLength ?? defaultTank.bodyLength)
  );

  // Remote gun barrel for visual parity with the local player tank.
  const gunObj = new THREE.Object3D();
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(
      ((t.cannonCaliber ?? defaultTank.cannonCaliber) / 1000) / 2,
      ((t.cannonCaliber ?? defaultTank.cannonCaliber) / 1000) / 2,
      t.barrelLength ?? defaultTank.barrelLength
    ),
    new THREE.MeshStandardMaterial({ color: 0x556655 })
  );
  barrel.rotation.x = -Math.PI / 2;
  barrel.position.z = -(t.barrelLength ?? defaultTank.barrelLength) / 2;
  gunObj.add(barrel);
  turt.add(gunObj);

  body.add(turt);
  return { mesh: body, turret: turt, gun: gunObj };
}

if (window.io) {
  socket = window.io();
  socket.on('connect', () => console.log('Connected to server'));
  socket.on('connect_error', () => showError('Unable to connect to server. Running offline.'));
  socket.on('disconnect', () => showError('Disconnected from server. Running offline.'));
  socket.on('terrain', (payload) => applyTerrainPayload(payload));
  socket.on('projectile-fired', (p) => {
    if (!scene) return;
    // Debug: log projectile spawn details so firing issues are easier to trace.
    console.debug('Projectile spawned', p);
    // Previous shells were too small to see; increase radius for visibility.
    const geom = new THREE.SphereGeometry(0.3, 12, 12);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(p.x, p.y, p.z);
    scene.add(mesh);
    projectiles.set(p.id, { mesh, vx: p.vx, vy: p.vy, vz: p.vz });
  });
  socket.on('projectile-exploded', (p) => {
    const proj = projectiles.get(p.id);
    if (proj) {
      scene.remove(proj.mesh);
      proj.mesh.geometry.dispose();
      proj.mesh.material.dispose();
      projectiles.delete(p.id);
    }
    renderExplosion(new THREE.Vector3(p.x, p.y, p.z));
  });
  socket.on('tank-damaged', ({ id, health }) => {
    if (id === socket.id) playerHealth = health;
  });
  // --- Multiplayer player management ---
  socket.on('player-joined', ({ id, tank: t }) => {
    if (!scene || id === socket.id || otherPlayers.has(id)) return;
    const remote = createRemoteTank(t);
    remote.mesh.position.set(t.x || 0, t.y || 0, t.z || 0);
    scene.add(remote.mesh);
    otherPlayers.set(id, remote);
    console.log('Player joined', id);
  });
  socket.on('player-update', ({ id, state }) => {
    const remote = otherPlayers.get(id);
    if (!remote) return;
    remote.mesh.position.set(state.x, state.y, state.z);
    remote.mesh.rotation.y = state.rot;
    remote.turret.rotation.y = state.turret;
    if (remote.gun) remote.gun.rotation.x = state.gun ?? 0;
  });
  socket.on('player-left', (id) => {
    const remote = otherPlayers.get(id);
    if (!remote) return;
    scene.remove(remote.mesh);
    remote.mesh.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });
    otherPlayers.delete(id);
    console.log('Player left', id);
  });
  socket.on('restart', () => {
    // Reset graphics and physics state
    tank.position.set(0, 0, 0);
    tank.rotation.set(0, 0, 0);
    turret.rotation.set(0, 0, 0);
    if (gun) gun.rotation.set(0, 0, 0); // keep turret level; reset barrel pitch
    cameraYaw = 0;
    cameraPitch = 0;
    targetYaw = 0;
    targetPitch = 0;
    if (chassisBody) {
      chassisBody.position.set(0, 1, 0);
      chassisBody.velocity.set(0, 0, 0);
      chassisBody.angularVelocity.set(0, 0, 0);
      chassisBody.quaternion.set(0, 0, 0, 1);
    }
    currentSpeed = 0;
    playerHealth = 100;
    // Clear out any remote players so the scene resets cleanly.
    for (const { mesh } of otherPlayers.values()) {
      scene.remove(mesh);
      mesh.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
    }
    otherPlayers.clear();

    // Restore ammunition to the original loadout on restart
    playerAmmo.forEach(a => {
      a.count = loadout[a.name] || 0;
    });
    ammoLeft = playerAmmo.reduce((sum, a) => sum + a.count, 0);
    updateAmmoHUD(playerAmmo, selectedAmmo ? selectedAmmo.name : '');
    lastFireTime = 0;
    updateCooldownHUD(0, FIRE_DELAY > 0 ? FIRE_DELAY : 1);
  });
} else {
  showError('Socket.IO failed to load. Running offline.');
}

// Lobby DOM elements for tank selection
const lobby = document.getElementById('lobby');
const nationColumn = document.getElementById('nationColumn');
const tankTabs = document.getElementById('tankTabs');
const tankList = document.getElementById('tankList');
const ammoColumn = document.getElementById('ammoColumn');
const joinBtn = document.getElementById('joinBtn');
const lobbyError = document.getElementById('lobbyError');
const instructions = document.getElementById('instructions');
let availableTanks = [];
let ammoDefs = [];
let selectedNation = null;
let selectedTank = null;
let selectedClass = null; // current tank class tab
const loadout = {};
// Largest dimension across all tanks; used to render consistent-scale thumbnails
let maxTankDimension = 0;

// Populate lobby columns from server data
async function loadLobbyData() {
  try {
    const [nations, tanks, ammo] = await Promise.all([
      fetch('/api/nations').then(r => r.json()),
      fetch('/api/tanks').then(r => r.json()),
      fetch('/api/ammo').then(r => r.json())
    ]);
    availableTanks = Array.isArray(tanks) ? tanks : [];
    // Determine maximum dimension among all tanks so thumbnails share a scale
    maxTankDimension = availableTanks.reduce((m, t) => {
      const width = t.bodyWidth || 0;
      const height = (t.bodyHeight || 0) + (t.turretHeight || 0);
      const length = (t.bodyLength || 0) + (t.barrelLength || 0);
      return Math.max(m, width, height, length);
    }, 0);
    ammoDefs = Array.isArray(ammo) ? ammo : [];
    nationColumn.innerHTML = '';
    nations.forEach(n => {
      const div = document.createElement('div');
      div.className = 'flag selectable';
      div.textContent = n.flag || '🏳️';
      div.title = n.name;
      div.addEventListener('click', () => {
        selectedNation = n;
        renderTanks();
        highlightSelection(nationColumn, div);
      });
      nationColumn.appendChild(div);
    });
  } catch (err) {
    console.error('loadLobbyData failed', err);
    showError('Failed to load lobby data');
  }
}

function highlightSelection(container, el) {
  container.querySelectorAll('.selected').forEach(i => i.classList.remove('selected'));
  el.classList.add('selected');
}

function renderTanks() {
  tankTabs.innerHTML = '';
  tankList.innerHTML = '';
  ammoColumn.innerHTML = '';
  selectedTank = null;
  if (!selectedNation) return;

  // Build tab list from tank classes available to the chosen nation
  const filtered = availableTanks.filter(t => t.nation === selectedNation.name);
  const classes = [...new Set(filtered.map(t => t.class))];
  selectedClass = classes[0];

  classes.forEach(cls => {
    const tab = document.createElement('button');
    tab.textContent = cls;
    tab.className = 'tab';
    if (cls === selectedClass) tab.classList.add('selected');
    tab.addEventListener('click', () => {
      selectedClass = cls;
      highlightSelection(tankTabs, tab);
      renderTankList(filtered.filter(t => t.class === selectedClass));
    });
    tankTabs.appendChild(tab);
  });

  renderTankList(filtered.filter(t => t.class === selectedClass));
}

// generateTankThumbnail builds a miniature Three.js scene to render a tank
// from an isometric viewpoint. An orthographic camera sized using
// `maxTankDimension` guarantees that every generated image uses the same scale,
// allowing players to compare tank sizes visually.
function generateTankThumbnail(t) {
  const width = 80;
  const height = 60;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(width, height);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dir = new THREE.DirectionalLight(0xffffff, 0.5);
  dir.position.set(5, 10, 7);
  scene.add(dir);

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(t.bodyWidth || 1, t.bodyHeight || 1, t.bodyLength || 1),
    new THREE.MeshStandardMaterial({ color: 0x335533 })
  );
  const turret = new THREE.Mesh(
    new THREE.BoxGeometry(t.turretWidth || 1, t.turretHeight || 1, t.turretLength || 1),
    new THREE.MeshStandardMaterial({ color: 0x556655 })
  );
  turret.position.set(
    (t.turretYPercent || 50) / 100 * (t.bodyWidth || 1) - (t.bodyWidth || 1) / 2,
    (t.bodyHeight || 1) / 2 + (t.turretHeight || 1) / 2,
    (0.5 - (t.turretXPercent || 50) / 100) * (t.bodyLength || 1)
  );

  const gun = new THREE.Mesh(
    new THREE.CylinderGeometry(
      ((t.cannonCaliber || defaultTank.cannonCaliber) / 1000) / 2,
      ((t.cannonCaliber || defaultTank.cannonCaliber) / 1000) / 2,
      t.barrelLength || 1
    ),
    new THREE.MeshStandardMaterial({ color: 0x556655 })
  );
  gun.rotation.x = -Math.PI / 2;
  gun.position.z = -(t.barrelLength || 1) / 2;
  turret.add(gun);
  body.add(turret);
  scene.add(body);

  const size = maxTankDimension || 5;
  const aspect = width / height;
  const camera = new THREE.OrthographicCamera(
    -size,
    size,
    size / aspect,
    -size / aspect,
    0.1,
    100
  );
  camera.position.set(size, size, size);
  camera.lookAt(0, (t.bodyHeight || 1) / 2, 0);
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');

  // Dispose resources to avoid leaking WebGL contexts on repeated renders
  renderer.dispose();
  body.geometry.dispose();
  body.material.dispose();
  turret.geometry.dispose();
  turret.material.dispose();
  gun.geometry.dispose();
  gun.material.dispose();

  return url;
}

// Render clickable tank cards with thumbnail and brief stats for the active class
function renderTankList(list) {
  tankList.innerHTML = '';
  list.forEach(t => {
    // Card wrapper allows us to show text alongside the image
    const card = document.createElement('div');
    card.className = 'tank-card';

    // Thumbnail rendered from tank geometry at a consistent isometric scale
    const img = document.createElement('img');
    if (!t.thumbnail) {
      try {
        t.thumbnail = generateTankThumbnail(t);
      } catch (err) {
        console.error('thumbnail generation failed', err);
      }
    }
    img.src = t.thumbnail || 'https://placehold.co/80x60?text=Tank';
    img.alt = t.name;
    img.loading = 'lazy';

    // Caption summarising key tank info so users can make an informed choice
    const caption = document.createElement('div');
    caption.className = 'tank-caption';
    caption.textContent = `${t.name} (BR ${t.br})`;

    card.appendChild(img);
    card.appendChild(caption);

    card.addEventListener('click', () => {
      selectedTank = t;
      renderAmmo();
      highlightSelection(tankList, card);
    });

    tankList.appendChild(card);
  });
}

function renderAmmo() {
  ammoColumn.innerHTML = '';
  Object.keys(loadout).forEach(k => delete loadout[k]);
  if (!selectedTank) return;
  selectedTank.ammo.forEach(name => {
    const def = ammoDefs.find(a => a.name === name);
    if (!def) return;
    loadout[name] = 0;
    const div = document.createElement('div');
    div.className = 'ammo-item';
    const img = document.createElement('img');
    img.src = def.image || 'https://placehold.co/40x40?text=A';
    img.alt = name;
    const label = document.createElement('span');
    label.textContent = name;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '50';
    slider.value = '0';
    slider.addEventListener('input', () => {
      loadout[name] = parseInt(slider.value, 10);
    });
    div.appendChild(img);
    div.appendChild(label);
    div.appendChild(slider);
    ammoColumn.appendChild(div);
  });
}

joinBtn.addEventListener('click', () => {
  lobbyError.textContent = '';
  if (!selectedTank) {
    lobbyError.textContent = 'Select a tank';
    return;
  }
  lobby.style.display = 'none';
  instructions.style.display = 'block';
  showCrosshair(true);
  applyTankConfig(selectedTank);

  // Build player-specific ammo list from lobby selections
  playerAmmo = Object.entries(loadout)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => ({ name, count }));
  selectedAmmo = playerAmmo[0] || null;
  ammoLeft = playerAmmo.reduce((sum, a) => sum + a.count, 0);
  updateAmmoHUD(playerAmmo, selectedAmmo ? selectedAmmo.name : '');

  if (socket) socket.emit('join', { tank: selectedTank, loadout });
});

if (socket) {
  socket.on('join-denied', (msg) => {
    lobbyError.textContent = msg;
    lobby.style.display = 'block';
    instructions.style.display = 'none';
    updateAmmoHUD([]);
  });
}

loadLobbyData();

// Core scene objects
let tank, turret, gun, camera, scene, renderer, ground;
// Physics objects
let world, chassisBody, groundBody;
// Default tank stats used for movement and rotation
const defaultTank = {
  name: 'Basic',
  br: 1,
  mass: 30000,
  horsepower: 500,
  maxSpeed: 40, // km/h
  maxReverseSpeed: 15, // km/h
  bodyRotation: 20, // seconds for full hull rotation
  turretRotation: 20, // seconds for full turret rotation
  maxTurretIncline: 50,
  maxTurretDecline: 25,
  horizontalTraverse: 0,
  bodyWidth: 2,
  bodyLength: 4,
  bodyHeight: 1,
  turretWidth: 1.5,
  turretLength: 1.5,
  turretHeight: 0.5,
  cannonCaliber: 75,
  barrelLength: 3,
  ammoCapacity: 40,
  mainCannonFireRate: 6,
  turretXPercent: 50,
  turretYPercent: 50
};
// Movement coefficients derived from tank stats; mutable to apply tank-specific values
let MAX_SPEED = defaultTank.maxSpeed / 3.6; // convert km/h to m/s
let MAX_REVERSE_SPEED = defaultTank.maxReverseSpeed / 3.6; // convert km/h to m/s
let TARGET_TURN_RATE = (2 * Math.PI) / defaultTank.bodyRotation; // desired hull yaw speed in rad/s
let ROT_ACCEL = TARGET_TURN_RATE; // rad/s² to reach target rate in ~1 s
let TURRET_ROT_SPEED = (2 * Math.PI) / defaultTank.turretRotation; // turret radians per second
let FIRE_DELAY = 60 / defaultTank.mainCannonFireRate; // seconds between shots
let ammoLeft = defaultTank.ammoCapacity;
let lastFireTime = 0;
// Static friction coefficient representing tracks on typical terrain.
const GROUND_FRICTION = 0.3;
// Viscosity-driven damping ranges keep motion believable across mud/sand/water.
const MIN_ROLLING_DAMPING = 0.15;
const MAX_ROLLING_DAMPING = 0.65;
const BRAKE_DAMPING = 0.85;
// Default traction/viscosity values when palette data is missing or malformed.
const DEFAULT_SURFACE = { traction: 0.9, viscosity: 0.3 };
// Torque applied for A/D rotation; derived from mass, friction, and desired acceleration
let TURN_TORQUE = 0;
let MAX_TURRET_INCLINE = THREE.MathUtils.degToRad(defaultTank.maxTurretIncline);
let MAX_TURRET_DECLINE = THREE.MathUtils.degToRad(defaultTank.maxTurretDecline);
// Turret traverse limit in radians. Non-tank-destroyers keep Infinity to allow
// unrestricted rotation, while tank destroyers use their defined limits.
let MAX_TURRET_TRAVERSE = Infinity;
// Acceleration used when W/S are pressed. Tuned so max speed is reached in a few seconds.
let ACCELERATION = MAX_SPEED / 3;
let currentSpeed = 0;
let cameraMode = 'third'; // 'first' or 'third'

// Target angles driven by mouse movement; turret/gun ease toward these each frame.
// cameraYaw/cameraPitch represent the desired view orientation and can spin freely.
// targetYaw/targetPitch clamp those angles to the turret's mechanical limits so the
// turret gradually chases the camera.
let cameraYaw = 0; // radians around the Y axis for the view
let cameraPitch = 0; // radians around the X axis for the view
let targetYaw = 0; // turret yaw target (limited)
let targetPitch = 0; // turret pitch target (limited)
// Default camera spacing and the height of the point the camera tracks above the
// tank. Values load from localStorage so admins can tweak behaviour from the
// settings page without touching code.
let cameraDistance = parseFloat(localStorage.getItem('cameraDistance') || '10');
let cameraTargetHeight = parseFloat(localStorage.getItem('cameraTargetHeight') || '3');
console.debug('[camera] init', { cameraDistance, cameraTargetHeight });
const keys = {};
const DEBUG_MOVEMENT = false;
const logMovement = (...args) => { if (DEBUG_MOVEMENT) console.debug('[movement]', ...args); };

// Timing and networking helpers
const clock = new THREE.Clock(); // tracks frame timing for physics updates
let lastNetwork = 0;
let lastState = { x: 0, y: 0, z: 0, rot: 0, turret: 0, gun: 0 };

// Always initialize scene so the client can operate even without networking.
init();

function disposeTerrain() {
  if (ground) {
    scene.remove(ground);
    if (ground.geometry) ground.geometry.dispose();
    if (Array.isArray(ground.material)) {
      ground.material.forEach((mat) => mat.dispose());
    } else if (ground.material) {
      ground.material.dispose();
    }
    ground = null;
  }
  if (groundTexture) {
    groundTexture.dispose();
    groundTexture = null;
  }
  if (world && groundBody) {
    world.removeBody(groundBody);
    groundBody = null;
  }
}

function updateLighting(lightingSettings) {
  const settings = lightingSettings && typeof lightingSettings === 'object' ? lightingSettings : fallbackLighting;
  if (sunLight) {
    const sunPos = settings.sunPosition || fallbackLighting.sunPosition;
    sunLight.position.set(sunPos.x ?? fallbackLighting.sunPosition.x, sunPos.y ?? fallbackLighting.sunPosition.y, sunPos.z ?? fallbackLighting.sunPosition.z);
    sunLight.color.set(settings.sunColor || fallbackLighting.sunColor);
  }
  if (ambientLight) {
    ambientLight.color.set(settings.ambientColor || fallbackLighting.ambientColor);
  }
  if (scene) {
    const base = new THREE.Color(settings.ambientColor || fallbackLighting.ambientColor);
    const highlight = new THREE.Color(settings.sunColor || fallbackLighting.sunColor);
    const sky = base.clone().lerp(highlight, 0.35);
    scene.background = sky;
    if (renderer) renderer.setClearColor(sky);
  }
}

function buildLegacyTerrain(name) {
  if (!scene) return;
  disposeTerrain();
  const geometry = name === 'hill' || name === 'valley'
    ? new THREE.PlaneGeometry(200, 200, 10, 10)
    : new THREE.PlaneGeometry(200, 200, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color: 0x507140 });
  ground = new THREE.Mesh(geometry, material);
  const pos = geometry.attributes.position;
  if (name === 'hill' || name === 'valley') {
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const dist = Math.sqrt(x * x + y * y);
      const height = Math.max(0, 10 - dist / 5);
      pos.setZ(i, name === 'valley' ? -height : height);
    }
    geometry.computeVertexNormals();
  }
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  if (world) {
    const elementSize = 200 / 10;
    let shape;
    if (name === 'hill' || name === 'valley') {
      const data = [];
      for (let i = 0; i <= 10; i++) {
        data[i] = [];
        for (let j = 0; j <= 10; j++) {
          const x = (i - 5) * elementSize;
          const y = (j - 5) * elementSize;
          const dist = Math.sqrt(x * x + y * y);
          const height = Math.max(0, 10 - dist / 5);
          data[i][j] = name === 'valley' ? -height : height;
        }
      }
      shape = new CANNON.Heightfield(data, { elementSize });
      groundBody = new CANNON.Body({ mass: 0 });
      groundBody.addShape(shape, new CANNON.Vec3(-100, 0, -100));
      groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    } else {
      shape = new CANNON.Plane();
      groundBody = new CANNON.Body({ mass: 0 });
      groundBody.addShape(shape);
      groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    }
    world.addBody(groundBody);
  }
  updateLighting(null);
  currentTerrainDefinition = null;
}

function buildTerrainFromDefinition(definition) {
  if (!scene || !definition) {
    buildLegacyTerrain('flat');
    return;
  }
  const elevation = Array.isArray(definition.elevation) ? definition.elevation : [];
  if (!elevation.length || !Array.isArray(elevation[0])) {
    buildLegacyTerrain(definition.name || 'flat');
    return;
  }
  disposeTerrain();
  const rows = elevation.length;
  const cols = elevation[0].length;
  const widthMeters = Math.max(1, (definition.size?.x ?? 1) * 1000);
  const heightMeters = Math.max(1, (definition.size?.y ?? 1) * 1000);
  const geometry = new THREE.PlaneGeometry(widthMeters, heightMeters, Math.max(1, cols - 1), Math.max(1, rows - 1));
  const positions = geometry.attributes.position;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const index = y * cols + x;
      const value = elevation[y][x];
      positions.setZ(index, Number.isFinite(value) ? value : 0);
    }
  }
  geometry.computeVertexNormals();
  const palette = Array.isArray(definition.palette) && definition.palette.length ? definition.palette : fallbackPalette;
  const groundGrid = Array.isArray(definition.ground) && definition.ground.length ? definition.ground : Array.from({ length: rows }, () => Array(cols).fill(0));
  if (groundTexture) {
    groundTexture.dispose();
    groundTexture = null;
  }
  groundTexture = buildGroundTexture(palette, groundGrid);
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: groundTexture,
    roughness: 0.95,
    metalness: 0.05
  });
  ground = new THREE.Mesh(geometry, material);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  if (world) {
    // Use a Cannon Trimesh so physics matches the rendered mesh for any map ratio.
    const physicsGeometry = geometry.clone();
    physicsGeometry.rotateX(-Math.PI / 2);
    const positionAttr = physicsGeometry.attributes.position;
    const vertices = new Float32Array(positionAttr.array.length);
    vertices.set(positionAttr.array);
    let indicesArray;
    if (physicsGeometry.index) {
      const indexAttr = physicsGeometry.index.array;
      indicesArray = indexAttr instanceof Uint32Array
        ? new Uint32Array(indexAttr)
        : new Uint16Array(indexAttr);
    } else {
      const vertexCount = positionAttr.count;
      indicesArray = vertexCount > 65535
        ? new Uint32Array(vertexCount)
        : new Uint16Array(vertexCount);
      for (let i = 0; i < indicesArray.length; i++) indicesArray[i] = i;
    }
    const shape = new CANNON.Trimesh(vertices, indicesArray);
    groundBody = new CANNON.Body({ mass: 0 });
    groundBody.addShape(shape);
    world.addBody(groundBody);
    physicsGeometry.dispose();
  }
  updateLighting(definition.lighting);
  currentTerrainDefinition = definition;
}

function applyTerrainPayload(payload) {
  if (payload && typeof payload === 'object' && payload.definition) {
    buildTerrainFromDefinition(payload.definition);
  } else if (typeof payload === 'string') {
    buildLegacyTerrain(payload);
  } else {
    buildLegacyTerrain('flat');
  }
}

// Determine the traction and viscosity under the provided world-space position.
// Values default to sane behaviour when palette data is missing so gameplay continues.
function sampleSurfaceResponse(position) {
  if (!currentTerrainDefinition || !position) return { ...DEFAULT_SURFACE };
  const ground = Array.isArray(currentTerrainDefinition.ground)
    ? currentTerrainDefinition.ground
    : null;
  const palette = Array.isArray(currentTerrainDefinition.palette)
    ? currentTerrainDefinition.palette
    : null;
  if (!ground || !ground.length || !palette || !palette.length) return { ...DEFAULT_SURFACE };
  const rows = ground.length;
  const cols = ground[0].length;
  if (!rows || !cols) return { ...DEFAULT_SURFACE };
  const width = Math.max(1, (currentTerrainDefinition.size?.x ?? 1) * 1000);
  const height = Math.max(1, (currentTerrainDefinition.size?.y ?? 1) * 1000);
  const normX = THREE.MathUtils.clamp((position.x + width / 2) / width, 0, 0.999);
  const normZ = THREE.MathUtils.clamp((position.z + height / 2) / height, 0, 0.999);
  const xIndex = Math.min(cols - 1, Math.floor(normX * cols));
  const zIndex = Math.min(rows - 1, Math.floor(normZ * rows));
  const row = Array.isArray(ground[zIndex]) ? ground[zIndex] : null;
  if (!row || !row.length) return { ...DEFAULT_SURFACE };
  const paletteIndex = row[Math.min(xIndex, row.length - 1)];
  const entry =
    Number.isFinite(paletteIndex) && palette[paletteIndex]
      ? palette[paletteIndex]
      : null;
  const traction = Number.isFinite(entry?.traction)
    ? entry.traction
    : DEFAULT_SURFACE.traction;
  const viscosity = Number.isFinite(entry?.viscosity)
    ? entry.viscosity
    : DEFAULT_SURFACE.viscosity;
  return {
    traction: THREE.MathUtils.clamp(traction, 0.05, 2),
    viscosity: THREE.MathUtils.clamp(viscosity, 0, 1)
  };
}

function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(fallbackLighting.ambientColor);

  ambientLight = new THREE.AmbientLight(fallbackLighting.ambientColor, 0.6);
  scene.add(ambientLight);
  sunLight = new THREE.DirectionalLight(fallbackLighting.sunColor, 1.1);
  sunLight.position.set(
    fallbackLighting.sunPosition.x,
    fallbackLighting.sunPosition.y,
    fallbackLighting.sunPosition.z
  );
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = 1500;
  sunLight.shadow.camera.left = -600;
  sunLight.shadow.camera.right = 600;
  sunLight.shadow.camera.top = 600;
  sunLight.shadow.camera.bottom = -600;
  scene.add(sunLight);

  // Physics world with standard gravity
  world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  buildLegacyTerrain('flat');

  // Tank body graphics
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(defaultTank.bodyWidth, defaultTank.bodyHeight, defaultTank.bodyLength),
    new THREE.MeshStandardMaterial({ color: 0x555555 })
  );
  body.castShadow = true;
  body.receiveShadow = true;
  scene.add(body);
  tank = body;

  // Turret and gun
  turret = new THREE.Mesh(
    new THREE.BoxGeometry(defaultTank.turretWidth, defaultTank.turretHeight, defaultTank.turretLength),
    new THREE.MeshStandardMaterial({ color: 0x777777 })
  );
  turret.castShadow = true;
  turret.receiveShadow = true;
  turret.position.set(
    (defaultTank.turretYPercent / 100 - 0.5) * defaultTank.bodyWidth,
    defaultTank.bodyHeight / 2 + defaultTank.turretHeight / 2,
    (0.5 - defaultTank.turretXPercent / 100) * defaultTank.bodyLength
  );

  // Gun pivot exposes rotation.x for pitch; barrel mesh aims down the -Z axis.
  gun = new THREE.Object3D();
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(
      (defaultTank.cannonCaliber / 1000) / 2,
      (defaultTank.cannonCaliber / 1000) / 2,
      defaultTank.barrelLength
    ),
    new THREE.MeshStandardMaterial({ color: 0x777777 })
  );
  barrel.rotation.x = -Math.PI / 2; // orient along -Z
  barrel.position.z = -defaultTank.barrelLength / 2; // move so base sits at turret center
  barrel.castShadow = true;
  barrel.receiveShadow = true;
  gun.add(barrel);
  turret.add(gun);
  tank.add(turret);

  // Chassis physics body mirrors tank mesh
  const box = new CANNON.Box(new CANNON.Vec3(defaultTank.bodyWidth / 2, defaultTank.bodyHeight / 2, defaultTank.bodyLength / 2));
  chassisBody = new CANNON.Body({ mass: defaultTank.mass });
  chassisBody.addShape(box);
  // Update inertia tensor now that the shape is attached.
  chassisBody.updateMassProperties();
  // Precompute torque needed to overcome friction and accelerate hull rotation.
  // Use track spacing (tank width) as the lever arm for differential steering.
  const trackWidth = defaultTank.bodyWidth;
  const frictionTorque =
    chassisBody.mass * 9.82 * GROUND_FRICTION * (trackWidth / 2);
  const desiredAngularAccel = ROT_ACCEL; // rad/s² to hit target turn rate quickly
  TURN_TORQUE = frictionTorque + chassisBody.inertia.y * desiredAngularAccel;
  chassisBody.position.set(0, defaultTank.bodyHeight / 2, 0);
  chassisBody.angularFactor.set(0, 1, 0);
  // Lower angular damping so applied torque produces visible rotation.
  chassisBody.angularDamping = 0.2;
  chassisBody.linearDamping = MIN_ROLLING_DAMPING; // simulate base ground drag
  world.addBody(chassisBody);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);
  updateLighting(currentTerrainDefinition?.lighting ?? null);

  // Build HUD overlay to display runtime metrics and hide crosshair until gameplay
  initHUD();
  updateAmmoHUD([]);
  updateCooldownHUD(0, 1);
  showCrosshair(false);

  // Only engage pointer lock once the lobby is hidden so menu interactions
  // don't immediately start controlling the tank.
  document.body.addEventListener('click', () => {
    if (lobby.style.display === 'none' && !document.pointerLockElement) {
      // requestPointerLock returns a promise in modern browsers. If the user
      // presses Escape before it resolves, the promise rejects with a
      // SecurityError. Capture and log that failure so our global
      // `unhandledrejection` handler doesn't surface it as a fatal overlay.
      const lockAttempt = document.body.requestPointerLock();
      if (lockAttempt && typeof lockAttempt.catch === 'function') {
        lockAttempt.catch((err) =>
          console.warn('Pointer lock request rejected', err)
        );
      }
    }
  });

  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement) {
      document.addEventListener('mousemove', onMouseMove);
    } else {
      document.removeEventListener('mousemove', onMouseMove);
    }
  });

  window.addEventListener('keydown', (e) => {
    keys[e.key.toLowerCase()] = true;
    if (e.key === 'v') cameraMode = cameraMode === 'third' ? 'first' : 'third';
    if (e.key >= '1' && e.key <= '9') {
      const idx = parseInt(e.key, 10) - 1;
      if (playerAmmo[idx]) {
        selectedAmmo = playerAmmo[idx];
        updateAmmoHUD(playerAmmo, selectedAmmo.name);
        console.log('Selected ammo', selectedAmmo.name);
      }
    }
  });
  window.addEventListener('keyup', (e) => {
    keys[e.key.toLowerCase()] = false;
  });

  window.addEventListener('wheel', (e) => {
    cameraDistance = Math.min(Math.max(cameraDistance + e.deltaY * 0.01, 5), 20);
    localStorage.setItem('cameraDistance', String(cameraDistance));
  });

  // Require pointer lock before firing so lobby clicks can't trigger shots.
  window.addEventListener('mousedown', () => {
    if (document.pointerLockElement && socket && selectedAmmo) {
      const now = Date.now();
      if (
        now - lastFireTime >= FIRE_DELAY * 1000 &&
        ammoLeft > 0 &&
        selectedAmmo.count > 0
      ) {
        console.debug('Firing', selectedAmmo.name);
        socket.emit('fire', selectedAmmo.name);
        lastFireTime = now;
        selectedAmmo.count -= 1;
        ammoLeft -= 1;
        updateAmmoHUD(playerAmmo, selectedAmmo.name);
        console.debug('Ammo remaining', ammoLeft);
      }
    }
  });

  animate();
}

function applyTankConfig(t) {
  MAX_SPEED = (t.maxSpeed ?? defaultTank.maxSpeed) / 3.6;
  MAX_REVERSE_SPEED = (t.maxReverseSpeed ?? defaultTank.maxReverseSpeed) / 3.6;
  TARGET_TURN_RATE = (2 * Math.PI) / (t.bodyRotation ?? defaultTank.bodyRotation);
  ROT_ACCEL = TARGET_TURN_RATE; // adjust if slower turn ramp is desired
  TURRET_ROT_SPEED = (2 * Math.PI) / (t.turretRotation ?? defaultTank.turretRotation);
  MAX_TURRET_INCLINE = THREE.MathUtils.degToRad(t.maxTurretIncline ?? defaultTank.maxTurretIncline);
  MAX_TURRET_DECLINE = THREE.MathUtils.degToRad(t.maxTurretDecline ?? defaultTank.maxTurretDecline);
  // Only apply horizontal traverse limits for tank destroyers; other classes rotate freely.
  const traverseDeg =
    t.class === 'Tank Destroyer'
      ? t.horizontalTraverse ?? defaultTank.horizontalTraverse
      : 0;
  MAX_TURRET_TRAVERSE =
    traverseDeg === 0 ? Infinity : THREE.MathUtils.degToRad(traverseDeg);
  ACCELERATION = MAX_SPEED / 3;
  FIRE_DELAY = 60 / (t.mainCannonFireRate ?? defaultTank.mainCannonFireRate);
  ammoLeft = t.ammoCapacity ?? defaultTank.ammoCapacity;
  lastFireTime = 0;
  updateCooldownHUD(0, FIRE_DELAY > 0 ? FIRE_DELAY : 1);

  // Reset orientation targets so camera and turret start aligned for new stats
  cameraYaw = 0;
  cameraPitch = 0;
  targetYaw = 0;
  targetPitch = 0;
  turret.rotation.set(0, 0, 0);
  if (gun) gun.rotation.set(0, 0, 0);

  tank.geometry.dispose();
  tank.geometry = new THREE.BoxGeometry(
    t.bodyWidth ?? defaultTank.bodyWidth,
    t.bodyHeight ?? defaultTank.bodyHeight,
    t.bodyLength ?? defaultTank.bodyLength
  );
  turret.geometry.dispose();
  turret.geometry = new THREE.BoxGeometry(
    t.turretWidth ?? defaultTank.turretWidth,
    t.turretHeight ?? defaultTank.turretHeight,
    t.turretLength ?? defaultTank.turretLength
  );
  turret.position.set(
    ((t.turretYPercent ?? defaultTank.turretYPercent) / 100 - 0.5) *
      (t.bodyWidth ?? defaultTank.bodyWidth),
    (t.bodyHeight ?? defaultTank.bodyHeight) / 2 +
      (t.turretHeight ?? defaultTank.turretHeight) / 2,
    (0.5 - (t.turretXPercent ?? defaultTank.turretXPercent) / 100) *
      (t.bodyLength ?? defaultTank.bodyLength)
  );
  if (gun && gun.children[0]) {
    gun.remove(gun.children[0]);
  }
  const newBarrel = new THREE.Mesh(
    new THREE.CylinderGeometry(
      ((t.cannonCaliber ?? defaultTank.cannonCaliber) / 1000) / 2,
      ((t.cannonCaliber ?? defaultTank.cannonCaliber) / 1000) / 2,
      t.barrelLength ?? defaultTank.barrelLength
    ),
    new THREE.MeshStandardMaterial({ color: 0x777777 })
  );
  newBarrel.rotation.x = -Math.PI / 2;
  newBarrel.position.z = -(t.barrelLength ?? defaultTank.barrelLength) / 2;
  gun.add(newBarrel);

  world.removeBody(chassisBody);
  const box = new CANNON.Box(
    new CANNON.Vec3(
      (t.bodyWidth ?? defaultTank.bodyWidth) / 2,
      (t.bodyHeight ?? defaultTank.bodyHeight) / 2,
      (t.bodyLength ?? defaultTank.bodyLength) / 2
    )
  );
  chassisBody = new CANNON.Body({ mass: t.mass ?? defaultTank.mass });
  chassisBody.addShape(box);
  // Refresh inertia tensor and compute turn torque including inertia.
  chassisBody.updateMassProperties();
  // Use track spacing (tank width) to estimate ground resistance moment.
  const trackWidth = t.bodyWidth ?? defaultTank.bodyWidth;
  const frictionTorque =
    chassisBody.mass * 9.82 * GROUND_FRICTION * (trackWidth / 2);
  const desiredAngularAccel = ROT_ACCEL;
  TURN_TORQUE = frictionTorque + chassisBody.inertia.y * desiredAngularAccel;
  chassisBody.position.set(0, (t.bodyHeight ?? defaultTank.bodyHeight) / 2, 0);
  chassisBody.angularFactor.set(0, 1, 0);
  // Reduced damping keeps hull rotation responsive.
  chassisBody.angularDamping = 0.2;
  chassisBody.linearDamping = MIN_ROLLING_DAMPING;
  world.addBody(chassisBody);
  currentSpeed = 0;
}

function onMouseMove(e) {
  const sensitivity = 0.002; // radians per pixel of mouse movement
  // Update the free camera orientation. Yaw no longer wraps at ±π so the turret
  // can rotate continuously without snapping when crossing the rear arc of the tank.
  cameraYaw -= e.movementX * sensitivity;
  // Vertical movement is inverted so dragging up looks up. Clamp to avoid flipping.
  cameraPitch = THREE.MathUtils.clamp(
    cameraPitch + e.movementY * sensitivity,
    -Math.PI / 2 + 0.01,
    Math.PI / 2 - 0.01
  );

  // Turret targets chase the camera orientation but respect mechanical limits.
  targetYaw = THREE.MathUtils.clamp(
    cameraYaw,
    -MAX_TURRET_TRAVERSE,
    MAX_TURRET_TRAVERSE
  );
  targetPitch = THREE.MathUtils.clamp(
    cameraPitch,
    -MAX_TURRET_DECLINE,
    MAX_TURRET_INCLINE
  );
}
/**
 * updateMovement translates key inputs into physics state. It constrains the
 * chassis to horizontal movement while allowing yaw rotation.
 */
function updateMovement() {
  const surface = sampleSurfaceResponse(chassisBody?.position);
  const tractionScale = surface.traction;
  const viscosity = surface.viscosity;
  // Translate key input into continuous forces rather than direct velocity changes
  let throttle = 0;
  if (keys['w']) throttle = 1;
  else if (keys['s']) throttle = -1;
  if (throttle !== 0) {
    const withinLimits =
      (throttle > 0 && currentSpeed < MAX_SPEED) ||
      (throttle < 0 && currentSpeed > -MAX_REVERSE_SPEED);
    if (withinLimits) {
      const force = throttle * ACCELERATION * tractionScale * chassisBody.mass;
      // Negative Z is forward in local space; applying at center of mass
      chassisBody.applyLocalForce(new CANNON.Vec3(0, 0, -force), new CANNON.Vec3(0, 0, 0));
    }
  }

  // Apply direct torque for rotation around the Y axis
  let turn = 0;
  if (keys['a']) turn = 1;
  else if (keys['d']) turn = -1;
  if (turn !== 0) {
    chassisBody.wakeUp(); // ensure sleeping bodies respond immediately
    chassisBody.torque.y += turn * TURN_TORQUE * tractionScale;
  }

  // Simple hand brake: increase damping while space is held
  const rollingDrag = THREE.MathUtils.lerp(MIN_ROLLING_DAMPING, MAX_ROLLING_DAMPING, viscosity);
  chassisBody.linearDamping = keys[' '] ? BRAKE_DAMPING : rollingDrag;
}

function animate() {
  requestAnimationFrame(animate);

  // Frame timing used for physics and acceleration integration
  const delta = clock.getDelta();
  updateMovement();

  // Step physics world with fixed timestep
  world.step(1 / 60, delta, 3);

  // Calculate speed along the forward vector and log for debugging
  const forward = new CANNON.Vec3(0, 0, -1);
  chassisBody.quaternion.vmult(forward, forward);
  currentSpeed = forward.dot(chassisBody.velocity);
  logMovement('spd', currentSpeed.toFixed(2), 'ang', chassisBody.angularVelocity.y.toFixed(2));

  // Sync Three.js mesh with physics body
  tank.position.copy(chassisBody.position);
  tank.quaternion.copy(chassisBody.quaternion);

  // Move client-side projectile meshes based on server-provided velocities
  for (const proj of projectiles.values()) {
    proj.vy += GRAVITY * delta;
    proj.mesh.position.x += proj.vx * delta;
    proj.mesh.position.y += proj.vy * delta;
    proj.mesh.position.z += proj.vz * delta;
  }

  // Smoothly rotate turret and gun toward target angles
  const yawDiff = targetYaw - turret.rotation.y;
  const yawStep = THREE.MathUtils.clamp(
    yawDiff,
    -TURRET_ROT_SPEED * delta,
    TURRET_ROT_SPEED * delta
  );
  turret.rotation.y = THREE.MathUtils.clamp(
    turret.rotation.y + yawStep,
    -MAX_TURRET_TRAVERSE,
    MAX_TURRET_TRAVERSE
  );

  const pitchDiff = targetPitch - gun.rotation.x;
  const pitchStep = THREE.MathUtils.clamp(
    pitchDiff,
    -TURRET_ROT_SPEED * delta,
    TURRET_ROT_SPEED * delta
  );
  gun.rotation.x = THREE.MathUtils.clamp(
    gun.rotation.x + pitchStep,
    -MAX_TURRET_DECLINE,
    MAX_TURRET_INCLINE
  );

  // Update HUD with current speed, inclination and health
  const speedKmh = currentSpeed * 3.6;
  const inclination = THREE.MathUtils.radToDeg(tank.rotation.x);
  updateHUD(speedKmh, inclination, playerHealth);

  updateCamera();
  renderer.render(scene, camera);
  const reloadRemaining = Math.max(0, FIRE_DELAY - (Date.now() - lastFireTime) / 1000);
  updateCooldownHUD(reloadRemaining, FIRE_DELAY > 0 ? FIRE_DELAY : 1);

  // Throttle network updates to minimize bandwidth
  if (socket) {
    const now = performance.now();
    if (now - lastNetwork > 100) {
      const state = {
        x: chassisBody.position.x,
        y: chassisBody.position.y,
        z: chassisBody.position.z,
        rot: tank.rotation.y,
        turret: turret.rotation.y,
        gun: gun.rotation.x
      };
      const diff =
        Math.abs(state.x - lastState.x) +
        Math.abs(state.y - lastState.y) +
        Math.abs(state.z - lastState.z) +
        Math.abs(state.rot - lastState.rot) +
        Math.abs(state.turret - lastState.turret) +
        Math.abs(state.gun - lastState.gun);
      if (diff > 0.01) {
        socket.emit('update', state);
        lastState = state;
      }
      lastNetwork = now;
    }
  }
}

/**
 * updateCamera positions the view based on mouse-driven target angles. The
 * camera responds instantly to mouse movement while the turret eases toward
 * the same target yaw/pitch values. Third person uses a simple spherical
 * orbit; first person locks the view to the target orientation.
 */
function updateCamera() {
  // Camera orientation is driven directly by mouse input (cameraYaw/cameraPitch).
  // The turret will ease toward targetYaw/targetPitch separately.
  const yaw = tank.rotation.y + cameraYaw; // world yaw the camera should face
  // cameraPitch convention: positive values mean the player is aiming downward.
  // updateCamera translates that into the correct orientation for each mode.
  const pitch = cameraPitch; // world pitch the camera should face

  if (cameraMode === 'third') {
    // Orbit around the tank using spherical coordinates so the view rotates
    // immediately with the mouse. The camera tracks a point above the tank
    // so players see more of the battlefield. Raising the focal point is
    // especially useful on hilly terrain.
    const radius = cameraDistance;
    const target = tank.position.clone().add(new THREE.Vector3(0, cameraTargetHeight, 0));
    const offset = new THREE.Vector3(
      radius * Math.sin(yaw) * Math.cos(pitch),
      radius * Math.sin(pitch),
      radius * Math.cos(yaw) * Math.cos(pitch)
    );
    camera.position.copy(target).add(offset);
    camera.lookAt(target);
  } else {
    // First-person camera positioned at turret height. Orientation is derived
    // from the target angles so the view snaps immediately while the turret
    // model lags behind.
    const baseOffset = new THREE.Vector3(0, 1, 0)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    camera.position.copy(tank.position).add(baseOffset);

    // In first-person mode cameraPitch stores positive values when aiming downward.
    // three.js' Euler expects positive pitch to look upward, so invert the value here
    // to keep mouse movement consistent between camera modes.
    const orientation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-pitch, yaw, 0, 'YXZ')
    );
    const look = new THREE.Vector3(0, 0, -1).applyQuaternion(orientation);
    camera.lookAt(camera.position.clone().add(look));
  }
}

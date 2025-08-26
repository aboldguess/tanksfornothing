// tanksfornothing-client.js
// Summary: Browser client for Tanks for Nothing. Provides lobby tank selection,
//          renders a dimensioned 3D tank based on server-supplied parameters,
//          handles user input and firing mechanics, uses Cannon.js for simple
//          collision physics, force-based tank movement and synchronizes state
//          with a server via Socket.IO.
// Structure: lobby data fetch -> scene setup -> physics setup -> input handling ->
//             firing helpers -> movement update -> animation loop -> optional networking.
// Usage: Included by index.html; requires Socket.IO for multiplayer networking and
//         loads Cannon.js from CDN for physics.
// ---------------------------------------------------------------------------
import * as THREE from './libs/three.module.js';
// cannon-es provides lightweight rigid body physics with vehicle helpers.
// Imported from CDN to keep repository light while using the latest version.
import * as CANNON from 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';
import { initHUD, updateHUD } from './hud.js';

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
let ammoList = [];
let selectedAmmo = null;
const projectiles = new Map(); // id -> { mesh, vx, vy, vz }
let playerHealth = 100;

if (window.io) {
  socket = window.io();
  socket.on('connect', () => console.log('Connected to server'));
  socket.on('connect_error', () => showError('Unable to connect to server. Running offline.'));
  socket.on('disconnect', () => showError('Disconnected from server. Running offline.'));
  socket.on('terrain', (name) => buildTerrain(name));
  socket.on('ammo', (list) => {
    ammoList = Array.isArray(list) ? list : [];
    selectedAmmo = ammoList[0] || null;
    console.log('Ammo received', ammoList);
  });
  socket.on('projectile-fired', (p) => {
    if (!scene) return;
    const geom = new THREE.SphereGeometry(0.1, 8, 8);
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
  socket.on('restart', () => {
    // Reset graphics and physics state
    tank.position.set(0, 0, 0);
    tank.rotation.set(0, 0, 0);
    turret.rotation.set(0, 0, 0);
    if (chassisBody) {
      chassisBody.position.set(0, 1, 0);
      chassisBody.velocity.set(0, 0, 0);
      chassisBody.angularVelocity.set(0, 0, 0);
      chassisBody.quaternion.set(0, 0, 0, 1);
    }
    currentSpeed = 0;
    playerHealth = 100;
  });
} else {
  showError('Socket.IO failed to load. Running offline.');
}

// Lobby DOM elements for tank selection
const lobby = document.getElementById('lobby');
const nationSelect = document.getElementById('nationSelect');
const tankSelect = document.getElementById('tankSelect');
const joinBtn = document.getElementById('joinBtn');
const lobbyError = document.getElementById('lobbyError');
const instructions = document.getElementById('instructions');
let availableTanks = [];

// Populate nation and tank dropdowns from server data
async function loadLobbyData() {
  try {
    const [nations, tanks] = await Promise.all([
      fetch('/api/nations').then(r => r.json()),
      fetch('/api/tanks').then(r => r.json())
    ]);
    availableTanks = Array.isArray(tanks) ? tanks : [];
    nations.forEach(n => {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = n;
      nationSelect.appendChild(opt);
    });
    nationSelect.addEventListener('change', updateTankOptions);
    updateTankOptions();
  } catch (err) {
    showError('Failed to load tank data');
  }
}

function updateTankOptions() {
  tankSelect.innerHTML = '';
  const filtered = availableTanks.filter(t => t.nation === nationSelect.value);
  filtered.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.name;
    opt.textContent = `${t.name} (BR ${t.br})`;
    tankSelect.appendChild(opt);
  });
}

joinBtn.addEventListener('click', () => {
  lobbyError.textContent = '';
  const tank = availableTanks.find(
    t => t.name === tankSelect.value && t.nation === nationSelect.value
  );
  if (!tank) {
    lobbyError.textContent = 'Invalid selection';
    return;
  }
  lobby.style.display = 'none';
  instructions.style.display = 'block';
  applyTankConfig(tank);
  if (socket) socket.emit('join', tank);
});

if (socket) {
  socket.on('join-denied', (msg) => {
    lobbyError.textContent = msg;
    lobby.style.display = 'block';
    instructions.style.display = 'none';
  });
}

loadLobbyData();

let tank, turret, camera, scene, renderer, ground;
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
  bodyRotation: 20, // seconds for full rotation
  maxTurretIncline: 50,
  maxTurretDecline: 25,
  horizontalTraverse: 0,
  bodyWidth: 2,
  bodyLength: 4,
  bodyHeight: 1,
  turretWidth: 1.5,
  turretLength: 1.5,
  turretHeight: 0.5
};
// Movement coefficients derived from tank stats; mutable to apply tank-specific values
let MAX_SPEED = defaultTank.maxSpeed / 3.6; // convert km/h to m/s
let MAX_REVERSE_SPEED = defaultTank.maxReverseSpeed / 3.6; // convert km/h to m/s
let ROT_SPEED = (2 * Math.PI) / defaultTank.bodyRotation; // radians per second
// Torque applied for A/D rotation; computed once mass is known
let TURN_TORQUE = 0;
let MAX_TURRET_INCLINE = THREE.MathUtils.degToRad(defaultTank.maxTurretIncline);
let MAX_TURRET_DECLINE = THREE.MathUtils.degToRad(defaultTank.maxTurretDecline);
let MAX_TURRET_TRAVERSE = Infinity; // radians; Infinity allows full rotation
// Acceleration used when W/S are pressed. Tuned so max speed is reached in a few seconds.
let ACCELERATION = MAX_SPEED / 3;
let currentSpeed = 0;
let cameraMode = 'third'; // 'first' or 'third'
let cameraDistance = 10;
const keys = {};
const DEBUG_MOVEMENT = false;
const logMovement = (...args) => { if (DEBUG_MOVEMENT) console.debug('[movement]', ...args); };

// Timing and networking helpers
const clock = new THREE.Clock(); // tracks frame timing for physics updates
let lastNetwork = 0;
let lastState = { x: 0, y: 0, z: 0, rot: 0, turret: 0 };

// Always initialize scene so the client can operate even without networking.
init();

// Build ground mesh based on terrain name.
function buildTerrain(name) {
  if (!scene) return;
  // Remove old graphics and physics terrain
  if (ground) {
    ground.geometry.dispose();
    ground.material.dispose();
    scene.remove(ground);
  }
  if (world && groundBody) {
    world.removeBody(groundBody);
    groundBody = null;
  }

  // Helper to generate height data for physics heightfields
  const buildHeightField = (evaluator) => {
    const size = 10; // segments per side
    const data = [];
    for (let i = 0; i <= size; i++) {
      data[i] = [];
      for (let j = 0; j <= size; j++) {
        const x = (i - size / 2) * (200 / size);
        const y = (j - size / 2) * (200 / size);
        data[i][j] = evaluator(x, y);
      }
    }
    const shape = new CANNON.Heightfield(data, { elementSize: 200 / size });
    const body = new CANNON.Body({ mass: 0 });
    body.addShape(shape, new CANNON.Vec3(-100, 0, -100)); // shift to match mesh
    body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(body);
    groundBody = body;
  };

  switch (name) {
    case 'hill': {
      ground = new THREE.Mesh(
        new THREE.PlaneGeometry(200, 200, 10, 10),
        new THREE.MeshStandardMaterial({ color: 0x228822 })
      );
      const pos = ground.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const dist = Math.sqrt(x * x + y * y);
        const height = Math.max(0, 10 - dist / 5);
        pos.setZ(i, height);
      }
      ground.geometry.computeVertexNormals();
      buildHeightField((x, y) => {
        const dist = Math.sqrt(x * x + y * y);
        return Math.max(0, 10 - dist / 5);
      });
      break;
    }
    case 'valley': {
      ground = new THREE.Mesh(
        new THREE.PlaneGeometry(200, 200, 10, 10),
        new THREE.MeshStandardMaterial({ color: 0x228822 })
      );
      const pos = ground.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const dist = Math.sqrt(x * x + y * y);
        const height = -Math.max(0, 10 - dist / 5);
        pos.setZ(i, height);
      }
      ground.geometry.computeVertexNormals();
      buildHeightField((x, y) => {
        const dist = Math.sqrt(x * x + y * y);
        return -Math.max(0, 10 - dist / 5);
      });
      break;
    }
    default:
      ground = new THREE.Mesh(
        new THREE.PlaneGeometry(200, 200),
        new THREE.MeshStandardMaterial({ color: 0x228822 })
      );
      const plane = new CANNON.Plane();
      groundBody = new CANNON.Body({ mass: 0 });
      groundBody.addShape(plane);
      groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
      world.addBody(groundBody);
  }
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
}

function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xa0d0ff);

  const light = new THREE.HemisphereLight(0xffffff, 0x444444);
  light.position.set(0, 20, 0);
  scene.add(light);

  // Physics world with standard gravity
  world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  buildTerrain('flat');

  // Tank body graphics
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(defaultTank.bodyWidth, defaultTank.bodyHeight, defaultTank.bodyLength),
    new THREE.MeshStandardMaterial({ color: 0x555555 })
  );
  scene.add(body);
  tank = body;

  // Turret and gun
  turret = new THREE.Mesh(
    new THREE.BoxGeometry(defaultTank.turretWidth, defaultTank.turretHeight, defaultTank.turretLength),
    new THREE.MeshStandardMaterial({ color: 0x777777 })
  );
  turret.position.y = defaultTank.bodyHeight / 2 + defaultTank.turretHeight / 2;
  const gun = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.1, 3),
    new THREE.MeshStandardMaterial({ color: 0x777777 })
  );
  gun.rotation.z = Math.PI / 2;
  gun.position.x = 1.5;
  turret.add(gun);
  tank.add(turret);

  // Chassis physics body mirrors tank mesh
  const box = new CANNON.Box(new CANNON.Vec3(defaultTank.bodyWidth / 2, defaultTank.bodyHeight / 2, defaultTank.bodyLength / 2));
  chassisBody = new CANNON.Body({ mass: defaultTank.mass });
  chassisBody.addShape(box);
  chassisBody.position.set(0, defaultTank.bodyHeight / 2, 0);
  chassisBody.angularFactor.set(0, 1, 0);
  chassisBody.angularDamping = 0.4;
  chassisBody.linearDamping = 0.3; // simulate ground friction/drag
  TURN_TORQUE = chassisBody.mass * ROT_SPEED;
  world.addBody(chassisBody);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  renderer = new THREE.WebGLRenderer();
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  // Build HUD overlay to display runtime metrics
  initHUD();

  // Only engage pointer lock once the lobby is hidden so menu interactions
  // don't immediately start controlling the tank.
  document.body.addEventListener('click', () => {
    if (lobby.style.display === 'none' && !document.pointerLockElement) {
      document.body.requestPointerLock();
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
      if (ammoList[idx]) {
        selectedAmmo = ammoList[idx];
        console.log('Selected ammo', selectedAmmo.name);
      }
    }
  });
  window.addEventListener('keyup', (e) => {
    keys[e.key.toLowerCase()] = false;
  });

  window.addEventListener('wheel', (e) => {
    cameraDistance = Math.min(Math.max(cameraDistance + e.deltaY * 0.01, 5), 20);
  });

  // Require pointer lock before firing so lobby clicks can't trigger shots.
  window.addEventListener('mousedown', () => {
    if (document.pointerLockElement && socket && selectedAmmo) {
      socket.emit('fire', selectedAmmo.name);
    }
  });

  animate();
}

function applyTankConfig(t) {
  MAX_SPEED = (t.maxSpeed ?? defaultTank.maxSpeed) / 3.6;
  MAX_REVERSE_SPEED = (t.maxReverseSpeed ?? defaultTank.maxReverseSpeed) / 3.6;
  ROT_SPEED = (2 * Math.PI) / (t.bodyRotation ?? defaultTank.bodyRotation);
  MAX_TURRET_INCLINE = THREE.MathUtils.degToRad(t.maxTurretIncline ?? defaultTank.maxTurretIncline);
  MAX_TURRET_DECLINE = THREE.MathUtils.degToRad(t.maxTurretDecline ?? defaultTank.maxTurretDecline);
  const traverseDeg = t.horizontalTraverse ?? defaultTank.horizontalTraverse;
  MAX_TURRET_TRAVERSE = traverseDeg === 0 ? Infinity : THREE.MathUtils.degToRad(traverseDeg);
  ACCELERATION = MAX_SPEED / 3;

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
  turret.position.y =
    (t.bodyHeight ?? defaultTank.bodyHeight) / 2 +
    (t.turretHeight ?? defaultTank.turretHeight) / 2;

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
  chassisBody.position.set(0, (t.bodyHeight ?? defaultTank.bodyHeight) / 2, 0);
  chassisBody.angularFactor.set(0, 1, 0);
  chassisBody.angularDamping = 0.4;
  chassisBody.linearDamping = 0.3;
  TURN_TORQUE = chassisBody.mass * ROT_SPEED;
  world.addBody(chassisBody);
  currentSpeed = 0;
}

function onMouseMove(e) {
  const sensitivity = 0.002;
  const newYaw = turret.rotation.y - e.movementX * sensitivity;
  turret.rotation.y = THREE.MathUtils.clamp(newYaw, -MAX_TURRET_TRAVERSE, MAX_TURRET_TRAVERSE);
  turret.rotation.x = THREE.MathUtils.clamp(
    turret.rotation.x - e.movementY * sensitivity,
    -MAX_TURRET_DECLINE,
    MAX_TURRET_INCLINE
  );
}
/**
 * updateMovement translates key inputs into physics state. It constrains the
 * chassis to horizontal movement while allowing yaw rotation.
 * @param {number} delta - seconds since last frame.
 */
function updateMovement(delta) {
  // Translate key input into continuous forces rather than direct velocity changes
  let throttle = 0;
  if (keys['w']) throttle = 1;
  else if (keys['s']) throttle = -1;
  if (throttle !== 0) {
    const withinLimits =
      (throttle > 0 && currentSpeed < MAX_SPEED) ||
      (throttle < 0 && currentSpeed > -MAX_REVERSE_SPEED);
    if (withinLimits) {
      const force = throttle * ACCELERATION * chassisBody.mass;
      // Negative Z is forward in local space; applying at center of mass
      chassisBody.applyLocalForce(new CANNON.Vec3(0, 0, -force), new CANNON.Vec3(0, 0, 0));
    }
  }

  // Apply torque for rotation around the Y axis
  let turn = 0;
  if (keys['a']) turn = 1;
  else if (keys['d']) turn = -1;
  if (turn !== 0) {
    chassisBody.applyLocalTorque(new CANNON.Vec3(0, turn * TURN_TORQUE, 0));
  }

  // Simple hand brake: increase damping while space is held
  chassisBody.linearDamping = keys[' '] ? 0.8 : 0.3;
}

function animate() {
  requestAnimationFrame(animate);

  // Frame timing used for physics and acceleration integration
  const delta = clock.getDelta();
  updateMovement(delta);

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
    proj.mesh.position.x += proj.vx * delta;
    proj.mesh.position.y += proj.vy * delta;
    proj.mesh.position.z += proj.vz * delta;
  }

  // Update HUD with current speed, inclination and health
  const speedKmh = currentSpeed * 3.6;
  const inclination = THREE.MathUtils.radToDeg(tank.rotation.x);
  updateHUD(speedKmh, inclination, playerHealth);

  updateCamera();
  renderer.render(scene, camera);

  // Throttle network updates to minimize bandwidth
  if (socket) {
    const now = performance.now();
    if (now - lastNetwork > 100) {
      const state = {
        x: chassisBody.position.x,
        y: chassisBody.position.y,
        z: chassisBody.position.z,
        rot: tank.rotation.y,
        turret: turret.rotation.y
      };
      const diff =
        Math.abs(state.x - lastState.x) +
        Math.abs(state.y - lastState.y) +
        Math.abs(state.z - lastState.z) +
        Math.abs(state.rot - lastState.rot) +
        Math.abs(state.turret - lastState.turret);
      if (diff > 0.01) {
        socket.emit('update', state);
        lastState = state;
      }
      lastNetwork = now;
    }
  }
}

function updateCamera() {
  if (cameraMode === 'third') {
    const offset = new THREE.Vector3(0, 3, cameraDistance);
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), tank.rotation.y);
    camera.position.copy(tank.position).add(offset);
    camera.lookAt(tank.position);
  } else {
    const offset = new THREE.Vector3(0, 1, 0);
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), tank.rotation.y + turret.rotation.y);
    camera.position.copy(tank.position).add(offset);
    const look = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(tank.quaternion)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), turret.rotation.y);
    camera.lookAt(camera.position.clone().add(look));
  }
}

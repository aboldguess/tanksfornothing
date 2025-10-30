// main.ts
// @ts-nocheck
// Summary: Browser client for Tanks for Nothing. Provides lobby flag, tabbed tank-class
//          and ammo selection, renders a dimensioned 3D tank based on server-supplied parameters,
//          handles user input, camera control and firing mechanics. Camera defaults
//          (height/distance) can be adjusted via the admin settings page. Uses Cannon.js for
//          simple collision physics, force-based tank movement and synchronizes state
//          with a server via Colyseus WebSocket rooms, now resolving the multiplayer
//          endpoint via environment-aware helpers so development and production hosts
//          both connect successfully. Camera immediately reflects mouse movement while
//          turret and gun lag behind to emulate realistic traverse. Projectiles now drop
//          under gravity. Remote players are represented with simple meshes that now
//          include a visible cannon barrel and update as network events arrive so
//          everyone shares the same battlefield. HUD displays current ammo selections,
//          auto-distributes lobby loadouts with live capacity feedback, and local firing
//          now layers in muzzle flashes plus audio for instant feedback.
// Structure: lobby data fetch -> scene setup -> physics setup -> input handling ->
//             firing helpers -> movement update -> animation loop -> optional networking.
// Usage: Registered as the Vite entry module (see ../public/index.html). Relies on bundled
//         dependencies (Three.js, Cannon-es, Colyseus.js client) and automatically wires up the
//         navigation HUD and debugging overlays when loaded in the browser.
// ---------------------------------------------------------------------------
// Security & Debugging: All critical operations log descriptive errors and surface fatal
// issues directly within the page so testers immediately see failures without opening the
// console. Imports reference npm packages that Vite pins and audits, removing the old ad-hoc
// CDN includes.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Client as ColyseusClient } from 'colyseus.js';
import {
  GAME_COMMAND,
  GAME_EVENT,
  applyProjectileRuntimeBuffer,
  createGameWorld,
  createEntity,
  destroyEntity,
  TransformComponent,
  ProjectileComponent
} from '@tanksfornothing/shared';
import type { EnsureEntityForId } from '@tanksfornothing/shared';

import { RemoteWorldRenderer } from './remote-world';

import './nav';
import { initHUD, updateHUD, updateAmmoHUD, showCrosshair, updateCooldownHUD } from './hud';
import { buildGroundTexture } from './ground-textures';

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

// Scratch buffers shared by muzzle flash helpers so we avoid allocating vectors
// every time the player fires. The direction vector is normalised before use so
// callers may pass any non-zero magnitude without worrying about side effects.
const muzzleFlashScratch = {
  offset: new THREE.Vector3(),
  direction: new THREE.Vector3()
};

// Lightweight muzzle flash: a short-lived additive sprite and point light at
// the muzzle end gives instant visual feedback even before the server confirms
// the projectile spawn.
function renderMuzzleFlash(position, direction) {
  if (!scene) return;
  const flashMaterial = new THREE.SpriteMaterial({
    color: 0xfff2a6,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false
  });
  const flash = new THREE.Sprite(flashMaterial);
  flash.scale.set(0.9, 0.9, 0.9);
  muzzleFlashScratch.direction.copy(direction).normalize();
  muzzleFlashScratch.offset
    .copy(muzzleFlashScratch.direction)
    .multiplyScalar(0.8);
  flash.position.copy(position).add(muzzleFlashScratch.offset);
  scene.add(flash);

  const light = new THREE.PointLight(0xffbb66, 2.2, 10, 2);
  light.position.copy(flash.position);
  scene.add(light);

  setTimeout(() => {
    scene.remove(flash);
    scene.remove(light);
    flashMaterial.dispose();
  }, 80);
}

let audioContext = null;

// Ensure a Web Audio context exists and is resumed. Browsers suspend contexts
// until the user interacts with the page, so this helper gracefully handles
// the common failure cases and logs rather than throwing.
function ensureAudioContext() {
  try {
    if (!audioContext) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      audioContext = Ctor ? new Ctor() : null;
    }
    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume().catch((err) => console.warn('Audio resume failed', err));
    }
  } catch (error) {
    console.warn('AudioContext initialisation failed', error);
    audioContext = null;
  }
  return audioContext;
}

// Fire a short, percussive cannon blast combining filtered noise with a low
// sawtooth oscillator. The envelope keeps the sound tight and avoids clipping.
function playCannonSound() {
  const ctx = ensureAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  try {
    const noiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.25), ctx.sampleRate);
    const channel = noiseBuffer.getChannelData(0);
    for (let i = 0; i < channel.length; i += 1) {
      const fade = 1 - i / channel.length;
      channel[i] = (Math.random() * 2 - 1) * fade * fade;
    }
    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.35, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    noiseSource.connect(noiseGain).connect(ctx.destination);
    noiseSource.start(now);
    noiseSource.stop(now + 0.25);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(65, now);
    osc.frequency.exponentialRampToValueAtTime(30, now + 0.25);
    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.25, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc.connect(oscGain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.35);
  } catch (error) {
    console.warn('Cannon sound playback failed', error);
  }
}

// Resolve Colyseus endpoint with awareness of build-time env vars so the development
// client (served from Vite) can still reach the Node server that typically listens on
// port 3000 while production continues to use same-origin requests.
function resolveColyseusEndpoint() {
  // Allow a fully qualified origin override first so deployments behind proxies can
  // pin the exact WebSocket URL without worrying about host/port assembly here.
  const explicitOrigin = (import.meta.env.VITE_SERVER_ORIGIN ?? '').trim().replace(/\/$/, '');
  const explicitPath = (import.meta.env.VITE_SERVER_PATH ?? '/colyseus').trim() || '/colyseus';
  const normalizedPath = explicitPath.startsWith('/') ? explicitPath : `/${explicitPath}`;
  if (explicitOrigin) {
    return `${explicitOrigin}${normalizedPath}`;
  }

  const fallbackProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const explicitProtocol = (import.meta.env.VITE_SERVER_PROTOCOL ?? '').trim().replace(/:$/, '');
  const protocol = explicitProtocol || fallbackProtocol;

  const explicitHost = (import.meta.env.VITE_SERVER_HOST ?? '').trim();
  const host = explicitHost || window.location.hostname;

  // If a host override already includes a port (e.g. example.com:4000) we respect it
  // otherwise prefer the explicit port env var or fall back to window.location.port.
  const explicitPort = (import.meta.env.VITE_SERVER_PORT ?? '').trim().replace(/^:/, '');
  const portFromHost = host.includes(':') ? '' : explicitPort || window.location.port;
  const portSegment = portFromHost ? `:${portFromHost}` : '';

  return `${protocol}://${host}${portSegment}${normalizedPath}`;
}

// Establish a resilient Colyseus client so the multiplayer channel functions in both
// dev (Vite) and production builds, logging the chosen endpoint for easier debugging.
let networkClient = null;
let room = null;
const colyseusEndpoint = resolveColyseusEndpoint();
try {
  console.info('Initialising Colyseus client', { endpoint: colyseusEndpoint });
  networkClient = new ColyseusClient(colyseusEndpoint);
} catch (error) {
  console.warn('Colyseus client failed to initialise; continuing offline mode.', error);
}
// Client-side ammo handling
let playerAmmo = [];
let selectedAmmo = null;
const projectiles = new Map(); // id -> { mesh }
// Client-side tracer spheres rendered immediately upon firing so clicks always
// yield visual feedback, even when the server is slow or unreachable.
const localProjectiles = [];
// Scratch buffers reused when spawning tracers to avoid per-shot allocations.
const muzzleScratch = {
  position: new THREE.Vector3(),
  direction: new THREE.Vector3(0, 0, -1),
  quaternion: new THREE.Quaternion(),
  velocity: new THREE.Vector3()
};
const LOCAL_PROJECTILE_LIFETIME = 2; // seconds before a tracer despawns
const LOCAL_PROJECTILE_SPEED = 120; // metres per second for the visual tracer
const LOCAL_PROJECTILE_GRAVITY = 9.81; // m/s^2 downward acceleration
let playerHealth = 100;
let remoteWorld = null;

let projectileWorld = createGameWorld();
const projectileServerToLocal = new Map();
const projectileIdToServer = new Map();
const ensureProjectileEntity = (serverEntityId) => {
  if (!projectileServerToLocal.has(serverEntityId)) {
    const local = createEntity(projectileWorld);
    projectileServerToLocal.set(serverEntityId, local);
  }
  return projectileServerToLocal.get(serverEntityId) ?? null;
};
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
// Normalised terrain height cache describing the rendered/physics ground so we can
// clamp player spawns onto the surface even when the admin-provided heightmaps
// sit entirely above or below world origin.
let terrainHeightData = null;
// Scratch vectors reused when aligning the tank chassis to sampled terrain normals.
// Declared early so helper functions invoked during initial terrain load can safely
// access the reused buffers without tripping Temporal Dead Zone rules for const.
const terrainScratch = {
  tangentX: new THREE.Vector3(),
  tangentZ: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  up: new THREE.Vector3(),
  forward: new THREE.Vector3(),
  projectedForward: new THREE.Vector3(),
  temp: new THREE.Vector3(),
  tiltedForward: new THREE.Vector3(),
  targetQuat: new THREE.Quaternion(),
  bodyQuat: new THREE.Quaternion(),
  tiltQuat: new THREE.Quaternion(),
  yawQuat: new THREE.Quaternion()
};

// Scratch vectors for translating local yaw torque (track differential) into world space
// before applying it to the Cannon body. Re-using the buffers prevents per-frame
// allocations and keeps the movement hot path lean.
const movementScratch = {
  localTorque: new CANNON.Vec3(),
  worldTorque: new CANNON.Vec3(),
  localAngularVelocity: new CANNON.Vec3(),
  worldToLocalQuat: new CANNON.Quaternion(),
  worldAngularVelocity: new CANNON.Vec3()
};

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

if (!networkClient) {
  showError(`Unable to connect to server at ${colyseusEndpoint}. Running offline.`);
}

function clearRemotePlayers() {
  remoteWorld?.clear();
}

function resetProjectileWorld() {
  for (const id of Array.from(projectiles.keys())) {
    removeProjectileVisual(id);
  }
  projectileServerToLocal.clear();
  projectileIdToServer.clear();
  projectileWorld = createGameWorld();
  clearLocalProjectiles();
}

function syncProjectileWorld(buffer) {
  if (!buffer) return;
  const seen = applyProjectileRuntimeBuffer(projectileWorld, buffer, ensureProjectileEntity);
  const activeIds = new Set(buffer.id ? Array.from(buffer.id) : []);
  for (let i = 0; i < (buffer.id?.length ?? 0); i += 1) {
    const id = buffer.id[i];
    const serverEntity = buffer.entityId[i];
    const localEntity = projectileServerToLocal.get(serverEntity);
    if (typeof localEntity !== 'number') continue;
    projectileIdToServer.set(id, serverEntity);
    const position = {
      x: TransformComponent.x[localEntity] || 0,
      y: TransformComponent.y[localEntity] || 0,
      z: TransformComponent.z[localEntity] || 0
    };
    let record = projectiles.get(id);
    if (!record) {
      record = createProjectileVisual(id, position);
    } else {
      record.mesh.position.set(position.x, position.y, position.z);
    }
  }

  for (const [id] of [...projectiles]) {
    if (!activeIds.has(id)) {
      removeProjectileVisual(id);
      const serverEntity = projectileIdToServer.get(id);
      if (typeof serverEntity === 'number') {
        const localEntity = projectileServerToLocal.get(serverEntity);
        if (typeof localEntity === 'number') {
          destroyEntity(projectileWorld, localEntity);
        }
        projectileServerToLocal.delete(serverEntity);
        projectileIdToServer.delete(id);
      }
    }
  }

  for (const [serverEntity, localEntity] of [...projectileServerToLocal]) {
    if (!seen.has(serverEntity)) {
      destroyEntity(projectileWorld, localEntity);
      projectileServerToLocal.delete(serverEntity);
    }
  }
}

function resetGameState() {
  if (!tank || !turret) return;
  tank.position.set(0, 0, 0);
  tank.rotation.set(0, 0, 0);
  turret.rotation.set(0, 0, 0);
  if (gun) gun.rotation.set(0, 0, 0);
  cameraYaw = 0;
  cameraPitch = 0;
  targetYaw = 0;
  targetPitch = 0;
  if (chassisBody) {
    chassisBody.position.set(0, 1, 0);
    chassisBody.velocity.set(0, 0, 0);
    chassisBody.angularVelocity.set(0, 0, 0);
    chassisBody.quaternion.set(0, 0, 0, 1);
    repositionTankOnTerrain();
  }
  currentSpeed = 0;
  playerHealth = 100;
  clearRemotePlayers();
  resetProjectileWorld();
  playerAmmo.forEach((a) => {
    a.count = loadout[a.name] || 0;
  });
  ammoLeft = playerAmmo.reduce((sum, a) => sum + a.count, 0);
  updateAmmoHUD(playerAmmo, selectedAmmo ? selectedAmmo.name : '');
  lastFireTime = 0;
  updateCooldownHUD(0, FIRE_DELAY > 0 ? FIRE_DELAY : 1);
}

function createProjectileVisual(id, position) {
  if (!scene) return null;
  const geom = new THREE.SphereGeometry(0.3, 12, 12);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(position.x, position.y, position.z);
  scene.add(mesh);
  const record = { mesh };
  projectiles.set(id, record);
  return record;
}

function removeProjectileVisual(id) {
  const record = projectiles.get(id);
  if (!record) return;
  scene?.remove(record.mesh);
  record.mesh.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) obj.material.dispose();
  });
  projectiles.delete(id);
}

// Spawn a short-lived tracer so the player receives instant visual feedback
// when firing. The server remains authoritative for real projectiles, but these
// local meshes bridge latency and also work when running offline.
function spawnLocalProjectileTrace() {
  if (!scene || !barrelMesh) return;
  barrelMesh.updateWorldMatrix(true, true);
  barrelMesh.getWorldPosition(muzzleScratch.position);
  barrelMesh.getWorldQuaternion(muzzleScratch.quaternion);
  muzzleScratch.direction.set(0, 0, -1).applyQuaternion(muzzleScratch.quaternion).normalize();
  renderMuzzleFlash(muzzleScratch.position, muzzleScratch.direction);

  const geom = new THREE.SphereGeometry(0.15, 10, 10);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffc25a });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.copy(muzzleScratch.position);
  scene.add(mesh);

  muzzleScratch.velocity
    .copy(muzzleScratch.direction)
    .multiplyScalar(LOCAL_PROJECTILE_SPEED);

  localProjectiles.push({
    mesh,
    velocity: muzzleScratch.velocity.clone(),
    lifetime: LOCAL_PROJECTILE_LIFETIME
  });
}

function updateLocalProjectiles(delta) {
  for (let i = localProjectiles.length - 1; i >= 0; i -= 1) {
    const entry = localProjectiles[i];
    entry.velocity.y -= LOCAL_PROJECTILE_GRAVITY * delta;
    entry.mesh.position.addScaledVector(entry.velocity, delta);
    entry.lifetime -= delta;
    if (entry.lifetime <= 0 || entry.mesh.position.y < 0) {
      scene.remove(entry.mesh);
      entry.mesh.geometry?.dispose?.();
      if (Array.isArray(entry.mesh.material)) {
        entry.mesh.material.forEach((mat) => mat.dispose?.());
      } else {
        entry.mesh.material?.dispose?.();
      }
      localProjectiles.splice(i, 1);
    }
  }
}

function clearLocalProjectiles() {
  for (let i = localProjectiles.length - 1; i >= 0; i -= 1) {
    const entry = localProjectiles[i];
    scene?.remove(entry.mesh);
    entry.mesh.geometry?.dispose?.();
    if (Array.isArray(entry.mesh.material)) {
      entry.mesh.material.forEach((mat) => mat.dispose?.());
    } else {
      entry.mesh.material?.dispose?.();
    }
    localProjectiles.pop();
  }
}

function extractAmmoLoadoutFromMetadata(metadata) {
  const list = [];
  if (!metadata?.ammoLoadout) return list;
  if (selectedTank && Array.isArray(selectedTank.ammo)) {
    selectedTank.ammo.forEach((name) => {
      const value = metadata.ammoLoadout.get(name) ?? 0;
      if (value > 0) list.push({ name, count: value });
    });
  } else {
    metadata.ammoLoadout.forEach((value, name) => {
      if (value > 0) list.push({ name, count: value });
    });
  }
  return list;
}

function syncLocalPlayerState(metadata, runtime) {
  const newAmmo = extractAmmoLoadoutFromMetadata(metadata);
  const newTotal = newAmmo.reduce((sum, entry) => sum + entry.count, 0);
  const ammoChanged =
    newTotal !== ammoLeft ||
    newAmmo.length !== playerAmmo.length ||
    newAmmo.some((entry, index) => playerAmmo[index]?.name !== entry.name || playerAmmo[index]?.count !== entry.count);
  if (ammoChanged) {
    const previousSelection = selectedAmmo ? selectedAmmo.name : null;
    playerAmmo = newAmmo;
    selectedAmmo =
      playerAmmo.find((entry) => entry.name === previousSelection) || playerAmmo[0] || null;
    ammoLeft = newTotal;
    updateAmmoHUD(playerAmmo, selectedAmmo ? selectedAmmo.name : '');
  }
  if (metadata && typeof metadata.ammoCapacity === 'number') {
    activeAmmoCapacity = metadata.ammoCapacity;
  }
  if (metadata && runtime) {
    const entityId = metadata.entityId;
    const index = runtime.entityId.findIndex((value) => value === entityId);
    if (index >= 0) {
      const healthValue = runtime.health[index];
      if (typeof healthValue === 'number') {
        playerHealth = healthValue;
      }
    }
  }
}

function attachRoomListeners(activeRoom) {
  activeRoom.onLeave(() => {
    showError('Disconnected from server. Running offline.');
    resetProjectileWorld();
    clearRemotePlayers();
    room = null;
  });

  let stateListenersBound = false;
  let waitingForSchemaState = false;

  const bindSchemaCollections = (stateCandidate) => {
    const schemaState =
      stateCandidate && typeof stateCandidate.listen === 'function'
        ? stateCandidate
        : typeof activeRoom.state?.listen === 'function'
          ? activeRoom.state
          : null;

    if (!schemaState) {
      if (!waitingForSchemaState) {
        console.debug('Waiting for Colyseus schema state with listen() support before binding listeners');
        waitingForSchemaState = true;
      }
      return;
    }

    if (stateListenersBound) return;
    if (!schemaState.playerMetadata || !schemaState.playerRuntime || !schemaState.projectileRuntime) {
      if (!waitingForSchemaState) {
        console.debug('Waiting for Colyseus state to initialise before binding listeners');
        waitingForSchemaState = true;
      }
      return;
    }

    if (!scene) {
      console.warn('Scene not initialised; deferring ECS bindings');
      return;
    }

    waitingForSchemaState = false;
    remoteWorld?.clear();
    remoteWorld = new RemoteWorldRenderer(scene, createRemoteTank, () => activeRoom.sessionId);

    const handleMetadataUpdate = (metadata, sessionId) => {
      if (!metadata) return;
      if (sessionId === activeRoom.sessionId) {
        syncLocalPlayerState(metadata, schemaState.playerRuntime);
        return;
      }
      remoteWorld?.addOrUpdateMetadata(sessionId, metadata);
    };

    schemaState.playerMetadata.onAdd = handleMetadataUpdate;
    schemaState.playerMetadata.onChange = handleMetadataUpdate;
    schemaState.playerMetadata.onRemove = (_metadata, sessionId) => {
      if (sessionId === activeRoom.sessionId) return;
      remoteWorld?.removeMetadata(sessionId);
    };

    schemaState.listen(
      'tick',
      () => {
        if (remoteWorld) {
          remoteWorld.applyRuntime(schemaState.playerRuntime);
        }
        const localMetadata = schemaState.playerMetadata.get(activeRoom.sessionId);
        syncLocalPlayerState(localMetadata, schemaState.playerRuntime);
        syncProjectileWorld(schemaState.projectileRuntime);
      },
      true
    );

    stateListenersBound = true;
    console.debug('Colyseus schema listeners bound for active room', { sessionId: activeRoom.sessionId });

    schemaState.playerMetadata.forEach((metadata, sessionId) => {
      handleMetadataUpdate(metadata, sessionId);
    });
    syncProjectileWorld(schemaState.projectileRuntime);
  };

  if (activeRoom.state) {
    bindSchemaCollections(activeRoom.state);
  }

  if (typeof activeRoom.onStateChange === 'function') {
    activeRoom.onStateChange((state) => {
      if (!stateListenersBound) {
        bindSchemaCollections(state);
      }
    });
  } else {
    console.warn('Colyseus room missing onStateChange handler; multiplayer state may not sync correctly');
  }

  activeRoom.onMessage(GAME_EVENT.TerrainDefinition, (payload) => applyTerrainPayload(payload));
  activeRoom.onMessage(GAME_EVENT.ProjectileExploded, (p) => {
    removeProjectileVisual(p.id);
    const serverEntity = projectileIdToServer.get(p.id);
    if (typeof serverEntity === 'number') {
      const localEntity = projectileServerToLocal.get(serverEntity);
      if (typeof localEntity === 'number') {
        destroyEntity(projectileWorld, localEntity);
      }
      projectileServerToLocal.delete(serverEntity);
      projectileIdToServer.delete(p.id);
    }
    renderExplosion(new THREE.Vector3(p.x, p.y, p.z));
  });
  activeRoom.onMessage(GAME_EVENT.TankDamaged, ({ id, health }) => {
    if (id === activeRoom.sessionId) playerHealth = health;
  });
  activeRoom.onMessage(GAME_EVENT.Restart, () => resetGameState());
  activeRoom.onMessage(GAME_EVENT.TanksCatalog, (serverTanks) => {
    if (Array.isArray(serverTanks) && serverTanks.length) {
      availableTanks = serverTanks;
      if (selectedNation) renderTanks();
    }
  });
  activeRoom.onMessage(GAME_EVENT.AmmoCatalog, (serverAmmo) => {
    if (Array.isArray(serverAmmo) && serverAmmo.length) {
      ammoDefs = serverAmmo;
      if (selectedTank) renderAmmo();
    }
  });
}

async function joinRoomWithSelection(tankConfig, ammoLoadout) {
  if (!networkClient) {
    throw new Error('Multiplayer unavailable');
  }
  if (room) {
    try {
      await room.leave();
    } catch (err) {
      console.warn('Previous room leave failed', err);
    }
    room = null;
  }
  const options = {
    tank: { name: tankConfig.name, nation: tankConfig.nation },
    loadout: ammoLoadout
  };
  const newRoom = await networkClient.joinOrCreate('tanksfornothing', options);
  room = newRoom;
  console.log('Connected to server');
  attachRoomListeners(newRoom);
  newRoom.send(GAME_COMMAND.PlayerUpdate, {
    x: chassisBody?.position.x ?? 0,
    y: chassisBody?.position.y ?? 0,
    z: chassisBody?.position.z ?? 0,
    rot: turret?.rotation.y ?? 0,
    turret: turret?.rotation.y ?? 0,
    gun: gun?.rotation.x ?? 0,
    health: playerHealth
  });
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
let loadoutSummaryEl = null;
if (joinBtn) {
  joinBtn.disabled = true;
  joinBtn.title = 'Select a tank and allocate ammo before joining.';
}
let availableTanks = [];
let ammoDefs = [];
let selectedNation = null;
let selectedTank = null;
let selectedClass = null; // current tank class tab
const loadout = {};
let activeAmmoCapacity = 0;
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
  loadoutSummaryEl = null;
  updateLoadoutSummary();
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

function sanitiseLoadout() {
  return Object.fromEntries(
    Object.entries(loadout).map(([name, value]) => [name, Math.max(0, Math.floor(Number(value) || 0))])
  );
}

function totalAllocatedRounds() {
  return Object.values(loadout).reduce(
    (sum, value) => sum + Math.max(0, Math.floor(Number(value) || 0)),
    0
  );
}

function updateLoadoutSummary() {
  const capacity = Math.max(0, activeAmmoCapacity);
  const total = totalAllocatedRounds();
  const overCapacity = capacity > 0 && total > capacity;
  const noAmmo = total <= 0;
  if (loadoutSummaryEl) {
    const capacityText = capacity > 0 ? `${total}/${capacity}` : `${total}`;
    loadoutSummaryEl.textContent = `Allocated ${capacityText} rounds`;
    loadoutSummaryEl.classList.toggle('warning', overCapacity || noAmmo);
  }
  if (joinBtn) {
    const needsTank = !selectedTank;
    const invalid = overCapacity || noAmmo || needsTank;
    joinBtn.disabled = invalid;
    if (needsTank) {
      joinBtn.title = 'Select a tank and allocate ammo before joining.';
    } else if (overCapacity) {
      joinBtn.title = `Reduce your loadout to ${capacity} rounds or fewer.`;
    } else if (noAmmo) {
      joinBtn.title = 'Allocate at least one round before joining.';
    } else {
      joinBtn.title = 'Join the battle!';
    }
  }
}

function computeDefaultLoadout(ammoNames, capacity) {
  const defaults = {};
  const names = Array.isArray(ammoNames) ? ammoNames : [];
  let remaining = Math.max(0, capacity);
  const count = names.length;
  names.forEach((name, index) => {
    if (remaining <= 0) {
      defaults[name] = 0;
      return;
    }
    const slots = Math.min(
      remaining,
      Math.max(1, Math.floor(remaining / Math.max(1, count - index)))
    );
    defaults[name] = slots;
    remaining -= slots;
  });
  return defaults;
}

function renderAmmo() {
  ammoColumn.innerHTML = '';
  loadoutSummaryEl = null;
  Object.keys(loadout).forEach(k => delete loadout[k]);
  updateLoadoutSummary();
  if (!selectedTank) return;

  activeAmmoCapacity = Math.max(0, selectedTank.ammoCapacity ?? defaultTank.ammoCapacity);
  const ammoDefinitions = Array.isArray(selectedTank.ammo)
    ? selectedTank.ammo
        .map(name => ammoDefs.find(a => a.name === name))
        .filter(def => !!def)
    : [];

  if (!ammoDefinitions.length) {
    const empty = document.createElement('div');
    empty.className = 'ammo-empty';
    empty.textContent = 'No ammunition is configured for this tank. Visit the admin tools to assign shells.';
    ammoColumn.appendChild(empty);
    updateLoadoutSummary();
    return;
  }

  const header = document.createElement('div');
  header.className = 'ammo-header';
  header.textContent = `Distribute up to ${activeAmmoCapacity} rounds. Adjust sliders now; press 1-9 in battle to switch shells.`;
  ammoColumn.appendChild(header);

  loadoutSummaryEl = document.createElement('div');
  loadoutSummaryEl.className = 'ammo-summary';
  ammoColumn.appendChild(loadoutSummaryEl);

  const defaults = computeDefaultLoadout(
    ammoDefinitions.map(def => def.name),
    activeAmmoCapacity
  );

  ammoDefinitions.forEach(def => {
    const row = document.createElement('div');
    row.className = 'ammo-item';

    const img = document.createElement('img');
    img.src = def.image || 'https://placehold.co/40x40?text=A';
    img.alt = def.name;

    const details = document.createElement('div');
    details.className = 'ammo-details';

    const label = document.createElement('span');
    label.className = 'ammo-label';
    label.textContent = def.name;

    const countLabel = document.createElement('span');
    countLabel.className = 'ammo-count';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = String(activeAmmoCapacity);
    const defaultCount = defaults[def.name] ?? 0;
    slider.value = String(defaultCount);
    loadout[def.name] = defaultCount;
    countLabel.textContent = `${defaultCount} rounds`;

    slider.addEventListener('input', () => {
      const desired = Math.max(0, Math.floor(Number(slider.value) || 0));
      const current = loadout[def.name] ?? 0;
      const othersTotal = totalAllocatedRounds() - current;
      const allowed = Math.min(desired, Math.max(0, activeAmmoCapacity - othersTotal));
      if (allowed !== desired) {
        slider.value = String(allowed);
      }
      loadout[def.name] = allowed;
      countLabel.textContent = `${allowed} rounds`;
      updateLoadoutSummary();
    });

    details.appendChild(label);
    details.appendChild(countLabel);
    row.appendChild(img);
    row.appendChild(details);
    row.appendChild(slider);
    ammoColumn.appendChild(row);
  });

  updateLoadoutSummary();
}

joinBtn.addEventListener('click', async () => {
  lobbyError.textContent = '';
  if (!selectedTank) {
    lobbyError.textContent = 'Select a tank';
    return;
  }
  const capacity = Math.max(0, activeAmmoCapacity);
  const totalRounds = totalAllocatedRounds();
  if (totalRounds <= 0) {
    lobbyError.textContent = 'Allocate ammunition using the sliders before deploying.';
    updateLoadoutSummary();
    return;
  }
  if (capacity > 0 && totalRounds > capacity) {
    lobbyError.textContent = `Too many rounds selected. Limit to ${capacity} in total.`;
    updateLoadoutSummary();
    return;
  }
  lobby.style.display = 'none';
  instructions.style.display = 'block';
  showCrosshair(true);
  applyTankConfig(selectedTank);

  // Build player-specific ammo list from lobby selections
  const sanitizedLoadout = sanitiseLoadout();
  const positiveEntries = Object.entries(sanitizedLoadout).filter(([, count]) => count > 0);
  const payload = Object.fromEntries(positiveEntries);
  playerAmmo = positiveEntries.map(([name, count]) => ({ name, count }));
  selectedAmmo = playerAmmo[0] || null;
  ammoLeft = playerAmmo.reduce((sum, a) => sum + a.count, 0);
  updateAmmoHUD(playerAmmo, selectedAmmo ? selectedAmmo.name : '');

  if (!networkClient) {
    showError('Multiplayer unavailable; running offline.');
    return;
  }
  try {
    await joinRoomWithSelection(selectedTank, payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lobbyError.textContent = message || 'Failed to join room';
    lobby.style.display = 'block';
    instructions.style.display = 'none';
    showCrosshair(false);
    updateAmmoHUD([]);
  }
});

loadLobbyData();

// Core scene objects
let tank, turret, gun, camera, scene, renderer, ground, barrelMesh;
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
activeAmmoCapacity = defaultTank.ammoCapacity;
let lastFireTime = 0;
// Static friction coefficient representing tracks on typical terrain. Raised to
// better reflect the grip of heavy tracked vehicles so the hull settles more
// quickly after movement.
const GROUND_FRICTION = 0.65;
// Viscosity-driven damping ranges keep motion believable across mud/sand/water.
const MIN_ROLLING_DAMPING = 0.15;
const MAX_ROLLING_DAMPING = 0.65;
const BRAKE_DAMPING = 0.85;
// Threshold at which we snap yaw angular velocity to zero so the hull actually
// stops turning instead of creeping forever, plus proportional brake stiffness
// used while A/D are released.
const TURN_STOP_THRESHOLD = THREE.MathUtils.degToRad(0.25);
const TURN_BRAKE_STIFFNESS = 4.5;
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
// Track the active hull height so we can place the chassis just above the terrain surface.
let currentTankBodyHeight = defaultTank.bodyHeight;

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
  terrainHeightData = null;
}

// Persist the current terrain's sampled heights for rapid lookup when positioning
// the player's physics body on the surface. Data is stored in world metres.
function updateTerrainHeightData(widthMeters, heightMeters, heights) {
  if (!Array.isArray(heights) || !heights.length || !Array.isArray(heights[0])) {
    terrainHeightData = null;
    return;
  }
  terrainHeightData = {
    width: widthMeters,
    height: heightMeters,
    rows: heights.length,
    cols: heights[0].length,
    heights
  };
}

// Sample the normalised elevation grid using bilinear interpolation so the
// chassis can hug the terrain even between vertex points.
function sampleTerrainHeightAt(x, z) {
  if (!terrainHeightData) return 0;
  const { width, height, rows, cols, heights } = terrainHeightData;
  if (!rows || !cols) return 0;
  const normX = THREE.MathUtils.clamp((x + width / 2) / width, 0, 0.999);
  const normZ = THREE.MathUtils.clamp((z + height / 2) / height, 0, 0.999);
  const gridX = normX * (cols - 1);
  const gridZ = normZ * (rows - 1);
  const x0 = Math.floor(gridX);
  const x1 = Math.min(cols - 1, x0 + 1);
  const z0 = Math.floor(gridZ);
  const z1 = Math.min(rows - 1, z0 + 1);
  const tx = gridX - x0;
  const tz = gridZ - z0;
  const h00 = heights[z0]?.[x0] ?? 0;
  const h10 = heights[z0]?.[x1] ?? h00;
  const h01 = heights[z1]?.[x0] ?? h00;
  const h11 = heights[z1]?.[x1] ?? h10;
  const h0 = THREE.MathUtils.lerp(h00, h10, tx);
  const h1 = THREE.MathUtils.lerp(h01, h11, tx);
  return THREE.MathUtils.lerp(h0, h1, tz);
}

// Compute an approximate terrain normal using central differences so we can tilt
// the chassis to match the slope even without reliable physics contacts.
function sampleTerrainNormalAt(x, z, target = new THREE.Vector3()) {
  if (!terrainHeightData) return target.set(0, 1, 0);
  const { width, height, rows, cols } = terrainHeightData;
  if (rows < 2 || cols < 2) return target.set(0, 1, 0);
  const stepX = width / Math.max(1, cols - 1);
  const stepZ = height / Math.max(1, rows - 1);
  const halfX = stepX / 2;
  const halfZ = stepZ / 2;
  const hL = sampleTerrainHeightAt(x - halfX, z);
  const hR = sampleTerrainHeightAt(x + halfX, z);
  const hF = sampleTerrainHeightAt(x, z - halfZ);
  const hB = sampleTerrainHeightAt(x, z + halfZ);
  if (
    !Number.isFinite(hL) ||
    !Number.isFinite(hR) ||
    !Number.isFinite(hF) ||
    !Number.isFinite(hB)
  ) {
    return target.set(0, 1, 0);
  }
  terrainScratch.tangentX.set(stepX, hR - hL, 0);
  terrainScratch.tangentZ.set(0, hB - hF, stepZ);
  target
    .copy(terrainScratch.tangentZ)
    .cross(terrainScratch.tangentX);
  if (target.lengthSq() < 1e-6) {
    return target.set(0, 1, 0);
  }
  return target.normalize();
}

// Align the chassis body with the sampled terrain height/normal so it cannot fall
// through sparse collision meshes. forceSnap ensures we hard set the Y position
// (used on spawn / terrain rebuild) while the default mode simply prevents the
// body from dipping below the surface during gameplay.
function alignChassisToTerrain(forceSnap = false) {
  if (!chassisBody) return;
  const surfaceY = sampleTerrainHeightAt(chassisBody.position.x, chassisBody.position.z);
  if (!Number.isFinite(surfaceY)) return;

  // Determine the terrain normal up-front so we can position the chassis along that
  // normal rather than world-up. This keeps the underside flush with the surface even
  // once we tilt the hull to match the slope, preventing the earlier issue where the
  // tank re-penetrated sloped terrain immediately after alignment.
  const normal = sampleTerrainNormalAt(
    chassisBody.position.x,
    chassisBody.position.z,
    terrainScratch.normal
  );
  if (normal.y <= 0) {
    // Degenerate cases (e.g. malformed height data) can produce a downward-facing
    // normal; fall back to world-up so we never flip the chassis underground.
    normal.set(0, 1, 0);
  }
  const normalY = normal.y;
  // Clamp to a tiny epsilon so we avoid division by zero if the sampled normal is
  // unexpectedly horizontal, while still biasing the chassis upward to stay on the slope.
  const safeNormalY = Math.max(normalY, 1e-3);
  const desiredY = surfaceY + (currentTankBodyHeight / 2) / safeNormalY;
  const belowSurface = chassisBody.position.y < desiredY - 0.01;
  if (forceSnap || belowSurface) {
    chassisBody.position.y = desiredY;
    chassisBody.previousPosition.y = desiredY;
    chassisBody.interpolatedPosition.y = desiredY;
    if (forceSnap || chassisBody.velocity.y < 0) {
      chassisBody.velocity.y = 0;
    }
    chassisBody.angularVelocity.x = 0;
    chassisBody.angularVelocity.z = 0;
    if (forceSnap) {
      lastState.y = desiredY;
    }
  }

  // Use the terrain normal to tilt the chassis so it hugs slopes naturally.
  terrainScratch.up.copy(normal).normalize();
  terrainScratch.bodyQuat.set(
    chassisBody.quaternion.x,
    chassisBody.quaternion.y,
    chassisBody.quaternion.z,
    chassisBody.quaternion.w
  );

  // Preserve the player's intended heading by projecting the current forward
  // vector onto the terrain plane, then rotating the chassis so its up axis
  // matches the sampled normal while its projected forward vector remains
  // aligned with that heading. This avoids the previous behaviour where the
  // hull snapped back to world-forward every frame, preventing A/D steering.
  terrainScratch.forward
    .set(0, 0, -1)
    .applyQuaternion(terrainScratch.bodyQuat);
  terrainScratch.projectedForward
    .copy(terrainScratch.forward)
    .projectOnPlane(terrainScratch.up);
  if (terrainScratch.projectedForward.lengthSq() < 1e-6) {
    // Degenerate cases: try projecting global forward, otherwise fall back to
    // a sane default so we never feed a zero vector into the quaternion math.
    terrainScratch.temp
      .set(0, 0, -1)
      .projectOnPlane(terrainScratch.up);
    if (terrainScratch.temp.lengthSq() > 1e-6) {
      terrainScratch.projectedForward.copy(terrainScratch.temp);
    } else {
      terrainScratch.projectedForward.set(0, 0, -1);
    }
  }
  terrainScratch.projectedForward.normalize();

  terrainScratch.tiltQuat.setFromUnitVectors(
    terrainScratch.temp.set(0, 1, 0),
    terrainScratch.up
  );
  terrainScratch.tiltedForward
    .set(0, 0, -1)
    .applyQuaternion(terrainScratch.tiltQuat)
    .normalize();
  terrainScratch.yawQuat.setFromUnitVectors(
    terrainScratch.tiltedForward,
    terrainScratch.projectedForward
  );
  terrainScratch.targetQuat
    .copy(terrainScratch.tiltQuat)
    .multiply(terrainScratch.yawQuat)
    .normalize();
  chassisBody.quaternion.set(
    terrainScratch.targetQuat.x,
    terrainScratch.targetQuat.y,
    terrainScratch.targetQuat.z,
    terrainScratch.targetQuat.w
  );
  chassisBody.angularVelocity.x = 0;
  chassisBody.angularVelocity.z = 0;
}

// Ensure the local player starts on top of the terrain instead of buried below
// heightmaps that never cross y=0. Invoked whenever the map changes or tank
// geometry is rebuilt so both visuals and physics stay aligned.
function repositionTankOnTerrain() {
  if (!chassisBody || !tank) return;
  alignChassisToTerrain(true);
  tank.position.copy(chassisBody.position);
  tank.quaternion.set(
    chassisBody.quaternion.x,
    chassisBody.quaternion.y,
    chassisBody.quaternion.z,
    chassisBody.quaternion.w
  );
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
  const isHeightfield = name === 'hill' || name === 'valley';
  const segments = isHeightfield ? 10 : 1;
  const geometry = new THREE.PlaneGeometry(200, 200, segments, segments);
  const material = new THREE.MeshStandardMaterial({ color: 0x507140 });
  ground = new THREE.Mesh(geometry, material);
  let heightGrid = null;
  if (isHeightfield) {
    const elementSize = 200 / segments;
    heightGrid = Array.from({ length: segments + 1 }, () => Array(segments + 1).fill(0));
    let minHeight = Infinity;
    let maxHeight = -Infinity;
    for (let row = 0; row <= segments; row++) {
      for (let col = 0; col <= segments; col++) {
        const x = (col - segments / 2) * elementSize;
        const z = (row - segments / 2) * elementSize;
        const dist = Math.sqrt(x * x + z * z);
        const magnitude = Math.max(0, 10 - dist / 5);
        const signed = name === 'valley' ? -magnitude : magnitude;
        heightGrid[row][col] = signed;
        minHeight = Math.min(minHeight, signed);
        maxHeight = Math.max(maxHeight, signed);
      }
    }
    const offset = Number.isFinite(minHeight) && Number.isFinite(maxHeight)
      ? (minHeight + maxHeight) / 2
      : 0;
    const pos = geometry.attributes.position;
    let index = 0;
    for (let row = 0; row <= segments; row++) {
      for (let col = 0; col <= segments; col++) {
        const normalised = heightGrid[row][col] - offset;
        heightGrid[row][col] = normalised;
        pos.setZ(index, normalised);
        index += 1;
      }
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
  } else {
    heightGrid = [
      [0, 0],
      [0, 0]
    ];
  }
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  if (world) {
    let shape;
    if (isHeightfield) {
      const elementSize = 200 / segments;
      shape = new CANNON.Heightfield(heightGrid, { elementSize });
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
  updateTerrainHeightData(200, 200, heightGrid);
  repositionTankOnTerrain();
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
  let minElevation = Infinity;
  let maxElevation = -Infinity;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const value = elevation[y][x];
      const numeric = Number.isFinite(value) ? value : 0;
      if (numeric < minElevation) minElevation = numeric;
      if (numeric > maxElevation) maxElevation = numeric;
    }
  }
  const offset = Number.isFinite(minElevation) && Number.isFinite(maxElevation)
    ? (minElevation + maxElevation) / 2
    : 0;
  const normalisedElevation = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const index = y * cols + x;
      const value = elevation[y][x];
      const numeric = Number.isFinite(value) ? value : 0;
      const normalised = numeric - offset;
      normalisedElevation[y][x] = normalised;
      positions.setZ(index, normalised);
    }
  }
  positions.needsUpdate = true;
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
  updateTerrainHeightData(widthMeters, heightMeters, normalisedElevation);
  repositionTankOnTerrain();
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
  barrelMesh = barrel;
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
  repositionTankOnTerrain();

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
      ensureAudioContext();
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
    if (!document.pointerLockElement || !selectedAmmo) return;

    const now = Date.now();
    const ready = now - lastFireTime >= FIRE_DELAY * 1000;
    if (!ready || ammoLeft <= 0 || selectedAmmo.count <= 0) return;

    lastFireTime = now;
    selectedAmmo.count -= 1;
    ammoLeft -= 1;
    updateAmmoHUD(playerAmmo, selectedAmmo.name);
    spawnLocalProjectileTrace();
    playCannonSound();
    console.debug('Firing', selectedAmmo.name, { ammoLeft });

    if (room) {
      room.send(GAME_COMMAND.PlayerFire, selectedAmmo.name);
    } else {
      console.debug('Offline shot: no room joined, rendering local tracer only');
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
  activeAmmoCapacity = t.ammoCapacity ?? defaultTank.ammoCapacity;
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
    const oldBarrel = gun.children[0];
    gun.remove(oldBarrel);
    oldBarrel.geometry?.dispose?.();
    if (Array.isArray(oldBarrel.material)) {
      oldBarrel.material.forEach((mat) => mat.dispose?.());
    } else {
      oldBarrel.material?.dispose?.();
    }
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
  barrelMesh = newBarrel;

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
  currentTankBodyHeight = t.bodyHeight ?? defaultTank.bodyHeight;
  chassisBody.position.set(0, currentTankBodyHeight / 2, 0);
  chassisBody.angularFactor.set(0, 1, 0);
  // Reduced damping keeps hull rotation responsive.
  chassisBody.angularDamping = 0.2;
  chassisBody.linearDamping = MIN_ROLLING_DAMPING;
  world.addBody(chassisBody);
  currentSpeed = 0;
  repositionTankOnTerrain();
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

// Ensure angle differences stay in the [-π, π] range so yaw easing always
// travels the shortest arc when re-aligning the turret with the camera.
function normaliseAngle(value) {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

// Apply a light, explicit yaw brake so the hull actually comes to rest after
// releasing A/D. Cannon's built-in angular damping slows rotation but never
// fully reaches zero, which left the tank drifting and made mouse movement feel
// inverted. The proportional torque below cancels the remaining angular
// velocity and snaps extremely small values to zero so the chassis sleeps.
function stabiliseHullYaw(tractionScale) {
  if (!chassisBody) return;
  movementScratch.worldToLocalQuat.copy(chassisBody.quaternion);
  movementScratch.worldToLocalQuat.conjugate();
  movementScratch.worldToLocalQuat.vmult(
    chassisBody.angularVelocity,
    movementScratch.localAngularVelocity
  );
  const yawRate = movementScratch.localAngularVelocity.y;
  if (Math.abs(yawRate) < TURN_STOP_THRESHOLD) {
    movementScratch.localAngularVelocity.y = 0;
    chassisBody.quaternion.vmult(
      movementScratch.localAngularVelocity,
      movementScratch.worldAngularVelocity
    );
    chassisBody.angularVelocity.copy(movementScratch.worldAngularVelocity);
    return;
  }

  const brakeTorque = -yawRate * chassisBody.inertia.y * TURN_BRAKE_STIFFNESS * tractionScale;
  movementScratch.localTorque.set(0, brakeTorque, 0);
  chassisBody.vectorToWorldFrame(movementScratch.localTorque, movementScratch.worldTorque);
  chassisBody.torque.vadd(movementScratch.worldTorque, chassisBody.torque);
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
    // Differential steering works in the tank's local space. Convert the desired yaw
    // torque into world coordinates so slopes (where the hull is tilted) still honour
    // player input. Blend in a proportional correction toward the desired turn rate so
    // tapping A/D immediately produces visible rotation even after angular damping.
    const desiredYawRate = turn * TARGET_TURN_RATE;
    // Convert the body's world-space angular velocity into the local frame so we
    // compare two values that reference the same yaw axis even while perched on
    // uneven terrain. This prevents the corrective torque from overreacting when
    // the hull is pitched or rolled.
    movementScratch.worldToLocalQuat.copy(chassisBody.quaternion);
    movementScratch.worldToLocalQuat.conjugate();
    movementScratch.worldToLocalQuat.vmult(
      chassisBody.angularVelocity,
      movementScratch.localAngularVelocity
    );
    const currentYawRate = movementScratch.localAngularVelocity.y;
    const yawError = desiredYawRate - currentYawRate;
    const correctiveTorque = yawError * chassisBody.inertia.y;
    const baseTorque = turn * TURN_TORQUE * tractionScale;
    movementScratch.localTorque.set(0, baseTorque + correctiveTorque, 0);
    chassisBody.vectorToWorldFrame(movementScratch.localTorque, movementScratch.worldTorque);
    chassisBody.torque.vadd(movementScratch.worldTorque, chassisBody.torque);
  } else {
    stabiliseHullYaw(tractionScale);
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

  // Keep the chassis glued to the sampled heightmap so it never clips through
  // the terrain when collision meshes fail to register contacts.
  alignChassisToTerrain(false);

  // Calculate speed along the forward vector and log for debugging
  const forward = new CANNON.Vec3(0, 0, -1);
  chassisBody.quaternion.vmult(forward, forward);
  currentSpeed = forward.dot(chassisBody.velocity);
  movementScratch.worldToLocalQuat.copy(chassisBody.quaternion);
  movementScratch.worldToLocalQuat.conjugate();
  movementScratch.worldToLocalQuat.vmult(
    chassisBody.angularVelocity,
    movementScratch.localAngularVelocity
  );
  logMovement(
    'spd',
    currentSpeed.toFixed(2),
    'ang',
    movementScratch.localAngularVelocity.y.toFixed(2)
  );

  // Sync Three.js mesh with physics body
  tank.position.copy(chassisBody.position);
  tank.quaternion.copy(chassisBody.quaternion);

  remoteWorld?.updateMeshes();
  updateLocalProjectiles(delta);

  // Smoothly rotate turret and gun toward target angles
  const yawDiff = normaliseAngle(targetYaw - turret.rotation.y);
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
  if (room) {
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
        room.send(GAME_COMMAND.PlayerUpdate, state);
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

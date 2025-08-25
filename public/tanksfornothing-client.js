// tanksfornothing-client.js
// Summary: Browser client for Tanks for Nothing. Renders 3D scene, handles user input,
//          simulates basic vehicle physics via Cannon.js and synchronizes state with
//          a server through Socket.IO.
// Structure: scene setup -> physics setup -> input handling -> animation loop ->
//             optional networking.
// Usage: Included by index.html; requires Socket.IO for multiplayer networking and
//         loads Cannon.js from CDN for physics.
// ---------------------------------------------------------------------------
import * as THREE from './libs/three.module.js';
// cannon-es provides lightweight rigid body physics with vehicle helpers.
// Imported from CDN to keep repository light while using the latest version.
import * as CANNON from 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';

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

// `io` is provided globally by the socket.io script tag in index.html. Create a
// socket when available and surface connection issues to the player.
let socket = null;
if (window.io) {
  socket = window.io();
  socket.on('connect', () => console.log('Connected to server'));
  socket.on('connect_error', () => showError('Unable to connect to server. Running offline.'));
  socket.on('disconnect', () => showError('Disconnected from server. Running offline.'));
  socket.on('terrain', (name) => buildTerrain(name));
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
  });
} else {
  showError('Socket.IO failed to load. Running offline.');
}

let tank, turret, camera, scene, renderer, ground;
// Physics objects
let world, vehicle, chassisBody, groundBody;
// Default tank stats mapped to physics parameters
const defaultTank = { name: 'Basic', br: 1, mass: 30000, horsepower: 500 };
// Precompute engine/brake forces based on tank stats
const ENGINE_FORCE = defaultTank.horsepower * 5; // simple hp -> force mapping
const BRAKE_FORCE = defaultTank.mass * 0.5; // mass based braking force
let cameraMode = 'third'; // 'first' or 'third'
let freelook = false;
let cameraDistance = 10;
const keys = {};

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
    new THREE.BoxGeometry(2, 1, 4),
    new THREE.MeshStandardMaterial({ color: 0x555555 })
  );
  scene.add(body);
  tank = body;

  // Turret and gun
  turret = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, 0.5, 1.5),
    new THREE.MeshStandardMaterial({ color: 0x777777 })
  );
  turret.position.y = 0.75;
  const gun = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.1, 3),
    new THREE.MeshStandardMaterial({ color: 0x777777 })
  );
  gun.rotation.z = Math.PI / 2;
  gun.position.x = 1.5;
  turret.add(gun);
  tank.add(turret);

  // Chassis physics body mirrors tank mesh
  const box = new CANNON.Box(new CANNON.Vec3(1, 0.5, 2));
  chassisBody = new CANNON.Body({ mass: defaultTank.mass });
  chassisBody.addShape(box);
  chassisBody.position.set(0, 1, 0);
  world.addBody(chassisBody);

  // RaycastVehicle provides suspension and wheel-ground interaction
  vehicle = new CANNON.RaycastVehicle({
    chassisBody,
    indexRightAxis: 0,
    indexUpAxis: 1,
    indexForwardAxis: 2
  });
  const wheelOptions = {
    radius: 0.5,
    directionLocal: new CANNON.Vec3(0, -1, 0),
    suspensionStiffness: 30,
    suspensionRestLength: 0.3,
    axleLocal: new CANNON.Vec3(1, 0, 0),
    frictionSlip: 5,
    dampingRelaxation: 2.3,
    dampingCompression: 4.4,
    maxSuspensionForce: 1e4,
    rollInfluence: 0.01
  };
  const wheelPositions = [
    new CANNON.Vec3(-1, 0, 1.5),
    new CANNON.Vec3(1, 0, 1.5),
    new CANNON.Vec3(-1, 0, -1.5),
    new CANNON.Vec3(1, 0, -1.5)
  ];
  wheelPositions.forEach((pos) => {
    wheelOptions.chassisConnectionPointLocal = pos.clone();
    vehicle.addWheel(wheelOptions);
  });
  vehicle.addToWorld(world);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  renderer = new THREE.WebGLRenderer();
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  document.body.addEventListener('click', () => {
    document.body.requestPointerLock();
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
    if (e.key.toLowerCase() === 'c') freelook = true;
  });
  window.addEventListener('keyup', (e) => {
    keys[e.key.toLowerCase()] = false;
    if (e.key.toLowerCase() === 'c') freelook = false;
  });

  window.addEventListener('wheel', (e) => {
    cameraDistance = Math.min(Math.max(cameraDistance + e.deltaY * 0.01, 5), 20);
  });

  animate();

  // Join game with default tank when networking is available
  if (socket) {
    socket.emit('join', defaultTank);
  }
}

function onMouseMove(e) {
  const sensitivity = 0.002;
  tank.rotation.y -= e.movementX * sensitivity;
  if (!freelook) turret.rotation.y -= e.movementX * sensitivity;
  turret.rotation.x = THREE.MathUtils.clamp(turret.rotation.x - e.movementY * sensitivity, -0.5, 0.5);
}

const clock = new THREE.Clock();
let lastNetwork = 0;
let lastState = { x: 0, y: 0, z: 0, rot: 0, turret: 0 };
function animate() {
  requestAnimationFrame(animate);

  // Handle input -> engine/brake/torque
  let leftForce = 0;
  let rightForce = 0;
  if (keys['w']) { leftForce += ENGINE_FORCE; rightForce += ENGINE_FORCE; }
  if (keys['s']) { leftForce -= ENGINE_FORCE; rightForce -= ENGINE_FORCE; }
  if (keys['a']) { leftForce -= ENGINE_FORCE * 0.5; rightForce += ENGINE_FORCE * 0.5; }
  if (keys['d']) { leftForce += ENGINE_FORCE * 0.5; rightForce -= ENGINE_FORCE * 0.5; }
  vehicle.applyEngineForce(leftForce, 0);
  vehicle.applyEngineForce(leftForce, 2);
  vehicle.applyEngineForce(rightForce, 1);
  vehicle.applyEngineForce(rightForce, 3);

  if (keys[' ']) {
    for (let i = 0; i < 4; i++) vehicle.setBrake(BRAKE_FORCE, i);
  } else {
    for (let i = 0; i < 4; i++) vehicle.setBrake(0, i);
  }

  // Step physics world with fixed timestep
  const delta = clock.getDelta();
  world.step(1 / 60, delta, 3);

  // Sync Three.js mesh with physics body
  tank.position.copy(chassisBody.position);
  tank.quaternion.copy(chassisBody.quaternion);

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

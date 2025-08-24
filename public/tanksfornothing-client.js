// tanksfornothing-client.js
// Summary: Browser client for Tanks for Nothing. Renders 3D scene and handles user input.
// Structure: setup -> input handling -> animation loop -> networking.
// Usage: Included by index.html; expects `io` global from Socket.IO and local Three.js module.
// ---------------------------------------------------------------------------
import * as THREE from './libs/three.module.js';

// `io` is provided globally by the socket.io script tag in index.html

const socket = io();
let tank, turret, camera, scene, renderer;
let cameraMode = 'third'; // 'first' or 'third'
let freelook = false;
let cameraDistance = 10;
const keys = {};

init();

function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xa0d0ff);

  const light = new THREE.HemisphereLight(0xffffff, 0x444444);
  light.position.set(0, 20, 0);
  scene.add(light);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x228822 }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // Tank body
  const body = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4), new THREE.MeshStandardMaterial({ color: 0x555555 }));
  scene.add(body);
  tank = body;

  // Turret and gun
  turret = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 1.5), new THREE.MeshStandardMaterial({ color: 0x777777 }));
  turret.position.y = 0.75;
  const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 3), new THREE.MeshStandardMaterial({ color: 0x777777 }));
  gun.rotation.z = Math.PI / 2;
  gun.position.x = 1.5;
  turret.add(gun);
  tank.add(turret);

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

  // Join game with default tank
  socket.emit('join', { name: 'Basic', br: 1 });
}

function onMouseMove(e) {
  const sensitivity = 0.002;
  tank.rotation.y -= e.movementX * sensitivity;
  if (!freelook) turret.rotation.y -= e.movementX * sensitivity;
  turret.rotation.x = THREE.MathUtils.clamp(turret.rotation.x - e.movementY * sensitivity, -0.5, 0.5);
}

function animate() {
  requestAnimationFrame(animate);
  const speed = 0.05;
  if (keys['w']) tank.position.z -= speed * Math.cos(tank.rotation.y);
  if (keys['s']) tank.position.z += speed * Math.cos(tank.rotation.y);
  if (keys['a']) tank.position.x -= speed * Math.sin(tank.rotation.y);
  if (keys['d']) tank.position.x += speed * Math.sin(tank.rotation.y);

  updateCamera();
  renderer.render(scene, camera);

  // Send state to server
  socket.emit('update', {
    x: tank.position.x,
    y: tank.position.y,
    z: tank.position.z,
    rot: tank.rotation.y,
    turret: turret.rotation.y
  });
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

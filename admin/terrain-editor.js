// terrain-editor.js
// Summary: Provides a simple grid-based terrain editor for the admin panel.
// Structure: state setup -> ground type management -> grid generation & drawing -> event wiring.
// Usage: Imported by terrain.html; allows admins to set map size, manage ground types and paint them onto a 50m grid.

// Default ground types with color, traction and viscosity for quick start
const defaultGroundTypes = [
  { name: 'grass', color: '#3cb043', traction: 0.9, viscosity: 0.1 },
  { name: 'mud', color: '#6b4423', traction: 0.5, viscosity: 0.5 },
  { name: 'snow', color: '#ffffff', traction: 0.4, viscosity: 0.2 },
  { name: 'sand', color: '#c2b280', traction: 0.6, viscosity: 0.3 },
  { name: 'water', color: '#1e90ff', traction: 0.2, viscosity: 0.8 }
];

let groundTypes = [...defaultGroundTypes];
let currentGround = 0; // index into groundTypes currently selected for painting
let grid = []; // 2D array storing ground type indices
let gridWidth = 0; // in cells
let gridHeight = 0; // in cells
const cellPx = 10; // pixel size for each cell when drawing

const canvas = document.getElementById('terrainCanvas');
const ctx = canvas.getContext('2d');

function renderGroundTypes() {
  const list = document.getElementById('groundTypesList');
  list.innerHTML = '';
  groundTypes.forEach((g, i) => {
    const btn = document.createElement('button');
    btn.textContent = g.name;
    btn.style.background = g.color;
    btn.className = i === currentGround ? 'selected' : '';
    btn.addEventListener('click', () => selectGroundType(i));
    const del = document.createElement('span');
    del.textContent = '✖';
    del.className = 'delete-ground';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteGroundType(i);
    });
    btn.appendChild(del);
    list.appendChild(btn);
  });
}

function selectGroundType(i) {
  currentGround = i;
  renderGroundTypes();
}

function deleteGroundType(i) {
  if (groundTypes.length === 1) return; // keep at least one type
  groundTypes.splice(i, 1);
  if (currentGround >= groundTypes.length) currentGround = 0;
  renderGroundTypes();
  drawGrid();
}

function addGroundType() {
  const name = document.getElementById('groundName').value.trim();
  if (!name) return;
  const color = document.getElementById('groundColor').value;
  const traction = Number(document.getElementById('groundTraction').value);
  const viscosity = Number(document.getElementById('groundViscosity').value);
  groundTypes.push({ name, color, traction, viscosity });
  document.getElementById('groundName').value = '';
  renderGroundTypes();
}

function generateGrid() {
  const type = document.getElementById('terrainType').value;
  const xKm = Number(document.getElementById('sizeX').value);
  const yKm = Number(document.getElementById('sizeY').value);
  gridWidth = Math.max(1, Math.round((xKm * 1000) / 50));
  gridHeight = Math.max(1, Math.round((yKm * 1000) / 50));
  console.debug('Generating grid', { type, gridWidth, gridHeight });
  grid = Array.from({ length: gridHeight }, () => Array(gridWidth).fill(currentGround));
  canvas.width = gridWidth * cellPx;
  canvas.height = gridHeight * cellPx;
  drawGrid();
}

function drawGrid() {
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      drawCell(x, y);
    }
  }
}

function drawCell(x, y) {
  const gt = groundTypes[grid[y][x]];
  ctx.fillStyle = gt.color;
  ctx.fillRect(x * cellPx, y * cellPx, cellPx, cellPx);
  ctx.strokeStyle = '#00000033';
  ctx.strokeRect(x * cellPx, y * cellPx, cellPx, cellPx);
}

function paint(e) {
  if (gridWidth === 0 || gridHeight === 0) return;
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) / cellPx);
  const y = Math.floor((e.clientY - rect.top) / cellPx);
  if (x < 0 || y < 0 || x >= gridWidth || y >= gridHeight) return;
  grid[y][x] = currentGround;
  drawCell(x, y);
}

// Event wiring
renderGroundTypes();

document.getElementById('addGroundBtn').addEventListener('click', addGroundType);
document.getElementById('generateBtn').addEventListener('click', generateGrid);
canvas.addEventListener('mousedown', paint);


// terrain-editor.js
// Summary: Enhanced terrain editor with raised-cosine elevation brush, proportional 3D preview and axis toggle.
// Structure: state setup -> ground type management -> grid generation -> drawing -> raised-cosine painting -> 3D plot -> event wiring.
// Usage: Imported by terrain.html; provides smooth terrain sculpting with adjustable X/Y size and peak height sliders. Axes in the
//         3D preview are measured in metres with a fixed 50 m grid spacing and can be hidden for a clean view.

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
let groundGrid = []; // 2D array storing ground type indices
let elevationGrid = []; // 2D array storing elevation heights
let gridWidth = 0; // in cells
let gridHeight = 0; // in cells
let mapWidthMeters = 0; // actual map width represented, in metres
let mapHeightMeters = 0; // actual map height represented, in metres
const cellPx = 10; // pixel size for each cell when drawing
const cellMeters = 50; // each grid cell equals 50 metres on the terrain
const maxHeight = 100; // max elevation value used for shading

const canvas = document.getElementById('terrainCanvas');
const ctx = canvas.getContext('2d');

// Render available ground types as selectable buttons
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
  update3DPlot();
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

// Generate grid based on map size in km (1 cell = 50 m)
function generateGrid() {
  const type = document.getElementById('terrainType').value;
  const xKm = Number(document.getElementById('sizeX').value);
  const yKm = Number(document.getElementById('sizeY').value);
  const xMeters = xKm * 1000;
  const yMeters = yKm * 1000;
  gridWidth = Math.max(1, Math.round(xMeters / cellMeters));
  gridHeight = Math.max(1, Math.round(yMeters / cellMeters));
  mapWidthMeters = gridWidth * cellMeters;
  mapHeightMeters = gridHeight * cellMeters;
  console.debug('Generating grid', { type, gridWidth, gridHeight, mapWidthMeters, mapHeightMeters });
  groundGrid = Array.from({ length: gridHeight }, () => Array(gridWidth).fill(currentGround));
  elevationGrid = Array.from({ length: gridHeight }, () => Array(gridWidth).fill(0));
  // Set drawing buffer dimensions and mirror them as CSS sizes so grid cells remain square
  canvas.width = gridWidth * cellPx;
  canvas.height = gridHeight * cellPx;
  canvas.style.width = `${canvas.width}px`;
  canvas.style.height = `${canvas.height}px`;
  drawGrid();
  update3DPlot();
}

// Draw entire grid to canvas
function drawGrid() {
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      drawCell(x, y);
    }
  }
}

// Lighten ground color based on elevation for quick visual feedback
function shadeColor(hex, height) {
  const num = parseInt(hex.slice(1), 16);
  let r = num >> 16;
  let g = (num >> 8) & 0xff;
  let b = num & 0xff;
  const factor = 0.5 + (height / (2 * maxHeight));
  r = Math.min(255, Math.round(r * factor));
  g = Math.min(255, Math.round(g * factor));
  b = Math.min(255, Math.round(b * factor));
  return `rgb(${r},${g},${b})`;
}

function drawCell(x, y) {
  const gt = groundTypes[groundGrid[y][x]];
  ctx.fillStyle = shadeColor(gt.color, elevationGrid[y][x]);
  ctx.fillRect(x * cellPx, y * cellPx, cellPx, cellPx);
  ctx.strokeStyle = '#00000033';
  ctx.strokeRect(x * cellPx, y * cellPx, cellPx, cellPx);
}

// Apply raised-cosine brush using X/Y size sliders and peak height
function applyRaisedCosineBrush(cx, cy, cb) {
  const rx = Number(document.getElementById('brushSizeX').value);
  const ry = Number(document.getElementById('brushSizeY').value);
  const peak = Number(document.getElementById('brushSizeZ').value);
  console.debug('Brush params', { cx, cy, rx, ry, peak });
  for (let dy = -ry; dy <= ry; dy++) {
    for (let dx = -rx; dx <= rx; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= gridWidth || y >= gridHeight) continue;
      const dist = Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2);
      if (dist > 1) continue; // outside ellipse
      const influence = peak * 0.5 * (1 + Math.cos(Math.PI * dist));
      cb(x, y, influence);
    }
  }
}

function handlePaint(e) {
  if (gridWidth === 0 || gridHeight === 0) return;
  const rect = canvas.getBoundingClientRect();
  // Account for potential CSS scaling so clicks map to the correct cell
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const cx = Math.floor(((e.clientX - rect.left) * scaleX) / cellPx);
  const cy = Math.floor(((e.clientY - rect.top) * scaleY) / cellPx);
  const mode = document.getElementById('mode').value;
  const button = e.button;
  applyRaisedCosineBrush(cx, cy, (x, y, influence) => {
    if (mode === 'ground') {
      groundGrid[y][x] = currentGround;
    } else {
      const sign = button === 2 ? -1 : 1;
      const newHeight = elevationGrid[y][x] + sign * influence;
      elevationGrid[y][x] = Math.max(0, Math.min(maxHeight, newHeight));
    }
    drawCell(x, y);
  });
  if (mode === 'elevation') update3DPlot();
}

// Fill elevation grid with random heights for quick terrain generation
function randomizeTerrain() {
  if (gridWidth === 0 || gridHeight === 0) return;
  elevationGrid = Array.from({ length: gridHeight }, () =>
    Array.from({ length: gridWidth }, () => Math.random() * maxHeight)
  );
  drawGrid();
  update3DPlot();
}

// Render 3D surface using Plotly with ground type colors
function update3DPlot() {
  if (!window.Plotly || gridWidth === 0 || gridHeight === 0) return;
  const colorIndices = groundGrid.map(row => row.map(i => i));
  const colorscale = groundTypes.map((g, i) => [
    groundTypes.length === 1 ? 0 : i / (groundTypes.length - 1),
    g.color
  ]);
  const xCoords = Array.from({ length: gridWidth }, (_, i) => i * cellMeters);
  const yCoords = Array.from({ length: gridHeight }, (_, i) => i * cellMeters);
  const showAxes = document.getElementById('showAxes').checked; // user toggle for axis visibility
  const layout = {
    margin: { l: 0, r: 0, t: 0, b: 0 },
    scene: {
      // Axes use metres so setting aspectmode:'data' keeps proportions realistic
      xaxis: { title: 'X (m)', range: [0, mapWidthMeters], dtick: cellMeters, visible: showAxes },
      yaxis: { title: 'Y (m)', range: [0, mapHeightMeters], dtick: cellMeters, visible: showAxes },
      zaxis: { title: 'Elevation (m)', range: [0, maxHeight], dtick: cellMeters, visible: showAxes },
      aspectmode: 'data',
      camera: { eye: { x: 0, y: 0, z: 2 }, projection: { type: 'orthographic' } }
    }
  };
  Plotly.newPlot('terrain3d', [{
    x: xCoords,
    y: yCoords,
    z: elevationGrid,
    surfacecolor: colorIndices,
    colorscale,
    cmin: 0,
    cmax: groundTypes.length - 1,
    type: 'surface',
    showscale: false
  }], layout);
}

// Event wiring
renderGroundTypes();
document.getElementById('addGroundBtn').addEventListener('click', addGroundType);
document.getElementById('generateBtn').addEventListener('click', generateGrid);
document.getElementById('randomizeBtn').addEventListener('click', randomizeTerrain);
document.getElementById('showAxes').addEventListener('change', update3DPlot);

let mouseDown = false;
canvas.addEventListener('mousedown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  mouseDown = true;
  handlePaint(e);
});
canvas.addEventListener('mousemove', (e) => {
  if (mouseDown) {
    e.preventDefault();
    e.stopPropagation();
    handlePaint(e);
  }
});
canvas.addEventListener('mouseup', (e) => {
  e.preventDefault();
  e.stopPropagation();
  mouseDown = false;
});
canvas.addEventListener('mouseleave', () => { mouseDown = false; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());


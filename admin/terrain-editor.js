// terrain-editor.js
// Summary: Terrain editor enabling direct 3D surface sculpting with a raised-cosine brush, camera presets,
//          perspective control and shading.
// Structure: state setup -> ground type management -> grid generation -> raised-cosine painting -> 3D plot with camera controls -> event wiring.
// Usage: Imported by terrain.html; click or drag on the 3D plot to paint ground or elevation. Axes and camera settings are user configurable.

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
const cellMeters = 50; // each grid cell equals 50 metres on the terrain
const maxHeight = 100; // max elevation value used for shading

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
  update3DPlot();
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

function handlePlotPaint(e) {
  if (gridWidth === 0 || gridHeight === 0) return;
  const point = e.points?.[0];
  if (!point) return;
  const cx = Math.floor(point.x / cellMeters);
  const cy = Math.floor(point.y / cellMeters);
  const mode = document.getElementById('mode').value;
  const button = e.event.button;
  applyRaisedCosineBrush(cx, cy, (x, y, influence) => {
    if (mode === 'ground') {
      groundGrid[y][x] = currentGround;
    } else {
      const sign = button === 2 ? -1 : 1;
      const newHeight = elevationGrid[y][x] + sign * influence;
      elevationGrid[y][x] = Math.max(0, Math.min(maxHeight, newHeight));
    }
  });
  update3DPlot();
}

// Fill elevation grid with random heights for quick terrain generation
function randomizeTerrain() {
  if (gridWidth === 0 || gridHeight === 0) return;
  elevationGrid = Array.from({ length: gridHeight }, () =>
    Array.from({ length: gridWidth }, () => Math.random() * maxHeight)
  );
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
  const view = document.getElementById('viewSelect').value;
  const projection = document.getElementById('projectionType').value;
  const lockCamera = document.getElementById('lockCamera').checked;
  let eye;
  switch (view) {
    case 'top':
      eye = { x: 0, y: 0, z: 2 };
      break;
    case 'front':
      eye = { x: 0, y: 2, z: 0.1 };
      break;
    case 'side':
      eye = { x: 2, y: 0, z: 0.1 };
      break;
    default:
      eye = { x: 1.25, y: 1.25, z: 1.25 };
  }
  const layout = {
    margin: { l: 0, r: 0, t: 0, b: 0 },
    scene: {
      xaxis: { title: 'X (m)', range: [0, mapWidthMeters], dtick: cellMeters, visible: showAxes },
      yaxis: { title: 'Y (m)', range: [0, mapHeightMeters], dtick: cellMeters, visible: showAxes },
      zaxis: { title: 'Elevation (m)', range: [0, maxHeight], dtick: cellMeters, visible: showAxes },
      aspectmode: 'data',
      dragmode: lockCamera ? false : 'turntable',
      camera: { eye, projection: { type: projection } }
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
    showscale: false,
    lighting: { ambient: 0.4, diffuse: 0.6, specular: 0.2, roughness: 0.5, fresnel: 0.2 },
    lightposition: { x: 100, y: 200, z: 400 }
  }], layout, { responsive: true });
}

// Event wiring
renderGroundTypes();
document.getElementById('addGroundBtn').addEventListener('click', addGroundType);
document.getElementById('generateBtn').addEventListener('click', generateGrid);
document.getElementById('randomizeBtn').addEventListener('click', randomizeTerrain);
document.getElementById('showAxes').addEventListener('change', update3DPlot);
document.getElementById('viewSelect').addEventListener('change', update3DPlot);
document.getElementById('projectionType').addEventListener('change', update3DPlot);
document.getElementById('lockCamera').addEventListener('change', update3DPlot);

const plot = document.getElementById('terrain3d');
let mouseDown = false;
plot.addEventListener('mousedown', () => { mouseDown = true; });
document.addEventListener('mouseup', () => { mouseDown = false; });
plot.addEventListener('contextmenu', (e) => e.preventDefault());
plot.on('plotly_click', handlePlotPaint);
plot.on('plotly_hover', (e) => { if (mouseDown) handlePlotPaint(e); });


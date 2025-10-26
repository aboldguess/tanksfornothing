// terrain-editor.ts
// @ts-nocheck
// Summary: Terrain editor enabling direct 3D surface sculpting with a raised-cosine brush, camera presets,
//          perspective control, shading, Perlin-noise-based terrain generation (with adjustable scale
//          and amplitude controls) and capture-the-flag position placement. Ground, elevation and flag
//          tools are separated via a tabbed interface. Displays a friendly message if Plotly is unavailable.
// Structure: state setup -> ground type management -> terrain initialization -> raised-cosine painting ->
//            Perlin noise generation -> 3D plot with camera controls -> event wiring.
// Usage: Imported by terrain.html; click or drag on the 3D plot to paint ground or elevation. Axes and
//        camera settings are user configurable.
/* global Plotly */

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

let currentMode = 'ground'; // currently active editing tool
let terrainEditorMissingListWarned = false; // prevent repeated console noise when markup changes
let terrainEditorInitialized = false; // ensure DOM wiring happens only once

// Capture-the-flag positions for red and blue teams (a-d each)
function defaultFlags() {
  return {
    red: { a: null, b: null, c: null, d: null },
    blue: { a: null, b: null, c: null, d: null }
  };
}
let flags = defaultFlags();
window.getTerrainFlags = () => flags; // exposed for admin.js persistence
window.getTerrainGround = () => groundGrid;
window.getTerrainElevation = () => elevationGrid;

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

// Initialize terrain based on map size in km (1 cell = 50 m)
function initializeTerrain() {
  const type = document.getElementById('terrainType').value;
  const xKm = Number(document.getElementById('sizeX').value);
  const yKm = Number(document.getElementById('sizeY').value);
  const xMeters = xKm * 1000;
  const yMeters = yKm * 1000;
  gridWidth = Math.max(1, Math.round(xMeters / cellMeters));
  gridHeight = Math.max(1, Math.round(yMeters / cellMeters));
  mapWidthMeters = gridWidth * cellMeters;
  mapHeightMeters = gridHeight * cellMeters;
  console.debug('Initializing terrain', { type, gridWidth, gridHeight, mapWidthMeters, mapHeightMeters });
  flags = window.existingFlags ? JSON.parse(JSON.stringify(window.existingFlags)) : defaultFlags();
  groundGrid = window.existingGround
    ? window.existingGround.map(row => row.slice())
    : Array.from({ length: gridHeight }, () => Array(gridWidth).fill(currentGround));
  elevationGrid = window.existingElevation
    ? window.existingElevation.map(row => row.slice())
    : Array.from({ length: gridHeight }, () => Array(gridWidth).fill(0));
  if (!window.existingElevation) {
    document.getElementById('perlinAmplitude').value = 20;
    generatePerlinTerrain();
  } else {
    update3DPlot();
  }
}

// Apply raised-cosine brush using X/Y size sliders and peak height
function applyRaisedCosineBrush(cx, cy, rx, ry, peak, cb) {
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
  const button = e.event.button;
  if (currentMode === 'flags') {
    const [team, letter] = document.getElementById('flagSelect').value.split('-');
    flags[team][letter] = {
      x: cx * cellMeters + cellMeters / 2,
      y: cy * cellMeters + cellMeters / 2
    };
    console.debug('Set flag', { team, letter, position: flags[team][letter] });
    update3DPlot();
  } else if (currentMode === 'ground') {
    const rx = Number(document.getElementById('gBrushSizeX').value);
    const ry = Number(document.getElementById('gBrushSizeY').value);
    applyRaisedCosineBrush(cx, cy, rx, ry, 1, (x, y) => {
      groundGrid[y][x] = currentGround;
    });
    update3DPlot();
  } else if (currentMode === 'elevation') {
    const rx = Number(document.getElementById('eBrushSizeX').value);
    const ry = Number(document.getElementById('eBrushSizeY').value);
    const peak = Number(document.getElementById('eBrushSizeZ').value);
    const sign = button === 2 ? -1 : 1;
    applyRaisedCosineBrush(cx, cy, rx, ry, peak, (x, y, influence) => {
      const newHeight = elevationGrid[y][x] + sign * influence;
      elevationGrid[y][x] = Math.max(0, Math.min(maxHeight, newHeight));
    });
    update3DPlot();
  }
}

// PerlinNoise generator based on public domain implementation by Stefan Gustavson
// Used here for deterministic, natural-looking terrain generation.
class PerlinNoise {
  constructor() {
    this.permutation = [
      151,160,137,91,90,15,
      131,13,201,95,96,53,194,233,7,225,140,36,103,30,69,142,
      8,99,37,240,21,10,23,190, 6,148,247,120,234,75,0,26,197,62,94,252,
      219,203,117,35,11,32,57,177,33,88,237,149,56,87,174,20,125,136,171,168,
      68,175,74,165,71,134,139,48,27,166,77,146,158,231,83,111,229,122,60,211,
      133,230,220,105,92,41,55,46,245,40,244,102,143,54,65,25,63,161,1,216,
      80,73,209,76,132,187,208,89,18,169,200,196,135,130,116,188,159,86,164,100,
      109,198,173,186,3,64,52,217,226,250,124,123,5,202,38,147,118,126,255,82,
      85,212,207,206,59,227,47,16,58,17,182,189,28,42,223,183,170,213,119,248,
      152,2,44,154,163,70,221,153,101,155,167,43,172,9,129,22,39,253,19,98,
      108,110,79,113,224,232,178,185,112,104,218,246,97,228,251,34,242,193,238,210,
      144,12,191,179,162,241,81,51,145,235,249,14,239,107,49,192,214,31,181,199,
      106,157,184,84,204,176,115,121,50,45,127,4,150,254,138,236,205,93,222,114,
      67,29,24,72,243,141,128,195,78,66,215,61,156,180
    ];
    this.p = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.p[i] = this.permutation[i & 255];
    }
  }
  fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  lerp(t, a, b) { return a + t * (b - a); }
  grad(hash, x, y, z) {
    const h = hash & 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  }
  noise(x, y, z = 0) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(z) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    z -= Math.floor(z);
    const u = this.fade(x);
    const v = this.fade(y);
    const w = this.fade(z);
    const A = this.p[X] + Y;
    const AA = this.p[A] + Z;
    const AB = this.p[A + 1] + Z;
    const B = this.p[X + 1] + Y;
    const BA = this.p[B] + Z;
    const BB = this.p[B + 1] + Z;
    return this.lerp(w,
      this.lerp(v,
        this.lerp(u, this.grad(this.p[AA], x, y, z),
                     this.grad(this.p[BA], x - 1, y, z)),
        this.lerp(u, this.grad(this.p[AB], x, y - 1, z),
                     this.grad(this.p[BB], x - 1, y - 1, z))
      ),
      this.lerp(v,
        this.lerp(u, this.grad(this.p[AA + 1], x, y, z - 1),
                     this.grad(this.p[BA + 1], x - 1, y, z - 1)),
        this.lerp(u, this.grad(this.p[AB + 1], x, y - 1, z - 1),
                     this.grad(this.p[BB + 1], x - 1, y - 1, z - 1))
      )
    );
  }
}

// Generate elevation grid using Perlin noise for more natural terrain
function generatePerlinTerrain() {
  if (gridWidth === 0 || gridHeight === 0) return;
  const noise = new PerlinNoise();
  const scaleInput = Number(document.getElementById('perlinScale').value);
  const amplitudeInput = Number(document.getElementById('perlinAmplitude').value);
  const scale = Math.max(1, scaleInput || 10);
  const amplitude = Math.max(1, Math.min(maxHeight, amplitudeInput || maxHeight));
  elevationGrid = Array.from({ length: gridHeight }, (_, y) =>
    Array.from({ length: gridWidth }, (_, x) => {
      const value = noise.noise(x / scale, y / scale, 0);
      return ((value + 1) / 2) * amplitude; // normalize to [0, amplitude]
    })
  );
  console.debug('Perlin terrain generated', { gridWidth, gridHeight, scale, amplitude });
  update3DPlot();
}

// Render 3D surface using Plotly with ground type colors
function update3DPlot() {
  // If Plotly failed to load from the CDN, inform the user and skip rendering
  if (typeof Plotly === 'undefined') {
    console.warn('Plotly library unavailable; 3-D preview disabled');
    const placeholder = document.getElementById('terrain3d');
    if (placeholder) placeholder.textContent = '3-D preview unavailable';
    return;
  }
  if (gridWidth === 0 || gridHeight === 0) return;
  const colorIndices = groundGrid.map(row => row.map(i => i));
  const colorscale = groundTypes.map((g, i) => [
    groundTypes.length === 1 ? 0 : i / (groundTypes.length - 1),
    g.color
  ]);
  let highestElevation = 0;
  for (const row of elevationGrid) {
    for (const value of row) {
      if (Number.isFinite(value) && value > highestElevation) highestElevation = value;
    }
  }
  const safeMax = Math.max(1, highestElevation);
  const axisMax = Math.min(maxHeight, Math.ceil(safeMax / 5) * 5);
  const zTick = Math.max(1, Math.round(axisMax / 5));
  console.debug('Plot axis scaling', { highestElevation, axisMax, zTick });
  const xCoords = Array.from({ length: gridWidth }, (_, i) => i * cellMeters);
  const yCoords = Array.from({ length: gridHeight }, (_, i) => i * cellMeters);
  const showAxes = document.getElementById('showAxes').checked; // user toggle for axis visibility
  const view = document.getElementById('viewSelect').value;
  const projection = document.getElementById('projectionType').value;
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
      zaxis: { title: 'Elevation (m)', range: [0, axisMax], dtick: zTick, visible: showAxes },
      aspectmode: 'data',
      dragmode: 'turntable',
      camera: { eye, projection: { type: projection } }
    }
  };
  const traces = [{
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
  }];
  const flagColors = { red: 'red', blue: 'blue' };
  ['red', 'blue'].forEach(team => {
    ['a', 'b', 'c', 'd'].forEach(letter => {
      const pos = flags[team][letter];
      if (pos) {
        traces.push({
          x: [pos.x],
          y: [pos.y],
          z: [0],
          text: [`${team[0].toUpperCase()}${letter.toUpperCase()}`],
          mode: 'markers+text',
          type: 'scatter3d',
          marker: { size: 5, color: flagColors[team] },
          textposition: 'top center'
        });
      }
    });
  });
  const plot = document.getElementById('terrain3d');
  if (!plot.data) {
    Plotly.newPlot(plot, traces, layout, { responsive: true });
    plot.on('plotly_click', handlePlotPaint);
    plot.on('plotly_hover', (e) => { if (mouseDown) handlePlotPaint(e); });
  } else {
    Plotly.react(plot, traces, layout);
  }
  applyCameraLock();
}

// Prevent scrolling to keep zoom level fixed when camera is locked
function preventPlotScroll(e) {
  e.preventDefault();
}

// Toggle drag and zoom capabilities to freeze or free the current view
function applyCameraLock() {
  const locked = document.getElementById('lockCamera').checked;
  const plot = document.getElementById('terrain3d');
  Plotly.relayout(plot, { 'scene.dragmode': locked ? false : 'turntable' });
  plot.removeEventListener('wheel', preventPlotScroll);
  if (locked) plot.addEventListener('wheel', preventPlotScroll, { passive: false });
}

// Wire up the terrain editor UI once the DOM is ready or the editor is opened
function setupTerrainEditor(e) {
  // Ensure required elements exist before wiring events to avoid runtime errors
  const groundTypesList = document.getElementById('groundTypesList');
  if (!groundTypesList) {
    if (!terrainEditorMissingListWarned) {
      console.warn('setupTerrainEditor: #groundTypesList not found');
      terrainEditorMissingListWarned = true;
    }
    return;
  }

  if (!terrainEditorInitialized) {
    const ids = [
      'addGroundBtn',
      'perlinBtn',
      'showAxes',
      'viewSelect',
      'projectionType',
      'lockCamera',
      'sizeX',
      'sizeY',
      'terrainType'
    ];
    const elements = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) {
        console.warn(`setupTerrainEditor: #${id} not found`);
        return;
      }
      elements[id] = el;
    }

    const toolTabs = document.querySelectorAll('.tool-tab');
    if (!toolTabs.length) {
      console.warn('setupTerrainEditor: .tool-tab elements not found');
      return;
    }

    // Only render ground types after confirming the list exists
    renderGroundTypes();

    elements.addGroundBtn.addEventListener('click', addGroundType);
    elements.perlinBtn.addEventListener('click', generatePerlinTerrain);
    elements.showAxes.addEventListener('change', update3DPlot);
    elements.viewSelect.addEventListener('change', update3DPlot);
    elements.projectionType.addEventListener('change', update3DPlot);
    elements.lockCamera.addEventListener('change', applyCameraLock);
    toolTabs.forEach(btn => btn.addEventListener('click', () => setMode(btn.dataset.mode)));

    ['sizeX', 'sizeY', 'terrainType'].forEach(id => {
      elements[id].addEventListener('change', initializeTerrain);
    });

    terrainEditorInitialized = true;
  }

  if (e && e.type === 'terrain-editor-opened') {
    initializeTerrain();
  }
}

document.addEventListener('DOMContentLoaded', setupTerrainEditor);
document.addEventListener('terrain-editor-opened', setupTerrainEditor);

const plotDiv = document.getElementById('terrain3d');
let mouseDown = false;
plotDiv.addEventListener('mousedown', () => { mouseDown = true; });
document.addEventListener('mouseup', () => { mouseDown = false; });
plotDiv.addEventListener('contextmenu', (e) => e.preventDefault());

function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.tool-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  document.getElementById('groundControls').style.display = mode === 'ground' ? '' : 'none';
  document.getElementById('elevationControls').style.display = mode === 'elevation' ? '' : 'none';
  document.getElementById('flagControls').style.display = mode === 'flags' ? '' : 'none';
}
setMode('ground');


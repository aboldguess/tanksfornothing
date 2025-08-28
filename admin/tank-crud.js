// tank-crud.js
// Summary: Standalone module powering the prototype tank CRUD page. It builds the
//          editor form from a field configuration object, renders simple canvas
//          thumbnails for each tank and performs fetch-based create, update and
//          delete operations against the server's /api/tanks endpoint.
// Structure: data caches -> DOM builders -> rendering helpers -> CRUD handlers -> init.
// Usage: Loaded by tank-crud.html. Requires an admin session cookie.

let tanks = [];
let nations = [];
let editingIndex = null; // null means creating a new tank

// Field configuration grouped by section to allow dynamic form generation.
// Each field defines id, label and input attributes. Range inputs will have
// their current value displayed beside the slider for clarity.
const FORM_SECTIONS = [
  {
    title: 'Basics',
    fields: [
      { id: 'name', label: 'Name', type: 'text' },
      { id: 'nation', label: 'Nation', type: 'select', options: () => nations.map(n => n.name) },
      { id: 'br', label: 'Battle Rating', type: 'range', min: 1, max: 10, step: 0.1 },
      { id: 'class', label: 'Class', type: 'select', options: ['Light/Scout', 'Medium/MBT', 'Heavy', 'Tank Destroyer'] }
    ]
  },
  {
    title: 'Armament',
    fields: [
      { id: 'cannonCaliber', label: 'Cannon Caliber (mm)', type: 'range', min: 20, max: 150, step: 10 },
      { id: 'ammo', label: 'Ammo Types', type: 'checkbox', options: ['AP', 'HE', 'HEAT', 'Smoke'] },
      { id: 'ammoCapacity', label: 'Ammo Capacity', type: 'range', min: 1, max: 120, step: 1 },
      { id: 'turretRotation', label: 'Turret Rotation (s/360°)', type: 'range', min: 1, max: 60, step: 1 },
      { id: 'horizontalTraverse', label: 'Horizontal Traverse (deg)', type: 'range', min: 0, max: 20, step: 1 },
      { id: 'maxTurretIncline', label: 'Max Turret Incline (deg)', type: 'range', min: 0, max: 50, step: 1 },
      { id: 'maxTurretDecline', label: 'Max Turret Decline (deg)', type: 'range', min: 0, max: 25, step: 1 }
    ]
  },
  {
    title: 'Survivability',
    fields: [
      { id: 'crew', label: 'Crew', type: 'range', min: 1, max: 10, step: 1 },
      { id: 'armor', label: 'Chassis Armor (mm)', type: 'range', min: 10, max: 150, step: 1 },
      { id: 'turretArmor', label: 'Turret Armor (mm)', type: 'range', min: 10, max: 150, step: 1 }
    ]
  },
  {
    title: 'Maneuverability',
    fields: [
      { id: 'engineHp', label: 'Engine HP', type: 'range', min: 100, max: 1000, step: 50 },
      { id: 'maxSpeed', label: 'Max Speed (km/h)', type: 'range', min: 10, max: 100, step: 1 },
      { id: 'maxReverseSpeed', label: 'Max Reverse (km/h)', type: 'range', min: 0, max: 50, step: 0.5 },
      { id: 'incline', label: 'Max Incline (%)', type: 'range', min: 2, max: 12, step: 1 },
      { id: 'bodyRotation', label: 'Body Rotation (s/360°)', type: 'range', min: 1, max: 60, step: 1 }
    ]
  },
  {
    title: 'Dimensions',
    fields: [
      { id: 'bodyWidth', label: 'Body Width (m)', type: 'range', min: 1, max: 5, step: 0.25 },
      { id: 'bodyLength', label: 'Body Length (m)', type: 'range', min: 1, max: 10, step: 0.25 },
      { id: 'bodyHeight', label: 'Body Height (m)', type: 'range', min: 1, max: 3, step: 0.25 },
      { id: 'turretWidth', label: 'Turret Width (m)', type: 'range', min: 1, max: 3, step: 0.25 },
      { id: 'turretLength', label: 'Turret Length (m)', type: 'range', min: 1, max: 5, step: 0.25 },
      { id: 'turretHeight', label: 'Turret Height (m)', type: 'range', min: 0.25, max: 2, step: 0.25 }
    ]
  }
];

// Build the form at runtime so new fields can be added easily.
function buildForm() {
  const form = document.getElementById('tankForm');
  form.innerHTML = '';
  FORM_SECTIONS.forEach(section => {
    const fs = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = section.title;
    fs.appendChild(legend);
    section.fields.forEach(f => {
      const label = document.createElement('label');
      label.textContent = f.label;
      let input;
      if (f.type === 'select') {
        input = document.createElement('select');
        const opts = typeof f.options === 'function' ? f.options() : f.options;
        opts.forEach(opt => {
          const o = document.createElement('option');
          o.value = opt;
          o.textContent = opt;
          input.appendChild(o);
        });
      } else if (f.type === 'checkbox') {
        input = document.createElement('div');
        input.className = 'checkbox-group';
        f.options.forEach(opt => {
          const cbLabel = document.createElement('label');
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.name = f.id;
          cb.value = opt;
          cbLabel.appendChild(cb);
          cbLabel.appendChild(document.createTextNode(' ' + opt));
          input.appendChild(cbLabel);
        });
      } else {
        input = document.createElement('input');
        input.type = f.type;
        if (f.min !== undefined) input.min = f.min;
        if (f.max !== undefined) input.max = f.max;
        if (f.step !== undefined) input.step = f.step;
        if (f.type === 'range') {
          // Set default to mid-scale so the UI looks balanced on first load.
          const mid = (Number(f.min) + Number(f.max)) / 2;
          input.value = mid;
          const span = document.createElement('span');
          span.id = f.id + 'Val';
          span.textContent = mid;
          input.addEventListener('input', () => span.textContent = input.value);
          label.appendChild(input);
          label.appendChild(span);
          fs.appendChild(label);
          return;
        }
      }
      input.id = 'tank' + f.id.charAt(0).toUpperCase() + f.id.slice(1);
      label.appendChild(input);
      fs.appendChild(label);
    });
    form.appendChild(fs);
  });
  const preview = document.createElement('canvas');
  preview.id = 'tankPreview';
  preview.width = 300;
  preview.height = 150;
  form.appendChild(preview);
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = editingIndex === null ? 'Add Tank' : 'Update Tank';
  form.appendChild(submit);
}

function renderTable() {
  const tbody = document.getElementById('tankTableBody');
  tbody.innerHTML = '';
  tanks.forEach((t, i) => {
    const tr = document.createElement('tr');
    const thumbCell = document.createElement('td');
    const canvas = document.createElement('canvas');
    canvas.width = 60; canvas.height = 30;
    drawTank(canvas, t);
    thumbCell.appendChild(canvas);
    tr.appendChild(thumbCell);
    ['name', 'nation', 'br', 'class'].forEach(k => {
      const td = document.createElement('td');
      td.textContent = t[k];
      tr.appendChild(td);
    });
    const actions = document.createElement('td');
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => startEdit(i));
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => deleteTank(i));
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    tr.appendChild(actions);
    tbody.appendChild(tr);
  });
}

function drawTank(canvas, tank) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / tank.bodyLength, canvas.height / tank.bodyWidth);
  const bw = tank.bodyWidth * scale;
  const bl = tank.bodyLength * scale;
  const bx = (canvas.width - bl) / 2;
  const by = (canvas.height - bw) / 2;
  ctx.fillStyle = '#666';
  ctx.fillRect(bx, by, bl, bw);
  const tw = tank.turretWidth * scale;
  const tl = tank.turretLength * scale;
  const tx = (canvas.width - tl) / 2;
  const ty = (canvas.height - tw) / 2;
  ctx.fillStyle = '#999';
  ctx.fillRect(tx, ty, tl, tw);
}

function startEdit(i) {
  editingIndex = i;
  buildForm();
  const t = tanks[i];
  FORM_SECTIONS.forEach(sec => {
    sec.fields.forEach(f => {
      const el = document.getElementById('tank' + capitalize(f.id));
      if (!el) return;
      if (f.type === 'checkbox') {
        el.querySelectorAll('input').forEach(cb => cb.checked = t[f.id].includes(cb.value));
      } else {
        el.value = t[f.id];
        if (f.type === 'range') document.getElementById(f.id + 'Val').textContent = t[f.id];
      }
    });
  });
  drawTank(document.getElementById('tankPreview'), t);
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

async function deleteTank(i) {
  await fetch(`/api/tanks/${i}`, { method: 'DELETE', credentials: 'include' });
  await loadData();
}

function gatherFormData() {
  const t = {};
  FORM_SECTIONS.forEach(sec => {
    sec.fields.forEach(f => {
      const el = document.getElementById('tank' + capitalize(f.id));
      if (f.type === 'checkbox') {
        t[f.id] = Array.from(el.querySelectorAll('input:checked')).map(cb => cb.value);
      } else if (f.type === 'range') {
        t[f.id] = parseFloat(el.value);
      } else {
        t[f.id] = el.value;
      }
    });
  });
  return t;
}

async function submitForm(e) {
  e.preventDefault();
  const data = gatherFormData();
  const method = editingIndex === null ? 'POST' : 'PUT';
  const url = editingIndex === null ? '/api/tanks' : `/api/tanks/${editingIndex}`;
  await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(data)
  });
  editingIndex = null;
  await loadData();
  buildForm();
}

async function loadData() {
  const [nRes, tRes] = await Promise.all([
    fetch('/api/nations', { credentials: 'include' }),
    fetch('/api/tanks', { credentials: 'include' })
  ]);
  nations = await nRes.json();
  tanks = await tRes.json();
  renderTable();
}

function init() {
  const form = document.getElementById('tankForm');
  form.addEventListener('submit', submitForm);
  loadData().then(buildForm);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

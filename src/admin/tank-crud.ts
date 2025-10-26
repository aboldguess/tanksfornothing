// tank-crud.ts
// @ts-nocheck
// Summary: Standalone module powering the tank CRUD page. It renders a fully
//          dynamic table displaying every tank parameter, adds column sorting
//          and quick filtering and enables inline row editing via slider-based
//          controls.
// Structure: data caches -> table builders/sort+filter -> editing helpers -> CRUD handlers -> init.
// Usage: Loaded by tank-crud.html. Requires an admin session cookie.

let tanks = [];
let nations = [];
let editingIndex = null; // null = creating new tank
let sortField = null; // current column id for sorting
let sortAsc = true; // true = ascending, false = descending
let filterText = ''; // free-text filter applied to all fields
let filterNation = ''; // nation name to filter by

// Field configuration grouped by section to allow dynamic table and form generation.
// Each field defines id, label and input attributes. Range inputs will have their
// current value displayed beside the slider for clarity.
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
      { id: 'barrelLength', label: 'Barrel Length (m)', type: 'range', min: 1, max: 12, step: 0.25 },
      { id: 'mainCannonFireRate', label: 'Main Gun Fire Rate (rpm)', type: 'range', min: 1, max: 60, step: 1 },
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
      { id: 'turretHeight', label: 'Turret Height (m)', type: 'range', min: 0.25, max: 2, step: 0.25 },
      { id: 'turretXPercent', label: 'Turret X Position (%)', type: 'range', min: 0, max: 100, step: 1 },
      { id: 'turretYPercent', label: 'Turret Y Position (%)', type: 'range', min: 0, max: 100, step: 1 }
    ]
  }
];

// Flattened list of fields for easier iteration.
const ALL_FIELDS = FORM_SECTIONS.flatMap(sec => sec.fields);

// ---------- Table Construction ----------

function buildTableHeader() {
  const thead = document.getElementById('tankTableHead');
  thead.innerHTML = '';
  const tr = document.createElement('tr');
  const thumb = document.createElement('th');
  thumb.textContent = 'Thumb';
  tr.appendChild(thumb);
  ALL_FIELDS.forEach(f => {
    const th = document.createElement('th');
    th.textContent = f.label;
    if (sortField === f.id) th.textContent += sortAsc ? ' \u25B2' : ' \u25BC';
    th.dataset.field = f.id;
    th.addEventListener('click', () => {
      if (sortField === f.id) {
        sortAsc = !sortAsc;
      } else {
        sortField = f.id;
        sortAsc = true;
      }
      renderTable();
    });
    tr.appendChild(th);
  });
  const actions = document.createElement('th');
  actions.textContent = 'Actions';
  tr.appendChild(actions);
  thead.appendChild(tr);
}

function renderTable() {
  buildTableHeader();
  const tbody = document.getElementById('tankTableBody');
  tbody.innerHTML = '';
  let rows = [...tanks];
  if (filterText) {
    const q = filterText.toLowerCase();
    rows = rows.filter(t =>
      Object.values(t).some(v => {
        const val = Array.isArray(v) ? v.join(' ') : String(v);
        return val.toLowerCase().includes(q);
      })
    );
  }
  if (filterNation) rows = rows.filter(t => t.nation === filterNation);
  if (sortField) {
    rows.sort((a, b) => {
      const av = a[sortField];
      const bv = b[sortField];
      if (typeof av === 'number' && typeof bv === 'number') {
        return (av - bv) * (sortAsc ? 1 : -1);
      }
      return String(av).localeCompare(String(bv)) * (sortAsc ? 1 : -1);
    });
  }
  rows.forEach(t => {
    const i = tanks.indexOf(t);
    const tr = document.createElement('tr');
    const thumbCell = document.createElement('td');
    const canvas = document.createElement('canvas');
    canvas.width = 60; canvas.height = 30;
    drawTank(canvas, t);
    thumbCell.appendChild(canvas);
    tr.appendChild(thumbCell);
    ALL_FIELDS.forEach(f => {
      const td = document.createElement('td');
      const val = t[f.id];
      td.textContent = Array.isArray(val) ? val.join(', ') : val;
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

// ---------- Editing Helpers ----------

function emptyTank() {
  const t = {};
  FORM_SECTIONS.forEach(sec => {
    sec.fields.forEach(f => {
      if (f.type === 'range') {
        t[f.id] = (Number(f.min) + Number(f.max)) / 2;
      } else if (f.type === 'select') {
        const opts = typeof f.options === 'function' ? f.options() : f.options;
        t[f.id] = opts[0] ?? '';
      } else if (f.type === 'checkbox') {
        t[f.id] = [];
      } else {
        t[f.id] = '';
      }
    });
  });
  return t;
}

function startEdit(i) {
  cancelEdit();
  editingIndex = i;
  const tank = i === null ? emptyTank() : tanks[i];
  const tbody = document.getElementById('tankTableBody');
  const editorRow = document.createElement('tr');
  editorRow.className = 'editor-row';
  const td = document.createElement('td');
  td.colSpan = ALL_FIELDS.length + 2; // thumb + fields + actions
  const form = document.createElement('form');

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
        input.value = tank[f.id];
      } else if (f.type === 'checkbox') {
        input = document.createElement('div');
        f.options.forEach(opt => {
          const cbLabel = document.createElement('label');
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.value = opt;
          cb.checked = tank[f.id].includes(opt);
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
        input.value = tank[f.id];
        if (f.type === 'range') {
          const span = document.createElement('span');
          span.id = f.id + 'Val';
          span.textContent = tank[f.id];
          input.addEventListener('input', () => span.textContent = input.value);
          label.appendChild(input);
          label.appendChild(span);
          fs.appendChild(label);
          return;
        }
      }
      input.id = f.id;
      label.appendChild(input);
      fs.appendChild(label);
    });
    form.appendChild(fs);
  });

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.textContent = 'Save';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', cancelEdit);
  form.appendChild(saveBtn);
  form.appendChild(cancelBtn);
  form.addEventListener('submit', saveEdit);

  td.appendChild(form);
  editorRow.appendChild(td);

  if (i === null) {
    tbody.appendChild(editorRow);
  } else {
    const rows = tbody.querySelectorAll('tr');
    rows[i].after(editorRow);
  }
}

function cancelEdit() {
  const row = document.querySelector('.editor-row');
  if (row) row.remove();
  editingIndex = null;
}

function gatherFormData(form) {
  const t = {};
  FORM_SECTIONS.forEach(sec => {
    sec.fields.forEach(f => {
      const el = form.querySelector('#' + f.id);
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

async function saveEdit(e) {
  e.preventDefault();
  const form = e.target;
  const data = gatherFormData(form);
  const method = editingIndex === null ? 'POST' : 'PUT';
  const url = editingIndex === null ? '/api/tanks' : `/api/tanks/${editingIndex}`;
  await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(data)
  });
  await loadData();
  cancelEdit();
}

// ---------- CRUD + Rendering ----------

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
  const tx = bx + (tank.turretXPercent ?? 50) / 100 * bl - tl / 2;
  const ty = by + (tank.turretYPercent ?? 50) / 100 * bw - tw / 2;
  ctx.fillStyle = '#999';
  ctx.fillRect(tx, ty, tl, tw);
}

async function deleteTank(i) {
  cancelEdit();
  await fetch(`/api/tanks/${i}`, { method: 'DELETE', credentials: 'include' });
  await loadData();
}

async function loadData() {
  const [nRes, tRes] = await Promise.all([
    fetch('/api/nations', { credentials: 'include' }),
    fetch('/api/tanks', { credentials: 'include' })
  ]);
  nations = await nRes.json();
  tanks = await tRes.json();
  const nf = document.getElementById('nationFilter');
  nf.innerHTML = '<option value="">All Nations</option>';
  nations.forEach(n => {
    const o = document.createElement('option');
    o.value = n.name;
    o.textContent = n.name;
    nf.appendChild(o);
  });
  renderTable();
}

function init() {
  document.getElementById('addTankBtn').addEventListener('click', () => startEdit(null));
  document.getElementById('filterInput').addEventListener('input', e => {
    filterText = e.target.value;
    renderTable();
  });
  document.getElementById('nationFilter').addEventListener('change', e => {
    filterNation = e.target.value;
    renderTable();
  });
  loadData();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}


// hud.js
// Summary: Provides an on-screen heads-up display showing current speed, inclination,
//          health and currently selected ammunition with remaining rounds, alongside a
//          center-screen crosshair for aiming.
// Structure: initHUD() creates overlay elements; updateHUD() refreshes tank metrics;
//            updateAmmoHUD() renders ammo counts and highlights the active selection;
//            showCrosshair() toggles the crosshair visibility.
// Usage: Import { initHUD, updateHUD, updateAmmoHUD, showCrosshair } and call initHUD once
//        during startup. Call updateHUD(speed, incline, health) each frame, updateAmmoHUD()
//        whenever ammo counts change and showCrosshair(true) when gameplay starts.
// ---------------------------------------------------------------------------
let speedEl, inclineEl, healthEl, ammoHudEl, crosshairEl;

/**
 * Initialize HUD elements and add them to the document body.
 */
export function initHUD() {
  const hud = document.createElement('div');
  hud.id = 'hud';
  speedEl = document.createElement('div');
  inclineEl = document.createElement('div');
  healthEl = document.createElement('div');
  hud.appendChild(speedEl);
  hud.appendChild(inclineEl);
  hud.appendChild(healthEl);
  document.body.appendChild(hud);

  // Create crosshair overlay but keep it hidden until gameplay starts
  crosshairEl = document.createElement('div');
  crosshairEl.id = 'crosshair';
  crosshairEl.innerHTML =
    '<div class="line horizontal"></div><div class="line vertical"></div>';
  crosshairEl.style.display = 'none';
  document.body.appendChild(crosshairEl);

  // Ammo display, hidden until the player joins a match
  ammoHudEl = document.createElement('div');
  ammoHudEl.id = 'ammoHud';
  ammoHudEl.style.display = 'none';
  document.body.appendChild(ammoHudEl);

  updateHUD(0, 0, 100);
}

/**
 * Update HUD with current speed (km/h) and inclination (degrees).
 * @param {number} speedKmh - Current tank speed in km/h.
 * @param {number} inclinationDeg - Tank pitch relative to the ground.
 */
export function updateHUD(speedKmh, inclinationDeg, health = 100) {
  if (!speedEl || !inclineEl || !healthEl) return;
  speedEl.textContent = `Speed: ${speedKmh.toFixed(1)} km/h`;
  inclineEl.textContent = `Inclination: ${inclinationDeg.toFixed(1)}°`;
  healthEl.textContent = `Health: ${health.toFixed(0)}`;
}

/**
 * Render ammo counts and highlight the currently selected type.
 * @param {Array<{name:string,count:number}>} ammoList - Available ammo and remaining rounds.
 * @param {string} selected - Name of the currently selected ammo type.
 */
export function updateAmmoHUD(ammoList, selected = '') {
  if (!ammoHudEl) return;
  ammoHudEl.innerHTML = '';
  ammoList.forEach(({ name, count }) => {
    const span = document.createElement('span');
    span.textContent = `${name}: ${count}`;
    if (name === selected) span.classList.add('selected');
    ammoHudEl.appendChild(span);
  });
  ammoHudEl.style.display = ammoList.length ? 'flex' : 'none';
}

/**
 * Toggle crosshair visibility. Hidden by default so lobby screens stay clean.
 * @param {boolean} show - true to display the crosshair, false to hide.
 */
export function showCrosshair(show) {
  if (crosshairEl) crosshairEl.style.display = show ? 'block' : 'none';
}

// hud.js
// Summary: Provides an on-screen heads-up display showing current speed, inclination and health.
// Structure: initHUD() creates overlay elements; updateHUD() updates the displayed values.
// Usage: Import { initHUD, updateHUD } and call initHUD once during startup,
//        then call updateHUD(speed, incline, health) each frame.
// ---------------------------------------------------------------------------
let speedEl, inclineEl, healthEl;

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

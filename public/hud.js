// hud.js
// Summary: Provides an on-screen heads-up display showing current speed, inclination and health
//          along with a center-screen crosshair for aiming.
// Structure: initHUD() creates overlay elements; updateHUD() updates the displayed values;
//            showCrosshair() toggles the crosshair visibility.
// Usage: Import { initHUD, updateHUD, showCrosshair } and call initHUD once during startup,
//        then call updateHUD(speed, incline, health) each frame and showCrosshair(true)
//        when the player enters the game.
// ---------------------------------------------------------------------------
let speedEl, inclineEl, healthEl, crosshairEl;

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
 * Toggle crosshair visibility. Hidden by default so lobby screens stay clean.
 * @param {boolean} show - true to display the crosshair, false to hide.
 */
export function showCrosshair(show) {
  if (crosshairEl) crosshairEl.style.display = show ? 'block' : 'none';
}

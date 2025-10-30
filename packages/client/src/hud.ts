// hud.ts
// Summary: Provides an on-screen heads-up display showing current speed, inclination,
//          health and currently selected ammunition with remaining rounds, alongside a
//          center-screen crosshair and a reload progress indicator for the active shell type.
// Structure: initHUD() creates overlay elements; updateHUD() refreshes tank metrics;
//            updateAmmoHUD() renders ammo counts and highlights the active selection;
//            updateCooldownHUD() animates the reload bar; showCrosshair() toggles visibility.
// Usage: Import { initHUD, updateHUD, updateAmmoHUD, updateCooldownHUD, showCrosshair } and call initHUD once
//        during startup. Call updateHUD(speed, incline, health) each frame, updateAmmoHUD()
//        whenever ammo counts change, updateCooldownHUD(remaining, total) after firing and
//        showCrosshair(true) when gameplay starts.
// ---------------------------------------------------------------------------
let speedEl: HTMLDivElement | null;
let inclineEl: HTMLDivElement | null;
let healthEl: HTMLDivElement | null;
let ammoHudEl: HTMLDivElement | null;
let crosshairEl: HTMLDivElement | null;
let ammoSlotsEl: HTMLDivElement | null;
let cooldownEl: HTMLDivElement | null;
let cooldownFillEl: HTMLDivElement | null;
let cooldownLabelEl: HTMLSpanElement | null;

/**
 * Initialize HUD elements and add them to the document body.
 */
export function initHUD(): void {
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
  ammoSlotsEl = document.createElement('div');
  ammoSlotsEl.className = 'ammo-slots';
  ammoHudEl.appendChild(ammoSlotsEl);

  cooldownEl = document.createElement('div');
  cooldownEl.className = 'cooldown';
  cooldownEl.style.display = 'none';
  cooldownLabelEl = document.createElement('span');
  cooldownLabelEl.className = 'cooldown-label';
  cooldownEl.appendChild(cooldownLabelEl);
  const bar = document.createElement('div');
  bar.className = 'cooldown-bar';
  cooldownFillEl = document.createElement('div');
  cooldownFillEl.className = 'cooldown-fill';
  bar.appendChild(cooldownFillEl);
  cooldownEl.appendChild(bar);
  ammoHudEl.appendChild(cooldownEl);
  document.body.appendChild(ammoHudEl);

  updateHUD(0, 0, 100);
  updateCooldownHUD(0, 1);
}

/**
 * Update HUD with current speed (km/h) and inclination (degrees).
 * @param {number} speedKmh - Current tank speed in km/h.
 * @param {number} inclinationDeg - Tank pitch relative to the ground.
 */
export function updateHUD(speedKmh: number, inclinationDeg: number, health = 100): void {
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
export function updateAmmoHUD(
  ammoList: Array<{ name: string; count: number }>,
  selected = ''
): void {
  if (!ammoHudEl || !ammoSlotsEl) return;
  ammoSlotsEl.innerHTML = '';
  ammoList.forEach(({ name, count }) => {
    const item = document.createElement('span');
    item.className = 'ammo-item';
    item.textContent = `${name}: ${count}`;
    if (name === selected) item.classList.add('selected');
    ammoSlotsEl.appendChild(item);
  });
  ammoHudEl.style.display = ammoList.length ? 'flex' : 'none';
  if (cooldownEl && ammoList.length === 0) {
    cooldownEl.style.display = 'none';
  }
}

/**
 * Toggle crosshair visibility. Hidden by default so lobby screens stay clean.
 * @param {boolean} show - true to display the crosshair, false to hide.
 */
export function showCrosshair(show: boolean): void {
  if (crosshairEl) crosshairEl.style.display = show ? 'block' : 'none';
}

/**
 * Update the reload cooldown bar for the selected ammunition type.
 * @param {number} remainingSeconds - Seconds until the gun is ready.
 * @param {number} totalSeconds - Total reload time in seconds.
 */
export function updateCooldownHUD(remainingSeconds: number, totalSeconds: number): void {
  if (!cooldownEl || !cooldownFillEl || !cooldownLabelEl) return;
  const total = totalSeconds > 0 ? totalSeconds : 1;
  if (remainingSeconds <= 0.05) {
    cooldownEl.style.display = 'flex';
    cooldownFillEl.style.width = '100%';
    cooldownLabelEl.textContent = 'Ready';
    return;
  }
  cooldownEl.style.display = 'flex';
  const clamped = Math.max(0, Math.min(1, remainingSeconds / total));
  cooldownFillEl.style.width = `${(1 - clamped) * 100}%`;
  cooldownLabelEl.textContent = `Reloading ${remainingSeconds.toFixed(1)}s`;
}

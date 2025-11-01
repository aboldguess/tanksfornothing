// projectile-debug-overlay.ts
// Summary: Renders a fixed HUD panel listing projectile telemetry (distance, impact details,
//          shooter) so QA can verify that shells spawn correctly and strike visible targets.
// Structure: initProjectileDebugOverlay() builds the DOM scaffold; updateProjectileDebugOverlay()
//            renders a provided entry list; helper utilities keep styling consistent.
// Usage: Import { initProjectileDebugOverlay, updateProjectileDebugOverlay } from this module.
//        Call initProjectileDebugOverlay() once during bootstrap, then updateProjectileDebugOverlay()
//        whenever projectile telemetry changes.
// ---------------------------------------------------------------------------

export interface ProjectileDebugOverlayEntry {
  id: string;
  ammoLabel: string;
  shooterLabel: string;
  distanceMetres: number;
  status: string;
  hitSummary: string;
  travelTimeMs: number;
  impactSpeed: number;
  lastUpdated: number;
}

let containerEl: HTMLDivElement | null = null;
let listEl: HTMLDivElement | null = null;
let hintEl: HTMLParagraphElement | null = null;

/**
 * Create the projectile debug overlay container.
 */
export function initProjectileDebugOverlay(): void {
  if (containerEl) return;
  containerEl = document.createElement('aside');
  containerEl.id = 'projectileDebugOverlay';

  const title = document.createElement('h2');
  title.textContent = 'Projectile Telemetry';
  containerEl.appendChild(title);

  hintEl = document.createElement('p');
  hintEl.className = 'projectile-debug-hint';
  hintEl.textContent = 'Fire the cannon to capture live range and impact diagnostics.';
  containerEl.appendChild(hintEl);

  listEl = document.createElement('div');
  listEl.className = 'projectile-debug-list';
  containerEl.appendChild(listEl);

  document.body.appendChild(containerEl);
}

/**
 * Render the latest projectile telemetry in the overlay.
 */
export function updateProjectileDebugOverlay(entries: ProjectileDebugOverlayEntry[]): void {
  if (!listEl || !containerEl || !hintEl) return;
  if (!entries.length) {
    listEl.innerHTML = '';
    hintEl.style.display = 'block';
    return;
  }

  hintEl.style.display = 'none';
  listEl.innerHTML = '';

  const sorted = [...entries].sort((a, b) => b.lastUpdated - a.lastUpdated).slice(0, 6);
  for (const entry of sorted) {
    const row = document.createElement('div');
    row.className = 'projectile-debug-row';

    const headline = document.createElement('div');
    headline.className = 'projectile-debug-headline';
    headline.textContent = `${entry.status} · ${entry.ammoLabel}`;
    row.appendChild(headline);

    const shooter = document.createElement('div');
    shooter.className = 'projectile-debug-line';
    shooter.textContent = `Shooter: ${entry.shooterLabel}`;
    row.appendChild(shooter);

    const distance = document.createElement('div');
    distance.className = 'projectile-debug-line';
    distance.textContent = `Distance: ${entry.distanceMetres.toFixed(1)} m`;
    row.appendChild(distance);

    const travel = document.createElement('div');
    travel.className = 'projectile-debug-line';
    const seconds = entry.travelTimeMs / 1000;
    travel.textContent = `Flight: ${seconds.toFixed(2)} s · Impact: ${entry.impactSpeed.toFixed(1)} m/s`;
    row.appendChild(travel);

    const summary = document.createElement('div');
    summary.className = 'projectile-debug-summary';
    summary.textContent = entry.hitSummary;
    row.appendChild(summary);

    listEl.appendChild(row);
  }
}

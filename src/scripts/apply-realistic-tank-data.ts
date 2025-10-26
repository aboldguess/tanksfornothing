/**
 * Summary: Applies approximate real-world geometry and fire-rate values to tank definitions.
 * Structure: Reads existing data/tanks.json, merges per-tank updates, writes file back with consistent formatting.
 * Usage: npm run build && node dist/scripts/apply-realistic-tank-data.js
 */
import { readFile, writeFile } from 'node:fs/promises';

const projectRoot = new URL('../../', import.meta.url);
const file = new URL('./data/tanks.json', projectRoot);
const data = JSON.parse(await readFile(file, 'utf8'));

const updates = {
  "M2A4": { bodyWidth: 2.23, bodyLength: 4.72, bodyHeight: 2.5, turretWidth: 1.8, turretLength: 2.0, turretHeight: 1.0, barrelLength: 1.9, mainCannonFireRate: 20, turretXPercent: 50, turretYPercent: 50 },
  "M3 Stuart": { bodyWidth: 2.23, bodyLength: 4.66, bodyHeight: 2.31, turretWidth: 1.9, turretLength: 2.1, turretHeight: 1.0, barrelLength: 2.0, mainCannonFireRate: 20, turretXPercent: 50, turretYPercent: 50 },
  "M4A1 Sherman": { bodyWidth: 2.62, bodyLength: 5.85, bodyHeight: 2.74, turretWidth: 2.7, turretLength: 2.8, turretHeight: 1.1, barrelLength: 3.5, mainCannonFireRate: 12, turretXPercent: 45, turretYPercent: 50 },
  "M4A3E2 Jumbo": { bodyWidth: 2.62, bodyLength: 5.96, bodyHeight: 2.74, turretWidth: 2.8, turretLength: 2.9, turretHeight: 1.2, barrelLength: 3.5, mainCannonFireRate: 10, turretXPercent: 45, turretYPercent: 50 },
  "M10 Wolverine": { bodyWidth: 3.05, bodyLength: 5.97, bodyHeight: 2.57, turretWidth: 2.8, turretLength: 3.0, turretHeight: 1.2, barrelLength: 3.8, mainCannonFireRate: 12, turretXPercent: 55, turretYPercent: 50 },
  "M18 Hellcat": { bodyWidth: 2.82, bodyLength: 6.4, bodyHeight: 2.57, turretWidth: 2.6, turretLength: 2.8, turretHeight: 1.1, barrelLength: 3.5, mainCannonFireRate: 12, turretXPercent: 54, turretYPercent: 50 },
  "M26 Pershing": { bodyWidth: 3.51, bodyLength: 6.63, bodyHeight: 2.77, turretWidth: 3.1, turretLength: 3.3, turretHeight: 1.2, barrelLength: 4.6, mainCannonFireRate: 8, turretXPercent: 50, turretYPercent: 50 },
  "M46 Patton": { bodyWidth: 3.51, bodyLength: 6.95, bodyHeight: 3.0, turretWidth: 3.2, turretLength: 3.4, turretHeight: 1.2, barrelLength: 4.6, mainCannonFireRate: 8, turretXPercent: 50, turretYPercent: 50 },
  "M48 Patton": { bodyWidth: 3.63, bodyLength: 6.95, bodyHeight: 3.1, turretWidth: 3.3, turretLength: 3.5, turretHeight: 1.3, barrelLength: 5.0, mainCannonFireRate: 8, turretXPercent: 52, turretYPercent: 50 },
  "M60": { bodyWidth: 3.63, bodyLength: 6.95, bodyHeight: 3.25, turretWidth: 3.4, turretLength: 3.5, turretHeight: 1.3, barrelLength: 5.3, mainCannonFireRate: 8, turretXPercent: 52, turretYPercent: 50 },

  "Panzer II": { bodyWidth: 2.22, bodyLength: 4.81, bodyHeight: 2.0, turretWidth: 1.8, turretLength: 2.0, turretHeight: 1.0, barrelLength: 1.8, mainCannonFireRate: 20, turretXPercent: 55, turretYPercent: 50 },
  "Panzer III": { bodyWidth: 2.95, bodyLength: 5.52, bodyHeight: 2.5, turretWidth: 2.1, turretLength: 2.3, turretHeight: 1.0, barrelLength: 3.0, mainCannonFireRate: 15, turretXPercent: 45, turretYPercent: 50 },
  "Panzer IV": { bodyWidth: 2.88, bodyLength: 5.92, bodyHeight: 2.68, turretWidth: 2.2, turretLength: 2.4, turretHeight: 1.1, barrelLength: 3.6, mainCannonFireRate: 10, turretXPercent: 45, turretYPercent: 50 },
  "Panther A": { bodyWidth: 3.27, bodyLength: 6.87, bodyHeight: 2.99, turretWidth: 3.1, turretLength: 3.2, turretHeight: 1.1, barrelLength: 5.3, mainCannonFireRate: 7, turretXPercent: 48, turretYPercent: 50 },
  "Tiger I": { bodyWidth: 3.56, bodyLength: 6.32, bodyHeight: 3.0, turretWidth: 3.3, turretLength: 3.6, turretHeight: 1.2, barrelLength: 4.9, mainCannonFireRate: 6, turretXPercent: 45, turretYPercent: 50 },
  "Tiger II": { bodyWidth: 3.75, bodyLength: 7.38, bodyHeight: 3.09, turretWidth: 3.6, turretLength: 3.8, turretHeight: 1.3, barrelLength: 6.4, mainCannonFireRate: 6, turretXPercent: 50, turretYPercent: 50 },
  "Jagdpanzer IV": { bodyWidth: 3.17, bodyLength: 6.7, bodyHeight: 2.0, turretWidth: 3.0, turretLength: 3.5, turretHeight: 1.4, barrelLength: 3.8, mainCannonFireRate: 10, turretXPercent: 60, turretYPercent: 50 },
  "Jagdtiger": { bodyWidth: 3.59, bodyLength: 7.4, bodyHeight: 2.95, turretWidth: 3.5, turretLength: 4.0, turretHeight: 1.5, barrelLength: 7.0, mainCannonFireRate: 4, turretXPercent: 60, turretYPercent: 50 },
  "Leopard 1": { bodyWidth: 3.25, bodyLength: 7.09, bodyHeight: 2.4, turretWidth: 2.9, turretLength: 3.1, turretHeight: 1.0, barrelLength: 5.3, mainCannonFireRate: 10, turretXPercent: 50, turretYPercent: 50 },
  "Leopard 2A4": { bodyWidth: 3.74, bodyLength: 7.7, bodyHeight: 3.0, turretWidth: 3.5, turretLength: 3.6, turretHeight: 1.2, barrelLength: 5.3, mainCannonFireRate: 9, turretXPercent: 50, turretYPercent: 50 },

  "T-26": { bodyWidth: 2.44, bodyLength: 4.62, bodyHeight: 2.4, turretWidth: 2.0, turretLength: 2.3, turretHeight: 1.0, barrelLength: 2.1, mainCannonFireRate: 15, turretXPercent: 45, turretYPercent: 50 },
  "BT-7": { bodyWidth: 2.29, bodyLength: 5.66, bodyHeight: 2.42, turretWidth: 2.1, turretLength: 2.3, turretHeight: 1.0, barrelLength: 2.8, mainCannonFireRate: 15, turretXPercent: 50, turretYPercent: 50 },
  "T-34": { bodyWidth: 3.0, bodyLength: 6.68, bodyHeight: 2.45, turretWidth: 2.5, turretLength: 2.6, turretHeight: 1.0, barrelLength: 3.3, mainCannonFireRate: 10, turretXPercent: 47, turretYPercent: 50 },
  "KV-1": { bodyWidth: 3.32, bodyLength: 6.75, bodyHeight: 2.7, turretWidth: 3.2, turretLength: 3.3, turretHeight: 1.3, barrelLength: 3.2, mainCannonFireRate: 6, turretXPercent: 50, turretYPercent: 50 },
  "IS-1": { bodyWidth: 3.07, bodyLength: 6.68, bodyHeight: 2.73, turretWidth: 2.9, turretLength: 3.0, turretHeight: 1.3, barrelLength: 4.5, mainCannonFireRate: 7, turretXPercent: 46, turretYPercent: 50 },
  "IS-2": { bodyWidth: 3.09, bodyLength: 6.79, bodyHeight: 2.73, turretWidth: 3.2, turretLength: 3.3, turretHeight: 1.4, barrelLength: 5.6, mainCannonFireRate: 5, turretXPercent: 46, turretYPercent: 50 },
  "SU-85": { bodyWidth: 2.9, bodyLength: 6.1, bodyHeight: 2.45, turretWidth: 3.0, turretLength: 3.3, turretHeight: 1.3, barrelLength: 3.9, mainCannonFireRate: 10, turretXPercent: 60, turretYPercent: 50 },
  "SU-152": { bodyWidth: 3.25, bodyLength: 6.95, bodyHeight: 2.45, turretWidth: 3.2, turretLength: 3.5, turretHeight: 1.6, barrelLength: 5.1, mainCannonFireRate: 4, turretXPercent: 60, turretYPercent: 50 },
  "T-54": { bodyWidth: 3.27, bodyLength: 6.45, bodyHeight: 2.39, turretWidth: 2.8, turretLength: 3.2, turretHeight: 1.3, barrelLength: 5.0, mainCannonFireRate: 8, turretXPercent: 48, turretYPercent: 50 },
  "T-62": { bodyWidth: 3.3, bodyLength: 6.7, bodyHeight: 2.4, turretWidth: 2.9, turretLength: 3.3, turretHeight: 1.2, barrelLength: 5.3, mainCannonFireRate: 6, turretXPercent: 50, turretYPercent: 50 },

  "A13 Cruiser": { bodyWidth: 2.64, bodyLength: 5.49, bodyHeight: 2.24, turretWidth: 2.0, turretLength: 2.2, turretHeight: 1.0, barrelLength: 2.3, mainCannonFireRate: 15, turretXPercent: 50, turretYPercent: 50 },
  "Matilda II": { bodyWidth: 2.49, bodyLength: 5.61, bodyHeight: 2.51, turretWidth: 2.1, turretLength: 2.3, turretHeight: 1.1, barrelLength: 2.0, mainCannonFireRate: 15, turretXPercent: 46, turretYPercent: 50 },
  "Churchill III": { bodyWidth: 3.25, bodyLength: 7.44, bodyHeight: 2.49, turretWidth: 2.7, turretLength: 3.0, turretHeight: 1.2, barrelLength: 2.6, mainCannonFireRate: 10, turretXPercent: 42, turretYPercent: 50 },
  "Cromwell": { bodyWidth: 2.91, bodyLength: 6.35, bodyHeight: 2.49, turretWidth: 2.5, turretLength: 2.8, turretHeight: 1.1, barrelLength: 3.0, mainCannonFireRate: 10, turretXPercent: 45, turretYPercent: 50 },
  "Comet": { bodyWidth: 3.05, bodyLength: 6.57, bodyHeight: 2.68, turretWidth: 2.6, turretLength: 2.9, turretHeight: 1.1, barrelLength: 4.2, mainCannonFireRate: 10, turretXPercent: 45, turretYPercent: 50 },
  "Centurion Mk 3": { bodyWidth: 3.4, bodyLength: 7.6, bodyHeight: 3.0, turretWidth: 3.1, turretLength: 3.4, turretHeight: 1.3, barrelLength: 6.5, mainCannonFireRate: 8, turretXPercent: 50, turretYPercent: 50 },
  "FV4202": { bodyWidth: 3.4, bodyLength: 7.8, bodyHeight: 2.7, turretWidth: 3.0, turretLength: 3.3, turretHeight: 1.2, barrelLength: 6.0, mainCannonFireRate: 8, turretXPercent: 50, turretYPercent: 50 },
  "Chieftain Mk 3": { bodyWidth: 3.5, bodyLength: 7.66, bodyHeight: 2.9, turretWidth: 3.5, turretLength: 3.9, turretHeight: 1.3, barrelLength: 7.5, mainCannonFireRate: 7, turretXPercent: 50, turretYPercent: 50 },
  "Challenger 1": { bodyWidth: 3.5, bodyLength: 8.32, bodyHeight: 2.95, turretWidth: 3.5, turretLength: 3.9, turretHeight: 1.4, barrelLength: 7.0, mainCannonFireRate: 7, turretXPercent: 50, turretYPercent: 50 },
  "Challenger 2": { bodyWidth: 3.52, bodyLength: 8.3, bodyHeight: 2.79, turretWidth: 3.5, turretLength: 3.9, turretHeight: 1.4, barrelLength: 6.6, mainCannonFireRate: 7, turretXPercent: 50, turretYPercent: 50 },

  "Ha-Go": { bodyWidth: 2.06, bodyLength: 4.38, bodyHeight: 2.21, turretWidth: 1.6, turretLength: 1.8, turretHeight: 1.0, barrelLength: 1.6, mainCannonFireRate: 20, turretXPercent: 50, turretYPercent: 50 },
  "Chi-Ha": { bodyWidth: 2.33, bodyLength: 5.52, bodyHeight: 2.23, turretWidth: 2.0, turretLength: 2.2, turretHeight: 1.0, barrelLength: 2.4, mainCannonFireRate: 15, turretXPercent: 50, turretYPercent: 50 },
  "Chi-Nu": { bodyWidth: 2.5, bodyLength: 5.5, bodyHeight: 2.5, turretWidth: 2.2, turretLength: 2.4, turretHeight: 1.1, barrelLength: 3.2, mainCannonFireRate: 10, turretXPercent: 50, turretYPercent: 50 },
  "Chi-To": { bodyWidth: 2.87, bodyLength: 6.08, bodyHeight: 2.77, turretWidth: 2.6, turretLength: 2.7, turretHeight: 1.1, barrelLength: 4.3, mainCannonFireRate: 10, turretXPercent: 50, turretYPercent: 50 },
  "Chi-Ri": { bodyWidth: 2.8, bodyLength: 6.3, bodyHeight: 2.8, turretWidth: 2.8, turretLength: 3.0, turretHeight: 1.2, barrelLength: 4.9, mainCannonFireRate: 10, turretXPercent: 50, turretYPercent: 50 },
  "Ho-Ni III": { bodyWidth: 2.5, bodyLength: 5.5, bodyHeight: 2.4, turretWidth: 2.5, turretLength: 2.7, turretHeight: 1.2, barrelLength: 4.2, mainCannonFireRate: 8, turretXPercent: 60, turretYPercent: 50 },
  "Type 61": { bodyWidth: 2.95, bodyLength: 6.03, bodyHeight: 2.5, turretWidth: 2.7, turretLength: 3.0, turretHeight: 1.2, barrelLength: 5.5, mainCannonFireRate: 8, turretXPercent: 50, turretYPercent: 50 },
  "Type 74": { bodyWidth: 3.18, bodyLength: 7.4, bodyHeight: 2.25, turretWidth: 2.8, turretLength: 3.2, turretHeight: 1.2, barrelLength: 5.3, mainCannonFireRate: 9, turretXPercent: 50, turretYPercent: 50 },
  "Type 90": { bodyWidth: 3.43, bodyLength: 7.59, bodyHeight: 2.37, turretWidth: 3.0, turretLength: 3.4, turretHeight: 1.3, barrelLength: 5.3, mainCannonFireRate: 9, turretXPercent: 50, turretYPercent: 50 },
  "Type 10": { bodyWidth: 3.24, bodyLength: 7.5, bodyHeight: 2.3, turretWidth: 3.0, turretLength: 3.4, turretHeight: 1.3, barrelLength: 5.2, mainCannonFireRate: 10, turretXPercent: 50, turretYPercent: 50 }
};

for (const tank of data.tanks) {
  const patch = updates[tank.name];
  if (patch) Object.assign(tank, patch);
}

await writeFile(file, JSON.stringify(data, null, 2));
console.log('Updated data/tanks.json with realistic parameters.');

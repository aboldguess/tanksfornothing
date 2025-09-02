# Tanks for Nothing

A minimal browser-based multiplayer tank demo built with Node.js, Express, Socket.IO and Three.js. Tanks are rendered as simple blocks with basic movement and turret controls.

## Features
- WASD driving, Space brake, mouse-look turret control
- Hold `C` for freelook, `V` to toggle first/third person
- Mouse wheel zoom
- Modern admin dashboard with CRUD for nations, tanks, ammo, terrain and maps plus live statistics
- Shells drop under gravity with per-ammo velocity settings
- Secure player accounts with signup/login and persistent tracking of games, kills and deaths
- Adjustable third-person camera height and distance via Game Settings page

## Requirements
- Node.js 18+ and npm

## Setup
Run these commands from a terminal (PowerShell on Windows):

### Linux / macOS / Raspberry Pi
```bash
cd tanksfornothing
npm install
npm run setup   # create data files
npm start
```

### Windows
```powershell
cd tanksfornothing
npm install
npm run setup   # create data files
npm start
```

The server listens on port **3000** by default. Use the `PORT` environment variable to change it:
```bash
PORT=8080 npm start
```
Set `NODE_ENV=production` when deploying to enable secure cookies.

Set `ADMIN_PASSWORD` to change the admin login password (default `adminpass`).
Set `JWT_SECRET` to a long random string to sign authentication tokens.

### Updating tank data from War Thunder

Run `npm run import-wt` to pull ground vehicle definitions from the public War
Thunder encyclopedia API and write them to `data/tanks.json`. If your network
requires a proxy, export `HTTPS_PROXY` (or `HTTP_PROXY`) before running the
import:

```bash
# Linux / macOS / Raspberry Pi
HTTPS_PROXY=http://proxy.example.com:3128 npm run import-wt

# Windows PowerShell
$env:HTTPS_PROXY='http://proxy.example.com:3128'
npm run import-wt
```

The script reports connection issues and proxy usage to aid debugging.

## Usage
 - Create an account at `http://localhost:3000/signup.html` then log in via `http://localhost:3000/login.html`.
 - Open `http://localhost:3000` in a modern browser after logging in to join the battle.
 - Click the screen to capture the mouse and drive the tank.
- Visit `http://localhost:3000/admin/admin.html` for the admin dashboard. A sidebar links to dedicated pages for Nations, Tanks, Ammo, Terrain, Map CRUD and Game Settings. The Game Settings page exposes sliders for default camera distance and height. Manage nations, then create tanks and ammo tied to those nations. The tank form provides class dropdowns, a BR slider, separate chassis and turret armor sliders, a cannon caliber slider, an ammo capacity slider, checkboxes for HE/HEAT/AP/Smoke ammo types, crew and engine horsepower sliders, separate sliders for maximum forward and reverse speeds, and controls for incline and rotation times. The ammo form captures name, nation, caliber, armor penetration, type, explosion radius and penetration at 0m/100m. Data persists across restarts.

### Tank geometry and turret limits
The tank editor now includes additional sliders for turret elevation limits and chassis/turret dimensions. Configure:

- Max Turret Incline / Decline (0–50° / 0–25°)
- Body Width, Length and Height (1–5m / 1–10m / 1–3m)
- Turret Width, Length and Height (1–3m / 1–5m / 0.25–2m)

## Debugging
The server logs player connections and updates to the console. Use `npm run dev` to auto-restart on changes.

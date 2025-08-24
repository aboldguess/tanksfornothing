# Tanks for Nothing

A minimal browser-based multiplayer tank demo built with Node.js, Express, Socket.IO and Three.js. Tanks are rendered as simple blocks with basic movement and turret controls.

## Features
- WASD driving, mouse-look turret control
- Hold `C` for freelook, `V` to toggle first/third person
- Mouse wheel zoom
- Minimal admin panel for CRUD of tanks, ammo, terrain

## Requirements
- Node.js 18+ and npm

## Setup
### Linux / macOS / Raspberry Pi
```bash
cd tanksfornothing
npm install
npm start
```

### Windows
```powershell
cd tanksfornothing
npm install
npm start
```

The server listens on port **3000** by default. Use the `PORT` environment variable to change it:
```bash
PORT=8080 npm start
```

Set `ADMIN_PASSWORD` to change the admin login password (default `adminpass`).

## Usage
- Open `http://localhost:3000` in a modern browser.
- Click the screen to capture the mouse and drive the tank.
- Visit `http://localhost:3000/admin/admin.html` for the admin panel.

## Debugging
The server logs player connections and updates to the console. Use `npm run dev` to auto-restart on changes.

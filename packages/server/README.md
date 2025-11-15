# Tanks for Nothing Server Workspace

This workspace encapsulates the physics and authoritative server systems for Tanks for Nothing. It exposes a compiled
`dist/game/server-world.js` module that the legacy Node.js entry point imports. Run the following to set it up:

## Installation

### Linux / macOS / Raspberry Pi
```bash
cd packages/server
npm install
npm run build
```

### Windows
```powershell
cd packages/server
npm install
npm run build
```

The TypeScript sources live under `src/` and emit compiled artifacts into `dist/`. Regenerate the build whenever you
change source files. The physics world relies on the `cannon-es` library.

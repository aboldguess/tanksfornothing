// index.ts
// Summary: Public entry point for the shared workspace, re-exporting reusable math and terrain helpers.
// Structure: Named exports for terrain-noise utilities to support both client and server packages.
// Usage: import { generateGentleHills } from '@tanksfornothing/shared';
// ---------------------------------------------------------------------------

export { generateGentleHills } from './terrain-noise.js';
export {
  PlayerStateSchema,
  ProjectileStateSchema,
  TanksForNothingState,
  GAME_COMMAND,
  GAME_EVENT,
  type GameCommand,
  type GameEvent,
  type AmmoLoadout
} from './schema.js';

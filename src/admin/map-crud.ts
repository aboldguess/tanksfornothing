// map-crud.ts
// @ts-nocheck
// Summary: Wires the Map CRUD UI, enabling opening and cancellation of the map editor and emitting
//          debug info.
// Structure: DOMContentLoaded listener -> add/cancel handlers -> debug logging.
// Usage: Imported by map-crud.html; click "Add Map" to open the editor or "Cancel" to close.

'use strict';

console.debug('map-crud.js loaded');

document.addEventListener('DOMContentLoaded', () => {
  const add = document.getElementById('newTerrainBtn');
  if (add) {
    add.addEventListener('click', () => {
      // Ensure form starts clean, then reveal editor and notify listeners
      if (typeof window.clearTerrainForm === 'function') {
        window.clearTerrainForm();
      }
      const card = document.getElementById('editorCard');
      if (card) card.style.display = 'flex';
      document.dispatchEvent(new Event('terrain-editor-opened'));
      console.debug('Map editor opened');
    });
  }

  const cancel = document.getElementById('cancelTerrainBtn');
  if (cancel) {
    cancel.addEventListener('click', () => {
      // clearTerrainForm is exposed by admin.js
      if (typeof window.clearTerrainForm === 'function') {
        window.clearTerrainForm();
      }
      const card = document.getElementById('editorCard');
      if (card) card.style.display = 'none';
      console.debug('Map editor cancelled');
    });
  }
});

// map-crud.js
// Summary: Wires improved Map CRUD UI, offering a cancel button and debug hooks for the editor.
// Structure: DOMContentLoaded listener -> cancel handler -> debug logging.
// Usage: Imported by map-crud.html to enhance terrain editor workflow.

'use strict';

console.debug('map-crud.js loaded');

document.addEventListener('DOMContentLoaded', () => {
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

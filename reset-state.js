/**
 * One-time state reset for purpose-driven buildings migration.
 *
 * - Clears customLocations
 * - Moves all bots to central-square
 * - Initializes locations, publicLogs, emptyTicks for new predefined locations
 * - Removes old locations (workshop, custom locations)
 * - Keeps memories, agendas, governance history intact
 *
 * Usage: node reset-state.js
 */

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const STATE_FILE = 'state-social-village.json';
const BACKUP_FILE = `${STATE_FILE}.pre-reset.bak`;

const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));

// Backup
copyFileSync(STATE_FILE, BACKUP_FILE);
console.log(`Backed up to ${BACKUP_FILE}`);

// Collect all bots from all locations
const allBots = new Set();
for (const bots of Object.values(state.locations)) {
  for (const b of bots) allBots.add(b);
}
console.log(`Found ${allBots.size} bots:`, [...allBots]);

// New predefined locations
const NEW_LOCATIONS = ['central-square', 'town-hall', 'library', 'temple', 'prison'];

// Reset locations — all bots go to central-square
state.locations = {};
for (const loc of NEW_LOCATIONS) {
  state.locations[loc] = [];
}
state.locations['central-square'] = [...allBots];

// Clear custom locations
state.customLocations = {};

// Reset publicLogs
state.publicLogs = {};
for (const loc of NEW_LOCATIONS) {
  state.publicLogs[loc] = [];
}

// Reset emptyTicks
state.emptyTicks = {};
for (const loc of NEW_LOCATIONS) {
  state.emptyTicks[loc] = 0;
}

// Clear location-specific state for deleted locations
if (state.locationState) {
  const newLocationState = {};
  for (const loc of NEW_LOCATIONS) {
    if (state.locationState[loc]) {
      newLocationState[loc] = state.locationState[loc];
    }
  }
  state.locationState = newLocationState;
}

writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
console.log('State reset complete.');
console.log('New locations:', Object.keys(state.locations));
console.log('Bots at central-square:', state.locations['central-square']);
console.log('\nRestart the village server to apply changes.');

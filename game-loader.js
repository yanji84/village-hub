/**
 * Game schema loader — reads a JSON game definition and builds derived
 * lookup maps consumed by logic.js, scene.js, and server.js.
 *
 * Pure function, no side effects — easily testable.
 */

import { readFileSync } from 'node:fs';

/**
 * Load and validate a game schema from a JSON file.
 *
 * @param {string} filePath - Absolute path to the game JSON file
 * @returns {object} gameConfig with raw schema + derived lookup maps
 * @throws {Error} on missing file, invalid JSON, or schema validation failure
 */
export function loadGame(filePath) {
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'));

  validate(raw, filePath);

  const locationSlugs = Object.keys(raw.locations);
  const locationNames = {};
  const locationFlavors = {};
  for (const [slug, loc] of Object.entries(raw.locations)) {
    locationNames[slug] = loc.name;
    locationFlavors[slug] = loc.flavor;
  }

  const phases = Object.keys(raw.phases);
  const phaseDescriptions = {};
  for (const [phase, cfg] of Object.entries(raw.phases)) {
    phaseDescriptions[phase] = cfg.description;
  }

  const emotionKeys = Object.keys(raw.emotions);

  return {
    raw,
    locationSlugs,
    locationNames,
    locationFlavors,
    spawnLocation: raw.spawnLocation,
    phases,
    phaseDescriptions,
    timezone: raw.timezone,
    events: raw.events,
    eventConfig: raw.eventConfig,
    spice: raw.spice,
    spiceConfig: raw.spiceConfig,
    emotions: raw.emotions,
    emotionKeys,
    emotionConfig: raw.emotionConfig,
    relationships: raw.relationships,
    tools: raw.tools,
    sceneLabels: raw.sceneLabels,
  };
}

/**
 * Validate required fields and cross-references in the game schema.
 */
function validate(raw, filePath) {
  const required = ['id', 'locations', 'spawnLocation', 'phases', 'events', 'eventConfig',
    'spice', 'spiceConfig', 'emotions', 'emotionConfig', 'relationships', 'tools', 'sceneLabels'];

  for (const field of required) {
    if (raw[field] === undefined || raw[field] === null) {
      throw new Error(`Game schema ${filePath}: missing required field "${field}"`);
    }
  }

  const locationSlugs = Object.keys(raw.locations);
  if (locationSlugs.length === 0) {
    throw new Error(`Game schema ${filePath}: "locations" must have at least one entry`);
  }

  if (!locationSlugs.includes(raw.spawnLocation)) {
    throw new Error(`Game schema ${filePath}: "spawnLocation" "${raw.spawnLocation}" is not a valid location key`);
  }

  // Validate event location references
  for (let i = 0; i < raw.events.length; i++) {
    const ev = raw.events[i];
    if (ev.locations) {
      for (const loc of ev.locations) {
        if (!locationSlugs.includes(loc)) {
          throw new Error(`Game schema ${filePath}: events[${i}].locations contains unknown location "${loc}"`);
        }
      }
    }
  }

  // Validate phases have descriptions
  for (const [phase, cfg] of Object.entries(raw.phases)) {
    if (!cfg.description) {
      throw new Error(`Game schema ${filePath}: phases.${phase} missing "description"`);
    }
  }

  // Validate emotions have labels
  for (const [emo, cfg] of Object.entries(raw.emotions)) {
    if (cfg.label === undefined) {
      throw new Error(`Game schema ${filePath}: emotions.${emo} missing "label"`);
    }
  }
}

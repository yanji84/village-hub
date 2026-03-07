/**
 * Shared utilities — deduplicates helpers used across multiple modules.
 */

/**
 * Seeded PRNG (mulberry32).
 */
export function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simple string hash (djb2 variant).
 */
export function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * Simple template renderer — replaces {key} placeholders in a string.
 */
export function renderTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] !== undefined ? vars[key] : `{${key}}`);
}

/**
 * Append a labeled section to lines if items is non-empty.
 * Adds blank line before header, renders each item.
 */
export function addSection(lines, header, items, renderItem) {
  if (!items || items.length === 0) return;
  lines.push('');
  lines.push(header);
  for (const item of items) lines.push(renderItem(item));
}

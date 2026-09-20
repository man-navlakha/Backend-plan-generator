const fs = require('fs');
const path = require('path');
const formatIndex = require('../assets/formats/format_index.json');
const { mergeRules } = require('./merge');

const RULES_DIR = path.join(__dirname, '..', 'assets', 'rules');

const cache = new Map();

/** Read one rules file. Throws loudly — a missing or malformed rules file is a startup bug. */
function readRuleFile(key) {
  const file = path.join(RULES_DIR, `${key}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Rules file not found: ${key}.json`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Rules file ${key}.json is not valid JSON: ${error.message}`);
  }
}

/**
 * Walk the `extends` chain to its root, then merge back down so the most
 * specific file wins. `transit_bus` -> `transit` -> `global`.
 */
function resolveChain(key) {
  const chain = [];
  const seen = new Set();
  let current = key;
  while (current) {
    if (seen.has(current)) {
      throw new Error(`Circular extends in rules: ${[...seen, current].join(' -> ')}`);
    }
    seen.add(current);
    const doc = readRuleFile(current);
    chain.unshift(doc);
    current = doc.extends;
  }
  return chain;
}

/** Merged rules for a rules key (`transit_bus`), cached. */
function loadRulesByKey(key) {
  if (cache.has(key)) return cache.get(key);
  const merged = resolveChain(key).reduce((acc, doc) => mergeRules(acc, doc), {});
  merged.key = key;
  Object.freeze(merged);
  cache.set(key, merged);
  return merged;
}

/** Merged rules for a media slug or display name (`bus`, `Bus`, `metro_train`). */
function loadRules(media) {
  const needle = String(media || '').toLowerCase();
  for (const [name, meta] of Object.entries(formatIndex.media_types)) {
    if (name.toLowerCase() === needle || meta.slug.toLowerCase() === needle) {
      return loadRulesByKey(meta.rules_key);
    }
  }
  throw new Error(`Unknown media "${media}" — no rules_key in format_index.json`);
}

/** Every distinct rules key in use, for boot-time validation. */
function allRuleKeys() {
  return [...new Set(Object.values(formatIndex.media_types).map((m) => m.rules_key))].sort();
}

/**
 * Load and sanity-check every rules file at boot. Called from server start so a
 * typo fails immediately rather than silently disabling a restriction.
 */
function validateAllRules() {
  const problems = [];

  // Every file reachable from a media key, including the ancestors they extend.
  const files = new Set();
  for (const key of allRuleKeys()) {
    let current = key;
    while (current && !files.has(current)) {
      files.add(current);
      current = readRuleFile(current).extends;
    }
  }

  const declaredIn = new Map();

  for (const key of files) {
    let doc;
    try {
      doc = readRuleFile(key);
    } catch (error) {
      problems.push(`${key}: ${error.message}`);
      continue;
    }

    // Duplicates are only meaningful *within* one file — a child repeating a
    // parent id is a deliberate override, which mergeRules handles.
    const seen = new Set();
    for (const constraint of doc.constraints || []) {
      if (!constraint.id) {
        problems.push(`${key}: constraint with no id`);
        continue;
      }
      if (seen.has(constraint.id)) {
        problems.push(`${key}: constraint id "${constraint.id}" appears twice in the same file`);
      }
      seen.add(constraint.id);
      if (!constraint.message) problems.push(`${key}: ${constraint.id} has no message`);
      if (!['block', 'warn', 'advise'].includes(constraint.severity)) {
        problems.push(`${key}: ${constraint.id} has invalid severity "${constraint.severity}"`);
      }
      if (!declaredIn.has(constraint.id)) declaredIn.set(constraint.id, key);
    }
  }

  // Each media key must resolve, and its chain must not loop.
  for (const key of allRuleKeys()) {
    try {
      loadRulesByKey(key);
    } catch (error) {
      problems.push(`${key}: ${error.message}`);
    }
  }

  if (problems.length) {
    throw new Error(`Invalid rules:\n  - ${problems.join('\n  - ')}`);
  }
  return { files: [...files].sort(), mediaKeys: allRuleKeys(), constraints: declaredIn.size };
}

module.exports = { loadRules, loadRulesByKey, allRuleKeys, validateAllRules, RULES_DIR };

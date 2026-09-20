/**
 * Layered merge for rules files: global -> family -> media key.
 *
 * Arrays of rules merge *by id* so a child can override one constraint without
 * restating the parent's list. Plain string arrays (guidance, terms) concatenate
 * and de-duplicate, because a child adding a "don't" should not silently drop
 * the family's. Scalars are replaced.
 */

const BY_ID = new Set(['constraints', 'scenarios']);
// Guidance accumulates: a child adding a "don't" must not drop the family's.
const CONCAT = new Set(['do', 'dont', 'never_claim', 'first_time_advertiser']);
// Terms do NOT accumulate. Each medium's T&C sheet is a complete, signed-off
// list — concatenating a parent's would put Mobile Van clauses on an auto sheet.
// Identity keys belong to the file they came from, never to the merged result.
const SKIP = new Set(['key', 'extends', 'label', '_note']);

function mergeById(parent = [], child = []) {
  const out = [...parent];
  const index = new Map(out.map((item, i) => [item.id, i]));
  for (const item of child) {
    if (index.has(item.id)) {
      out[index.get(item.id)] = { ...out[index.get(item.id)], ...item };
    } else {
      index.set(item.id, out.length);
      out.push(item);
    }
  }
  return out;
}

function concatUnique(parent = [], child = []) {
  return [...new Set([...parent, ...child])];
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeRules(parent, child) {
  const out = { ...parent };

  for (const [key, value] of Object.entries(child)) {
    if (SKIP.has(key)) continue;

    if (BY_ID.has(key)) {
      out[key] = mergeById(parent[key], value);
    } else if (CONCAT.has(key) && Array.isArray(value)) {
      out[key] = concatUnique(parent[key], value);
    } else if (isPlainObject(value)) {
      out[key] = mergeRules(parent[key] || {}, value);
    } else {
      out[key] = value;
    }
  }

  return out;
}

module.exports = { mergeRules };

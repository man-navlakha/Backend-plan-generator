/**
 * Which media the catalog can actually quote today.
 *
 * A medium can sit in the format index, have a renderer template and a rules
 * file, and still have nothing behind it -- newspaper has 552 products in its
 * workbook and not one rate, so it is left out of the import entirely. A brief
 * asking for it is a reasonable brief; it just cannot be planned yet.
 *
 * This is read from the database rather than kept as a list in code. The day a
 * master gains rates, the import picks it up and /brief starts accepting it
 * with nothing else to change. A hand-maintained list would have to be found
 * and edited, and would be wrong in the meantime.
 */

const { rows } = require('../pg');
const pg = require('../pg');
const { catalogSlugsFor, absenceReason } = require('./media-map');

// Long enough that a burst of briefs costs one query, short enough that a
// re-import shows up without a redeploy.
const TTL_MS = 5 * 60 * 1000;

let cache = null;

/** slug -> { products, price_options } for everything with a usable rate. */
async function loadAvailability() {
  const result = await rows(`
    select p.media_type,
           count(distinct p.id) as products,
           count(po.id)         as price_options
      from masters.products p
      join masters.price_options po
        on po.product_id = p.id
       and po.status = 1
       and po.offer_rate is not null
       and po.offer_rate > 0
     where p.status = 1
     group by p.media_type
  `);

  const map = new Map();
  for (const row of result) {
    map.set(row.media_type, {
      products: Number(row.products),
      price_options: Number(row.price_options)
    });
  }
  return map;
}

/**
 * Cached availability.
 *
 * Returns null when the database cannot be reached or is not configured. A
 * caller must treat null as "unknown" and let the brief through -- refusing
 * every medium because a connection blipped would be worse than accepting one
 * that later turns out to be empty.
 */
async function getAvailability({ force = false } = {}) {
  if (!pg.isConfigured()) return null;
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.map;

  try {
    const map = await loadAvailability();
    cache = { at: Date.now(), map };
    return map;
  } catch (error) {
    console.error('[availability] lookup failed:', error.message);
    return cache?.map ?? null;
  }
}

/**
 * Every media slug a service name covers, in the vocabulary the database uses.
 *
 * "Bus" is one slug. "Transit" is ten. "Television" is 'tv', because the index
 * and the workbooks disagree -- see media-map.js. A family is only unavailable
 * when every medium inside it is: "Print" stays bookable on magazine alone even
 * with newspaper missing.
 */
function slugsFor(service) {
  return catalogSlugsFor(service);
}

/**
 * Can this service be planned right now?
 *
 *   { available: true }                              plan away
 *   { available: false, reason: 'coming_soon' }      real medium, no rates yet
 *   { available: true,  reason: 'unknown' }          catalog unreachable; allowed
 *
 * `partial` marks a family where some media are live and some are not, so the
 * brief can be accepted while still naming what is missing.
 */
async function checkService(service) {
  const slugs = slugsFor(service);
  const map = await getAvailability();

  if (!map) {
    return { available: true, reason: 'unknown', slugs, live: [], missing: [] };
  }

  const live = slugs.filter((slug) => map.has(slug));
  const missing = slugs.filter((slug) => !map.has(slug));

  if (live.length === 0) {
    return {
      available: false,
      reason: 'coming_soon',
      slugs,
      live,
      missing,
      // Why, when it is a gap we have already looked into.
      detail: absenceReason(String(service || '').trim().toLowerCase()) || absenceForSlugs(slugs)
    };
  }

  return {
    available: true,
    reason: missing.length ? 'partial' : 'ok',
    slugs,
    live,
    missing,
    inventory: Object.fromEntries(live.map((slug) => [slug, map.get(slug)]))
  };
}

/** The first documented reason among the slugs a service resolved to. */
function absenceForSlugs(slugs) {
  for (const slug of slugs) {
    const reason = absenceReason(slug);
    if (reason) return reason;
  }
  return null;
}

/** Drops the cache, for tests and for a re-import that wants to be seen now. */
function reset() {
  cache = null;
}

module.exports = { checkService, getAvailability, slugsFor, reset, TTL_MS };

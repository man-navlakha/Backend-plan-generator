/**
 * Turning a brief into the shortlist the model starts from.
 *
 * The model cannot be shown the catalog. Auto alone carries 1,453 price options
 * and the whole master is 47,574 -- a prompt that size is neither affordable nor
 * one a model reads carefully. So the first pass is SQL: narrow by the media and
 * the cities the brief actually asked for, take the strongest candidates, and
 * hand over a few dozen complete rows.
 *
 * What comes back is deliberately more than a list of products:
 *
 *   candidates  what can be quoted
 *   coverage    which media x city combinations have nothing behind them
 *   notes       what the brief asked for that the catalog cannot answer
 *
 * The gaps matter as much as the hits. A model shown only what exists will
 * quietly plan around a missing city; a model told "Bus has no inventory in
 * Kanpur" can say so.
 */

const { rows } = require('../pg');
const formatIndex = require('../assets/formats/format_index.json');
const { searchProducts } = require('./search');
const { catalogSlugsFor, absenceReason } = require('./media-map');

// How much gets through to the prompt. Roughly 60 products x ~700 tokens of
// JSON each sits near 40k tokens -- large, but one call, and complete.
const MAX_CANDIDATES = 60;
const PER_COMBINATION = 12;

// 'Bus' -> bus, 'Transit' -> every transit medium.
const BY_NAME = new Map();
const BY_SLUG = new Map();
const BY_FAMILY = new Map();
for (const [name, meta] of Object.entries(formatIndex.media_types)) {
  const entry = { name, slug: meta.slug, family: meta.family };
  BY_NAME.set(name.toLowerCase(), entry);
  BY_SLUG.set(meta.slug.toLowerCase(), entry);
  if (!BY_FAMILY.has(meta.family)) BY_FAMILY.set(meta.family, []);
  BY_FAMILY.get(meta.family).push(entry);
}

/**
 * What the brief called the medium, resolved against what the database stores.
 *
 * A brief says "Transit" as often as it says "Bus", so a family name expands to
 * its members. Anything the format index does not recognise is still tried as a
 * raw slug -- the BTL master alone invented 40-odd media types (atm_branding,
 * gym_digital_screen) that were never in the index.
 */
function resolveMedia(service) {
  const needle = String(service || '').trim().toLowerCase();
  if (!needle) return { slugs: [], label: null, expandedFrom: null };

  // catalogSlugsFor does the index-to-database translation, so 'Television'
  // arrives here as 'tv' rather than as a slug nothing is stored under.
  const slugs = catalogSlugsFor(service);

  const direct = BY_NAME.get(needle) || BY_SLUG.get(needle);
  if (direct) return { slugs, label: direct.name, expandedFrom: null };

  if (BY_FAMILY.has(needle)) {
    return { slugs, label: needle, expandedFrom: 'family' };
  }

  return { slugs, label: service, expandedFrom: 'raw' };
}

/**
 * Matches each requested location against the cities and states that actually
 * carry the medium.
 *
 * A city with no inventory is not a failure to report later -- it changes what
 * gets fetched now. When Lucknow has no cinema, the useful fallback is Uttar
 * Pradesh, and the brief should be told that is what happened.
 */
async function resolveLocations(requested, mediaSlugs) {
  const wanted = (requested || []).map((l) => String(l).trim()).filter(Boolean);
  if (wanted.length === 0) return [{ requested: null, city: null, state: null, match: 'any' }];

  const available = await rows(
    `select distinct lower(p.city) as city_key, p.city, lower(p.state) as state_key, p.state
       from masters.products p
       join masters.price_options po on po.product_id = p.id and po.offer_rate > 0
      where p.media_type = any($1::text[]) and p.status = 1`,
    [mediaSlugs]
  );

  const cities = new Map();
  const states = new Map();
  for (const row of available) {
    if (row.city_key) cities.set(row.city_key, { city: row.city, state: row.state });
    if (row.state_key) states.set(row.state_key, row.state);
  }

  return wanted.map((name) => {
    const key = name.toLowerCase();
    const city = cities.get(key);
    if (city) return { requested: name, city: city.city, state: city.state, match: 'city' };
    if (states.has(key)) return { requested: name, city: null, state: states.get(key), match: 'state' };
    return { requested: name, city: null, state: null, match: 'none' };
  });
}

/**
 * Builds the shortlist.
 *
 *   brief.service          'Bus' | 'Transit' | 'atm_branding'
 *   brief.budget           rupees; caps the per-unit rate that can be shown
 *   brief.target_locations ['Lucknow', 'Kanpur']
 */
async function prefetchForBrief(brief = {}, options = {}) {
  const maxCandidates = options.maxCandidates || MAX_CANDIDATES;
  const perCombination = options.perCombination || PER_COMBINATION;

  const media = resolveMedia(brief.service);
  const notes = [];

  if (media.expandedFrom === 'family') {
    notes.push(`Brief named the family "${brief.service}"; expanded to ${media.slugs.length} media types.`);
  }

  // Which of those slugs the database has anything for at all.
  const present = await rows(
    `select p.media_type, count(distinct p.id) as products, count(po.id) as options
       from masters.products p
       join masters.price_options po on po.product_id = p.id and po.offer_rate > 0
      where p.media_type = any($1::text[]) and p.status = 1
      group by p.media_type order by options desc`,
    [media.slugs]
  );

  const live = present.map((r) => r.media_type);
  const empty = media.slugs.filter((s) => !live.includes(s));
  for (const slug of empty) {
    const why = absenceReason(slug);
    notes.push(
      `No priced inventory for media "${slug}". Nothing can be quoted for it.` +
        (why ? ` ${why}` : '')
    );
  }
  if (live.length === 0) {
    return {
      media: { ...media, available: [] },
      locations: [],
      candidates: [],
      coverage: [],
      notes: [...notes, 'Prefetch found no priced inventory for this brief at all.'],
      stats: { products: 0, price_options: 0, truncated: false }
    };
  }

  const locations = await resolveLocations(brief.target_locations, live);
  for (const loc of locations) {
    if (loc.match === 'none') {
      notes.push(`"${loc.requested}" is not a city or state carrying this medium. It was not searched.`);
    } else if (loc.match === 'state') {
      notes.push(`No city named "${loc.requested}"; searched the whole state of ${loc.state} instead.`);
    }
  }

  // A single unit costing more than the entire budget is not a candidate.
  const maxRate = Number(brief.budget) > 0 ? Number(brief.budget) : null;

  const askedForLocations = (brief.target_locations || []).filter(Boolean).length > 0;
  const usable = locations.filter((l) => l.match !== 'none');

  /*
   * A brief that named cities and matched none of them gets nothing back.
   *
   * The tempting fallback is to drop the filter and return national inventory,
   * but that is how a Gangtok brief ends up quoting Kolkata buses: the model
   * sees candidates, not the note explaining they are from the wrong place.
   * Better to return an empty shortlist and say why.
   */
  if (askedForLocations && usable.length === 0) {
    return {
      media: { ...media, available: present },
      locations,
      candidates: [],
      coverage: live.map((slug) => ({
        media: slug,
        location: locations.map((l) => l.requested).join(', '),
        resolved_as: 'none',
        products_found: 0
      })),
      notes: [
        ...notes,
        `None of the requested locations carry ${live.join(', ')}. ` +
          'No candidates were fetched - quoting another city here would be wrong. ' +
          'Use search_products or cities_for_media to find the nearest inventory.'
      ],
      stats: { products: 0, price_options: 0, truncated: false }
    };
  }

  const combinations = [];
  for (const slug of live) {
    if (usable.length === 0) {
      combinations.push({ media: slug, location: null });
    } else {
      for (const loc of usable) combinations.push({ media: slug, location: loc });
    }
  }

  // Run the combinations together. A ten-medium family brief is ten round trips
  // to a database at the far end of a public proxy; sequentially that is most of
  // the prefetch's wall clock.
  const found = await Promise.all(
    combinations.map((combo) =>
      searchProducts({
        mediaType: combo.media,
        city: combo.location?.city || undefined,
        state: combo.location?.city ? undefined : combo.location?.state || undefined,
        maxRate,
        limit: perCombination
      })
    )
  );

  const candidates = [];
  const coverage = [];

  combinations.forEach((combo, i) => {
    const hits = found[i];
    coverage.push({
      media: combo.media,
      location: combo.location?.requested || 'any',
      resolved_as: combo.location?.match || 'any',
      products_found: hits.length
    });

    if (hits.length === 0) {
      notes.push(
        `No ${combo.media} inventory in ${combo.location?.requested || 'the catalog'}` +
          (maxRate ? ` within a ${maxRate.toLocaleString('en-IN')} budget.` : '.')
      );
      return;
    }
    candidates.push(...hits);
  });

  // Strongest first, so the trim below drops the weakest rather than whatever
  // happened to be queried last.
  candidates.sort((a, b) => Number(b.priced_options) - Number(a.priced_options));
  const truncated = candidates.length > maxCandidates;
  const trimmed = candidates.slice(0, maxCandidates);
  if (truncated) {
    notes.push(
      `${candidates.length} products matched; the ${maxCandidates} with the most price options were kept. ` +
        'Call search_products for anything the shortlist is missing.'
    );
  }

  return {
    media: { ...media, available: present },
    locations,
    candidates: trimmed,
    coverage,
    notes,
    stats: {
      products: trimmed.length,
      price_options: trimmed.reduce((n, p) => n + (p.price_options?.length || 0), 0),
      truncated
    }
  };
}

module.exports = { prefetchForBrief, resolveMedia, resolveLocations, MAX_CANDIDATES };

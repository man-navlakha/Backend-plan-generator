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
const NATIONAL_MEDIA = new Set(['magazine']);
const COUNTRY_NAMES = new Set(['india', 'bharat']);
const CINEMA_CITY_ALIASES = new Map([
  ['gurugram', ['Gurugram', 'Gurgaon']],
  ['gurgaon', ['Gurgaon', 'Gurugram']]
]);

function catalogNameKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^magazine\s+advertising\s+in\s+/, '')
    .replace(/[\u2019']s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function locationKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function cinemaCityValues(city) {
  const value = String(city || '').trim();
  return CINEMA_CITY_ALIASES.get(locationKey(value)) || (value ? [value] : undefined);
}

function usefulCinemaValue(value) {
  if (value === null || value === undefined || value === '') return false;
  return !/^\s*(?:\[object object\]|https?:\/\/|www\.)/i.test(String(value));
}

function cinemaCompleteness(product) {
  const attrs = product.attrs || {};
  return [
    attrs.screen_code,
    product.locality || attrs.locality,
    attrs.pincode,
    attrs.theatre_type,
    attrs.multiplex_name,
    usefulCinemaValue(attrs.address) ? attrs.address : null,
    attrs.audi_no,
    attrs.audi_type,
    attrs.cinema_chain,
    attrs.seating_capacity
  ].filter((value) => value !== null && value !== undefined && value !== '').length;
}

function cinemaAudiNumber(product) {
  const stated = product.attrs?.audi_no;
  if (stated !== null && stated !== undefined && stated !== '') return String(stated);
  const match = /\baudi\s*(\d+)|\bscreen[-_\s]*(\d+)/i.exec(
    `${product.name || ''} ${product.sku || ''}`
  );
  return match ? String(match[1] || match[2]) : '';
}

function cinemaVenueCore(product) {
  return String(product.attrs?.multiplex_name || product.name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(?:audi|screen)\s*\d+\b/g, ' ')
    .replace(/\b(?:pvr|inox|cinepolis|miraj|cinemas?|superplex|multiplex|mall|gurgaon|gurugram|noida|haryana|ncr)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function cinemaMarketKey(product) {
  const city = locationKey(product.city).replace(/^gurgaon$/, 'gurugram');
  return `${city}|${locationKey(product.state)}|${cinemaAudiNumber(product)}`;
}

function sameCinemaScreen(a, b) {
  const aCode = locationKey(a.attrs?.screen_code);
  const bCode = locationKey(b.attrs?.screen_code);
  if (aCode && bCode && aCode === bCode) return true;
  if (cinemaMarketKey(a) !== cinemaMarketKey(b)) return false;
  const aVenue = cinemaVenueCore(a);
  const bVenue = cinemaVenueCore(b);
  if (!aVenue || !bVenue) return false;
  return aVenue === bVenue ||
    (Math.min(aVenue.length, bVenue.length) >= 7 && (aVenue.includes(bVenue) || bVenue.includes(aVenue)));
}

/** Prefer the most complete version of a physical audi and drop its sparse aliases. */
function dedupeCinemaProducts(products) {
  const ranked = [...(products || [])].sort((a, b) =>
    cinemaCompleteness(b) - cinemaCompleteness(a) || Number(b.id) - Number(a.id)
  );
  const kept = [];
  for (const product of ranked) {
    if (!kept.some((candidate) => sameCinemaScreen(product, candidate))) kept.push(product);
  }
  return kept;
}

async function searchCinemaCatalog(params) {
  return dedupeCinemaProducts(await searchProducts({
    ...params,
    city: cinemaCityValues(params.city),
    mediaType: 'cinema'
  }));
}

/**
 * Resolve one CRM location against the city/state pairs carried by a medium.
 *
 * The brief reviewer commonly returns qualified names such as
 * "Noida, Uttar Pradesh". The catalog stores those as two columns, so treating
 * the whole string as either a city or a state rejects valid inventory. Keep
 * exact city/state matching, then understand comma/bullet-qualified locations
 * and verify that the requested city and state actually occur together.
 */
function matchRequestedLocation(name, available) {
  const requested = String(name || '').trim();
  const key = locationKey(requested);
  if (!key) return { requested, city: null, state: null, match: 'none' };

  const exactCities = available.filter((row) => row.city_key === key);
  if (exactCities.length) {
    const stateNames = [...new Set(exactCities.map((row) => row.state).filter(Boolean))];
    return {
      requested,
      city: exactCities[0].city,
      // Do not arbitrarily constrain a city that appears under multiple states
      // in a dirty source catalog. A qualified request below is unambiguous.
      state: stateNames.length === 1 ? stateNames[0] : null,
      match: 'city'
    };
  }

  const exactState = available.find((row) => row.state_key === key);
  if (exactState) {
    return { requested, city: null, state: exactState.state, match: 'state' };
  }

  const parts = requested
    .split(/\s*[,\u00b7|]\s*/u)
    .map(locationKey)
    .filter(Boolean)
    .filter((part, index, all) => !(index === all.length - 1 && COUNTRY_NAMES.has(part)));

  if (parts.length >= 2) {
    for (const row of available) {
      if (parts.includes(row.city_key) && parts.includes(row.state_key)) {
        return { requested, city: row.city, state: row.state, match: 'city' };
      }
    }
  }

  // Also accept the common unpunctuated form "Noida Uttar Pradesh" while
  // still requiring an exact catalog city/state pair.
  const flattened = key.replace(/\s*[,\u00b7|]\s*/gu, ' ');
  const pair = available.find((row) =>
    `${row.city_key} ${row.state_key}` === flattened ||
    `${row.state_key} ${row.city_key}` === flattened
  );
  if (pair) return { requested, city: pair.city, state: pair.state, match: 'city' };

  return { requested, city: null, state: null, match: 'none' };
}

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

  return wanted.map((name) => matchRequestedLocation(name, available));
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

  const nationalInventory = live.every((slug) => NATIONAL_MEDIA.has(slug));
  const locations = nationalInventory ? [] : await resolveLocations(brief.target_locations, live);
  if (nationalInventory && (brief.target_locations || []).filter(Boolean).length) {
    notes.push(
      `${brief.service} inventory is national; ${brief.target_locations.join(', ')} is kept as the ` +
      'campaign geography and is not used as a city filter.'
    );
  }
  for (const loc of locations) {
    if (loc.match === 'none') {
      notes.push(`"${loc.requested}" is not a city or state carrying this medium. It was not searched.`);
    } else if (loc.match === 'state') {
      notes.push(`No city named "${loc.requested}"; searched the whole state of ${loc.state} instead.`);
    }
  }

  // A single unit costing more than the entire budget is not a candidate.
  const maxRate = Number(brief.budget) > 0 ? Number(brief.budget) : null;

  const askedForLocations = !nationalInventory && (brief.target_locations || []).filter(Boolean).length > 0;
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
      combinations.push({
        media: slug,
        location: null
      });
    } else {
      for (const loc of usable) combinations.push({
        media: slug,
        location: loc
      });
    }
  }

  // Run the combinations together. A ten-medium family brief is ten round trips
  // to a database at the far end of a public proxy; sequentially that is most of
  // the prefetch's wall clock.
  const found = await Promise.all(
    combinations.map(async (combo) => {
      const params = {
        city: combo.location?.city || undefined,
        state: combo.location?.state || undefined,
        maxRate,
        // Read deeper before quality ranking/deduplication; only the best
        // perCombination rows go into the model prompt below.
        limit: combo.media === 'cinema'
          ? Math.max(60, perCombination * 5)
          : perCombination
      };
      const hits = combo.media === 'cinema'
        ? await searchCinemaCatalog(params)
        : await searchProducts({ ...params, mediaType: combo.media });
      return hits.slice(0, perCombination);
    })
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

  // Explicit Magazine titles must survive the generic "most inventory" trim.
  // Search each title separately, accept only an exact normalized name, and
  // place those products at the front of the shortlist.
  const requestedNames = Array.isArray(brief.requested_publications)
    ? brief.requested_publications.map(String).map((value) => value.trim()).filter(Boolean)
    : [];
  const requestedCandidates = [];
  if (live.includes('magazine') && requestedNames.length) {
    const requestedResults = await Promise.all(
      requestedNames.map((name) => searchProducts({ q: name, mediaType: 'magazine', limit: 8 }))
    );
    requestedResults.forEach((hits, index) => {
      const key = catalogNameKey(requestedNames[index]);
      const exact = hits.find((item) => catalogNameKey(item.name) === key);
      if (exact) requestedCandidates.push(exact);
      else notes.push(`Requested Magazine title "${requestedNames[index]}" is not in the current catalog.`);
    });
  }

  // Strongest first, so the trim below drops the weakest rather than whatever
  // happened to be queried last.
  candidates.sort((a, b) => Number(b.priced_options) - Number(a.priced_options));
  const prioritized = [...requestedCandidates, ...candidates]
    .filter((candidate, index, all) =>
      all.findIndex((item) => String(item.id) === String(candidate.id)) === index
    );
  const truncated = prioritized.length > maxCandidates;
  const trimmed = prioritized.slice(0, maxCandidates);
  if (truncated) {
    notes.push(
      `${prioritized.length} products matched; the ${maxCandidates} with requested titles first were kept. ` +
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

/**
 * Fetch the complete priced Cinema list for the client-facing options sheet.
 *
 * The normal prefetch is deliberately small because it is sent to the model.
 * That shortlist is suitable for recommendations, but it must not become the
 * client's view of all available screens. This second read keeps every priced
 * product and every price option in each resolved requested location, without
 * applying the campaign budget as a per-rate ceiling.
 */
async function fetchCompleteCinemaInventory(brief = {}, prefetch = null) {
  const media = resolveMedia(brief.service);
  if (!media.slugs.includes('cinema')) return [];

  const locations = prefetch?.locations || await resolveLocations(brief.target_locations, ['cinema']);
  const askedForLocations = (brief.target_locations || []).filter(Boolean).length > 0;
  const usable = locations.filter((location) => location.match !== 'none');
  if (askedForLocations && usable.length === 0) return [];

  const combinations = [];
  if (usable.length === 0) combinations.push({ location: null });
  else for (const location of usable) combinations.push({ location });

  const batches = await Promise.all(combinations.map(({ location }) =>
    searchCinemaCatalog({
      city: location?.city || undefined,
      state: location?.state || undefined,
      pricedOnly: true,
      limit: 500,
      optionsPerProduct: 200
    })
  ));

  return dedupeCinemaProducts(batches.flat());
}

module.exports = {
  prefetchForBrief,
  fetchCompleteCinemaInventory,
  resolveMedia,
  resolveLocations,
  matchRequestedLocation,
  cinemaCityValues,
  cinemaCompleteness,
  dedupeCinemaProducts,
  catalogNameKey,
  MAX_CANDIDATES
};

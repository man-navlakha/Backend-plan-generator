/**
 * Bridging the two vocabularies for a medium.
 *
 * format_index.json names media the way the sales desk and the renderer do
 * ('Television' -> television, 'Balloon Branding' -> balloon). The database
 * names them the way the workbooks did, because the importer derives the slug
 * from each master's own Media Option column ('tv', 'sky_balloon_branding').
 *
 * They mostly agree. Where they do not, the gap is invisible and expensive:
 * /brief answers "Television is coming soon" while 946 television rates sit in
 * the catalog, and a Television brief prefetches nothing at all.
 *
 * Only aliases verified against real inventory belong here. A medium the
 * catalog genuinely lacks -- Outdoor, Dealer Board, Wall Painting, the
 * per-platform digital media -- must stay unmapped so it is reported honestly
 * as not yet available. Mapping it to something approximate would quote the
 * wrong inventory, which is worse than saying "not yet".
 */

const formatIndex = require('../assets/formats/format_index.json');

/**
 * format_index slug -> the media_type value(s) the importer actually stored.
 *
 * Each entry was confirmed by querying for priced inventory under the target
 * slug. Re-check with `npm run catalog:media` after any master is re-imported;
 * the importer derives slugs from the workbook, so a renamed column here
 * silently breaks an alias.
 */
const ALIASES = {
  // The tv master is the whole medium; the index calls it by its long name.
  television: ['tv'],

  // The BTL master splits balloons by type instead of carrying one medium.
  balloon: ['sky_balloon_branding', 'hot_air_balloon_branding'],

  // Same medium, the workbook writes "activation" where the index writes
  // "activity", and appends "branding" to the screen media.
  corporate_activity: ['corporate_activation'],
  corporate_digital_screens: ['corporate_digital_screen_branding'],
  society_digital_screens: ['society_digital_screen_branding'],

  // Leaflets: the index names the channel, the master names the act.
  leaflet_d2d: ['door_to_door_leaflet_distribution'],
  leaflet_insertion: ['leaflet_insertion_in_newspaper']
};

/**
 * Media the catalog does not carry, with the reason.
 *
 * Kept explicit so a "coming soon" can say something better than "no". These
 * are not failures to look up -- they were looked up and are genuinely absent.
 */
const KNOWN_ABSENT = {
  newspaper: 'The newspaper master has products but no rate card, so nothing can be priced.',
  hoarding: 'No outdoor/hoarding master has been imported yet.',
  dealer_board: 'No dealer board inventory in any master.',
  wall_painting: 'No wall painting inventory in any master.',
  meta_ads: 'The digital master lists publishers, not ad platforms.',
  youtube: 'The digital master lists publishers, not ad platforms.',
  google_business: 'The digital master lists publishers, not ad platforms.',
  in_app: 'The digital master lists publishers, not ad platforms.',
  digital_sampling: 'Not carried as a distinct medium in the digital master.',
  pr: 'Covered by Digital PR; there is no separate PR rate card.',
  influencer: 'No influencer rate card in any master.',
  press_conference: 'No press conference rate card in any master.'
};

/**
 * Every media_type value in the database that a service name should match.
 *
 *   catalogSlugsFor('Television')  -> ['tv']
 *   catalogSlugsFor('Transit')     -> ten transit slugs
 *   catalogSlugsFor('atm_branding')-> ['atm_branding']   (straight through)
 */
function catalogSlugsFor(service) {
  const needle = String(service || '').trim().toLowerCase();
  if (!needle) return [];

  // An exact medium, by display name or index slug.
  for (const [name, meta] of Object.entries(formatIndex.media_types)) {
    if (name.toLowerCase() === needle || meta.slug.toLowerCase() === needle) {
      return expand(meta.slug);
    }
  }

  // A family name: every medium inside it.
  const family = [];
  for (const meta of Object.values(formatIndex.media_types)) {
    if (meta.family.toLowerCase() === needle) family.push(...expand(meta.slug));
  }
  if (family.length) return [...new Set(family)];

  // Something the index never knew about -- the BTL master invented forty of
  // these. Pass it through as a slug and let the query decide.
  return [needle.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')];
}

/** One index slug to the catalog slugs it covers. */
function expand(indexSlug) {
  return ALIASES[indexSlug] || [indexSlug];
}

/** Why a medium is not available, when we happen to know. */
function absenceReason(indexSlug) {
  return KNOWN_ABSENT[indexSlug] || null;
}

module.exports = { catalogSlugsFor, expand, absenceReason, ALIASES, KNOWN_ABSENT };

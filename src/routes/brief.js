const express = require('express');
const formatIndex = require('../assets/formats/format_index.json');
const { checkService, getAvailability } = require('../catalog/availability');
const { expand, absenceReason } = require('../catalog/media-map');

const router = express.Router();

/**
 * Express 4 does not catch a rejected promise from an async handler -- it
 * becomes an unhandled rejection and the request hangs until it times out.
 * Every async route below is wrapped so a failure becomes a 500 with a body.
 */
const wrap = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

const MEDIA_TYPES = Object.keys(formatIndex.media_types);

// Lookup by both display name ("Metro Train") and slug ("metro_train"), case-insensitively.
const MEDIA_LOOKUP = new Map();
for (const [name, meta] of Object.entries(formatIndex.media_types)) {
  MEDIA_LOOKUP.set(name.toLowerCase(), { name, ...meta });
  MEDIA_LOOKUP.set(meta.slug.toLowerCase(), { name, ...meta });
}

/**
 * Query params are strings; every field is described once here so validation,
 * the 400 payload and the docs stay in sync.
 * `aliases` lets callers send camelCase or a shorter name.
 */
const FIELDS = [
  { key: 'deal_id', label: 'Deal ID', required: true, aliases: ['dealId', 'deal'] },
  { key: 'company', label: 'Company', required: true, aliases: ['client'] },
  { key: 'service', label: 'Service (media)', required: true, aliases: ['media', 'media_type', 'mediaType'] },
  { key: 'budget', label: 'Budget', required: true, aliases: ['amount'] },
  {
    key: 'campaign_objective',
    label: 'Campaign objective',
    required: false,
    aliases: ['campaignObjective', 'objective']
  },
  {
    key: 'target_audience',
    label: 'Target audience',
    required: false,
    aliases: ['targetAudience', 'audience']
  },
  {
    key: 'target_locations',
    label: 'Target locations',
    required: false,
    aliases: ['targetLocations', 'locations', 'location']
  },
  {
    key: 'remarks_for_media',
    label: 'Remarks for media',
    required: false,
    aliases: ['remarksForMedia', 'remarks']
  }
];

// GET /brief — accepts the deal brief as query parameters and echoes back the parsed brief.
router.get('/', wrap(async (req, res) => {
  const raw = {};
  for (const field of FIELDS) {
    raw[field.key] = firstValue(req.query, [field.key, ...field.aliases]);
  }

  const errors = [];

  for (const field of FIELDS) {
    if (field.required && !raw[field.key]) {
      errors.push({ field: field.key, message: `${field.label} is required` });
    }
  }

  const media = raw.service ? MEDIA_LOOKUP.get(raw.service.toLowerCase()) : undefined;
  if (raw.service && !media) {
    errors.push({
      field: 'service',
      message: `Unknown service (media) "${raw.service}"`,
      allowed: MEDIA_TYPES
    });
  }

  const budget = parseBudget(raw.budget);
  if (raw.budget && budget === null) {
    errors.push({ field: 'budget', message: 'Budget must be a positive number' });
  }

  if (errors.length > 0) {
    return res.status(400).json({ status: 'error', errors });
  }

  /*
   * The medium is spelled correctly and is a medium we sell -- but the catalog
   * may hold no rates for it, in which case no plan can be built. That is not
   * the caller's mistake, so it is not a 400. The brief is acknowledged and the
   * answer says plainly that the medium is not live yet.
   */
  const availability = await checkService(media.name);
  if (!availability.available) {
    return res.status(200).json({
      status: 'coming_soon',
      receivedAt: new Date().toISOString(),
      message:
        `${media.name} plans are coming soon. The rate card for this medium is not in the ` +
        'catalog yet, so a plan cannot be generated. Everything else in the brief was accepted.',
      service: media.name,
      brief: briefPayload(raw, media, budget),
      available_now: await liveServices()
    });
  }

  return res.status(200).json({
    status: 'ok',
    receivedAt: new Date().toISOString(),
    // A family brief where part of the family has no rates: worth planning,
    // worth saying which part will be missing from the plan.
    ...(availability.reason === 'partial'
      ? {
          notice:
            `Some ${media.name} media have no rates in the catalog and will be left out: ` +
            `${availability.missing.join(', ')}.`
        }
      : {}),
    brief: briefPayload(raw, media, budget)
  });
}));

/**
 * Discovery helper so callers can see the accepted media names without reading
 * the asset index -- now with whether each one can actually be planned, so a
 * caller can avoid the coming_soon answer instead of discovering it.
 */
router.get('/media-types', wrap(async (req, res) => {
  const map = await getAvailability();

  const media_types = MEDIA_TYPES.map((name) => {
    const meta = formatIndex.media_types[name];
    // Through the alias map, not the raw slug: 'television' is stored as 'tv',
    // and one index medium can cover several catalog ones.
    const catalogSlugs = expand(meta.slug);
    const found = catalogSlugs.map((slug) => map?.get(slug)).filter(Boolean);

    return {
      name,
      slug: meta.slug,
      family: meta.family,
      // null when the catalog could not be reached; the caller should not read
      // that as "unavailable".
      status: map ? (found.length ? 'available' : 'coming_soon') : null,
      products: found.reduce((n, i) => n + i.products, 0) || null,
      price_options: found.reduce((n, i) => n + i.price_options, 0) || null,
      ...(map && !found.length ? { reason: absenceReason(meta.slug) } : {})
    };
  });

  res.status(200).json({
    status: 'ok',
    count: media_types.length,
    available: media_types.filter((m) => m.status === 'available').length,
    coming_soon: media_types.filter((m) => m.status === 'coming_soon').map((m) => m.name),
    media_types
  });
}));

/** The parsed brief, shaped the same whether or not the medium is live yet. */
function briefPayload(raw, media, budget) {
  return {
    deal_id: raw.deal_id,
    company: raw.company,
    service: media.name,
    media: {
      slug: media.slug,
      family: media.family,
      template: media.template
    },
    budget,
    campaign_objective: raw.campaign_objective || null,
    target_audience: raw.target_audience || null,
    target_locations: splitList(raw.target_locations),
    remarks_for_media: raw.remarks_for_media || null
  };
}

/**
 * The services that can be planned today, for a caller who just hit a
 * coming_soon and needs somewhere to go next.
 *
 * Falls back to the full list when the catalog cannot be reached -- an empty
 * array here would read as "nothing works", which is a worse lie than an
 * optimistic one.
 */
async function liveServices() {
  const map = await getAvailability();
  if (!map) return MEDIA_TYPES;
  return MEDIA_TYPES.filter((name) => {
    const meta = formatIndex.media_types[name];
    if (expand(meta.slug).some((slug) => map.has(slug))) return true;
    // A family name stays on the list while any of its members are live.
    return Object.values(formatIndex.media_types).some(
      (other) => other.family === meta.family && expand(other.slug).some((s) => map.has(s))
    );
  });
}

function firstValue(query, names) {
  for (const name of names) {
    const value = query[name];
    // Express gives an array when a param repeats; take the last one it received.
    const single = Array.isArray(value) ? value[value.length - 1] : value;
    if (typeof single === 'string' && single.trim() !== '') {
      return single.trim();
    }
  }
  return undefined;
}

// Accepts "250000", "2,50,000" or "₹250000" — returns null when it isn't a usable amount.
function parseBudget(value) {
  if (!value) return null;
  const cleaned = value.replace(/[,\s₹]/g, '');
  const amount = Number(cleaned);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
}

function splitList(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

module.exports = router;

const express = require('express');
const formatIndex = require('../assets/formats/format_index.json');

const router = express.Router();

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
router.get('/', (req, res) => {
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

  return res.status(200).json({
    status: 'ok',
    receivedAt: new Date().toISOString(),
    brief: {
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
    }
  });
});

// Discovery helper so callers can see the accepted media names without reading the asset index.
router.get('/media-types', (req, res) => {
  res.status(200).json({
    status: 'ok',
    count: MEDIA_TYPES.length,
    media_types: MEDIA_TYPES.map((name) => ({
      name,
      slug: formatIndex.media_types[name].slug,
      family: formatIndex.media_types[name].family
    }))
  });
});

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

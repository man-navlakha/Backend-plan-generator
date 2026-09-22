/**
 * Plan generation, end to end.
 *
 *   POST /plans          brief in, workbook URL out
 *   GET  /plans/:id      a plan generated earlier
 *   GET  /plans          recent plans
 *
 * The POST is synchronous. That is a deliberate choice for now: a model call
 * plus a render plus an upload runs in roughly ten to twenty seconds, which a
 * curl or a desk tool will happily wait for, and a synchronous endpoint is far
 * easier to reason about than a job queue. It will need to become a 202 with a
 * job id before this runs on a serverless platform with a hard timeout.
 *
 * Everything is written to app.plans regardless of outcome, including failures.
 * A plan nobody can find out about is a plan nobody can fix.
 */

const express = require('express');
const { buildPlan } = require('../engine/build');
const { planWorkbookBuffer } = require('../render');
const planStorage = require('../storage/appwrite');
const { checkService } = require('../catalog/availability');
const { query, one } = require('../pg');
const formatIndex = require('../assets/formats/format_index.json');

const router = express.Router();

const wrap = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

/*
 * A brief says "Bus" as often as it says "Transit", so both resolve here.
 * Families are registered under their own name with a `family` marker; the
 * prefetch expands them into their member media, which is where the difference
 * actually matters.
 */
const MEDIA_LOOKUP = new Map();
for (const [name, meta] of Object.entries(formatIndex.media_types)) {
  MEDIA_LOOKUP.set(name.toLowerCase(), { name, ...meta });
  MEDIA_LOOKUP.set(meta.slug.toLowerCase(), { name, ...meta });
}
for (const meta of Object.values(formatIndex.media_types)) {
  const key = meta.family.toLowerCase();
  if (MEDIA_LOOKUP.has(key)) continue;
  MEDIA_LOOKUP.set(key, {
    name: meta.family.replace(/\b\w/g, (c) => c.toUpperCase()),
    slug: meta.family,
    family: meta.family,
    is_family: true
  });
}

/** Accepts the brief from a JSON body or, for curl convenience, the query string. */
function readBrief(req) {
  const src = { ...req.query, ...(req.body || {}) };
  const pick = (...names) => {
    for (const name of names) {
      const value = src[name];
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        return Array.isArray(value) ? value[value.length - 1] : value;
      }
    }
    return undefined;
  };

  const locations = pick('target_locations', 'targetLocations', 'locations', 'location');

  return {
    deal_id: pick('deal_id', 'dealId', 'deal'),
    company: pick('company', 'client'),
    service: pick('service', 'media', 'media_type', 'mediaType'),
    budget: parseBudget(pick('budget', 'amount')),
    campaign_objective: pick('campaign_objective', 'campaignObjective', 'objective') || null,
    target_audience: pick('target_audience', 'targetAudience', 'audience') || null,
    target_locations: Array.isArray(locations)
      ? locations
      : String(locations || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
    remarks_for_media: pick('remarks_for_media', 'remarksForMedia', 'remarks') || null,
    duration_months: Number(pick('duration_months', 'months')) || undefined
  };
}

function parseBudget(value) {
  if (value === undefined || value === null) return null;
  const cleaned = String(value).replace(/[,\s₹]/g, '');
  const amount = Number(cleaned);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

// POST /plans - the whole flow.
router.post('/', wrap(async (req, res) => {
  const brief = readBrief(req);
  const errors = [];

  if (!brief.deal_id) errors.push({ field: 'deal_id', message: 'Deal ID is required' });
  if (!brief.company) errors.push({ field: 'company', message: 'Company is required' });
  if (!brief.service) errors.push({ field: 'service', message: 'Service (media) is required' });
  if (!brief.budget) errors.push({ field: 'budget', message: 'Budget must be a positive number' });

  const media = brief.service ? MEDIA_LOOKUP.get(String(brief.service).toLowerCase()) : undefined;
  if (brief.service && !media) {
    errors.push({
      field: 'service',
      message: `Unknown service (media) "${brief.service}"`,
      allowed: [...new Set([...MEDIA_LOOKUP.values()].map((m) => m.name))]
    });
  }

  if (errors.length) return res.status(400).json({ status: 'error', errors });

  brief.service = media.name;

  // Same answer /brief gives, so a caller that skipped /brief is not surprised.
  const availability = await checkService(media.name);
  if (!availability.available) {
    return res.status(200).json({
      status: 'coming_soon',
      message:
        `${media.name} plans are coming soon. The rate card for this medium is not in the ` +
        'catalog yet, so a plan cannot be generated.',
      detail: availability.detail || null,
      service: media.name
    });
  }

  // The brief is recorded before anything is attempted, so a failure downstream
  // still leaves a trace of what was asked for.
  const briefRow = await one(
    `insert into app.briefs
       (deal_id, company, service, budget, campaign_objective, target_audience,
        target_locations, remarks_for_media, raw)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning id`,
    [
      brief.deal_id,
      brief.company,
      brief.service,
      brief.budget,
      brief.campaign_objective,
      brief.target_audience,
      brief.target_locations,
      brief.remarks_for_media,
      JSON.stringify(brief)
    ]
  );

  const planRow = await one(
    `insert into app.plans (brief_id, deal_id, status) values ($1,$2,'running') returning id`,
    [briefRow.id, brief.deal_id]
  );
  const planId = planRow.id;

  try {
    const built = await buildPlan(brief, { strategy: req.query.strategy });

    if (!built.plan) {
      await query(
        `update app.plans set status='blocked', flags=$2, error=$3, completed_at=now() where id=$1`,
        [planId, JSON.stringify(built.flags), built.flags[0]?.message || 'No plan could be built']
      );
      return res.status(200).json({
        status: 'blocked',
        plan_id: planId,
        message: built.flags[0]?.message || 'No plan could be built from this brief.',
        flags: built.flags,
        notes: built.notes
      });
    }

    // Render and upload. A plan that exists only in this response is a plan
    // nobody else can open, so the workbook goes to storage before the reply.
    const workbook = await planWorkbookBuffer(built.plan);
    const uploaded = await planStorage.uploadPlan(workbook, { plan: built.plan });

    // The URL handed out is this API's, not Appwrite's. Appwrite's needs the
    // server key; ours serves the file and keeps the bucket private.
    const downloadUrl = `${req.protocol}://${req.get('host')}/plans/${planId}/download`;

    await query(
      `update app.plans
          set status=$2, plan=$3, flags=$4, grand_total=$5,
              file_id=$6, file_name=$7, file_url=$8,
              model=$9, prompt_tokens=$10, output_tokens=$11, completed_at=now()
        where id=$1`,
      [
        planId,
        built.status,
        JSON.stringify(built.plan),
        JSON.stringify(built.flags),
        built.plan.totals.total,
        uploaded.fileId,
        uploaded.name,
        downloadUrl,
        built.plan.strategy,
        null,
        null
      ]
    );

    return res.status(201).json({
      status: built.status,
      plan_id: planId,
      deal_id: brief.deal_id,
      company: brief.company,
      service: brief.service,

      download_url: downloadUrl,
      // Appwrite's own URL, for a caller that holds the server key.
      storage_url: uploaded.downloadUrl,
      file_name: uploaded.name,
      file_size: uploaded.size,

      totals: built.plan.totals,
      budget: brief.budget,
      strategy: built.plan.strategy,

      legs: built.plan.legs.map((leg) => ({
        media: leg.media,
        duration: leg.duration_label,
        lines: leg.lines.length,
        net: leg.lines.reduce((sum, l) => sum + l.net, 0)
      })),

      flags: built.flags,
      desk_actions: built.plan.desk_actions,
      notes: built.notes,
      trace: built.trace
    });
  } catch (error) {
    await query(
      `update app.plans set status='failed', error=$2, completed_at=now() where id=$1`,
      [planId, error.message]
    );
    throw error;
  }
}));

/*
 * GET /plans/:id/download - the workbook.
 *
 * This, not the Appwrite URL, is what a caller is given. The bucket grants read
 * to nobody, so Appwrite's own /download answers 401 to anyone without the
 * server key; serving it here keeps the key on the server and keeps a client
 * quotation from being readable to whoever guesses a file id.
 */
router.get('/:id(\\d+)/download', wrap(async (req, res) => {
  const plan = await one(
    `select file_id, file_name, status from app.plans where id = $1`,
    [req.params.id]
  );

  if (!plan) return res.status(404).json({ status: 'error', message: 'No such plan' });
  if (!plan.file_id) {
    return res.status(409).json({
      status: 'error',
      message: `Plan ${req.params.id} has no workbook (status: ${plan.status}).`
    });
  }

  const buffer = await planStorage.downloadPlan(plan.file_id);
  res.setHeader('Content-Type', planStorage.XLSX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="${plan.file_name}"`);
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
}));

// GET /plans/:id
router.get('/:id(\\d+)', wrap(async (req, res) => {
  const plan = await one(
    `select id, deal_id, status, plan, flags, grand_total, file_name, file_url,
            model, error, created_at, completed_at
       from app.plans where id = $1`,
    [req.params.id]
  );
  if (!plan) return res.status(404).json({ status: 'error', message: 'No such plan' });
  res.status(200).json({ status: 'ok', plan });
}));

// GET /plans - recent, newest first.
router.get('/', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const { rows } = await query(
    `select id, deal_id, status, grand_total, file_name, file_url, model,
            jsonb_array_length(flags) as flag_count, created_at, completed_at
       from app.plans
      order by id desc limit $1`,
    [limit]
  );
  res.status(200).json({ status: 'ok', count: rows.length, plans: rows });
}));

module.exports = router;

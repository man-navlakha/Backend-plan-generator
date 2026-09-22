/**
 * Turns the CRM's free-text client brief into the structured fields consumed by
 * the plan engine. The model extracts; the server validates. In particular, a
 * missing client name or budget is never invented just to make a plan run.
 */

const OpenAI = require('openai');

const MODEL = process.env.OPENAI_BRIEF_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini';

let client = null;
function openai() {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error('OPENAI_API_KEY is not set.');
    error.status = 503;
    error.code = 'openai_not_configured';
    throw error;
  }
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

function isConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

const CLIENT_BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    company: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'The client or company name exactly as stated. Null when it is not stated.'
    },
    budget: {
      anyOf: [{ type: 'number' }, { type: 'null' }],
      description: 'The planning ceiling in Indian rupees. For a stated range, use its upper value.'
    },
    budget_min: {
      anyOf: [{ type: 'number' }, { type: 'null' }],
      description: 'Lower end of an explicitly stated budget range, otherwise null.'
    },
    budget_max: {
      anyOf: [{ type: 'number' }, { type: 'null' }],
      description: 'Upper end of an explicitly stated budget range, otherwise null.'
    },
    campaign_objective: {
      anyOf: [{ type: 'string' }, { type: 'null' }]
    },
    target_audience: {
      anyOf: [{ type: 'string' }, { type: 'null' }]
    },
    target_locations: {
      type: 'array',
      items: { type: 'string' }
    },
    remarks_for_media: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'Media requirements, constraints, preferences, dates, and other planning details.'
    },
    duration_months: {
      anyOf: [{ type: 'integer' }, { type: 'null' }],
      description: 'Campaign duration in whole months only when explicitly stated or directly convertible.'
    },
    service_conflict: {
      type: 'boolean',
      description: 'True only when the brief explicitly asks for media that contradicts requested_service.'
    },
    service_conflict_reason: {
      anyOf: [{ type: 'string' }, { type: 'null' }]
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description: 'Ambiguities or conflicts that a planner should know about.'
    }
  },
  required: [
    'company',
    'budget',
    'budget_min',
    'budget_max',
    'campaign_objective',
    'target_audience',
    'target_locations',
    'remarks_for_media',
    'duration_months',
    'service_conflict',
    'service_conflict_reason',
    'warnings'
  ],
  additionalProperties: false
};

const SYSTEM = `You review client media briefs received from a CRM and extract facts for a media
planning system.

Rules:
- Extract only information explicitly present in the client brief. Never invent a company, budget,
  audience, location, objective, duration, date, or requirement.
- Convert Indian budget expressions to rupees: for example, 15 lakh is 1500000 and 1.5 crore is
  15000000. For an explicit range such as 5-7 lakh, return budget_min 500000, budget_max 700000,
  and use the upper value 700000 as budget because it is the spending ceiling. Add a warning that
  the upper end is being used. For a single exact budget, budget_min and budget_max are null. Return
  a null budget only when no usable amount is stated or amounts genuinely contradict each other.
- Keep client constraints and additional planning details in remarks_for_media. Do not silently
  discard dates, exclusions, preferences, deliverables, or special instructions.
- A duration may be converted to whole months only when that conversion is direct. Otherwise leave
  duration_months null and retain the original wording in remarks_for_media.
- Do not evaluate catalog availability and do not choose inventory. A later model does that against
  the agency's rate card.
- The user message contains requested_service separately from client_brief. Set service_conflict true
  only when the brief explicitly requests a different medium. A brief that does not name a medium is
  not a conflict.`;

function cleanText(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned || null;
}

function cleanStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanText).filter(Boolean))];
}

function indianAmount(numberText, unitText) {
  const value = Number(String(numberText || '').replace(/,/g, ''));
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = String(unitText || '').toLowerCase();
  if (/^crore/.test(unit)) return value * 10_000_000;
  if (/^(?:lakh|lac)/.test(unit)) return value * 100_000;
  return value;
}

/**
 * Deterministic support for the common Indian range notation used by CRMs.
 * Requiring lakh/lac/crore prevents an age range such as 20-40 years from
 * being mistaken for money.
 */
function extractBudgetRange(clientBrief) {
  const match = String(clientBrief || '').match(
    /(?:₹|inr\s*|rs\.?\s*)?([\d,.]+)\s*(?:-|–|—|to)\s*(?:₹|inr\s*|rs\.?\s*)?([\d,.]+)\s*(lakhs?|lacs?|crores?)/i
  );
  if (!match) return null;

  const first = indianAmount(match[1], match[3]);
  const second = indianAmount(match[2], match[3]);
  if (!first || !second) return null;

  return {
    minimum: Math.min(first, second),
    maximum: Math.max(first, second)
  };
}

/** Normalize model output again at the trust boundary. */
function normalizeReview(value) {
  const suppliedBudget = Number(value?.budget);
  const suppliedMin = Number(value?.budget_min);
  const suppliedMax = Number(value?.budget_max);
  const duration = Number(value?.duration_months);
  const budgetMin = Number.isFinite(suppliedMin) && suppliedMin > 0 ? suppliedMin : null;
  const budgetMax = Number.isFinite(suppliedMax) && suppliedMax > 0 ? suppliedMax : null;
  const budget =
    Number.isFinite(suppliedBudget) && suppliedBudget > 0
      ? suppliedBudget
      : budgetMax;

  const brief = {
    company: cleanText(value?.company),
    budget: Number.isFinite(budget) && budget > 0 ? budget : null,
    budget_min: budgetMin,
    budget_max: budgetMax,
    campaign_objective: cleanText(value?.campaign_objective),
    target_audience: cleanText(value?.target_audience),
    target_locations: cleanStringArray(value?.target_locations),
    remarks_for_media: cleanText(value?.remarks_for_media),
    duration_months:
      Number.isInteger(duration) && duration > 0 ? duration : undefined
  };

  const missingFields = [];
  if (!brief.company) missingFields.push('company');
  if (!brief.budget) missingFields.push('budget');

  return {
    brief,
    missing_fields: missingFields,
    service_conflict: value?.service_conflict === true,
    service_conflict_reason: cleanText(value?.service_conflict_reason),
    warnings: cleanStringArray(value?.warnings)
  };
}

async function reviewClientBrief(clientBrief, options = {}) {
  const api = options.client || openai();
  const model = options.model || MODEL;

  const response = await api.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: JSON.stringify({
          requested_service: options.service || null,
          client_brief: clientBrief
        })
      }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'crm_client_brief',
        schema: CLIENT_BRIEF_SCHEMA,
        strict: true
      }
    }
  });

  const message = response.choices?.[0]?.message;
  if (message?.refusal) {
    const error = new Error('The client brief could not be reviewed by the model.');
    error.status = 422;
    error.code = 'brief_review_refused';
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(message?.content || '{}');
  } catch {
    const error = new Error('The model returned an invalid client brief review.');
    error.status = 502;
    error.code = 'invalid_brief_review';
    throw error;
  }

  const normalized = normalizeReview(parsed);
  const deterministicRange = extractBudgetRange(clientBrief);
  if (deterministicRange) {
    normalized.brief.budget_min = deterministicRange.minimum;
    normalized.brief.budget_max = deterministicRange.maximum;
    normalized.brief.budget = deterministicRange.maximum;
    normalized.missing_fields = normalized.missing_fields.filter((field) => field !== 'budget');
    normalized.warnings = cleanStringArray([
      ...normalized.warnings,
      `Budget is a range; ${deterministicRange.maximum.toLocaleString('en-IN')} rupees ` +
        'is used as the planning ceiling.'
    ]);
  }

  return {
    ...normalized,
    model,
    usage: {
      prompt_tokens: response.usage?.prompt_tokens || 0,
      completion_tokens: response.usage?.completion_tokens || 0
    }
  };
}

module.exports = {
  reviewClientBrief,
  normalizeReview,
  extractBudgetRange,
  isConfigured,
  MODEL,
  CLIENT_BRIEF_SCHEMA
};

/**
 * The model step: reading the brief and the shortlist, and deciding what to buy.
 *
 * Two hard boundaries, both enforced here rather than trusted to the prompt:
 *
 *   1. The model returns ids and quantities. It never returns a rate, a total
 *      or any rupee figure. cost.js computes money from the master, so a
 *      hallucinated number has nowhere to enter the plan.
 *   2. Every id it returns is checked against the catalog before it is used. A
 *      made-up price_option_id is rejected with a message the model can act on,
 *      not quietly dropped.
 *
 * The shortlist arrives in the prompt. When it is not enough -- a city the
 * prefetch missed, a medium the brief hinted at -- the model calls the same
 * catalog functions the rest of the codebase uses, through the tools below.
 * Every call is recorded: when a plan quotes the wrong thing, the only way to
 * find out why is to see what was searched and what came back.
 */

const OpenAI = require('openai');
const { searchProducts, getPriceOptions, citiesForMedia } = require('../catalog/search');
const { isInventory } = require('./mode');

const MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
const MAX_TOOL_ROUNDS = Number(process.env.PLAN_MAX_TOOL_ROUNDS || 6);

let client = null;
function openai() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set.');
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

function isConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

// ───────────────────────────── tools ─────────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_products',
      description:
        'Search the media catalog. Use when the shortlist does not cover something the brief asks ' +
        'for -- another city, another medium, a cheaper or dearer tier. Returns products with their ' +
        'price options attached.',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Free text, e.g. "auto branding lucknow". Tolerates typos.' },
          media_type: { type: 'string', description: 'Catalog media slug, e.g. bus, auto, cinema, fm_radio.' },
          city: { type: 'string' },
          state: { type: 'string' },
          max_rate: { type: 'number', description: 'Exclude options priced above this per unit.' },
          limit: { type: 'integer', description: 'Default 20, maximum 50.' }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_price_options',
      description:
        'Every price option for one product, including ones the search trimmed. Use before ' +
        'committing to a product whose shortlisted options do not fit.',
      parameters: {
        type: 'object',
        properties: { product_id: { type: 'integer' } },
        required: ['product_id'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cities_for_media',
      description:
        'Which cities carry a medium, with their rate range. Use when the brief names a city the ' +
        'catalog does not have, to find what is actually nearby.',
      parameters: {
        type: 'object',
        properties: {
          media_type: { type: 'string' },
          limit: { type: 'integer', description: 'Default 25.' }
        },
        required: ['media_type'],
        additionalProperties: false
      }
    }
  }
];

/** Runs one tool call and returns what the model should see. */
async function runTool(name, args) {
  switch (name) {
    case 'search_products': {
      const found = await searchProducts({
        q: args.q,
        mediaType: args.media_type,
        city: args.city,
        state: args.state,
        maxRate: args.max_rate,
        limit: Math.min(args.limit || 20, 50)
      });
      return { count: found.length, products: found.map(compactProduct) };
    }
    case 'get_price_options': {
      const options = await getPriceOptions(args.product_id);
      return { count: options.length, price_options: options.map(compactOption) };
    }
    case 'cities_for_media': {
      const cities = await citiesForMedia(args.media_type, Math.min(args.limit || 25, 100));
      return { count: cities.length, cities };
    }
    default:
      return { error: `Unknown tool "${name}".` };
  }
}

// ───────────────────────────── shaping ─────────────────────────────

/**
 * What the model sees of a product.
 *
 * Descriptions, meta titles and image paths are dropped -- they are most of the
 * bytes and none of the decision. What is kept is what a buy turns on: the
 * rate, the unit, the minimum and the spec.
 */
function compactProduct(product) {
  return {
    product_id: product.id,
    name: product.name,
    media_type: product.media_type,
    city: product.city,
    state: product.state,
    attrs: trimAttrs(product.attrs),
    price_options: (product.price_options || []).map(compactOption)
  };
}

function compactOption(option) {
  const units = (option.units || [])
    .map((u) => ({ unit: u.unit, minimum: u.minimum, step: u.step }))
    .filter((u) => u.unit);

  return {
    price_option_id: option.id,
    sku: option.sku,
    name: option.name,
    offer_rate: option.offer_rate,
    discounted_rate: option.discounted_rate,
    buying_rate: option.buying_rate,
    minimum_billing: option.minimum_billing,
    pricing_unit: option.pricing_unit,
    gst: option.gst,
    on_request: option.on_request,
    spec: trimAttrs(option.attrs),
    units: units.length ? units : undefined,
    addons: (option.addons || []).length ? option.addons : undefined
  };
}

function trimAttrs(attrs) {
  if (!attrs || typeof attrs !== 'object') return undefined;
  const out = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === '' || value === undefined) continue;
    if (String(value).length > 120) continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

// ───────────────────────────── the call ─────────────────────────────

const SELECTION_SCHEMA = {
  type: 'object',
  properties: {
    selections: {
      type: 'array',
      description: 'The lines to quote. Empty if nothing in the catalog suits the brief.',
      items: {
        type: 'object',
        properties: {
          product_id: { type: 'integer' },
          price_option_id: { type: 'integer' },
          qty: { type: 'integer', description: 'Units: buses, autos, screens, spots.' },
          months: {
            type: 'integer',
            description:
              'Billing-period multiplier. For per-week rates use campaign weeks; for per-month rates use campaign months; otherwise use 1.'
          },
          why: { type: 'string', description: 'One sentence: why this option, this quantity.' }
        },
        required: ['product_id', 'price_option_id', 'qty', 'months', 'why'],
        additionalProperties: false
      }
    },
    reasoning: {
      type: 'array',
      description: 'How the budget was split and what was deliberately left out.',
      items: { type: 'string' }
    },
    concerns: {
      type: 'array',
      description: 'Anything the desk must check before this plan goes to the client.',
      items: { type: 'string' }
    }
  },
  required: ['selections', 'reasoning', 'concerns'],
  additionalProperties: false
};

const SYSTEM = `You are a media planner at an Indian out-of-home advertising agency, building a
media plan from a client brief against the agency's own rate card.

You choose WHAT to buy and HOW MUCH. You never calculate money.

Rules you must follow:
- Return only product_id, price_option_id, qty and months. Never a rate, a total or any rupee figure.
  Costs are computed downstream from the rate card; any number you invent would be wrong.
- Only use ids that appear in the shortlist or in a tool result. Never guess an id.
- Respect minimum_billing and the unit minimums. A quantity below a stated minimum cannot be bought.
- The months field is the billing-period multiplier, despite its legacy name. If pricing_unit says per week,
  set it to the requested duration_weeks (a four-week Cinema campaign uses months=4). If pricing_unit
  says per month, use duration_months. Use 1 only when the price has no duration unit.
- For Cinema, qty is the ad-film or slide length in seconds. Use creative_duration_seconds when stated;
  otherwise use the Cinema standard of 10 seconds. Spend additional budget by selecting more suitable
  screens or properties, never by silently lengthening the creative.
- For Cinema, your selections form the "Recommended Plan" sheet. The workbook separately includes every
  matching priced screen in the client's requested locations, so recommend the strongest balanced buy from
  that inventory. Cover every requested city that has inventory; do not spend the whole budget in one city
  and omit another requested city. Prioritise named chains, venues and catchments. If the budget cannot buy
  at least one suitable screen in every requested city, explain that in concerns instead of substituting a city.
- SPEND THE BUDGET. The client has allocated this money and expects a plan that uses it. Aim to land
  between 85% and 97% of the budget. A plan that spends a fraction of what was allocated is a failed
  plan -- it will be rejected and reworked. Before you answer, add up roughly what your selections
  cost (rate x qty x months, summed) and if it is well under the budget, increase quantities or move
  to a higher-value option until it is not.
- The budget is inclusive of 18% GST unless the brief says otherwise, so your pre-tax total should be
  about budget / 1.18. For a 15,00,000 budget that is roughly 12,70,000 of inventory.
- Prefer scale on a strong option over a token quantity of many. 100 buses on the main city route
  beats 15 buses and a handful of everything else.
- Spread across media only where it serves the brief. Two media bought properly beat four bought thinly.
- Transit and outdoor need at least 2 months to work. Radio, cinema and digital are bought in bursts.
- If the brief asks for a city or a medium the catalog does not carry, say so in concerns.
  Do not substitute another city silently.
- For Magazine, every title in requested_publications is mandatory. Select its exact catalog title
  when present; never replace it with a similarly named publication.
- If the shortlist is not enough, call the tools before deciding.`;

/*
 * The no-budget counterpart. The costed prompt above is organised around
 * spending a number; with no number to spend, every instruction built on it
 * misleads -- so the task is restated rather than patched.
 *
 * The job here is curation: a representative spread the desk can send as an
 * options list, not a purchase. Quantity and duration still come back because
 * the sheet quotes a rate for a stated creative length and flight.
 */
const SYSTEM_INVENTORY = `You are a media planner at an Indian out-of-home advertising agency,
drawing up a list of available inventory from the agency's own rate card.

The client has NOT stated a budget. You are not buying anything. You are choosing what to SHOW:
an options list the desk sends so the client can pick from it.

Rules you must follow:
- Return only product_id, price_option_id, qty and months. Never a rate, a total or any rupee figure.
- Only use ids that appear in the shortlist or in a tool result. Never guess an id.
- There is no budget. Never leave inventory out because it looks expensive, and never try to hit
  a total. Cost is not your concern here.
- If the brief explicitly asks for a minimum-cost or low-budget proposal, prefer the lowest suitable
  rates among the requested inventory. There is still no spending ceiling, so do not invent one.
- Cover every city the brief asks for. A city the catalog carries and your list omits reads to the
  client as a city we cannot serve. If the catalog genuinely has nothing in a city, say so in concerns.
- Within each city, give a spread the client can actually choose between: different properties,
  and across theatre types and audience classes where the shortlist has them. Prefer breadth of
  venue over every screen in one multiplex -- two or three audis from a property is usually enough
  to show what it offers.
- Aim for a sheet a client will read: roughly 100 to 180 rows across all cities. Weight the count
  towards the larger markets rather than splitting it evenly.
- Magazine is the exception: make a concise proposal of roughly 4 to 10 rows. Include every exact
  requested publication, then add only closely relevant recommendations. A title may have more than
  one useful inside-page size, but do not pad the proposal with every cover position in the catalog.
- For Cinema, one selection is one screen, so qty and months do not vary the row count. Set qty to the
  creative length in seconds (creative_duration_seconds, else the Cinema standard of 10) and
  months to the campaign duration in the unit the rate uses -- duration_weeks for a per-week rate.
- For Cinema, your selections are recommendations shown on a separate "Recommended Plan" sheet. The
  workbook also carries the complete matching priced inventory so the client can make a different choice.
  Recommend a balanced spread across every requested city and prioritise named chains, venues and catchments.
- If the brief names a chain, a theatre type or a catchment, honour it. Do not pad the list with
  inventory the brief excluded.
- For Magazine, every title in requested_publications is mandatory. Select its exact catalog title
  when present; never replace it with a similarly named publication.`;

/**
 * Asks the model for selections.
 *
 * Returns the same shape as the deterministic selector, plus what it cost and
 * what it looked at, so a plan can be audited after the fact.
 */
async function selectWithModel(brief, prefetch, options = {}) {
  const maxRounds = options.maxToolRounds ?? MAX_TOOL_ROUNDS;
  const toolCalls = [];

  const inventory = isInventory(brief);
  const messages = [
    { role: 'system', content: inventory ? SYSTEM_INVENTORY : SYSTEM },
    {
      role: 'user',
      content: JSON.stringify(
        {
          brief: {
            company: brief.company,
            service: brief.service,
            budget: inventory ? undefined : brief.budget,
            budget_range:
              !inventory && brief.budget_min && brief.budget_max
                ? { minimum: brief.budget_min, maximum: brief.budget_max }
                : null,
            no_budget_stated: inventory || undefined,
            objective: brief.campaign_objective,
            audience: brief.target_audience,
            locations: brief.target_locations,
            preferred_catchments: brief.preferred_catchments || [],
            duration_months: brief.duration_months || null,
            duration_weeks: brief.duration_weeks || null,
            creative_duration_seconds: brief.creative_duration_seconds || null,
            remarks: brief.remarks_for_media,
            requested_publications: brief.requested_publications || [],
            // The CRM route keeps the original wording as well as the extracted
            // fields so unusual constraints are not lost between the two model
            // stages. The structured fields above remain the planning contract.
            client_brief: brief.client_brief || null
          },
          catalog_notes: prefetch.notes,
          shortlist: prefetch.candidates.map(compactProduct)
        },
        null,
        1
      )
    }
  ];

  let usage = { prompt_tokens: 0, completion_tokens: 0 };

  for (let round = 0; round <= maxRounds; round += 1) {
    const isFinalRound = round === maxRounds;

    const response = await openai().chat.completions.create({
      model: MODEL,
      messages,
      // On the last round the tools are withdrawn so the model must answer.
      ...(isFinalRound ? {} : { tools: TOOLS }),
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'plan_selection', schema: SELECTION_SCHEMA, strict: true }
      }
    });

    usage.prompt_tokens += response.usage?.prompt_tokens || 0;
    usage.completion_tokens += response.usage?.completion_tokens || 0;

    const message = response.choices[0].message;
    messages.push(message);

    const calls = message.tool_calls || [];
    if (calls.length === 0) {
      const parsed = JSON.parse(message.content || '{}');
      return {
        selections: parsed.selections || [],
        reasoning: parsed.reasoning || [],
        concerns: parsed.concerns || [],
        strategy: 'model',
        model: MODEL,
        usage,
        tool_calls: toolCalls
      };
    }

    for (const call of calls) {
      const started = Date.now();
      let args = {};
      let result;
      try {
        args = JSON.parse(call.function.arguments || '{}');
        result = await runTool(call.function.name, args);
      } catch (error) {
        result = { error: error.message };
      }
      toolCalls.push({
        tool: call.function.name,
        args,
        rows_returned: result?.count ?? null,
        duration_ms: Date.now() - started,
        error: result?.error || null
      });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result)
      });
    }
  }

  return {
    selections: [],
    reasoning: [`Model used all ${maxRounds} tool rounds without returning a selection.`],
    concerns: [],
    strategy: 'model',
    model: MODEL,
    usage,
    tool_calls: toolCalls
  };
}

module.exports = { selectWithModel, isConfigured, MODEL, TOOLS, compactProduct, compactOption };

/**
 * Choosing what goes in the plan.
 *
 * This is the one step a model is meant to do: read the brief and the
 * shortlist, and say which SKUs, how many units, for how long. It returns
 * selections only -- {price_option_id, qty, months} -- never money. Costing
 * happens afterwards in cost.js from rates that came out of the master.
 *
 * Until OPENAI_API_KEY is set, `selectLines` falls back to a deterministic
 * strategy. That is not a placeholder to be embarrassed about: it makes the
 * whole pipeline runnable and testable today, and it is the baseline a model
 * has to beat. If the model's plan is worse than this, that is worth knowing.
 */

const { chooseRate, quantityFloor, unitsForBudget, costLine } = require('./cost');
const { isInventory } = require('./mode');
const { selectWithModel, MODEL } = require('./model');
const { loadRules } = require('../rules');
const log = require('../log');

// How the budget is split when a brief covers several media. Front-loading the
// first medium reflects how the desk actually buys: one medium carries the
// campaign and the rest add reach.
const SPLIT = [0.55, 0.25, 0.12, 0.08];

function isModelConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Picks the strongest price option for a product.
 *
 * "Strongest" means the dearest option that the budget can still buy a sensible
 * quantity of -- a plan built from the cheapest option of everything reads as a
 * cheap plan, and the desk will not send it.
 */
function bestOption(product, budget, months) {
  const options = (product.price_options || []).filter((o) => {
    const { rate } = chooseRate(o);
    return rate !== null && rate > 0;
  });
  if (options.length === 0) return null;

  const affordable = options.filter((o) => unitsForBudget(o, budget, months) >= 1);
  const pool = affordable.length ? affordable : options;

  return pool.reduce((best, option) => {
    const { rate } = chooseRate(option);
    const { rate: bestRate } = chooseRate(best);
    return rate > bestRate ? option : best;
  }, pool[0]);
}

/**
 * Duration for a medium, in months.
 *
 * Outdoor and transit work on repeat exposure and are not worth buying for less
 * than two months; broadcast and digital are bought by the burst. The brief can
 * override with `duration_months`.
 */
function monthsFor(mediaType, brief) {
  const weeks = Number(brief.duration_weeks);
  if (/cinema/.test(mediaType) && Number.isFinite(weeks) && weeks > 0) {
    return Math.trunc(weeks);
  }
  const stated = Number(brief.duration_months);
  if (Number.isFinite(stated) && stated > 0) return Math.trunc(stated);
  if (/train|bus|auto|rickshaw|tricycle|cab|van|metro/.test(mediaType)) return 2;
  return 1;
}

function cinemaCreativePreference(brief = {}) {
  const text = [brief.remarks_for_media, brief.client_brief].filter(Boolean).join(' ').toLowerCase();
  if (/creative(?:\s+type)?[^:\n.]*[:\-]\s*(?:feature\s+)?video\b/.test(text)) return 'video';
  if (/creative(?:\s+type)?[^:\n.]*[:\-]\s*(?:slide\s*show|slide|static)\b/.test(text)) return 'slide';
  if (/\b(?:video|ad\s*film)\b/.test(text)) return 'video';
  if (/\b(?:slide\s*show|slide|static)\b/.test(text)) return 'slide';
  return null;
}

function cinemaScreenKey(product, option) {
  const match = /\bSCREEN[-_\s]*(\d+)/i.exec(option?.name || option?.sku || '');
  return match ? `${product.id}:${match[1]}` : `${product.id}:${option.id}`;
}

function cinemaFormatScore(option, preference) {
  const text = `${option?.template || ''} ${option?.name || ''} ${option?.sku || ''}`.toLowerCase();
  const video = /ad\s*film|adfilm|video/.test(text);
  const slide = /slide|static/.test(text);
  if (preference === 'video') return video ? 3 : slide ? 0 : 1;
  if (preference === 'slide') return slide ? 3 : video ? 0 : 1;
  return video ? 2 : slide ? 1 : 0;
}

function cinemaProductionGross() {
  const billing = loadRules('Cinema').billing || {};
  const net = (Number(billing.making_conversion_cost_per_creative) || 0) *
    Math.max(1, Math.trunc(Number(billing.default_creatives) || 1));
  return net * (1 + (Number(billing.gst_rate) || 18) / 100);
}

function cinemaCommercialMultiplier() {
  const value = Number(loadRules('Cinema').billing?.listed_value_multiplier);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function cinemaUsesReferenceBudget(brief = {}) {
  const behavior = String(brief.budget_behavior || brief.budget_behaviour || '').toLowerCase();
  return !/^(?:hard|hard_ceiling|strict|strict_ceiling|do_not_exceed)$/.test(behavior);
}

function cinemaPreferenceScore(product, brief, modelScreens, screen) {
  let score = modelScreens.has(screen) ? 1000 : 0;
  const productText = `${product.name || ''} ${product.locality || ''} ` +
    `${product.attrs?.cinema_chain || ''}`.toLowerCase();
  const requestedText = [
    ...(brief.preferred_catchments || []),
    brief.remarks_for_media,
    brief.client_brief
  ].filter(Boolean).join(' ').toLowerCase();

  for (const chain of ['pvr', 'inox', 'cinepolis', 'miraj']) {
    if (requestedText.includes(chain) && productText.includes(chain)) score += 80;
  }
  for (const catchment of brief.preferred_catchments || []) {
    const words = String(catchment).toLowerCase().match(/[a-z0-9]+/g) || [];
    score += words.filter((word) => word.length >= 4 && productText.includes(word)).length * 12;
  }
  if (/icon|platinum/i.test(product.attrs?.audience_class || '')) score += 8;
  else if (/gold/i.test(product.attrs?.audience_class || '')) score += 4;
  return score;
}

function cinemaCandidates(brief, products, modelSelections = []) {
  const byProduct = new Map(products.map((product) => [Number(product.id), product]));
  const modelScreens = new Set();
  for (const pick of modelSelections || []) {
    const product = byProduct.get(Number(pick.product_id));
    const option = product?.price_options?.find((item) => Number(item.id) === Number(pick.price_option_id));
    if (product && option) modelScreens.add(cinemaScreenKey(product, option));
  }

  const preference = cinemaCreativePreference(brief);
  const qty = Math.max(1, Math.trunc(Number(brief.creative_duration_seconds) || 10));
  const candidates = [];
  for (const product of products) {
    const grouped = new Map();
    for (const option of product.price_options || []) {
      const key = cinemaScreenKey(product, option);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(option);
    }
    for (const [screen, options] of grouped) {
      const option = [...options].sort((a, b) => {
        const format = cinemaFormatScore(b, preference) - cinemaFormatScore(a, preference);
        if (format) return format;
        return (chooseRate(a).rate || Infinity) - (chooseRate(b).rate || Infinity);
      })[0];
      const months = monthsFor(product.media_type, brief);
      const line = costLine(option, {
        qty,
        months,
        product,
        commercialMultiplier: cinemaCommercialMultiplier()
      });
      if (line.error) continue;
      candidates.push({
        product,
        option,
        screen,
        gross: Number(line.total) || 0,
        score: cinemaPreferenceScore(product, brief, modelScreens, screen),
        pick: {
          product_id: Number(product.id),
          price_option_id: Number(option.id),
          media_type: product.media_type,
          qty,
          months,
          why: 'Geography-first Cinema recommendation in a client-requested market.'
        }
      });
    }
  }
  return candidates;
}

/** Human-style proposal: relevant screens in requested cities, independent of budget. */
function selectRecommendedCinema(brief, prefetch, modelSelections = [], inventoryProducts = null) {
  const source = inventoryProducts?.length ? inventoryProducts : (prefetch.candidates || []);
  const products = source.filter((product) =>
    /cinema/.test(String(product.media_type || '').toLowerCase())
  );
  if (!products.length) return null;
  const candidates = cinemaCandidates(brief, products, modelSelections);
  const resolvedCities = (prefetch.locations || []).filter((location) => location.match === 'city');
  const market = (value) => String(value || '').toLowerCase().replace(/^gurgaon$/, 'gurugram').trim();
  const allowed = new Set(resolvedCities.map((location) =>
    `${market(location.city)}|${market(location.state)}`
  ));
  const relevant = allowed.size
    ? candidates.filter((candidate) =>
        allowed.has(`${market(candidate.product.city)}|${market(candidate.product.state)}`)
      )
    : candidates;
  const configuredSource = loadRules('Cinema').billing?.recommended_inventory_source;
  const sourceRelevant = configuredSource === 'pan_india_2025'
    ? relevant.filter((candidate) =>
        candidate.product.attrs?.source_file === configuredSource ||
        candidate.product.attrs?.linked_screen_code
      )
    : relevant;
  const planned = sourceRelevant.length ? sourceRelevant : relevant;
  planned.sort((a, b) => {
    const cityA = market(a.product.city);
    const cityB = market(b.product.city);
    const cityOrderA = resolvedCities.findIndex((location) => market(location.city) === cityA);
    const cityOrderB = resolvedCities.findIndex((location) => market(location.city) === cityB);
    return cityOrderA - cityOrderB || b.score - a.score || b.gross - a.gross;
  });
  if (!planned.length) return null;
  return {
    selections: planned.map((candidate) => ({
      ...candidate.pick,
      planner_fields: configuredSource ? { cinema_rate_card: configuredSource } : null
    })),
    reasoning: [
      `Recommended Media Plan: ${planned.length} relevant screen(s) across requested cities; budget is treated as a reference, not a geography-cutting ceiling.`,
      ...(configuredSource ? [`Recommendation priced from the approved ${configuredSource} Cinema rate-card footprint.`] : []),
      'Preferred chains are prioritised inside each requested city; another city is never substituted to satisfy a chain preference.'
    ]
  };
}

function parseAudienceSize(value) {
  const text = String(value || '').toLowerCase().replace(/,/g, '').trim();
  if (!text) return null;
  const match = /([\d.]+)\s*(k|l|lac|lakh|m|mn|million)?/.exec(text);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const unit = match[2] || '';
  if (unit === 'k') return base * 1000;
  if (unit === 'l' || unit === 'lac' || unit === 'lakh') return base * 100000;
  if (unit === 'm' || unit === 'mn' || unit === 'million') return base * 1000000;
  return base;
}

function radioRank(product) {
  const rank = Number(product.attrs?.rank ?? product.attrs?.Rank ?? product.rank);
  return Number.isFinite(rank) && rank > 0 ? rank : null;
}

function radioListenership(product) {
  return parseAudienceSize(
    product.attrs?.listenership ??
    product.attrs?.Listenership ??
    product.listenership
  );
}

function radioStationName(product) {
  return product.attrs?.station || product.attrs?.Station || product.name || 'Radio station';
}

function radioCityPriority(product, brief, indexFallback = 0) {
  const requested = (brief.target_locations || [])
    .map((value) => String(value || '').toLowerCase().trim())
    .filter(Boolean);
  if (!requested.length) return Math.max(35, 75 - indexFallback * 8);

  const city = String(product.city || '').toLowerCase();
  const state = String(product.state || '').toLowerCase();
  const exactIndex = requested.findIndex((value) => value === city);
  if (exactIndex >= 0) return Math.max(55, 100 - exactIndex * 15);
  const stateIndex = requested.findIndex((value) => value === state);
  if (stateIndex >= 0) return Math.max(45, 85 - stateIndex * 10);
  return 25;
}

function radioMarketAllowed(product, brief) {
  const requested = (brief.target_locations || [])
    .map((value) => String(value || '').toLowerCase().trim())
    .filter(Boolean);
  if (!requested.length) return true;
  const city = String(product.city || '').toLowerCase();
  const state = String(product.state || '').toLowerCase();
  return requested.includes(city) || requested.includes(state);
}

function isRadioProduct(product) {
  return /(?:^|_)radio$|private_radio|fm_radio/.test(String(product.media_type || '').toLowerCase());
}

function radioScore(product, option, brief, context) {
  const audience = radioListenership(product);
  const rank = radioRank(product);
  const { rate } = chooseRate(option);
  const audienceScore = audience && context.maxAudience
    ? Math.min(100, (audience / context.maxAudience) * 100)
    : 50;
  const rankScore = rank ? Math.max(0, Math.min(100, 110 - rank * 18)) : 50;
  const efficiencyScore = rate && context.minRate
    ? Math.min(100, (context.minRate / rate) * 100)
    : 50;
  const cityScore = radioCityPriority(product, brief, context.cityOrder.get(locationKey(product.city)) || 0);
  return roundScore(
    audienceScore * 0.40 +
    rankScore * 0.30 +
    efficiencyScore * 0.20 +
    cityScore * 0.10
  );
}

function roundScore(value) {
  return Math.round(value * 10) / 10;
}

function locationKey(value) {
  return String(value || '').toLowerCase().trim();
}

function objectiveLabel(brief) {
  const text = `${brief.campaign_objective || ''} ${brief.remarks_for_media || ''} ${brief.client_brief || ''}`.toLowerCase();
  if (/launch|store|opening/.test(text)) return 'launch support';
  if (/lead|enquir|conversion|sales/.test(text)) return 'lead generation';
  if (/rural|district|penetration/.test(text)) return 'regional penetration';
  if (/dominance|dominate|share of voice/.test(text)) return 'city dominance';
  return 'brand awareness';
}

function selectRadioPlanner(brief, prefetch) {
  const budget = Number(brief.budget) || 0;
  if (budget <= 0) return null;
  const allCandidates = prefetch.candidates || [];
  if (!allCandidates.length || !allCandidates.every(isRadioProduct)) return null;
  const products = allCandidates.filter((product) => radioMarketAllowed(product, brief));
  if (!products.length) return null;

  const optionRows = [];
  for (const product of products) {
    for (const option of product.price_options || []) {
      const { rate } = chooseRate(option);
      if (rate && rate > 0) optionRows.push({ product, option, rate });
    }
  }
  if (!optionRows.length) return null;

  const audiences = optionRows.map(({ product }) => radioListenership(product)).filter(Boolean);
  const cityOrder = new Map();
  [...new Set(products.map((product) => locationKey(product.city)).filter(Boolean))]
    .forEach((city, index) => cityOrder.set(city, index));
  const context = {
    maxAudience: audiences.length ? Math.max(...audiences) : null,
    minRate: Math.min(...optionRows.map((row) => row.rate)),
    cityOrder
  };

  const ranked = optionRows
    .map((row) => ({ ...row, score: radioScore(row.product, row.option, brief, context) }))
    .sort((a, b) => b.score - a.score || a.rate - b.rate);

  const bestByCity = [];
  const usedCities = new Set();
  for (const row of ranked) {
    const city = locationKey(row.product.city);
    if (city && usedCities.has(city)) continue;
    usedCities.add(city);
    bestByCity.push(row);
    if (bestByCity.length >= 6) break;
  }
  if (!bestByCity.length) return null;

  const objective = objectiveLabel(brief);
  const days = Math.max(7, Math.trunc(Number(brief.duration_days || brief.days) || 30));
  const spotSeconds = Math.max(5, Math.trunc(Number(brief.creative_duration_seconds) || 10));
  const baseSpots = objective === 'city dominance'
    ? [18, 14, 10, 8, 6, 5]
    : objective === 'lead generation'
      ? [12, 10, 8, 6, 5, 5]
      : [15, 12, 8, 5, 5, 5];

  const selected = bestByCity.map((row, index) => ({
    ...row,
    spotsPerDay: baseSpots[index] || 5
  }));

  const grossFor = (rows) => rows.reduce((sum, row) => {
    const qty = spotSeconds * row.spotsPerDay * days;
    const line = costLine(row.option, { qty, months: 1, product: row.product });
    return line.error ? sum : sum + Number(line.total || 0);
  }, 0);

  let gross = grossFor(selected);
  const ceiling = budget * 0.97;
  while (gross > ceiling && selected.some((row) => row.spotsPerDay > 5)) {
    const row = [...selected].reverse().find((item) => item.spotsPerDay > 5);
    row.spotsPerDay -= 1;
    gross = grossFor(selected);
  }
  while (gross < budget * 0.85) {
    const row = selected.find((item) => item.spotsPerDay < 22);
    if (!row) break;
    row.spotsPerDay += 1;
    const nextGross = grossFor(selected);
    if (nextGross > ceiling) {
      row.spotsPerDay -= 1;
      break;
    }
    gross = nextGross;
  }

  const selections = selected.map((row, index) => {
    const qty = spotSeconds * row.spotsPerDay * days;
    const audience = radioListenership(row.product);
    const rank = radioRank(row.product);
    return {
      product_id: row.product.id,
      price_option_id: row.option.id,
      media_type: row.product.media_type,
      qty,
      months: 1,
      planner_fields: {
        spot_seconds: spotSeconds,
        spots_per_day: row.spotsPerDay,
        days,
        planner_score: row.score,
        planner_priority: index + 1
      },
      why:
        `${radioStationName(row.product)} ${row.product.city || ''}: score ${row.score}` +
        `${audience ? `, listenership ${Math.round(audience).toLocaleString('en-IN')}` : ''}` +
        `${rank ? `, rank #${rank}` : ''}; ${row.spotsPerDay} spots/day for ${objective}.`
    };
  });

  const cityMix = selected
    .map((row) => `${row.product.city || 'Unknown'} ${row.spotsPerDay} spots/day`)
    .join('; ');
  return {
    selections,
    reasoning: [
      `Radio planner mode used objective-first scoring for ${objective}: listenership 40%, rank 30%, cost efficiency 20%, city priority 10%.`,
      `Frequency was weighted by market priority instead of split equally: ${cityMix}.`
    ],
    strategy: 'deterministic_radio_planner'
  };
}

/**
 * A server-checked Cinema recommendation.
 *
 * The model supplies judgement and ranking, but its rough arithmetic can miss
 * minimum billing or omit a requested city. Build a balanced set from the same
 * shortlist, giving the model's screens first preference, then stop below the
 * GST-inclusive budget after reserving the mandatory production charge.
 */
function selectBalancedCinema(brief, prefetch, modelSelections = []) {
  const budget = Number(brief.budget) || 0;
  if (budget <= 0) return null;
  const products = (prefetch.candidates || []).filter((product) =>
    /cinema/.test(String(product.media_type || '').toLowerCase())
  );
  if (!products.length || products.length !== (prefetch.candidates || []).length) return null;

  const candidates = cinemaCandidates(brief, products, modelSelections);

  const resolved = (prefetch.locations || []).filter((location) => location.match !== 'none');
  const marketCity = (value) => String(value || '').toLowerCase().replace(/^gurgaon$/, 'gurugram');
  const locationKey = (location) => `${marketCity(location.city)}|${String(location.state || '').toLowerCase()}`;
  const candidateLocation = (candidate) => `${marketCity(candidate.product.city)}|${String(candidate.product.state || '').toLowerCase()}`;
  const pools = resolved.map((location) => ({
    location,
    candidates: candidates
      .filter((candidate) => {
        if (location.city && marketCity(candidate.product.city) !== marketCity(location.city)) return false;
        if (location.state && String(candidate.product.state).toLowerCase() !== String(location.state).toLowerCase()) return false;
        return true;
      })
      .sort((a, b) => b.score - a.score || a.gross - b.gross)
  }));
  if (!pools.length) {
    pools.push({ location: null, candidates: [...candidates].sort((a, b) => b.score - a.score || a.gross - b.gross) });
  }

  const selected = [];
  const used = new Set();
  let gross = cinemaProductionGross();
  const ceiling = budget * 0.97;
  const addFirstFitting = (pool, required = false) => {
    const ordered = required
      ? [...pool.candidates].sort((a, b) => a.gross - b.gross || b.score - a.score)
      : pool.candidates;
    const candidate = ordered.find((item) =>
      !used.has(item.screen) && gross + item.gross <= (required ? budget : ceiling)
    );
    if (!candidate) return false;
    used.add(candidate.screen);
    selected.push(candidate);
    gross += candidate.gross;
    return true;
  };

  // First guarantee one affordable screen in every requested city.
  for (const pool of pools) addFirstFitting(pool, true);

  // Then add a round-robin spread so one large market cannot consume the plan.
  let added = true;
  while (added) {
    added = false;
    for (const pool of pools) {
      if (addFirstFitting(pool)) added = true;
    }
  }

  if (!selected.length) return null;
  const covered = new Set(selected.map(candidateLocation));
  const missing = pools
    .filter((pool) => pool.location && !covered.has(locationKey(pool.location)))
    .map((pool) => pool.location.requested);
  const reasoning = [
    `Server-balanced Cinema recommendation: ${selected.length} screen(s), including mandatory production charges, within the GST-inclusive budget.`,
    ...(missing.length ? [`Budget could not cover a screen in: ${missing.join(', ')}.`] : [])
  ];
  return { selections: selected.map((candidate) => candidate.pick), reasoning };
}

/**
 * The deterministic selector.
 *
 * One product per medium, the best option on it, quantity sized to that
 * medium's slice of the budget. Deliberately simple and deliberately
 * explainable -- every choice here can be stated in one sentence, which is what
 * makes it a usable baseline.
 */
function selectDeterministic(brief, prefetch) {
  const radio = selectRadioPlanner(brief, prefetch);
  if (radio) return radio;

  const byMedia = new Map();
  for (const product of prefetch.candidates) {
    if (!byMedia.has(product.media_type)) byMedia.set(product.media_type, []);
    byMedia.get(product.media_type).push(product);
  }

  // Media with the deepest inventory first -- that is where the plan has room.
  const media = [...byMedia.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, SPLIT.length);

  const budget = Number(brief.budget) || 0;
  const selections = [];
  const reasoning = [];
  const activeWeight = media.reduce(
    (sum, _entry, index) => sum + (SPLIT[index] ?? SPLIT[SPLIT.length - 1]),
    0
  );

  media.forEach(([mediaType, products], index) => {
    // SPLIT describes relative priority. Normalise it over the media that are
    // actually present so one-medium plans receive the whole budget instead
    // of only the first 55%, and two-medium plans do not strand the last 20%.
    const weight = SPLIT[index] ?? SPLIT[SPLIT.length - 1];
    const share = activeWeight > 0 ? budget * (weight / activeWeight) : 0;
    const months = monthsFor(mediaType, brief);

    // Prefer the highest-value option whose minimum purchasable quantity fits
    // the GST-inclusive share. This matters for Magazine, where each title
    // commonly has one option and the first catalog row may cost more than the
    // share even though many suitable titles are affordable.
    const affordable = [];
    for (const product of products) {
      for (const candidate of product.price_options || []) {
        const { rate: candidateRate } = chooseRate(candidate);
        if (!candidateRate || candidateRate <= 0) continue;
        const { floor: candidateFloor } = quantityFloor(candidate);
        const creativeQty = /cinema/.test(mediaType)
          ? Math.max(1, Math.trunc(Number(brief.creative_duration_seconds) || 10))
          : 1;
        const minimumQty = Math.max(candidateFloor || 1, creativeQty);
        const gst = candidate.gst === null || candidate.gst === undefined || candidate.gst === ''
          ? 18
          : Number(candidate.gst);
        const grossFactor = 1 + (Number.isFinite(gst) ? gst : 18) / 100;
        const minimumCost = candidateRate * months * minimumQty * grossFactor;
        if (minimumCost <= share) affordable.push({ product, option: candidate, rate: candidateRate });
      }
    }
    const choice = affordable.reduce(
      (best, candidate) => !best || candidate.rate > best.rate ? candidate : best,
      null
    );
    const product = choice?.product || products.reduce((best, p) =>
      (p.price_options?.length || 0) > (best.price_options?.length || 0) ? p : best
    , products[0]);
    const option = choice?.option || bestOption(product, share, months);
    if (!option) {
      reasoning.push(`${mediaType}: no option with a usable rate; skipped.`);
      return;
    }

    const { rate } = chooseRate(option);
    const { floor } = quantityFloor(option);
    const gst = option.gst === null || option.gst === undefined || option.gst === ''
      ? 18
      : Number(option.gst);
    const grossFactor = 1 + (Number.isFinite(gst) ? gst : 18) / 100;
    let qty = Math.floor(share / (rate * months * grossFactor));

    // Cinema quantity is creative seconds, not a scalable inventory count.
    // The renderer and server billing boundary use the approved 10-second
    // default unless the brief explicitly states a different creative length.
    if (/cinema/.test(mediaType)) {
      qty = Math.max(1, Math.trunc(Number(brief.creative_duration_seconds) || 10));
    }

    if (floor !== null && qty < floor) {
      // The floor costs more than the share. Take it anyway if the whole budget
      // covers it -- a medium is either bought properly or not at all.
      const floorCost = rate * floor * months * grossFactor;
      if (floorCost <= budget) {
        qty = floor;
        reasoning.push(
          `${mediaType}: raised to the ${floor}-unit minimum, which costs more than its budget share.`
        );
      } else {
        reasoning.push(
          `${mediaType}: the ${floor}-unit minimum costs more than the whole budget; skipped.`
        );
        return;
      }
    }

    if (qty < 1) {
      reasoning.push(`${mediaType}: budget share does not buy a single unit; skipped.`);
      return;
    }

    selections.push({
      product_id: product.id,
      price_option_id: option.id,
      media_type: mediaType,
      qty,
      months,
      why:
        `${qty} x ${option.name} at ${rate}/${option.pricing_unit || 'unit'}` +
        `${months > 1 ? ` for ${months} months` : ''}, sized to ${Math.round(share).toLocaleString('en-IN')} ` +
        `of the ${Math.round(budget).toLocaleString('en-IN')} budget.`
    });
  });

  return { selections, reasoning, strategy: 'deterministic' };
}

/**
 * The no-budget baseline: list what matches, do not choose between it.
 *
 * Used when the model is unavailable or its answer was unusable. It cannot
 * curate the way the model does, so it does the one honest thing a rule can do
 * -- take every priced option, nearest the top of the shortlist first, up to a
 * cap that keeps the sheet readable. The desk trims. Silently dropping venues
 * by some invented measure of quality would be worse than a long list.
 */
const INVENTORY_ROW_CAP = Number(process.env.PLAN_INVENTORY_ROW_CAP || 500);

function selectInventory(brief, prefetch) {
  const selections = [];
  const reasoning = [];
  let skippedUnpriced = 0;

  for (const product of prefetch.candidates) {
    const months = monthsFor(product.media_type, brief);
    const qty = /cinema/.test(product.media_type)
      ? Math.max(1, Math.trunc(Number(brief.creative_duration_seconds) || 10))
      : 1;

    for (const option of product.price_options || []) {
      if (selections.length >= INVENTORY_ROW_CAP) break;
      const { rate } = chooseRate(option);
      if (!rate || rate <= 0) { skippedUnpriced += 1; continue; }
      selections.push({
        product_id: product.id,
        price_option_id: option.id,
        media_type: product.media_type,
        qty,
        months,
        why: `Listed as available inventory: ${product.name} - ${option.name}.`
      });
    }
    if (selections.length >= INVENTORY_ROW_CAP) {
      reasoning.push(
        `Listing stopped at the ${INVENTORY_ROW_CAP}-row cap; the shortlist holds more inventory than that.`
      );
      break;
    }
  }

  if (skippedUnpriced) {
    reasoning.push(`${skippedUnpriced} option(s) were left out because the master carries no rate for them.`);
  }
  reasoning.push(`No budget was stated, so ${selections.length} matching screen(s) are listed with their rates rather than bought.`);

  return { selections, reasoning, strategy: 'inventory' };
}

/** The rule-based selector appropriate to the brief's mode. */
function selectWithoutModel(brief, prefetch, options = {}) {
  if (isInventory(brief)) return selectInventory(brief, prefetch);
  const cinema = selectBalancedCinema(brief, prefetch);
  if (cinema) {
    if (cinemaUsesReferenceBudget(brief)) {
      const recommended = selectRecommendedCinema(
        brief,
        prefetch,
        [],
        options.cinemaInventory
      );
      if (recommended) return {
        ...recommended,
        budget_fit_selections: cinema.selections,
        reasoning: [...recommended.reasoning, ...cinema.reasoning],
        strategy: 'deterministic_cinema_dual'
      };
    }
    return { ...cinema, strategy: 'deterministic_cinema' };
  }
  const radio = selectRadioPlanner(brief, prefetch);
  if (radio) return radio;
  return selectDeterministic(brief, prefetch);
}

/**
 * Chooses the lines for a plan.
 *
 * Model-backed selection lands here when OPENAI_API_KEY is present; the
 * signature and the return shape are already what that call will produce, so
 * wiring it in does not disturb anything downstream.
 */
async function selectLines(brief, prefetch, options = {}) {
  if (prefetch.candidates.length === 0) {
    return {
      selections: [],
      reasoning: ['Prefetch returned no candidates; there is nothing to select from.'],
      strategy: 'none'
    };
  }

  if (options.strategy === 'deterministic' || !isModelConfigured()) {
    const started = Date.now();
    const result = selectWithoutModel(brief, prefetch, options);
    if (!isModelConfigured() && options.strategy !== 'deterministic') {
      result.reasoning.unshift(
        'OPENAI_API_KEY is not set, so the deterministic selector ran instead of the model.'
      );
    }
    log.info('selection.deterministic.completed', {
      strategy: result.strategy,
      candidate_count: prefetch.candidates.length,
      selection_count: result.selections.length,
      duration_ms: Date.now() - started
    });
    return result;
  }

  /*
   * Model path. A failure here falls back to the deterministic selector rather
   * than failing the request: a plan built by the simpler strategy is worth far
   * more to the desk than a 500, and the fallback is recorded so nobody mistakes
   * one for the other.
  */
  const started = Date.now();
  log.info('selection.model.started', {
    model: MODEL,
    candidate_count: prefetch.candidates.length,
    inventory_mode: isInventory(brief)
  });
  try {
    const result = await selectWithModel(brief, prefetch, options);
    const checked = validateSelections(result.selections, prefetch);

    log.info('selection.model.completed', {
      model: result.model || MODEL,
      proposed_count: result.selections.length,
      valid_count: checked.valid.length,
      rejected_count: checked.rejected.length,
      tool_call_count: (result.tool_calls || []).length,
      prompt_tokens: result.usage?.prompt_tokens || 0,
      completion_tokens: result.usage?.completion_tokens || 0,
      duration_ms: Date.now() - started
    });

    if (checked.rejected.length) {
      result.reasoning.push(
        ...checked.rejected.map((r) => `Rejected a selection: ${r.reason}`)
      );
    }

    if (checked.valid.length === 0) {
      const fallback = selectWithoutModel(brief, prefetch, options);
      fallback.reasoning.unshift(
        'The model returned no usable selections; the deterministic selector ran instead.'
      );
      fallback.strategy = 'deterministic_after_model';
      fallback.model_output = result;
      log.warn('selection.model.fallback', {
        reason: 'no_usable_selections',
        fallback_selection_count: fallback.selections.length
      });
      return fallback;
    }

    const cinema = selectBalancedCinema(brief, prefetch, checked.valid);
    if (cinema) {
      if (cinemaUsesReferenceBudget(brief)) {
        const recommended = selectRecommendedCinema(
          brief,
          prefetch,
          checked.valid,
          options.cinemaInventory
        );
        if (recommended) return {
          ...result,
          selections: recommended.selections,
          budget_fit_selections: cinema.selections,
          reasoning: [...result.reasoning, ...recommended.reasoning, ...cinema.reasoning]
        };
      }
      return {
        ...result,
        selections: cinema.selections,
        reasoning: [...result.reasoning, ...cinema.reasoning]
      };
    }

    return { ...result, selections: checked.valid };
  } catch (error) {
    log.error('selection.model.failed', {
      model: MODEL,
      duration_ms: Date.now() - started,
      error: log.errorDetails(error)
    });
    const fallback = selectWithoutModel(brief, prefetch, options);
    fallback.reasoning.unshift(
      `Model selection failed (${error.message}); the deterministic selector ran instead.`
    );
    fallback.strategy = 'deterministic_after_error';
    log.warn('selection.model.fallback', {
      reason: 'model_error',
      fallback_selection_count: fallback.selections.length
    });
    return fallback;
  }
}

/**
 * Keeps only selections that name a real price option on a real product.
 *
 * The model is told to use ids from the shortlist and the tool results, and it
 * largely does -- but an id it invented would otherwise become a line in a
 * client quotation, so every one is checked. A selection is also rejected when
 * its price option belongs to a different product than it claims: that pairing
 * would cost the right rate against the wrong inventory.
 *
 * Ids from tool results are not in the shortlist, so anything unrecognised is
 * held for a catalog lookup rather than rejected outright.
 */
function validateSelections(selections, prefetch) {
  const shortlist = new Map();
  for (const product of prefetch.candidates) {
    shortlist.set(product.id, new Set((product.price_options || []).map((o) => o.id)));
  }

  const valid = [];
  const rejected = [];

  for (const pick of selections || []) {
    const productId = Number(pick.product_id);
    const optionId = Number(pick.price_option_id);
    const qty = Math.trunc(Number(pick.qty));
    const months = Math.trunc(Number(pick.months) || 1);

    if (!Number.isFinite(productId) || !Number.isFinite(optionId)) {
      rejected.push({ pick, reason: 'product_id or price_option_id is not a number.' });
      continue;
    }
    if (!Number.isFinite(qty) || qty < 1) {
      rejected.push({ pick, reason: `quantity ${pick.qty} is not a positive whole number.` });
      continue;
    }

    const known = shortlist.get(productId);
    if (known && !known.has(optionId)) {
      rejected.push({
        pick,
        reason: `price option ${optionId} does not belong to product ${productId}.`
      });
      continue;
    }

    // Unknown product ids came from a tool result; build.js re-reads every
    // selection from the catalog before costing it, and drops what is not there.
    valid.push({
      product_id: productId,
      price_option_id: optionId,
      media_type: pick.media_type || null,
      qty,
      months: months > 0 ? months : 1,
      why: pick.why || null,
      planner_fields: pick.planner_fields || null,
      from_shortlist: Boolean(known)
    });
  }

  return { valid, rejected };
}

module.exports = {
  selectLines,
  selectDeterministic,
  selectBalancedCinema,
  selectRecommendedCinema,
  cinemaUsesReferenceBudget,
  validateSelections,
  isModelConfigured,
  monthsFor,
  bestOption
};

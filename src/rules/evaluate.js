/**
 * Applies rules to a costed plan.
 *
 * The engine decides the numbers; this only judges them. Nothing here changes a
 * rate or a quantity — it returns what fired, so the plan can carry
 * `applied_rules` and the desk can see why the plan looks the way it does.
 */

const OPS = {
  '>=': (a, b) => Number(a) >= Number(b),
  '<=': (a, b) => Number(a) <= Number(b),
  '==': (a, b) => a === b || Number(a) === Number(b),
  '!=': (a, b) => !(a === b || Number(a) === Number(b)),
  in: (a, b) => Array.isArray(b) && b.includes(a),
  not_in: (a, b) => Array.isArray(b) && !b.includes(a),
  between: (a, b) => Array.isArray(b) && Number(a) >= Number(b[0]) && Number(a) <= Number(b[1])
};

// Anything the six operators cannot express gets a named function here rather
// than a bigger DSL. Keep these small and individually tested.
const PREDICATES = {
  qty_within_units(line) {
    const { qty, unit_min, unit_max, unit_step } = line;
    if (qty == null || unit_min == null) return true;
    if (qty < unit_min) return false;
    if (unit_max != null && qty > unit_max) return false;
    if (unit_step) return Number.isInteger((qty - unit_min) / unit_step);
    return true;
  },
  min_billing_met(line) {
    if (line.minimum_billing == null) return true;
    return Number(line.net) >= Number(line.minimum_billing);
  },
  margin_known(line) {
    return line.buying_rate != null;
  },
  sells_above_buying(line) {
    if (line.buying_rate == null) return true;
    return Number(line.rate) > Number(line.buying_rate);
  }
};

function get(target, field) {
  return field.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), target);
}

/** Evaluate one constraint against one line. Returns null when it passes or does not apply. */
function checkConstraint(constraint, line) {
  let passed = true;

  if (constraint.predicate) {
    const fn = PREDICATES[constraint.predicate];
    if (!fn) throw new Error(`Unknown predicate "${constraint.predicate}" on ${constraint.id}`);
    passed = fn(line);
  } else if (constraint.assert) {
    const { field, op, value } = constraint.assert;
    const actual = get(line, field);
    if (actual === undefined) return null; // field not present on this line — not applicable
    const fn = OPS[op];
    if (!fn) throw new Error(`Unknown operator "${op}" on ${constraint.id}`);
    passed = fn(actual, value);
  } else {
    // Advisory-only rule: it carries guidance, not a testable assertion.
    return null;
  }

  if (passed) return null;
  return {
    id: constraint.id,
    severity: constraint.severity,
    message: constraint.message,
    source: constraint.source || null,
    fix: constraint.fix || null,
    line: line.sr ?? null,
    product: line.product_name ?? null
  };
}

/**
 * Run every constraint in `rules` over every line.
 * Returns { violations, blocked } — `blocked` is true when any `block` fired.
 */
function applyConstraints(lines, rules) {
  const violations = [];
  for (const line of lines) {
    for (const constraint of rules.constraints || []) {
      const violation = checkConstraint(constraint, line);
      if (violation) violations.push(violation);
    }
  }
  return {
    violations,
    blocked: violations.some((v) => v.severity === 'block')
  };
}

/** Scenarios are advisory nudges evaluated against the whole plan, not a line. */
function applyScenarios(context, rules) {
  const fired = [];
  for (const scenario of rules.scenarios || []) {
    const when = scenario.when || {};
    const hit = Object.entries(when).every(([key, value]) => {
      if (key.endsWith('_below')) return Number(context[key.replace('_below', '')]) < Number(value);
      if (key.endsWith('_above')) return Number(context[key.replace('_above', '')]) > Number(value);
      return context[key] === value;
    });
    if (hit) {
      fired.push({
        id: scenario.id,
        severity: scenario.severity || 'advise',
        message: scenario.message,
        then: scenario.then || {}
      });
    }
  }
  return fired;
}

/** The match_policy block from global.json, resolved for the brief's policy name. */
function matchPolicy(rules, policyName) {
  const policies = rules.match_policy || {};
  return policies[policyName] || policies.flexible || {};
}

module.exports = { applyConstraints, applyScenarios, matchPolicy, checkConstraint, OPS, PREDICATES };

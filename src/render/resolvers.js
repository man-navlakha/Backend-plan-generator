/**
 * Fields the client sheet shows that a plan line does not carry directly.
 * Documented in assets/formats/README.md — this is the implementation of that table.
 *
 * A resolver returning null renders an empty cell on purpose: the master does not
 * hold the value and the desk fills it before the plan goes out.
 */

const resolvers = {
  // The serial number, 1-based within its sheet.
  sr: (line, ctx) => ctx.index + 1,

  /**
   * Printing, mounting or union charges divided down to per unit, because the
   * engine costs them as one lump per line.
   */
  addon_per_unit: (line) => {
    if (line.addon_per_unit != null) return line.addon_per_unit;
    if (!line.addon_total || !line.qty) return null;
    return round2(line.addon_total / line.qty);
  },

  /** The rate plus the per-unit add-on: "Charges Per Bus Per Month". */
  rate_all_in: (line) => {
    const rate = Number(line.rate) || 0;
    const addon = Number(resolvers.addon_per_unit(line)) || 0;
    return round2(rate + addon);
  },

  /**
   * The rate as the sheet must show it. Where a minimum billing or quantity floor
   * lifted the line, the master rate no longer multiplies out to the cost on the
   * same row, and a client sheet that does not add up gets queried — so show what
   * the cost divides down to. Everything else shows the master rate untouched.
   */
  rate: (line) => {
    if (!line.min_billing_applied) return line.rate ?? null;
    const units = Number(line.qty) * Number(line.months || 1);
    if (!units) return line.rate ?? null;
    return round2(Number(line.net) / units);
  },

  /** "Delhi Metro - Line 3&4 Exterior Wrap" -> "Line 3&4". Blank where none is named. */
  metro_line: (line) => {
    const match = /\b(Line\s*[\w&]+|Aqua Line|Red Line|Blue Line|Green Line|Yellow Line)\b/i
      .exec(line.price_option || '');
    return match ? match[1].replace(/\s+/g, ' ').trim() : null;
  },

  /** The same price option with the city and the line stripped off. */
  package: (line) => {
    let text = String(line.price_option || '');
    if (line.market) text = text.replace(new RegExp(`\\b${escapeRegExp(line.market)}\\b`, 'gi'), '');
    const metroLine = resolvers.metro_line(line);
    if (metroLine) text = text.replace(new RegExp(escapeRegExp(metroLine), 'gi'), '');
    text = text.replace(/\b(Metro|Train)\b/gi, ' ').replace(/[-–—]/g, ' ');
    text = text.replace(/\s{2,}/g, ' ').trim();
    return text || null;
  },

  /** 7, 15 or 30 days, for media the master prices by duration rather than by month. */
  duration: (line) => {
    if (line.duration != null) return line.duration;
    if (line.days != null) return line.days;
    if (line.months != null) return `${line.months} Month${line.months > 1 ? 's' : ''}`;
    return null;
  },

  /** Radio: spot length x spots a day x days. */
  total_seconds: (line) => {
    if (line.total_seconds != null) return line.total_seconds;
    const { spot_seconds: s, spots_per_day: d, days } = line;
    if (s == null || d == null || days == null) return null;
    return s * d * days;
  }
};

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

/**
 * Value for one format.json column on one line.
 * Falls back to the raw field, then to null (an empty cell the desk fills).
 */
function resolveField(field, line, ctx) {
  if (resolvers[field]) {
    const value = resolvers[field](line, ctx);
    return value === undefined ? null : value;
  }
  const value = line[field];
  return value === undefined ? null : value;
}

module.exports = { resolveField, resolvers };

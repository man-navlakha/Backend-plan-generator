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

  // Magazine's master uses title-cased catalog attributes while its client
  // sheet uses concise field names. Keep the source wording intact and only
  // infer a size when the supplied Position clearly describes a cover/page.
  publication: (line) => line.publication || line.product_name || null,
  circulation: (line) => numberOrText(line.circulation ?? line.Circulation),
  frequency: (line) => line.frequency || line.Frequency || null,
  ad_size: (line) => line.ad_size || magazineAdSize(line.Position || line.position),
  page_position: (line) =>
    line.page_position || magazinePagePosition(line.Position || line.position),

  // Cinema's client template uses field names from its source workbook while
  // the unified catalog uses generic product columns plus attrs.
  city: (line) => {
    const city = line.city || line.market || null;
    return /^gurgaon$/i.test(String(city || '').trim()) ? 'Gurugram' : city;
  },
  screen_code: (line) => line.screen_code || line.sku || line.product_sku || null,
  pincode: (line) => {
    if (line.pincode != null) {
      const digits = String(line.pincode).replace(/\.0+$/, '').replace(/\D/g, '');
      if (/^[1-9]\d{5}$/.test(digits)) return digits;
    }
    const match = /\b[1-9]\d{5}\b/.exec(
      `${line.address || ''} ${line.product_description || ''}`
    );
    return match ? match[0] : null;
  },
  theatre_type: (line) => line.theatre_type || line.audience_class || null,
  multiplex_name: (line) => line.multiplex_name || line.product_name || null,
  address: (line) => [line.address, line.product_description]
    .find((value) => value && !/^\s*(?:\[object object\]|https?:\/\/|www\.)/i.test(String(value))) || null,
  capacity_preference: (line) => {
    if (line.capacity_preference != null) return line.capacity_preference;
    return line.rank != null ? `S${line.rank}` : null;
  },
  total_screen: (line) => line.total_screen ?? null,
  audi_no: (line) => {
    if (line.audi_no != null) return line.audi_no;
    if (line.screen != null) return line.screen;
    const match = /\bSCREEN[-_\s]*(\d+)/i.exec(line.price_option || line.sku || '');
    return match ? Number(match[1]) : null;
  },
  audi_type: (line) => line.audi_type || null,
  cinema_chain: (line) => line.cinema_chain || null,
  seating_capacity: (line) => line.seating_capacity ?? line.seats ?? null,
  /**
   * What the whole flight costs for this screen. The inventory sheet quotes a
   * price the client can read against one row -- 15 seconds for the full two
   * weeks -- rather than the weekly rate the costed plan multiplies up in its
   * footer, because an inventory sheet has no footer to do the multiplying.
   */
  cinema_flight_rate: (line) => round2(Number(line.net) || 0),

  cinema_weekly_rate: (line) => {
    const weeks = Math.max(1, Number(line.months) || 1);
    return round2((Number(line.net) || 0) / weeks);
  },

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

function magazineAdSize(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/quarter/i.test(text)) return 'Quarter Page';
  if (/\b(half|hal)\b/i.test(text)) return 'Half Page';
  if (/\b(double|two page|centre spread)\b/i.test(text)) return 'Double-page Spread';
  if (/gate\s*fold/i.test(text)) return 'Gatefold';
  if (/classified/i.test(text)) return 'Classified';
  if (/\b(cover|inside|inner|back page)\b/i.test(text)) return 'Full Page';
  if (/full page/i.test(text)) return 'Full Page';
  return text;
}

function magazinePagePosition(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/inside front/i.test(text)) return 'Inside Front Cover';
  if (/inside back|insdie back|cover[- ]back inside/i.test(text)) return 'Inside Back Cover';
  if (/outside back|back cover|back coverpage|back page/i.test(text)) return 'Back Cover';
  if (/front cover/i.test(text)) return 'Front Cover';
  if (/cover\s*page/i.test(text)) return 'Cover Page';
  if (/\b(inside|inner|centre spread)\b/i.test(text)) return 'Inside Page';
  // The approved Magazine proposal uses Inside Page for size-only selections
  // such as Full Page and Double Spread. Exact cover positions above remain
  // explicit; their availability is still governed by the terms sheet.
  if (/\b(quarter|half|hal|full|double|two page|gate\s*fold|classified)\b/i.test(text)) {
    return 'Inside Page';
  }
  return null;
}

function numberOrText(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).replaceAll(',', '').trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : value;
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

/**
 * Read the CRM's free-text query value without losing text after an unescaped
 * ampersand. Some CRM webhook builders interpolate a field into the URL
 * without percent-encoding it, so Express sees "Fashion & Lifestyle" as two
 * query parameters and truncates client_brief at "Fashion ".
 *
 * Proper URL encoding is still preferred. This recovery is deliberately
 * limited to client_brief, which is the final required parameter in the CRM
 * contract. A trailing force=true/1/yes remains an API option.
 */

function decodeQueryValue(value, fallback) {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' ')).trim();
  } catch {
    return String(fallback || '').trim();
  }
}

function clientBriefFromUrl(originalUrl, fallback = '') {
  const queryAt = String(originalUrl || '').indexOf('?');
  if (queryAt === -1) return String(fallback || '').trim();

  const rawQuery = String(originalUrl).slice(queryAt + 1);
  const match = rawQuery.match(/(?:^|&)client_brief=/i);
  if (!match) return String(fallback || '').trim();

  const valueAt = match.index + match[0].length;
  const rawValue = rawQuery
    .slice(valueAt)
    .replace(/&force=(?:1|true|yes)$/i, '');

  return decodeQueryValue(rawValue, fallback);
}

module.exports = { clientBriefFromUrl };

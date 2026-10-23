'use strict';
// Sanitizers for text that comes from Plex (titles, summaries, server and user
// names) or from errors. Plex data is partly controlled by other people: a
// friend's shared server picks its own name and can edit its own metadata.

/**
 * Make SSML safe: escape &, < and > in everything except the tags we emit
 * ourselves. Without this a title like "Law & Order" makes the whole response
 * invalid SSML, and a crafted title could inject audio/markup tags.
 */
const ALLOWED_TAG = /<\/?(?:speak|say-as|break|emphasis|prosody|s|p)(?:\s+[a-z-]+="[^"<>]*")*\s*\/?>/gi;
const escapeText = (t) => t.replace(/&(?!(?:amp|lt|gt|quot|apos);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function ssmlSafe(ssml) {
  if (typeof ssml !== 'string') return ssml;
  let out = '';
  let last = 0;
  for (const m of ssml.matchAll(ALLOWED_TAG)) {
    out += escapeText(ssml.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + escapeText(ssml.slice(last));
}

/**
 * APL evaluates ${…} anywhere in document strings. Text from Plex is placed
 * into documents, so neutralise "${" (a zero-width space keeps it readable).
 */
function aplText(s) {
  if (s === undefined || s === null) return s;
  return String(s).replace(/\$\{/g, '$\u200B{');
}

/** Strip URLs, hosts, IPs and tokens from error text before logging/diagnostics. */
function redact(msg) {
  return String(msg || '')
    .replace(/https?:\/\/[^\s"')]+/gi, '<url>')
    .replace(/X-Plex-Token=[^&\s]+/gi, 'X-Plex-Token=<redacted>')
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.plex\.direct\b/gi, '<host>.plex.direct')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
    .replace(/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/gi, '<ip6>')
    .slice(0, 300);
}

/**
 * Connection URIs come from plex.tv, partly controlled by server owners.
 * The backend only talks HTTPS, never to IP literals in private, loopback,
 * link-local or metadata ranges, and never to localhost.
 */
function isSafeServerUri(uri) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return false;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 169 && b === 254) return false;            // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;  // CGNAT
  }
  if (host.includes(':')) {                               // IPv6 literal
    if (host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:')) return false;
  }
  return true;
}

module.exports = { ssmlSafe, aplText, redact, isSafeServerUri };

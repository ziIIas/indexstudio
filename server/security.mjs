import { timingSafeEqual } from 'node:crypto';

export const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function requestAllowed(req, baseUrl) {
  // Exact authority and origin comparisons prevent DNS rebinding and cross-port access.
  if (req.headers.host !== new URL(baseUrl).host) return false;
  if (req.headers.origin !== undefined && req.headers.origin !== baseUrl) return false;
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
}

export function authenticated(req, token) {
  const supplied = Buffer.from(String(req.headers.authorization ?? ''));
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export class AuthMailError extends Error {
  constructor(message, status = 429, retryAfter = 60) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// Fixed ten-minute budgets are atomic across Worker instances. Store a keyed
// hash, never the raw IP. Failed deliveries still count against abuse budgets.
export async function reserveAuthRequest(env, ip, stamp = Date.now()) {
  const windowMs = 600000;
  const slot = Math.floor(stamp / windowMs);
  const expires = (slot + 1) * windowMs;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.AUTH_PEPPER || ''}|${ip || 'unknown'}|${slot}`));
  const hash = Array.from(new Uint8Array(bytes), v => v.toString(16).padStart(2, '0')).join('');
  for (const [bucket, limit] of [[`ip:${slot}:${hash}`, 20], [`global:${slot}`, 100]]) {
    const row = await env.CUSTOMER_DB.prepare(`INSERT INTO auth_request_limits(bucket,used,expires_at)
      VALUES (?1,1,?2) ON CONFLICT(bucket) DO UPDATE SET used=used+1
      WHERE used < ?3 RETURNING used`).bind(bucket, expires, limit).first();
    if (!row) throw new AuthMailError('Too many code requests. Please wait a few minutes and try again.', 429, Math.max(1, Math.ceil((expires-stamp)/1000)));
  }
}

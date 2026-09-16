export class AuthMailError extends Error {
  constructor(message, status = 429, retryAfter = 60) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// Fixed ten-minute budgets are atomic across Worker instances. Store a keyed
// hash, never the raw IP. Failed deliveries still count against abuse budgets.
//
// The owner gets a bucket of its own, keyed on the address being signed into
// rather than the IP. Woody's phone, his PC and any customer on the same
// connection can share one IP, so a busy morning of customer sign-ins could
// spend the owner's budget and lock him out of his own app with "Too many code
// requests" — at exactly the moment he was trying to get back in.
export async function reserveAuthRequest(env, ip, stamp = Date.now(), role = "customer") {
  const windowMs = 600000;
  const slot = Math.floor(stamp / windowMs);
  const expires = (slot + 1) * windowMs;
  const keyed = async (value) => {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.AUTH_PEPPER || ''}|${value}|${slot}`));
    return Array.from(new Uint8Array(bytes), v => v.toString(16).padStart(2, '0')).join('');
  };
  const buckets = role === "owner"
    ? [[`owner:${slot}`, 40], [`global:${slot}`, 100]]
    : [[`ip:${slot}:${await keyed(ip || 'unknown')}`, 20], [`global:${slot}`, 100]];
  for (const [bucket, limit] of buckets) {
    const row = await env.CUSTOMER_DB.prepare(`INSERT INTO auth_request_limits(bucket,used,expires_at)
      VALUES (?1,1,?2) ON CONFLICT(bucket) DO UPDATE SET used=used+1
      WHERE used < ?3 RETURNING used`).bind(bucket, expires, limit).first();
    if (!row) throw new AuthMailError('Too many code requests. Please wait a few minutes and try again.', 429, Math.max(1, Math.ceil((expires-stamp)/1000)));
  }
}

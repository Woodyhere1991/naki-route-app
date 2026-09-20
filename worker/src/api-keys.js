export async function apiDigest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}

export async function apiBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
    throw Object.assign(new Error('Send Content-Type: application/json.'), {status: 415});
  }
  const reader = request.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) {
        await reader.cancel();
        throw Object.assign(new Error('JSON must be under 32 KB.'), {status: 413});
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw Object.assign(new Error('Send valid JSON.'), {status: 400}); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('Send a JSON object.'), {status: 400});
  }
  return body;
}

const publicKey = row => ({
  id: row.id, name: row.name, prefix: row.prefix, permission: row.permission,
  createdAt: row.created_at, expiresAt: row.expires_at,
  revokedAt: row.revoked_at, lastUsedAt: row.last_used_at
});

// Called only after the portal has verified a real owner session.
export async function handleApiKeys({request, env, path, json}) {
  if (path !== '/owner/api-keys' && !path.startsWith('/owner/api-keys/')) return null;
  const db = env.CUSTOMER_DB;
  if (path === '/owner/api-keys' && request.method === 'GET') {
    const rows = await db.prepare('SELECT id,name,prefix,permission,created_at,expires_at,revoked_at,last_used_at FROM bot_api_keys ORDER BY created_at DESC LIMIT 100').all();
    return json(request, {keys: rows.results.map(publicKey)});
  }
  if (path === '/owner/api-keys/activity' && request.method === 'GET') {
    const rows = await db.prepare(`SELECT r.method,r.path,r.status,r.created_at AS createdAt,k.name AS keyName
      FROM bot_api_requests r JOIN bot_api_keys k ON k.id=r.key_id ORDER BY r.created_at DESC LIMIT 50`).all();
    return json(request, {activity: rows.results});
  }
  if (path === '/owner/api-keys' && request.method === 'POST') {
    let body;
    try { body = await apiBody(request); } catch (e) { return json(request, {error: e.message}, e.status); }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 60) return json(request, {error: 'Give the key a name, up to 60 characters.'}, 400);
    if (!['read', 'write'].includes(body.permission)) return json(request, {error: 'Choose read-only or read and write.'}, 400);
    const days = body.expiresInDays ?? 90;
    if (![7, 30, 90, 365].includes(days)) return json(request, {error: 'Choose 7, 30, 90 or 365 days.'}, 400);
    const random = crypto.getRandomValues(new Uint8Array(32));
    const token = 'naki_bot_' + Array.from(random, b => b.toString(16).padStart(2, '0')).join('');
    const row = {id: crypto.randomUUID(), name, prefix: token.slice(0, 17), permission: body.permission,
      created_at: Date.now(), expires_at: Date.now() + days * 86400000, revoked_at: null, last_used_at: null};
    // Atomic limit: two simultaneous creates cannot exceed 20 active keys.
    const result = await db.prepare(`INSERT INTO bot_api_keys(id,name,token_hash,prefix,permission,created_at,expires_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE (SELECT COUNT(*) FROM bot_api_keys WHERE revoked_at IS NULL AND expires_at>?6)<20`)
      .bind(row.id, name, await apiDigest(token), row.prefix, row.permission, row.created_at, row.expires_at).run();
    if (!result.meta?.changes) return json(request, {error: 'Revoke an old key first. You can have 20 active keys.'}, 409);
    return json(request, {key: publicKey(row), secret: token, message: 'Copy this secret now. It is only shown once.'}, 201);
  }
  const match = path.match(/^\/owner\/api-keys\/([a-zA-Z0-9-]+)$/);
  if (match && request.method === 'DELETE') {
    const result = await db.prepare('UPDATE bot_api_keys SET revoked_at=COALESCE(revoked_at,?1) WHERE id=?2').bind(Date.now(), match[1]).run();
    return result.meta?.changes ? json(request, {ok: true}) : json(request, {error: 'Key not found.'}, 404);
  }
  return json(request, {error: 'Method or path not supported.'}, 405);
}

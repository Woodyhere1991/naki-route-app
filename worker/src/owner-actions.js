// Atomic claims prevent concurrent taps and uncertain network retries sending twice.
export const OWNER_ACTIONS = new Set(['/send-bulk','/send-receipt','/send-invoice','/set-reminder','/cancel-reminder','/owner/bookings/bulk-confirm']);
async function digest(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b=>b.toString(16).padStart(2,'0')).join('');
}
export async function ownerAction(request, env, path, session, json, run) {
  const raw = await request.clone().text();
  if (raw.length > 3000000) return json(request,{error:'This request is too large.'},413);
  const token = request.headers.get('Idempotency-Key') || crypto.randomUUID();
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(token)) return json(request,{error:'Invalid request reference.'},400);
  const owner = session.email.toLowerCase();
  const id = await digest(owner+'|'+path+'|'+token), fingerprint = await digest(path+'|'+raw);
  const db = env.CUSTOMER_DB;
  const replay = async () => {
    const old = await db.prepare('SELECT fingerprint,status,response FROM owner_action_receipts WHERE id=?1').bind(id).first();
    if (!old) return null;
    if (old.fingerprint !== fingerprint) return json(request,{error:'This request reference belongs to different details.'},409);
    if (old.status) return json(request,JSON.parse(old.response),old.status);
    return json(request,{error:'This send is still processing or its result is uncertain. Check your Sent mail before trying a new send.'},409);
  };
  const old = await replay(); if (old) return old;
  const count = await db.prepare('SELECT COUNT(*) AS count FROM owner_action_receipts WHERE owner_email=?1 AND created_at>?2').bind(owner,Date.now()-60000).first();
  if (Number(count?.count)>119) return json(request,{error:'Too many actions at once. Please wait a minute.'},429);
  const claim = await db.prepare('INSERT OR IGNORE INTO owner_action_receipts(id,owner_email,fingerprint,created_at) VALUES (?1,?2,?3,?4)').bind(id,owner,fingerprint,Date.now()).run();
  if (!claim.meta?.changes) return await replay() || json(request,{error:'Please try again.'},409);
  // On an exception leave the claim in place: a provider may have accepted mail.
  const response = await run();
  const body = await response.clone().text();
  if (response.status >= 400 && response.status < 500) {
    await db.prepare('DELETE FROM owner_action_receipts WHERE id=?1').bind(id).run();
  } else {
    await db.prepare('UPDATE owner_action_receipts SET status=?1,response=?2 WHERE id=?3').bind(response.status,body,id).run();
  }
  return response;
}

// D1 is the authoritative copy: KV alone cannot atomically reject stale writers.
export async function readRunBackup(env, key, previous = false) {
  let row = await env.CUSTOMER_DB.prepare('SELECT * FROM run_backups WHERE owner_key=?').bind(key).first();
  if (!row) {
    const raw = await env.REMINDERS.get(key);
    if (!raw) return null;
    const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const prev = await env.REMINDERS.get(`${key}:prev`);
    await env.CUSTOMER_DB.prepare('INSERT OR IGNORE INTO run_backups(owner_key,saved_at,record_json,previous_json) VALUES(?,?,?,?)')
      .bind(key, record.savedAt, JSON.stringify(record), typeof prev === 'string' ? prev : prev ? JSON.stringify(prev) : null).run();
    row = await env.CUSTOMER_DB.prepare('SELECT * FROM run_backups WHERE owner_key=?').bind(key).first();
  }
  const raw = previous ? row.previous_json : row.record_json;
  return raw ? JSON.parse(raw) : null;
}

export async function writeRunBackup(env, key, parsed) {
  if (!Number.isSafeInteger(parsed.baseSavedAt) || parsed.baseSavedAt < 0) {
    return {status:428, error:'Your app needs refreshing before it can save runs safely. Your phone copy is still kept.'};
  }
  const existing = await readRunBackup(env, key);
  if ((existing?.savedAt || 0) !== parsed.baseSavedAt) {
    // A lost response can be acknowledged safely without a second write.
    if (existing && JSON.stringify(existing.data) === JSON.stringify(parsed.data)) return {savedAt:existing.savedAt};
    return {status:409, error:'Your account has newer runs. Both copies are kept. Export this phone copy, then use Restore from account to review the newer runs.'};
  }
  const savedAt = Math.max(Date.now(), parsed.baseSavedAt + 1);
  const record = JSON.stringify({savedAt, runCount:Number(parsed.runCount)||0, data:parsed.data});
  const result = existing
    ? await env.CUSTOMER_DB.prepare('UPDATE run_backups SET previous_json=record_json,record_json=?,saved_at=? WHERE owner_key=? AND saved_at=?').bind(record,savedAt,key,parsed.baseSavedAt).run()
    : await env.CUSTOMER_DB.prepare('INSERT OR IGNORE INTO run_backups(owner_key,saved_at,record_json) VALUES(?,?,?)').bind(key,savedAt,record).run();
  if (!result.meta?.changes) return {status:409,error:'Your account has newer runs. Both copies are kept. Export this phone copy before restoring from account.'};
  // Retain the old daily safety net. A mirror failure cannot undo the D1 save.
  try {
    if (existing) {
      const old = JSON.stringify(existing);
      await env.REMINDERS.put(`${key}:prev`,old);
      const daily = `${key}:day:${new Date(existing.savedAt).toISOString().slice(0,10)}`;
      if (!await env.REMINDERS.get(daily)) await env.REMINDERS.put(daily,old,{expirationTtl:8*86400});
    }
    await env.REMINDERS.put(key,record);
  } catch { /* The authoritative D1 current and previous copies remain intact. */ }
  return {savedAt};
}

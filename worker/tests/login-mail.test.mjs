import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { loginSender } from '../src/login-mail.js';

const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const start = source.indexOf('async function sendMail(');
const end = source.indexOf('const BANK_LINE', start);
function mailHarness(ok = true) {
  const calls = [];
  const context = { loginSender, sendGmail: async () => { calls.push('gmail'); return true; },
    fetch: async (url, options) => { calls.push({ url, payload: JSON.parse(options.body) }); return { ok }; } };
  vm.runInNewContext(source.slice(start, end), context);
  return { calls, send: context.sendMail };
}
const msg = { kind: 'customer-login', to: 'test@example.invalid', subject: 'Code', text: 'Test code' };
const env = { AUTH_EMAIL_FROM: 'no-reply@nakiwhitewareremoval.vip', BREVO_API_KEY: 'fake-only' };

test('customer code uses business sender without calling Gmail', async () => {
  const h = mailHarness();
  assert.equal(await h.send(env, msg), true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].payload.sender.email, env.AUTH_EMAIL_FROM);
});
test('failed business delivery never falls back to personal Gmail', async () => {
  const h = mailHarness(false);
  assert.equal(await h.send(env, msg), false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].payload.sender.email, env.AUTH_EMAIL_FROM);
});
test('missing Brevo credentials do not fall back to personal Gmail', async () => {
  const h = mailHarness();
  assert.equal(await h.send({ AUTH_EMAIL_FROM: env.AUTH_EMAIL_FROM }, msg), false);
  assert.equal(h.calls.length, 0);
});
test('invalid sender fails before any external request', async () => {
  const h = mailHarness();
  for (const address of ['someone@gmail.com', 'no-reply@wrong.vip', 'x\r\nBcc:a@b.test']) {
    await assert.rejects(h.send({ ...env, AUTH_EMAIL_FROM: address }, msg));
  }
  assert.equal(h.calls.length, 0);
});
test('other messages and unconfigured deployments preserve existing delivery', async () => {
  const h = mailHarness();
  assert.equal(await h.send(env, { ...msg, kind: 'owner-login' }), true);
  assert.equal(await h.send(env, { ...msg, kind: undefined }), true);
  assert.equal(await h.send({}, msg), true);
  assert.deepEqual(h.calls, ['gmail', 'gmail', 'gmail']);
});

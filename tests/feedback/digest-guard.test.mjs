// The weekly digest's recipient guard (feedback/digest/guard-recipient.mjs): the Claude writing the digest reads text
// written by strangers, so whatever it tries, the only thing that goes through is one email to the owner, from the
// owner's own Gmail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../../feedback/digest/guard-recipient.mjs', import.meta.url));
const TOOL = 'mcp__claude_ai_Gmail_abc__send_message';
const OWNER = 'owner@example.com';

function decide(tool_name, tool_input, env = { PERCH_DIGEST_TO: OWNER, PERCH_DIGEST_TOOL: TOOL }) {
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ tool_name, tool_input }), env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
}

test('the digest to the owner goes through (any capitals)', () => {
  assert.equal(decide(TOOL, { to: ['Owner@Example.com'], subject: 'Perch digest', htmlBody: '<p>hi</p>' }), 'allow');
});

test('anyone else, copies, drafts, attachments, replies, other accounts and other tools are refused', () => {
  assert.equal(decide(TOOL, { to: ['someone@evil.example'] }), 'deny');
  assert.equal(decide(TOOL, { to: [OWNER, 'someone@evil.example'] }), 'deny');
  assert.equal(decide(TOOL, { to: [OWNER], cc: ['someone@evil.example'] }), 'deny');
  assert.equal(decide(TOOL, { to: [OWNER], bcc: ['someone@evil.example'] }), 'deny');
  assert.equal(decide(TOOL, { draftId: 'r1' }), 'deny');
  assert.equal(decide(TOOL, { to: [OWNER], attachments: [{ content: 'eA==' }] }), 'deny');
  assert.equal(decide(TOOL, { to: [OWNER], replyThreadId: 't1' }), 'deny');
  assert.equal(decide('mcp__claude_ai_Gmail__send_message', { to: [OWNER] }), 'deny', 'another Gmail account');
  assert.equal(decide('mcp__claude_ai_Gmail_abc__forward', { to: [OWNER] }), 'deny');
  assert.equal(decide('mcp__claude_ai_Slack__slack_send_message', {}), 'deny');
});

test('not set up: refused', () => {
  assert.equal(decide(TOOL, { to: [OWNER] }, { PERCH_DIGEST_TOOL: TOOL }), 'deny');
  assert.equal(decide(TOOL, { to: [OWNER] }, { PERCH_DIGEST_TO: OWNER }), 'deny');
  assert.equal(decide(TOOL, { to: [''] }, { PERCH_DIGEST_TO: '', PERCH_DIGEST_TOOL: TOOL }), 'deny');
});

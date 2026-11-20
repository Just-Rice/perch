// A Claude Code PreToolUse hook for the weekly digest (weekly-digest.sh): the one email it may send goes to the owner
// ($PERCH_DIGEST_TO) and nobody else, from the owner's own Gmail ($PERCH_DIGEST_TOOL). Feedback and pull requests are written by strangers and could ask Claude to
// mail them elsewhere; this check doesn't depend on Claude saying no. Anything but a plain send to that one address,
// with no copies, saved drafts or attachments, is refused.
import { readFileSync } from 'node:fs';

const owner = String(process.env.PERCH_DIGEST_TO ?? '').trim().toLowerCase();
let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch {}
const t = input.tool_input ?? {};

function refuse(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: `Perch digest guard: ${reason}` } }));
  process.exit(0);
}

// The one Gmail tool (one connected account) allowed to send: $PERCH_DIGEST_TOOL, e.g. mcp__claude_ai_Gmail__send_message.
const tool = String(process.env.PERCH_DIGEST_TOOL ?? '').trim();
if (!tool || input.tool_name !== tool) refuse('only sending the digest, from the owner\u2019s own Gmail, is allowed');
if (!owner) refuse('PERCH_DIGEST_TO is not set');
const to = Array.isArray(t.to) ? t.to.map(s => String(s).trim().toLowerCase()) : [];
if (to.length !== 1 || to[0] !== owner) refuse(`the digest goes only to ${owner}`);
for (const k of ['cc', 'bcc']) if (Array.isArray(t[k]) && t[k].length) refuse(`no ${k}`);
if (t.draftId) refuse('no saved drafts');
if (Array.isArray(t.attachments) && t.attachments.length) refuse('no attachments');
if (t.replyThreadId || t.replyToMessageId) refuse('no replies into other threads');
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
  permissionDecisionReason: 'Perch digest guard: to the owner only' } }));

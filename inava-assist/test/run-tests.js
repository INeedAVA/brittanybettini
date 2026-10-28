// End-to-end tests of Ask INAVA's logic against fake Google services.
// Run: node test/run-tests.js
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createEnv, toSerial } = require('./harness');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA_KEY = JSON.stringify({
  client_email: 'inava-assist@project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token',
});

const DOC = (n) => 'https://docs.google.com/document/d/' + 'doc' + n + 'xxxxxxxxxxxxxxxxxxxxxx' + '/edit';

function setupEnv() {
  const env = createEnv();
  env.props.ANTHROPIC_API_KEY = 'sk-test';
  env.props.SERVICE_ACCOUNT_KEY = SA_KEY;
  env.props.ADMIN_EMAIL = 'britt@inava.test';
  env.ctx.setup();

  const users = env.sheet('Users');
  users.length = 1;
  [
    ['britt@inava.test', 'Britt', 'ADMIN', '', 'YES', 'users/1', 'spaces/dm-britt'],
    ['cyn@inava.test', 'Cyn', 'MANAGEMENT', '', 'YES', 'users/2', 'spaces/dm-cyn'],
    ['mabelle@inava.test', 'Mabelle', 'MANAGEMENT', '', 'YES', 'users/3', 'spaces/dm-mabelle'],
    ['verge@inava.test', 'Verge', 'HR', '', 'YES', 'users/4', 'spaces/dm-verge'],
    ['pay@inava.test', 'Pat Payroll', 'HR', '', 'YES', 'users/5', 'spaces/dm-pay'],
    ['va@inava.test', 'Vicky VA', 'VA', 'Acme', 'YES', 'users/6', ''],
    ['va2@inava.test', 'Andy (Acme VA)', 'VA', 'Acme', 'YES', 'users/7', ''],
    ['va3@inava.test', 'Olive (Other VA)', 'VA', 'Other', 'YES', 'users/8', ''],
    ['gone@inava.test', 'Gone', 'VA', '', 'NO', '', ''],
  ].forEach((r) => users.push([...r, '']));

  const routing = env.sheet('Routing');
  routing.length = 1;
  [
    ['CLIENT_CARE', 'Cyn', 'cyn@inava.test', '', 'NO'],
    ['OPERATIONS', 'Mabelle', 'mabelle@inava.test', '', 'NO'],
    ['RECRUITMENT_HR', 'Verge', 'verge@inava.test', '', 'NO'],
    ['PAYROLL', 'Pat Payroll', 'pay@inava.test', '', 'YES'],
  ].forEach((r) => routing.push([...r, 2, 8, 24, 72]));

  const kb = env.sheet('Knowledge');
  [
    ['VA Handbook', DOC(1), 'VA, HR, MANAGEMENT', '', 'Approved'],
    ['Client FAQ', DOC(2), 'ALL', '', 'Approved'],
    ['Management Playbook', DOC(3), 'MANAGEMENT', '', 'Approved'],
    ['Acme Service Agreement', DOC(4), 'VA, MANAGEMENT', 'Acme', 'Approved'],
    ['Old Policy', DOC(5), 'ALL', '', 'Retired'],
  ].forEach((r) => kb.push([...r, '', '']));
  env.docs['doc1xxxxxxxxxxxxxxxxxxxxxx'] = 'Leave: request 2 weeks ahead via the leave form.';
  env.docs['doc2xxxxxxxxxxxxxxxxxxxxxx'] = 'Office hours are 9-5 EST.';
  env.docs['doc3xxxxxxxxxxxxxxxxxxxxxx'] = 'CONFIDENTIAL management escalation matrix.';
  env.docs['doc4xxxxxxxxxxxxxxxxxxxxxx'] = 'Acme gets 40 hours per week.';
  env.docs['doc5xxxxxxxxxxxxxxxxxxxxxx'] = 'Retired policy text.';
  kb.push(['Text Handbook', 'https://drive.google.com/file/d/doc6xxxxxxxxxxxxxxxxxxxxxx/view', 'VA', '', 'Approved', '', '']);
  env.docs['doc6xxxxxxxxxxxxxxxxxxxxxx'] = { mimeType: 'text/plain', text: 'Plain text handbook.' };
  kb.push(['Scanned PDF', 'https://drive.google.com/file/d/doc7xxxxxxxxxxxxxxxxxxxxxx/view', 'VA', '', 'Approved', '', '']);
  env.docs['doc7xxxxxxxxxxxxxxxxxxxxxx'] = { mimeType: 'application/pdf', text: '%PDF' };

  const spaces = env.sheet('Spaces');
  spaces.push(['spaces/acme', 'Acme VA Team', 'YES', 'VA', 'Acme', toSerial(new Date()), '']);
  spaces.push(['spaces/team', 'INAVA Team', 'YES', 'MANAGEMENT', '', toSerial(new Date()), '']);
  return env;
}

// Builds Claude's structured answer. Older tests use the one-concern shorthand
// (escalate/category/priority/duplicate_of_ticket); newer ones pass intent/concerns directly.
function answer(o) {
  o = o || {};
  const out = { intent: o.intent || (o.escalate ? 'CONCERN' : 'QUESTION'), reply: 'reply' in o ? o.reply : 'Here is the answer.',
    sources: o.sources || [], concerns: o.concerns || [], status_ticket: o.status_ticket || '' };
  if (o.escalate) {
    out.concerns = [concern({ category: o.category, priority: o.priority || 'NORMAL', related_ticket: o.duplicate_of_ticket || 'NEW',
      recommended_action: o.recommended_action || '' })];
  }
  return out;
}

function concern(o) {
  return Object.assign({ category: 'CLIENT_CARE', priority: 'NORMAL', concern_text: '', related_ticket: 'NEW',
    urgent_safety: false, recommended_action: '', handoff: '' }, o);
}

function claudeReturns(env, obj, extra) {
  env.setClaude(() => Object.assign({
    body: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(obj) }] },
  }, extra || {}));
}

let msgSeq = 0;
function dmEvent(email, userId, text) {
  return {
    type: 'MESSAGE',
    user: { name: userId, email, displayName: email },
    space: { name: 'spaces/dm-' + userId.replace('users/', 'u'), type: 'DM', singleUserBotDm: true },
    message: { name: 'spaces/dm/messages/m' + (++msgSeq), text, argumentText: text, sender: { type: 'HUMAN' }, thread: { name: 'spaces/dm/threads/t1' } },
  };
}

function spaceEvent(email, userId, spaceName, text) {
  return {
    type: 'MESSAGE',
    user: { name: userId, email },
    space: { name: spaceName, type: 'ROOM', displayName: spaceName },
    message: { name: spaceName + '/messages/m' + (++msgSeq), text: '@Ask INAVA ' + text, argumentText: ' ' + text, sender: { type: 'HUMAN' },
      thread: { name: spaceName + '/threads/abc' } },
  };
}

function kbSent(env) {
  const sys = env.sent.claude[env.sent.claude.length - 1].body.system[1].text;
  return (sys.match(/<document title="([^"]+)"/g) || []).map((s) => s.slice(17, -1));
}

function ticketRows(env) {
  const data = env.sheet('Tickets');
  const h = data[0];
  return data.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}

// The text of a card message posted to the team chat.
function cardText(call) {
  return call.body.cardsV2[0].card.sections[0].widgets[0].textParagraph.text;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('setup creates every tab with headers and seeds routing; running it twice is safe', () => {
  const env = createEnv();
  env.props.SERVICE_ACCOUNT_KEY = SA_KEY;
  env.props.ADMIN_EMAIL = 'Britt@inava.test';
  env.ctx.setup();
  ['Users', 'Spaces', 'Routing', 'Knowledge', 'Tickets', 'Audit Log'].forEach((n) => assert.ok(env.tabs[n], n));
  assert.ok(!env.tabs.Sheet1, 'blank Sheet1 removed');
  assert.strictEqual(env.sheet('Tickets')[0][0], 'Ticket ID');
  assert.strictEqual(env.sheet('Routing').length, 5);
  assert.deepStrictEqual(env.sheet('Users')[1].slice(0, 3), ['britt@inava.test', 'Administrator', 'ADMIN']);
  env.ctx.setup();
  assert.strictEqual(env.sheet('Routing').length, 5);
  assert.strictEqual(env.sheet('Users').length, 2);
});

test('text that looks like a formula is stored as plain text', () => {
  const env = setupEnv();
  claudeReturns(env, answer({ escalate: true, category: 'CLIENT_CARE', concern_summary: 'x' }));
  env.ctx.onMessage(dmEvent('va2@inava.test', 'users/7', '=IMPORTXML("http://evil")'));
  assert.strictEqual(ticketRows(env)[0].Summary, '=IMPORTXML("http://evil")');
  const row = env.sheet('Tickets')[1];
  assert.strictEqual(typeof row[12], 'number', 'Created is stored as a real date');
});

test('unregistered and inactive people get no AI answer', () => {
  const env = setupEnv();
  claudeReturns(env, answer({}));
  let r = env.ctx.onMessage(dmEvent('stranger@x.test', 'users/99', 'What is the leave policy?'));
  assert.match(r.text, /approved list/);
  r = env.ctx.onMessage(dmEvent('gone@inava.test', 'users/9', 'hello'));
  assert.match(r.text, /approved list/);
  assert.strictEqual(env.sent.claude.length, 0);
});

test('new spaces default to the VA audience', () => {
  const env = setupEnv();
  env.ctx.onAddedToSpace({ type: 'ADDED_TO_SPACE', user: { email: 'britt@inava.test' },
    space: { name: 'spaces/x', type: 'ROOM', displayName: 'X' } });
  assert.strictEqual(env.sheet('Spaces').find((r) => r[0] === 'spaces/x')[3], 'VA');
});

test('bot is silent in spaces that are not approved', () => {
  const env = setupEnv();
  claudeReturns(env, answer({}));
  const added = env.ctx.onAddedToSpace({ type: 'ADDED_TO_SPACE', user: { email: 'va@inava.test' },
    space: { name: 'spaces/new', type: 'ROOM', displayName: 'New Space' } });
  assert.match(added.text, /not switched on/);
  const row = env.sheet('Spaces').find((r) => r[0] === 'spaces/new');
  assert.strictEqual(row[2], 'NO');
  const r = env.ctx.onMessage(spaceEvent('va@inava.test', 'users/6', 'spaces/new', 'hi'));
  assert.match(r.text, /not switched on/);
  assert.strictEqual(env.sent.claude.length, 0);
});

test('VA in a DM gets VA + general docs only, and only real sources are cited', () => {
  const env = setupEnv();
  claudeReturns(env, answer({ reply: 'Request leave 2 weeks ahead.', sources: ['VA Handbook', 'Made Up Policy'] }));
  const r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'How do I request leave?'));
  assert.deepStrictEqual(kbSent(env).sort(), ['Acme Service Agreement', 'Client FAQ', 'Text Handbook', 'VA Handbook']);
  assert.strictEqual(r.text, 'Request leave 2 weeks ahead.', 'no source line or AI label by default');
  const log = env.sheet('Audit Log').slice(-1)[0].join(' ');
  assert.match(log, /sources: VA Handbook/);
  assert.doesNotMatch(log, /Made Up/);
  env.props.SHOW_SOURCES = 'on';
  env.props.SHOW_AI_LABEL = 'on';
  const r2 = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'How do I request leave?'));
  assert.match(r2.text, /Source: VA Handbook_/);
  assert.doesNotMatch(r2.text, /Made Up/);
  assert.match(r2.text, /AI assistant/);
  // Remembers the VA's DM space for future notifications.
  assert.strictEqual(env.sheet('Users').find((u) => u[0] === 'va@inava.test')[6], 'spaces/dm-u6');
});

test('Claude request is well formed (model, version, structured output, fallbacks, caching)', () => {
  const env = setupEnv();
  claudeReturns(env, answer({}));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'hello'));
  const req = env.sent.claude[0];
  assert.strictEqual(req.headers['anthropic-version'], '2026-10-21');
  // Default: the cheapest model, which has no server-side fallback.
  assert.strictEqual(req.body.model, 'claude-haiku-5-5');
  assert.ok(!('fallbacks' in req.body));
  assert.ok(!('anthropic-beta' in req.headers));
  assert.strictEqual(req.body.output_config.format.type, 'json_schema');
  assert.strictEqual(req.body.output_config.effort, 'low');
  assert.deepStrictEqual(req.body.system[1].cache_control, { type: 'ephemeral' });
  assert.ok(!('temperature' in req.body));

  // A bigger model, chosen in Script Properties, gets refusal fallbacks.
  env.props.CLAUDE_MODEL = 'claude-opus-5-5';
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'hello again'));
  const req2 = env.sent.claude[1];
  assert.strictEqual(req2.body.model, 'claude-opus-5-5');
  assert.strictEqual(req2.body.fallbacks, 'default');
  assert.strictEqual(req2.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
});

test('token use and estimated cost are written to the Audit Log', () => {
  const env = setupEnv();
  env.setClaude(() => ({ body: { stop_reason: 'end_turn',
    usage: { input_tokens: 200, cache_read_input_tokens: 20000, cache_creation_input_tokens: 0, output_tokens: 400 },
    content: [{ type: 'text', text: JSON.stringify(answer({})) }] } }));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'hello'));
  const log = env.sheet('Audit Log').slice(-1)[0].join(' ');
  // Haiku: 200*0.10 + 20000*0.01 + 400*0.50 = 420 per million = $0.0004
  assert.match(log, /in 200, cache read 20000, cache write 0, out 400, ~\$0\.0004/);
});

test('manager asking in a VA space only gets VA-safe docs for that space\'s client', () => {
  const env = setupEnv();
  claudeReturns(env, answer({}));
  env.ctx.onMessage(spaceEvent('cyn@inava.test', 'users/2', 'spaces/acme', 'What are Acme hours?'));
  assert.deepStrictEqual(kbSent(env).sort(), ['Acme Service Agreement', 'Client FAQ', 'VA Handbook']);
});

test('a VA never gets documents for a client account they do not work on', () => {
  const env = setupEnv();
  claudeReturns(env, answer({}));
  env.ctx.onMessage(dmEvent('va3@inava.test', 'users/8', 'What hours does my client get?'));
  assert.deepStrictEqual(kbSent(env).sort(), ['Client FAQ', 'Text Handbook', 'VA Handbook']);
  env.ctx.onMessage(dmEvent('va2@inava.test', 'users/7', 'What hours does my client get?'));
  assert.deepStrictEqual(kbSent(env).sort(), ['Acme Service Agreement', 'Client FAQ', 'Text Handbook', 'VA Handbook']);
});

test('management in an internal space sees the management playbook', () => {
  const env = setupEnv();
  claudeReturns(env, answer({}));
  env.ctx.onMessage(spaceEvent('mabelle@inava.test', 'users/3', 'spaces/team', 'escalation matrix?'));
  assert.ok(kbSent(env).indexOf('Management Playbook') >= 0);
  assert.ok(kbSent(env).indexOf('Old Policy') < 0);
});

test('client care concern opens a ticket and privately notifies Cyn', () => {
  const env = setupEnv();
  claudeReturns(env, answer({ reply: 'I am sorry to hear that. I have passed this on.', escalate: true,
    category: 'CLIENT_CARE', priority: 'HIGH', concern_summary: 'Client unhappy with VA response times.',
    recommended_action: 'Call the client today.' }));
  const r = env.ctx.onMessage(spaceEvent('va2@inava.test', 'users/7', 'spaces/acme', 'My client is unhappy with response times'));
  assert.doesNotMatch(r.text, /INAVA-|ticket/i, 'the VA never sees ticket jargon');
  assert.match(env.sent.claude[0].body.messages.slice(-1)[0].content, /Team members: CLIENT_CARE: Cyn from our Client Care team; OPERATIONS: Mabelle from our Operations team/);
  const t = ticketRows(env)[0];
  assert.strictEqual(t.Status, 'Assigned');
  assert.strictEqual(t['Assignee Email'], 'cyn@inava.test');
  assert.strictEqual(t['Source Link'], 'https://chat.google.com/room/acme/abc');
  const dm = env.sent.chat.find((c) => c.url.indexOf('spaces/dm-cyn/messages') >= 0);
  assert.ok(dm, 'Cyn was messaged');
  assert.match(dm.body.text, /^\*\*NEW CONCERN\*\*\n\nName: Andy \(Acme VA\)\n\nConcern: My client is unhappy with response times\n\nConversation: https:\/\/chat.google.com\/room\/acme\/abc\n\nWhen it's sorted/);
  assert.match(dm.body.text, /When it's sorted, reply: done INAVA-\d{6}-001$/);
  assert.match(dm.body.text, /chat\.google\.com\/room\/acme\/abc/);
});

test('repeat of the same concern is a follow-up, not a duplicate ticket', () => {
  const env = setupEnv();
  claudeReturns(env, answer({ escalate: true, category: 'RECRUITMENT_HR', concern_summary: 'Leave request for Dec 24.' }));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'I need Dec 24 off'));
  const id = ticketRows(env)[0]['Ticket ID'];
  claudeReturns(env, answer({ escalate: true, category: 'RECRUITMENT_HR', duplicate_of_ticket: id, intent: 'FOLLOW_UP' }));
  const r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'Also it is for my sister\'s wedding'));
  assert.strictEqual(ticketRows(env).length, 1);
  assert.doesNotMatch(r.text, /INAVA-/);
  assert.match(ticketRows(env)[0].History, /Follow-up/);
  // Claude is told about the open ticket the second time.
  assert.match(env.sent.claude[1].body.messages.slice(-1)[0].content, /INAVA-\d{6}-001 \(open, RECRUITMENT_HR, raised/);
});

test('Claude can mark a same-category concern as a separate ticket with NEW', () => {
  const env = setupEnv();
  claudeReturns(env, answer({ escalate: true, category: 'CLIENT_CARE', concern_summary: 'Client A unhappy.' }));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'Client A is unhappy'));
  claudeReturns(env, answer({ escalate: true, category: 'CLIENT_CARE', concern_summary: 'Client B unhappy.', duplicate_of_ticket: 'NEW' }));
  const r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'Different client, B, is also unhappy'));
  assert.strictEqual(ticketRows(env).length, 2);
  assert.doesNotMatch(r.text, /INAVA-/);
});

test('team inbox: every concern, payroll included, goes to the team chat with figures removed', () => {
  const env = setupEnv();
  env.sheet('Spaces')[0][7] = 'Team Inbox';
  env.sheet('Spaces').push(['spaces/inbox', 'INAVA Team Inbox', 'YES', 'MANAGEMENT', '', toSerial(new Date()), '', 'YES']);
  claudeReturns(env, answer({ escalate: true, category: 'CLIENT_CARE', priority: 'HIGH', concern_summary: 'x' }));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'My client is unhappy'));
  claudeReturns(env, answer({ escalate: true, category: 'PAYROLL', priority: 'URGENT', concern_summary: 'x' }));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'I was not paid $1,250.00, my account is 1234 5678 90'));
  const posts = env.sent.chat.filter((c) => c.url.indexOf('spaces/inbox/messages') >= 0);
  assert.strictEqual(posts.length, 2);
  assert.match(cardText(posts[0]), /^<font color="#D93025"><b>NEW CONCERN<\/b><\/font><br><br>Name: Vicky VA<br><br>Concern: My client is unhappy/);
  assert.match(cardText(posts[0]), /reply here: @Ask INAVA done INAVA-/);
  assert.match(cardText(posts[1]), /Concern: I was not paid \[amount removed\], my account is \[number removed\]/);
  assert.doesNotMatch(cardText(posts[0]), /For |Designated/);
  assert.ok(!env.sent.chat.some((c) => /dm-cyn|dm-pay/.test(c.url)), 'no private messages when the team chat is used');
  const id = ticketRows(env)[0]['Ticket ID'];
  const done = env.ctx.onMessage(spaceEvent('cyn@inava.test', 'users/2', 'spaces/inbox', 'done ' + id + ' sorted'));
  assert.match(done.text, /marked as done/);
});

test('one handler for everything: the VA is told the designated contact, the handler gets it', () => {
  const env = setupEnv();
  env.sheet('Spaces')[0][7] = 'Team Inbox';
  env.sheet('Spaces').push(['spaces/inbox', 'INAVA Team Inbox', 'YES', 'MANAGEMENT', '', toSerial(new Date()), '', 'YES']);
  env.sheet('Routing').forEach((r, i) => { if (i > 0) r[2] = 'mabelle@inava.test'; });
  claudeReturns(env, answer({ escalate: true, category: 'CLIENT_CARE', concern_summary: 'x' }));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'My client is unhappy'));
  const post = env.sent.chat.find((c) => c.url.indexOf('spaces/inbox/messages') >= 0);
  assert.match(cardText(post), /^<font color="#D93025"><b>NEW CONCERN<\/b>/);
  assert.match(env.sent.claude[0].body.messages.slice(-1)[0].content, /CLIENT_CARE: Cyn from our Client Care team/);
  assert.strictEqual(ticketRows(env)[0]['Assignee Email'], 'mabelle@inava.test');
});

test('morning briefing: posts to briefing spaces, falls back without search, remembers history', () => {
  const env = setupEnv();
  env.sheet('Spaces')[0][7] = 'Team Inbox';
  env.sheet('Spaces')[0][8] = 'Morning Briefing';
  env.sheet('Spaces').push(['spaces/internal', 'INAVA Internal', 'YES', 'MANAGEMENT', '', toSerial(new Date()), '', 'NO', 'YES']);
  env.sheet('Spaces').push(['spaces/off', 'Not approved', 'NO', 'MANAGEMENT', '', toSerial(new Date()), '', 'NO', 'YES']);
  let calls = 0;
  env.setClaude((req) => {
    calls++;
    if (calls === 1) {
      assert.strictEqual(req.body.model, 'claude-sonnet-5-5');
      assert.strictEqual(req.body.tools[0].type, 'web_search_20260209');
      assert.match(req.body.system, /PH & US alerts/);
      return { body: { stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: {} }] } };
    }
    if (calls === 2) {
      assert.strictEqual(req.body.messages[1].role, 'assistant', 'paused turn is sent back');
      return { body: { stop_reason: 'end_turn', content: [{ type: 'text', text: '💬 Quote\n💡 VA tip: tip\n🔥 Trending for VAs:\n- item (source: x.com)\n🌏 PH & US alerts:\n- No major alerts today. Stay safe!' }] } };
    }
    throw new Error('unexpected call');
  });
  env.ctx.dailyMorning();
  const posts = env.sent.chat.filter((c) => c.url.indexOf('spaces/internal/messages') >= 0);
  assert.strictEqual(posts.length, 1);
  assert.match(cardText(posts[0]), /GOOD MORNING, TEAM!/);
  assert.match(cardText(posts[0]), /PH &amp; US alerts/);
  assert.ok(!env.sent.chat.some((c) => c.url.indexOf('spaces/off') >= 0), 'unapproved spaces get nothing');
  assert.match(env.props.BRIEFING_HISTORY, /VA tip: tip/);

  // Search not available: second attempt without the tool.
  calls = 0;
  env.setClaude((req) => {
    calls++;
    if (req.body.tools) return { code: 400, body: { error: { message: 'web search is disabled for this organization' } } };
    assert.match(req.body.system, /do not repeat/i);
    assert.match(req.body.system, /VA tip: tip/, 'recent briefings are passed in');
    return { body: { stop_reason: 'end_turn', content: [{ type: 'text', text: '💬 Another quote' }] } };
  });
  env.ctx.postMorningBriefing();
  assert.strictEqual(calls, 2);

  // Preview goes only to the admin's private chat and is not remembered.
  env.props.ADMIN_EMAIL = 'britt@inava.test';
  const historyBefore = env.props.BRIEFING_HISTORY;
  const spacePosts = env.sent.chat.filter((c) => c.url.indexOf('spaces/internal') >= 0).length;
  env.ctx.previewMorningBriefing();
  assert.match(cardText(env.sent.chat.slice(-1)[0]), /^<font[^>]*><b>PREVIEW/);
  assert.match(env.sent.chat.slice(-1)[0].url, /spaces\/dm-britt\/messages/);
  assert.strictEqual(env.sent.chat.filter((c) => c.url.indexOf('spaces/internal') >= 0).length, spacePosts);
  assert.strictEqual(env.props.BRIEFING_HISTORY, historyBefore);

  // Weekends: nothing at all.
  env.ctx.__weekday = '6';
  const before = env.sent.chat.length;
  env.ctx.dailyMorning();
  assert.strictEqual(env.sent.chat.length, before);
  assert.strictEqual(env.sent.chat.filter((c) => c.url.indexOf('spaces/internal/messages') >= 0).length, 2);
});

test('payroll: figures are stripped and only the cleared payroll contact gets details', () => {
  const env = setupEnv();
  claudeReturns(env, answer({ escalate: true, category: 'PAYROLL', priority: 'URGENT',
    concern_summary: 'Missing pay of $1,250.00 to account 1234 5678 90.' }));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'I was not paid $1,250.00, my account is 1234 5678 90'));
  const t = ticketRows(env)[0];
  assert.doesNotMatch(t.Summary, /1,250|1234/);
  const dm = env.sent.chat.find((c) => c.url.indexOf('spaces/dm-pay/messages') >= 0);
  assert.ok(dm);
  // The cleared payroll contact sees the amount privately; account numbers are never sent.
  assert.match(dm.body.text, /Name: Vicky VA\n\nConcern: I was not paid \$1,250\.00, my account is \[number removed\]\n\nWhen it's sorted/);
  assert.ok(!env.sent.chat.some((c) => /dm-mabelle|dm-cyn|dm-verge/.test(c.url)));
});

test('payroll routed to someone not cleared: details withheld', () => {
  const env = setupEnv();
  const row = env.sheet('Routing').find((r) => r[0] === 'PAYROLL');
  row[4] = 'NO';
  claudeReturns(env, answer({ escalate: true, category: 'PAYROLL', concern_summary: 'Deduction question.' }));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'Why the deduction?'));
  const dm = env.sent.chat.find((c) => c.url.indexOf('spaces/dm-pay/messages') >= 0);
  assert.match(dm.body.text, /Concern: Payroll matter \(details are private/);
  assert.doesNotMatch(dm.body.text, /Deduction question/);
});

test('assignee without a DM space: ticket stays New and Operations is alerted', () => {
  const env = setupEnv();
  const cyn = env.sheet('Users').find((u) => u[0] === 'cyn@inava.test');
  cyn[5] = ''; cyn[6] = '';
  claudeReturns(env, answer({ escalate: true, category: 'CLIENT_CARE', concern_summary: 'x' }));
  const r = env.ctx.onMessage(dmEvent('va2@inava.test', 'users/7', 'problem'));
  assert.strictEqual(ticketRows(env)[0].Status, 'New');
  assert.doesNotMatch(r.text, /INAVA-/);
  const alert = env.sent.chat.find((c) => c.url.indexOf('spaces/dm-mabelle/messages') >= 0);
  assert.ok(alert, 'Operations is told straight away');
  assert.match(alert.body.text, /COULDN'T REACH CYN/);
});

test('ticket commands: assignee can update, others cannot, and never in a space', () => {
  const env = setupEnv();
  claudeReturns(env, answer({ escalate: true, category: 'CLIENT_CARE', concern_summary: 'x' }));
  env.ctx.onMessage(dmEvent('va2@inava.test', 'users/7', 'problem'));
  const id = ticketRows(env)[0]['Ticket ID'];
  const before = env.sent.claude.length;

  let r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'status ' + id + ' resolved'));
  assert.match(r.text, /Only the assigned/);
  r = env.ctx.onMessage(spaceEvent('cyn@inava.test', 'users/2', 'spaces/team', 'status ' + id + ' resolved'));
  assert.match(r.text, /direct message/);
  r = env.ctx.onMessage(dmEvent('cyn@inava.test', 'users/2', 'status ' + id + ' in progress called them'));
  assert.match(r.text, /now In Progress/);
  assert.match(ticketRows(env)[0].History, /In Progress by Cyn: called them/);
  r = env.ctx.onMessage(dmEvent('cyn@inava.test', 'users/2', 'my tickets'));
  assert.match(r.text, new RegExp(id));
  r = env.ctx.onMessage(dmEvent('va2@inava.test', 'users/7', 'ticket ' + id));
  assert.match(r.text, /currently in progress/);
  r = env.ctx.onMessage(dmEvent('va2@inava.test', 'users/7', 'my tickets'));
  assert.match(r.text, /with Cyn from our Client Care team \(in progress\)/);
  assert.doesNotMatch(r.text, /INAVA-/);
  r = env.ctx.onMessage(dmEvent('cyn@inava.test', 'users/2', 'done ' + id + ' spoke to the client'));
  assert.match(r.text, /marked as done/);
  assert.strictEqual(ticketRows(env)[0].Status, 'Resolved');
  // Requester raised it by DM, so they are told it is resolved.
  assert.ok(env.sent.chat.some((c) => c.url.indexOf('spaces/dm-u7/messages') >= 0 && /Cyn from our Client Care team has marked what you raised with me as sorted/.test(c.body.text)));
  assert.strictEqual(env.sent.claude.length, before, 'commands never call Claude');
});

test('daily check-in: one message listing open concerns, nothing when all are done', () => {
  const env = setupEnv();
  claudeReturns(env, answer({ escalate: true, category: 'CLIENT_CARE', priority: 'HIGH', concern_summary: 'x' }));
  env.ctx.onMessage(dmEvent('va2@inava.test', 'users/7', 'Client unhappy with the report'));
  claudeReturns(env, answer({ escalate: true, category: 'PAYROLL', concern_summary: 'x' }));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'I was not paid $500'));
  const count = (s) => env.sent.chat.filter((c) => c.url.indexOf(s) >= 0).length;

  // No team chat: the check-in goes privately to Operations (Mabelle).
  const before = count('dm-mabelle');
  env.ctx.checkOverdueTickets();
  assert.strictEqual(count('dm-mabelle'), before + 1);
  const dm = env.sent.chat.filter((c) => c.url.indexOf('dm-mabelle') >= 0).slice(-1)[0].body.text;
  assert.match(dm, /^\*\*DAILY CHECK-IN: 2 CONCERNS STILL OPEN\*\*/);
  assert.match(dm, /Andy \(Acme VA\) \(today\): Client unhappy with the report/);
  assert.match(dm, /Vicky VA \(today\): I was not paid \[amount removed\]/);

  // With a team chat: one card there, nothing private.
  env.sheet('Spaces')[0][7] = 'Team Inbox';
  env.sheet('Spaces').push(['spaces/inbox', 'INAVA Team Inbox', 'YES', 'MANAGEMENT', '', toSerial(new Date()), '', 'YES']);
  const dmBefore = count('dm-');
  env.ctx.checkOverdueTickets();
  assert.strictEqual(count('spaces/inbox/messages'), 1);
  assert.strictEqual(count('dm-'), dmBefore);
  assert.match(cardText(env.sent.chat.slice(-1)[0]), /DAILY CHECK-IN: 2 CONCERNS STILL OPEN/);

  // Everything done: no message at all.
  const tickets = env.sheet('Tickets');
  tickets.slice(1).forEach((r) => { r[tickets[0].indexOf('Status')] = 'Resolved'; });
  const total = env.sent.chat.length;
  env.ctx.checkOverdueTickets();
  assert.strictEqual(env.sent.chat.length, total);
});

test('slow answer is posted through the Chat API instead of timing out', () => {
  const env = setupEnv();
  claudeReturns(env, answer({ reply: 'Slow answer' }), { advanceMs: 26000 });
  const r = env.ctx.onMessage(spaceEvent('mabelle@inava.test', 'users/3', 'spaces/team', 'question'));
  assert.strictEqual(JSON.stringify(r), '{}');
  const post = env.sent.chat.find((c) => c.url.indexOf('spaces/team/messages') >= 0);
  assert.match(post.body.text, /Slow answer/);
  assert.strictEqual(post.body.thread.name, 'spaces/team/threads/abc');
  assert.match(post.url, /REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD/);
});

test('Workspace add-on event format is understood and answered in add-on format', () => {
  const env = setupEnv();
  claudeReturns(env, answer({ reply: 'Add-on reply' }));
  const r = env.ctx.onMessage({ chat: {
    user: { name: 'users/6', email: 'va@inava.test' },
    messagePayload: {
      space: { name: 'spaces/dm-u6', spaceType: 'DIRECT_MESSAGE' },
      message: { text: 'hi', sender: { type: 'HUMAN' } },
    },
  } });
  assert.match(r.hostAppDataAction.chatDataAction.createMessageAction.message.text, /Add-on reply/);
});

test('fallbacks rejected by the API: retried once without them', () => {
  const env = setupEnv();
  env.props.CLAUDE_MODEL = 'claude-opus-5-5';
  let calls = 0;
  env.setClaude((req) => {
    calls++;
    if (req.body.fallbacks) return { code: 400, body: { error: { message: 'fallbacks: not supported' } } };
    return { body: { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer({ reply: 'ok' })) }] } };
  });
  const r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'hi'));
  assert.strictEqual(calls, 2);
  assert.ok(!('anthropic-beta' in env.sent.claude[1].headers));
  assert.match(r.text, /ok/);
});

test('refusal and API errors produce a safe message, never a crash', () => {
  const env = setupEnv();
  env.setClaude(() => ({ body: { stop_reason: 'refusal', content: [] } }));
  let r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'something'));
  assert.match(r.text, /can't help with that/);
  env.setClaude(() => ({ code: 500, body: 'boom' }));
  r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'something'));
  assert.match(r.text, /something went wrong/);
});

test('messages from other bots are ignored', () => {
  const env = setupEnv();
  claudeReturns(env, answer({}));
  const ev = dmEvent('va@inava.test', 'users/6', 'hi');
  ev.message.sender.type = 'BOT';
  assert.strictEqual(JSON.stringify(env.ctx.onMessage(ev)), '{}');
  assert.strictEqual(env.sent.claude.length, 0);
});

test('conversation memory carries the last turns', () => {
  const env = setupEnv();
  claudeReturns(env, answer({ reply: 'First answer' }));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'first question'));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'second question'));
  const msgs = env.sent.claude[1].body.messages;
  assert.strictEqual(msgs.length, 3);
  assert.strictEqual(msgs[0].content, 'first question');
  assert.match(msgs[1].content, /First answer/);
});

test('redaction strips amounts and account numbers but keeps ordinary text', () => {
  const env = createEnv();
  const out = env.ctx.redactSensitive_('Paid PHP 25,000 and $300.50 to 1234 5678 9012 on 2026-10-15 for 3 days');
  assert.doesNotMatch(out, /25,000|300\.50|1234/);
  assert.match(out, /2026-10-15 for 3 days/);
});

// ---------------- Phase 1: concern detection, follow-ups, status, reliability ----------------

function withInbox(env) {
  env.sheet('Spaces')[0][7] = 'Team Inbox';
  env.sheet('Spaces').push(['spaces/inbox', 'INAVA Team Inbox', 'YES', 'MANAGEMENT', '', toSerial(new Date()), '', 'YES']);
  return env;
}
const inboxPosts = (env) => env.sent.chat.filter((c) => c.url.indexOf('spaces/inbox/messages') >= 0);
const replyOf = (r) => (r.hostAppDataAction ? r.hostAppDataAction.chatDataAction.createMessageAction.message.text : r.text);

test('clear concern: one ticket, NEW CONCERN card unchanged, handoff only after delivery', () => {
  const env = withInbox(setupEnv());
  claudeReturns(env, answer({ intent: 'CONCERN',
    reply: 'That sounds really stressful. I\'ve passed this to Ms. Cynthia already. Try replying to the client calmly today.',
    concerns: [concern({ category: 'CLIENT_CARE', priority: 'HIGH', handoff: 'I\'ve passed this to Cyn from our Client Care team, and they\'ll get back to you.' })] }));
  const r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'My client shouted at me on a call today'));
  assert.strictEqual(ticketRows(env).length, 1);
  const t = ticketRows(env)[0];
  assert.strictEqual(t.Status, 'Assigned');
  assert.strictEqual(t.Delivery, 'Delivered');
  assert.match(t['Source Message ID'], /^spaces\/dm\/messages\/m\d+#0$/);
  const posts = inboxPosts(env);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(cardText(posts[0]), '<font color="#D93025"><b>NEW CONCERN</b></font><br><br>Name: Vicky VA<br><br>' +
    'Concern: My client shouted at me on a call today<br><br>When it\'s sorted, reply here: @Ask INAVA done ' + t['Ticket ID']);
  assert.match(posts[0].url, /messageId=client-inava-\d{6}-001-new$/);
  // The AI's own "I've passed this" claim is removed; the system's handoff is added once.
  assert.strictEqual(r.text, 'That sounds really stressful. Try replying to the client calmly today.\n\n' +
    'I\'ve passed this to Cyn from our Client Care team, and they\'ll get back to you.');
  assert.doesNotMatch(r.text, /INAVA-|ticket/i);
});

test('casual conversation and ordinary handbook questions never create tickets', () => {
  const env = withInbox(setupEnv());
  // Even if the AI wrongly lists a concern for small talk, nothing is recorded.
  claudeReturns(env, answer({ intent: 'CASUAL', reply: 'Aww, thank you! Have a great shift.', concerns: [concern({})] }));
  let r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'hi! salamat sa tabang ganina'));
  assert.strictEqual(r.text, 'Aww, thank you! Have a great shift.');
  claudeReturns(env, answer({ intent: 'QUESTION', reply: 'Request leave 2 weeks ahead using the leave form.', sources: ['VA Handbook'] }));
  r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'Paano mag-file ng leave?'));
  assert.strictEqual(r.text, 'Request leave 2 weeks ahead using the leave form.');
  assert.strictEqual(ticketRows(env).length, 0);
  assert.strictEqual(inboxPosts(env).length, 0);
});

test('ambiguous message: a short clarifying question, no ticket yet', () => {
  const env = withInbox(setupEnv());
  claudeReturns(env, answer({ intent: 'CLARIFY', reply: 'I\'m here for you. Can you tell me a bit more about what happened?',
    concerns: [concern({ category: 'OPERATIONS' })] }));
  const r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'May problema ako'));
  assert.match(r.text, /tell me a bit more/);
  assert.strictEqual(ticketRows(env).length, 0);
  assert.strictEqual(inboxPosts(env).length, 0);
});

test('same-issue follow-up: history appended, UPDATE ON A CONCERN card, no new ticket', () => {
  const env = withInbox(setupEnv());
  claudeReturns(env, answer({ escalate: true, category: 'CLIENT_CARE' }));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'Acme is unhappy with my report'));
  const id = ticketRows(env)[0]['Ticket ID'];
  env.setClaude((req) => {
    // The AI sees this VA's own concern (and nobody else's).
    assert.match(req.body.messages.slice(-1)[0].content, new RegExp(id + ' \\(open, CLIENT_CARE'));
    return { body: { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer({ intent: 'FOLLOW_UP', reply: 'Thanks for the update.',
      concerns: [concern({ related_ticket: id, handoff: 'I\'ve let Cyn from our Client Care team know about this update.' })] })) }] } };
  });
  const r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'Acme emailed again, now asking for a refund'));
  assert.strictEqual(ticketRows(env).length, 1);
  assert.match(ticketRows(env)[0].History, /Follow-up from Vicky VA: Acme emailed again, now asking for a refund/);
  const posts = inboxPosts(env);
  assert.strictEqual(posts.length, 2);
  assert.match(cardText(posts[1]), /^<font color="#D93025"><b>UPDATE ON A CONCERN<\/b><\/font><br><br>Name: Vicky VA<br><br>Concern: Acme emailed again/);
  assert.match(cardText(posts[1]), new RegExp('reply here: @Ask INAVA done ' + id + '$'));
  assert.strictEqual(r.text, 'Thanks for the update.\n\nI\'ve let Cyn from our Client Care team know about this update.');
});

test('unrelated concerns are kept separate, and nobody else\'s ticket can be updated', () => {
  const env = withInbox(setupEnv());
  claudeReturns(env, answer({ escalate: true, category: 'CLIENT_CARE' }));
  env.ctx.onMessage(dmEvent('va2@inava.test', 'users/7', 'Acme is unhappy'));
  const andysTicket = ticketRows(env)[0]['Ticket ID'];
  // Same VA, same category, minutes later: a different client is a new concern (no 24-hour merge).
  claudeReturns(env, answer({ escalate: true, category: 'CLIENT_CARE', duplicate_of_ticket: 'NEW' }));
  env.ctx.onMessage(dmEvent('va2@inava.test', 'users/7', 'Separately, my other client Beta keeps messaging at 2am'));
  assert.strictEqual(ticketRows(env).length, 2);
  // Another VA names Andy's ticket: it is not touched; Olive gets her own ticket.
  claudeReturns(env, answer({ escalate: true, category: 'CLIENT_CARE', duplicate_of_ticket: andysTicket }));
  env.ctx.onMessage(dmEvent('va3@inava.test', 'users/8', 'My client is unhappy too'));
  const rows = ticketRows(env);
  assert.strictEqual(rows.length, 3);
  assert.doesNotMatch(rows[0].History, /Olive/);
  assert.strictEqual(rows[2]['Requester Email'], 'va3@inava.test');
  assert.strictEqual(inboxPosts(env).filter((p) => /NEW CONCERN/.test(cardText(p))).length, 3);
});

test('multiple issues in one message: separate tickets and cards, each with its own words', () => {
  const env = withInbox(setupEnv());
  const msg = 'My client wants to cut my hours to 20. Also I need to file leave on Nov 3 for a check-up.';
  claudeReturns(env, answer({ intent: 'CONCERN', reply: 'Thanks for telling me both of these.', concerns: [
    concern({ category: 'CLIENT_CARE', concern_text: 'My client wants to cut my hours to 20.', handoff: 'I\'ve passed the hours issue to Cyn from our Client Care team.' }),
    concern({ category: 'RECRUITMENT_HR', concern_text: 'I need to file leave on Nov 3 for a check-up.', handoff: 'Your leave request is with Verge from our HR team.' }),
    // Made-up text (not in the message) falls back to the whole message.
    concern({ category: 'OPERATIONS', concern_text: 'The VA is threatening to quit immediately.', handoff: 'Ops will check.' }),
  ] }));
  const r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', msg));
  const rows = ticketRows(env);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].Summary, 'My client wants to cut my hours to 20.');
  assert.strictEqual(rows[1].Summary, 'I need to file leave on Nov 3 for a check-up.');
  assert.strictEqual(rows[2].Summary, msg);
  assert.deepStrictEqual(rows.map((x) => x['Source Message ID'].slice(-2)), ['#0', '#1', '#2']);
  assert.strictEqual(inboxPosts(env).length, 3);
  assert.match(r.text, /hours issue to Cyn[^]*leave request is with Verge/);
});

test('Bisaya and Tagalog concerns are recorded word for word, reply in their language', () => {
  const env = withInbox(setupEnv());
  claudeReturns(env, answer({ intent: 'CONCERN', reply: 'Pasensya kaayo, kabalo ko nga lisod kana.',
    concerns: [concern({ category: 'CLIENT_CARE', priority: 'HIGH', handoff: 'Gipasa na nako ni kay Cyn sa among Client Care team, ug siya ang mo-contact nimo.' })] }));
  let r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'Nasuko akong client kay late ko nakareply, unsa man akong buhaton?'));
  assert.strictEqual(r.text, 'Pasensya kaayo, kabalo ko nga lisod kana.\n\nGipasa na nako ni kay Cyn sa among Client Care team, ug siya ang mo-contact nimo.');
  claudeReturns(env, answer({ intent: 'CONCERN', reply: 'Naiintindihan kita, nakakabahala talaga \'yan. Naipasa ko na ito sa Payroll.',
    concerns: [concern({ category: 'PAYROLL', priority: 'URGENT', handoff: 'Ipinasa ko na ito sa aming Payroll Team.' })] }));
  r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'Wala pa akong sahod for this cutoff, ₱8,500 dapat'));
  // The AI's own claim is removed from the caring part; the handoff is added after delivery.
  assert.strictEqual(r.text, 'Naiintindihan kita, nakakabahala talaga \'yan.\n\nIpinasa ko na ito sa aming Payroll Team.');
  const rows = ticketRows(env);
  assert.strictEqual(rows[0].Summary, 'Nasuko akong client kay late ko nakareply, unsa man akong buhaton?');
  assert.strictEqual(rows[1].Summary, 'Wala pa akong sahod for this cutoff, [amount removed] dapat');
  assert.match(cardText(inboxPosts(env)[1]), /Concern: Wala pa akong sahod for this cutoff, \[amount removed\] dapat/);
});

test('passwords, codes, card and account numbers never reach notifications, the sheet or memory', () => {
  const env = withInbox(setupEnv());
  claudeReturns(env, answer({ escalate: true, category: 'CLIENT_CARE' }));
  const msg = 'Client portal is locked. Password: Sunflower2024! and the OTP is 482913. ' +
    'Card 4111 1111 1111 1111 was charged twice. My password is not working either.';
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', msg));
  const card = cardText(inboxPosts(env)[0]);
  const row = ticketRows(env)[0];
  [card, row.Summary, row.History, JSON.stringify(env.cache)].forEach((text) => {
    assert.doesNotMatch(text, /Sunflower|482913|4111/);
  });
  assert.match(row.Summary, /Password: \[removed\]! and the OTP is \[removed\]\. Card \[number removed\] was charged twice\. My password is not working either\./);
  assert.strictEqual(env.ctx.redactCredentials_('my PIN 1234, acct no. 0012-3456-78, key sk-ant-abc123def456ghi789'),
    'my PIN [removed], acct no. [number removed], key [removed]');
  assert.strictEqual(env.ctx.redactCredentials_('Meeting on 2026-11-03 at 9:30 for 3 hours'), 'Meeting on 2026-11-03 at 9:30 for 3 hours');
});

test('status questions: own tickets only, wording matches the recorded status exactly', () => {
  const env = withInbox(setupEnv());
  claudeReturns(env, answer({ escalate: true, category: 'RECRUITMENT_HR' }));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'I need Dec 24 off'));
  const id = ticketRows(env)[0]['Ticket ID'];
  const ask = (text, which, extra) => {
    claudeReturns(env, answer(Object.assign({ intent: 'STATUS_REQUEST', reply: '', status_ticket: which }, extra || {})));
    return env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', text)).text;
  };
  const statusCol = env.sheet('Tickets')[0].indexOf('Status');
  const setStatus = (s) => { env.sheet('Tickets')[1][statusCol] = s; };

  let r = ask('Any update sa akong leave?', id);
  assert.match(r, /^It's with Verge from our HR team \(passed on \d+ \w{3}\)\. There's no update recorded from them yet\.$/);
  assert.doesNotMatch(r, /review|working|looking/i);
  setStatus('In Progress');
  assert.strictEqual(ask('kumusta na?', id), 'Verge from our HR team is working on it.');
  setStatus('Awaiting Response');
  assert.match(ask('update?', id), /waiting for a reply from you/);
  setStatus('Resolved');
  assert.match(ask('update?', id), /marked it as sorted on \d+ \w{3}\. If it's still not right/);
  assert.strictEqual(ticketRows(env).length, 1, 'a status question never creates a ticket');

  // A ticket that belongs to someone else is never described, even if the AI names it.
  claudeReturns(env, answer({ escalate: true, category: 'CLIENT_CARE' }));
  env.ctx.onMessage(dmEvent('va2@inava.test', 'users/7', 'Acme problem'));
  const andys = ticketRows(env)[1]['Ticket ID'];
  r = ask('what about ' + andys + '?', andys);
  assert.doesNotMatch(r, /Andy|Acme|Client Care/);
  assert.match(r, /can't find anything you've raised/);
  assert.match(env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'ticket ' + andys)).text, /could not find/);
  assert.doesNotMatch(env.sent.claude.slice(-1)[0].body.messages.slice(-1)[0].content.split('<message>')[0], new RegExp(andys));
});

test('status question matching several concerns: asks which one; privately in shared spaces', () => {
  const env = withInbox(setupEnv());
  claudeReturns(env, answer({ escalate: true, category: 'RECRUITMENT_HR' }));
  env.ctx.onMessage(dmEvent('va2@inava.test', 'users/7', 'Leave request for Dec 24'));
  claudeReturns(env, answer({ escalate: true, category: 'PAYROLL' }));
  env.ctx.onMessage(dmEvent('va2@inava.test', 'users/7', 'Missing pay for October'));
  claudeReturns(env, answer({ intent: 'STATUS_REQUEST', reply: '', status_ticket: 'AMBIGUOUS' }));
  let r = env.ctx.onMessage(dmEvent('va2@inava.test', 'users/7', 'any update?'));
  assert.match(r.text, /Which one do you mean\?\n- the one from \d+ \w{3}: "Leave request for Dec 24"\n- the one from \d+ \w{3}: "Missing pay for October"/);
  r = env.ctx.onMessage(spaceEvent('va2@inava.test', 'users/7', 'spaces/acme', 'any update?'));
  assert.match(r.text, /send me a direct message/);
  assert.doesNotMatch(r.text, /Leave|pay for October/);
  // Payroll status is never discussed in a shared space.
  const payId = ticketRows(env)[1]['Ticket ID'];
  claudeReturns(env, answer({ intent: 'STATUS_REQUEST', reply: '', status_ticket: payId }));
  r = env.ctx.onMessage(spaceEvent('va2@inava.test', 'users/7', 'spaces/acme', 'update on my pay?'));
  assert.match(r.text, /about pay, so let's keep it private/);
  assert.strictEqual(ticketRows(env).length, 2);
});

test('failed Team Inbox delivery: honest reply, saved as Pending, retried once without duplicates', () => {
  const env = withInbox(setupEnv());
  env.setChatFail((url) => (url.indexOf('spaces/inbox') >= 0 ? 503 : null));
  claudeReturns(env, answer({ intent: 'CONCERN', reply: 'I\'m sorry that happened.',
    concerns: [concern({ category: 'CLIENT_CARE', handoff: 'I\'ve passed this to Cyn.' })] }));
  const r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'Client was rude to me'));
  assert.match(r.text, /^I'm sorry that happened\.\n\nI've noted this, but I couldn't reach the team just now/);
  assert.doesNotMatch(r.text, /passed this to Cyn/, 'no false delivery confirmation');
  let t = ticketRows(env)[0];
  assert.strictEqual(t.Status, 'New');
  assert.strictEqual(t.Delivery, 'Pending');
  assert.strictEqual(inboxPosts(env).length, 0);

  // Team chat back: the next run posts it exactly once; later runs post nothing.
  env.setChatFail(null);
  env.ctx.retryUndeliveredConcerns();
  env.ctx.retryUndeliveredConcerns();
  t = ticketRows(env)[0];
  assert.strictEqual(inboxPosts(env).length, 1);
  assert.match(cardText(inboxPosts(env)[0]), /^<font color="#D93025"><b>NEW CONCERN<\/b>/);
  assert.strictEqual(t.Status, 'Assigned');
  assert.strictEqual(t.Delivery, 'Delivered');

  // Posted, but the run died before recording it: the retry sees "already exists" and does not post again.
  env.ctx.updateObject_(env.get('SHEETS.TICKETS'), 2, { 'Delivery': 'Pending', 'Status': 'New' });
  env.ctx.retryUndeliveredConcerns();
  assert.strictEqual(inboxPosts(env).length, 1);
  assert.strictEqual(ticketRows(env)[0].Delivery, 'Delivered');
});

test('failed follow-up delivery is retried as the same UPDATE card, once', () => {
  const env = withInbox(setupEnv());
  claudeReturns(env, answer({ escalate: true, category: 'CLIENT_CARE' }));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'Acme is unhappy'));
  const id = ticketRows(env)[0]['Ticket ID'];
  env.setChatFail((url) => (url.indexOf('spaces/inbox') >= 0 ? 500 : null));
  claudeReturns(env, answer({ intent: 'FOLLOW_UP', reply: 'Got it.', concerns: [concern({ related_ticket: id, handoff: 'I\'ve let Cyn know.' })] }));
  const r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'Acme now wants a call tomorrow'));
  assert.match(r.text, /couldn't reach the team/);
  assert.match(ticketRows(env)[0].Delivery, /^Pending update u-[0-9a-f]{8}$/);
  env.setChatFail(null);
  env.ctx.retryUndeliveredConcerns();
  env.ctx.retryUndeliveredConcerns();
  const updates = inboxPosts(env).filter((p) => /UPDATE ON A CONCERN/.test(cardText(p)));
  assert.strictEqual(updates.length, 1);
  assert.match(cardText(updates[0]), /Concern: Acme now wants a call tomorrow/);
  assert.strictEqual(ticketRows(env)[0].Delivery, 'Delivered');
});

test('ticket could not be saved: the VA is told it was not passed on', () => {
  const env = withInbox(setupEnv());
  const realAppend = env.ctx.appendObject_;
  env.ctx.appendObject_ = function (def, obj) {
    if (def.name === 'Tickets') throw new Error('Sheets API post failed (503)');
    return realAppend(def, obj);
  };
  claudeReturns(env, answer({ intent: 'CONCERN', reply: 'That must be frustrating.', concerns: [concern({ handoff: 'I\'ve passed this to Cyn.' })] }));
  const r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'Client keeps changing deadlines'));
  assert.match(r.text, /That must be frustrating\.\n\nSorry, I couldn't record this just now[^]*not been passed on yet/);
  assert.doesNotMatch(r.text, /passed this to Cyn/);
  assert.strictEqual(inboxPosts(env).length, 0);
});

test('duplicate event processing: a re-delivered message is handled once', () => {
  const env = withInbox(setupEnv());
  claudeReturns(env, answer({ escalate: true, category: 'CLIENT_CARE' }));
  const ev = dmEvent('va@inava.test', 'users/6', 'My client is unhappy');
  env.ctx.onMessage(ev);
  assert.strictEqual(JSON.stringify(env.ctx.onMessage(JSON.parse(JSON.stringify(ev)))), '{}');
  assert.strictEqual(env.sent.claude.length, 1, 'no second AI call');
  // Even after the 6-hour memory is gone (or two runs race), the sheet stops a second ticket or card.
  Object.keys(env.cache).filter((k) => k.indexOf('msg:') === 0).forEach((k) => delete env.cache[k]);
  claudeReturns(env, answer({ intent: 'CONCERN', concerns: [concern({}), concern({ category: 'OPERATIONS' })] }));
  const r = env.ctx.onMessage(JSON.parse(JSON.stringify(ev)));
  assert.strictEqual(ticketRows(env).length, 1);
  assert.strictEqual(inboxPosts(env).length, 1);
  assert.match(r.text, /passed this to Cyn from our Client Care team/);
  assert.match(env.sheet('Audit Log').map((x) => x[4]).join(' '), /DUPLICATE_MESSAGE_IGNORED/);
});

test('urgent safety: unchanged concern card plus one urgent notice; ordinary upset gets none', () => {
  const env = withInbox(setupEnv());
  claudeReturns(env, answer({ intent: 'CONCERN', reply: 'I\'m really glad you told me. Please get somewhere safe.',
    concerns: [concern({ category: 'OPERATIONS', priority: 'HIGH', urgent_safety: true, handoff: 'I\'ve passed this to Mabelle from our Operations team.' })] }));
  const r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'A client said he knows where I live and will come to hurt me'));
  const posts = inboxPosts(env);
  assert.strictEqual(posts.length, 2);
  assert.match(cardText(posts[0]), /^<font color="#D93025"><b>NEW CONCERN<\/b><\/font><br><br>Name: Vicky VA<br><br>Concern: A client said/);
  assert.match(cardText(posts[1]), /^<font color="#D93025"><b>URGENT: SAFETY CONCERN<\/b><\/font><br><br>Name: Vicky VA<br><br>Please read the concern above and contact Vicky/);
  assert.strictEqual(ticketRows(env)[0].Priority, 'URGENT');
  assert.match(r.text, /If you're in immediate danger, please contact your local emergency services or seek immediate help from someone nearby\./);
  assert.doesNotMatch(r.text, /911/);
  // A plain fact, with no promise about who is available or when.
  assert.match(r.text, /I've let Mabelle from our Operations team know about this right away\./);
  assert.doesNotMatch(r.text, /passed this to Mabelle|get back to you|check in/);
  assert.strictEqual(ticketRows(env)[0]['Urgent Notice'], 'Posted');

  claudeReturns(env, answer({ intent: 'CONCERN', reply: 'That sounds exhausting.', concerns: [concern({ priority: 'HIGH' })] }));
  const r2 = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'My client is so rude, I am fed up'));
  assert.strictEqual(inboxPosts(env).length, 3, 'only the normal card');
  assert.doesNotMatch(r2.text, /emergency/);
  assert.strictEqual(ticketRows(env)[1]['Urgent Notice'], '');
});

test('new ticket columns are added to an existing sheet without touching its data', () => {
  const env = setupEnv();
  const tickets = env.sheet('Tickets');
  tickets[0] = tickets[0].slice(0, 18);
  tickets.push(['INAVA-261001-001', 'Assigned', 'CLIENT_CARE', 'NORMAL']);
  Object.keys(env.cache).filter((k) => k.indexOf('cols_ok:') === 0).forEach((k) => delete env.cache[k]);
  env.ctx.ensureColumns_(env.get('SHEETS.TICKETS'));
  assert.deepStrictEqual(tickets[0].slice(18), ['Source Message ID', 'Delivery', 'Delivery Attempts', 'Urgent Notice']);
  assert.strictEqual(tickets[1][0], 'INAVA-261001-001');
  // Older tickets have no Delivery value and are never re-sent.
  env.sheet('Spaces').push(['spaces/inbox', 'Inbox', 'YES', 'MANAGEMENT', '', toSerial(new Date()), '', 'YES']);
  env.ctx.retryUndeliveredConcerns();
  assert.strictEqual(env.sent.chat.length, 0);
});

test('live language test: checks each case, writes results, never posts or creates tickets', () => {
  const env = withInbox(setupEnv());
  env.setClaude((req) => {
    const msg = req.body.messages.slice(-1)[0].content.split('<message>\n')[1].split('\n</message>')[0];
    const casual = /Good morning|salamat|Salamat|okay ra|tired/.test(msg);
    const status = /update on my leave/.test(msg);
    const out = status ? answer({ intent: 'STATUS_REQUEST', status_ticket: 'INAVA-261020-001', reply: 'You will see it below.' })
      : answer({ intent: casual ? 'CASUAL' : 'QUESTION', reply: 'Hello!' });
    return { body: { stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 500 },
      content: [{ type: 'text', text: JSON.stringify(out) }] } };
  });
  const snapshot = () => JSON.stringify(['Tickets', 'Audit Log', 'Users', 'Spaces', 'Routing', 'Knowledge'].map((n) => env.sheet(n)));
  const before = snapshot();
  const propsBefore = JSON.stringify(env.props);
  env.ctx.runLanguageEval();
  // Only the Eval Results tab is written: tickets, audit log, settings, chat and memory are untouched.
  assert.strictEqual(snapshot(), before);
  assert.strictEqual(JSON.stringify(env.props), propsBefore);
  assert.ok(!Object.keys(env.cache).some((k) => /^hist:|^msg:|pending_delivery/.test(k)));
  const rows = env.sheet('Eval Results');
  assert.strictEqual(rows[0][0], 'Time');
  const total = rows[rows.length - 1];
  assert.strictEqual(total[1], 'TOTAL');
  assert.match(total[11], /^\d+\/34 cases passed, estimated cost \$0\.0119/);
  assert.ok(rows.some((r) => r[10] === 'PASS') && rows.some((r) => r[10] === 'CHECK'));
  // A status case is answered by the real status code from the made-up record, not the AI's words.
  const statusRow = rows.find((r) => r[3] === 'Any update on my leave request?');
  assert.match(statusRow[13], /^It's with Verge from our HR team \(passed on 20 Oct\)\. There's no update recorded from them yet\.$/);
  assert.strictEqual(statusRow[10], 'PASS');
  // The leave policy case is checked for both notice periods and an HR referral.
  assert.match(rows.find((r) => r[3] === 'How many days ahead do I need to request leave?')[11], /two-week rule missing.*ten-business-day rule missing.*no referral to HR/);
  assert.strictEqual(ticketRows(env).length, 0);
  assert.strictEqual(env.sent.chat.length, 0);

  // Stops at the budget.
  env.setClaude(() => ({ body: { stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 300000 },
    content: [{ type: 'text', text: JSON.stringify(answer({})) }] } }));
  const calls = env.sent.claude.length;
  env.ctx.runLanguageEval();
  assert.strictEqual(env.sent.claude.length - calls, 2, '$0.15 per call: stops after passing $0.20');
});

test('routine client frustration gets advice and an offer, no ticket; mistreatment is escalated', () => {
  const env = withInbox(setupEnv());
  claudeReturns(env, answer({ intent: 'QUESTION', concerns: [],
    reply: 'Ay, that sounds stressful. Reply to your client right away with a short apology and a clear time for the next update.\n\n' +
      'Would you like me to pass this to Cyn from our Client Care team if it keeps happening?' }));
  let r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'Nasuko akong client kay late ko nakareply, unsa man akong buhaton?'));
  assert.strictEqual(ticketRows(env).length, 0);
  assert.strictEqual(inboxPosts(env).length, 0);
  assert.match(r.text, /short apology[^]*Would you like me to pass this to Cyn/, 'an offer (a question) is kept');

  claudeReturns(env, answer({ intent: 'CONCERN', reply: 'Nobody should be spoken to like that, and I\'m sorry.',
    concerns: [concern({ category: 'CLIENT_CARE', priority: 'HIGH', handoff: 'I\'ve passed this to Cyn from our Client Care team, and they\'ll get back to you.' })] }));
  r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'My client curses at me and calls me useless almost every day'));
  assert.strictEqual(ticketRows(env).length, 1);
  assert.strictEqual(ticketRows(env)[0].Priority, 'HIGH');
  assert.match(cardText(inboxPosts(env)[0]), /^<font color="#D93025"><b>NEW CONCERN<\/b><\/font><br><br>Name: Vicky VA<br><br>Concern: My client curses at me/);
  assert.strictEqual(r.text, 'Nobody should be spoken to like that, and I\'m sorry.\n\nI\'ve passed this to Cyn from our Client Care team, and they\'ll get back to you.');
});

test('premature handoff claims from the AI are never shown, in any language', () => {
  const claims = [
    'I\'ve passed this on so the payroll team can look into it.',
    'Schedule changes need approval, so I\'ve flagged both parts for the team to decide.',
    'Nasa tabi ka namin, so I\'ve passed this along so someone on the team can check in with you.',
    'Busa akong i-pasa ang imong request ngadto sa team.',
    'Naipasa ko na ito sa Payroll.',
    'Gipasa na nako ni kay Ms. Cynthia.',
    'I\'ll let Ms. Cynthia know right away.',
    'Ms. Vergelyn will get back to you soon.',
    'This has been forwarded to HR.',
    'I\'ll call emergency services for you.',
  ];
  // Delivered: each claim is replaced by the system's one handoff, never shown twice.
  const env = withInbox(setupEnv());
  claims.forEach((claim, i) => {
    claudeReturns(env, answer({ intent: 'CONCERN', reply: 'I\'m sorry you\'re dealing with this. ' + claim,
      concerns: [concern({ handoff: 'HANDOFF-' + i })] }));
    const r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'Concern number ' + i));
    assert.strictEqual(r.text, 'I\'m sorry you\'re dealing with this.\n\nHANDOFF-' + i, claim);
  });
  // Not delivered: no claim at all, only the honest note.
  const env2 = withInbox(setupEnv());
  env2.setChatFail((url) => (url.indexOf('spaces/inbox') >= 0 ? 503 : null));
  claims.forEach((claim) => {
    claudeReturns(env2, answer({ intent: 'CONCERN', reply: claim, concerns: [concern({ handoff: 'I\'ve passed this to Cyn.' })] }));
    const r = env2.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'x ' + claim));
    assert.match(r.text, /^I've noted this, but I couldn't reach the team just now/, claim);
    assert.doesNotMatch(r.text, /passed|flagged|forwarded|i-pasa|Naipasa|Gipasa|let Ms|get back|emergency services for you/i, claim);
  });
  // Ordinary advice is left alone.
  const env3 = setupEnv();
  const advice = 'Ipasa mo ang leave form sa HR dalawang linggo bago. Reply to your client calmly. Let me help you write it.';
  claudeReturns(env3, answer({ intent: 'QUESTION', reply: advice }));
  assert.strictEqual(env3.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'how do I file leave and reply to my client?')).text, advice);
});

test('urgent safety notice: retried until posted, never posted twice, at most one per ticket', () => {
  const env = withInbox(setupEnv());
  // The concern card goes through, the urgent card does not.
  env.setChatFail((url) => (/-urgent/.test(url) ? 503 : null));
  claudeReturns(env, answer({ intent: 'CONCERN', reply: 'Please stay safe.',
    concerns: [concern({ category: 'OPERATIONS', urgent_safety: true, handoff: 'I\'ve passed this to Mabelle.' })] }));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'A client threatened to come to my house'));
  const urgentPosts = () => inboxPosts(env).filter((p) => /URGENT: SAFETY CONCERN/.test(cardText(p)));
  assert.strictEqual(inboxPosts(env).length, 1);
  // (The bot already retried once right after replying.)
  assert.match(ticketRows(env)[0]['Urgent Notice'], /^Pending [12]$/);

  env.setChatFail(null);
  env.ctx.retryUndeliveredConcerns();
  env.ctx.retryUndeliveredConcerns();
  assert.strictEqual(urgentPosts().length, 1);
  assert.strictEqual(ticketRows(env)[0]['Urgent Notice'], 'Posted');
  assert.match(ticketRows(env)[0].History, /Urgent safety notice posted on retry \d/);

  // Posted but not recorded (the run died): the retry gets "already exists" and posts nothing.
  env.ctx.updateObject_(env.get('SHEETS.TICKETS'), 2, { 'Urgent Notice': 'Pending 2' });
  env.ctx.retryUndeliveredConcerns();
  assert.strictEqual(urgentPosts().length, 1);
  assert.strictEqual(ticketRows(env)[0]['Urgent Notice'], 'Posted');

  // An urgent follow-up on the same ticket: an UPDATE card, but no second urgent card.
  const id = ticketRows(env)[0]['Ticket ID'];
  claudeReturns(env, answer({ intent: 'FOLLOW_UP', reply: 'Thank you for telling me.',
    concerns: [concern({ category: 'OPERATIONS', related_ticket: id, urgent_safety: true, handoff: 'I\'ve let Mabelle know.' })] }));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'He messaged me again saying he is outside'));
  assert.strictEqual(inboxPosts(env).filter((p) => /UPDATE ON A CONCERN/.test(cardText(p))).length, 1);
  assert.strictEqual(urgentPosts().length, 1);

  // Concern card not delivered: the urgent card waits, then follows it, in that order.
  const env2 = withInbox(setupEnv());
  env2.setChatFail((url) => (url.indexOf('spaces/inbox') >= 0 ? 503 : null));
  claudeReturns(env2, answer({ intent: 'CONCERN', reply: 'Please stay safe.', concerns: [concern({ urgent_safety: true })] }));
  env2.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'Someone is threatening me'));
  assert.strictEqual(ticketRows(env2)[0]['Urgent Notice'], 'Pending');
  env2.setChatFail(null);
  env2.ctx.retryUndeliveredConcerns();
  const headings = inboxPosts(env2).map((p) => cardText(p).match(/<b>([^<]+)<\/b>/)[1]);
  assert.deepStrictEqual(headings, ['NEW CONCERN', 'URGENT: SAFETY CONCERN']);
  assert.strictEqual(ticketRows(env2)[0]['Urgent Notice'], 'Posted');
});

test('final message: handoff goes where the AI put [HANDOFF], only after delivery; failure note there otherwise', () => {
  const reply = 'That sounds really stressful, and I\'m sorry it happened.\n\n[HANDOFF]\n\nIn the meantime:\n- write down what was said\n- keep replies calm';
  const env = withInbox(setupEnv());
  claudeReturns(env, answer({ intent: 'CONCERN', reply, concerns: [concern({ handoff: 'I\'ve passed this to Cyn from our Client Care team, and they\'ll get back to you.' })] }));
  let r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'My client yelled at me'));
  assert.strictEqual(r.text, 'That sounds really stressful, and I\'m sorry it happened.\n\n' +
    'I\'ve passed this to Cyn from our Client Care team, and they\'ll get back to you.\n\n' +
    'In the meantime:\n- write down what was said\n- keep replies calm', 'bullets keep their lines');

  const env2 = withInbox(setupEnv());
  env2.setChatFail((url) => (url.indexOf('spaces/inbox') >= 0 ? 503 : null));
  claudeReturns(env2, answer({ intent: 'CONCERN', reply, concerns: [concern({ handoff: 'I\'ve passed this to Cyn.' })] }));
  r = env2.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'My client yelled at me'));
  assert.match(r.text, /^That sounds really stressful, and I'm sorry it happened\.\n\nI've noted this, but I couldn't reach the team just now[^\n]*\n\nIn the meantime:\n- write down/);
  assert.doesNotMatch(r.text, /passed this to Cyn|\[HANDOFF\]/);

  // No concern (for example a question): the marker simply disappears.
  claudeReturns(env2, answer({ intent: 'QUESTION', reply: 'Here is how to file leave. [HANDOFF]' }));
  assert.strictEqual(env2.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'how to file leave?')).text, 'Here is how to file leave.');
});

test('every kind of premature ticket-action claim is removed; advice and offers stay', () => {
  const env = setupEnv();
  const strip = (t) => env.ctx.cleanReply_(t);
  [
    'I\'ve added this to your earlier concern.',
    'I\'ve noted it for the team.',
    'I\'ve flagged this.',
    'I\'ve shared this with management.',
    'I\'ve logged your request.',
    'We\'ve passed it to HR.',
    'It has been added to your concern.',
    'Naidagdag ko na ito sa concern mo.',
    'Na-note ko na ito para sa team.',
    'Ibinahagi ko na sa management.',
    'Gi-share na nako sa team.',
    'Gidugang na nako sa imong concern.',
    'Akong i-share ni sa management.',
  ].forEach((claim) => assert.strictEqual(strip('Sorry to hear that. ' + claim), 'Sorry to hear that.', claim));
  [
    'Would you like me to add this to your earlier concern?',
    'Gusto mo bang i-share ko ito sa team?',
    'Add the exact dates to your leave request.',
    'Note the time it happened and what was said.',
    'Let me help you add a line to your draft.',
    'Ipasa mo ang leave form sa HR.',
    'I-share nimo ang screenshot sa imong client.',
  ].forEach((ok) => assert.strictEqual(strip(ok), ok, ok));
});

test('status answer is exactly the recorded status from the Tickets sheet, not the AI\'s wording', () => {
  const env = withInbox(setupEnv());
  claudeReturns(env, answer({ escalate: true, category: 'RECRUITMENT_HR' }));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'I need Dec 24 off'));
  const id = ticketRows(env)[0]['Ticket ID'];
  env.sheet('Tickets')[1][env.sheet('Tickets')[0].indexOf('Status')] = 'In Progress';
  claudeReturns(env, answer({ intent: 'STATUS_REQUEST', status_ticket: id,
    reply: 'Kumusta! Makikita mo ang kasalukuyang status nito sa ibaba. Please wait for the update.' }));
  const r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'Kumusta na yung leave ko?'));
  assert.strictEqual(r.text, 'Verge from our HR team is working on it.');
  assert.strictEqual(ticketRows(env).length, 1);
});

test('credentials are removed before anything reaches the AI, the sheet, the team chat or memory', () => {
  const env = withInbox(setupEnv());
  claudeReturns(env, answer({ escalate: true, category: 'OPERATIONS', reply: 'Please change that password.' }));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'Portal locked. My password is Sunflower2024 and PIN 4321'));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'thanks'));
  const toAi = JSON.stringify(env.sent.claude.map((c) => c.body.messages));
  assert.doesNotMatch(toAi, /Sunflower2024|4321/);
  assert.match(toAi, /My password is \[removed\] and PIN \[removed\]/);
  const row = ticketRows(env)[0];
  [row.Summary, row.History, cardText(inboxPosts(env)[0]), JSON.stringify(env.cache), JSON.stringify(env.sheet('Audit Log'))]
    .forEach((t) => assert.doesNotMatch(t, /Sunflower2024|4321/));
});

test('routing: each category names its designated contact and reaches the single handler', () => {
  const env = withInbox(setupEnv());
  // Like the live sheet: every row is handled by Mabelle; payroll is introduced as Ms. Vergelyn.
  const names = { CLIENT_CARE: 'Ms. Cynthia', OPERATIONS: 'Ms. Mabelle', RECRUITMENT_HR: 'Ms. Vergelyn', PAYROLL: 'Ms. Vergelyn' };
  env.sheet('Routing').slice(1).forEach((r) => { r[1] = names[r[0]]; r[2] = 'mabelle@inava.test'; });
  const expected = {
    CLIENT_CARE: 'Ms. Cynthia from our Client Care team', OPERATIONS: 'Ms. Mabelle from our Operations team',
    RECRUITMENT_HR: 'Ms. Vergelyn from our HR team', PAYROLL: 'our Payroll Team',
  };
  Object.keys(expected).forEach((cat, i) => {
    claudeReturns(env, answer({ intent: 'CONCERN', reply: '', concerns: [concern({ category: cat })] }));
    const r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'Concern ' + i + ' about ' + cat + ' and $1,200.00'));
    assert.strictEqual(r.text, cat === 'PAYROLL' ? 'I\'ve forwarded your concern to our Payroll Team for review.'
      : 'I\'ve passed this to ' + expected[cat] + ', and they\'ll get back to you.');
    assert.strictEqual(ticketRows(env)[i]['Assignee Email'], 'mabelle@inava.test');
    assert.strictEqual(ticketRows(env)[i].Category, cat);
  });
  // Even with a person's name in the Payroll row, VAs (and the AI) only ever see "our Payroll Team".
  assert.match(env.sent.claude[0].body.messages.slice(-1)[0].content, /PAYROLL: our Payroll Team(;|\n)/);
  assert.match(cardText(inboxPosts(env)[3]), /Concern: Concern 3 about PAYROLL and \[amount removed\]/);
  // With no name, or the generic label, in the Payroll row (the live sheet), the same.
  ['', 'our Payroll Team'].forEach((v) => {
    env.sheet('Routing').find((r) => r[0] === 'PAYROLL')[1] = v;
    env.ctx.resetMemo_();
    assert.strictEqual(env.ctx.teamNames_().PAYROLL, 'our Payroll Team');
  });
  assert.ok(!JSON.stringify(env.sheet('Routing')).match(/britt/i), 'Boss Britt is never in routing');
});

test('reply language is detected and sent to the AI (Tagalog, Bisaya, English, mixed)', () => {
  const env = setupEnv();
  const lang = (t) => env.ctx.replyLanguage_(t);
  assert.match(lang('May problema ako'), /^Tagalog/);
  assert.match(lang('Kumusta na yung leave ko?'), /^Tagalog/);
  assert.match(lang('Naa koy concern'), /^Bisaya/);
  assert.match(lang('Salamat kaayo sa tabang ganina!'), /^Bisaya/);
  assert.match(lang('Wala pa ko nasweldohan karong cutoff, ug gusto pud ko mag-file og leave sunod semana.'), /^Bisaya/);
  assert.strictEqual(lang('How many days ahead do I need to request leave?'), 'English');
  assert.match(lang('Pabago-bago ang instructions ng client ko this week, medyo nakaka-frustrate. Any tips?'), /^Tagalog.*mixed with English/);
  claudeReturns(env, answer({}));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'Naa koy concern'));
  assert.match(env.sent.claude[0].body.messages.slice(-1)[0].content, /Reply language: Bisaya \(Cebuano\), not Tagalog/);
  assert.match(env.sent.claude[0].body.system[0].text, /never answer a Bisaya message in Tagalog/);
});

test('policy grounding: the leave notice conflict is sent with the documents, and can be switched off', () => {
  const env = setupEnv();
  claudeReturns(env, answer({}));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'How early do I file leave?'));
  const kb = env.sent.claude[0].body.system[1].text;
  assert.match(kb, /<policy_notes>[^]*two \(2\) weeks[^]*ten \(10\) business days[^]*HR has not yet confirmed/);
  assert.match(env.sent.claude[0].body.system[0].text, /Never say or imply that a request is approved/);
  assert.match(env.sent.claude[0].body.system[0].text, /give both as written and say HR confirms which applies/);
  env.props.POLICY_NOTES = 'none';
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'How early do I file leave?'));
  assert.doesNotMatch(env.sent.claude[1].body.system[1].text, /policy_notes/);
});

test('payroll: handled internally by its assignee, but VAs only ever hear "our Payroll Team"', () => {
  const env = withInbox(setupEnv());
  // Internally assigned to Verge (payroll-cleared); the public label stays generic.
  const pay = env.sheet('Routing').find((r) => r[0] === 'PAYROLL');
  pay[1] = 'our Payroll Team'; pay[2] = 'verge@inava.test'; pay[4] = 'YES';
  claudeReturns(env, answer({ intent: 'CONCERN',
    reply: 'I\'m sorry your pay is late. Verge handles payroll, so she will sort it out. Please don\'t share bank details here.\n\n[HANDOFF]',
    concerns: [concern({ category: 'PAYROLL', priority: 'HIGH', handoff: 'I\'ve passed this to Ms. Vergelyn, who handles payroll.' })] }));
  let r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'Wala pa akong sahod ngayong cutoff'));
  assert.strictEqual(r.text, 'I\'m sorry your pay is late. Please don\'t share bank details here.\n\n' +
    'I\'ve forwarded your concern to our Payroll Team for review.');
  const t = ticketRows(env)[0];
  assert.strictEqual(t['Assignee Email'], 'verge@inava.test');
  assert.strictEqual(t['Assignee Name'], 'our Payroll Team');
  assert.match(cardText(inboxPosts(env)[0]), /^<font color="#D93025"><b>NEW CONCERN<\/b>/);

  // Status, "my tickets", follow-up and the resolution note: never a name.
  const id = t['Ticket ID'];
  env.sheet('Tickets')[1][env.sheet('Tickets')[0].indexOf('Status')] = 'In Progress';
  claudeReturns(env, answer({ intent: 'STATUS_REQUEST', reply: '', status_ticket: id }));
  assert.strictEqual(env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'update sa sahod ko?')).text, 'Our Payroll Team is working on it.');
  assert.match(env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'my tickets')).text, /with our Payroll Team \(in progress\)/);
  claudeReturns(env, answer({ intent: 'FOLLOW_UP', reply: 'Thanks.', concerns: [concern({ category: 'PAYROLL', related_ticket: id, handoff: 'I\'ve let Verge know.' })] }));
  assert.strictEqual(env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'It was for Oct 15')).text, 'Thanks.\n\nI\'ve let our Payroll Team know about this update.');
  // Verge (the internal assignee) can close it; the VA's note names only the team.
  r = env.ctx.onMessage(dmEvent('verge@inava.test', 'users/4', 'done ' + id));
  assert.match(r.text, /marked as done/);
  const note = env.sent.chat.filter((c) => c.url.indexOf('dm-u6') >= 0).slice(-1)[0];
  assert.match(note.body.text, /^Quick update: Our Payroll Team has marked/);
  env.sent.chat.filter((c) => /dm-u6|spaces\/dm\//.test(c.url)).forEach((c) => assert.doesNotMatch(JSON.stringify(c.body), /Verg/));
  // Non-payroll answers can still name people.
  assert.strictEqual(env.ctx.cleanReply_('Ms. Vergelyn from HR can help with your leave.'), 'Ms. Vergelyn from HR can help with your leave.');
});

test('sensitive personal disclosure: generic card and sheet text, urgent notice kept, VA identifiable', () => {
  const env = withInbox(setupEnv());
  const words = 'Honestly I have been thinking about ending my life lately';
  claudeReturns(env, answer({ intent: 'CONCERN', reply: 'I\'m really glad you told me, and I\'m sorry you\'re carrying this.\n\n[HANDOFF]',
    concerns: [concern({ category: 'RECRUITMENT_HR', priority: 'URGENT', urgent_safety: true, sensitive_personal: true,
      concern_text: words, recommended_action: 'Vicky says she is thinking about ending her life.' })] }));
  const r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', words));
  const generic = 'Sensitive personal safety concern. Please contact this VA privately as soon as possible.';
  const t = ticketRows(env)[0];
  assert.strictEqual(t.Summary, generic);
  assert.strictEqual(t['Recommended Action'], 'Contact the VA privately as soon as possible.');
  assert.strictEqual(t['Requester Email'], 'va@inava.test', 'the manager can identify and contact the VA');
  assert.doesNotMatch(JSON.stringify(env.sheet('Tickets')) + JSON.stringify(env.sheet('Audit Log')), /ending my life|ending her life/);
  const posts = inboxPosts(env);
  // Same NEW CONCERN layout, generic concern line, then the urgent notice.
  assert.strictEqual(cardText(posts[0]), '<font color="#D93025"><b>NEW CONCERN</b></font><br><br>Name: Vicky VA<br><br>' +
    'Concern: ' + generic + '<br><br>When it\'s sorted, reply here: @Ask INAVA done ' + t['Ticket ID']);
  assert.match(cardText(posts[1]), /URGENT: SAFETY CONCERN/);
  assert.strictEqual(t['Urgent Notice'], 'Posted');
  assert.match(r.text, /I've let Verge from our HR team know about this right away\.\n\nIf you're in immediate danger, please contact your local emergency services/);

  // A follow-up on it stays generic too.
  claudeReturns(env, answer({ intent: 'FOLLOW_UP', reply: 'Thank you for telling me.',
    concerns: [concern({ category: 'RECRUITMENT_HR', related_ticket: t['Ticket ID'], sensitive_personal: false })] }));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'It got worse last night, I took some pills'));
  assert.doesNotMatch(JSON.stringify(env.sheet('Tickets')), /pills/);
  assert.match(cardText(inboxPosts(env).slice(-1)[0]), /UPDATE ON A CONCERN<\/b><\/font><br><br>Name: Vicky VA<br><br>Concern: Sensitive personal safety concern/);

  // Non-sensitive concerns (even serious mistreatment) keep the VA's redacted words.
  claudeReturns(env, answer({ intent: 'CONCERN', reply: '', concerns: [concern({ priority: 'HIGH', sensitive_personal: false })] }));
  env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'My client screams at me and my password is Tulip99'));
  assert.match(cardText(inboxPosts(env).slice(-1)[0]), /Concern: My client screams at me and my password is \[removed\]/);
});

test('reviewLeavePolicy shows the leave passages and the temporary note, changing nothing', () => {
  const env = setupEnv();
  env.docs['doc1xxxxxxxxxxxxxxxxxxxxxx'] = 'Intro\nThe VA must file leave two (2) weeks before the leave date.\nOther text';
  const logs = [];
  env.ctx.console.log = (m) => logs.push(m);
  const before = JSON.stringify(env.tabs);
  env.ctx.reviewLeavePolicy();
  assert.strictEqual(JSON.stringify(env.tabs), before);
  assert.strictEqual(env.sent.chat.length + env.sent.claude.length, 0);
  assert.ok(logs.some((l) => /=== VA Handbook \(1 passage/.test(l) && /two \(2\) weeks before/.test(l)));
  assert.ok(logs.some((l) => /Temporary note currently sent to the AI:[^]*ten \(10\) business days/.test(l)));
});

let failed = 0;
tests.forEach((t) => {
  try {
    t.fn();
    console.log('PASS  ' + t.name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n      '));
  }
});
console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
process.exit(failed ? 1 : 0);

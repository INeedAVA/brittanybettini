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

function answer(overrides) {
  return Object.assign({
    reply: 'Here is the answer.', sources: [], escalate: false, category: 'NONE', priority: 'NORMAL',
    concern_summary: '', recommended_action: '', duplicate_of_ticket: '',
  }, overrides);
}

function claudeReturns(env, obj, extra) {
  env.setClaude(() => Object.assign({
    body: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(obj) }] },
  }, extra || {}));
}

function dmEvent(email, userId, text) {
  return {
    type: 'MESSAGE',
    user: { name: userId, email, displayName: email },
    space: { name: 'spaces/dm-' + userId.replace('users/', 'u'), type: 'DM', singleUserBotDm: true },
    message: { text, argumentText: text, sender: { type: 'HUMAN' }, thread: { name: 'spaces/dm/threads/t1' } },
  };
}

function spaceEvent(email, userId, spaceName, text) {
  return {
    type: 'MESSAGE',
    user: { name: userId, email },
    space: { name: spaceName, type: 'ROOM', displayName: spaceName },
    message: { text: '@Ask INAVA ' + text, argumentText: ' ' + text, sender: { type: 'HUMAN' },
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
  const r = env.ctx.onMessage(dmEvent('va@inava.test', 'users/6', 'Any update on my leave?'));
  assert.strictEqual(ticketRows(env).length, 1);
  assert.doesNotMatch(r.text, /INAVA-/);
  assert.match(ticketRows(env)[0].History, /Follow-up/);
  // Claude is told about the open ticket the second time.
  assert.match(env.sent.claude[1].body.messages.slice(-1)[0].content, /INAVA-\d{6}-001 \(RECRUITMENT_HR, Assigned\)/);
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
  assert.match(dm.body.text, /Name: Vicky VA\n\nConcern: I was not paid \$1,250\.00, my account is 1234 5678 90\n\nWhen it's sorted/);
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
  assert.match(r.text, /with Cyn \(in progress\)/);
  assert.doesNotMatch(r.text, /INAVA-/);
  r = env.ctx.onMessage(dmEvent('cyn@inava.test', 'users/2', 'done ' + id + ' spoke to the client'));
  assert.match(r.text, /marked as done/);
  assert.strictEqual(ticketRows(env)[0].Status, 'Resolved');
  // Requester raised it by DM, so they are told it is resolved.
  assert.ok(env.sent.chat.some((c) => c.url.indexOf('spaces/dm-u7/messages') >= 0 && /Cyn has marked what you raised with me as sorted/.test(c.body.text)));
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

/**
 * Google Chat entry points.
 *
 * Google Chat calls these functions directly:
 *   onMessage          someone @mentions INAVA Assist in a space, or messages it directly
 *   onAddedToSpace     INAVA Assist is added to a space or a direct message
 *   onRemovedFromSpace INAVA Assist is removed from a space
 *
 * In shared spaces Google Chat only sends INAVA Assist the messages that
 * @mention it, so it never answers ordinary conversation.
 *
 * Both Chat event formats are supported: the classic Chat app format and the
 * newer "Google Workspace add-on" format. normalizeEvent_ hides the difference.
 */

function onMessage(event) {
  const started = Date.now();
  resetMemo_();
  const ev = normalizeEvent_(event);
  if (!ev.message || (ev.message.sender && ev.message.sender.type === 'BOT')) return {};

  let text;
  try {
    text = handleMessage_(ev);
  } catch (e) {
    console.error('onMessage failed: ' + (e && e.stack ? e.stack : e));
    audit_({ email: ev.user.email, space: ev.space.name, action: 'ERROR', detail: String(e) });
    text = 'Sorry, something went wrong on my side and I could not answer. Please try again in a moment, ' +
      'or contact the INAVA team directly if it is urgent.' + aiFooter_();
  }
  return deliver_(ev, text, started);
}

function onAddedToSpace(event) {
  resetMemo_();
  const ev = normalizeEvent_(event);
  const user = findUser_(ev.user.email);
  if (ev.isDm) {
    if (user && user.active) rememberUserChatIds_(user, ev.user.name, ev.space.name);
    return reply_(ev, WELCOME_TEXT + (user && user.active ? '' : NOT_REGISTERED_TEXT));
  }
  const space = registerSpace_(ev.space.name, ev.space.displayName, ev.user.email);
  audit_({ email: ev.user.email, space: ev.space.name, action: 'ADDED_TO_SPACE', detail: ev.space.displayName });
  if (!space.approved) {
    return reply_(ev, 'Hi, I\'m *INAVA Assist*, an AI assistant for I Need A VA. ' +
      'I\'m not switched on in this space yet: an INAVA administrator needs to approve it first. ' +
      'Until then I won\'t answer here.');
  }
  return reply_(ev, WELCOME_TEXT);
}

function onRemovedFromSpace(event) {
  resetMemo_();
  const ev = normalizeEvent_(event);
  const space = findSpace_(ev.space.name);
  if (space) updateObject_(SHEETS.SPACES, space.row, { 'Approved': 'NO', 'Notes': 'Removed from space on ' + new Date() });
  audit_({ email: ev.user.email, space: ev.space.name, action: 'REMOVED_FROM_SPACE' });
  return {};
}

// Optional label under every reply. Off by default: Chat already marks the bot as an "App",
// and the welcome message says it is an AI. Set Script Property SHOW_AI_LABEL = on to show it.
const AI_FOOTER_TEXT = '\n\n_INAVA Assist \u00B7 AI assistant_';

const WELCOME_TEXT = [
  'Hi! I\'m INAVA Assist, the AI assistant for I Need A VA (I\'m not a person, but I\'m here to help).',
  '',
  '- Ask me anything about how things work at INAVA: policies, procedures, leave, schedules. I\'ll tell you which document my answer comes from.',
  '- If something\'s wrong or you need a person, just tell me. I\'ll pass it privately to the right person on the team and they\'ll get back to you.',
  '- If I\'m not sure about something, I\'ll ask the right person for you instead of guessing.',
  '- In a group space, @mention me. Please keep anything personal, especially about pay, to a direct message with me.',
].join('\n');

const NOT_REGISTERED_TEXT = '\n\nI don\'t have you on INAVA\'s approved list yet, so I can\'t answer questions for you. ' +
  'Please ask the INAVA team to add you.';

const HELP_TEXT = [
  'Just message me the way you would message a colleague: ask a question, or tell me what you need help with.',
  '',
  'For the INAVA team (in a direct message with me):',
  '- my tickets: the concerns passed to you',
  '- done INAVA-261027-001 (optional note): mark one as handled',
  '- status INAVA-261027-001 in progress (or awaiting response): update one',
].join('\n');

/** Does the work for one message and returns the reply text. */
function handleMessage_(ev) {
  const text = String(ev.message.argumentText || ev.message.text || '').trim();
  const user = findUser_(ev.user.email);
  if (!user || !user.active || !user.role) {
    audit_({ email: ev.user.email, space: ev.space.name, action: 'UNREGISTERED_USER' });
    return 'Hi, I\'m INAVA Assist, an AI assistant.' + NOT_REGISTERED_TEXT;
  }
  if (ev.isDm) rememberUserChatIds_(user, ev.user.name, ev.space.name);

  let space = null;
  if (!ev.isDm) {
    space = findSpace_(ev.space.name) || registerSpace_(ev.space.name, ev.space.displayName, ev.user.email);
    if (!space.approved) {
      return 'I\'m not switched on in this space yet. An INAVA administrator needs to approve it first.';
    }
  }

  const command = runCommand_(text, user, ev.isDm);
  if (command !== null) return command;
  if (!text) return WELCOME_TEXT;

  const ctx = buildAccessContext_(user, space);
  const knowledge = loadKnowledgeFor_(ctx);
  if (knowledge.truncated) {
    audit_({ email: user.email, role: user.role, space: ev.space.name, action: 'KNOWLEDGE_TOO_LARGE',
      detail: 'Some approved documents were left out of this answer. Shorten or split the knowledge base.' });
  }
  const openTickets = openTicketsFor_(user.email).map(function (t) {
    return { id: t.id, category: t.category, status: t.status, summary: t.summary };
  });
  const history = loadHistory_(user.email, ev.space.name);

  const decision = askClaude_({
    text: text, user: user, ctx: ctx, knowledge: knowledge, openTickets: openTickets, history: history,
    team: teamNames_(),
  });
  if (decision.refused) {
    audit_({ email: user.email, role: user.role, space: ev.space.name, action: 'REFUSED' });
    return 'Sorry, I can\'t help with that one. If it\'s something the INAVA team should look at, just say "please pass this to someone" and I\'ll let the right person know.' + aiFooter_();
  }

  let reply = String(decision.reply || '').trim();

  // Only cite documents this person was actually given.
  const titles = knowledge.docs.map(function (d) { return d.title; });
  const cited = (decision.sources || []).filter(function (s, i, arr) {
    return titles.indexOf(s) >= 0 && arr.indexOf(s) === i;
  });
  // Sources are always recorded in the Audit Log; shown in Chat only if SHOW_SOURCES = on.
  if (cited.length && isOn_('SHOW_SOURCES')) reply += '\n\n_Source: ' + cited.join('; ') + '_';

  let ticketId = '';
  if (decision.escalate && CATEGORIES.hasOwnProperty(decision.category)) {
    const result = handleEscalation_(decision, user, {
      spaceId: ev.space.name,
      spaceName: ev.space.displayName,
      isDm: ev.isDm,
      link: ev.isDm ? '' : conversationLink_(ev),
      message: text,
    });
    // Tracked quietly: the person never sees ticket numbers.
    ticketId = result.ticketId;
  }

  saveHistory_(user.email, ev.space.name, history, text, reply);
  audit_({ email: user.email, role: user.role, space: ev.space.name, action: 'ANSWERED', ticketId: ticketId,
    detail: (decision.escalate ? decision.category + ' / ' + decision.priority : 'no escalation') +
      (cited.length ? ' | sources: ' + cited.join('; ') : '') });
  return reply + aiFooter_();
}

/** Returns reply text for a command, or null if the text is not a command. */
function runCommand_(text, user, isDm) {
  const t = text.replace(/^\//, '').trim();
  if (/^help$/i.test(t)) return HELP_TEXT;
  if (/^(whoami|who am i)\??$/i.test(t)) {
    return 'You are *' + user.name + '* (' + user.email + '), role *' + user.role + '*' +
      (user.clientAccounts.length ? ', client accounts: ' + user.clientAccounts.join(', ') : '') + '.';
  }

  const myTickets = /^my tickets$/i.test(t);
  const view = t.match(/^ticket\s+(INAVA-\d{6}-\d+)\s*$/i);
  const status = t.match(/^status\s+(INAVA-\d{6}-\d+)\s+(new|assigned|in[ _-]?progress|awaiting[ _-]response|resolved)\b[\s:,.-]*([\s\S]*)$/i);
  const done = t.match(/^done\s+(INAVA-\d{6}-\d+)\b[\s:,.-]*([\s\S]*)$/i);
  if (!myTickets && !view && !status && !done) return null;
  if (!isDm) return 'Let\'s keep that private: send it to me in a direct message.';
  if (myTickets) return describeMyTickets_(user);
  if (view) return describeTicket_(user, view[1]);
  if (done) return updateTicketStatus_(user, done[1], 'resolved', done[2].trim());
  const words = status[2].replace(/inprogress/i, 'in progress');
  return updateTicketStatus_(user, status[1], words, status[3].trim());
}

/**
 * Returns the reply in the form Google Chat expects. If we are close to Chat's
 * 30-second limit, posts through the Chat API instead and returns an empty
 * acknowledgement.
 */
function deliver_(ev, text, started) {
  if (Date.now() - started < SYNC_REPLY_BUDGET_MS) return reply_(ev, text);
  try {
    postMessage_(ev.space.name, text, ev.message && ev.message.thread ? ev.message.thread.name : null);
  } catch (e) {
    console.error('Late reply could not be posted: ' + e);
  }
  return {};
}

function reply_(ev, text) {
  const message = { text: text };
  if (ev.format === 'addon') {
    return { hostAppDataAction: { chatDataAction: { createMessageAction: { message: message } } } };
  }
  return message;
}

/** A link team members can open to see the conversation (spaces only). */
function conversationLink_(ev) {
  const spaceId = String(ev.space.name).replace('spaces/', '');
  const thread = ev.message && ev.message.thread ? String(ev.message.thread.name || '') : '';
  const threadId = thread.split('/threads/')[1];
  if (threadId) return 'https://chat.google.com/room/' + spaceId + '/' + threadId;
  return ev.space.spaceUri || 'https://chat.google.com/room/' + spaceId;
}

/** Converts either Chat event format into one shape. */
function normalizeEvent_(e) {
  e = e || {};
  let format, type, message, user, space;
  if (e.chat) {
    format = 'addon';
    const c = e.chat;
    user = c.user || {};
    if (c.messagePayload) {
      type = 'MESSAGE';
      message = c.messagePayload.message;
      space = c.messagePayload.space;
    } else if (c.addedToSpacePayload) {
      type = 'ADDED_TO_SPACE';
      space = c.addedToSpacePayload.space;
    } else if (c.removedFromSpacePayload) {
      type = 'REMOVED_FROM_SPACE';
      space = c.removedFromSpacePayload.space;
    }
  } else {
    format = 'classic';
    type = e.type;
    message = e.message;
    user = e.user || {};
    space = e.space || (e.message && e.message.space);
  }
  space = space || (message && message.space) || {};
  return {
    format: format,
    type: type,
    message: message || null,
    user: { name: user.name || '', email: lower_(user.email), displayName: user.displayName || '' },
    space: space,
    isDm: space.type === 'DM' || space.spaceType === 'DIRECT_MESSAGE' || space.singleUserBotDm === true,
  };
}

function aiFooter_() {
  return isOn_('SHOW_AI_LABEL') ? AI_FOOTER_TEXT : '';
}

/**
 * Google Chat entry points.
 *
 * Google Chat calls these functions directly:
 *   onMessage          someone @mentions Ask INAVA in a space, or messages it directly
 *   onAddedToSpace     Ask INAVA is added to a space or a direct message
 *   onRemovedFromSpace Ask INAVA is removed from a space
 *
 * In shared spaces Google Chat only sends Ask INAVA the messages that
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

  // Google Chat can deliver the same message twice (for example after a timeout). Only the
  // first delivery is handled; Tickets.gs also checks the sheet, so an expired claim is safe too.
  const messageKey = String(ev.message.name || '');
  if (messageKey && !claimMessage_(messageKey)) {
    console.warn('Ignored a repeated delivery of ' + messageKey);
    return {};
  }

  let text;
  try {
    text = handleMessage_(ev, messageKey);
  } catch (e) {
    console.error('onMessage failed: ' + (e && e.stack ? e.stack : e));
    audit_({ email: ev.user.email, space: ev.space.name, action: 'ERROR', detail: String(e) });
    text = 'Sorry, something went wrong on my side and I could not answer. Please try again in a moment, ' +
      'or contact the INAVA team directly if it is urgent.' + aiFooter_();
  }
  const response = deliver_(ev, text, started);
  // Something saved earlier did not reach the team chat: try again now (never posts twice).
  if (Date.now() - started < 20000 && CacheService.getScriptCache().get('pending_delivery')) {
    try {
      retryPending_();
    } catch (e) {
      console.error('Retry of undelivered concerns failed: ' + e);
    }
  }
  return response;
}

/** True the first time a Chat message is seen (kept 6 hours). */
function claimMessage_(messageKey) {
  const cache = CacheService.getScriptCache();
  const key = 'msg:' + messageKey.slice(-200);
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return !cache.get(key);
  }
  try {
    if (cache.get(key)) return false;
    cache.put(key, '1', 21600);
    return true;
  } finally {
    lock.releaseLock();
  }
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
    return reply_(ev, 'Hi, I\'m Ask INAVA, an AI assistant for I Need A VA. ' +
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
const AI_FOOTER_TEXT = '\n\n_Ask INAVA \u00B7 AI assistant_';

const WELCOME_TEXT = [
  'Hi! I\'m Ask INAVA, the AI assistant for I Need A VA (I\'m not a person, but I\'m here to help).',
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
function handleMessage_(ev, messageKey) {
  const text = String(ev.message.argumentText || ev.message.text || '').trim();
  const user = findUser_(ev.user.email);
  if (!user || !user.active || !user.role) {
    audit_({ email: ev.user.email, space: ev.space.name, action: 'UNREGISTERED_USER' });
    return 'Hi, I\'m Ask INAVA, an AI assistant.' + NOT_REGISTERED_TEXT;
  }
  if (ev.isDm) rememberUserChatIds_(user, ev.user.name, ev.space.name);

  let space = null;
  if (!ev.isDm) {
    space = findSpace_(ev.space.name) || registerSpace_(ev.space.name, ev.space.displayName, ev.user.email);
    if (!space.approved) {
      return 'I\'m not switched on in this space yet. An INAVA administrator needs to approve it first.';
    }
  }

  const command = runCommand_(text, user, ev.isDm || !!(space && space.teamInbox));
  if (command !== null) return command;
  if (!text) return WELCOME_TEXT;

  const ctx = buildAccessContext_(user, space);
  const knowledge = loadKnowledgeFor_(ctx);
  if (knowledge.truncated) {
    audit_({ email: user.email, role: user.role, space: ev.space.name, action: 'KNOWLEDGE_TOO_LARGE',
      detail: 'Some approved documents were left out of this answer. Shorten or split the knowledge base.' });
  }
  // Only the person's own concerns are ever looked up or shown to the AI.
  const tickets = recentTicketsFor_(user.email).map(function (t) {
    return { id: t.id, category: t.category, open: t.status !== 'Resolved', raised: shortDate_(t.created), summary: t.summary };
  });
  const history = loadHistory_(user.email, ev.space.name);

  // Passwords, codes and card or account numbers never go to the AI (it only needs to know one was shared).
  const safeText = redactCredentials_(text);
  const decision = askClaude_({
    text: safeText, user: user, ctx: ctx, knowledge: knowledge, tickets: tickets, history: history,
    team: teamNames_(),
  });
  if (decision.refused) {
    audit_({ email: user.email, role: user.role, space: ev.space.name, action: 'REFUSED' });
    return 'Sorry, I can\'t help with that one. If it\'s something the INAVA team should look at, just say "please pass this to someone" and I\'ll let the right person know.' + aiFooter_();
  }

  // No ticket before a clarifying answer, and none for small talk.
  const concerns = decision.intent === 'CLARIFY' || decision.intent === 'CASUAL' ? [] : decision.concerns;
  const results = escalateConcerns_(concerns, user, {
    spaceId: ev.space.name,
    spaceName: ev.space.displayName,
    isDm: ev.isDm,
    link: ev.isDm ? '' : conversationLink_(ev),
    message: safeText,
    messageKey: messageKey,
  });
  const which = String(decision.status_ticket || '').trim();
  const status = decision.intent === 'STATUS_REQUEST' || (which && which.toUpperCase() !== 'NONE')
    ? statusReply_(user, which || 'NONE', !ev.isDm) : '';
  let reply = composeReply_(decision, status, results);

  // Only cite documents this person was actually given.
  const titles = knowledge.docs.map(function (d) { return d.title; });
  const cited = (decision.sources || []).filter(function (s, i, arr) {
    return titles.indexOf(s) >= 0 && arr.indexOf(s) === i;
  });
  // Sources are always recorded in the Audit Log; shown in Chat only if SHOW_SOURCES = on.
  if (cited.length && isOn_('SHOW_SOURCES')) reply += '\n\n_Source: ' + cited.join('; ') + '_';

  // Passwords and codes are never kept, even in the 6-hour conversation memory.
  saveHistory_(user.email, ev.space.name, history, redactCredentials_(text), reply);
  audit_({ email: user.email, role: user.role, space: ev.space.name, action: 'ANSWERED',
    ticketId: results.map(function (r) { return r.ticketId; }).filter(String).join(' '),
    detail: decision.intent + (results.length ? ' | ' + results.map(function (r) {
      return r.category + (r.isNew ? ' new' : ' update') + (r.saved ? (r.delivered ? ' delivered' : ' NOT delivered') : ' NOT saved') +
        (r.urgent ? ' urgent-safety' : '');
    }).join(', ') : '') +
      (cited.length ? ' | sources: ' + cited.join('; ') : '') +
      (decision.usage ? ' | ' + decision.usage : '') });
  return reply + aiFooter_();
}

// Sentences claiming that something was (or will be) passed on, added to a concern, noted,
// shared or flagged, or promising that someone on the team will act. Only the system says that,
// and only after it has happened, so any such sentence written by the AI is removed.
// English, Tagalog and Bisaya. Advice ("ipasa mo ang form") and offers phrased as a question stay.
const TEAM_WORDS = '(?:team|Ms\\.?|Mabelle|Cynthia|Vergelyn|Payroll|HR|Client Care|Operations|management|manager|right person|someone|a person|colleague)';
const ME = '\\b(?:I\'?ve|I have|I\'ll|I will|I\'m going to|I am going to|I\'m|I am|let me|I just|I already|we\'?ve|we have|we\'ll|we will)\\s+(?:also\\s+|already\\s+|now\\s+|just\\s+|gone ahead and\\s+)?';
const CONCERN_OBJECT = '(?:' + TEAM_WORDS + '|(?:your|the|this|that)\\s+(?:\\w+\\s+)?(?:concern|request|ticket|case|record|report|file))';
const HANDOFF_CLAIMS = [
  // "I've passed this on", "I'll flag it", "I'm escalating this"
  new RegExp(ME + '(?:pass(?:ed|ing)?|forward(?:ed|ing)?|escalat(?:e|ed|ing)|flag(?:ged|ging)?|refer(?:red|ring)?|loop(?:ed|ing)? (?:you |this |it )?in|rais(?:e|ed|ing)|report(?:ed|ing)?)\\b', 'i'),
  // "I'll let the team know", "I've shared this with management", "I'm sending this to HR"
  new RegExp(ME + '(?:sen[dt]\\w*|let\\w*|told|tell\\w*|notif\\w*|inform\\w*|shar(?:e|ed|ing)|alert\\w*|contact\\w*|reach\\w* out|messag\\w*|ping\\w*|ask\\w*)\\b[^.!?]*\\b(?:' + TEAM_WORDS + '|them|her|him)\\b', 'i'),
  // "I've added this to your earlier concern", "I've noted it for the team", "I've logged your request"
  new RegExp(ME + '(?:not(?:e|ed|ing)|add(?:ed|ing)?|log(?:ged|ging)?|record(?:ed|ing)?|document(?:ed|ing)?|updat(?:e|ed|ing)|includ(?:e|ed|ing)|attach(?:ed|ing)?|put|creat(?:e|ed|ing)|open(?:ed|ing)?|sav(?:e|ed|ing)|made a note|mak(?:e|ing) a note|kept a note|submit(?:ted|ting)?|fil(?:e|ed|ing))\\b[^.!?]*\\b' + CONCERN_OBJECT, 'i'),
  // "This has been passed to ...", "It's been added to your concern", "It's now with the team"
  /\b(?:has|have|was|were|is|are)\s+(?:already\s+|now\s+)?(?:been\s+)?(?:passed|forwarded|escalated|flagged|shared|sent|reported|raised|referred|noted|logged|added|recorded|updated)\s+(?:on|along|to|with|for|in)\b/i,
  new RegExp('\\b(?:is|are)\\s+(?:now\\s+)?(?:with|in the hands of)\\s+(?:the\\s+|our\\s+)?' + TEAM_WORDS, 'i'),
  // "Ms. Cynthia will get back to you", "so someone on the team can check in with you"
  new RegExp('\\b' + TEAM_WORDS + '[^.!?]*\\b(?:will|\'ll|is going to|are going to|can)\\s+(?:get back|contact|reach out|follow up|look into|check in|check on|review|call you|message you|be in touch)', 'i'),
  // "Ms. Cynthia is reviewing it"
  /\b(?:is|are)\s+(?:now\s+|currently\s+|already\s+)?(?:reviewing|looking into|working on|checking on|handling)\b/i,
  // "I'll call emergency services for you" (it cannot)
  /\bI(?:'ll| will|'ve| have|'m going to| am going to)\s+(?:also\s+)?(?:call|contact|alert|notify|send)\w*\b[^.!?]*\b(?:emergency|police|911|ambulance|authorities|barangay)/i,
  // Tagalog / Bisaya, first person: "Naipasa ko na", "Naidagdag ko na sa concern mo", "Gipasa na nako",
  // "Gi-share nako sa team", "Na-note ko na", "Ipapaalam ko"
  new RegExp('\\b(?:naipasa|ipinasa|ipapasa|ipasa|i-pasa|gipasa|naipaabot|ipaabot|gipaabot|naipaalam|ipinaalam|ipapaalam|ipaalam|' +
    'gipahibalo|ipahibalo|i-?forward|gi-?forward|na-?forward|ifo-?forward|i-?report|gi-?report|i-?escalate|gi-?escalate|na-?escalate|' +
    'naidagdag|idinagdag|idadagdag|idagdag|gidugang|i-?dugang|na-?note|gi-?note|i-?note|naitala|itinala|itatala|nailista|inilista|gilista|' +
    'i-?share|na-?share|gi-?share|ibinahagi|naibahagi|ibabahagi|na-?flag|gi-?flag|i-?flag|na-?record|gi-?record|ni-?record|na-?log|gi-?log)' +
    '\\b\\W*(?:na\\s+)?(?:ko|nako|namo|namin)\\b', 'i'),
  /\bakong\s+(?:i-?pasa|i-?forward|i-?report|i-?escalate|ipahibalo|ipaabot|i-?share|i-?note|idugang|i-?dugang|i-?flag|i-?record)\b/i,
];
// Offers stay: "Would you like me to pass this to Ms. Cynthia?" (but not "I've passed it, okay?")
const OFFER = /\b(?:would you like|do you want|want me to|if you(?:'d| would)? (?:like|want|prefer)|should I|gusto mo ba|gusto mo bang|gusto nimo|kung gusto (?:mo|nimo))\b/i;
const PAST_CLAIM = /\b(?:I'?ve|I have|we'?ve|already|naipasa|ipinasa|gipasa|na-?forward|gi-?forward|naipaalam|gipahibalo|naidagdag|gidugang|na-?note|gi-?share|na-?share)\b/i;

function isHandoffClaim_(sentence) {
  if (OFFER.test(sentence) && !PAST_CLAIM.test(sentence)) return false;
  if (/\b(?:babalikan|kokontakin|tatawagan|mo-?contact|kontakon|tawgan|mobalik)\b/i.test(sentence) &&
    new RegExp('\\b' + TEAM_WORDS, 'i').test(sentence)) return true;
  return HANDOFF_CLAIMS.some(function (re) { return re.test(sentence); });
}

/** Removes claim sentences from one line of text, keeping everything else as written. */
function stripHandoffClaims_(text) {
  const sentences = String(text || '').split(/(?<=[.!?])(?<!\b(?:Ms|Mr|Mrs|Dr|Sr|Jr)\.)[ \t]+/);
  return sentences.filter(function (s) { return !isHandoffClaim_(s); }).join(' ').trim();
}

/**
 * The AI's reply with every claim sentence removed. Works line by line, so paragraphs and
 * "- " bullet lists keep their layout. The [HANDOFF] marker is left in place.
 */
function cleanReply_(text) {
  const paragraphs = String(text || '').split(/\n{2,}/).map(function (p) {
    return p.split('\n').map(function (line) {
      const bullet = (line.match(/^\s*(?:[-*•]|\d+[.)])\s+/) || [''])[0];
      const body = stripHandoffClaims_(line.slice(bullet.length));
      return body ? bullet + body : '';
    }).filter(String).join('\n');
  });
  return paragraphs.filter(String).join('\n\n');
}

const HANDOFF_MARKER = /\[\s*HANDOFF\s*\]/gi;
const EMERGENCY_TEXT = 'If you\'re in immediate danger, please contact your local emergency services or seek immediate help from someone nearby.';

/**
 * The reply the person sees: the AI's caring part, then facts the system can vouch for:
 * the recorded status, who a concern went to (only once it reached the team), or an honest
 * note when saving or posting failed.
 */
function composeReply_(decision, status, results) {
  const team = teamNames_();
  const ops = team.OPERATIONS || 'our Operations team';
  const urgent = results.some(function (r) { return r.urgent; });

  // What the system can vouch for about the concerns in this message.
  const facts = [];
  const handoffs = [];
  results.forEach(function (r) {
    if (!r.saved || !r.delivered) return;
    // For a safety risk, a plain fact with no promise about who is available or when.
    const h = r.urgent ? 'I\'ve let ' + (team[r.category] || 'our team') + ' know about this right away.' : r.handoff;
    if (h && handoffs.indexOf(h) < 0) handoffs.push(h);
  });
  if (handoffs.length) facts.push(handoffs.join(' '));
  if (results.some(function (r) { return r.saved && !r.delivered; })) {
    facts.push('I\'ve noted this, but I couldn\'t reach the team just now. I\'ll keep trying and make sure it gets to them.' +
      (urgent ? ' Because this is urgent, please also contact ' + ops + ' directly.' : ''));
  }
  if (results.some(function (r) { return !r.saved; })) {
    facts.push('Sorry, I couldn\'t record ' + (results.length > 1 ? 'all of this' : 'this') + ' just now because of a problem on my side, so ' +
      (results.length > 1 ? 'some of it has' : 'it has') + ' not been passed on yet. Please send it again in a few minutes, or contact ' + ops + ' directly if it can\'t wait.');
  }

  // A plain status question is answered only from the Tickets sheet, never from the AI's wording.
  const statusOnly = decision.intent === 'STATUS_REQUEST' && status && !results.length;
  let own = statusOnly ? '' : cleanReply_(decision.reply);
  let placed = false;
  if (own.search(HANDOFF_MARKER) >= 0) {
    let first = true;
    own = own.replace(HANDOFF_MARKER, function () {
      if (!first) return '';
      first = false;
      placed = facts.length > 0;
      return facts.length ? '\n\n' + facts.join('\n\n') + '\n\n' : '';
    }).replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  const parts = [];
  if (own) parts.push(own);
  if (status) parts.push(status);
  if (!placed) facts.forEach(function (f) { parts.push(f); });
  if (urgent && !/emergency services/i.test(parts.join(' '))) parts.push(EMERGENCY_TEXT);
  if (!parts.length) parts.push('I\'m here. Tell me a bit more about what you need and I\'ll help.');
  return parts.join('\n\n');
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

/**
 * Tickets, routing, private notifications and overdue reminders.
 *
 * Routing lives in the Routing tab: one row per category with the assignee's
 * name and email, a backup email, whether they are cleared for payroll details,
 * and response targets (SLA hours) per priority. Edit the sheet to re-route;
 * no code changes needed.
 */

const DEFAULT_SLA_HOURS = { URGENT: 2, HIGH: 8, NORMAL: 24, LOW: 72 };

/** How the AI names the team member for each category ("Ms. Cynthia from our Client Care team"). */
/**
 * The PUBLIC name VAs hear for each category. This is the only source of contact names in
 * anything a VA sees (AI context, handoffs, status answers, "my tickets", resolution notes).
 * The internal assignee is the Routing tab's Assignee Email, which VAs never see.
 * Payroll is always "our Payroll Team", whatever the sheet says, so the person who handles
 * pay is never identified to a VA.
 */
function teamNames_() {
  const names = {};
  Object.keys(CATEGORIES).forEach(function (cat) {
    if (cat === 'PAYROLL') {
      names[cat] = PAYROLL_PUBLIC_NAME;
      return;
    }
    const r = getRouting_(cat);
    const name = r ? displayName_(r.name) : '';
    // A generic label in the sheet ("our Client Care team") is used as it is.
    names[cat] = /^our\b/i.test(name) ? name : (name ? name + ' from ' : '') + 'our ' + TEAM_LABEL[cat] + ' team';
  });
  return names;
}

const PAYROLL_PUBLIC_NAME = 'our Payroll Team';

/** First names of the people named in Routing (for keeping them out of payroll replies). */
function teamMemberNames_() {
  return readTable_(SHEETS.ROUTING).map(function (r) {
    return displayName_(r['Assignee Name']).replace(/^(?:Ms|Mr|Mrs|Sir|Ma'?am)\.?\s+/i, '').split(' ')[0];
  }).filter(function (n) { return n && !/^our$/i.test(n) && n.length > 2; });
}

// How each team is described to VAs ("Ms. Cynthia from our Client Care team").
const TEAM_LABEL = {
  CLIENT_CARE: 'Client Care',
  OPERATIONS: 'Operations',
  RECRUITMENT_HR: 'HR',
  PAYROLL: 'Payroll',
};

/** Drops notes in brackets: "Ms. Cynthia (TEST: goes to smm)" -> "Ms. Cynthia". */
function displayName_(name) {
  return String(name || '').replace(/\s*\(.*\)\s*/g, ' ').trim();
}

function getRouting_(category) {
  const rows = readTable_(SHEETS.ROUTING);
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i]['Category']).trim().toUpperCase() === category) {
      const r = rows[i];
      const sla = {};
      PRIORITIES.forEach(function (p) {
        const v = Number(r['SLA Hours ' + p]);
        sla[p] = v > 0 ? v : DEFAULT_SLA_HOURS[p];
      });
      return {
        name: String(r['Assignee Name'] || '').trim(),
        email: lower_(r['Assignee Email']),
        backupEmail: lower_(r['Backup Email']),
        payrollCleared: isYes_(r['Payroll Cleared']),
        sla: sla,
      };
    }
  }
  return null;
}

/** Ticket IDs look like INAVA-261027-004 (date + running number for that day). */
function nextTicketId_() {
  const day = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyMMdd');
  const key = 'ticket_seq_' + day;
  const n = Number(getProp_(key) || 0) + 1;
  setProp_(key, String(n));
  return 'INAVA-' + day + '-' + ('00' + n).slice(-3);
}

function readTickets_() {
  return readTable_(SHEETS.TICKETS).map(function (r) {
    return {
      row: r._row,
      id: String(r['Ticket ID']),
      status: String(r['Status']),
      category: String(r['Category']),
      priority: String(r['Priority']),
      assigneeName: String(r['Assignee Name']),
      assigneeEmail: lower_(r['Assignee Email']),
      requesterName: String(r['Requester Name']),
      requesterEmail: lower_(r['Requester Email']),
      source: String(r['Source']),
      sourceLink: String(r['Source Link']),
      summary: String(r['Summary']),
      recommendedAction: String(r['Recommended Action']),
      created: r['Created'] instanceof Date ? r['Created'] : new Date(r['Created']),
      dueBy: r['Due By'] instanceof Date ? r['Due By'] : (r['Due By'] ? new Date(r['Due By']) : null),
      remindersSent: Number(r['Reminders Sent'] || 0),
      lastReminder: r['Last Reminder'] instanceof Date ? r['Last Reminder'] : (r['Last Reminder'] ? new Date(r['Last Reminder']) : null),
      history: String(r['History'] || ''),
      updated: r['Updated'] instanceof Date ? r['Updated'] : (r['Updated'] ? new Date(r['Updated']) : null),
      sourceRefs: String(r['Source Message ID'] || '').split(/\s+/).filter(String),
      delivery: String(r['Delivery'] || ''),
      deliveryAttempts: Number(r['Delivery Attempts'] || 0),
      urgentNotice: String(r['Urgent Notice'] || ''),
    };
  });
}

function findTicket_(id) {
  const target = String(id || '').trim().toUpperCase();
  const all = readTickets_();
  for (let i = 0; i < all.length; i++) if (all[i].id.toUpperCase() === target) return all[i];
  return null;
}

function openTicketsFor_(email) {
  return readTickets_().filter(function (t) {
    return t.requesterEmail === email && t.status !== 'Resolved';
  });
}

function historyLine_(text) {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') + ' - ' + text;
}

function appendHistory_(ticket, text) {
  const history = (ticket.history ? ticket.history + '\n' : '') + historyLine_(text);
  updateObject_(SHEETS.TICKETS, ticket.row, { 'History': history, 'Updated': new Date() });
  ticket.history = history;
}

/**
 * Strips figures that could be pay amounts or account numbers. Used on every
 * payroll summary, and on anything sent to someone not cleared for payroll.
 */
function redactSensitive_(text) {
  return String(text || '')
    .replace(/(?:[$₱€£]|\b(?:PHP|USD|EUR|GBP|AUD|CAD)\b)\s?\d[\d,]*(?:\.\d+)?/gi, '[amount removed]')
    .replace(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, '[amount removed]')
    .replace(/\b\d+\.\d{2}\b/g, '[amount removed]')
    .replace(/\b(?:\d[ ]?){6,}\b/g, '[number removed]');
}

const SECRET_WORDS = 'password|passcode|passwd|pwd|pin|otp|one[- ]time (?:code|password)|verification code|' +
  'security code|2fa code|login code|cvv|cvc';

/**
 * Removes passwords, PINs, one-time codes, card and account numbers and API keys. Applied to
 * every concern before it is stored or sent to anyone, whatever the category.
 */
function redactCredentials_(text) {
  return String(text || '')
    // "password: x", "PIN 1234", "my password is Mango123". Plain words after "is" are kept,
    // so "my password is not working" stays readable.
    .replace(new RegExp('\\b(' + SECRET_WORDS + ')\\b((?:\\s*(?:is|ko|ay|nako|kay|:|=|-))*\\s*)("[^"]+"|\'[^\']+\'|[^\\s,;]+?)(?=[.!?]?(?:\\s|$|[,;]))', 'gi'),
      function (m, word, sep, value) {
        const bare = value.replace(/^["']|["'.!?]+$/g, '');
        if (!/[:=]/.test(sep) && !/^["']/.test(value) && /^[A-Za-z]+$/.test(bare)) return m;
        return word + sep + '[removed]';
      })
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, '[removed]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[removed]')
    .replace(/\b(?:ghp|gho|github_pat|xox[abp])[_-][A-Za-z0-9_-]{10,}/g, '[removed]')
    .replace(/\b((?:account|acct|card|routing|iban|gcash|bank)(?:\s*(?:no\.?|number|num|#))?(?:\s*(?:is|:|-))?\s*)\d[\d -]{2,}\d/gi,
      '$1[number removed]')
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, '[number removed]') // card numbers
    .replace(/(?<!-)\b(?:\d ?){5,}\d\b/g, '[number removed]'); // account, phone and ID numbers (dates stay)
}

/** What is stored and sent for a concern: no credentials ever, and no pay figures for payroll. */
function redactConcern_(category, text) {
  const t = redactCredentials_(text);
  return category === 'PAYROLL' ? redactSensitive_(t) : t;
}

/**
 * For a message with several concerns, the part about this one (Claude copies it word for word).
 * If the excerpt does not really come from the message, the whole message is used instead, so
 * nothing the person did not say ever reaches the team.
 */
function concernTextFor_(concern, message, count) {
  const original = String(message || '').trim();
  const excerpt = String(concern.concern_text || '').trim();
  if (!original) return excerpt;
  if (count <= 1 || !excerpt) return original;
  const words = function (x) { return x.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []; };
  const have = {};
  words(original).forEach(function (w) { have[w] = true; });
  const ex = words(excerpt);
  const found = ex.filter(function (w) { return have[w]; }).length;
  return ex.length && found / ex.length >= 0.85 ? excerpt : original;
}

/** Short stable hash (FNV-1a), used to name a retry-safe Chat message. */
function shortHash_(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

// Shown to the team, and stored, instead of the words of a highly sensitive personal disclosure.
const SENSITIVE_TEXT = 'Sensitive personal safety concern. Please contact this VA privately as soon as possible.';

/**
 * The AI's handoff sentence, or the standard one when it gave none. For payroll, a sentence
 * that names a person (or not the Payroll Team) is replaced, so who handles pay stays private.
 */
function safeHandoff_(category, text, isFollowUp) {
  const h = String(text || '').trim();
  if (!h) return defaultHandoff_(category, isFollowUp);
  if (category === 'PAYROLL' && (!/payroll/i.test(h) || namesTeamMember_(h))) return defaultHandoff_(category, isFollowUp);
  return h;
}

function namesTeamMember_(text) {
  return teamMemberNames_().some(function (n) { return new RegExp('\\b' + n + '\\b', 'i').test(text); }) ||
    /\bMs\.?\s+[A-Z]/.test(text);
}

/** "I've passed this to Ms. Cynthia from our Client Care team, ..." when Claude gave none. */
function defaultHandoff_(category, isFollowUp) {
  const who = teamNames_()[category] || 'the right person on our team';
  if (category === 'PAYROLL') {
    return isFollowUp ? 'I\'ve let ' + who + ' know about this update.' : 'I\'ve forwarded your concern to ' + who + ' for review.';
  }
  return isFollowUp ? 'I\'ve let ' + who + ' know about this update.'
    : 'I\'ve passed this to ' + who + ', and they\'ll get back to you.';
}

/**
 * Records the concerns in one message: each one becomes a new ticket, or an update on the
 * person's own open ticket about the same matter. Runs under a lock, and a message that was
 * already processed (a retried Chat event) is never recorded or posted again.
 *
 * @param {Array} concerns Claude's "concerns" entries
 * @param {Object} user from findUser_
 * @param {Object} source {spaceId, spaceName, isDm, link, message, messageKey}
 * @return {Array<{ticketId, category, isNew, saved, delivered, handoff, urgent}>}
 */
function escalateConcerns_(concerns, user, source) {
  const valid = (concerns || []).filter(function (c) { return c && CATEGORIES.hasOwnProperty(c.category); });
  if (!valid.length) return [];
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    ensureColumns_(SHEETS.TICKETS);
    const all = readTickets_();

    // Already done for this message (Chat re-sent the event): report what happened, add nothing.
    if (source.messageKey) {
      const prefix = source.messageKey + '#';
      const done = all.filter(function (t) {
        return t.sourceRefs.some(function (r) { return r.indexOf(prefix) === 0; });
      });
      if (done.length) {
        audit_({ email: user.email, role: user.role, space: source.spaceId, action: 'DUPLICATE_MESSAGE_IGNORED',
          ticketId: done.map(function (t) { return t.id; }).join(' ') });
        return done.map(function (t) {
          const isNew = t.sourceRefs[0].indexOf(prefix) === 0;
          return { ticketId: t.id, category: t.category, isNew: isNew, saved: true,
            delivered: isNew ? t.delivery !== 'Pending' && t.status !== 'New' : t.delivery.indexOf('Pending update') !== 0,
            handoff: defaultHandoff_(t.category, !isNew), urgent: false };
        });
      }
    }

    const ownOpen = all.filter(function (t) { return t.requesterEmail === user.email && t.status !== 'Resolved'; });
    const ownResolved = all.filter(function (t) { return t.requesterEmail === user.email && t.status === 'Resolved'; });
    const results = [];
    const updated = {};
    valid.forEach(function (c, i) {
      const ref = source.messageKey ? source.messageKey + '#' + i : '';
      const relatedId = String(c.related_ticket || '').trim().toUpperCase();
      // Only the person's own open ticket can be updated; anything else is a new concern.
      const related = ownOpen.filter(function (t) { return t.id.toUpperCase() === relatedId; })[0];
      const earlier = related ? null : ownResolved.filter(function (t) { return t.id.toUpperCase() === relatedId; })[0];
      const urgent = c.urgent_safety === true;
      try {
        // A highly sensitive personal disclosure is never stored or shown in words: the team sees a
        // generic line and contacts the VA privately. An update on such a concern is treated the same.
        const sensitive = c.sensitive_personal === true || !!(related && related.summary === SENSITIVE_TEXT);
        if (related) {
          const text = sensitive ? SENSITIVE_TEXT : redactConcern_(c.category === 'PAYROLL' ? 'PAYROLL' : related.category,
            concernTextFor_(c, source.message, valid.length));
          if (updated[related.id]) {
            // A second part of the same message about the same matter: one update, not two.
            appendHistory_(related, 'Follow-up from ' + user.name + ': ' + text);
            return;
          }
          updated[related.id] = true;
          const r = addFollowUp_(related, text, user, ref, urgent);
          results.push({ ticketId: related.id, category: related.category, isNew: false, saved: true, delivered: r,
            handoff: safeHandoff_(related.category, c.handoff, true), urgent: urgent });
        } else {
          const raw = sensitive ? SENSITIVE_TEXT : concernTextFor_(c, source.message, valid.length);
          const t = createTicket_(c, raw, user, source, ref, earlier);
          results.push({ ticketId: t.id, category: c.category, isNew: true, saved: true, delivered: t.delivered,
            handoff: safeHandoff_(c.category, c.handoff, false), urgent: urgent });
        }
      } catch (e) {
        console.error('Could not record a concern: ' + e);
        audit_({ email: user.email, role: user.role, space: source.spaceId, action: 'TICKET_SAVE_FAILED', detail: String(e) });
        results.push({ ticketId: '', category: c.category, isNew: !related, saved: false, delivered: false, handoff: '', urgent: urgent });
      }
    });
    return results;
  } finally {
    lock.releaseLock();
  }
}

/** Saves a new ticket, then posts the NEW CONCERN card. Returns the ticket with .delivered. */
function createTicket_(c, raw, user, source, ref, earlier) {
  const category = c.category;
  const text = redactConcern_(category, raw);
  const urgent = c.urgent_safety === true;
  const priority = urgent ? 'URGENT' : (PRIORITIES.indexOf(c.priority) >= 0 ? c.priority : 'NORMAL');
  const routing = getRouting_(category) || getRouting_('OPERATIONS');
  const now = new Date();
  const slaHours = routing ? routing.sla[priority] : DEFAULT_SLA_HOURS[priority];
  const created = historyLine_('Created from a message by ' + user.name +
    (earlier ? ' (follows up on ' + earlier.id + ', which was marked sorted)' : '') +
    (urgent ? '. Marked as an urgent safety concern.' : ''));
  const ticket = {
    id: nextTicketId_(),
    status: 'New',
    category: category,
    priority: priority,
    assigneeName: routing ? routing.name : '',
    assigneeEmail: routing ? routing.email : '',
    requesterName: user.name,
    requesterEmail: user.email,
    source: source.isDm ? 'Direct message' : 'Space: ' + (source.spaceName || source.spaceId),
    sourceLink: source.link || '',
    summary: text || 'See source conversation.',
    recommendedAction: raw === SENSITIVE_TEXT ? 'Contact the VA privately as soon as possible.'
      : redactConcern_(category, String(c.recommended_action || '').trim()),
    dueBy: new Date(now.getTime() + slaHours * 3600 * 1000),
    history: created,
    sourceRefs: ref ? [ref] : [],
    delivery: 'Pending',
    deliveryAttempts: 0,
    urgentNotice: urgent ? 'Pending' : '',
  };
  // Saved as Pending first: if posting fails below (or this run dies), retryPending_ re-sends it.
  ticket.row = appendObject_(SHEETS.TICKETS, {
    'Ticket ID': ticket.id,
    'Status': ticket.status,
    'Category': ticket.category,
    'Priority': ticket.priority,
    'Assignee Name': ticket.assigneeName,
    'Assignee Email': ticket.assigneeEmail,
    'Requester Name': ticket.requesterName,
    'Requester Email': ticket.requesterEmail,
    'Source': ticket.source,
    'Source Link': ticket.sourceLink,
    'Summary': ticket.summary,
    'Recommended Action': ticket.recommendedAction,
    'Created': now,
    'Updated': now,
    'Due By': ticket.dueBy,
    'Reminders Sent': 0,
    'History': ticket.history,
    'Source Message ID': ticket.sourceRefs.join(' '),
    'Delivery': 'Pending',
    'Delivery Attempts': 0,
    'Urgent Notice': ticket.urgentNotice,
  });
  if (!ticket.row) throw new Error('The ticket row number was not returned by the Sheets API.');
  audit_({ email: user.email, role: user.role, space: source.spaceId, action: 'TICKET_CREATED', ticketId: ticket.id,
    detail: category + ' / ' + priority + (urgent ? ' / urgent safety' : '') });

  // A payroll contact cleared for details gets the figures privately (never in the team chat,
  // never stored); credentials are removed for everyone.
  ticket.delivered = deliverNewTicket_(ticket, 1, redactCredentials_(raw));
  if (!ticket.delivered) alertOperations_(ticket, user);
  return ticket;
}

/** Posts the NEW CONCERN card for a saved ticket and records the outcome. Safe to repeat. */
function deliverNewTicket_(ticket, attempt, message) {
  const ok = notifyAssignee_(ticket, message || ticket.summary, false, 'new');
  const fields = { 'Delivery Attempts': attempt };
  if (ok) {
    fields['Delivery'] = 'Delivered';
    if (ticket.status === 'New') fields['Status'] = 'Assigned';
    updateObject_(SHEETS.TICKETS, ticket.row, fields);
    if (ticket.status === 'New') ticket.status = 'Assigned';
    ticket.delivery = 'Delivered';
    appendHistory_(ticket, 'Assigned to ' + (ticket.assigneeName || ticket.assigneeEmail) +
      (teamInbox_() ? ' (posted in the team chat)' : ' (private notification sent)') + (attempt > 1 ? ' on retry ' + attempt : ''));
    // The urgent card always comes after the concern card it points to.
    if (ticket.urgentNotice.indexOf('Pending') === 0) sendUrgentNotice_(ticket);
  } else {
    fields['Delivery'] = attempt >= MAX_DELIVERY_ATTEMPTS ? 'Failed' : 'Pending';
    updateObject_(SHEETS.TICKETS, ticket.row, fields);
    ticket.delivery = fields['Delivery'];
    appendHistory_(ticket, fields['Delivery'] === 'Failed'
      ? 'Could not reach the team after ' + attempt + ' tries. It is listed in the daily check-in.'
      : 'Could not reach the team chat (try ' + attempt + '). Will retry.');
    if (fields['Delivery'] === 'Pending') markPendingDelivery_();
  }
  return ok;
}

/** Adds new information to the person's open ticket and posts the UPDATE ON A CONCERN card. */
function addFollowUp_(ticket, text, user, ref, urgent) {
  const postKey = 'u-' + shortHash_(ref || (text + Date.now()));
  appendHistory_(ticket, 'Follow-up from ' + user.name + ': ' + text +
    (urgent ? ' (marked as an urgent safety concern)' : ''));
  const fields = {};
  if (ref) fields['Source Message ID'] = ticket.sourceRefs.concat([ref]).join(' ');
  if (urgent && ticket.priority !== 'URGENT') fields['Priority'] = 'URGENT';
  if (urgent && ticket.urgentNotice !== 'Posted') {
    // A ticket gets at most one urgent card; a later urgent follow-up re-uses it.
    fields['Urgent Notice'] = 'Pending';
    ticket.urgentNotice = 'Pending';
  }
  if (ticket.delivery === 'Pending') deliverNewTicket_(ticket, ticket.deliveryAttempts + 1);
  const ok = notifyAssignee_(ticket, text, true, postKey);
  if (!ok) {
    fields['Delivery'] = 'Pending update ' + postKey;
    markPendingDelivery_();
  } else if (ticket.delivery.indexOf('Pending update') === 0) {
    fields['Delivery'] = 'Delivered';
  }
  if (Object.keys(fields).length) updateObject_(SHEETS.TICKETS, ticket.row, fields);
  if (!ok) ticket.delivery = fields['Delivery'];
  if (ok && ticket.urgentNotice.indexOf('Pending') === 0) sendUrgentNotice_(ticket);
  else if (ticket.urgentNotice.indexOf('Pending') === 0) markPendingDelivery_();
  audit_({ email: user.email, role: user.role, space: '', action: 'TICKET_FOLLOW_UP', ticketId: ticket.id,
    detail: ok ? 'posted' : 'not delivered, will retry' });
  return ok;
}

/**
 * One extra short card in the team chat, right after the normal concern card, for a genuine
 * safety risk. It asks for a person to act; it does not decide anything. It has a fixed Chat
 * message ID, so however often it is retried, the team sees it once. Without a team chat it
 * goes privately to the assignee. Records Posted, Pending <tries> or Failed.
 */
function sendUrgentNotice_(ticket) {
  const tries = Number((ticket.urgentNotice.match(/\d+/) || [0])[0]) + 1;
  const messageId = clientMessageId_(ticket.id + '-urgent');
  const body = 'Name: ' + (ticket.requesterName || ticket.requesterEmail) +
    '\n\nPlease read the concern above and contact ' + firstName_(ticket.requesterName) + ' as soon as possible.';
  let ok = false;
  try {
    const space = teamInbox_();
    ok = space ? !!postCard_(space, 'Urgent: safety concern', body, messageId)
      : sendPrivateMessage_(ticket.assigneeEmail, boldHeading_('Urgent: safety concern (' + ticket.id + ')\n\n' + body), messageId);
  } catch (e) {
    console.error('Urgent notice for ' + ticket.id + ' failed: ' + e);
  }
  ticket.urgentNotice = ok ? 'Posted' : tries >= MAX_DELIVERY_ATTEMPTS ? 'Failed' : 'Pending ' + tries;
  updateObject_(SHEETS.TICKETS, ticket.row, { 'Urgent Notice': ticket.urgentNotice });
  if (ok) appendHistory_(ticket, 'Urgent safety notice posted' + (tries > 1 ? ' on retry ' + tries : ''));
  else if (ticket.urgentNotice === 'Failed') appendHistory_(ticket, 'Urgent safety notice could not be posted after ' + tries + ' tries');
  else markPendingDelivery_();
  return ok;
}

const MAX_DELIVERY_ATTEMPTS = 6;

function markPendingDelivery_() {
  CacheService.getScriptCache().put('pending_delivery', '1', 21600);
}

/** Re-sends concerns that were saved but did not reach the team. Run it any time; it never posts twice. */
function retryUndeliveredConcerns() {
  resetMemo_();
  retryPending_();
}

/** Called after messages (when something is pending) and by the daily job. */
function retryPending_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    ensureColumns_(SHEETS.TICKETS);
    const needsWork = function (t) {
      return t.status !== 'Resolved' && (t.delivery.indexOf('Pending') === 0 || t.urgentNotice.indexOf('Pending') === 0);
    };
    const pending = readTickets_().filter(needsWork);
    pending.forEach(function (t) {
      try {
        if (t.delivery === 'Pending') {
          // Also posts a pending urgent card straight after, when the concern card goes through.
          deliverNewTicket_(t, t.deliveryAttempts + 1);
          return;
        }
        if (t.delivery.indexOf('Pending update') === 0) {
          const postKey = t.delivery.split(' ')[2];
          if (!notifyAssignee_(t, lastFollowUp_(t), true, postKey)) return;
          updateObject_(SHEETS.TICKETS, t.row, { 'Delivery': 'Delivered' });
          t.delivery = 'Delivered';
          appendHistory_(t, 'Update delivered to the team on retry');
        }
        // Only once the card it points to is in the chat.
        if (t.urgentNotice.indexOf('Pending') === 0 && t.delivery !== 'Failed') sendUrgentNotice_(t);
      } catch (e) {
        console.error('Retry for ' + t.id + ' failed: ' + e);
      }
    });
    const left = readTickets_().some(needsWork);
    if (!left) CacheService.getScriptCache().remove('pending_delivery');
  } finally {
    lock.releaseLock();
  }
}

/** The text of the latest "Follow-up from ..." entry in a ticket's history (already redacted). */
function lastFollowUp_(ticket) {
  const entries = ticket.history.split(/\n(?=\d{4}-\d{2}-\d{2} \d{2}:\d{2} - )/);
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = entries[i].match(/ - Follow-up from [^:]*: ([\s\S]*)$/);
    if (m) return m[1].replace(/ \(marked as an urgent safety concern\)$/, '');
  }
  return ticket.summary;
}

const DONE_LINE = 'When it\'s sorted, reply: done ';

/** The approved space marked Team Inbox = YES in the Spaces tab, or null. */
function teamInbox_() {
  const rows = readTable_(SHEETS.SPACES);
  for (let i = 0; i < rows.length; i++) {
    if (isYes_(rows[i]['Approved']) && isYes_(rows[i]['Team Inbox'])) return String(rows[i]['Space ID']).trim();
  }
  return null;
}

/** "Heading\n\nbody" -> "**HEADING**\n\nbody" for plain-text private messages. */
function boldHeading_(text) {
  const i = text.indexOf('\n\n');
  const heading = i < 0 ? text : text.slice(0, i);
  return '**' + heading.toUpperCase() + '**' + (i < 0 ? '' : text.slice(i));
}

/**
 * Posts a message in the team group chat, if one is set up, as a card with a
 * red heading (the text's first paragraph). Callers remove payroll figures first.
 * @return {boolean} true if posted
 */
function postToTeam_(ticket, text, messageId) {
  const space = teamInbox_();
  if (!space) return false;
  const i = text.indexOf('\n\n');
  try {
    postCard_(space, text.slice(0, i), text.slice(i + 2)
      .split(DONE_LINE).join('When it\'s sorted, reply here: @' + APP_NAME + ' done '), messageId);
    return true;
  } catch (e) {
    console.error('Team chat post for ' + ticket.id + ' failed: ' + e);
    return false;
  }
}

/** The Name / Concern block used in every message to the team. (Priority is tracked, not shown.) */
function concernLines_(ticket, concern) {
  return ['Name: ' + (ticket.requesterName || ticket.requesterEmail), 'Concern: ' + concern].join('\n\n');
}

/** "Vicky Santos" -> "Vicky". */
function firstName_(name) {
  return String(name || '').replace(/\s*\(.*\)\s*/g, ' ').trim().split(' ')[0];
}

/**
 * Posts the concern card in the team chat or, without one, privately to the assignee (or backup).
 * Payroll details only go to someone marked Payroll Cleared = YES.
 * @param {string} message the sender's own words, with credentials already removed
 * @param {boolean} isFollowUp true for a further message about an open concern
 * @param {string} postKey names the Chat message ("new", "u-1a2b3c4d") so a retry never posts twice
 */
function notifyAssignee_(ticket, message, isFollowUp, postKey) {
  const messageId = clientMessageId_(ticket.id + '-' + (postKey || (isFollowUp ? 'u-' + shortHash_(message) : 'new')));
  const routing = getRouting_(ticket.category);
  const cleared = ticket.category !== 'PAYROLL' || (routing && routing.payrollCleared &&
    (ticket.assigneeEmail === routing.email || ticket.assigneeEmail === routing.backupEmail));
  const details = cleared ? message
    : 'Payroll matter (details are private, please contact ' + firstName_(ticket.requesterName) + ' directly)';

  // Blank lines between lines: Google Chat may join single line breaks.
  const parts = [isFollowUp ? 'Update on a concern' : 'New concern'];
  parts.push(concernLines_(ticket, details));
  if (ticket.sourceLink) parts.push('Conversation: ' + ticket.sourceLink);
  parts.push(DONE_LINE + ticket.id);
  const text = parts.join('\n\n');

  // Everything goes to the team chat when one is set up. Payroll figures and account
  // numbers are removed there, because everyone in the chat can read it. If posting there
  // fails, it stays undelivered and is retried in the same chat (never sent elsewhere twice).
  const teamText = ticket.category === 'PAYROLL'
    ? text.replace(details, function () { return redactSensitive_(message); }) : text;
  if (teamInbox_()) return postToTeam_(ticket, teamText, messageId);

  const recipients = [ticket.assigneeEmail];
  if (routing && routing.backupEmail) recipients.push(routing.backupEmail);
  for (let i = 0; i < recipients.length; i++) {
    if (!recipients[i]) continue;
    try {
      if (sendPrivateMessage_(recipients[i], recipients[i] === ticket.assigneeEmail ? boldHeading_(text)
        : '(Covering for ' + (displayName_(ticket.assigneeName) || ticket.assigneeEmail) + ')\n\n' + boldHeading_(text), messageId)) return true;
    } catch (e) {
      console.error('Notification to ' + recipients[i] + ' failed: ' + e);
    }
  }
  return false;
}

/** When the assignee and backup can't be reached, tell Operations straight away (no payroll details). */
function alertOperations_(ticket, user) {
  const ops = getRouting_('OPERATIONS');
  if (!ops || !ops.email || ops.email === ticket.assigneeEmail) return;
  try {
    sendPrivateMessage_(ops.email, boldHeading_(['New concern (I couldn\'t reach ' + (displayName_(ticket.assigneeName) || 'the right person') + ')',
      concernLines_(ticket, ticket.category === 'PAYROLL' ? 'Payroll matter (details are private)' : ticket.summary),
      DONE_LINE + ticket.id].join('\n\n')));
    appendHistory_(ticket, 'Assignee unreachable; Operations (' + ops.email + ') alerted');
  } catch (e) {
    console.error('Operations alert for ' + ticket.id + ' failed: ' + e);
  }
}

function formatTime_(date) {
  if (!date) return '-';
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'EEE d MMM, h:mm a');
}

/** Who may view or change a ticket. */
function canManageTicket_(user, ticket) {
  const routing = getRouting_(ticket.category);
  const isAssignee = user.email === ticket.assigneeEmail || (routing && user.email === routing.backupEmail);
  if (isAssignee || user.role === 'ADMIN') return true;
  if (ticket.category === 'PAYROLL') return false;
  return user.role === 'MANAGEMENT';
}

/** Handles "status <ticket> <new status> [note]". Returns the reply text. */
function updateTicketStatus_(user, ticketId, statusWords, note) {
  const ticket = findTicket_(ticketId);
  if (!ticket) return 'I could not find ticket ' + ticketId + '.';
  if (!canManageTicket_(user, ticket)) return 'Only the assigned team member or management can update ' + ticket.id + '.';
  const status = matchStatus_(statusWords);
  if (!status) return 'Status must be one of: ' + STATUSES.join(', ') + '.';

  updateObject_(SHEETS.TICKETS, ticket.row, { 'Status': status });
  appendHistory_(ticket, 'Status set to ' + status + ' by ' + user.name + (note ? ': ' + note : ''));
  audit_({ email: user.email, role: user.role, action: 'TICKET_STATUS', ticketId: ticket.id, detail: status });

  if (status === 'Resolved' && ticket.source === 'Direct message') {
    try {
      sendPrivateMessage_(ticket.requesterEmail, 'Quick update: ' + capitalise_(teamNames_()[ticket.category] || 'our team') +
        ' has marked what you raised with me as sorted. If anything is still not right, just tell me.');
    } catch (e) {
      console.warn('Could not tell requester about resolution: ' + e);
    }
  }
  return status === 'Resolved' ? 'Thanks! ' + ticket.id + ' is marked as done.' : ticket.id + ' is now ' + status + '.';
}

function matchStatus_(words) {
  const w = String(words || '').trim().toLowerCase().replace(/[_-]/g, ' ');
  for (let i = 0; i < STATUSES.length; i++) if (STATUSES[i].toLowerCase() === w) return STATUSES[i];
  return null;
}

/** "my tickets": open tickets assigned to this person (staff) or raised by them. */
function describeMyTickets_(user) {
  const all = readTickets_().filter(function (t) { return t.status !== 'Resolved'; });
  const assigned = all.filter(function (t) { return t.assigneeEmail === user.email; });
  const raised = all.filter(function (t) { return t.requesterEmail === user.email; });
  const lines = [];
  if (assigned.length) {
    lines.push('Passed to you and still open:');
    assigned.forEach(function (t) {
      const overdue = t.dueBy && t.dueBy.getTime() < Date.now() ? ' - OVERDUE' : '';
      lines.push('- ' + t.id + ' | ' + t.status + ' | ' + t.priority + overdue + ' | ' +
        (t.category === 'PAYROLL' ? 'Payroll matter' : t.summary));
    });
  }
  if (raised.length) {
    if (lines.length) lines.push('');
    lines.push('Things I\'ve passed on for you:');
    raised.forEach(function (t) {
      lines.push('- ' + formatTime_(t.created) + ': with ' + (teamNames_()[t.category] || 'our team') +
        ' (' + t.status.toLowerCase() + ')');
    });
  }
  return lines.length ? lines.join('\n') : 'Nothing open right now.';
}

function describeTicket_(user, ticketId) {
  const t = findTicket_(ticketId);
  if (!t) return 'I could not find ticket ' + ticketId + '.';
  if (canManageTicket_(user, t)) {
    return [t.id + ' - ' + t.status, '', '- Category: ' + (CATEGORIES[t.category] || t.category), '- Priority: ' + t.priority,
      '- Assigned to: ' + (t.assigneeName || t.assigneeEmail || 'unassigned'), '- Respond by: ' + formatTime_(t.dueBy),
      '- From: ' + t.requesterName, '- Summary: ' + t.summary, '', 'History:', '']
      .concat(t.history.split('\n').map(function (h) { return '- ' + h; })).join('\n');
  }
  if (t.requesterEmail === user.email) return 'That one is currently ' + t.status.toLowerCase() + '.';
  return 'I could not find ticket ' + ticketId + '.';
}

/** The person's own concerns that are open, or were resolved in the last 14 days. */
function recentTicketsFor_(email) {
  const cutoff = Date.now() - 14 * 86400000;
  return readTickets_().filter(function (t) {
    return t.requesterEmail === email && (t.status !== 'Resolved' || (t.updated || t.created).getTime() >= cutoff);
  });
}

function capitalise_(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function shortDate_(date) {
  return date ? Utilities.formatDate(date, Session.getScriptTimeZone(), 'd MMM') : 'recently';
}

/**
 * What the person is told about one of their own concerns, worded strictly from the recorded
 * status: nobody is described as working on it unless the status is In Progress.
 */
function statusLine_(t) {
  const who = teamNames_()[t.category] || 'our team';
  const Who = capitalise_(who);
  switch (t.status) {
    case 'Assigned':
      return 'It\'s with ' + who + ' (passed on ' + shortDate_(t.created) + '). There\'s no update recorded from them yet.';
    case 'In Progress':
      return Who + ' is working on it.';
    case 'Awaiting Response':
      return Who + ' is waiting for a reply from you on this one. Please check your messages and email.';
    case 'Resolved':
      return Who + ' marked it as sorted on ' + shortDate_(t.updated || t.created) +
        '. If it\'s still not right, tell me what\'s happening and I\'ll pass it on again.';
    default:
      return 'I\'ve recorded it, but it hasn\'t reached ' + who + ' yet because of a problem on my side. I\'m making sure it gets there.';
  }
}

/**
 * Answers "any update?" about the person's OWN concerns only.
 * @param {string} which Claude's status_ticket: an ID, "AMBIGUOUS" or "NONE"
 * @return {string} text for the reply, or '' when no status was asked for
 */
function statusReply_(user, which, inSharedSpace, records) {
  const id = String(which || '').trim().toUpperCase();
  if (!id) return '';
  // records: only for the language test, which uses made-up tickets instead of the sheet.
  const own = records || recentTicketsFor_(user.email);
  const t = own.filter(function (x) { return x.id.toUpperCase() === id; })[0];
  if (t) {
    if (inSharedSpace && t.category === 'PAYROLL') {
      return 'That one is about pay, so let\'s keep it private: send me a direct message and I\'ll tell you where it is.';
    }
    return statusLine_(t);
  }
  if (!own.length) {
    return 'I don\'t have anything from you on record right now. If something\'s wrong, tell me what\'s happening and I\'ll pass it on.';
  }
  if (id === 'AMBIGUOUS' && own.length > 1) {
    if (inSharedSpace) return 'You\'ve raised a few things with me, so let\'s check privately: send me a direct message and tell me which one you mean.';
    return ['You\'ve raised a few things with me. Which one do you mean?'].concat(own.map(function (x) {
      const words = x.summary.length > 70 ? x.summary.slice(0, 67) + '...' : x.summary;
      return '- the one from ' + shortDate_(x.created) + ': "' + words + '"';
    })).join('\n');
  }
  return 'I can\'t find anything you\'ve raised with me about that recently. If it\'s still a problem, tell me what\'s happening and I\'ll pass it on.';
}

/**
 * Daily check-in (add a daily trigger for it under Triggers). Posts ONE message
 * in the team chat listing every concern that is still open, oldest first.
 * Posts nothing when everything is done. Without a team chat, it goes to the
 * Operations contact privately.
 */
function checkOverdueTickets() {
  resetMemo_();
  const now = Date.now();
  const open = readTickets_().filter(function (t) { return t.status !== 'Resolved'; })
    .sort(function (a, b) { return a.created - b.created; });
  if (!open.length) return;

  const days = function (t) {
    const d = Math.floor((now - t.created.getTime()) / 86400000);
    return d <= 0 ? 'today' : d === 1 ? '1 day ago' : d + ' days ago';
  };
  const lines = open.map(function (t) {
    // The sheet already stores payroll messages with figures removed.
    const concern = t.summary.length > 140 ? t.summary.slice(0, 137) + '...' : t.summary;
    return '- ' + (t.requesterName || t.requesterEmail) + ' (' + days(t) + '): ' + concern +
      (t.status === 'Awaiting Response' ? ' [waiting on the VA]' : '') + '\n   ' + DONE_LINE + t.id;
  });
  const heading = 'Daily check-in: ' + open.length + (open.length === 1 ? ' concern' : ' concerns') + ' still open';
  const text = heading + '\n\n' + lines.join('\n\n');

  const ops = getRouting_('OPERATIONS');
  if (!postToTeam_({ id: 'daily check-in' }, text) && ops && ops.email) {
    // Private fallback: no payroll wording beyond what the sheet stores, which is already redacted.
    sendPrivateMessage_(ops.email, boldHeading_(text));
  }
  open.forEach(function (t) {
    updateObject_(SHEETS.TICKETS, t.row, { 'Reminders Sent': t.remindersSent + 1, 'Last Reminder': new Date() });
  });
}

/**
 * Tickets, routing, private notifications and overdue reminders.
 *
 * Routing lives in the Routing tab: one row per category with the assignee's
 * name and email, a backup email, whether they are cleared for payroll details,
 * and response targets (SLA hours) per priority. Edit the sheet to re-route;
 * no code changes needed.
 */

const DEFAULT_SLA_HOURS = { URGENT: 2, HIGH: 8, NORMAL: 24, LOW: 72 };
// How often an overdue ticket's assignee is reminded, in hours.
const REMINDER_EVERY_HOURS = { URGENT: 1, HIGH: 4, NORMAL: 8, LOW: 24 };
// After this many reminders, the Operations contact is told as well.
const ESCALATE_AFTER_REMINDERS = 2;

/** How the AI names the team member for each category ("Ms. Cynthia from our Client Care team"). */
function teamNames_() {
  const names = {};
  Object.keys(CATEGORIES).forEach(function (cat) {
    const r = getRouting_(cat);
    const name = r ? displayName_(r.name) : '';
    names[cat] = (name ? name + ' from ' : '') + 'our ' + TEAM_LABEL[cat] + ' team';
  });
  return names;
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

/**
 * Opens a ticket for an escalated concern, or records a follow-up on the
 * person's existing open ticket for the same concern.
 *
 * @param {Object} decision Claude's structured answer (escalate === true)
 * @param {Object} user from findUser_
 * @param {Object} source {spaceId, spaceName, isDm, link, threadName}
 * @return {{ticketId: string, isNew: boolean, notified: boolean}}
 */
function handleEscalation_(decision, user, source) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const category = decision.category;
    const priority = PRIORITIES.indexOf(decision.priority) >= 0 ? decision.priority : 'NORMAL';
    // The team sees the sender's own words. The sheet keeps payroll messages with figures removed.
    const original = String(source.message || '').trim().slice(0, 2000) ||
      String(decision.concern_summary || '').trim() || 'See source conversation.';
    const summary = category === 'PAYROLL' ? redactSensitive_(original) : original;

    const existing = findDuplicate_(decision, user, category);
    if (existing) {
      appendHistory_(existing, 'Follow-up from ' + user.name + ': ' + summary);
      const notified = notifyAssignee_(existing, original, true);
      audit_({ email: user.email, role: user.role, space: source.spaceId, action: 'TICKET_FOLLOW_UP', ticketId: existing.id });
      return { ticketId: existing.id, isNew: false, notified: notified };
    }

    const routing = getRouting_(category) || getRouting_('OPERATIONS');
    const now = new Date();
    const slaHours = routing ? routing.sla[priority] : DEFAULT_SLA_HOURS[priority];
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
      summary: summary,
      recommendedAction: String(decision.recommended_action || '').trim(),
      dueBy: new Date(now.getTime() + slaHours * 3600 * 1000),
    };
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
      'History': historyLine_('Created from a message by ' + user.name),
    });
    ticket.history = historyLine_('Created from a message by ' + user.name);

    const notified = notifyAssignee_(ticket, original, false);
    if (notified) {
      updateObject_(SHEETS.TICKETS, ticket.row, { 'Status': 'Assigned' });
      appendHistory_(ticket, 'Assigned to ' + (ticket.assigneeName || ticket.assigneeEmail) + ' (private notification sent)');
    } else {
      appendHistory_(ticket, 'Could not send private notification. Ticket left as New.');
      alertOperations_(ticket, user);
    }
    audit_({ email: user.email, role: user.role, space: source.spaceId, action: 'TICKET_CREATED', ticketId: ticket.id, detail: category + ' / ' + priority });
    return { ticketId: ticket.id, isNew: true, notified: notified };
  } finally {
    lock.releaseLock();
  }
}

function findDuplicate_(decision, user, category) {
  const open = openTicketsFor_(user.email);
  const named = String(decision.duplicate_of_ticket || '').trim().toUpperCase();
  if (named === 'NEW') return null;
  if (named) {
    for (let i = 0; i < open.length; i++) if (open[i].id.toUpperCase() === named) return open[i];
  }
  const cutoff = Date.now() - Number(getProp_('DEDUP_HOURS')) * 3600 * 1000;
  for (let i = 0; i < open.length; i++) {
    if (open[i].category === category && open[i].created.getTime() >= cutoff) return open[i];
  }
  return null;
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

/** A real @mention if we know the person's Chat ID, otherwise their name. */
function mentionFor_(email, name) {
  const user = email ? findUser_(email) : null;
  if (user && user.chatUserId) return '<' + user.chatUserId + '>';
  return displayName_(name) || email || 'team';
}

/**
 * Posts a message for the assignee in the team group chat, if one is set up.
 * Callers remove payroll figures first (see notifyAssignee_).
 * @return {boolean} true if posted
 */
function postToTeam_(ticket, text) {
  const space = teamInbox_();
  if (!space) return false;
  try {
    postMessage_(space, 'For ' + mentionFor_(ticket.assigneeEmail, ticket.assigneeName) + ':\n\n' +
      text.split(DONE_LINE).join('When it\'s sorted, reply here: @' + APP_NAME + ' done '));
    return true;
  } catch (e) {
    console.error('Team chat post for ' + ticket.id + ' failed: ' + e);
    return false;
  }
}

/** The Name / Concern / Priority block used in every message to the team. */
function concernLines_(ticket, concern) {
  const p = String(ticket.priority || 'NORMAL');
  return ['Name: ' + (ticket.requesterName || ticket.requesterEmail),
    'Concern: ' + concern,
    'Priority: ' + p.charAt(0) + p.slice(1).toLowerCase()].join('\n\n');
}

/** "Vicky Santos" -> "Vicky". */
function firstName_(name) {
  return String(name || '').replace(/\s*\(.*\)\s*/g, ' ').trim().split(' ')[0];
}

/**
 * Sends a short private message to the assignee (or their backup).
 * Payroll details only go to someone marked Payroll Cleared = YES.
 * @param {string} message the sender's own words
 * @param {boolean} isFollowUp true for a further message about an open concern
 */
function notifyAssignee_(ticket, message, isFollowUp) {
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
  // numbers are removed there, because everyone in the chat can read it.
  const teamText = ticket.category === 'PAYROLL'
    ? text.replace(details, function () { return redactSensitive_(message); }) : text;
  if (postToTeam_(ticket, teamText)) return true;

  const recipients = [ticket.assigneeEmail];
  if (routing && routing.backupEmail) recipients.push(routing.backupEmail);
  for (let i = 0; i < recipients.length; i++) {
    if (!recipients[i]) continue;
    try {
      if (sendPrivateMessage_(recipients[i], recipients[i] === ticket.assigneeEmail ? text
        : '(Covering for ' + (displayName_(ticket.assigneeName) || ticket.assigneeEmail) + ')\n\n' + text)) return true;
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
    sendPrivateMessage_(ops.email, ['New concern (I couldn\'t reach ' + (displayName_(ticket.assigneeName) || 'the right person') + ')',
      concernLines_(ticket, ticket.category === 'PAYROLL' ? 'Payroll matter (details are private)' : ticket.summary),
      DONE_LINE + ticket.id].join('\n\n'));
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
      sendPrivateMessage_(ticket.requesterEmail, 'Quick update: ' + (ticket.assigneeName || 'the team').replace(/\s*\(.*\)\s*/g, ' ').trim() +
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
      lines.push('- ' + formatTime_(t.created) + ': with ' + (t.assigneeName || 'the team').replace(/\s*\(.*\)\s*/g, ' ').trim() +
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

/**
 * Time-driven job (add an hourly trigger for it under Triggers): reminds assignees about
 * overdue tickets and tells Operations when a ticket stays overdue.
 */
function checkOverdueTickets() {
  resetMemo_();
  const now = Date.now();
  const ops = getRouting_('OPERATIONS');
  readTickets_().forEach(function (t) {
    if (t.status === 'Resolved' || t.status === 'Awaiting Response') return;
    if (!t.dueBy || t.dueBy.getTime() > now) return;
    const every = (REMINDER_EVERY_HOURS[t.priority] || 8) * 3600 * 1000;
    if (t.lastReminder && now - t.lastReminder.getTime() < every) return;

    const hoursLate = Math.round((now - t.dueBy.getTime()) / 3600000);
    const reminderFor = function (concern) {
      return ['Reminder: still waiting for help', concernLines_(t, concern), DONE_LINE + t.id].join('\n\n');
    };
    let sent = false;
    try {
      // The sheet already stores payroll messages with figures removed.
      sent = postToTeam_(t, reminderFor(t.summary)) || (t.assigneeEmail ? sendPrivateMessage_(t.assigneeEmail,
        reminderFor(t.category === 'PAYROLL' ? 'Payroll matter (details are private)' : t.summary)) : false);
    } catch (e) {
      console.error('Reminder for ' + t.id + ' failed: ' + e);
    }
    const reminders = t.remindersSent + 1;
    updateObject_(SHEETS.TICKETS, t.row, { 'Reminders Sent': reminders, 'Last Reminder': new Date() });
    appendHistory_(t, 'Overdue reminder #' + reminders + (sent ? ' sent' : ' could not be sent'));

    // Tell Operations once: after repeated reminders, or straight away if the assignee can't be reached.
    if ((reminders === ESCALATE_AFTER_REMINDERS || (!sent && reminders === 1)) && ops && ops.email && ops.email !== t.assigneeEmail) {
      try {
        const heads = function (concern) {
          return ['Heads up: this is ' + hoursLate + 'h overdue with ' + (displayName_(t.assigneeName) || 'nobody yet'),
            concernLines_(t, concern)].join('\n\n');
        };
        if (!postToTeam_({ id: t.id, assigneeEmail: ops.email, assigneeName: ops.name }, heads(t.summary))) {
          sendPrivateMessage_(ops.email, heads(t.category === 'PAYROLL' ? 'Payroll matter (details are private)' : t.summary));
        }
        appendHistory_(t, 'Escalated to Operations (' + ops.email + ')');
      } catch (e) {
        console.error('Escalation for ' + t.id + ' failed: ' + e);
      }
    }
  });
}

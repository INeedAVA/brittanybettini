/**
 * One-time setup and health checks. Run these from the Apps Script editor
 * (choose the function in the toolbar, then click Run).
 *
 *   setup()        prepares the tabs, headers and drop-downs in the control sheet
 *   checkSetup()   checks every piece and logs what still needs doing
 *   tryInEditor()  asks the AI a test question without Google Chat
 *
 * Before setup(): create a blank Google Sheet, share it with the service
 * account's email as Editor, and put its ID in Script Property CONTROL_SHEET_ID.
 */

function setup() {
  resetMemo_();
  const saEmail = getServiceAccountEmail_();
  let meta = sheetsApi_('get', '?fields=sheets.properties(sheetId,title)');
  const titles = meta.sheets.map(function (s) { return s.properties.title; });
  const defs = Object.keys(SHEETS).map(function (k) { return SHEETS[k]; });

  const add = defs.filter(function (d) { return titles.indexOf(d.name) < 0; })
    .map(function (d) { return { addSheet: { properties: { title: d.name } } }; });
  if (add.length) sheetsApi_('post', ':batchUpdate', { requests: add });
  meta = sheetsApi_('get', '?fields=sheets.properties(sheetId,title)');
  const ids = {};
  meta.sheets.forEach(function (s) { ids[s.properties.title] = s.properties.sheetId; });

  const headerRows = sheetsApi_('get', '/values:batchGet?' + defs.map(function (d) {
    return 'ranges=' + encodeURIComponent(quoteSheet_(d.name) + '!1:1');
  }).join('&')).valueRanges || [];
  const writes = [];
  defs.forEach(function (d, i) {
    const current = (headerRows[i] && headerRows[i].values && headerRows[i].values[0]) || [];
    if (current.join('') === '') writes.push({ range: quoteSheet_(d.name) + '!A1', values: [d.headers] });
  });
  if (writes.length) sheetsApi_('post', '/values:batchUpdate', { valueInputOption: 'RAW', data: writes });

  const requests = [];
  defs.forEach(function (d) {
    requests.push({ updateSheetProperties: {
      properties: { sheetId: ids[d.name], gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount',
    } });
    requests.push({ repeatCell: {
      range: { sheetId: ids[d.name], startRowIndex: 0, endRowIndex: 1 },
      cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.91, green: 0.92, blue: 0.96 } } },
      fields: 'userEnteredFormat(textFormat,backgroundColor)',
    } });
  });
  const dropdown = function (def, header, values) {
    requests.push({ setDataValidation: {
      range: { sheetId: ids[def.name], startRowIndex: 1, startColumnIndex: def.headers.indexOf(header),
        endColumnIndex: def.headers.indexOf(header) + 1 },
      rule: { condition: { type: 'ONE_OF_LIST', values: values.map(function (v) { return { userEnteredValue: v }; }) },
        strict: true, showCustomUi: true },
    } });
  };
  dropdown(SHEETS.USERS, 'Role', ROLES);
  dropdown(SHEETS.USERS, 'Active', ['YES', 'NO']);
  dropdown(SHEETS.SPACES, 'Approved', ['YES', 'NO']);
  dropdown(SHEETS.SPACES, 'Audience', ['CLIENT', 'VA', 'HR', 'MANAGEMENT']);
  dropdown(SHEETS.ROUTING, 'Payroll Cleared', ['YES', 'NO']);
  dropdown(SHEETS.KNOWLEDGE, 'Status', ['Approved', 'Draft', 'Retired']);
  dropdown(SHEETS.TICKETS, 'Status', STATUSES);
  dropdown(SHEETS.TICKETS, 'Priority', PRIORITIES);
  if (ids.hasOwnProperty('Sheet1')) requests.push({ deleteSheet: { sheetId: ids['Sheet1'] } });
  sheetsApi_('post', ':batchUpdate', { requests: requests });

  const admin = lower_(getProp_('ADMIN_EMAIL'));
  if (admin && readTable_(SHEETS.USERS).length === 0) {
    appendObject_(SHEETS.USERS, { 'Email': admin, 'Name': 'Administrator', 'Role': 'ADMIN', 'Active': 'YES',
      'Notes': 'Added by setup()' });
  }
  if (readTable_(SHEETS.ROUTING).length === 0) {
    [
      ['CLIENT_CARE', 'Cyn', 'cyn@REPLACE-ME.com', '', 'NO'],
      ['OPERATIONS', 'Mabelle', 'mabelle@REPLACE-ME.com', '', 'NO'],
      ['RECRUITMENT_HR', 'Verge', 'verge@REPLACE-ME.com', '', 'NO'],
      ['PAYROLL', 'Payroll contact', 'payroll@REPLACE-ME.com', '', 'YES'],
    ].forEach(function (r) {
      appendObject_(SHEETS.ROUTING, {
        'Category': r[0], 'Assignee Name': r[1], 'Assignee Email': r[2], 'Backup Email': r[3], 'Payroll Cleared': r[4],
        'SLA Hours URGENT': DEFAULT_SLA_HOURS.URGENT, 'SLA Hours HIGH': DEFAULT_SLA_HOURS.HIGH,
        'SLA Hours NORMAL': DEFAULT_SLA_HOURS.NORMAL, 'SLA Hours LOW': DEFAULT_SLA_HOURS.LOW,
      });
    });
  }

  console.log('Setup complete. Control sheet: https://docs.google.com/spreadsheets/d/' + controlSheetId_());
  console.log('Share each knowledge document (or their folder) with ' + saEmail + ' as Viewer.');
  console.log('Next: fill in the Routing, Users and Knowledge tabs, add the hourly trigger for checkOverdueTickets, then run checkSetup().');
}

/** Logs a checklist of what is working and what still needs doing. */
function checkSetup() {
  const ok = [];
  const todo = [];
  const check = function (label, fn) {
    try {
      const note = fn();
      ok.push('OK   ' + label + (note ? ' - ' + note : ''));
    } catch (e) {
      todo.push('FIX  ' + label + ' - ' + (e && e.message ? e.message : e));
    }
  };

  resetMemo_();
  check('Service account key', function () { return getServiceAccountEmail_(); });
  check('Control spreadsheet (shared with the service account as Editor)', function () {
    sheetsApi_('get', '?fields=properties.title');
    readTable_(SHEETS.USERS);
    return 'https://docs.google.com/spreadsheets/d/' + controlSheetId_();
  });
  check('Anthropic API key', function () {
    if (!getProp_('ANTHROPIC_API_KEY')) throw new Error('Add ANTHROPIC_API_KEY in Project Settings > Script Properties');
  });
  check('Claude responds', function () {
    const resp = postToClaude_(getProp_('ANTHROPIC_API_KEY'), {
      model: getProp_('CLAUDE_MODEL'), max_tokens: 1000, output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    }, false);
    if (resp.code !== 200) throw new Error('HTTP ' + resp.code + ': ' + resp.text.slice(0, 300));
    return getProp_('CLAUDE_MODEL');
  });
  check('Chat API access (for private notifications)', function () {
    getServiceToken_(CHAT_SCOPE);
    return 'token obtained';
  });
  check('Routing', function () {
    const problems = [];
    Object.keys(CATEGORIES).forEach(function (cat) {
      const r = getRouting_(cat);
      if (!r || !r.email || /REPLACE-ME/i.test(r.email)) { problems.push(cat + ': set a real Assignee Email'); return; }
      const u = findUser_(r.email);
      if (!u || !u.active) problems.push(cat + ': ' + r.email + ' must be in Users with Active = YES');
      else if (!u.dmSpace && !u.chatUserId) problems.push(cat + ': ' + r.email + ' must send INAVA Assist one direct message (e.g. "hi")');
      if (cat === 'PAYROLL' && !r.payrollCleared) problems.push('PAYROLL: Payroll Cleared should be YES for the payroll contact');
    });
    if (problems.length) throw new Error(problems.join('; '));
  });
  check('Knowledge documents', function () {
    const docs = listKnowledgeDocs_();
    const approved = docs.filter(function (d) { return String(d.status).toUpperCase() === 'APPROVED'; });
    if (!approved.length) throw new Error('Add at least one Google Doc to the Knowledge tab with Status = Approved');
    const unreadable = approved.filter(function (d) { return getDocText_(d.url) === null; });
    if (unreadable.length) {
      throw new Error('Cannot open: ' + unreadable.map(function (d) { return d.title; }).join(', ') +
        '. Share them with ' + getServiceAccountEmail_() + ' as Viewer.');
    }
    return approved.length + ' approved document(s) readable';
  });
  check('Spaces', function () {
    const spaces = readTable_(SHEETS.SPACES);
    const approved = spaces.filter(function (s) { return isYes_(s['Approved']); });
    return spaces.length + ' known, ' + approved.length + ' approved';
  });

  console.log(['INAVA Assist setup check', ''].concat(ok, todo.length ? [''].concat(todo) : ['', 'Everything is set up.'],
    ['', 'Reminder: the hourly trigger for checkOverdueTickets is set under Triggers (clock icon).']).join('\n'));
}

/**
 * Asks the AI a question as a pretend user, without Google Chat, and logs the
 * structured answer. Edit the three values below, then Run. No ticket is created.
 */
function tryInEditor() {
  resetMemo_();
  const ROLE = 'VA';                       // CLIENT, VA, HR, MANAGEMENT or ADMIN
  const IN_SHARED_SPACE = false;           // true = answer as if in a space
  const QUESTION = 'How do I request time off?';

  const user = { name: 'Test User', email: 'test@example.com', role: ROLE, clientAccounts: [] };
  const space = IN_SHARED_SPACE ? { audience: ROLE === 'CLIENT' ? 'CLIENT' : 'VA', clientAccount: '' } : null;
  const ctx = buildAccessContext_(user, space);
  const knowledge = loadKnowledgeFor_(ctx);
  console.log('Documents available: ' + (knowledge.docs.map(function (d) { return d.title; }).join(', ') || 'none'));
  const decision = askClaude_({ text: QUESTION, user: user, ctx: ctx, knowledge: knowledge, openTickets: [], history: [] });
  console.log(JSON.stringify(decision, null, 2));
}

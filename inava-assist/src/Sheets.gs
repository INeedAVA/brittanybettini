/**
 * Reads and writes the control spreadsheet through the Google Sheets API, as
 * the bot's service account.
 *
 * Why not SpreadsheetApp? An Apps Script Chat app runs with the identity of the
 * person who messaged it. Reading the sheet as them would mean every VA and
 * client needs access to it. Instead, the sheet is shared ONLY with the service
 * account (and with you), and all reads and writes go through it.
 */

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets/';
const DATA_SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly';
const DATE_COLUMNS = ['Created', 'Updated', 'Due By', 'Last Reminder', 'Time', 'Added On', 'Last Reviewed'];

// Rows read during this run, so one message doesn't re-read the same tab many times.
var tableMemo_ = {};
var sheetTimeZone_ = null;

/** Call at the start of every entry point so each run sees fresh data. */
function resetMemo_() {
  tableMemo_ = {};
}

function controlSheetId_() {
  const id = getProp_('CONTROL_SHEET_ID');
  if (!id) throw new Error('CONTROL_SHEET_ID is not set in Script Properties.');
  return id;
}

function sheetsApi_(method, path, body) {
  const options = {
    method: method,
    headers: { Authorization: 'Bearer ' + getServiceToken_(DATA_SCOPES) },
    muteHttpExceptions: true,
  };
  if (body) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(body);
  }
  const resp = UrlFetchApp.fetch(SHEETS_API + controlSheetId_() + path, options);
  const code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Sheets API ' + method + ' failed (' + code + '): ' + resp.getContentText().slice(0, 300) +
      (code === 403 || code === 404 ? ' - is the control sheet shared with the service account as Editor?' : ''));
  }
  return JSON.parse(resp.getContentText() || '{}');
}

function quoteSheet_(name) {
  return "'" + name.replace(/'/g, "''") + "'";
}

function columnLetter_(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function getSheetTimeZone_() {
  if (sheetTimeZone_) return sheetTimeZone_;
  const cache = CacheService.getScriptCache();
  sheetTimeZone_ = cache.get('sheet_tz');
  if (!sheetTimeZone_) {
    sheetTimeZone_ = sheetsApi_('get', '?fields=properties.timeZone').properties.timeZone || Session.getScriptTimeZone();
    cache.put('sheet_tz', sheetTimeZone_, 21600);
  }
  return sheetTimeZone_;
}

/** Converts a Sheets date serial number (in the sheet's time zone) to a Date. */
function serialToDate_(serial) {
  const wall = new Date(Math.round((serial - 25569) * 86400000));
  const text = Utilities.formatDate(wall, 'UTC', 'yyyy-MM-dd HH:mm:ss');
  return Utilities.parseDate(text, getSheetTimeZone_(), 'yyyy-MM-dd HH:mm:ss');
}

/** Formats a value for writing. Text can never become a formula. */
function toCell_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, getSheetTimeZone_(), 'yyyy-MM-dd HH:mm:ss');
  if (typeof value === 'string' && /^[=+\-@']/.test(value)) return "'" + value;
  return value === null || value === undefined ? '' : value;
}

/** Returns every data row as an object keyed by header, plus _row (sheet row number). */
function readTable_(def) {
  if (tableMemo_[def.name]) return tableMemo_[def.name];
  const resp = sheetsApi_('get', '/values/' + encodeURIComponent(quoteSheet_(def.name)) +
    '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER');
  const values = resp.values || [];
  const rows = [];
  if (values.length >= 2) {
    const headers = values[0].map(String);
    for (let i = 1; i < values.length; i++) {
      const row = { _row: i + 1 };
      let empty = true;
      headers.forEach(function (h, c) {
        let v = values[i][c];
        if (v === undefined || v === null) v = '';
        if (v !== '') empty = false;
        if (DATE_COLUMNS.indexOf(h) >= 0 && v !== '') {
          v = typeof v === 'number' ? serialToDate_(v) : new Date(v);
        }
        row[h] = v;
      });
      if (!empty) rows.push(row);
    }
  }
  tableMemo_[def.name] = rows;
  return rows;
}

function appendObject_(def, obj) {
  delete tableMemo_[def.name];
  const row = def.headers.map(function (h) { return toCell_(obj.hasOwnProperty(h) ? obj[h] : ''); });
  const resp = sheetsApi_('post', '/values/' + encodeURIComponent(quoteSheet_(def.name) + '!A1') +
    ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS', { values: [row] });
  const m = String(resp.updates && resp.updates.updatedRange || '').match(/![A-Z]+(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Writes only the given fields of one row. */
function updateObject_(def, rowNumber, fields) {
  delete tableMemo_[def.name];
  const data = Object.keys(fields).map(function (h) {
    const col = def.headers.indexOf(h);
    if (col < 0) throw new Error('Unknown column "' + h + '" in ' + def.name);
    return { range: quoteSheet_(def.name) + '!' + columnLetter_(col + 1) + rowNumber, values: [[toCell_(fields[h])]] };
  });
  sheetsApi_('post', '/values:batchUpdate', { valueInputOption: 'USER_ENTERED', data: data });
}

function isYes_(value) {
  if (value === true) return true;
  const s = String(value || '').trim().toUpperCase();
  return s === 'YES' || s === 'Y' || s === 'TRUE';
}

function splitList_(value) {
  return String(value || '')
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s; });
}

function audit_(entry) {
  try {
    appendObject_(SHEETS.AUDIT, {
      'Time': new Date(),
      'Email': entry.email || '',
      'Role': entry.role || '',
      'Space': entry.space || '',
      'Action': entry.action || '',
      'Ticket ID': entry.ticketId || '',
      'Detail': String(entry.detail || '').slice(0, 500),
    });
  } catch (e) {
    console.error('Audit log write failed: ' + e);
  }
}

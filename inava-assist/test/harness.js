// Loads the Apps Script source into a Node VM with in-memory fakes of the
// Google services and HTTP APIs it uses, so the bot's logic can be tested
// without any Google or Anthropic account.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', 'src');
const SHEET_ID = 'control-sheet-id';

/** Date -> Sheets serial number (tests use UTC as the sheet time zone). */
function toSerial(date) {
  return date.getTime() / 86400000 + 25569;
}

function createEnv() {
  const props = { CONTROL_SHEET_ID: SHEET_ID };
  const cache = {};
  const docs = {};
  const sent = { claude: [], chat: [], token: 0 };
  // Fake spreadsheet: tab name -> 2D array of cell values.
  const tabs = { Sheet1: [] };
  let nextSheetId = 1;
  const sheetIds = { Sheet1: 0 };
  let claudeHandler = () => { throw new Error('No Claude handler set'); };
  // Chat API: messages posted with a client-assigned ID (per space), and an optional failure hook.
  const chatIds = {};
  let chatFail = null;
  let clockOffset = 0;

  function response(code, body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { getResponseCode: () => code, getContentText: () => text };
  }

  // What the Sheets API does with USER_ENTERED values.
  function enter(v) {
    if (typeof v !== 'string') return v;
    if (v.startsWith("'")) return v.slice(1);
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) return toSerial(new Date(v.replace(' ', 'T') + 'Z'));
    return v;
  }

  function parseRange(range) {
    const m = decodeURIComponent(range).match(/^'((?:[^']|'')+)'(?:!([A-Z]+)?(\d+)?(?::.*)?)?$/);
    if (!m) throw new Error('Bad range ' + range);
    const name = m[1].replace(/''/g, "'");
    let col = 0;
    if (m[2]) for (const ch of m[2]) col = col * 26 + (ch.charCodeAt(0) - 64);
    return { name, col: col ? col - 1 : 0, row: m[3] ? Number(m[3]) : 1 };
  }

  function sheetsApi(url, opts) {
    const rest = url.slice(('https://sheets.googleapis.com/v4/spreadsheets/' + SHEET_ID).length);
    const method = (opts.method || 'get').toLowerCase();
    const body = opts.payload ? JSON.parse(opts.payload) : null;
    if (rest.startsWith('?')) {
      return response(200, {
        properties: { title: 'Control', timeZone: 'UTC' },
        sheets: Object.keys(tabs).map((t) => ({ properties: { title: t, sheetId: sheetIds[t] } })),
      });
    }
    if (rest === ':batchUpdate') {
      body.requests.forEach((r) => {
        if (r.addSheet) { tabs[r.addSheet.properties.title] = []; sheetIds[r.addSheet.properties.title] = nextSheetId++; }
        if (r.deleteSheet) {
          const name = Object.keys(sheetIds).find((k) => sheetIds[k] === r.deleteSheet.sheetId);
          delete tabs[name]; delete sheetIds[name];
        }
      });
      return response(200, {});
    }
    if (rest.startsWith('/values:batchGet')) {
      const ranges = rest.split('?')[1].split('&').map((p) => p.replace('ranges=', ''));
      return response(200, { valueRanges: ranges.map((r) => {
        const { name } = parseRange(r);
        return { values: tabs[name] && tabs[name][0] ? [tabs[name][0]] : [] };
      }) });
    }
    if (rest === '/values:batchUpdate') {
      body.data.forEach((d) => {
        const { name, col, row } = parseRange(d.range);
        d.values.forEach((line, r) => line.forEach((v, c) => {
          while (tabs[name].length < row + r) tabs[name].push([]);
          tabs[name][row - 1 + r][col + c] = body.valueInputOption === 'RAW' ? v : enter(v);
        }));
      });
      return response(200, {});
    }
    const m = rest.match(/^\/values\/([^?:]+)(:append)?/);
    if (m && m[2] && method === 'post') {
      const { name } = parseRange(m[1]);
      const data = tabs[name];
      body.values.forEach((row) => data.push(row.map(enter)));
      return response(200, { updates: { updatedRange: "'" + name + "'!A" + data.length + ':Z' + data.length } });
    }
    if (m) {
      const { name } = parseRange(m[1]);
      if (!tabs[name]) return response(400, { error: 'no tab ' + name });
      return response(200, { values: tabs[name].map((r) => Array.from(r, (v) => (v === undefined ? '' : v))) });
    }
    throw new Error('Unexpected Sheets call ' + method + ' ' + url);
  }

  const ctx = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (k in cache ? cache[k] : null),
        put: (k, v) => { cache[k] = v; },
        getAll: (keys) => { const o = {}; keys.forEach((k) => { if (k in cache) o[k] = cache[k]; }); return o; },
        putAll: (o) => Object.assign(cache, o),
        remove: (k) => { delete cache[k]; },
      }),
    },
    UrlFetchApp: {
      fetch: (url, opts) => {
        opts = opts || {};
        if (url.indexOf('api.anthropic.com') >= 0) {
          const req = { headers: opts.headers, body: JSON.parse(opts.payload) };
          sent.claude.push(req);
          const r = claudeHandler(req);
          if (r.advanceMs) clockOffset += r.advanceMs;
          return response(r.code || 200, r.body);
        }
        if (url.indexOf('oauth2.googleapis.com') >= 0) {
          sent.token++;
          return response(200, { access_token: 'fake-token' });
        }
        if (url.indexOf('sheets.googleapis.com') >= 0) return sheetsApi(url, opts);
        if (url.indexOf('www.googleapis.com/drive/v3/files/') >= 0) {
          // docs[id] is a string (a Google Doc) or {mimeType, text} (e.g. a .txt file).
          const id = decodeURIComponent(url.split('/files/')[1].split(/[/?]/)[0]);
          if (!(id in docs)) return response(404, 'not found');
          const doc = typeof docs[id] === 'string' ? { mimeType: 'application/vnd.google-apps.document', text: docs[id] } : docs[id];
          if (url.indexOf('fields=mimeType') >= 0) return response(200, { mimeType: doc.mimeType });
          if (url.indexOf('/export') >= 0 && doc.mimeType !== 'application/vnd.google-apps.document') return response(403, 'fileNotExportable');
          return response(200, doc.text);
        }
        if (url.indexOf('chat.googleapis.com') >= 0) {
          const call = { url, method: opts.method, body: opts.payload ? JSON.parse(opts.payload) : null };
          if (url.indexOf('findDirectMessage') >= 0) { sent.chat.push(call); return response(404, { error: 'not found' }); }
          const failCode = chatFail && chatFail(url);
          if (failCode) { sent.chatFailed = (sent.chatFailed || 0) + 1; return response(failCode, { error: 'unavailable' }); }
          const id = (url.match(/[?&]messageId=([^&]+)/) || [])[1];
          if (id) {
            const key = url.split('/messages')[0] + '|' + id;
            if (chatIds[key]) return response(409, { error: { status: 'ALREADY_EXISTS' } });
            chatIds[key] = true;
          }
          sent.chat.push(call);
          return response(200, { name: 'spaces/x/messages/1' });
        }
        throw new Error('Unexpected fetch ' + url);
      },
    },
    Utilities: {
      sleep: () => {},
      formatDate: (d, tz, fmt) => {
        const iso = d.toISOString();
        if (fmt === 'yyMMdd') return iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);
        if (fmt === 'yyyy-MM-dd HH:mm:ss') return iso.slice(0, 10) + ' ' + iso.slice(11, 19);
        if (fmt === 'yyyy-MM-dd HH:mm') return iso.slice(0, 10) + ' ' + iso.slice(11, 16);
        if (fmt === 'd MMM') return String(d.getUTCDate()) + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
        if (fmt === 'u') return ctx.__weekday || '3';
        return iso;
      },
      parseDate: (text) => new Date(text.replace(' ', 'T') + 'Z'),
      base64EncodeWebSafe: (v) => Buffer.from(typeof v === 'string' ? v : Buffer.from(v)).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_'),
      computeRsaSha256Signature: (input, key) => [...crypto.sign('RSA-SHA256', Buffer.from(input), key)],
    },
    Session: { getScriptTimeZone: () => 'UTC' },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, tryLock: () => true, releaseLock: () => {} }) },
  };
  vm.createContext(ctx);

  // Controllable clock inside the VM (Date.now only; used for timing checks).
  ctx.__clockOffset = () => clockOffset;
  vm.runInContext('(function(){ const realNow = Date.now; Date.now = function(){ return realNow() + __clockOffset(); }; })()', ctx);

  // Files load in alphabetical order, which is a worst case for Apps Script
  // load-order bugs (Access.gs before Config.gs).
  if (process.env.TEST_DIST) {
    // The single-file bundle exactly as it will be pasted into Apps Script.
    const file = path.join(__dirname, '..', 'dist', 'INAVA_Assist.gs');
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: 'INAVA_Assist.gs' });
  } else {
    fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort().forEach((f) => {
      // Top-level const/let stay script-scoped in a VM; expose them as globals so tests can read them.
      let code = fs.readFileSync(path.join(SRC, f), 'utf8');
      code = code.replace(/^(const|let) /gm, 'var ');
      vm.runInContext(code, ctx, { filename: f });
    });
  }

  return {
    ctx,
    props,
    cache,
    docs,
    sent,
    tabs,
    setClaude: (fn) => { claudeHandler = fn; },
    // fn(url) returns an HTTP error code to fail that Chat API call, or null to let it through.
    setChatFail: (fn) => { chatFail = fn; },
    sheet: (name) => tabs[name],
    // Evaluates an expression inside the script (top-level consts are not globals in the bundle).
    get: (expr) => vm.runInContext(expr, ctx),
  };
}

module.exports = { createEnv, toSerial };

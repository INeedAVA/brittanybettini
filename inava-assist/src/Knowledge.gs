/**
 * Knowledge base: approved Google Docs listed in the Knowledge tab.
 *
 * Each row has a Title, a Google Doc URL, an Access list (any of ALL, VA, HR,
 * MANAGEMENT), an optional Client Account, and a Status. Only rows with
 * Status = Approved are ever used. To retire a document, change its Status.
 *
 * Each document must be a Google Doc or a plain .txt file shared with the service account (Viewer).
 * Sharing one Drive folder of approved documents with it is easiest. Nothing the
 * service account cannot open is ever used.
 *
 * Document text is cached for up to 6 hours to keep replies fast. After you edit
 * a document, run refreshKnowledgeBase() (or wait) to pick up the change.
 */

const KB_CACHE_SECONDS = 6 * 60 * 60;
const KB_CHUNK_CHARS = 20000;

function listKnowledgeDocs_() {
  return readTable_(SHEETS.KNOWLEDGE).map(function (r) {
    return {
      title: String(r['Title'] || '').trim(),
      url: String(r['Google Doc URL'] || '').trim(),
      access: String(r['Access'] || ''),
      clientAccount: String(r['Client Account'] || ''),
      status: String(r['Status'] || ''),
    };
  }).filter(function (d) { return d.title && d.url; });
}

/**
 * Returns the documents this person may use here, with their text.
 * @return {{docs: Array<{title:string, text:string}>, truncated: boolean}}
 */
function loadKnowledgeFor_(ctx) {
  const allowed = listKnowledgeDocs_().filter(function (d) { return documentAllowed_(d, ctx); });
  const docs = [];
  let total = 0;
  let truncated = false;
  for (let i = 0; i < allowed.length; i++) {
    const text = getDocText_(allowed[i].url);
    if (text === null) continue;
    if (total + text.length > MAX_KNOWLEDGE_CHARS) {
      truncated = true;
      break;
    }
    total += text.length;
    docs.push({ title: allowed[i].title, text: text });
  }
  return { docs: docs, truncated: truncated };
}

function docIdFromUrl_(url) {
  const m = String(url).match(/\/d\/([a-zA-Z0-9_-]{20,})/) || String(url).match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(url)) return url;
  return null;
}

/** Reads a Google Doc's text, using the cache when possible. Returns null on failure. */
function getDocText_(url) {
  const id = docIdFromUrl_(url);
  if (!id) {
    console.warn('Not a Google Doc URL: ' + url);
    return null;
  }
  const cache = CacheService.getScriptCache();
  const countKey = 'kb:' + id + ':n';
  const n = cache.get(countKey);
  if (n !== null) {
    const keys = [];
    for (let i = 0; i < Number(n); i++) keys.push('kb:' + id + ':' + i);
    const parts = cache.getAll(keys);
    if (keys.every(function (k) { return parts[k] !== undefined && parts[k] !== null; })) {
      return keys.map(function (k) { return parts[k]; }).join('');
    }
  }

  let text;
  try {
    text = readDocText_(id);
  } catch (e) {
    console.error('Could not read document ' + url + ': ' + e);
    return null;
  }
  const chunks = {};
  let count = 0;
  for (let i = 0; i < text.length; i += KB_CHUNK_CHARS) {
    chunks['kb:' + id + ':' + count] = text.slice(i, i + KB_CHUNK_CHARS);
    count++;
  }
  chunks[countKey] = String(count);
  try {
    cache.putAll(chunks, KB_CACHE_SECONDS);
  } catch (e) {
    console.warn('Could not cache document ' + id + ': ' + e);
  }
  return text;
}

/** Reads a Google Doc (exported as text) or a plain .txt file, as the service account. */
function readDocText_(id) {
  const auth = { Authorization: 'Bearer ' + getServiceToken_(DATA_SCOPES) };
  const base = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id);
  const meta = UrlFetchApp.fetch(base + '?fields=mimeType&supportsAllDrives=true', { headers: auth, muteHttpExceptions: true });
  if (meta.getResponseCode() !== 200) {
    throw new Error('HTTP ' + meta.getResponseCode() + ' (share the file with the service account as Viewer)');
  }
  const mimeType = JSON.parse(meta.getContentText()).mimeType;
  let url;
  if (mimeType === 'application/vnd.google-apps.document') url = base + '/export?mimeType=text%2Fplain';
  else if (mimeType === 'text/plain') url = base + '?alt=media&supportsAllDrives=true';
  else throw new Error('Unsupported file type ' + mimeType + ': use a Google Doc or a .txt file');
  const resp = UrlFetchApp.fetch(url, { headers: auth, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    throw new Error('HTTP ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 200));
  }
  return resp.getContentText('UTF-8');
}

/** Clears cached document text so the next question re-reads every document. */
function refreshKnowledgeBase() {
  const cache = CacheService.getScriptCache();
  listKnowledgeDocs_().forEach(function (d) {
    const id = docIdFromUrl_(d.url);
    if (id) cache.remove('kb:' + id + ':n');
  });
  console.log('Knowledge base cache cleared.');
}

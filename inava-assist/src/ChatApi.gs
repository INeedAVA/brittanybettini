/**
 * Google Chat API calls made as the Chat app itself ("app authentication").
 *
 * Used for: private notifications to team members, reminders, and replies that
 * take longer than Google Chat's 30-second window. Uses the chat.bot scope,
 * which does NOT need Workspace administrator approval.
 *
 * Requires Script Property SERVICE_ACCOUNT_KEY: the JSON key of a service
 * account in the same Google Cloud project as the Chat app. The same service
 * account reads the control sheet and the knowledge documents (Sheets.gs,
 * Knowledge.gs).
 */

const CHAT_API = 'https://chat.googleapis.com/v1/';
const CHAT_SCOPE = 'https://www.googleapis.com/auth/chat.bot';

/** The service account's email, e.g. inava-assist-bot@inava-assist.iam.gserviceaccount.com */
function getServiceAccountEmail_() {
  return serviceAccountKey_().client_email;
}

function serviceAccountKey_() {
  const raw = getProp_('SERVICE_ACCOUNT_KEY');
  if (!raw) throw new Error('SERVICE_ACCOUNT_KEY is not set in Script Properties.');
  return JSON.parse(raw);
}

/**
 * Gets an access token for the service account (cached for 50 minutes).
 * @param {string} scopes space-separated OAuth scopes
 */
function getServiceToken_(scopes) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'sa_token:' + Utilities.base64EncodeWebSafe(scopes).slice(0, 200);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const key = serviceAccountKey_();
  const tokenUri = key.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const encode = function (obj) {
    return Utilities.base64EncodeWebSafe(JSON.stringify(obj)).replace(/=+$/, '');
  };
  const unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({
    iss: key.client_email,
    scope: scopes,
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  });
  const signature = Utilities.base64EncodeWebSafe(
    Utilities.computeRsaSha256Signature(unsigned, key.private_key)).replace(/=+$/, '');

  const resp = UrlFetchApp.fetch(tokenUri, {
    method: 'post',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + signature,
    },
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Service account token request failed: ' + resp.getContentText());
  }
  const token = JSON.parse(resp.getContentText()).access_token;
  cache.put(cacheKey, token, 3000);
  return token;
}

function chatApi_(method, path, body) {
  const options = {
    method: method,
    headers: { Authorization: 'Bearer ' + getServiceToken_(CHAT_SCOPE) },
    muteHttpExceptions: true,
  };
  if (body) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(body);
  }
  const resp = UrlFetchApp.fetch(CHAT_API + path, options);
  const code = resp.getResponseCode();
  const text = resp.getContentText();
  if (code === 404) return null;
  if (code < 200 || code >= 300) throw new Error('Chat API ' + method + ' ' + path + ' failed (' + code + '): ' + text);
  return text ? JSON.parse(text) : {};
}

/**
 * Posts a message as the app.
 * @param {string} spaceName e.g. "spaces/AAAA..."
 * @param {string} text Chat-formatted text
 * @param {string=} threadName reply in this thread when given
 */
function postMessage_(spaceName, text, threadName) {
  let path = spaceName + '/messages';
  const message = { text: text };
  if (threadName) {
    message.thread = { name: threadName };
    path += '?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD';
  }
  return chatApi_('post', path, message);
}

/** Finds the existing DM space between the app and a user ("users/123..."), or null. */
function findDirectMessageSpace_(chatUserId) {
  const space = chatApi_('get', 'spaces:findDirectMessage?name=' + encodeURIComponent(chatUserId));
  return space ? space.name : null;
}

/**
 * Sends a private message to a person listed in the Users tab.
 * They must have messaged INAVA Assist at least once (Google requires the DM to exist).
 * @return {boolean} true if sent
 */
function sendPrivateMessage_(email, text) {
  const user = findUser_(email);
  if (!user) {
    console.warn('Cannot notify ' + email + ': not in the Users tab.');
    return false;
  }
  let dmSpace = user.dmSpace;
  if (!dmSpace && user.chatUserId) {
    dmSpace = findDirectMessageSpace_(user.chatUserId);
    if (dmSpace) rememberUserChatIds_(user, '', dmSpace);
  }
  if (!dmSpace) {
    console.warn('Cannot notify ' + email + ': they have not messaged INAVA Assist yet.');
    return false;
  }
  postMessage_(dmSpace, text);
  return true;
}

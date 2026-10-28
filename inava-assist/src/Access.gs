/**
 * Identity and authorization.
 *
 * Google Chat tells us who sent each message (Google verifies the account; the
 * sender cannot fake it). We then look the email up in the Users tab. Anyone
 * not listed there, or not marked Active, gets no AI answers and no knowledge.
 *
 * What a person may see depends on two things:
 *   1. their Role (VA, HR, MANAGEMENT, ADMIN) and, for VAs, the client accounts they work on;
 *   2. where they are asking. In a shared space everyone in the space reads the
 *      answer, so the space's Audience also limits what may be used. A manager
 *      asking in a VA space only gets VA-safe knowledge.
 */

function findUser_(email) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return null;
  const rows = readTable_(SHEETS.USERS);
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i]['Email']).trim().toLowerCase() === target) {
      const r = rows[i];
      const role = String(r['Role']).trim().toUpperCase();
      return {
        row: r._row,
        email: target,
        name: String(r['Name'] || '').trim() || target,
        role: ROLES.indexOf(role) >= 0 ? role : null,
        clientAccounts: splitList_(r['Client Accounts']).map(lower_),
        active: isYes_(r['Active']),
        chatUserId: String(r['Chat User ID'] || ''),
        dmSpace: String(r['DM Space'] || ''),
      };
    }
  }
  return null;
}

/** Remembers a user's Chat ID and their DM space with the app, so we can notify them later. */
function rememberUserChatIds_(user, chatUserId, dmSpace) {
  const fields = {};
  if (chatUserId && user.chatUserId !== chatUserId) fields['Chat User ID'] = chatUserId;
  if (dmSpace && user.dmSpace !== dmSpace) fields['DM Space'] = dmSpace;
  if (Object.keys(fields).length) updateObject_(SHEETS.USERS, user.row, fields);
}

function findSpace_(spaceId) {
  const rows = readTable_(SHEETS.SPACES);
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i]['Space ID']).trim() === spaceId) {
      const r = rows[i];
      const audience = String(r['Audience'] || '').trim().toUpperCase();
      return {
        row: r._row,
        id: spaceId,
        name: String(r['Space Name'] || ''),
        approved: isYes_(r['Approved']),
        // An unset or unknown audience is treated as the most restrictive one.
        audience: ROLES.indexOf(audience) >= 0 ? audience : 'VA',
        clientAccount: lower_(r['Client Account']),
        // The team's group chat, where new concerns are posted (Tickets.gs).
        teamInbox: isYes_(r['Team Inbox']),
      };
    }
  }
  return null;
}

/** Records a space the app was added to. New spaces start NOT approved. */
function registerSpace_(spaceId, displayName, addedBy) {
  const existing = findSpace_(spaceId);
  if (existing) return existing;
  appendObject_(SHEETS.SPACES, {
    'Space ID': spaceId,
    'Space Name': displayName || '',
    'Approved': 'NO',
    'Audience': 'VA',
    'Client Account': '',
    'Added On': new Date(),
    'Notes': 'Added by ' + (addedBy || 'unknown') + '. Set Approved to YES to enable.',
  });
  return findSpace_(spaceId);
}

/**
 * Builds the access context for one question.
 * @param {Object} user from findUser_
 * @param {Object|null} space from findSpace_, or null for a direct message
 */
function buildAccessContext_(user, space) {
  return {
    role: user.role,
    clientAccounts: user.clientAccounts,
    inSharedSpace: !!space,
    spaceAudience: space ? space.audience : null,
    spaceClientAccount: space ? space.clientAccount : '',
  };
}

/** True if a role is allowed by a document's Access list. ADMIN inherits MANAGEMENT. */
function roleAllowed_(role, accessList) {
  if (accessList.indexOf('ALL') >= 0) return true;
  if (accessList.indexOf(role) >= 0) return true;
  return role === 'ADMIN' && accessList.indexOf('MANAGEMENT') >= 0;
}

/** Decides whether one Knowledge row may be used for this question. */
function documentAllowed_(doc, ctx) {
  if (String(doc.status).trim().toUpperCase() !== 'APPROVED') return false;
  const access = splitList_(doc.access).map(function (s) { return s.toUpperCase(); });
  if (!roleAllowed_(ctx.role, access)) return false;
  if (ctx.inSharedSpace && !roleAllowed_(ctx.spaceAudience, access)) return false;

  const docClient = lower_(doc.clientAccount);
  if (!docClient) return true;
  // Client-specific document.
  if (ctx.inSharedSpace) {
    // Only ever inside that client's own space.
    if (ctx.spaceClientAccount !== docClient) return false;
  }
  if (ctx.role === 'MANAGEMENT' || ctx.role === 'ADMIN' || ctx.role === 'HR') return true;
  return ctx.clientAccounts.indexOf(docClient) >= 0;
}

function isStaff_(user) {
  return STAFF_ROLES.indexOf(user.role) >= 0;
}

function lower_(value) {
  return String(value || '').trim().toLowerCase();
}

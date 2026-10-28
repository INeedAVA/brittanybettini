/**
 * Ask INAVA - configuration.
 *
 * Nothing in this file needs to change for day-to-day operation. Routing,
 * users, spaces and knowledge documents all live in the control spreadsheet
 * that setup() creates. Secrets live in Project Settings > Script Properties:
 *
 *   ANTHROPIC_API_KEY     your Anthropic API key (required)
 *   SERVICE_ACCOUNT_KEY   the JSON key of the Chat app's service account (required
 *                         for private notifications and slow replies)
 *   CONTROL_SHEET_ID      filled in automatically by setup()
 *
 * Optional Script Properties (defaults shown in DEFAULTS below):
 *   CLAUDE_MODEL, CLAUDE_EFFORT, CLAUDE_FALLBACKS, SHOW_SOURCES, SHOW_AI_LABEL
 */

const APP_NAME = 'Ask INAVA';

const DEFAULTS = {
  // Cheapest current model. For better answers on tricky or emotional messages,
  // set Script Property CLAUDE_MODEL to claude-sonnet-5-5 (about 20x the cost)
  // or claude-opus-5-5 (about 40x).
  CLAUDE_MODEL: 'claude-haiku-5-5',
  // 'low' keeps replies fast enough for Google Chat's 30-second window.
  // Raise to 'medium' if answers feel too shallow.
  CLAUDE_EFFORT: 'low',
  // 'default' lets Anthropic retry a safety-declined request on another model.
  // Set to 'off' to disable.
  CLAUDE_FALLBACKS: 'default',
  // Show "Source: <document>" under answers ('on' / 'off').
  SHOW_SOURCES: 'off',
  // Show "Ask INAVA · AI assistant" under every reply ('on' / 'off').
  SHOW_AI_LABEL: 'off',
};

// Notes about known gaps or conflicts in the approved documents, sent with them to the AI.
// Override with Script Property POLICY_NOTES (set it to "none" once HR has fixed the documents).
const DEFAULT_POLICY_NOTES = [
  '- Leave notice: the handbook gives two different notice periods. The Leave Process section says "file two (2) weeks before the leave date" (filing late: not permitted to take the leave, and not eligible for the perfect attendance bonus). Another section says to notify Workforce and HR "at least ten (10) business days in advance". HR has not yet confirmed which applies. When asked about leave notice, mention both as written, say HR confirms which applies, and suggest filing as early as possible. For a request that is already late or close to the date, do not say it will be refused or allowed: say HR decides and offer to pass it to HR.',
].join('\n');

function policyNotes_() {
  const v = getProp_('POLICY_NOTES');
  if (v && String(v).trim().toLowerCase() === 'none') return '';
  return v || DEFAULT_POLICY_NOTES;
}

// USD per million tokens [input, output, cache read], used only to estimate cost in the
// Audit Log. Cache writes are billed at 1.25x input. Check current prices at claude.com/pricing.
const MODEL_PRICES = {
  'claude-haiku-5-5': [0.10, 0.50, 0.01],
  'claude-sonnet-5-5': [2, 10, 0.20],
  'claude-opus-5-5': [4, 20, 0.20],
};

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2026-10-21';
const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// Google Chat waits 30 seconds for a reply. Past this point we post the reply
// through the Chat API instead of returning it.
const SYNC_REPLY_BUDGET_MS = 24000;

// Upper bound on knowledge base text sent to Claude per question.
const MAX_KNOWLEDGE_CHARS = 600000;

// Ask INAVA serves VAs and the internal team. Clients are outside the Workspace and never use it.
const ROLES = ['VA', 'HR', 'MANAGEMENT', 'ADMIN'];

// Roles that may run ticket commands for tickets they are not assigned to.
const STAFF_ROLES = ['HR', 'MANAGEMENT', 'ADMIN'];

const CATEGORIES = {
  CLIENT_CARE: 'Client Care',
  OPERATIONS: 'Operations / Management Escalation',
  RECRUITMENT_HR: 'Recruitment / HR',
  PAYROLL: 'Payroll (Sensitive)',
};

const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

const STATUSES = ['New', 'Assigned', 'In Progress', 'Awaiting Response', 'Resolved'];

// Control spreadsheet tab names and column headers. setup() creates these.
const SHEETS = {
  USERS: {
    name: 'Users',
    headers: ['Email', 'Name', 'Role', 'Client Accounts', 'Active', 'Chat User ID', 'DM Space', 'Notes'],
  },
  SPACES: {
    name: 'Spaces',
    headers: ['Space ID', 'Space Name', 'Approved', 'Audience', 'Client Account', 'Added On', 'Notes', 'Team Inbox', 'Morning Briefing'],
  },
  ROUTING: {
    name: 'Routing',
    headers: ['Category', 'Assignee Name', 'Assignee Email', 'Backup Email', 'Payroll Cleared',
      'SLA Hours URGENT', 'SLA Hours HIGH', 'SLA Hours NORMAL', 'SLA Hours LOW'],
  },
  KNOWLEDGE: {
    name: 'Knowledge',
    headers: ['Title', 'Google Doc URL', 'Access', 'Client Account', 'Status', 'Last Reviewed', 'Notes'],
  },
  TICKETS: {
    name: 'Tickets',
    headers: ['Ticket ID', 'Status', 'Category', 'Priority', 'Assignee Name', 'Assignee Email',
      'Requester Name', 'Requester Email', 'Source', 'Source Link', 'Summary', 'Recommended Action',
      'Created', 'Updated', 'Due By', 'Reminders Sent', 'Last Reminder', 'History',
      // Added in Phase 1 (ensureColumns_ adds them to an existing sheet): which chat messages a
      // ticket came from (so a retried event never makes a second ticket), and whether the
      // team chat has really received it (Pending tickets are re-sent safely).
      // Urgent Notice: the extra URGENT: SAFETY CONCERN card (Pending / Posted / Failed), retried like Delivery.
      'Source Message ID', 'Delivery', 'Delivery Attempts', 'Urgent Notice'],
  },
  AUDIT: {
    name: 'Audit Log',
    headers: ['Time', 'Email', 'Role', 'Space', 'Action', 'Ticket ID', 'Detail'],
  },
};

function getProp_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (value !== null && value !== '') return value;
  return DEFAULTS.hasOwnProperty(key) ? DEFAULTS[key] : null;
}

function isOn_(key) {
  return String(getProp_(key)).trim().toLowerCase() === 'on';
}

function setProp_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
}

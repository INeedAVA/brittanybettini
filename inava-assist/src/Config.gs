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
 *   CLAUDE_MODEL, CLAUDE_EFFORT, CLAUDE_FALLBACKS, DEDUP_HOURS
 */

const APP_NAME = 'Ask INAVA';

const DEFAULTS = {
  CLAUDE_MODEL: 'claude-opus-5-5',
  // 'low' keeps replies fast enough for Google Chat's 30-second window.
  // Raise to 'medium' if answers feel too shallow.
  CLAUDE_EFFORT: 'low',
  // 'default' lets Anthropic retry a safety-declined request on another model.
  // Set to 'off' to disable.
  CLAUDE_FALLBACKS: 'default',
  // A new concern from the same person in the same category within this many
  // hours is treated as a follow-up to their open ticket, not a new ticket.
  DEDUP_HOURS: '24',
  // Show "Source: <document>" under answers ('on' / 'off').
  SHOW_SOURCES: 'off',
  // Show "Ask INAVA · AI assistant" under every reply ('on' / 'off').
  SHOW_AI_LABEL: 'off',
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
    headers: ['Space ID', 'Space Name', 'Approved', 'Audience', 'Client Account', 'Added On', 'Notes', 'Team Inbox'],
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
      'Created', 'Updated', 'Due By', 'Reminders Sent', 'Last Reminder', 'History'],
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

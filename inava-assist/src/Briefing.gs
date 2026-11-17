/**
 * Morning briefing: once a day, a short post in the space(s) marked
 * Morning Briefing = YES in the Spaces tab: a quote,
 * 2-3 current items about apps and software that are useful to VAs, and
 * alerts about calamities or disruptions in the Philippines and the USA.
 *
 * The trending items and alerts come from a live web search (Anthropic's web search tool),
 * so they are current and carry their source. If search is unavailable, the
 * briefing is posted without them rather than with made-up news.
 *
 * Runs from dailyMorning() (Triggers: Day timer). Uses BRIEFING_MODEL, which
 * defaults to Sonnet: it runs once a day, so quality matters more than the
 * few cents it costs.
 */

const BRIEFING_MODEL_DEFAULT = 'claude-sonnet-5-5';
const BRIEFING_HISTORY_DAYS = 10;

const BRIEFING_PROMPT = [
  'You write the morning briefing for I Need A VA (INAVA), posted in the internal Google Chat space of INAVA\'s staff and virtual assistants (VAs). VAs are remote, mostly in the Philippines, supporting US small businesses with admin, inboxes, scheduling, social media, customer service and bookkeeping tasks.',
  '',
  'Write three short parts, in this order, as plain text with no headings or markdown:',
  '1. A line starting "💬 " with one genuine, well-known quote and the real person who said it. Only use a quote you are confident is real and correctly attributed; never invent or misattribute one.',
  '2. A line "🔥 Trending for VAs:" followed by 2 or 3 lines starting "- ", each one current item about apps, AI tools or software that matters to VAs (a new feature, launch, update or useful change from the last two weeks). Use web search to find them. Each line: what it is and why a VA would care, in one sentence, then the source in brackets, e.g. (source: zapier.com). Only include items you found in search results; if you cannot find any, write "- Nothing big today. Back tomorrow!"',
  '',
  '3. A line "🌏 PH & US alerts:" followed by up to 3 lines starting "- ", only about the Philippines or the USA, only current events (last 48 hours) that could affect VAs or their US clients: typhoons, storms, floods, earthquakes, volcanic activity, major power or internet outages, work or class suspensions, or major holidays. Use web search. Each line: place, what is happening, and a practical note if useful (e.g. "charge your laptop and keep a backup connection ready"), then the source in brackets. Calm and factual, never alarming or graphic. No politics, crime or celebrity news. If there is nothing significant, write "- No major alerts today. Stay safe!"',
  '',
  'Tone: warm, upbeat and encouraging, like a team lead starting the day; calm and caring in the alerts. Keep the whole briefing under 170 words. Do not repeat any quote or news item from the recent briefings listed below (repeat an alert only if it is still ongoing, and say so).',
].join('\n');

/** Daily job for the Day timer: posts the morning briefing, then the open-concerns check-in. Skips weekends. */
function dailyMorning() {
  const day = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'u'); // 1 = Monday ... 7 = Sunday
  if (day === '6' || day === '7') return;
  try {
    postMorningBriefing();
  } catch (e) {
    console.error('Morning briefing failed: ' + e);
  }
  try {
    // First Wednesday of the month only (does nothing on other days).
    if (day === '3' && Number(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'd')) <= 7) {
      postMonthlyReminder();
      postMonthlySummary();
    }
  } catch (e) {
    console.error('Monthly reminder failed: ' + e);
  }
  try {
    clearOldOffTopicCounts_();
  } catch (e) {
    console.error('Clearing off-topic counts failed: ' + e);
  }
  try {
    // Concerns that were saved but never reached the team chat (does nothing when there are none).
    retryUndeliveredConcerns();
  } catch (e) {
    console.error('Retry of undelivered concerns failed: ' + e);
  }
  checkOverdueTickets();
}

function briefingSpaces_() {
  return readTable_(SHEETS.SPACES).filter(function (r) {
    return isYes_(r['Approved']) && isYes_(r['Morning Briefing']);
  }).map(function (r) { return String(r['Space ID']).trim(); });
}

/** Writes today's briefing and posts it. Safe to run by hand to preview. */
function postMorningBriefing() {
  resetMemo_();
  const spaces = briefingSpaces_();
  if (!spaces.length) {
    console.log('No space has Morning Briefing = YES in the Spaces tab.');
    return;
  }
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'EEEE, d MMMM yyyy');
  const history = loadBriefingHistory_();

  const body = writeBriefing_(today, history);
  const heading = 'Good morning, team! · ' + Utilities.formatDate(new Date(), tz, 'EEEE, d MMMM');
  spaces.forEach(function (space) {
    try {
      postCard_(space, heading, body);
    } catch (e) {
      console.error('Briefing post to ' + space + ' failed: ' + e);
    }
  });
  saveBriefingHistory_(history, today, body);
  audit_({ action: 'MORNING_BRIEFING', detail: spaces.length + ' space(s)' });
}

/** Asks Claude for the briefing text; retries without web search if search is not available. */
function writeBriefing_(today, history) {
  const apiKey = getProp_('ANTHROPIC_API_KEY');
  const model = getProp_('BRIEFING_MODEL') || BRIEFING_MODEL_DEFAULT;
  const recent = history.length
    ? history.map(function (h) { return '[' + h.date + ']\n' + h.text; }).join('\n\n')
    : '(none yet)';
  const request = function (withSearch) {
    const body = {
      model: model,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      system: BRIEFING_PROMPT + '\n\nRecent briefings (do not repeat):\n' + recent,
      messages: [{ role: 'user', content: 'Write the briefing for ' + today + '.' +
        (withSearch ? '' : ' Web search is unavailable today, so for part 2 write exactly "- Nothing big today. Back tomorrow!" and for part 3 write exactly "- Alerts are unavailable today. Please check PAGASA and local news."') }],
    };
    if (withSearch) body.tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }];
    // Server-side search can pause a long turn; resume by sending the paused turn back.
    for (let i = 0; i < 3; i++) {
      const res = postToClaude_(apiKey, body, false);
      if (res.code !== 200) return { error: res.code + ': ' + res.text.slice(0, 300) };
      const msg = JSON.parse(res.text);
      if (msg.stop_reason === 'pause_turn') {
        body.messages = body.messages.concat([{ role: 'assistant', content: msg.content }]);
        continue;
      }
      if (msg.stop_reason === 'refusal') return { error: 'refusal' };
      const text = (msg.content || []).filter(function (b) { return b.type === 'text'; })
        .map(function (b) { return b.text; }).join('').trim();
      return text ? { text: text } : { error: 'empty reply' };
    }
    return { error: 'search did not finish' };
  };

  let result = request(true);
  if (result.error) {
    console.warn('Briefing with web search failed (' + result.error + '); retrying without search.');
    result = request(false);
  }
  if (result.error) throw new Error('Could not write the briefing: ' + result.error);
  return result.text;
}

/**
 * Preview: writes today's briefing and sends it ONLY to the admin's private chat
 * with Ask INAVA (Script Property ADMIN_EMAIL). Nothing is posted to any space,
 * and it is not remembered as a real briefing. Run it from the Apps Script editor.
 */
function previewMorningBriefing() {
  resetMemo_();
  const admin = findUser_(getProp_('ADMIN_EMAIL'));
  if (!admin || !admin.dmSpace) throw new Error('Send Ask INAVA a direct message first, from ' + getProp_('ADMIN_EMAIL') + '.');
  const tz = Session.getScriptTimeZone();
  const body = writeBriefing_(Utilities.formatDate(new Date(), tz, 'EEEE, d MMMM yyyy'), loadBriefingHistory_());
  postCard_(admin.dmSpace, 'Preview · Good morning, team! · ' + Utilities.formatDate(new Date(), tz, 'EEEE, d MMMM'), body);
  console.log('Preview sent to your private chat with Ask INAVA:\n\n' + body);
}

function loadBriefingHistory_() {
  try {
    return JSON.parse(getProp_('BRIEFING_HISTORY') || '[]');
  } catch (e) {
    return [];
  }
}

function saveBriefingHistory_(history, date, text) {
  const h = history.concat([{ date: date, text: text }]).slice(-BRIEFING_HISTORY_DAYS);
  setProp_('BRIEFING_HISTORY', JSON.stringify(h));
}

// The part of the monthly reminder that never changes (the AI writes only the opener above it).
const MONTHLY_REMINDER_LINE = 'Questions about INAVA policies or a concern at work? Just message me, Ask INAVA, anytime. DM me for anything private.';
const MONTHLY_REMINDER_FALLBACK = 'Hi team! 👋 ' + MONTHLY_REMINDER_LINE;
const MONTHLY_HISTORY_MONTHS = 12;

const MONTHLY_PROMPT = [
  'You write the opener of a once-a-month post by Ask INAVA, the AI assistant of I Need A VA (INAVA), in the Google Chat group chats of INAVA\'s virtual assistants (VAs). VAs are remote, mostly Filipino, supporting US small businesses. A fixed reminder line about asking Ask INAVA questions is added under your opener, so do not write a reminder or a call to action yourself.',
  '',
  'Write ONE opener of 1 or 2 short sentences, at most 35 words, in English. Rotate between three kinds and do not use the same kind as last month: "Happy <Month>, team!" with a light line about the month; a "Did you know" fact; or a practical VA tip (one specific, useful habit or tool trick for remote VAs, for example a Gmail, Google Calendar, Canva or Chrome shortcut, or a client-communication habit), said with the same light wit.',
  '- Witty and genuinely funny in a light, dry, friendly way, like a clever coworker. Not cringe: no forced puns stacked together, no "hustle", "slay", "vibes", "grind" or corporate buzzwords, no ALL CAPS, at most 2 emojis, at most one exclamation mark.',
  '- Good material: something true and widely known about the month (seasons, well-known holidays in the Philippines or the US, the "ber" months, rainy season, New Year), relatable remote-work moments (muted mics, 47 browser tabs, coffee, the Wi-Fi betraying you), or the month as a fresh start.',
  '- A "Did you know" must be a fact you are certain is true and widely known. Never invent facts, numbers, dates or statistics. Nothing about INAVA policies, pay, leave, bonuses or rules.',
  '- No politics, religion beyond a simple holiday greeting, tragedies, weather warnings, or anything that could make someone feel left out or teased.',
  '- Plain text only, no markdown, no quotation marks around it.',
].join('\n');

/** The month's reminder text: your own MONTHLY_REMINDER_TEXT, or the AI opener + MONTHLY_REMINDER_LINE. */
function monthlyReminderText_(monthName, save) {
  const own = String(getProp_('MONTHLY_REMINDER_TEXT') || '').trim();
  if (own) return own;
  let history = [];
  try { history = JSON.parse(getProp_('MONTHLY_REMINDER_HISTORY') || '[]'); } catch (e) { history = []; }
  let opener = '';
  try {
    opener = writeMonthlyOpener_(monthName, history);
  } catch (e) {
    console.warn('Monthly opener could not be written (' + e + '); using the standard reminder.');
    return MONTHLY_REMINDER_FALLBACK;
  }
  if (save) {
    setProp_('MONTHLY_REMINDER_HISTORY', JSON.stringify(history.concat([{ month: monthName, text: opener }]).slice(-MONTHLY_HISTORY_MONTHS)));
  }
  return opener + '\n\n' + MONTHLY_REMINDER_LINE;
}

function writeMonthlyOpener_(monthName, history) {
  const recent = history.length ? history.map(function (h) { return '- ' + h.month + ': ' + h.text; }).join('\n') : '(none yet)';
  const res = postToClaude_(getProp_('ANTHROPIC_API_KEY'), {
    model: getProp_('BRIEFING_MODEL') || BRIEFING_MODEL_DEFAULT,
    max_tokens: 2000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: MONTHLY_PROMPT + '\n\nRecent openers (do not repeat their hook or joke):\n' + recent,
    messages: [{ role: 'user', content: 'Write the opener for ' + monthName + '.' }],
  }, false);
  if (res.code !== 200) throw new Error(res.code + ': ' + String(res.text).slice(0, 200));
  const msg = JSON.parse(res.text);
  const text = (msg.content || []).filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; }).join(' ').replace(/\s+/g, ' ').replace(/^["“]|["”]$/g, '').trim();
  if (!text || msg.stop_reason === 'refusal') throw new Error('empty or refused');
  // A runaway answer is not posted.
  if (text.split(' ').length > 60) throw new Error('too long');
  return text;
}

/** Sends this month's kind of reminder to your private chat with Ask INAVA, to see the tone. Posts nothing in group chats. */
function previewMonthlyReminder() {
  resetMemo_();
  const admin = findUser_(getProp_('ADMIN_EMAIL'));
  if (!admin || !admin.dmSpace) throw new Error('Send Ask INAVA a direct message first, from ' + getProp_('ADMIN_EMAIL') + '.');
  const text = monthlyReminderText_(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMMM yyyy'), false);
  postMessage_(admin.dmSpace, '(Preview of the monthly reminder)\n\n' + text);
  console.log('Preview sent to your private chat with Ask INAVA:\n\n' + text);
}

/**
 * Posts the monthly reminder in every approved space with Monthly Reminder = YES. dailyMorning
 * calls it on the first Wednesday of the month; run it by hand to post it now. The month's text is
 * written once and kept, and each space gets it at most once a month, however often this runs.
 */
function postMonthlyReminder() {
  resetMemo_();
  ensureColumns_(SHEETS.SPACES);
  if (String(getProp_('MONTHLY_REMINDER_TEXT') || '').trim().toLowerCase() === 'off') return;
  const tz = Session.getScriptTimeZone();
  const month = Utilities.formatDate(new Date(), tz, 'yyyy-MM');
  const spaces = readTable_(SHEETS.SPACES).filter(function (r) {
    return isYes_(r['Approved']) && isYes_(r['Monthly Reminder']) && !isYes_(r['Team Inbox']);
  });
  if (!spaces.length) return;
  // Written once per month: a re-run posts the same text (and Chat refuses the duplicate).
  let text = getProp_('MONTHLY_REMINDER_' + month);
  if (!text) {
    text = monthlyReminderText_(Utilities.formatDate(new Date(), tz, 'MMMM yyyy'), true);
    setProp_('MONTHLY_REMINDER_' + month, text);
  }
  spaces.forEach(function (r) {
    const space = String(r['Space ID']).trim();
    try {
      postMessage_(space, text, null, clientMessageId_('reminder-' + month + '-' + shortHash_(space)));
      audit_({ space: space, action: 'MONTHLY_REMINDER', detail: month });
    } catch (e) {
      console.error('Monthly reminder for ' + space + ' failed: ' + e);
    }
  });
}

/**
 * Last month in numbers, for the team inbox only (first Wednesday of the month, with the reminder):
 * how many check-ins sorted things without the team, off-topic requests, and the AI cost of chat
 * answers (from the Audit Log). Run it by hand to see it now; it is posted at most once a month.
 */
function postMonthlySummary() {
  resetMemo_();
  const space = teamInbox_();
  if (!space) return;
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const month = Utilities.formatDate(last, tz, 'yyyy-MM');
  const inMonth = function (d) {
    const t = d instanceof Date ? d : (d ? new Date(d) : null);
    return !!t && !isNaN(t.getTime()) && Utilities.formatDate(t, tz, 'yyyy-MM') === month;
  };

  const tickets = readTickets_().filter(function (t) { return inMonth(t.updated || t.created); });
  const sortedByVa = tickets.filter(function (t) { return /Resolved by VA: [^\n]*not passed to the team/.test(t.history); }).length;
  const autoClosed = tickets.filter(function (t) { return /Closed automatically: no reply/.test(t.history); }).length;
  const passedOn = tickets.filter(function (t) { return /Passed to the team: they still needed help/.test(t.history); }).length;

  const audit = readTable_(SHEETS.AUDIT).filter(function (r) { return inMonth(r['Time']); });
  const offTopic = audit.filter(function (r) { return r['Action'] === 'OFF_TOPIC'; });
  const offTopicPeople = offTopic.map(function (r) { return r['Email']; }).filter(function (e, i, a) { return a.indexOf(e) === i; }).length;
  const alerts = audit.filter(function (r) { return r['Action'] === 'OFF_TOPIC_ALERT'; }).length;
  let cost = 0, answered = 0;
  audit.forEach(function (r) {
    if (r['Action'] !== 'ANSWERED') return;
    answered++;
    const m = String(r['Detail'] || '').match(/~\$([\d.]+)/);
    if (m) cost += Number(m[1]);
  });

  const body = [
    'Check-ins: ' + sortedByVa + ' sorted without the team (the VA said it was fixed), ' + passedOn + ' passed on after the check-in, ' +
      autoClosed + ' closed after no reply.',
    'Off-topic requests: ' + offTopic.length + ' from ' + offTopicPeople + (offTopicPeople === 1 ? ' person' : ' people') +
      (alerts ? ' (' + alerts + (alerts === 1 ? ' heads-up' : ' heads-ups') + ' sent)' : '') + '.',
    'AI cost: about $' + cost.toFixed(2) + ' for ' + answered + ' answers (chat only; the morning briefing adds a few cents a day).',
  ].join('\n\n');
  postCard_(space, 'Monthly summary: ' + Utilities.formatDate(last, tz, 'MMMM yyyy'), body, clientMessageId_('summary-' + month));
  audit_({ space: space, action: 'MONTHLY_SUMMARY', detail: month });
}

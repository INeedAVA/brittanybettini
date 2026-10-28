/**
 * Morning briefing: once a day, a short post in the space(s) marked
 * Morning Briefing = YES in the Spaces tab: a quote, a practical VA tip,
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
  'Write four short parts, in this order, as plain text with no headings or markdown:',
  '1. A line starting "💬 " with one genuine, well-known quote and the real person who said it. Only use a quote you are confident is real and correctly attributed; never invent or misattribute one.',
  '2. A line starting "💡 VA tip: " with one specific, practical tip a VA can use today (a shortcut, a template idea, a tool feature, a client-communication habit). One or two sentences.',
  '3. A line "🔥 Trending for VAs:" followed by 2 or 3 lines starting "- ", each one current item about apps, AI tools or software that matters to VAs (a new feature, launch, update or useful change from the last two weeks). Use web search to find them. Each line: what it is and why a VA would care, in one sentence, then the source in brackets, e.g. (source: zapier.com). Only include items you found in search results; if you cannot find any, write "- Nothing big today. Back tomorrow!"',
  '',
  '4. A line "🌏 PH & US alerts:" followed by up to 3 lines starting "- ", only about the Philippines or the USA, only current events (last 48 hours) that could affect VAs or their US clients: typhoons, storms, floods, earthquakes, volcanic activity, major power or internet outages, work or class suspensions, or major holidays. Use web search. Each line: place, what is happening, and a practical note if useful (e.g. "charge your laptop and keep a backup connection ready"), then the source in brackets. Calm and factual, never alarming or graphic. No politics, crime or celebrity news. If there is nothing significant, write "- No major alerts today. Stay safe!"',
  '',
  'Tone: warm, upbeat and encouraging, like a team lead starting the day; calm and caring in the alerts. Keep the whole briefing under 190 words. Do not repeat any quote, tip or news item from the recent briefings listed below (repeat an alert only if it is still ongoing, and say so).',
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
        (withSearch ? '' : ' Web search is unavailable today, so for part 3 write exactly "- Nothing big today. Back tomorrow!" and for part 4 write exactly "- Alerts are unavailable today. Please check PAGASA and local news."') }],
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

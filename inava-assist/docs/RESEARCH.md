# Google Chat API: what it can do, what it can't, and what needs admin approval

Checked on 27 October 2026 against Google's developer documentation and Google's official
Apps Script Chat samples (`googleworkspace/google-chat-samples`, last updated March 2026).
Google's documentation site could not be opened directly from my build environment, so these
points come from search results that quote the docs, plus the official sample code. The two
points I could not fully confirm are marked **verify**. Each one is covered by a step in the
test plan.

## 1. How a Chat app receives messages

| Situation | What Google sends the bot | Source |
|---|---|---|
| Direct message (1:1) with the bot | **Every** message | [Chat codelab](https://developers.google.com/codelabs/chat-apps-script) |
| Shared space, someone **@mentions** the bot | That message only | same |
| Shared space, ordinary messages with no @mention | **Nothing**, unless you set up event subscriptions (section 4) | [Workspace Events API scopes](https://developers.google.com/workspace/events/guides/auth) |
| Bot added to or removed from a space | An "added" or "removed" event | Official samples |

So the bot stays quiet in normal conversation by design. It only sees what it is tagged in,
plus its own direct messages.

## 2. Reply time limit

- Google Chat waits **30 seconds** for a reply. After that the person sees "not responding".
  ([Send messages](https://developers.google.com/workspace/add-ons/chat/send-messages))
- If a reply takes longer, the app has to post it separately through the Chat API using its own
  credentials ("app authentication", scope `chat.bot`).
- **What INAVA Assist does:** it answers directly when it can. If Claude takes longer than about
  24 seconds, it posts the answer through the Chat API in the same thread. Claude runs at "low"
  effort by default to keep answers fast.

## 3. Private notifications to Cyn, Mabelle, Verge and payroll

- A bot can post into a **direct message that already exists** between it and a person, using
  `chat.bot` app authentication. `spaces.findDirectMessage` finds that DM, and returns 404 if none exists.
  ([findDirectMessage](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces/findDirectMessage))
- A bot **cannot start** a new DM with `chat.bot` alone. Creating spaces as the app needs the
  `chat.app.spaces.create` scope, which needs **administrator approval**. `spaces.setup` only
  works with a signed-in user's credentials.
  ([Authentication](https://developers.google.com/workspace/chat/authenticate-authorize),
  [spaces.setup](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces/setup))
- **What INAVA Assist does:** each person who receives notifications sends INAVA Assist one
  message, for example "hi". The bot saves that DM and uses it for every notification after that.
  No admin approval is needed. `checkSetup()` tells you who hasn't done this yet.

## 4. Watching messages that don't @mention the bot (not in version 1)

- This works through the **Google Workspace Events API**: a subscription that streams a space's
  message events to Google Cloud Pub/Sub.
- Per-space subscriptions as the app use the `chat.app.messages.readonly` scope, which needs
  **one-time administrator approval**.
- Organisation-wide subscriptions use `chat.app.all.messages.readonly`. These cover every space
  without adding the bot to each one, and also need administrator approval plus service-account
  setup. ([Events API release notes](https://developers.google.com/workspace/events/release-notes),
  [Create a subscription](https://developers.google.com/workspace/events/guides/create-subscription))
- Google's own sample "issue-management-app / 3-message-monitoring" shows the per-space pattern
  in Apps Script.
- **Recommendation:** leave this out of version 1. Reading everyone's untagged messages raises
  privacy and consent questions, adds cost, and needs Pub/Sub. If you want it later, start with
  one internal space, tell the people in it, and only flag clear concerns. Never reply
  automatically to untagged messages. **Verify** in the Admin console that the scope approval is
  available for your Workspace edition.

## 5. Does the Workspace administrator need to approve the bot?

For **version 1, no scope approval is needed.** The bot only uses `chat.bot`. Three admin
settings can still block it, so check them:

1. **Chat apps allowed for users.** Admin console > Apps > Google Workspace > Google Chat >
   Chat apps. If installing Chat apps is restricted, add INAVA Assist to the allowlist. If you
   are the Workspace super admin, you can do this yourself.
2. **Service account keys.** Google Cloud organisations created after early 2024 block new
   service account keys by default (policy `iam.disableServiceAccountKeyCreation`). If key
   creation fails in setup step 4, an Organization Policy Administrator has to allow keys for the
   `inava-assist` project only.
3. **External clients (verify before any client rollout).** Google limits how Chat apps behave
   with people outside your organisation, and admins can set separate rules for external spaces.
   Test with one external test account, never a real client, before you plan any client-facing
   use. If clients can't use the bot, INAVA Assist still works for VAs, HR and management, and
   clients can be served through a VA.

You would need admin approval later for: monitoring untagged messages (section 4), and letting
the bot start DMs or create spaces itself (`chat.app.spaces.create`).

## 6. Apps Script: limits that matter

- **An Apps Script Chat app runs as the person messaging it.** Each person authorises the bot
  once, through a "requires configuration" card in Chat.
  ([Authorization scopes](https://developers.google.com/apps-script/concepts/scopes),
  [Granular OAuth for Chat apps](https://developers.google.com/workspace/chat/authenticate-authorize-granular-oauth-permissions))
  If the bot read the control sheet with that person's identity, every VA and client would need
  access to the sheet. **What INAVA Assist does:** it asks people for only one permission,
  "connect to an external service". It reads and writes the sheet and documents through the
  Sheets and Drive APIs **as its service account**, and only the service account and you can
  open them. **Verify** during testing that the configuration prompt shows only that one
  permission.

- Runs on Google's servers 24/7. Your computer can be off.
- Each run can last up to 6 minutes. The hourly reminder job is well within that.
- URL Fetch and trigger quotas are generous for a team of INAVA's size.
- There is no official Anthropic SDK for Apps Script, so the bot calls the Claude API over
  HTTPS with `UrlFetchApp`.
- Google's official Apps Script Chat samples still use the "classic" Chat event format. Google
  also offers Chat apps "built as Google Workspace add-ons", which use a different event format.
  INAVA Assist understands **both**, so either setting in the Chat API configuration works.

## 7. Claude API settings used

| Setting | Value | Why |
|---|---|---|
| Model | `claude-opus-5-5` | Anthropic's current default model. Change it with Script Property `CLAUDE_MODEL`. |
| Effort | `low` | Keeps replies inside Chat's 30-second window. Change it with `CLAUDE_EFFORT`. |
| Structured output | JSON schema | The reply, the escalation decision, the category and the priority always come back in a fixed shape. |
| Prompt caching | On (knowledge base) | Repeat questions within 5 minutes reuse the cached documents, which is about 20x cheaper for that part. |
| Refusal fallback | `fallbacks: "default"` (beta) | If Claude's safety filter declines a harmless request, Anthropic retries it on another model. Turn it off with `CLAUDE_FALLBACKS = off`. |
| API version | `2026-10-21` | Current version. |

**Rough cost:** Opus 5.5 is $4 per million input tokens and $20 per million output tokens. A
question costs roughly **$0.01-$0.12**, depending on how large the knowledge base is and
whether it's cached. Set a monthly spending limit in the Anthropic Console.

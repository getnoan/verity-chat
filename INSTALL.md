# Install — written for your coding agent

Hand this file to Claude Code (or any coding agent) in a clone of this repo and say
"install this for me". Steps marked **HUMAN** need the person; everything else the agent
runs and verifies itself.

What you are deploying: a grounded chat service for YOUR website. Its brain is facts in
your NOAN workspace (persona, playbook, and the blocks it is allowed to answer from), so
it only says what your fact layer says. It streams answers, shows visitors an honest
trace of which facts it read, files support cases as tasks, and writes a wrap-up memo to
the visitor's contact when they leave. The embed is ONE script tag; the service serves it
itself at /widget.js, so your site never needs a build step.

## 0. Prove the shell locally (no keys, ~1 minute)

```bash
NODE_ENV=test node -e "const { server } = await import('./site-web/server.mjs'); server.listen(8674, () => console.log('up'));"
```

VERIFY: `curl -s http://127.0.0.1:8674/healthz` prints `ok`, and http://127.0.0.1:8674/widget-demo
shows a stand-in page with the chat launcher bottom-right. The panel opens and asks for an
email; replies need the keys below.

## 1. HUMAN — keys

- A NOAN workspace + API key (https://app.getnoan.com → Settings → API keys) → `NOAN_AGENT_API_KEY`
- An Anthropic API key (https://console.anthropic.com) → `ANTHROPIC_API_KEY`

## 2. The brain — three facts in your workspace

```bash
NOAN_AGENT_API_KEY=... node agents/seed-site-chat.mjs
```

It creates three blocks in a "Site Chat Config" stack of their own (kept apart from any other
agent's instructions: anyone on the internet can type into this chat) and prints their slugs:

- **Site Chat Agent Config** → `SITE_CHAT_CONFIG_BLOCK_SLUG`: audiences, grounding, support
  cases, guardrails. This fact IS the assistant's procedure; edit it any time, no deploy.
- **Site Chat Playbook** → `SITE_CHAT_PLAYBOOK_BLOCK_SLUG`: tone, format, length.
- **Site Chat Pause Switch** → `SITE_CHAT_PAUSE_BLOCK_SLUG`: first word "paused" takes the
  chat offline without a deploy.

Re-running the seed never overwrites a fact that exists. The text is a STARTER: read it in
the NOAN app and make it yours (it mentions a booking link and support by email — say what
yours are, or take those lines out).

Then pick the blocks it may answer FROM: `SITE_CHAT_GROUNDING_SLUGS` is a comma-separated
list of block slugs (pricing, product, FAQs — whatever a visitor should get straight
answers about). The service refuses to boot un-instructed rather than answer from general
knowledge.

VERIFY: service log says "brain loaded from facts" after step 4.

## 3. Spend and abuse ceilings (already on — know the numbers)

- `SITE_DAILY_BUDGET_USD` (default 20): at the cap the chat stops replying until
  midnight UTC and emails `ESCALATE_TO` if set. Worst case per day = this number.
- Conversations are capped at 40 visitor turns; identity rides a signed token
  (`SESSION_SECRET`); writes only ever go to the token's own contact.
- The budget is metered in Supabase, and it FAILS CLOSED: until it can read today's spend,
  the chat refuses every message. **HUMAN:** create a project at https://supabase.com (free
  tier is fine) and run `schema.sql` once (SQL Editor → paste → Run, or
  `psql "$DATABASE_URL" -f schema.sql`) to create the `api_usage` table; the agent sets
  `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (the service_role key, never anon).
- To run uncapped instead, set `SITE_BUDGET_UNMETERED=1` (the boot log says so loudly), or
  `SITE_DAILY_BUDGET_USD=0`. Neither is recommended on a public site.

VERIFY: the boot log's model line reads `budget $20/day, metered`. Anything starting `!!`
means the cap is not doing what you think.

## 4. Deploy (Render blueprint — the blessed path)

Fork or push this repo to your GitHub → Render → New → Blueprint → pick the repo. Fill the
env when prompted. `SITE_ALLOWED_ORIGINS` = your website's origins, comma-separated
(e.g. https://www.yourcompany.com,https://yourcompany.com) — the chat API answers no other
origin.

VERIFY: `curl -s https://<render-url>/healthz` prints `ok`;
`https://<render-url>/widget-demo` chats end to end.

## 5. Embed — one line on your site

```html
<script src="https://<your-service>/widget.js" async
        data-name="Assistant" data-accent="#0e7a68"
        data-greeting="Ask me anything about what we do."></script>
```

Works on any stack — Webflow, WordPress, Next, hand-written HTML. No build step, no npm
package; the deployed service serves the embed, so updating the service updates the
widget everywhere.

VERIFY: open your site, click the launcher, ask something your grounding facts answer.

## 6. Optional

- `RESEND_API_KEY` + `MAIL_FROM` + `ESCALATE_TO`: budget alerts by email.
- `SITE_LEAD_TAG_ID`: tag new chat contacts as leads in your workspace.
- `SITE_HUMAN_ASSIGNEE_ID` / `SITE_SALES_ASSIGNEE_ID`: the NOAN identity ids that own
  routed follow-ups (general / sales). Unset, those tasks are filed with no assignee.
- `SITE_CHAT_MANUAL_STACK_SLUG`: a stack whose blocks ground SUBSCRIBER conversations
  (support answers); `SITE_SUBSCRIBER_TAG_ID` marks who counts as a subscriber.

## What you got

A support and sales assistant on your own domain that only speaks your verified facts,
shows its grounding to the visitor, files real support cases into your workspace, and
leaves a memo on the contact after every conversation — with the spend capped by a number
you chose.

Exported from getnoan/agents @ a70dfb6.

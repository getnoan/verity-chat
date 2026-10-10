@AGENTS.md

# verity-chat

Open-source, self-hosted chat widget for a company website: a Node 22 service with no dependencies and no build step. It answers only from NOAN facts with Claude, streams replies, files support cases as NOAN tasks and writes a wrap-up memo to the visitor's contact. It serves its own embed at `/widget.js`. Users deploy it to Render from `render.yaml` (the Dockerfile works on any other host).

| Path | Purpose |
| --- | --- |
| `site-web/` | HTTP server, chat logic, budget gate, signed visitor token, wrap-up, `widget.js` |
| `agents/` | Shared modules (NOAN client, Anthropic client, usage log, Resend), seed script, tests |
| `schema.sql` | The `api_usage` table the daily budget reads, run once by self-hosters in Supabase |
| `scripts/check-provenance.mjs` | CI check that a PR only edits files the export keeps |

## Generated export

- **Only `README.md`, `LICENSE` and `SECURITY.md` belong to this repo.** Every other file, this one included, is copied from a private upstream repo, and the next export deletes any change to it. Make changes upstream.
- PRs from `export/*` branches carry the upstream copy and skip the provenance check.

## Security

- **`/contact`, `/chat` and `/chat-end` are public and spend the operator's Anthropic key.** Keep the daily budget (`site-web/budget.mjs`) failing closed: if it cannot read today's spend, it refuses every message.
- **Every NOAN write takes the contact from the signed token** (`site-web/site-token.mjs`), never from a contact id in the request body.
- CORS headers allow only `SITE_ALLOWED_ORIGINS`. They don't stop a caller outside a browser, so a write still needs the signed token.
- Visitor messages are untrusted: they land in NOAN memos and tasks that agents read. The brain answers only from the configured grounding blocks.
- Secrets come from env only: `NOAN_AGENT_API_KEY`, `ANTHROPIC_API_KEY`, `SESSION_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`. In `render.yaml` a secret is `sync: false` or `generateValue: true`, never a `value:`.
- Workspace ids (tags, assignees) come from env only. Never ship one as a default.

## What writes where

- Supabase `api_usage`: one row per model call, written by `agents/usage-log.mjs`.
- NOAN, through `site-web/server.mjs` and `site-web/site-wrapup.mjs`: find or create the visitor contact, add memos, create tasks and link their tags, assignees and contact.
- `agents/seed-site-chat.mjs` creates the "Site Chat Config" stack and three config facts, and never overwrites an existing fact.

## schema.sql

- **Self-hosters already ran this file.** Changes stay additive and idempotent: `create ... if not exists`, `add column if not exists`. Never rename or drop a column, and never change a type.
- A new column the service writes must be nullable, so a deploy works before the user runs the new SQL.
- INSTALL.md must tell users when to run `schema.sql` again.

## Public repo

- Anyone can read every file, commit, PR and CI log.
- No keys, tokens, customer data, real emails or hostnames, internal repo names or names of people. Use `example.com` addresses.

## Tests and CI

- Tests are plain Node scripts, `agents/test-*.mjs`, with no network.
- CI (`.github/workflows/ci.yml`) runs `node --check` on every `.mjs` and `.js`, every test, then boots the server with `NODE_ENV=test` and checks `/healthz`, `/widget.js` and `/widget-demo`. On PRs it also runs the provenance check.

## Commands

```bash
for t in agents/test-*.mjs; do node "$t" || break; done                    # all tests
for f in $(find site-web agents scripts -name '*.mjs' -o -name '*.js'); do node --check "$f"; done   # syntax check

# local run with no keys: serves /healthz, /widget.js and /widget-demo, replies need keys
NODE_ENV=test node -e "const { server } = await import('./site-web/server.mjs'); server.listen(8674, () => console.log('up'));"
```

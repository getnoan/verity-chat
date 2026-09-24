-- The spend ledger the daily budget reads: run once in the Supabase SQL editor (or psql)
-- before the first deploy. Idempotent. Without it the budget cannot meter, and the chat
-- refuses every message rather than run uncapped.
create table if not exists public.api_usage (
  id                 bigint generated always as identity primary key,
  at                 timestamptz not null default now(),
  agent              text not null,
  action             text not null default '',
  provider           text not null,
  model              text,
  input_tokens       bigint,
  output_tokens      bigint,
  cache_read_tokens  bigint,
  cache_write_tokens bigint,
  units              numeric,
  cost_usd           numeric(12,6) not null default 0,
  run_id             text
);
create index if not exists api_usage_at_idx       on public.api_usage (at);
create index if not exists api_usage_agent_at_idx on public.api_usage (agent, at);
alter table public.api_usage enable row level security;

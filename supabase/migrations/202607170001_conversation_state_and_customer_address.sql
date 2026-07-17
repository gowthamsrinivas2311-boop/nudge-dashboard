alter table public.customers
add column if not exists address text;

create table if not exists public.conversation_state (
  phone text primary key,
  step text not null,
  partial_data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists conversation_state_updated_at_idx
on public.conversation_state (updated_at desc);

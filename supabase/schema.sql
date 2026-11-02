-- Local Listings: one row per account with that person's shows and subscriptions.
-- Paste this into Supabase → SQL Editor → New query, then tap Run.

create table if not exists public.lineups (
  user_id uuid primary key references auth.users (id) on delete cascade,
  shows jsonb not null default '[]'::jsonb,
  subs jsonb,
  updated_at timestamptz not null default now()
);

alter table public.lineups enable row level security;

drop policy if exists "read own lineup" on public.lineups;
drop policy if exists "add own lineup" on public.lineups;
drop policy if exists "change own lineup" on public.lineups;
drop policy if exists "delete own lineup" on public.lineups;

create policy "read own lineup" on public.lineups
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "add own lineup" on public.lineups
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "change own lineup" on public.lineups
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "delete own lineup" on public.lineups
  for delete to authenticated using ((select auth.uid()) = user_id);

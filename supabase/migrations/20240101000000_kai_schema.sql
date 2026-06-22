-- KAI Brain — complete schema
-- Run this once in Supabase SQL editor if tables don't exist

-- Chats
create table if not exists kai_chats (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'Chat',
  starred boolean default false,
  created_at timestamptz default now()
);

-- Messages
create table if not exists kai_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid references kai_chats(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null default '',
  meta jsonb default '{}',
  feedback integer,
  created_at timestamptz default now()
);
create index if not exists kai_messages_chat_id on kai_messages(chat_id);
create index if not exists kai_messages_created on kai_messages(created_at);

-- Notes / memory
create table if not exists kai_notes (
  id uuid primary key default gen_random_uuid(),
  fact text not null,
  created_at timestamptz default now()
);

-- Lessons (learned from feedback)
create table if not exists kai_lessons (
  id uuid primary key default gen_random_uuid(),
  lesson text not null,
  source text default 'feedback',
  importance float default 0.5,
  created_at timestamptz default now()
);

-- Settings (active provider, etc.)
create table if not exists kai_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz default now()
);
insert into kai_settings(key,value) values ('active_provider','or_openrouter_free')
  on conflict(key) do nothing;

-- Projects (KAI Computer)
create table if not exists kai_projects (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  goal text,
  status text default 'idle',
  current_step integer default 0,
  plan jsonb default '[]',
  files jsonb default '{}',
  log jsonb default '[]',
  created_at timestamptz default now()
);

-- Storage bucket for images/artifacts
insert into storage.buckets (id, name, public)
values ('kai-artifacts', 'kai-artifacts', true)
on conflict (id) do nothing;

-- Allow public read on kai-artifacts
create policy if not exists "kai-artifacts public read"
  on storage.objects for select
  using (bucket_id = 'kai-artifacts');

create policy if not exists "kai-artifacts service write"
  on storage.objects for insert
  with check (bucket_id = 'kai-artifacts');

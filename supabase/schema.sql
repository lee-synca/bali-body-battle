-- Bali Body Battle: database setup
-- Paste this whole file into Supabase > SQL Editor > New query, then press Run.
-- Safe to run once on a fresh project.

-- ============ Tables ============
create table public.competitions (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  code          text not null unique,
  entry_fee     int  not null default 50,
  start_date    date not null,            -- week 0 weigh-in (a Sunday)
  weeks         int  not null default 10, -- final weigh-in = start_date + weeks*7
  reveal_time   time not null default '19:00',
  tz            text not null default 'Australia/Melbourne',
  team_goal     numeric not null default 8,
  created_at    timestamptz not null default now()
);

create table public.players (
  id             uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  name           text not null check (char_length(name) between 1 and 20),
  emoji          text not null default '🌴',
  joined_week    int  not null default 0,
  is_admin       boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (competition_id, user_id)
);

create table public.weighins (
  player_id  uuid not null references public.players(id) on delete cascade,
  week       int  not null,
  weight     numeric(5,1) not null check (weight between 30 and 300),
  updated_at timestamptz not null default now(),
  primary key (player_id, week)
);

create table public.posts (
  id             uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  player_id      uuid not null references public.players(id) on delete cascade,
  body           text not null check (char_length(body) between 1 and 200),
  created_at     timestamptz not null default now()
);

-- post_key is 'p:<post id>' for messages, or a key for an automatic post such as 'r:6' (week 6 results)
create table public.reactions (
  competition_id uuid not null references public.competitions(id) on delete cascade,
  post_key       text not null,
  player_id      uuid not null references public.players(id) on delete cascade,
  emoji          text not null,
  primary key (post_key, player_id, emoji)
);

create table public.challenge_days (
  player_id uuid not null references public.players(id) on delete cascade,
  week      int not null,
  day       smallint not null check (day between -1 and 6), -- -1 = joined the challenge
  primary key (player_id, week, day)
);

create table public.push_subscriptions (
  endpoint   text primary key,
  player_id  uuid not null references public.players(id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  prefs      jsonb not null default '{"weigh":true,"results":true,"overtake":true,"badges":true,"countdown":true,"banter":false}',
  created_at timestamptz not null default now()
);

create table public.notification_log (
  key     text primary key,  -- stops the same scheduled notification going out twice
  sent_at timestamptz not null default now()
);

-- ============ Helpers ============
-- Week number whose results have been revealed (-1 = nothing revealed yet)
create or replace function public.revealed_week(c public.competitions) returns int
language sql stable as $$
  select coalesce(max(k), -1)::int from generate_series(0, c.weeks) k
  where ((c.start_date + k*7) + c.reveal_time) at time zone c.tz <= now();
$$;

-- Week currently open for weigh-ins (null once the final reveal has happened)
create or replace function public.open_week(c public.competitions) returns int
language sql stable as $$
  select case when public.revealed_week(c) >= c.weeks then null else public.revealed_week(c) + 1 end;
$$;

create or replace function public.my_player(comp uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select id from players where competition_id = comp and user_id = auth.uid();
$$;

create or replace function public.is_member(comp uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from players where competition_id = comp and user_id = auth.uid());
$$;

-- ============ Row level security ============
alter table public.competitions       enable row level security;
alter table public.players            enable row level security;
alter table public.weighins           enable row level security;
alter table public.posts              enable row level security;
alter table public.reactions          enable row level security;
alter table public.challenge_days     enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_log   enable row level security;

create policy "members read competition" on public.competitions for select using (public.is_member(id));
create policy "members read players"     on public.players for select using (public.is_member(competition_id));
create policy "update own profile"       on public.players for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Weights: you can only ever read your own. Everyone else's only reach you as percentages via leaderboard().
create policy "read own weights" on public.weighins for select
  using (player_id in (select id from public.players where user_id = auth.uid()));

create policy "members read posts" on public.posts for select using (public.is_member(competition_id));
create policy "post as yourself"   on public.posts for insert with check (player_id = public.my_player(competition_id));
create policy "delete own posts"   on public.posts for delete using (player_id = public.my_player(competition_id));

create policy "members read reactions" on public.reactions for select using (public.is_member(competition_id));
create policy "react as yourself"      on public.reactions for insert with check (player_id = public.my_player(competition_id));
create policy "remove own reaction"    on public.reactions for delete using (player_id = public.my_player(competition_id));

create policy "members read challenge" on public.challenge_days for select
  using (player_id in (select p.id from public.players p where public.is_member(p.competition_id)));
create policy "tick own challenge" on public.challenge_days for insert
  with check (player_id in (select id from public.players where user_id = auth.uid()));
create policy "untick own challenge" on public.challenge_days for delete
  using (player_id in (select id from public.players where user_id = auth.uid()));

create policy "own push subscriptions" on public.push_subscriptions for all
  using (player_id in (select id from public.players where user_id = auth.uid()))
  with check (player_id in (select id from public.players where user_id = auth.uid()));
-- notification_log: no policies, so only the server can touch it.

-- ============ Actions the app calls ============
create or replace function public.join_competition(p_code text, p_name text, p_emoji text, p_weight numeric)
returns uuid language plpgsql security definer set search_path = public as $$
declare c competitions; pid uuid; jw int;
begin
  if auth.uid() is null then raise exception 'Please sign in first.'; end if;
  select * into c from competitions where upper(code) = upper(trim(p_code));
  if c.id is null then raise exception 'That join code doesn''t match. Check the invite.'; end if;
  if p_weight is null or p_weight < 30 or p_weight > 300 then raise exception 'Enter your starting weight in kilograms.'; end if;
  if public.revealed_week(c) >= c.weeks - 1 then raise exception 'Sorry, joining has closed for this battle.'; end if;
  select id into pid from players where competition_id = c.id and user_id = auth.uid();
  if pid is not null then return c.id; end if;
  jw := greatest(public.revealed_week(c), 0);
  insert into players (competition_id, user_id, name, emoji, joined_week)
    values (c.id, auth.uid(), trim(p_name), coalesce(nullif(p_emoji,''), '🌴'), jw) returning id into pid;
  insert into weighins (player_id, week, weight) values (pid, jw, round(p_weight, 1));
  return c.id;
end $$;

-- Logs (or corrects) your weight for the open week. Returns your private % change for the week.
create or replace function public.log_weight(p_comp uuid, p_weight numeric)
returns numeric language plpgsql security definer set search_path = public as $$
declare c competitions; pid uuid; jw int; wk int; prev numeric;
begin
  select * into c from competitions where id = p_comp;
  select id, joined_week into pid, jw from players where competition_id = p_comp and user_id = auth.uid();
  if pid is null then raise exception 'You''re not in this battle yet.'; end if;
  if p_weight is null or p_weight < 30 or p_weight > 300 then raise exception 'Enter your weight in kilograms.'; end if;
  wk := public.open_week(c);
  if wk is null then raise exception 'The battle is over. No more weigh-ins.'; end if;
  if wk = jw then
    -- Before the first reveal you can still correct your starting weight
    update weighins set weight = round(p_weight,1), updated_at = now() where player_id = pid and week = jw;
    return 0;
  end if;
  insert into weighins (player_id, week, weight) values (pid, wk, round(p_weight,1))
    on conflict (player_id, week) do update set weight = excluded.weight, updated_at = now();
  select weight into prev from weighins where player_id = pid and week < wk order by week desc limit 1;
  return round((prev - p_weight) / prev * 100, 2);
end $$;

-- Everything the leaderboard needs, with weights converted to percentages.
-- Results for a week only appear after that week's 7pm reveal.
create or replace function public.leaderboard(p_comp uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c competitions; rw int; ow int;
begin
  if not public.is_member(p_comp) and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Not a member of this battle.';
  end if;
  select * into c from competitions where id = p_comp;
  rw := public.revealed_week(c); ow := public.open_week(c);
  return jsonb_build_object(
    'competition', to_jsonb(c),
    'now', now(),
    'revealed_week', rw,
    'open_week', ow,
    'me', public.my_player(p_comp),
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'emoji', p.emoji, 'joined_week', p.joined_week, 'is_admin', p.is_admin,
        'weighed_open', ow is not null and exists(select 1 from weighins w where w.player_id = p.id and w.week = ow and ow > p.joined_week),
        'weeks', coalesce((
          select jsonb_agg(jsonb_build_object('week', s.k, 'total', s.total, 'change', s.change) order by s.k)
          from (
            select k,
              round((base.weight - lk.weight) / base.weight * 100, 3) as total,
              case when k > p.joined_week and cur.weight is not null and prv.weight is not null
                   then round((prv.weight - cur.weight) / prv.weight * 100, 3) end as change
            from generate_series(p.joined_week, rw) k
            cross join lateral (select weight from weighins where player_id = p.id and week = p.joined_week) base
            cross join lateral (select weight from weighins where player_id = p.id and week <= k order by week desc limit 1) lk
            left join lateral (select weight from weighins where player_id = p.id and week = k) cur on true
            left join lateral (select weight from weighins where player_id = p.id and week < k order by week desc limit 1) prv on true
          ) s
        ), '[]'::jsonb)
      ) order by p.created_at)
      from players p where p.competition_id = p_comp
    ), '[]'::jsonb)
  );
end $$;

revoke execute on function public.leaderboard(uuid) from anon;
revoke execute on function public.join_competition(text,text,text,numeric) from anon;
revoke execute on function public.log_weight(uuid,numeric) from anon;

-- ============ The Bali Body Battle itself ============
-- Week 0 = Sunday 11 Oct 2026, final weigh-in (week 10) = Sunday 20 Dec 2026, results at 7pm Melbourne time.
insert into public.competitions (name, code, entry_fee, start_date, weeks, reveal_time, tz, team_goal)
values ('Bali Body Battle', 'BALI-2026', 50, '2026-10-11', 10, '19:00', 'Australia/Melbourne', 8);

// Bali Body Battle push notifications.
// - Called every hour by pg_cron with {type:"tick"} and the x-cron-secret header: sends reminders, results and countdowns.
// - Called by the app with {type:"weighed"} or {type:"post"} (signed-in user): tells everyone else.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;
webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

type Sub = { endpoint: string; player_id: string; p256dh: string; auth: string; prefs: Record<string, boolean> };
type Wk = { week: number; total: number; change: number | null };
type Pl = { id: string; name: string; emoji: string; joined_week: number; weighed_open: boolean; weeks: Wk[] };

async function subsFor(compId: string): Promise<Sub[]> {
  const { data } = await db.from("push_subscriptions").select("*, players!inner(competition_id)").eq("players.competition_id", compId);
  return (data ?? []) as Sub[];
}
async function send(sub: Sub, title: string, body: string, tag: string) {
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify({ title, body, tag }), { TTL: 6 * 3600 });
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    if (code === 404 || code === 410) await db.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
  }
}
async function once(key: string): Promise<boolean> {
  const { error } = await db.from("notification_log").insert({ key });
  return !error; // duplicate key = already sent
}
const ordinal = (n: number) => n + (["th", "st", "nd", "rd"][((n % 100) - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
function standings(players: Pl[], k: number) {
  return players.filter((p) => p.joined_week <= k)
    .map((p) => ({ p, total: [...p.weeks].reverse().find((w) => w.week <= k)?.total ?? 0 }))
    .sort((a, b) => b.total - a.total || a.p.name.localeCompare(b.p.name))
    .map((x, i) => ({ ...x, rank: i + 1 }));
}
function localParts(tz: string) {
  const f = new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "short", hour: "numeric", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" });
  const o = Object.fromEntries(f.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { weekday: o.weekday, hour: Number(o.hour), date: `${o.year}-${o.month}-${o.day}` };
}

async function tick() {
  const { data: comps } = await db.from("competitions").select("*");
  for (const c of comps ?? []) {
    const { data: lb } = await db.rpc("leaderboard", { p_comp: c.id });
    if (!lb) continue;
    const players = lb.players as Pl[];
    const rw: number = lb.revealed_week, ow: number | null = lb.open_week;
    const subs = await subsFor(c.id);
    const t = localParts(c.tz);
    const final = new Date(c.start_date + "T00:00:00Z"); final.setUTCDate(final.getUTCDate() + c.weeks * 7);
    const today = new Date(t.date + "T00:00:00Z");
    const daysLeft = Math.round((final.getTime() - today.getTime()) / 864e5);
    const openDate = ow == null ? null : (() => { const d = new Date(c.start_date + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + ow * 7); return d.toISOString().slice(0, 10); })();

    // Weigh-in day reminders (only for weeks after the start)
    if (ow != null && ow > 0 && openDate === t.date) {
      const inCount = players.filter((p) => p.weighed_open).length;
      if (t.hour === 8 && await once(`weigh_am:${c.id}:${ow}`)) {
        await Promise.all(subs.filter((s) => s.prefs.weigh).map((s) =>
          send(s, ow === c.weeks ? "🏁 Final weigh-in day!" : "⏰ Weigh-in day!", `${inCount ? inCount + " already stepped on the scales. " : ""}Results at 7pm.`, "weigh")));
      }
      if (t.hour === 17 && await once(`weigh_pm:${c.id}:${ow}`)) {
        const notIn = new Set(players.filter((p) => !p.weighed_open && p.joined_week < ow).map((p) => p.id));
        await Promise.all(subs.filter((s) => s.prefs.weigh && notIn.has(s.player_id)).map((s) =>
          send(s, "⏳ 2 hours left", "You haven't weighed in yet. Results are revealed at 7pm.", "weigh")));
      }
    }

    // Results (fires on the first tick after the 7pm reveal)
    if (rw >= 1 && await once(`results:${c.id}:${rw}`)) {
      const now = standings(players, rw), before = standings(players, rw - 1);
      const win = players.map((p) => ({ p, w: p.weeks.find((x) => x.week === rw)?.change })).filter((x) => x.w != null)
        .sort((a, b) => (b.w as number) - (a.w as number))[0];
      const isFinal = rw === c.weeks;
      await Promise.all(subs.map((s) => {
        const me = now.find((x) => x.p.id === s.player_id); if (!me) return;
        const was = before.find((x) => x.p.id === s.player_id)?.rank;
        if (isFinal) return send(s, "🏆 The final results are in!", `${now[0].p.name} wins Bali Body Battle. You finished ${ordinal(me.rank)}. Open the app for the big reveal.`, "results");
        if (s.prefs.overtake && was && me.rank > was) {
          const above = now.find((x) => x.rank === me.rank - 1)!;
          return send(s, "🔥 You've been passed", `${above.p.name} just jumped ahead of you into ${ordinal(above.rank)}.`, "results");
        }
        if (s.prefs.results) return send(s, `🏆 Week ${rw} results are in!`, `${win ? win.p.name + " takes the crown 👑. " : ""}You're ${ordinal(me.rank)} of ${now.length}.`, "results");
      }));
    }

    // Countdown to the final weigh-in
    if ([30, 14, 7, 1].includes(daysLeft) && t.hour === 9 && await once(`countdown:${c.id}:${daysLeft}`)) {
      await Promise.all(subs.filter((s) => s.prefs.countdown).map((s) =>
        send(s, "🌴 Bali countdown", daysLeft === 1 ? "Final weigh-in is tomorrow. Make it count!" : `${daysLeft} days until the final weigh-in.`, "countdown")));
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const body = await req.json().catch(() => ({}));

  if (body.type === "tick") {
    if (req.headers.get("x-cron-secret") !== CRON_SECRET) return json({ error: "forbidden" }, 403);
    await tick();
    return json({ ok: true });
  }

  // App events: identify the signed-in user
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: u } = await db.auth.getUser(token);
  if (!u?.user) return json({ error: "sign in first" }, 401);
  const { data: me } = await db.from("players").select("*").eq("user_id", u.user.id).eq("competition_id", body.competition_id).single();
  if (!me) return json({ error: "not a player" }, 403);
  const others = (await subsFor(me.competition_id)).filter((s) => s.player_id !== me.id);

  if (body.type === "test") {
    const mine = (await subsFor(me.competition_id)).filter((s) => s.player_id === me.id);
    await Promise.all(mine.map((s) => send(s, "🔔 Notifications are on", "You'll hear about weigh-ins, results and anyone passing you.", "test")));
  } else if (body.type === "weighed") {
    const { data: lb } = await db.rpc("leaderboard", { p_comp: me.competition_id });
    const ps = (lb?.players ?? []) as Pl[];
    const ow = lb?.open_week;
    const n = ps.filter((p) => p.weighed_open).length, total = ps.filter((p) => p.joined_week < ow).length;
    if (await once(`weighed:${me.id}:${ow}`)) {
      await Promise.all(others.filter((s) => s.prefs.weigh).map((s) =>
        send(s, "Bali Body Battle", `${me.emoji} ${me.name} just weighed in. ${n} of ${total} are in.`, "weighed")));
    }
  } else if (body.type === "post") {
    const text = String(body.text ?? "").slice(0, 120);
    await Promise.all(others.filter((s) => s.prefs.banter).map((s) => send(s, `${me.emoji} ${me.name}`, text, "banter")));
  }
  return json({ ok: true });
});

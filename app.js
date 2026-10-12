/* Bali Body Battle: the real app. Data lives in Supabase; weights never leave the database except as percentages. */
const CFG = window.BBB_CONFIG;
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true } });

const DAY = 864e5;
const HEALTHY_MAX = 1.5;
const EMOJIS = ['🐒','🦜','🌴','🍍','🐠','🦀','🌞','🍹','🛵','🌊','🌺','🐢','🏄','🥥','🐬','🦩','🐙','🥭'];
const REACTS = ['👏','🔥','😂','😱','🍹'];
const CHALLENGES = ['', 'Drink 2 litres of water a day','No soft drink week','Take the stairs every chance','No snacks after 8pm','Veg with every meal','10,000 steps every day','No takeaway week','Dry week: no alcohol until Sunday','30 minutes of movement daily','Final push: no sugar till weigh-in'];
const BADGES = [
  {id:'first', i:'👣', n:'First Step',   d:'Logged a starting weight'},
  {id:'one',   i:'🌱', n:'1% Down',      d:'Lost 1% of starting weight'},
  {id:'five',  i:'🏅', n:'5% Club',      d:'Lost 5% of starting weight'},
  {id:'ten',   i:'🏆', n:'10% Legend',   d:'Lost 10% of starting weight'},
  {id:'fire',  i:'🔥', n:'On Fire',      d:'3 weeks of losses in a row'},
  {id:'come',  i:'💪', n:'Comeback Kid', d:'Lost after a gain week'},
  {id:'crown', i:'👑', n:'Crowned',      d:'Biggest loser of a week'},
  {id:'steady',i:'🐢', n:'Steady Eddie', d:'4 healthy-pace weeks'},
  {id:'attend',i:'📅', n:'Never Missed', d:'Every weigh-in, 4+ weeks'},
];

/* ===================== State ===================== */
let session = null, compId = null, LB = null, myWeights = [], posts = [], reactions = [], chalRows = [];
let pushOn = false, pushChecked = false, loadErr = '';
let ui = { screen:'loading', tab: ls('bbb-tab') || 'board', sheet:null, authMode:'join', pick:EMOJIS[0], err:'', busy:false, confirmBig:false, peek:false, editWeight:false };

function ls(k, v){ try{ if(v===undefined) return localStorage.getItem(k); localStorage.setItem(k, v); }catch(e){ return null; } }
const settings = Object.assign({ sound:true, weigh:true, results:true, overtake:true, badges:true, countdown:true, banter:false }, JSON.parse(ls('bbb-settings') || '{}'));
const saveSettings = () => ls('bbb-settings', JSON.stringify(settings));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/* ===================== Competition maths ===================== */
const C = () => LB.competition;
const R = () => LB.revealed_week;          // last revealed week (-1 before the first reveal)
const O = () => LB.open_week;              // week open for weigh-ins (null when finished)
const finished = () => R() >= C().weeks;
const players = () => LB.players;
const P = id => players().find(p => p.id === id);
const me = () => P(LB.me);
function weekDate(k){ const [y,m,d] = C().start_date.split('-').map(Number); return new Date(y, m-1, d + 7*k); }
function revealDate(k){ const d = weekDate(k); const [h,mi] = C().reveal_time.split(':').map(Number); d.setHours(h, mi, 0, 0); return d; }
const fmtDay = d => d.toLocaleDateString('en-AU', { weekday:'short', day:'numeric', month:'short' });
const fmtWhen = d => d.toLocaleString('en-AU', { weekday:'short', day:'numeric', month:'short', hour:'numeric', minute:'2-digit' });
const revealLabel = () => { const [h,mi] = C().reveal_time.split(':').map(Number); return `${h%12||12}${mi?':'+String(mi).padStart(2,'0'):''}${h<12?'am':'pm'}`; };
function daysToFinal(){ const t = new Date(); t.setHours(0,0,0,0); return Math.max(0, Math.round((weekDate(C().weeks) - t) / DAY)); }
const pot = () => players().length * C().entry_fee;

function entryAt(p, k){ let e = null; for(const w of p.weeks){ if(w.week <= k) e = w; } return e; }
const total = (p, k = R()) => Number(entryAt(p, k)?.total ?? 0);
function change(p, k){ const w = p.weeks.find(x => x.week === k); return w && w.change != null ? Number(w.change) : null; }
function standings(k = R()){
  const kk = Math.max(k, 0);
  return players().filter(p => p.joined_week <= kk)
    .map(p => ({ p, total: total(p, k) }))
    .sort((a,b) => b.total - a.total || a.p.name.localeCompare(b.p.name))
    .map((x,i) => ({ ...x, rank: i+1 }));
}
function weekWinner(k){ let best = null; players().forEach(p => { const w = change(p, k); if(w != null && (!best || w > best.w)) best = { p, w }; }); return best; }
function streak(p, upto = R()){ let n = 0; for(let k = upto; k > p.joined_week; k--){ const w = change(p, k); if(w != null && w > 0) n++; else break; } return n; }
function maxStreak(p, upto = R()){ let m = 0, n = 0; for(let k = p.joined_week+1; k <= upto; k++){ const w = change(p, k); if(w != null && w > 0){ n++; m = Math.max(m, n); } else n = 0; } return m; }
function crowns(p, upto = R()){ let n = 0; for(let k = 1; k <= upto; k++){ const ww = weekWinner(k); if(ww && ww.p.id === p.id) n++; } return n; }
function earned(p, upto = R()){
  const t = total(p, upto), out = new Set(['first']);
  if(t >= 1) out.add('one'); if(t >= 5) out.add('five'); if(t >= 10) out.add('ten');
  if(maxStreak(p, upto) >= 3) out.add('fire');
  let steady = 0, missed = false, weeks = 0;
  for(let k = p.joined_week+1; k <= upto; k++){
    weeks++;
    const w = change(p, k), pw = k-1 > p.joined_week ? change(p, k-1) : null;
    if(w == null) missed = true;
    if(w != null && w > 0 && pw != null && pw <= 0) out.add('come');
    if(w != null && w >= 0.5 && w <= HEALTHY_MAX) steady++;
  }
  if(steady >= 4) out.add('steady');
  if(!missed && weeks >= 4) out.add('attend');
  if(crowns(p, upto) > 0) out.add('crown');
  return out;
}
function teamPct(){ let s = 0, c = 0; players().forEach(p => { const base = 100, t = total(p); s += base; c += base - t; }); return s ? (s - c) / s * 100 : 0; }
const fmtPct = n => (Math.abs(n) < 0.005 ? 0 : n).toFixed(2);
const pctSigned = n => n == null ? '–' : (n > 0 ? '−' : n < 0 ? '+' : '±') + Math.abs(n).toFixed(2) + '%';
const ordinal = n => n + (['th','st','nd','rd'][(n%100-20)%10] || ['th','st','nd','rd'][n%100] || 'th');
const myWeightAt = k => myWeights.find(w => w.week === k)?.weight;
function myLastBefore(k){ let w = null; myWeights.forEach(x => { if(x.week < k) w = x; }); return w ? Number(w.weight) : null; }
const chalWeek = () => Math.min(Math.max(O() ?? C().weeks, 1), C().weeks);

/* ===================== Sound ===================== */
let AC = null, NB = null;
function ac(){ if(!settings.sound) return null; try{ if(!AC){ const K = window.AudioContext || window.webkitAudioContext; if(!K) return null; AC = new K(); } if(AC.state === 'suspended') AC.resume(); return AC; }catch(e){ return null; } }
function env(c, node, t, a, peak, d){ const g = c.createGain(); g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(peak, t+a); g.gain.exponentialRampToValueAtTime(.0001, t+a+d); node.connect(g); g.connect(c.destination); }
function osc(c, type, f, t, a, peak, d){ const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); env(c, o, t, a, peak, d); o.start(t); o.stop(t+a+d+.05); }
function noise(c, t, dur, peak, ft, freq, q = 1){ if(!NB){ NB = c.createBuffer(1, c.sampleRate*2, c.sampleRate); const d = NB.getChannelData(0); for(let i = 0; i < d.length; i++) d[i] = Math.random()*2-1; } const s = c.createBufferSource(); s.buffer = NB; const f = c.createBiquadFilter(); f.type = ft; f.frequency.value = freq; f.Q.value = q; s.connect(f); env(c, f, t, .003, peak, dur); s.start(t); s.stop(t+dur+.05); }
const SFX = {
  chaching(){ const c = ac(); if(!c) return; const t = c.currentTime+.02;
    noise(c,t,.05,.35,'bandpass',2800,2); noise(c,t+.06,.04,.25,'bandpass',4200,3);
    [[2637,0],[3951,0],[3136,.16],[4699,.16]].forEach(([f,o]) => { osc(c,'sine',f,t+.1+o,.004,.18,.9); osc(c,'triangle',f*2.01,t+.1+o,.004,.04,.4); });
    noise(c,t+.1,.5,.06,'highpass',7000); },
  trombone(){ const c = ac(); if(!c) return; const t = c.currentTime+.02;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1100; lp.connect(c.destination);
    [[233.1,0,.42],[220,.48,.42],[207.7,.96,.42],[196,1.44,1.3]].forEach(([f,o,d],i) => { const os = c.createOscillator(); os.type = 'sawtooth'; os.frequency.setValueAtTime(f, t+o);
      const g = c.createGain(); g.gain.setValueAtTime(.0001,t+o); g.gain.exponentialRampToValueAtTime(.14,t+o+.05); g.gain.setValueAtTime(.14,t+o+d-.1); g.gain.exponentialRampToValueAtTime(.0001,t+o+d);
      if(i === 3){ const l = c.createOscillator(), lg = c.createGain(); l.frequency.value = 5.5; lg.gain.value = 5; l.connect(lg); lg.connect(os.frequency); l.start(t+o+.25); l.stop(t+o+d); }
      os.connect(g); g.connect(lp); os.start(t+o); os.stop(t+o+d+.05); }); },
  tick(){ const c = ac(); if(!c) return; const t = c.currentTime+.01; osc(c,'triangle',880,t,.004,.16,.12); noise(c,t,.05,.12,'bandpass',180,1.2); },
  blip(){ const c = ac(); if(!c) return; osc(c,'sine',660,c.currentTime+.01,.005,.14,.18); },
  notify(){ const c = ac(); if(!c) return; const t = c.currentTime+.01; osc(c,'sine',1046.5,t,.005,.12,.22); osc(c,'sine',1568,t+.11,.005,.12,.35); },
  drumroll(sec){ const c = ac(); if(!c) return; const t = c.currentTime+.02; const n = Math.floor(sec/.045); for(let i = 0; i < n; i++) noise(c, t+i*.045+Math.random()*.006, .06, .05+.22*(i/n), 'bandpass', 1900, .8); },
  crash(){ const c = ac(); if(!c) return; const t = c.currentTime+.01; noise(c,t,1.6,.35,'highpass',5200); noise(c,t,.25,.4,'lowpass',160); },
  fanfare(){ const c = ac(); if(!c) return; const t = c.currentTime+.02;
    [[523.3,0,.14],[659.3,.13,.14],[784,.26,.14],[1046.5,.4,.9]].forEach(([f,o,d]) => { osc(c,'triangle',f,t+o,.01,.2,d); osc(c,'square',f,t+o,.01,.03,d*.7); });
    [523.3,659.3,784].forEach(f => osc(c,'triangle',f,t+.4,.02,.08,1.1)); },
};

/* ===================== Confetti ===================== */
const fx = document.getElementById('fx'), fxc = fx.getContext('2d');
let parts = [], fxRun = false;
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function confetti(n = 140, spread = 1){
  if(reduced()) return;
  const cs = getComputedStyle(document.documentElement);
  const cols = ['--hibiscus','--sunset','--gold','--lagoon','--yellow','--good'].map(v => cs.getPropertyValue(v).trim() || '#f0a');
  const dpr = Math.min(window.devicePixelRatio || 1, 2); fx.width = innerWidth*dpr; fx.height = innerHeight*dpr; fxc.setTransform(dpr,0,0,dpr,0,0);
  for(let i = 0; i < n; i++){ const a = -Math.PI/2 + (Math.random()-.5)*1.6*spread, v = 8+Math.random()*9;
    parts.push({ x:innerWidth/2+(Math.random()-.5)*80, y:innerHeight*.62, vx:Math.cos(a)*v, vy:Math.sin(a)*v, r:Math.random()*6, vr:(Math.random()-.5)*.4, w:6+Math.random()*6, h:8+Math.random()*8, c:cols[i%cols.length], s:Math.random()<.25?'o':'r', life:0 }); }
  if(!fxRun){ fxRun = true; requestAnimationFrame(stepFx); }
}
function stepFx(){
  fxc.clearRect(0,0,innerWidth,innerHeight);
  parts.forEach(p => { p.vy += .32; p.vx *= .99; p.vy *= .99; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.life++;
    fxc.save(); fxc.translate(p.x,p.y); fxc.rotate(p.r); fxc.fillStyle = p.c;
    if(p.s === 'o'){ fxc.beginPath(); fxc.arc(0,0,p.w/2,0,7); fxc.fill(); } else fxc.fillRect(-p.w/2,-p.h/4,p.w,p.h/2*Math.abs(Math.cos(p.life*.15))+1);
    fxc.restore(); });
  parts = parts.filter(p => p.y < innerHeight+40 && p.life < 400);
  if(parts.length) requestAnimationFrame(stepFx); else { fxRun = false; fxc.clearRect(0,0,innerWidth,innerHeight); }
}

/* ===================== In-app banners ===================== */
function toast(body, title = 'Bali Body Battle'){
  const box = document.getElementById('notifs');
  const el = document.createElement('div'); el.className = 'notif'; el.setAttribute('role','status');
  el.innerHTML = `<div class="app-ic">B</div><div><div class="nt"><b>${esc(title)}</b><span>now</span></div><p>${esc(body)}</p></div>`;
  box.prepend(el); SFX.notify();
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 350); };
  el.addEventListener('click', close); setTimeout(close, 5200);
}

/* ===================== Data ===================== */
async function loadAll(){
  const { data: mine, error } = await sb.from('players').select('competition_id').eq('user_id', session.user.id).limit(1);
  if(error) throw error;
  if(!mine.length){ ui.screen = 'join'; ui.authMode = 'join'; render(); return; }
  compId = mine[0].competition_id;
  await refresh();
  ui.screen = 'app'; render();
  checkPush();
  maybeAutoReveal();
}
async function refresh(){
  const [lb, w, ps, rx] = await Promise.all([
    sb.rpc('leaderboard', { p_comp: compId }),
    sb.from('weighins').select('week,weight').order('week'),
    sb.from('posts').select('*').eq('competition_id', compId).order('created_at', { ascending:false }).limit(150),
    sb.from('reactions').select('post_key,player_id,emoji').eq('competition_id', compId),
  ]);
  for(const r of [lb, w, ps, rx]) if(r.error) throw r.error;
  LB = lb.data; myWeights = w.data; posts = ps.data; reactions = rx.data;
  const ch = await sb.from('challenge_days').select('player_id,week,day').eq('week', chalWeek());
  chalRows = (ch.data || []).filter(r => P(r.player_id));
}
async function softRefresh(){ if(ui.screen !== 'app' || ui.busy) return; try{ await refresh(); if(!document.querySelector('.stage') && !ui.sheet && !document.activeElement?.matches('input,textarea')) render(); maybeAutoReveal(); }catch(e){} }
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') softRefresh(); });
setInterval(() => { if(document.visibilityState === 'visible') softRefresh(); }, 60000);

/* ===================== Render ===================== */
const root = document.getElementById('root');
const IC = {
  board:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>',
  weigh:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="4"/><path d="M8 10a4 4 0 0 1 8 0"/><path d="m12 10 1.5-2"/></svg>',
  banter:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/></svg>',
  me:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
};
function render(){
  if(ui.screen === 'loading'){ root.innerHTML = `<div class="loading"><div><h1 class="wordmark">Bali Body Battle</h1><p>${loadErr ? esc(loadErr) + '<br><br><button class="btn small" data-a="retry">Try again</button>' : 'Loading…'}</p></div></div>`; return; }
  if(ui.screen === 'auth' || ui.screen === 'join'){ root.innerHTML = authView() + (ui.sheet ? sheetView() : ''); return; }
  ls('bbb-tab', ui.tab);
  const needWeigh = O() != null && O() > me().joined_week && myWeightAt(O()) == null;
  root.innerHTML = `<div class="app">
    <header class="top">
      <h1 class="wordmark">Bali Body Battle</h1>
      <button class="icon-btn" data-a="sound" aria-label="${settings.sound?'Mute sound effects':'Turn on sound effects'}">${settings.sound?'🔊':'🔇'}</button>
    </header>
    <main class="view">${ ui.tab==='board'?boardView(): ui.tab==='weigh'?weighView(): ui.tab==='banter'?banterView(): meView() }</main>
    <nav class="tabs" aria-label="Sections">${tabBtn('board','Leaderboard')}${tabBtn('weigh','Weigh in',needWeigh)}${tabBtn('banter','Banter')}${tabBtn('me','Me')}</nav>
    ${ui.sheet ? sheetView() : ''}
  </div>`;
}
const tabBtn = (id, label, dot) => `<button class="tab" data-a="tab" data-v="${id}" ${ui.tab===id?'aria-current="page"':''}>${IC[id]}${label}${dot?'<i class="badge-dot"></i>':''}</button>`;

/* ---------- Sign up / log in ---------- */
function authView(){
  const signedIn = !!session;
  const join = ui.authMode === 'join' || signedIn;
  const code = (location.hash || '').replace('#','') || CFG.competitionCode || '';
  const install = isIOS() && !isStandalone() ? `<div class="install"><b>📲 Add to your Home Screen first</b><span>On iPhone, notifications only work when Bali Body Battle is opened from your Home Screen. Add it there, open it, then join.</span><button class="btn small" data-a="guide" style="align-self:flex-start">Show me how</button></div>` : '';
  return `<form class="join" id="authForm" novalidate>
    <div class="join-hero"><div style="font-size:44px">🌴</div><h1 class="wordmark">Bali Body Battle</h1><p>Ten weeks. One pot. Final weigh-in Sunday 20 December, then we fly.</p></div>
    ${install}
    ${signedIn ? '' : `<div class="seg" role="group"><button type="button" data-a="mode" data-v="join" aria-pressed="${join}">Join the battle</button><button type="button" data-a="mode" data-v="login" aria-pressed="${!join}">I've already joined</button></div>`}
    <div class="card">
      ${join ? `
        <label class="f" for="aCode">Join code<input class="input" id="aCode" autocomplete="off" autocapitalize="characters" value="${esc(code)}" placeholder="BALI-2026" style="font-family:var(--f-mono);letter-spacing:.06em"></label>
        <label class="f" for="aName">Your name (as the family knows you)<input class="input" id="aName" maxlength="20" autocomplete="nickname"></label>
        <div style="display:flex;flex-direction:column;gap:6px;font-weight:600;font-size:13.5px">Pick your avatar
          <div class="emoji-pick" role="group" aria-label="Avatar">${EMOJIS.map(e => `<button type="button" data-a="pick" data-v="${e}" aria-pressed="${ui.pick===e}">${e}</button>`).join('')}</div></div>` : ''}
      ${signedIn ? '' : `
        <label class="f" for="aEmail">Email<input class="input" id="aEmail" type="email" autocomplete="email" inputmode="email"></label>
        <label class="f" for="aPass">${join ? 'Make up a password (6+ characters)' : 'Password'}<input class="input" id="aPass" type="password" autocomplete="${join?'new-password':'current-password'}"></label>`}
      ${join ? `
        <label class="f" for="aWeight">Starting weight<div class="kg"><input class="input" id="aWeight" type="number" inputmode="decimal" step="0.1" min="30" max="300" placeholder="0.0"><span>kg</span></div></label>
        <div class="lock">🔒 <span>Nobody ever sees your weight. The app only shares the percentage you've lost. You can correct it until the first reveal on Sun 11 Oct, 7pm.</span></div>
        <label class="check" for="aPay"><input type="checkbox" id="aPay"> <span>I'm in for the <b>$50 entry</b> and will pay the organiser. Winner takes the whole pot.</span></label>` : ''}
      ${ui.err ? `<div class="err" role="alert">${esc(ui.err)}</div>` : ''}
      <button class="btn" type="submit" ${ui.busy?'disabled':''}>${ui.busy ? 'One sec…' : join ? 'Join the battle' : 'Log in'}</button>
      ${!join ? `<p class="muted" style="font-size:13px;margin:0">Forgot your password? Ask the organiser to reset it.</p>` : ''}
      ${signedIn ? `<button type="button" class="linkish" data-a="logout">Use a different account</button>` : ''}
    </div>
  </form>`;
}

/* ---------- Leaderboard ---------- */
function passView(){
  const team = teamPct(), pos = Math.min(team / C().team_goal, 1) * 100;
  return `<section class="pass" aria-label="Competition summary">
    <div class="pass-main"><div><div class="lbl">From</div><div class="code">HOME</div></div><div class="mid" aria-hidden="true">✈</div><div class="to"><div class="lbl">To · Denpasar</div><div class="code">DPS</div></div></div>
    <div class="pass-track" aria-hidden="true"><div class="rail"></div><div class="done" style="width:${pos}%"></div><div class="plane" style="left:clamp(10px,${pos}%,calc(100% - 10px))">✈️</div></div>
    <div class="pass-note">Team Bali has lost <b class="num">${fmtPct(team)}%</b> on average. Goal: ${C().team_goal}% by touchdown.</div>
    <div class="pass-stub">
      <div><div class="lbl">Prize pot</div><div class="v pot num">$${pot()}</div></div>
      <div><div class="lbl">Week</div><div class="v num">${finished() ? C().weeks : Math.max(O(),0)}/${C().weeks}</div></div>
      <div><div class="lbl">Final weigh-in</div><div class="v num">${finished() ? 'Done' : daysToFinal() + ' days'}</div></div>
    </div>
  </section>`;
}
function weekBanner(){
  if(finished()) return `<section class="week"><div class="week-head"><b>The battle is over 🌴</b><span>See you in Bali</span></div><button class="btn" data-a="final">Replay the final reveal</button></section>`;
  const k = O();
  if(k === 0) return `<section class="week">
    <div class="week-head"><b>Starting weigh-in</b><span>${esc(fmtDay(weekDate(0)))} · ${revealLabel()}</span></div>
    <div class="dots">${players().map(p => `<span class="dot in" title="${esc(p.name)}">${p.emoji}</span>`).join('')}</div>
    <div class="muted" style="font-size:13px"><b style="color:var(--ink)">${players().length} in so far.</b> Weigh yourself Sunday morning and correct your starting weight if you need to. Week 1 weigh-in is ${esc(fmtDay(weekDate(1)))}.</div>
    <button class="btn alt" data-a="copy">Copy the invite for the family chat</button></section>`;
  const eligible = players().filter(p => p.joined_week < k), inCount = eligible.filter(p => p.weighed_open).length;
  const yIn = myWeightAt(k) != null || me().joined_week >= k;
  return `<section class="week">
    <div class="week-head"><b>${k === C().weeks ? 'Final weigh-in' : 'Week ' + k + ' weigh-in'}</b><span>${esc(fmtDay(weekDate(k)))} · reveal ${revealLabel()}</span></div>
    <div class="dots" aria-label="${inCount} of ${eligible.length} weighed in">${eligible.map(p => `<span class="dot ${p.weighed_open?'in':''}" title="${esc(p.name)}">${p.emoji}</span>`).join('')}</div>
    <div class="muted" style="font-size:13px"><b style="color:var(--ink)">${inCount} of ${eligible.length}</b> weighed in. Results stay secret until ${revealLabel()} ${esc(fmtDay(weekDate(k)))}.</div>
    ${yIn ? `<div class="pill" style="align-self:flex-start">✓ You're locked in</div>` : `<button class="btn" data-a="tab" data-v="weigh">Weigh in now</button>`}
    ${R() >= 1 ? `<button class="linkish" data-a="replay" style="align-self:flex-start">Replay the Week ${R()} reveal</button>` : ''}
  </section>`;
}
/* Nudge anyone who hasn't turned notifications on, so they don't miss Sunday reminders */
function notifBanner(){
  if(!pushChecked || pushOn || ui.hideNotif || finished()) return '';
  const later = `<button class="linkish" data-a="hidenotif" style="align-self:flex-start;color:var(--pass-muted)">Not now</button>`;
  if(isIOS() && !isStandalone()) return `<div class="install"><b>🔔 Don't miss Sunday weigh-ins</b><span>Add Bali Body Battle to your Home Screen to get weigh-in reminders and results. Then open it from there and turn on notifications.</span><button class="btn small" data-a="guide" style="align-self:flex-start">Show me how</button>${later}</div>`;
  if(!pushSupported()) return '';
  if(Notification.permission === 'denied') return `<div class="install"><b>🔕 Notifications are blocked</b><span>To get weigh-in reminders and results, go to your phone's Settings → Notifications → Bali Battle and turn on Allow Notifications.</span>${later}</div>`;
  return `<div class="install"><b>🔔 Turn on notifications</b><span>Get a reminder on weigh-in mornings, the 7pm results, and a heads-up when someone passes you.</span><button class="btn small" data-a="enablepush" style="align-self:flex-start">Turn on notifications</button>${later}</div>`;
}
function boardView(){
  const st = standings(), prev = R() > 0 ? standings(R()-1) : [];
  const prevRank = Object.fromEntries(prev.map(x => [x.p.id, x.rank]));
  const started = R() >= 1, ww = started ? weekWinner(R()) : null;
  const n = st.length, lineAt = started && n >= 4 ? n-2 : -1;
  let rows = '';
  st.forEach((x, i) => {
    if(i === lineAt) rows += `<div class="yline" role="separator">Yellow line</div>`;
    const p = x.p, mv = prevRank[p.id] ? prevRank[p.id] - x.rank : 0, s = streak(p), wk = started ? change(p, R()) : null;
    const tags = `${ww && ww.p.id === p.id ? '<span title="Biggest loser of the week">👑</span>' : ''}${s >= 3 ? `<span title="${s} week streak">🔥${s}</span>` : ''}`;
    const sub = [ mv > 0 ? `<span class="mv up">▲${mv}</span>` : mv < 0 ? `<span class="mv down">▼${-mv}</span>` : '', O() != null && O() > 0 && p.weighed_open ? '✓ weighed in' : '', p.id === LB.me ? 'You' : '' ].filter(Boolean).join(' · ');
    const wkTxt = !started ? 'ready' : p.joined_week >= R() ? 'new' : wk == null ? 'missed wk ' + R() : pctSigned(wk) + ' wk';
    rows += `<button class="row r${started ? x.rank : 0} ${p.id === LB.me ? 'you' : ''} ${lineAt >= 0 && i >= lineAt ? 'below' : ''}" data-a="player" data-v="${p.id}">
      <span class="pos">${x.rank}</span><span class="ava">${p.emoji}</span>
      <span class="who"><b>${esc(p.name)} ${tags}</b><small>${sub || '&nbsp;'}</small></span>
      <span class="pct">${fmtPct(x.total)}<small>%</small><em>${wkTxt}</em></span></button>`;
  });
  const last = st[n-1];
  return `${notifBanner()}${passView()}${weekBanner()}
    <h2 class="sec">Leaderboard <small>${started ? 'after Week ' + R() + ' · ' : ''}% of starting weight lost</small></h2>
    <div class="board">${rows}</div>
    <p class="note">🍹 <b>Cocktail duty:</b> whoever finishes last buys the first round in Bali.${started && !finished() && last ? ` Right now that's <b>${esc(last.p.id === LB.me ? 'you' : last.p.name)}</b>.` : ''}</p>
    <section class="invite"><div><small>Invite family · they join themselves</small><div class="code">${esc(C().code)}</div></div><button class="btn small alt" data-a="copy">Copy invite</button></section>`;
}

/* ---------- Weigh in ---------- */
function weighView(){
  if(finished()) return `<div class="card center"><div style="font-size:48px">🏝️</div><h3>That's a wrap</h3><p class="muted">The final weigh-in is done. Pack the sunscreen.</p><button class="btn" data-a="final">See the final results</button></div>`;
  const k = O(), mine = me();
  const formFor = (title, sub, ph) => `<form class="card" id="weighForm" novalidate>
      <div><h3>${title}</h3><p class="muted" style="font-size:13.5px">${sub}</p></div>
      <label class="f" for="wIn">Today's weight<div class="kg"><input class="input" id="wIn" type="number" inputmode="decimal" step="0.1" min="30" max="300" placeholder="${ph}"><span>kg</span></div></label>
      ${ui.err ? `<div class="${ui.confirmBig ? 'warn' : 'err'}" role="alert">${esc(ui.err)}</div>` : ''}
      <button class="btn" type="submit" ${ui.busy?'disabled':''}>${ui.busy ? 'Saving…' : ui.confirmBig ? 'Yes, that’s right' : 'Lock it in'}</button>
    </form>`;
  if(k <= mine.joined_week){
    const base = myWeightAt(mine.joined_week);
    return `${formFor(k === 0 ? 'Starting weight' : 'You’re in!', `Your starting weight is <b>${base != null ? Number(base).toFixed(1) + ' kg' : '–'}</b> (only you can see this). You can correct it until ${revealLabel()} ${esc(fmtDay(weekDate(k)))}. Your first weigh-in is ${esc(fmtDay(weekDate(k+1)))}.`, base != null ? Number(base).toFixed(1) : '0.0')}
      <div class="note">🔔 Turn on notifications on the Me tab and we'll remind you on weigh-in mornings.</div>`;
  }
  const cur = myWeightAt(k), prev = myLastBefore(k);
  if(cur != null && !ui.editWeight){
    const w = (prev - cur) / prev * 100, flag = w > HEALTHY_MAX, cls = w > 0 ? 'loss' : w < 0 ? 'gain' : '';
    return `<div class="card center">
      <div class="muted" style="font-family:var(--f-mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase">${k === C().weeks ? 'Final weigh-in' : 'Week ' + k} · locked in</div>
      <div class="big-result ${cls} pop">${pctSigned(w)}</div>
      <p>${w > 0 ? (flag ? 'Big drop! Steady on, though.' : 'Nice work. That’s a loss.') : w < 0 ? 'Small gain this week. Plenty of time to bounce back.' : 'Holding steady.'}</p>
      ${flag ? `<div class="warn">More than ${HEALTHY_MAX}% in a week is fast. Make sure you're eating enough. Bali's not worth fainting at the airport.</div>` : ''}
      <p class="muted" style="font-size:13px">Only you can see this until the reveal at ${revealLabel()} ${esc(fmtDay(weekDate(k)))}. Everyone sees your new total then.</p>
      <button class="linkish" data-a="editweight">Made a mistake? Change it</button>
    </div>`;
  }
  return formFor(k === C().weeks ? 'Final weigh-in 🏁' : 'Week ' + k + ' weigh-in',
    `${esc(fmtDay(weekDate(k)))}. Weigh first thing in the morning, same scales, before breakfast. 🔒 Private: last time you logged <b>${prev != null ? prev.toFixed(1) + ' kg' : '–'}</b>.`,
    prev != null ? prev.toFixed(1) : '0.0');
}

/* ---------- Banter ---------- */
function feedItems(){
  const items = posts.map(p => ({ key:'p:' + p.id, pid:p.player_id, text:p.body, at:new Date(p.created_at), mine:p.player_id === LB.me, id:p.id }));
  for(let k = 1; k <= R(); k++){
    const win = weekWinner(k), st = standings(k), bottom = st.length >= 4 ? st.slice(-2).map(x => x.p.name) : [];
    items.push({ key:'r:' + k, sys:true, at:revealDate(k), text:`${k === C().weeks ? 'Final' : 'Week ' + k} results: ${win ? win.p.name + ' takes the crown 👑 with ' + win.w.toFixed(2) + '% lost.' : 'No one weighed in.'}${bottom.length ? ' Below the yellow line: ' + bottom.join(' and ') + '.' : ''}` });
    players().forEach(p => { if(p.joined_week >= k) return; const before = earned(p, k-1); [...earned(p, k)].filter(b => !before.has(b)).forEach(b => { const B = BADGES.find(x => x.id === b);
      items.push({ key:`b:${k}:${p.id}:${b}`, sys:true, at:new Date(revealDate(k).getTime() + 60000), text:`${p.name} earned ${B.n} ${B.i}.` }); }); });
  }
  return items.sort((a,b) => b.at - a.at);
}
function banterView(){
  const k = chalWeek(), joined = new Set(chalRows.filter(r => r.day === -1).map(r => r.player_id));
  const myDays = new Set(chalRows.filter(r => r.player_id === LB.me && r.day >= 0).map(r => r.day));
  const inIt = joined.has(LB.me), crew = [...joined].map(P).filter(Boolean);
  const days = ['M','T','W','T','F','S','S'];
  const counts = {}, mineR = new Set();
  reactions.forEach(r => { counts[r.post_key + r.emoji] = (counts[r.post_key + r.emoji] || 0) + 1; if(r.player_id === LB.me) mineR.add(r.post_key + r.emoji); });
  const feed = feedItems().map(f => {
    const p = f.pid ? P(f.pid) : null;
    const rx = REACTS.map(e => { const n = counts[f.key + e] || 0, m = mineR.has(f.key + e); return `<button class="react ${m?'mine':''}" data-a="react" data-v="${esc(f.key)}" data-e="${e}" aria-pressed="${m}">${e}${n ? `<span>${n}</span>` : ''}</button>`; }).join('');
    return `<article class="post ${f.sys?'sys':''}"><div class="ava">${f.sys ? '🏝' : p ? p.emoji : '🙂'}</div>
      <div style="min-width:0"><div class="meta"><b>${f.sys ? 'Battle HQ' : esc(p ? p.name : 'Someone')}</b><span>${esc(fmtWhen(f.at))}</span>${f.mine ? `<button class="linkish" style="margin-left:auto;font-size:12px;padding:0" data-a="delpost" data-v="${f.id}">Delete</button>` : ''}</div><p>${esc(f.text)}</p><div class="reacts">${rx}</div></div></article>`;
  }).join('');
  return `<section class="chal">
      <div class="lbl">Week ${k} mini-challenge · optional</div>
      <h3>${esc(CHALLENGES[k] || CHALLENGES[1])}</h3>
      ${inIt ? `<div class="days" role="group" aria-label="Days completed">${days.map((d,i) => `<button class="day ${myDays.has(i)?'on':''}" data-a="day" data-v="${i}" aria-pressed="${myDays.has(i)}">${d}</button>`).join('')}</div>`
             : `<button class="btn small" style="background:#fff;color:var(--lagoon);align-self:flex-start" data-a="joinchal">I'm in</button>`}
      <small>${crew.length ? crew.map(p => p.emoji).join(' ') + ' ' + crew.length + ' doing it this week' : 'Be the first to take it on'}${inIt ? ` · you've ticked off ${myDays.size} of 7 days` : ''}</small>
    </section>
    <form class="compose" id="postForm"><input class="input" id="postIn" maxlength="200" placeholder="Talk some trash…" autocomplete="off"><button class="btn small" type="submit">Post</button></form>
    <div class="feed">${feed || '<p class="note">No banter yet. Start it off.</p>'}</div>`;
}

/* ---------- Me ---------- */
function meView(){
  const m = me(), st = standings(), mine = st.find(x => x.p.id === m.id) || { rank:'–', total:0 }, got = earned(m);
  const start = myWeightAt(m.joined_week), latest = myWeights.length ? Number(myWeights[myWeights.length-1].weight) : null;
  const photo = ls('bbb-photo');
  const tg = (key, label, hint) => `<div class="toggle-row"><div>${label}<small>${hint}</small></div><button class="sw" data-a="set" data-v="${key}" aria-pressed="${!!settings[key]}" aria-label="${label}"></button></div>`;
  return `<section class="card">
      <div class="me-head"><div class="ava">${m.emoji}</div><div><h3>${esc(m.name)}</h3><div class="muted" style="font-size:13.5px">Joined ${m.joined_week === 0 ? 'at the start' : 'in Week ' + m.joined_week} · ${esc(session.user.email)}</div></div></div>
      <div class="stats"><div class="stat"><b>${mine.rank}<small style="font-size:12px">/${st.length}</small></b><small>Rank</small></div><div class="stat"><b>${fmtPct(mine.total)}%</b><small>Lost</small></div><div class="stat"><b>${streak(m)}${streak(m) >= 3 ? '🔥' : ''}</b><small>Week streak</small></div></div>
      <button class="btn alt small" data-a="peek" style="align-self:flex-start">${ui.peek ? 'Hide my kilos' : '🔒 Show my kilos (only you)'}</button>
      ${ui.peek && start != null ? `<div class="note num">Started <b>${Number(start).toFixed(1)} kg</b> · latest <b>${latest.toFixed(1)} kg</b> · down <b>${(start - latest).toFixed(1)} kg</b></div>` : ''}
    </section>
    <h2 class="sec">Badges <small>${got.size} of ${BADGES.length}</small></h2>
    <div class="badges">${BADGES.map(b => `<div class="badge ${got.has(b.id)?'':'locked'}"><i>${b.i}</i><b>${b.n}</b><small>${b.d}</small></div>`).join('')}</div>
    <h2 class="sec">Before &amp; after <small>private · this phone only</small></h2>
    <section class="card"><div class="photos">
        <label class="photo" for="photoIn">${photo ? `<img src="${photo}" alt="Your before photo">` : '＋ Add a before photo'}</label>
        <div class="photo">After photo unlocks<br>${esc(fmtDay(weekDate(C().weeks)))} 🏁</div></div>
      <input type="file" id="photoIn" accept="image/*" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none"></section>
    <h2 class="sec">Notifications <small>${pushOn ? 'on for this phone' : 'off'}</small></h2>
    <section class="card" style="gap:0">
      ${pushOn ? `<button class="btn alt small" data-a="testpush" style="margin-bottom:10px;align-self:flex-start">Send me a test notification</button>` : `<button class="btn" data-a="enablepush" style="margin-bottom:10px">🔔 Turn on notifications</button>`}
      ${tg('weigh','Weigh-in reminders','Sunday 8am, a 5pm nudge, and who’s weighed in')}
      ${tg('results','Results are in', 'Sunday ' + revealLabel() + ' reveal')}
      ${tg('overtake','Someone passes you','“Tom just jumped ahead of you”')}
      ${tg('countdown','Bali countdown','30, 14, 7 and 1 day to go')}
      ${tg('banter','Banter posts','Every new message in the feed')}
    </section>
    <details class="rules"><summary>How it works</summary><ol>
      <li>Everyone pays a $${C().entry_fee} entry to the organiser. Winner takes the whole pot ($${pot()} right now).</li>
      <li>Score = % of your own starting weight lost, so it's fair at any size.</li>
      <li>Weigh in every Sunday morning. You can change it until ${revealLabel()}, when results are revealed.</li>
      <li>Miss a weigh-in and your score stays where it was.</li>
      <li>Biggest % loss each week wears the 👑 for seven days.</li>
      <li>Bottom two on the leaderboard sit below the yellow line. It's just bragging rights.</li>
      <li>Weekly drops over ${HEALTHY_MAX}% get a "steady on" warning.</li>
      <li>Late joiners are measured from their own start.</li>
      <li>Final weigh-in ${esc(fmtDay(weekDate(C().weeks)))}. Last place buys the first round in Bali 🍹.</li>
    </ol></details>
    <button class="btn alt" data-a="logout">Log out</button>`;
}

/* ---------- Sheets ---------- */
function sheetView(){
  let inner = '';
  if(ui.sheet.type === 'player'){
    const p = P(ui.sheet.id), st = standings(), x = st.find(y => y.p.id === p.id) || { rank:'–', total:0 }, got = earned(p);
    let wk = ''; for(let k = R(); k > p.joined_week; k--){ const w = change(p, k), ww = weekWinner(k);
      wk += `<div><span>Week ${k} ${ww && ww.p.id === p.id ? '👑' : ''}</span><span>${w == null ? '<span class="muted">missed</span>' : `<b style="color:${w>0?'var(--good)':w<0?'var(--bad)':'var(--muted)'}">${pctSigned(w)}</b>${w > HEALTHY_MAX ? ' <span class="pill flag">steady on</span>' : ''}`}</span></div>`; }
    inner = `<div class="sheet-head"><div class="ava">${p.emoji}</div><div><h3>${esc(p.name)}${p.id === LB.me ? ' (you)' : ''}</h3><div class="muted" style="font-size:13.5px">Rank ${x.rank} of ${st.length} · ${crowns(p)} crown${crowns(p) === 1 ? '' : 's'} · streak ${streak(p)}</div></div><div class="big-result loss" style="font-size:30px">${fmtPct(x.total)}%</div></div>
      ${R() > p.joined_week ? chartSVG(p) : '<p class="note">Results start after the first weekly reveal.</p>'}
      <div class="badges">${BADGES.filter(b => got.has(b.id)).map(b => `<div class="badge"><i>${b.i}</i><b>${b.n}</b></div>`).join('')}</div>
      <div class="wk-list">${wk}<div><span>Start</span><span class="muted">${p.joined_week === 0 ? 'Week 0' : 'Joined Week ' + p.joined_week} · weight hidden</span></div></div>
      ${p.id === LB.me ? '' : `<div><div class="muted" style="font-size:13px;margin-bottom:6px">Send ${esc(p.name)} a reaction</div><div class="reacts">${REACTS.map(e => `<button class="react" style="font-size:20px;padding:6px 12px" data-a="cheer" data-v="${p.id}" data-e="${e}">${e}</button>`).join('')}</div></div>`}`;
  } else if(ui.sheet.type === 'guide'){
    inner = `<h3 style="margin:0;font-size:20px">Put it on your Home Screen</h3>
      <p class="muted" style="margin:0">On iPhone, notifications only work once the app is on your Home Screen (iOS 16.4 or later).</p>
      <ol class="steps">
        <li><div><b>Open the invite link in Safari</b><br><span class="muted">Not inside Messenger, Facebook or Instagram.</span></div></li>
        <li><div><b>Tap Share</b> <span aria-hidden="true">⬆️</span><br><span class="muted">The square with the arrow, at the bottom of the screen.</span></div></li>
        <li><div><b>Tap “Add to Home Screen”</b><br><span class="muted">Scroll down the list if you can't see it.</span></div></li>
        <li><div><b>Open Bali Body Battle from your Home Screen</b><br><span class="muted">Log in, go to Me, tap “Turn on notifications” and choose Allow.</span></div></li>
      </ol>`;
  }
  return `<div class="scrim" data-a="close"><div class="sheet" role="dialog" aria-modal="true" data-stop="1"><div class="grab"></div>${inner}<button class="btn alt" data-a="close">Close</button></div></div>`;
}
function chartSVG(p){
  const W = 340, H = 150, L = 36, Rr = 12, T = 12, B = 24, iw = W-L-Rr, ih = H-T-B, n = C().weeks;
  const pts = []; for(let k = p.joined_week; k <= R(); k++) pts.push([k, total(p, k)]);
  const mx = Math.max(4, Math.ceil(Math.max(...pts.map(x => x[1])) + 1));
  const X = k => L + k/n*iw, Y = v => T + ih - (Math.max(v,0)/mx)*ih;
  const line = pts.map((q,i) => `${i?'L':'M'}${X(q[0]).toFixed(1)},${Y(q[1]).toFixed(1)}`).join('');
  const area = `${line}L${X(pts[pts.length-1][0]).toFixed(1)},${Y(0)}L${X(pts[0][0]).toFixed(1)},${Y(0)}Z`, end = pts[pts.length-1];
  const grid = [0, mx/2, mx].map(v => `<line x1="${L}" x2="${W-Rr}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${L-6}" y="${Y(v)+4}" text-anchor="end" font-size="10" fill="var(--muted)">${v%1 ? v.toFixed(1) : v}%</text>`).join('');
  const xl = [[0,'Start'],[Math.round(n/2),'Wk ' + Math.round(n/2)],[n, fmtDay(weekDate(n)).replace(/^\w+ /,'')]].map(([k,t]) => `<text x="${X(k)}" y="${H-6}" text-anchor="${k===0?'start':k===n?'end':'middle'}" font-size="10" fill="var(--muted)">${t}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(p.name)}'s % lost by week">
    <defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--lagoon)" stop-opacity=".35"/><stop offset="1" stop-color="var(--lagoon)" stop-opacity="0"/></linearGradient></defs>
    ${grid}${xl}<line x1="${X(n)}" x2="${X(n)}" y1="${T}" y2="${T+ih}" stroke="var(--sunset)" stroke-dasharray="3 3"/>
    <path d="${area}" fill="url(#ga)"/><path d="${line}" fill="none" stroke="var(--lagoon)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${X(end[0])}" cy="${Y(end[1])}" r="5" fill="var(--lagoon)" stroke="var(--surface)" stroke-width="2"/></svg>`;
}

/* ===================== Reveal (plays the first time you open the app after 7pm Sunday) ===================== */
function maybeAutoReveal(){
  if(!LB || R() < 1 || document.querySelector('.stage')) return;
  const seen = Number(ls('bbb-seen-' + compId) ?? -1);
  if(seen >= R()) return;
  ls('bbb-seen-' + compId, String(R()));
  if(me().joined_week >= R()) return; // brand new players skip straight to the board
  runReveal(R());
}
async function runReveal(k){
  const results = players().filter(p => p.joined_week < k).map(p => ({ p, w: change(p, k) })).sort((a,b) => (a.w ?? -1e9) - (b.w ?? -1e9));
  const stage = document.createElement('div'); stage.className = 'stage'; stage.setAttribute('role','dialog'); stage.setAttribute('aria-modal','true');
  stage.innerHTML = `<div class="stage-in"><div class="kicker">${esc(fmtDay(weekDate(k)))} · ${revealLabel()}</div><h2>${k === C().weeks ? 'The Final Weigh-in' : 'Week ' + k + ' Results'}</h2><p class="sub">Biggest % loss this week, revealed from the bottom up</p>
    <button class="btn" id="rvGo">🥁 Start the reveal</button>
    <div id="rvList" style="display:flex;flex-direction:column-reverse;gap:8px;margin-top:6px"></div><div id="rvFoot" style="display:flex;flex-direction:column;gap:8px;margin-top:6px"></div></div>`;
  document.body.appendChild(stage);
  const list = stage.querySelector('#rvList'), foot = stage.querySelector('#rvFoot');
  // A tap is needed before sound can play on iPhone, so the reveal starts from a button.
  await new Promise(res => stage.querySelector('#rvGo').onclick = res);
  stage.querySelector('#rvGo').remove();
  foot.innerHTML = `<button class="btn alt" id="rvSkip">Skip to the winner</button>`;
  let skip = false; foot.querySelector('#rvSkip').onclick = () => { skip = true; };
  const wait = async ms => { const end = Date.now() + (reduced() ? Math.min(ms,150) : ms); while(Date.now() < end && !skip) await new Promise(r => setTimeout(r, 50)); };
  SFX.drumroll(1.6); await wait(1700);
  const n = results.length;
  for(let i = 0; i < n; i++){
    const r = results[i], isWin = i === n-1 && r.w != null;
    if(isWin && !skip){ const d = document.createElement('div'); d.className = 'drum'; d.textContent = '🥁'; list.prepend(d); SFX.drumroll(2.2); await wait(2300); d.remove(); }
    const flag = r.w != null && r.w > HEALTHY_MAX;
    const el = document.createElement('div'); el.className = 'rv' + (isWin ? ' win' : '');
    el.innerHTML = `<span class="pos">${isWin ? '👑' : n-i}</span><span class="ava">${r.p.emoji}</span><span><b>${esc(r.p.name)}</b><small>${r.w == null ? 'No weigh-in this week' : isWin ? 'Biggest loser of the week' : flag ? 'Steady on! That’s a big drop' : r.w < 0 ? 'Gained a little' : 'This week'}</small></span><span class="p ${r.w == null ? 'm' : r.w < 0 ? 'g' : ''}">${r.w == null ? 'missed' : pctSigned(r.w)}</span>`;
    list.appendChild(el);
    if(isWin){ SFX.crash(); SFX.fanfare(); confetti(180); } else { SFX.tick(); await wait(1000); }
  }
  const myNow = standings(k).find(x => x.p.id === LB.me), myWas = standings(k-1).find(x => x.p.id === LB.me);
  foot.innerHTML = k === C().weeks ? `<button class="btn" id="rvNext">And the Bali Body Battle champion is…</button>`
    : `<p class="sub">${myNow ? `You're <b style="color:#fff">${ordinal(myNow.rank)}</b> of ${standings(k).length}${myWas && myNow.rank < myWas.rank ? ', up ' + (myWas.rank - myNow.rank) + ' 🚀' : ''}.` : ''}</p><button class="btn" id="rvNext">See the leaderboard</button>`;
  foot.querySelector('#rvNext').onclick = () => { stage.remove(); if(k === C().weeks) showFinal(); else { ui.tab = 'board'; render(); } };
}
function showFinal(){
  const st = standings(), w = st[0], last = st[st.length-1];
  let big = null; players().forEach(p => { for(let k = 1; k <= R(); k++){ const v = change(p, k); if(v != null && (!big || v > big.v)) big = { p, v }; } });
  const mostC = players().map(p => ({ p, c:crowns(p) })).sort((a,b) => b.c - a.c)[0];
  const longS = players().map(p => ({ p, s:maxStreak(p) })).sort((a,b) => b.s - a.s)[0];
  const nm = x => x.p.id === LB.me ? 'You' : x.p.name;
  const pod = i => { const x = st[i]; if(!x) return '<div></div>'; return `<div class="pod p${i+1}"><div class="ava">${x.p.emoji}</div><b>${esc(nm(x))}</b><small>${fmtPct(x.total)}%</small><div class="blk">${i+1}</div></div>`; };
  const stage = document.createElement('div'); stage.className = 'stage'; stage.setAttribute('role','dialog'); stage.setAttribute('aria-modal','true');
  stage.innerHTML = `<div class="stage-in">
    <div class="kicker">${esc(fmtDay(weekDate(C().weeks)))} · Final results</div>
    <h2>${esc(w.p.id === LB.me ? 'You win' : w.p.name + ' wins')}<br>Bali Body Battle</h2>
    <div class="podium">${pod(1)}${pod(0)}${pod(2)}</div>
    <div class="potbig num">$${pot()}</div>
    <p class="sub">The whole pot goes to ${esc(w.p.id === LB.me ? 'you' : w.p.name)} for losing ${fmtPct(w.total)}% of their starting weight.</p>
    <div class="fstats">
      <div class="fstat"><small>Team Bali average</small><b>${fmtPct(teamPct())}% lost</b></div>
      <div class="fstat"><small>Most crowns</small><b>${mostC.p.emoji} ${esc(mostC.p.name)} · ${mostC.c}</b></div>
      <div class="fstat"><small>Biggest single week</small><b>${big ? `${big.p.emoji} ${esc(big.p.name)} · ${big.v.toFixed(2)}%` : '–'}</b></div>
      <div class="fstat"><small>Longest streak</small><b>${longS.p.emoji} ${esc(longS.p.name)} · ${longS.s} wks</b></div>
    </div>
    <div class="fstat" style="text-align:center;border-color:#F5BE4B88"><small>Cocktail duty 🍹</small><b>${esc(last.p.id === LB.me ? 'You buy' : last.p.name + ' buys')} the first round in Bali</b></div>
    <p class="sub">Screenshot this for the family chat 📸</p>
    <button class="btn" id="fClose">Close</button></div>`;
  document.body.appendChild(stage);
  stage.querySelector('#fClose').onclick = () => { stage.remove(); render(); };
  SFX.drumroll(1); setTimeout(() => { SFX.crash(); SFX.fanfare(); confetti(220, 1.3); setTimeout(() => confetti(140, 1.6), 900); }, reduced() ? 0 : 1000);
}

/* ===================== Push notifications ===================== */
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
function b64(s){ const p = '='.repeat((4 - s.length % 4) % 4), b = atob((s + p).replace(/-/g,'+').replace(/_/g,'/')); return Uint8Array.from([...b].map(c => c.charCodeAt(0))); }
const pushPrefs = () => ({ weigh:settings.weigh, results:settings.results, overtake:settings.overtake, badges:settings.badges, countdown:settings.countdown, banter:settings.banter });
async function checkPush(){
  pushChecked = true;
  if(!pushSupported() || Notification.permission !== 'granted') { pushOn = false; if(ui.tab === 'board' && !ui.sheet && !document.querySelector('.stage')) render(); return; }
  try{ const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); pushOn = !!sub;
    if(sub){ const j = sub.toJSON(); await sb.from('push_subscriptions').upsert({ endpoint:j.endpoint, player_id:LB.me, p256dh:j.keys.p256dh, auth:j.keys.auth, prefs:pushPrefs() }); }
    if(!document.querySelector('.stage') && !ui.sheet && !document.activeElement?.matches('input,textarea')) render(); }catch(e){}
}
async function enablePush(){
  if(!pushSupported()){ ui.sheet = { type:'guide' }; render(); return; }
  try{
    const perm = await Notification.requestPermission();
    if(perm !== 'granted'){ toast('Notifications are blocked. Turn them on in iPhone Settings > Notifications > Bali Body Battle.'); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if(!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:b64(CFG.vapidPublicKey) });
    const j = sub.toJSON();
    const { error } = await sb.from('push_subscriptions').upsert({ endpoint:j.endpoint, player_id:LB.me, p256dh:j.keys.p256dh, auth:j.keys.auth, prefs:pushPrefs() });
    if(error) throw error;
    pushOn = true; render(); SFX.chaching();
    sb.functions.invoke('notify', { body:{ type:'test', competition_id:compId } });
  }catch(e){ toast('Couldn’t turn on notifications: ' + (e.message || e)); }
}
async function savePrefs(){
  if(!pushOn) return;
  try{ const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if(sub) await sb.from('push_subscriptions').update({ prefs:pushPrefs() }).eq('endpoint', sub.endpoint); }catch(e){}
}

/* ===================== Events ===================== */
document.addEventListener('pointerdown', () => ac(), { once:true });
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-a]'); if(!t || t.closest('.stage')) return;
  if(t.dataset.a === 'close' && e.target.closest('[data-stop]') && !e.target.closest('button')) return;
  const a = t.dataset.a, v = t.dataset.v;
  try{
    switch(a){
      case 'retry': location.reload(); return;
      case 'mode': ui.authMode = v; ui.err = ''; render(); return;
      case 'pick': ui.pick = v; root.querySelectorAll('.emoji-pick button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === v)); return;
      case 'tab': ui.tab = v; ui.err = ''; ui.confirmBig = false; ui.editWeight = false; render(); window.scrollTo(0,0); return;
      case 'sound': settings.sound = !settings.sound; saveSettings(); render(); if(settings.sound) SFX.blip(); return;
      case 'player': ui.sheet = { type:'player', id:v }; render(); return;
      case 'close': ui.sheet = null; render(); return;
      case 'guide': ui.sheet = { type:'guide' }; render(); return;
      case 'set': settings[v] = !settings[v]; saveSettings(); t.setAttribute('aria-pressed', settings[v]); savePrefs(); return;
      case 'peek': ui.peek = !ui.peek; render(); return;
      case 'editweight': ui.editWeight = true; render(); return;
      case 'replay': runReveal(R()); return;
      case 'final': showFinal(); return;
      case 'enablepush': enablePush(); return;
      case 'hidenotif': ui.hideNotif = true; render(); return;
      case 'testpush': await sb.functions.invoke('notify', { body:{ type:'test', competition_id:compId } }); toast('Test sent. It should land in a few seconds.'); return;
      case 'logout': await sb.auth.signOut(); session = null; LB = null; ui.screen = 'auth'; ui.authMode = 'login'; ui.err = ''; render(); return;
      case 'copy': { const link = location.origin + location.pathname + '#' + C().code;
        const txt = `Join our Bali Body Battle 🌴 ${link} (code ${C().code}). $${C().entry_fee} entry, winner takes the pot. On iPhone: open in Safari, tap Share, then Add to Home Screen.`;
        const done = () => { const old = t.textContent; t.textContent = 'Copied ✓'; setTimeout(() => { t.textContent = old; }, 1800); };
        try{ await navigator.clipboard.writeText(txt); done(); }catch(err){ toast(txt, 'Copy this invite'); } return; }
      case 'joinchal': await sb.from('challenge_days').insert({ player_id:LB.me, week:chalWeek(), day:-1 }); await reloadChal(); SFX.blip(); return;
      case 'day': { const i = +v, has = chalRows.some(r => r.player_id === LB.me && r.day === i);
        if(has) await sb.from('challenge_days').delete().match({ player_id:LB.me, week:chalWeek(), day:i });
        else await sb.from('challenge_days').insert({ player_id:LB.me, week:chalWeek(), day:i });
        await reloadChal();
        if(!has){ SFX.chaching(); if(chalRows.filter(r => r.player_id === LB.me && r.day >= 0).length === 7){ confetti(120); toast('🎯 Challenge complete. All 7 days ticked off!'); } }
        return; }
      case 'react': { const has = reactions.some(r => r.post_key === v && r.emoji === t.dataset.e && r.player_id === LB.me);
        if(has) await sb.from('reactions').delete().match({ post_key:v, player_id:LB.me, emoji:t.dataset.e });
        else { await sb.from('reactions').insert({ competition_id:compId, post_key:v, player_id:LB.me, emoji:t.dataset.e }); SFX.blip(); }
        const rx = await sb.from('reactions').select('post_key,player_id,emoji').eq('competition_id', compId); reactions = rx.data || reactions; render(); return; }
      case 'cheer': { const p = P(v); await newPost(`${t.dataset.e} to ${p.name}`); ui.sheet = null; ui.tab = 'banter'; render(); toast(`Sent ${t.dataset.e} to ${p.name}.`); return; }
      case 'delpost': await sb.from('posts').delete().eq('id', v); posts = posts.filter(p => p.id !== v); render(); return;
    }
  }catch(err){ toast('Something went wrong: ' + (err.message || err)); }
});
async function reloadChal(){ const ch = await sb.from('challenge_days').select('player_id,week,day').eq('week', chalWeek()); chalRows = (ch.data || []).filter(r => P(r.player_id)); render(); }
async function newPost(text){
  const { data, error } = await sb.from('posts').insert({ competition_id:compId, player_id:LB.me, body:text }).select().single();
  if(error) throw error;
  posts.unshift(data); SFX.blip();
  sb.functions.invoke('notify', { body:{ type:'post', competition_id:compId, text } });
}

document.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, val = id => document.getElementById(id)?.value ?? '';
  if(f.id === 'authForm'){
    const join = ui.authMode === 'join' || !!session;
    const keep = { aCode:val('aCode'), aName:val('aName'), aEmail:val('aEmail'), aWeight:val('aWeight') };
    const fail = msg => { ui.err = msg; ui.busy = false; render(); Object.entries(keep).forEach(([k,v]) => { const el = document.getElementById(k); if(el) el.value = v; }); };
    const email = val('aEmail').trim(), pass = val('aPass');
    if(join){
      const w = parseFloat(val('aWeight'));
      if(!val('aCode').trim()) return fail('Enter the join code from your invite.');
      if(!val('aName').trim()) return fail('Add your name so the family knows who you are.');
      if(!session && !/^\S+@\S+\.\S+$/.test(email)) return fail('Enter your email address.');
      if(!session && pass.length < 6) return fail('Your password needs at least 6 characters.');
      if(!(w >= 30 && w <= 300)) return fail('Enter your starting weight in kilograms, for example 82.4.');
      if(!document.getElementById('aPay').checked) return fail('Tick the box to confirm your $50 entry.');
      ui.busy = true; render(); Object.entries(keep).forEach(([k,v]) => { const el = document.getElementById(k); if(el) el.value = v; });
      if(!session){
        const { data, error } = await sb.auth.signUp({ email, password:pass });
        if(error) return fail(/registered|exists/i.test(error.message) ? 'That email already has an account. Tap “I’ve already joined” to log in.' : error.message);
        if(!data.session) return fail('Check your email for a confirmation link, then come back and log in.');
        session = data.session;
      }
      const { error } = await sb.rpc('join_competition', { p_code:val('aCode').trim(), p_name:val('aName').trim(), p_emoji:ui.pick, p_weight:w });
      if(error) return fail(error.message);
      ui.busy = false; ui.err = '';
      await loadAll();
      ls('bbb-seen-' + compId, String(R()));
      sb.functions.invoke('notify', { body:{ type:'joined', competition_id:compId } });
      SFX.chaching(); confetti(140);
      setTimeout(() => toast(`🌴 Welcome ${me().name}! The pot is now $${pot()}.`), 600);
    } else {
      if(!email || !pass) return fail('Enter your email and password.');
      ui.busy = true; render();
      const { data, error } = await sb.auth.signInWithPassword({ email, password:pass });
      if(error) return fail('That email and password don’t match. Try again, or ask the organiser to reset it.');
      session = data.session; ui.busy = false; ui.err = '';
      await loadAll();
    }
    return;
  }
  if(f.id === 'weighForm'){
    const w = parseFloat(val('wIn')), k = O(), mine = me();
    const prev = k <= mine.joined_week ? null : myLastBefore(k);
    if(!(w >= 30 && w <= 300)){ ui.err = 'Enter your weight in kilograms, for example 81.6.'; ui.confirmBig = false; render(); return; }
    if(prev != null){
      const chg = (prev - w) / prev * 100;
      if(Math.abs(chg) > 5 && !ui.confirmBig){ ui.confirmBig = true; ui.err = `That's a ${Math.abs(chg).toFixed(1)}% change in a week. Double-check the number, then tap again to confirm.`; render(); document.getElementById('wIn').value = w; return; }
    }
    ui.busy = true; render(); document.getElementById('wIn').value = w;
    const firstTime = prev != null && myWeightAt(k) == null;
    const { data: pct, error } = await sb.rpc('log_weight', { p_comp:compId, p_weight:w });
    ui.busy = false;
    if(error){ ui.err = error.message; render(); return; }
    ui.err = ''; ui.confirmBig = false; ui.editWeight = false;
    await refresh(); render();
    if(prev == null){ SFX.blip(); toast('Starting weight updated.'); return; }
    const chg = Number(pct);
    if(chg > HEALTHY_MAX){ SFX.chaching(); confetti(60); } else if(chg > 0){ SFX.chaching(); confetti(140); } else if(chg < 0) SFX.trombone(); else SFX.blip();
    if(firstTime) sb.functions.invoke('notify', { body:{ type:'weighed', competition_id:compId } });
    return;
  }
  if(f.id === 'postForm'){
    const txt = val('postIn').trim(); if(!txt) return;
    try{ await newPost(txt); render(); }catch(err){ toast('Couldn’t post: ' + (err.message || err)); }
  }
});
document.addEventListener('change', e => {
  if(e.target.id !== 'photoIn' || !e.target.files[0]) return;
  const img = new Image(), url = URL.createObjectURL(e.target.files[0]);
  img.onload = () => { const s = Math.min(1, 480/Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = img.width*s; c.height = img.height*s; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); ls('bbb-photo', c.toDataURL('image/jpeg', .8)); URL.revokeObjectURL(url); render(); };
  img.src = url;
});
document.addEventListener('keydown', e => { if(e.key === 'Escape' && ui.sheet){ ui.sheet = null; render(); } });

/* ===================== Boot ===================== */
if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
(async function boot(){
  render();
  try{
    if(!CFG || !CFG.supabaseUrl || CFG.supabaseUrl.includes('YOUR-')) throw new Error('The app isn’t connected to its database yet (config.js).');
    const { data } = await sb.auth.getSession();
    session = data.session;
    if(!session){ ui.screen = 'auth'; render(); return; }
    await loadAll();
  }catch(e){ loadErr = e.message || String(e); ui.screen = 'loading'; render(); }
})();

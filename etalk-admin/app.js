/* 애톡 운영 콘솔.
 *
 * 앱을 다시 내지 않고 고칠 수 있어야 해서 웹으로 뺐다. 화면은 서버 함수
 * (ae_ops_*)가 돌려주는 것만 그린다 — **여기서 다시 세지 않는다.** 두 곳에서
 * 세면 같은 화면 안에서 숫자가 어긋나고, 어느 쪽이 맞는지 영영 모른다.
 *
 * 권한은 전부 DB 가 지킨다. 이 파일은 누구나 받아 볼 수 있지만, 관리자
 * 토큰이 없으면 함수가 42501 로 거절한다.
 *
 * **숫자만 크게 띄우지 않는다.** 무슨 뜻인지 옆에 적어 두지 않으면 운영자는
 * 매번 다시 물어야 한다. 카드마다 한 줄 설명을, 맨 위에는 사람 말로 쓴
 * 브리핑을 둔다.
 */
'use strict';

const SUPA = 'https://hzdzbxhqezqszjputpzo.supabase.co';
const WSURL = 'wss://hzdzbxhqezqszjputpzo.supabase.co/realtime/v1/websocket';
const ANON = 'sb_publishable_RW_iasCyyhuTFgXQ918WMA_o5yYlnr0';
const KEY = 'etalk.console.session';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const nf = new Intl.NumberFormat('ko-KR');
const n = (v) => nf.format(Number(v || 0));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── 세션 ────────────────────────────────────────────── */
let sess = null;
try { sess = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { sess = null; }

function saveSession(s) {
  sess = s;
  // expires_in 은 상대값이라 새로 고치면 쓸모없다. 절대 시각으로 바꿔 둔다.
  sess.expires_at = Date.now() + (s.expires_in ? s.expires_in * 1000 : 3600e3) - 60e3;
  localStorage.setItem(KEY, JSON.stringify(sess));
}
function clearSession() { sess = null; localStorage.removeItem(KEY); }

async function login(email, password) {
  const r = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error(d.error_description || d.msg || d.message || '로그인 실패');
  saveSession(d);
  return d;
}

async function refresh() {
  if (!sess?.refresh_token) throw new Error('no session');
  const r = await fetch(`${SUPA}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: sess.refresh_token }),
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) { clearSession(); throw new Error('세션이 끊겼습니다'); }
  saveSession(d);
  RT.pushToken();          // 실시간 줄에도 새 토큰을 알려 준다
}

async function token() {
  if (!sess) throw new Error('no session');
  if (Date.now() >= (sess.expires_at || 0)) await refresh();
  return sess.access_token;
}

/* ── 서버 함수 부르기 ─────────────────────────────────── */
async function rpc(fn, args = {}) {
  const call = async () => fetch(`${SUPA}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: ANON,
      authorization: `Bearer ${await token()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  let r = await call();
  // 토큰이 중간에 죽는 일이 있다. 한 번은 조용히 되살려 본다.
  if (r.status === 401) { await refresh(); r = await call(); }
  const text = await r.text();
  let d = null; try { d = text ? JSON.parse(text) : null; } catch { d = text; }
  if (!r.ok) throw new Error(d?.message || d?.hint || `${fn}: ${r.status}`);
  return d;
}

/* ── 사람이 읽는 시각 ─────────────────────────────────── */
function ago(iso) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}일 전`;
  return new Date(iso).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
}
function clock(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ko-KR',
    { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

/* ── 상태 ────────────────────────────────────────────── */
const S = {
  tab: 'sum',
  overview: null, series: null, content: null, couples: null,
  users: null, tickets: null, config: null, live: null,
  retention: null, audit: null,
  ticketId: null, userId: null,
  coupleSort: 'last_talk', coupleDesc: true,
  contentSort: 'total', contentDesc: true,
  lastFull: 0, lastLive: 0, failed: 0,
};

/* ══════════════════════════════════════════════════════
   실시간 — 두 겹이다.

   1) **밀어 주는 것(웹소켓).** Supabase Realtime 이 바뀐 줄을 즉시 보낸다.
      단 **관리자가 읽을 수 있는 표만** 온다 — RLS 가 구독에도 걸린다.
      대화(messages)는 커플에게만 열려 있어서 여기 오지 않는다. 일부러
      그렇게 두었다: 운영 화면이 남의 대화를 받아 볼 이유가 없다.
   2) **물어보는 것(폴링).** 그래서 숫자 타일은 5초마다 다시 묻는다.
      웹소켓이 끊겨도 화면은 계속 산다.

   머리말의 표시가 지금 어느 쪽인지 말해 준다. 「실시간」이라고 써 두고
   실제로는 1분에 한 번 읽는 화면이 제일 나쁘다. */
const RT = {
  ws: null, hb: null, ref: 0, tries: 0, joined: false, lastEvent: 0,

  connect() {
    if (!sess) return;
    try { this.ws?.close(); } catch { /* 이미 닫혔으면 그만 */ }
    const ws = new WebSocket(`${WSURL}?apikey=${ANON}&vsn=1.0.0`);
    this.ws = ws; this.joined = false;

    ws.onopen = async () => {
      this.tries = 0;
      let tok = null;
      try { tok = await token(); } catch { /* 곧 관문으로 간다 */ }
      ws.send(JSON.stringify({
        topic: 'realtime:ops', event: 'phx_join', ref: String(++this.ref),
        payload: {
          config: {
            broadcast: { self: false }, presence: { key: '' }, private: false,
            postgres_changes: [
              { event: 'INSERT', schema: 'public', table: 'profiles' },
              { event: '*', schema: 'public', table: 'ae_tickets' },
              { event: '*', schema: 'public', table: 'ae_ticket_messages' },
            ],
          },
          access_token: tok,
        },
      }));
      clearInterval(this.hb);
      this.hb = setInterval(() => {
        try {
          ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++this.ref) }));
        } catch { /* 곧 onclose 가 온다 */ }
      }, 25000);
    };

    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.event === 'system' && m.payload?.status === 'ok') {
        this.joined = true; paintLive();
      } else if (m.event === 'postgres_changes') {
        this.lastEvent = Date.now();
        onPush(m.payload?.data?.table);
      }
    };

    ws.onclose = () => {
      clearInterval(this.hb); this.joined = false; paintLive();
      if (!sess) return;
      // 되돌아올 때까지 점점 뜸하게. 끊긴 줄에 매달려 두드리지 않는다.
      const wait = Math.min(30000, 1000 * 2 ** Math.min(this.tries++, 5));
      setTimeout(() => { if (sess) this.connect(); }, wait);
    };
    ws.onerror = () => { /* onclose 가 이어서 온다 */ };
  },

  pushToken() {
    if (!this.ws || this.ws.readyState !== 1) return;
    token().then((t) => this.ws.send(JSON.stringify({
      topic: 'realtime:ops', event: 'access_token',
      payload: { access_token: t }, ref: String(++this.ref),
    }))).catch(() => {});
  },

  stop() {
    this.joined = false;
    clearInterval(this.hb);
    const w = this.ws; this.ws = null;
    try { w?.close(); } catch { /* 이미 닫혔다 */ }
  },
};

/** 서버가 「바뀌었다」고 밀어 준 순간. 바뀐 표에 맞는 것만 다시 읽는다. */
async function onPush(table) {
  try {
    if (table === 'ae_tickets' || table === 'ae_ticket_messages') {
      await loadTickets();
      toast('문의가 움직였습니다');
    }
    await loadLive();
  } catch { /* 다음 폴링이 따라잡는다 */ }
}

/* ══ 브리핑 — 숫자를 사람 말로 ══════════════════════════ */
function renderBrief() {
  const O = S.overview, L = S.live, A = S.audit;
  if (!O || !L) return;
  const u = O.usage || {}, sp = O.support || {}, sys = O.system || {},
        ai = O.ai || {}, m = O.money || {};
  const out = [];
  const add = (tone, head, why) => out.push({ tone, head, why });

  // 1. 지금
  const on = Number(L.online || 0);
  add(on > 0 ? 'good' : '',
    on > 0 ? `지금 <b>${n(on)}명</b>이 앱을 켜 두고 있습니다.`
           : '지금 앱을 켜 둔 사람은 없습니다.',
    '채팅이나 게임 화면을 열어 둔 사람을 셉니다. 앱을 닫으면 몇 분 뒤 빠집니다.');

  // 2. 오늘 vs 어제
  const dT = Number(L.dau || 0), dY = Number(u.dau_yesterday || 0);
  if (dY || dT) {
    const diff = dT - dY;
    add(diff >= 0 ? 'good' : 'warn',
      `오늘 <b>${n(dT)}명</b>이 뭔가 했습니다. 어제 하루는 ${n(dY)}명이었습니다` +
      (diff === 0 ? '.' : ` (${diff > 0 ? '+' : ''}${n(diff)}).`),
      '메시지·출석·체크인처럼 <b>이름이 찍힌 행동</b>만 셉니다. 오목 한 판 같은 커플 단위 기록은 둘 중 누가 했는지 표에 없어서 못 셉니다.');
  }

  // 3. 문의
  const open = Number(sp.open || 0);
  if (open > 0) {
    add('bad', `답을 기다리는 문의가 <b>${n(open)}건</b> 있습니다.`,
      `가장 오래된 것이 ${sp.oldest_open_hours}시간째입니다. 문의 탭에서 바로 답할 수 있습니다.`);
  } else {
    add('good', '답을 기다리는 문의는 없습니다.',
      `지금까지 받은 문의는 모두 ${n(sp.total)}건입니다.`);
  }

  // 4. 가입의 질
  if (A?.by_origin) {
    const bulk = Number(A.by_origin.bulk?.n || 0);
    const org = Number(A.by_origin.organic?.n || 0);
    if (bulk > 0) {
      add('warn', `계정 ${n(A.total)}개 중 <b>${n(bulk)}개</b>가 뭉텅이 가입으로 보입니다.`,
        '이름성.숫자@gmail 꼴이고 메시지도 기기 등록도 없습니다. 사용자 수를 셀 때 이것부터 빼야 합니다.');
    } else {
      add('good', `바깥에서 온 손님이 <b>${n(org)}명</b>입니다.`,
        '내부 시험 계정과 뭉텅이 가입을 뺀 수입니다.');
    }
  }

  // 5. 돈
  const prod = Number(m.subs_live_prod || 0), sand = Number(m.subs_live_sandbox || 0);
  if (prod === 0 && sand > 0) {
    add('warn', `살아 있는 구독 <b>${n(sand)}건이 전부 샌드박스</b>입니다 — 실매출은 0원입니다.`,
      '앱스토어 시험 결제라 돈이 들어오지 않습니다. 실결제가 생기면 여기가 초록으로 바뀝니다.');
  } else if (prod > 0) {
    add('good', `실제 구독이 <b>${n(prod)}건</b> 살아 있습니다.`,
      `시험 결제 ${n(sand)}건은 따로 셉니다.`);
  }

  // 6. AI 건강
  if (ai.health?.falling_back) {
    add('bad', '비서가 <b>대체 모델</b>로 돌고 있습니다 — 값이 몇 배로 뜁니다.',
      `${esc(ai.health.wanted || '본래 모델')} 대신 ${esc(ai.health.used || '대체')} 를 쓰는 중입니다. OPENAI_API_KEY 부터 확인하세요.`);
  }

  // 7. 막힌 것
  const stuck = Number(sys.stuck_jobs || 0);
  const pend = sys.pending_content || {};
  const pendN = ['course', 'child', 'trip', 'report'].reduce((a, k) => a + Number(pend[k] || 0), 0);
  if (stuck > 0 || pendN > 0) {
    add('warn', `만들다 만 것이 <b>${n(stuck + pendN)}건</b> 있습니다.`,
      '오래 걸려 있으면 사용자 화면에서 「만드는 중」이 안 끝납니다. 아래 시스템 카드에서 갈래별로 볼 수 있습니다.');
  }

  $('#brief').innerHTML = out.map((b) =>
    `<div class="b ${b.tone}"><i></i><div>${b.head}<span class="why">${b.why}</span></div></div>`).join('');
}

/* ══ 실시간 타일 ═══════════════════════════════════════ */
const ACT_LABEL = {
  message: '메시지', attend: '출석', checkin: '체크인', balance: '밸런스',
  answer: '질문 답', know: '서로 알기', gift: '선물 참모', buy: '아이템 구매',
  reaction: '반응', ticket: '문의',
};

function renderLive() {
  const L = S.live, O = S.overview;
  if (!L) return;
  const u = O?.usage || {};
  const tiles = [
    ['지금 접속', n(L.online), '채팅·게임 화면을 켜 둔 사람'],
    ['오늘 움직인 사람', n(L.dau),
      `어제 하루 ${n(u.dau_yesterday)}명 · 최근 7일 ${n(u.wau)}명`],
    ['오늘 메시지', n(L.msgs_today),
      `최근 5분 ${n(L.msgs_5m)}건 · 말한 사람 ${n(u.talkers_today)}명`],
    ['오늘 가입', n(L.signups_today), '아래 「가입이 어디서 왔나」에서 갈라 봅니다'],
  ];
  $('#liveTiles').innerHTML = tiles.map(([k, v, d]) => `
    <div class="card tile"><div class="k">${k}</div><div class="v">${v}</div>
    <div class="d">${d || ''}</div></div>`).join('');

  const open = Number(L.open_tickets || 0);
  const b = $('#openBadge');
  b.hidden = open === 0; b.textContent = open;

  $('#feed').innerHTML = (L.feed || []).map((f) => `
    <div class="f"><b>${esc(f.who)}</b>
      <span class="muted small">${esc(ACT_LABEL[f.kind] || f.kind)}</span>
      <span class="when">${ago(f.at)}</span></div>`).join('')
    || '<span class="muted small">아직 움직임이 없어요</span>';
}

/* ══ 사람 단계 ═════════════════════════════════════════ */
function kv(obj) {
  const e = Object.entries(obj || {}).sort((a, b) => Number(b[1]) - Number(a[1]));
  if (!e.length) return '<span class="muted small">아직 없어요</span>';
  return `<dl class="kv">${e.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${n(v)}</dd>`).join('')}</dl>`;
}

function renderTiers() {
  const p = S.overview?.people; if (!p) return;
  const parts = [
    ['활동', 'var(--good)', p.active, '30일 안에 뭔가 한 사람'],
    ['연결만', 'var(--pink)', p.paired, '커플은 있는데 30일째 조용한 사람'],
    ['둘러봄', 'var(--blue)', p.visited, '커플은 없지만 기기 등록이나 흔적이 있는 사람'],
    ['가입만', 'var(--ink3)', p.signup, '커플도 기기도 흔적도 없는 계정'],
  ];
  const tot = parts.reduce((a, x) => a + Number(x[2] || 0), 0) || 1;
  // **단계를 더해서 「이어진 사람」을 만들면 안 된다.** 활동 단계에는 커플이
  // 없는 사람도 들어 있어서 퍼널의 「커플 연결」과 어긋난다(실측 23 vs 21).
  const real = Number(S.overview?.funnel?.paired || 0);
  $('#tiers').innerHTML = `
    <div class="grid g4" style="margin-bottom:12px">
      <div class="tile"><div class="k">계정 전체</div><div class="v">${n(p.total)}</div>
        <div class="d">운영 계정은 뺐습니다</div></div>
      <div class="tile"><div class="k">커플로 이어진 사람</div>
        <div class="v" style="color:var(--pink)">${n(real)}</div>
        <div class="d">방에 들어가 있는 사람</div></div>
      <div class="tile"><div class="k">30일 안에 움직인 사람</div>
        <div class="v" style="color:var(--good)">${n(p.active)}</div>
        <div class="d">이 숫자가 진짜 사용자 수에 가깝습니다</div></div>
    </div>
    <div class="stack">${parts.map(([, c, v]) => {
      const w = (Number(v || 0) / tot) * 100;
      return w <= 0 ? '' : `<div style="width:${w}%;background:${c}" title="${n(v)}">${w > 7 ? n(v) : ''}</div>`;
    }).join('')}</div>
    <div class="legend">${parts.map(([l, c, v, why]) =>
      `<span title="${esc(why)}"><i style="background:${c}"></i>${l} ${n(v)}</span>`).join('')}</div>
    <div class="small muted" style="margin-top:8px">
      ${parts.map(([l, , , why]) => `<b>${l}</b> ${why}`).join(' · ')}
    </div>
    <div class="small muted" style="margin-top:6px">
      최근 7일 신규 ${n(p.new_7d)}명 · 오늘 ${n(p.new_today)}명.
    </div>
    <div class="grid g2" style="margin-top:12px">
      <div><div class="muted small" style="margin-bottom:4px">가입 경로</div>${kv(p.by_provider)}</div>
      <div><div class="muted small" style="margin-bottom:4px">이어진 사람의 나이대</div>${kv(p.by_age)}</div>
    </div>`;
}

function renderFunnel() {
  const f = S.overview?.funnel; if (!f) return;
  const steps = [
    ['가입', f.signed, '계정을 만든 사람'],
    ['앱 열어봄', f.opened, '기기를 등록했거나 흔적을 남긴 사람'],
    ['커플 연결', f.paired, '방에 들어간 사람'],
    ['대화 시작', f.talked, '메시지를 한 번이라도 보낸 사람'],
    ['7일 내 활동', f.kept_7d, '최근 일주일 안에 뭔가 한 사람'],
    ['하트 결제', f.paid, '하트를 충전한 적이 있는 사람'],
  ];
  const top = Number(f.signed || 0) || 1;
  let prev = null;
  $('#funnel').innerHTML = steps.map(([k, v, why]) => {
    const val = Number(v || 0);
    const pct = (val / top) * 100;
    const drop = prev === null || prev === 0 ? '' :
      `<span class="muted"> · ${Math.round((val / prev) * 100)}%</span>`;
    prev = val;
    return `<div class="row" title="${esc(why)}"><span class="muted">${k}</span>
      <div class="track"><div class="fill" style="width:${Math.max(pct, 0.6)}%"></div></div>
      <span class="n">${n(val)}${drop}</span></div>`;
  }).join('') + `<div class="small muted" style="margin-top:8px">
    오른쪽 작은 %는 <b>바로 위 칸 대비</b>입니다. 뚝 떨어지는 칸이 지금 앱에서 가장 아픈 곳입니다.</div>`;
}

/* ══ 가입 출처 ═════════════════════════════════════════ */
const ORIGIN = {
  organic:  ['바깥 손님', 'good',  '우리가 만들지 않은 계정 — 이것이 진짜 유입입니다'],
  internal: ['내부 시험', 'pink',  'etalk.dev · etalk.app · test* · 진우님 계정'],
  bulk:     ['뭉텅이 가입', 'warn', '이름성.숫자@gmail 꼴 · 메시지도 기기도 없음'],
};

function renderAudit() {
  const a = S.audit; if (!a) return;
  const by = a.by_origin || {};
  const order = ['organic', 'internal', 'bulk'];
  const tot = Number(a.total || 0) || 1;
  const risky = (a.bulk_but_active || []).length;

  $('#audit').innerHTML = `
    <div class="stack">${order.map((k) => {
      const v = Number(by[k]?.n || 0); const w = (v / tot) * 100;
      const c = { organic: 'var(--good)', internal: 'var(--pink)', bulk: 'var(--ink3)' }[k];
      return w <= 0 ? '' : `<div style="width:${w}%;background:${c}">${w > 8 ? n(v) : ''}</div>`;
    }).join('')}</div>
    <div class="tblwrap" style="margin-top:12px"><table>
      <thead><tr><th class="noSort">어디서 왔나</th><th class="noSort">계정</th>
        <th class="noSort">커플</th><th class="noSort">대화함</th><th class="noSort">기기 등록</th>
        <th class="noSort">30일 활동</th><th class="noSort">한 번 열고 끝</th></tr></thead>
      <tbody>${order.map((k) => {
        const v = by[k]; if (!v) return '';
        const [l, c, note] = ORIGIN[k];
        return `<tr>
          <td><span class="pill ${c}">${l}</span>
            <div class="muted small">${note}</div></td>
          <td class="num">${n(v.n)}</td>
          <td class="num ${Number(v.paired) ? '' : 'zero'}">${n(v.paired)}</td>
          <td class="num ${Number(v.talked) ? '' : 'zero'}">${n(v.talked)}</td>
          <td class="num ${Number(v.devices) ? '' : 'zero'}">${n(v.devices)}</td>
          <td class="num ${Number(v.active) ? '' : 'zero'}">${n(v.active)}</td>
          <td class="num muted">${n(v.one_shot)}</td></tr>`;
      }).join('')}</tbody></table></div>
    <div class="small muted" style="margin-top:8px">
      「한 번 열고 끝」 = 가입한 지 10분 안에 마지막 로그인이 끝난 계정.
    </div>
    ${risky
      ? `<div class="small" style="color:var(--warn);margin-top:8px">
           뭉텅이로 분류됐는데 실제로 쓴 계정이 ${risky}개 있습니다 — 규칙이 사람을 잡아먹고 있습니다:
           ${(a.bulk_but_active || []).map((x) => esc(x.name || x.email)).join(', ')}</div>`
      : `<div class="small muted" style="margin-top:6px">
           뭉텅이로 분류된 계정 중 실제로 쓴 것은 <b>하나도 없습니다</b> — 규칙이 진짜 손님을 지우고 있지 않습니다.
           잣대는 설정 탭의 <span class="mono">signup_audit</span> 에서 고칩니다.</div>`}`;
}

/* ══ 잔존율 ════════════════════════════════════════════ */
function renderRetention() {
  const d = S.retention; if (!d) return;
  const weeks = d.weeks || [];
  if (!weeks.length) { $('#retention').innerHTML = '<span class="muted small">아직 자료가 없어요</span>'; return; }
  const maxK = Math.max(...weeks.map((w) => (w.r || []).length));
  const heat = (pct) => pct <= 0 ? 'transparent'
    : `rgba(255,92,138,${(0.12 + 0.75 * Math.min(pct, 1)).toFixed(2)})`;
  $('#retention').innerHTML = `<div class="tblwrap"><table>
    <thead><tr><th class="noSort">가입한 주</th><th class="noSort">인원</th>
      ${Array.from({ length: maxK }, (_, k) => `<th class="noSort">${k === 0 ? '그 주' : `${k}주 뒤`}</th>`).join('')}
    </tr></thead>
    <tbody>${weeks.slice().reverse().map((w) => `
      <tr><td class="small">${esc(w.w)}</td><td class="num">${n(w.size)}</td>
      ${Array.from({ length: maxK }, (_, k) => {
        const v = (w.r || [])[k];
        if (v === undefined) return '<td></td>';
        const pct = Number(w.size) ? Number(v) / Number(w.size) : 0;
        return `<td class="num" style="background:${heat(pct)}">${n(v)}
          <span class="muted small">${Math.round(pct * 100)}%</span></td>`;
      }).join('')}</tr>`).join('')}</tbody></table></div>
    <div class="small muted" style="margin-top:8px">
      한 줄이 「그 주에 가입한 사람들」입니다. 오른쪽으로 갈수록 몇 명이 다시 돌아왔는지 보여 줍니다.
      <b>「그 주」 칸이 인원보다 훨씬 작으면 가입하고 아무것도 안 한 사람이 그만큼</b>이라는 뜻입니다.
      ${esc(d.note || '')}</div>`;
}

/* ══ 추이 ══════════════════════════════════════════════ */
function spark(rows, key, label, color, why) {
  const W = 260, H = 74, P = 4;
  const vals = rows.map((r) => Number(r[key] || 0));
  const max = Math.max(1, ...vals);
  const step = rows.length > 1 ? (W - P * 2) / (rows.length - 1) : 0;
  const pt = (v, i) => [P + i * step, H - P - (v / max) * (H - P * 2 - 12)];
  const line = vals.map((v, i) => pt(v, i).join(',')).join(' ');
  const area = `${P},${H - P} ${line} ${P + (rows.length - 1) * step},${H - P}`;
  const last = vals[vals.length - 1] ?? 0;
  const sum = vals.reduce((a, b) => a + b, 0);
  return `<div class="card" style="background:var(--panel2)">
    <div class="row2"><span class="muted small">${label}</span>
      <span class="spacer"></span>
      <b class="mono" style="font-size:13px">오늘 ${n(last)}</b></div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none"
         style="display:block;margin-top:6px">
      <polygon points="${area}" fill="${color}" opacity=".16"></polygon>
      <polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.6"
                stroke-linejoin="round" stroke-linecap="round"></polyline>
    </svg>
    <div class="small muted">기간 합계 ${n(sum)} · 하루 최고 ${n(max)}</div>
    <div class="small muted" style="margin-top:2px">${why}</div>
  </div>`;
}

function renderSeries() {
  const rows = S.series || [];
  if (!rows.length) { $('#chart').innerHTML = '<span class="muted small">자료가 없어요</span>'; return; }
  $('#seriesNote').textContent =
    `${rows[0].d} ~ ${rows[rows.length - 1].d} · 한국 시간 자정 기준`;
  $('#chart').innerHTML = `<div class="grid g2">
    ${spark(rows, 'signups', '가입', 'var(--ink3)', '계정이 만들어진 수(운영 계정 제외)')}
    ${spark(rows, 'dau', '움직인 사람', 'var(--good)', '이름이 찍힌 행동을 한 사람 수')}
    ${spark(rows, 'talkers', '말한 사람', 'var(--blue)', '메시지를 보낸 사람 수')}
    ${spark(rows, 'messages', '메시지', 'var(--pink)', '지운 것과 비서가 쓴 것은 뺐습니다')}
    ${spark(rows, 'hearts_spent', '하트 소모', 'var(--warn)', '커플끼리 주고받은 것은 뺐습니다')}
    ${spark(rows, 'ai_calls', '비서 호출', 'var(--blue)', 'AI 를 부른 횟수 — 원가와 함께 봅니다')}
  </div>`;
}

/* ══ 돈 ════════════════════════════════════════════════ */
const REASON = {
  purchase: '충전', daily: '오늘의 보상', attend: '출석', quest: '숙제', level: '레벨',
  spend: '기타 소모', fairy: '요정 꾸미기', child: '우리 2세', furniture: '가구',
  sticker: '스티커', reset: '전적 초기화', theme: '테마', refund: '환불',
  gift: '선물', gift_out: '선물 보냄', gift_in: '선물 받음', report: '연애 리포트',
  gift_consult: '선물 참모', mood: '기분',
};

function renderMoney() {
  const m = S.overview?.money; if (!m) return;
  const prices = m.heart_prices || {};
  const hasPrice = Object.keys(prices).length > 0;
  const subs = (m.subs || []).map((s) =>
    `<span class="pill ${s.env === 'Production' ? 'good' : 'warn'}">${esc(s.env)} · ${esc(s.status)} ${n(s.n)}</span>`).join(' ');
  const sandboxOnly = Number(m.subs_live_prod || 0) === 0 && Number(m.subs_live_sandbox || 0) > 0;
  const byReason = Object.fromEntries(Object.entries(m.spend_by_reason || {})
    .map(([k, v]) => [REASON[k] || k, v]));

  $('#money').innerHTML = `
    <div class="grid g4" style="margin-bottom:12px">
      <div class="tile"><div class="k">충전된 하트</div><div class="v">${n(m.hearts_bought)}</div>
        <div class="d">${n(m.heart_orders)}건 · 30일 ${n(m.heart_orders_30d)}건</div></div>
      <div class="tile"><div class="k">쓴 하트</div><div class="v">${n(m.hearts_spent)}</div>
        <div class="d">커플끼리 주고받은 건 뺐습니다</div></div>
      <div class="tile"><div class="k">남은 하트</div><div class="v">${n(m.hearts_held)}</div>
        <div class="d">모든 커플 지갑을 합한 값</div></div>
      <div class="tile"><div class="k">리포트 판매</div><div class="v">${n(m.reports_sold)}</div>
        <div class="d">인앱결제 + 하트 결제</div></div>
    </div>
    <div class="row2" style="margin-bottom:8px">
      <span class="muted small">구독</span>${subs || '<span class="muted small">없음</span>'}
    </div>
    ${sandboxOnly ? `<div class="small" style="color:var(--warn)">
      살아 있는 구독이 전부 <b>샌드박스</b>(앱스토어 시험 결제)입니다 — 실제 매출은 아직 0원입니다.</div>` : ''}
    ${hasPrice ? '' : `<div class="small muted" style="margin-top:6px">
      하트 팩 가격이 설정에 없어서 원 단위로 환산하지 않았습니다.
      설정 탭의 <span class="mono">heart_prices</span> 에 상품별 가격을 넣으면 매출로 보여 줍니다.</div>`}
    <div style="margin-top:12px"><div class="muted small" style="margin-bottom:4px">하트를 무엇에 썼나</div>
      ${kv(byReason)}</div>`;
}

function renderAi() {
  const a = S.overview?.ai; if (!a) return;
  const noCost = Number(a.cost_30d_usd || 0) === 0 && Number(a.calls_30d || 0) > 0;
  const h = a.health || {};
  $('#ai').innerHTML = `
    <div class="grid g4" style="margin-bottom:10px">
      <div class="tile"><div class="k">30일 호출</div><div class="v">${n(a.calls_30d)}</div>
        <div class="d">오늘 ${n(a.calls_today)}회</div></div>
      <div class="tile"><div class="k">30일 대화</div><div class="v">${n(a.chat_30d)}</div>
        <div class="d">비서와 나눈 말</div></div>
      <div class="tile"><div class="k">토큰 넣음/받음</div>
        <div class="v" style="font-size:18px">${n(a.in_30d)} / ${n(a.out_30d)}</div>
        <div class="d">그중 캐시 ${n(a.cached_30d)}</div></div>
      <div class="tile"><div class="k">30일 원가</div>
        <div class="v">$${Number(a.cost_30d_usd || 0).toFixed(2)}</div>
        <div class="d">오늘 $${Number(a.cost_today_usd || 0).toFixed(2)}</div></div>
    </div>
    ${noCost ? `<div class="small" style="color:var(--warn)">
      호출은 ${n(a.calls_30d)}번인데 원가가 0 입니다 —
      <span class="mono">ai_usage.cost_micros</span> 를 아무도 안 채우고 있습니다.
      토큰 수는 쌓이니 값은 나중에 소급해 계산할 수 있습니다.</div>` : ''}
    <div style="margin-top:8px">
      ${h.falling_back
        ? `<span class="pill bad">지금 대체 모델로 돌고 있다</span>
           <div class="small" style="color:var(--warn);margin-top:4px">
             ${esc(h.wanted || '본래 모델')} 대신 ${esc(h.used || '대체 모델')} 로 답하고 있습니다
             ${h.why ? `(${esc(h.why)})` : ''} — 값이 몇 배로 뜁니다. 키부터 확인하세요.</div>`
        : `<span class="pill good">본래 모델로 돌고 있다</span>
           <div class="small muted" style="margin-top:4px">
             애톡의 글은 <b>OpenAI</b> 가 씁니다. 키가 비면 앱이 깜깜해지지 않도록
             <b>대체 모델</b>로 조용히 넘어가게 해 뒀는데(값이 몇 배로 뜁니다),
             지금은 넘어간 적이 없습니다${h.last_at ? ` · 마지막 대체 ${clock(h.last_at)}` : ''}.</div>`}
    </div>`;
}

function renderSystem() {
  const s = S.overview?.system; if (!s) return;
  const p = s.pending_content || {};
  const stuck = Number(s.stuck_jobs || 0);
  const notice = s.notice && Object.keys(s.notice).length ? s.notice : null;
  $('#system').innerHTML = `
    <dl class="kv">
      <dt>최소 빌드</dt><dd class="mono">${esc(JSON.stringify(s.min_build))}</dd>
      <dt>등록된 기기</dt><dd>${n(s.devices)}</dd>
      ${Object.entries(s.devices_by_platform || {}).map(([k, v]) =>
        `<dt class="small">· ${esc(k)}</dt><dd class="small">${n(v)}</dd>`).join('')}
      <dt>10분 넘게 걸린 작업</dt><dd class="${stuck ? 'down' : ''}">${n(stuck)}</dd>
      <dt>만들다 만 코스</dt><dd>${n(p.course)} <span class="muted small">(실패 ${n(p.course_failed)})</span></dd>
      <dt>만들다 만 여행</dt><dd>${n(p.trip)} <span class="muted small">(실패 ${n(p.trip_failed)})</span></dd>
      <dt>만들다 만 2세</dt><dd>${n(p.child)}</dd>
      <dt>만들다 만 리포트</dt><dd>${n(p.report)}</dd>
    </dl>
    <div style="margin-top:10px" class="small">
      <span class="muted">앱 공지</span>
      ${notice ? `<div class="mono" style="margin-top:4px">${esc(JSON.stringify(notice))}</div>`
               : ' <span class="muted">없음</span>'}
    </div>
    <div style="margin-top:8px" class="small">
      <span class="muted">기능 스위치</span>
      <div class="mono" style="margin-top:4px">${esc(JSON.stringify(s.flags || {}))}</div>
    </div>
    <div class="small muted" style="margin-top:8px">
      「만들다 만」 것은 AI 가 만들다 멈춘 기록입니다. 사용자 화면에서는 「만드는 중」이 안 끝납니다.
    </div>`;
}

/* ══ 사용자 ════════════════════════════════════════════ */
const TIER = {
  active: ['활동', 'good'], paired: ['연결만', 'pink'],
  visited: ['둘러봄', 'warn'], signup: ['가입만', ''],
};

function renderUsers() {
  const d = S.users; if (!d) return;
  $('#userCount').textContent = `${n(d.total)}명`;
  const head = ['이름', '단계', '경로', '짝꿍', '메시지', '행동', '마지막 활동', '가입'];
  $('#userTbl').innerHTML = `
    <thead><tr>${head.map((h) => `<th class="noSort">${h}</th>`).join('')}</tr></thead>
    <tbody>${(d.rows || []).map((r) => {
      const [tl, tc] = TIER[r.tier] || ['?', ''];
      return `<tr class="clickable" data-id="${r.id}">
        <td>${esc(r.nickname || '이름없음')}${r.is_admin ? ' <span class="pill pink">운영</span>' : ''}</td>
        <td><span class="pill ${tc}">${tl}</span></td>
        <td class="small muted">${esc(r.provider || '?')}</td>
        <td class="small">${esc(r.partner || '—')}</td>
        <td class="num ${Number(r.msgs) ? '' : 'zero'}">${n(r.msgs)}</td>
        <td class="num ${Number(r.acts) ? '' : 'zero'}">${n(r.acts)}</td>
        <td class="small muted">${ago(r.last_act)}</td>
        <td class="small muted">${ago(r.joined)}</td></tr>`;
    }).join('')}</tbody>`;
  $$('#userTbl tbody tr').forEach((tr) => tr.onclick = () => openUser(tr.dataset.id));
}

async function openUser(id) {
  S.userId = id;
  $('#userDetail').innerHTML = '<span class="muted small">읽는 중…</span>';
  try {
    const d = await rpc('ae_ops_user', { p_id: id });
    const w = d.who || {};
    const [tl, tc] = TIER[w.tier] || ['?', ''];
    $('#userDetail').innerHTML = `
      <h2>${esc(w.nickname || '이름없음')} <span class="pill ${tc}">${tl}</span></h2>
      <dl class="kv">
        <dt>이메일</dt><dd class="small">${esc(w.email || '— (카카오·애플은 안 줍니다)')}</dd>
        <dt>가입 경로</dt><dd class="small">${esc(w.provider || '?')}</dd>
        <dt>성별 · 생일</dt><dd class="small">${esc(w.gender || '—')} · ${esc(w.birthday || '—')}</dd>
        <dt>가입</dt><dd class="small">${clock(w.joined)}</dd>
        <dt>마지막 로그인</dt><dd class="small">${clock(w.last_sign_in)}</dd>
        <dt>마지막 활동</dt><dd class="small">${clock(w.last_act)}</dd>
        <dt>등록 기기</dt><dd>${n(w.devices)}</dd>
        <dt>메시지</dt><dd>${n(w.msgs)}</dd>
        <dt>행동 (30일 / 전체)</dt><dd>${n(w.acts_30d)} / ${n(w.acts)}</dd>
      </dl>
      <div style="margin-top:12px"><div class="muted small" style="margin-bottom:4px">무엇을 했나</div>
        ${kv(Object.fromEntries(Object.entries(d.acts_by_kind || {})
          .map(([k, v]) => [ACT_LABEL[k] || k, v])))}</div>
      <div style="margin-top:12px"><div class="muted small" style="margin-bottom:4px">하트 원장</div>
        ${(d.hearts || []).length ? `<div class="tblwrap"><table><tbody>${
          d.hearts.map((h) => `<tr><td class="small">${clock(h.created_at)}</td>
            <td class="small">${esc(h.memo || REASON[h.reason] || h.reason)}</td>
            <td class="num ${h.amount > 0 ? 'up' : 'down'}">${h.amount > 0 ? '+' : ''}${n(h.amount)}</td>
          </tr>`).join('')}</tbody></table></div>`
          : '<span class="muted small">없음</span>'}</div>
      <div style="margin-top:12px"><div class="muted small" style="margin-bottom:4px">최근 움직임</div>
        ${(d.recent || []).slice(0, 12).map((r) =>
          `<div class="f small"><span>${esc(ACT_LABEL[r.kind] || r.kind)}</span>
           <span class="muted"> · ${clock(r.at)}</span></div>`).join('')
          || '<span class="muted small">없음</span>'}</div>`;
  } catch (e) {
    $('#userDetail').innerHTML = `<span class="err">${esc(e.message)}</span>`;
  }
}

/* ══ 커플 ══════════════════════════════════════════════ */
function renderCouples() {
  const d = S.couples; if (!d) return;
  const srcs = d.sources || [];
  const grps = [...new Set(srcs.map((s) => s.grp))];
  const sel = $('#coupleGrp');
  if (sel.options.length !== grps.length + 1) {
    sel.innerHTML = '<option value="">기능 · 모든 갈래</option>' +
      grps.map((g) => `<option>${esc(g)}</option>`).join('');
  }
  const grp = sel.value;
  // **아무 커플도 안 쓴 기능은 열을 만들지 않는다.** 서른여덟 칸을 다 그리면
  // 표가 옆으로 흘러서 정작 볼 숫자를 못 찾는다.
  const used = new Set();
  for (const r of d.rows || []) {
    for (const [k, v] of Object.entries(r.counts || {})) if (Number(v) > 0) used.add(k);
  }
  const cols = srcs.filter((s) => (!grp || s.grp === grp) && (used.has(s.key) || $('#showAllCols').checked));

  let rows = [...(d.rows || [])];
  const all = rows.length;
  if ($('#hideEmpty').checked) {
    rows = rows.filter((r) => Object.values(r.counts || {}).some((v) => Number(v) > 0));
  }
  $('#coupleNote').textContent =
    `${rows.length}쌍${rows.length !== all ? ` (전체 ${all})` : ''} · 기능 열 ${cols.length}개`;

  const val = (r, k) => (k in r) ? r[k] : Number(r.counts?.[k] || 0);
  rows.sort((a, b) => {
    const g = (x) => x === null || x === undefined ? -Infinity
      : (typeof x === 'string' ? (new Date(x).getTime() || 0) : Number(x));
    const c = g(val(a, S.coupleSort)) - g(val(b, S.coupleSort));
    return S.coupleDesc ? -c : c;
  });

  const fixed = [
    ['who', '커플', false], ['plan', '요금제', false], ['last_talk', '마지막 대화', true],
    ['hearts_bought', '충전', true], ['hearts_spent', '소모', true], ['hearts_now', '지갑', true],
    ['ai_chat', '비서', true],
  ];
  const arrow = (k) => S.coupleSort === k ? (S.coupleDesc ? ' ↓' : ' ↑') : '';

  $('#coupleTbl').innerHTML = `
    <thead><tr>
      ${fixed.map(([k, l, s]) => `<th ${s ? `data-k="${k}"` : 'class="noSort"'}>${l}${s ? arrow(k) : ''}</th>`).join('')}
      ${cols.map((c) => `<th data-k="${c.key}" title="${esc(c.grp)}">${esc(c.label)}${arrow(c.key)}</th>`).join('')}
    </tr></thead>
    <tbody>${rows.map((r) => {
      const who = (r.people || []).map((p) => esc(p.name)).join(' · ') || '<span class="muted">빈 방</span>';
      const solo = Number(r.members || 0) < 2 ? ' <span class="pill warn">혼자</span>' : '';
      const plan = r.plan === 'free'
        ? '<span class="pill">무료</span>' : `<span class="pill pink">${esc(r.plan)}</span>`;
      return `<tr>
        <td>${who}${solo} ${r.status !== 'active' ? `<span class="pill">${esc(r.status)}</span>` : ''}</td>
        <td>${plan}</td>
        <td class="small muted">${ago(r.last_talk)}</td>
        <td class="num ${Number(r.hearts_bought) ? '' : 'zero'}">${n(r.hearts_bought)}</td>
        <td class="num ${Number(r.hearts_spent) ? '' : 'zero'}">${n(r.hearts_spent)}</td>
        <td class="num">${n(r.hearts_now)}</td>
        <td class="num ${Number(r.ai_chat) ? '' : 'zero'}">${n(r.ai_chat)}</td>
        ${cols.map((c) => {
          const v = Number(r.counts?.[c.key] || 0);
          return `<td class="num ${v ? '' : 'zero'}">${v ? n(v) : '·'}</td>`;
        }).join('')}
      </tr>`;
    }).join('')}</tbody>`;

  $$('#coupleTbl th[data-k]').forEach((th) => th.onclick = () => {
    const k = th.dataset.k;
    if (S.coupleSort === k) S.coupleDesc = !S.coupleDesc;
    else { S.coupleSort = k; S.coupleDesc = true; }
    renderCouples();
  });
}

/* ══ 기능 사용량 ═══════════════════════════════════════ */
function renderContent() {
  const rows = [...(S.content || [])];
  if (!rows.length) return;
  rows.sort((a, b) => {
    const c = Number(a[S.contentSort] || 0) - Number(b[S.contentSort] || 0);
    return S.contentDesc ? -c : c;
  });
  const arrow = (k) => S.contentSort === k ? (S.contentDesc ? ' ↓' : ' ↑') : '';
  const cols = [['total', '누적'], ['d30', '30일'], ['d7', '7일'], ['today', '오늘']];
  const maxD30 = Math.max(1, ...rows.map((r) => Number(r.d30 || 0)));

  $('#contentTbl').innerHTML = `
    <thead><tr><th class="noSort">기능</th><th class="noSort">갈래</th>
      ${cols.map(([k, l]) => `<th data-k="${k}">${l}${arrow(k)}</th>`).join('')}
      <th class="noSort" style="width:150px">30일 사용량</th></tr></thead>
    <tbody>${rows.map((r) => {
      const w = (Number(r.d30 || 0) / maxD30) * 100;
      return `<tr>
        <td>${esc(r.label)}</td>
        <td class="small muted">${esc(r.grp)}</td>
        ${cols.map(([k]) => {
          const v = Number(r[k] || 0);
          if (!r.timed && k !== 'total')
            return '<td class="muted small" title="이 표에는 시각 열이 없어 기간별로 못 셉니다">—</td>';
          return `<td class="num ${v ? '' : 'zero'}">${v ? n(v) : '·'}</td>`;
        }).join('')}
        <td><div style="background:var(--panel2);border-radius:5px;height:9px">
          <div style="width:${w}%;height:100%;background:var(--pink);border-radius:5px"></div></div></td>
      </tr>`;
    }).join('')}</tbody>`;

  $$('#contentTbl th[data-k]').forEach((th) => th.onclick = () => {
    const k = th.dataset.k;
    if (S.contentSort === k) S.contentDesc = !S.contentDesc;
    else { S.contentSort = k; S.contentDesc = true; }
    renderContent();
  });
}

/* ══ 문의 ══════════════════════════════════════════════ */
const TSTATUS = { open: ['기다리는 중', 'bad'], answered: ['답함', 'good'], closed: ['닫음', ''] };

function renderTickets() {
  const list = S.tickets || [];
  $('#ticketList').innerHTML = list.map((t) => {
    const [l, c] = TSTATUS[t.status] || [t.status, ''];
    return `<div class="item ${t.id === S.ticketId ? 'on' : ''}" data-id="${t.id}">
      <div class="t">${esc(t.subject || '(제목 없음)')}</div>
      <div class="s">${esc(t.who)} · ${ago(t.created_at)} <span class="pill ${c}">${l}</span></div>
    </div>`;
  }).join('') || '<div class="item"><span class="muted small">들어온 문의가 없어요</span></div>';
  $$('#ticketList .item[data-id]').forEach((el) =>
    el.onclick = () => { S.ticketId = el.dataset.id; renderTickets(); });
  if (!S.ticketId && list.length) S.ticketId = list[0].id;
  renderTicket();
}

function renderTicket() {
  const t = (S.tickets || []).find((x) => x.id === S.ticketId);
  if (!t) { $('#ticketPane').innerHTML = '<span class="muted small">왼쪽에서 문의를 고르세요.</span>'; return; }
  const [l, c] = TSTATUS[t.status] || [t.status, ''];
  // 쓰던 답장을 실시간 갱신이 지워 버리면 안 된다.
  const draft = $('#replyBox')?.value || '';
  $('#ticketPane').innerHTML = `
    <h2>${esc(t.subject || '(제목 없음)')} <span class="pill ${c}">${l}</span>
      <span class="note">${esc(t.category || '')}</span></h2>
    <div class="small muted" style="margin-bottom:10px">
      ${esc(t.who)}${t.who_email ? ` · ${esc(t.who_email)}` : ''} · ${clock(t.created_at)}
    </div>
    <div class="msgs">${(t.messages || []).map((m) => `
      <div class="msg ${m.from_admin ? 'admin' : ''}">
        <div class="m">${esc(m.body)}</div>
        <div class="w">${m.from_admin ? '운영팀' : esc(t.who)} · ${clock(m.at)}</div>
      </div>`).join('')}</div>
    <textarea id="replyBox" placeholder="답장을 씁니다. 보내면 사용자 앱에 바로 뜹니다.">${esc(draft)}</textarea>
    <div class="row2" style="margin-top:8px">
      <button class="btn" id="sendReply" type="button">답장 보내기</button>
      <button class="btn ghost" data-st="closed" type="button">닫기</button>
      <button class="btn ghost" data-st="open" type="button">다시 열기</button>
      <span class="err small" id="replyErr"></span>
    </div>`;

  $('#sendReply').onclick = async () => {
    const box = $('#replyBox');
    const body = box.value.trim();
    if (!body) return;
    $('#sendReply').disabled = true;
    try {
      await rpc('ae_ops_reply', { p_ticket: t.id, p_body: body });
      box.value = '';
      toast('보냈습니다');
      await loadTickets();
    } catch (e) { $('#replyErr').textContent = e.message; }
    finally { const b = $('#sendReply'); if (b) b.disabled = false; }
  };
  $$('#ticketPane button[data-st]').forEach((b) => b.onclick = async () => {
    try {
      await rpc('ae_ops_ticket_status', { p_ticket: t.id, p_status: b.dataset.st });
      await loadTickets();
    } catch (e) { toast(e.message); }
  });
}

/* ══ 설정 ══════════════════════════════════════════════
   **무엇을 바꾸는지 모르는 스위치는 아무도 못 누른다.** 키마다 무슨 일이
   벌어지고 누가 그 값을 읽는지 적어 둔다. 아래 설명은 실제 코드를 뒤져
   확인한 것이다(lib/app/remote_config.dart · supabase/functions · DB 함수). */
const CFG_GROUPS = [
  ['앱 업데이트 벽', ['min_build', 'update_message', 'update_url_ios', 'update_url_android']],
  ['앱에 보이는 것', ['notice', 'welcome_message', 'checkin_anim_ms', 'map_style']],
  ['기능 스위치와 한도', ['flags', 'limits', 'free_trial_days']],
  ['하트 값', ['attend_hearts', 'score_reset_hearts', 'house_grow_base']],
  ['컨텐츠 기본값', ['spin_presets']],
  ['광고', ['ad_test_users']],
  ['이 콘솔만 쓰는 값', ['heart_prices', 'signup_audit']],
];

const CFG_DOC = {
  min_build: {
    what: '앱의 빌드 번호가 이 값보다 낮으면 <b>업데이트 벽</b>이 뜨고 앱을 못 씁니다. 0 이면 벽이 없습니다.',
    who: '앱 (remote_config.dart)',
    danger: '올려 두면 그보다 낮은 빌드를 쓰는 사람 전원이 즉시 막힙니다. 스토어에 새 빌드가 <b>깔린 뒤</b>에 올리세요.',
  },
  update_message: { what: '업데이트 벽에 보여 줄 한 줄. 비우면 기본 문구가 뜹니다.', who: '앱' },
  update_url_ios: { what: '업데이트 벽의 버튼이 여는 주소(아이폰).', who: '앱' },
  update_url_android: { what: '업데이트 벽의 버튼이 여는 주소(안드로이드).', who: '앱' },
  notice: {
    what: '홈 위쪽에 뜨는 공지 한 장. <span class="mono">{"id":"...","text":"...","url":""}</span> 꼴이고, ' +
          '<b>id 를 바꿔야 새 공지</b>로 칩니다(닫은 공지는 id 로 기억합니다). null 이면 공지 없음.',
    who: '앱',
  },
  welcome_message: { what: '커플이 처음 이어졌을 때 비서 「애비」가 방에 남기는 첫인사.', who: 'DB 함수 ae_welcome_text' },
  checkin_anim_ms: { what: '「오늘 하루」 편지가 접혀 날아가기까지 걸리는 시간(밀리초). 600~8000 밖은 앱이 알아서 가둡니다.', who: '앱' },
  map_style: { what: '타임라인 지도의 바탕 그림 이름(liberty·bright·positron…). 모르는 이름이면 기본값으로 떨어집니다.', who: '앱' },
  flags: {
    what: '기능 스위치. <b>없는 키는 켜진 것</b>이고 false 만 뜻이 있습니다. ' +
          '단 <span class="mono">ad_banner</span> 만 반대로, 명시적으로 true 일 때만 켜집니다(돈 받는 노출이라).',
    who: '앱 · 체크인 화면 · ai-assistant 엣지 함수',
  },
  limits: { what: '무료·유료 한도(하루 비서 대화 수, 게임 판수, 주간 코스 횟수 등).', who: '앱 요금제 표 · 엣지 함수 flags.ts · DB 함수 ae_game_gate / ae_game_quota' },
  free_trial_days: { what: '무료 체험 일수.', who: 'DB 함수 ae_free_trial_days' },
  attend_hearts: { what: '출석 한 번에 주는 하트 수.', who: 'DB 함수 ae_attend_state · ae_heart_attend' },
  score_reset_hearts: { what: '게임 전적을 초기화할 때 드는 하트 값.', who: 'DB 함수 ae_game_reset' },
  house_grow_base: { what: '「우리 집」 방을 넓힐 때의 기본 하트 값.', who: 'DB 함수 ae_house_grow_price' },
  spin_presets: { what: '빙글빙글 돌림판의 기본 목록(오늘 뭐 먹지 등).', who: 'DB 함수 ae_spin_state' },
  ad_test_users: {
    what: '여기 적힌 사용자에게는 <b>구글 시험 광고</b>가 나갑니다.',
    who: '앱',
    danger: '게시자 본인이 실광고를 누르면 무효 트래픽으로 계정이 정지될 수 있습니다. 진우님과 가까운 분의 id 는 여기 꼭 넣어 두세요.',
  },
  heart_prices: { what: '하트 팩 상품별 원 가격. 넣으면 「돈」 카드가 매출을 원으로 환산합니다. 앱은 안 읽습니다.', who: '이 콘솔' },
  signup_audit: { what: '가입 계정을 내부 시험 / 뭉텅이 / 바깥 손님으로 가르는 정규식. 앱은 안 읽습니다.', who: '이 콘솔' },
};

const CANT_CHANGE = [
  ['AI 프롬프트',
   '엣지 함수 안의 TypeScript 에 박혀 있습니다 — <span class="mono">ai-assistant · court · gift · recap · report · trip</span>. ' +
   '여기서 고치려면 프롬프트를 DB 표로 옮기고 엣지 함수가 그 표를 읽게 고친 뒤 한 번 다시 배포하면 됩니다. 그 뒤로는 웹에서 바로 고칩니다.'],
  ['비밀 값 (OPENAI_API_KEY 등)',
   '엣지 함수 비밀 저장소에 있습니다. 웹에서 바꾸려면 이 페이지가 Supabase 관리 토큰을 들고 있어야 하는데, ' +
   '그 토큰 하나면 프로젝트 전체를 지울 수 있습니다. <b>브라우저에 두면 안 되는 값</b>이라 일부러 막았습니다.'],
  ['요금제 가격', '앱스토어·플레이 콘솔에 있습니다. 상품 가격은 스토어가 쥡니다.'],
  ['집계 원천 목록',
   '<span class="mono">ae_ops_sources</span> 표입니다. 새 기능을 만들면 여기 한 줄을 넣으면 「기능 사용량」에 저절로 나옵니다 — ' +
   '지금은 SQL 로만 넣습니다. 원하시면 이 화면에 붙여 드리겠습니다.'],
];

function renderConfig() {
  const c = S.config; if (!c) return;
  const known = new Set(CFG_GROUPS.flatMap(([, ks]) => ks));
  const rest = Object.keys(c).filter((k) => !known.has(k)).sort();
  const groups = rest.length ? [...CFG_GROUPS, ['설명이 아직 없는 값', rest]] : CFG_GROUPS;

  $('#configList').innerHTML = groups.map(([title, keys]) => {
    const rows = keys.filter((k) => k in c).map((k) => {
      const doc = CFG_DOC[k] || {};
      const json = JSON.stringify(c[k].value, null, 2);
      const big = json.length > 300;
      return `<div class="cfgrow ${big ? 'closed' : ''}">
        <div class="head"><b class="mono">${esc(k)}</b>
          <span class="muted small">${ago(c[k].updated_at)} 고침</span>
          <span class="spacer"></span>
          ${big ? '<button class="toggle" type="button">펼치기</button>' : ''}</div>
        <div class="what">${doc.what || '<span class="muted">설명이 아직 없습니다.</span>'}</div>
        <div class="who">읽는 곳: ${esc(doc.who || '?')}</div>
        ${doc.danger ? `<div class="danger">⚠ ${doc.danger}</div>` : ''}
        <div class="body">
          <textarea class="mono" data-k="${esc(k)}" style="margin-top:8px">${esc(json)}</textarea>
          <div class="row2" style="margin-top:6px">
            <button class="btn ghost" data-save="${esc(k)}" type="button">저장</button>
            <span class="err small" data-err="${esc(k)}"></span>
          </div>
        </div>
      </div>`;
    }).join('');
    return rows ? `<div class="card cfg"><h3>${esc(title)}</h3>${rows}</div>` : '';
  }).join('');

  $$('#configList .toggle').forEach((b) => b.onclick = () => {
    const row = b.closest('.cfgrow');
    row.classList.toggle('closed');
    b.textContent = row.classList.contains('closed') ? '펼치기' : '접기';
  });

  $$('#configList button[data-save]').forEach((b) => b.onclick = async () => {
    const k = b.dataset.save;
    const ta = $(`#configList textarea[data-k="${CSS.escape(k)}"]`);
    const err = $(`#configList [data-err="${CSS.escape(k)}"]`);
    err.textContent = '';
    let v;
    try { v = JSON.parse(ta.value); }
    catch { err.textContent = 'JSON 형식이 아닙니다 — 따옴표와 쉼표를 확인하세요'; return; }
    // 되돌리기 어려운 것 하나만 다시 묻는다.
    if (k === 'min_build' && Number(v) > 0 &&
        !confirm(`최소 빌드를 ${v} 로 올립니다.\n이보다 낮은 빌드를 쓰는 사람은 앱이 막힙니다. 계속할까요?`)) return;
    b.disabled = true;
    try {
      await rpc('ae_ops_set_config', { p_key: k, p_value: v });
      toast(`${k} 저장했습니다`);
      S.config = await rpc('ae_ops_config');
      renderConfig();
    } catch (e) { err.textContent = e.message; }
    finally { b.disabled = false; }
  });

  $('#cantChange').innerHTML = `<table class="doc"><tbody>${
    CANT_CHANGE.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td class="muted">${v}</td></tr>`).join('')
  }</tbody></table>`;
}

/* ══ 불러오기 ══════════════════════════════════════════ */
async function loadLive() {
  S.live = await rpc('ae_ops_live');
  S.lastLive = Date.now();
  renderLive(); renderBrief();
}
async function loadTickets() {
  S.tickets = await rpc('ae_ops_tickets', { p_limit: 200 });
  renderTickets();
}
async function loadUsers() {
  S.users = await rpc('ae_ops_users', {
    p_tier: $('#tierSel').value || null,
    p_q: $('#userQ').value.trim() || null,
    p_limit: 200, p_offset: 0,
  });
  renderUsers();
}
async function loadAll() {
  const days = Number($('#seriesDays').value || 30);
  const [ov, se, co, cp, cf, rt, au] = await Promise.all([
    rpc('ae_ops_overview'),
    rpc('ae_ops_series', { p_days: days }),
    rpc('ae_ops_content'),
    rpc('ae_ops_couples'),
    rpc('ae_ops_config'),
    rpc('ae_ops_retention', { p_weeks: 10 }),
    rpc('ae_ops_signup_audit'),
  ]);
  S.overview = ov; S.series = se; S.content = co; S.couples = cp;
  S.config = cf; S.retention = rt; S.audit = au;
  S.lastFull = Date.now();
  renderTiers(); renderFunnel(); renderSeries(); renderMoney(); renderAi();
  renderSystem(); renderContent(); renderCouples(); renderConfig();
  renderRetention(); renderAudit();
  await Promise.all([loadUsers(), loadTickets()]);
  await loadLive();               // 브리핑은 overview 와 live 가 다 있어야 그린다
}

/* ══ 심장 박동 ═════════════════════════════════════════
   화면이 안 보일 때는 아무것도 안 부른다 — 켜 둔 탭이 조용히 요금을 만들면
   안 된다. */
const TICK_LIVE = 5000;      // 숫자 타일
const TICK_FULL = 60000;     // 나머지 전부

function paintLive() {
  const dot = $('#liveDot'), txt = $('#liveTxt');
  if (!dot) return;
  const s = S.lastLive ? Math.round((Date.now() - S.lastLive) / 1000) : null;
  if (document.hidden) {
    dot.className = 'dot stale'; txt.textContent = '멈춤 (탭이 뒤에 있음)'; return;
  }
  if (S.failed > 2) { dot.className = 'dot off'; txt.textContent = '서버에 못 닿음'; return; }
  if (RT.joined) {
    dot.className = 'dot on';
    txt.textContent = (s !== null && s > 20) ? `실시간 · ${s}초 전 확인` : '실시간';
  } else {
    dot.className = 'dot stale';
    txt.textContent = s === null ? '잇는 중…' : `${s}초 전 확인 (실시간 줄 끊김)`;
  }
}

function renderLiveDetail() {
  $('#liveDetail').innerHTML = `
    <table><tbody>
      <tr><td><b>즉시</b> (서버가 밀어 줌)</td>
        <td class="muted">새 가입 · 새 문의 · 문의 답장 ${RT.joined
          ? '<span class="pill good">연결됨</span>'
          : '<span class="pill bad">끊김 — 다시 잇는 중</span>'}</td></tr>
      <tr><td><b>5초마다</b></td><td class="muted">지금 접속 · 오늘 움직인 사람 · 오늘 메시지 · 오늘 가입 · 움직임 목록</td></tr>
      <tr><td><b>60초마다</b></td><td class="muted">사용자 · 커플 · 기능 사용량 · 잔존율 · 돈 · 비서 · 시스템 · 설정 (전부)</td></tr>
      <tr><td><b>안 옴</b></td><td class="muted">대화 내용 — 운영 계정에는 남의 대화를 읽을 권한이 없습니다(일부러 그렇게 뒀습니다).
        그래서 메시지 수는 밀어 주는 대신 5초마다 다시 셉니다.</td></tr>
    </tbody></table>
    <div style="margin-top:6px">탭을 뒤로 보내면 전부 멈춥니다. 다시 앞으로 오면 곧바로 한 번 읽습니다.</div>`;
}

function beat() {
  const tick = async () => {
    if (document.hidden || !sess) return;
    try {
      await loadLive();
      if (Date.now() - S.lastFull > TICK_FULL) await loadAll();
      S.failed = 0;
    } catch (e) {
      S.failed++;
      if (/세션|no session/.test(e.message)) return gate();
    }
    paintLive();
  };
  setInterval(tick, TICK_LIVE);
  setInterval(paintLive, 1000);
  document.addEventListener('visibilitychange', () => { paintLive(); if (!document.hidden) tick(); });
  tick();
  RT.connect();
}

/* ══ 뼈대 ══════════════════════════════════════════════ */
function gate() {
  RT.stop();
  $('#app').hidden = true;
  $('#gate').style.display = 'grid';
  clearSession();
}

async function enter() {
  $('#gate').style.display = 'none';
  $('#app').hidden = false;
  try { await loadAll(); }
  catch (e) {
    if (/42501|admin only|permission/.test(e.message)) {
      toast('이 계정은 운영자가 아닙니다');
      return gate();
    }
    toast(e.message);
  }
  beat();
}

$('#loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const b = $('#loginBtn'); b.disabled = true;
  $('#loginErr').textContent = '';
  try {
    await login($('#email').value.trim(), $('#pw').value);
    await enter();
  } catch (e) { $('#loginErr').textContent = e.message; }
  finally { b.disabled = false; }
});

$('#logoutBtn').onclick = () => { gate(); location.reload(); };
$('#refreshBtn').onclick = async () => {
  $('#refreshBtn').disabled = true;
  try { await loadAll(); toast('전부 다시 읽었습니다'); }
  catch (e) { toast(e.message); }
  finally { $('#refreshBtn').disabled = false; }
};
$('#liveChip').onclick = () => {
  const el = $('#liveDetail');
  el.hidden = !el.hidden;
  if (!el.hidden) renderLiveDetail();
};
$('#seriesDays').onchange = async () => {
  S.series = await rpc('ae_ops_series', { p_days: Number($('#seriesDays').value) });
  renderSeries();
};
$('#coupleGrp').onchange = renderCouples;
$('#hideEmpty').onchange = renderCouples;
$('#showAllCols').onchange = renderCouples;
$('#tierSel').onchange = loadUsers;

let qTimer = null;
$('#userQ').oninput = () => { clearTimeout(qTimer); qTimer = setTimeout(loadUsers, 300); };

$$('#tabs button').forEach((b) => b.onclick = () => {
  S.tab = b.dataset.tab;
  $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $$('main section').forEach((s) => s.classList.toggle('on', s.id === S.tab));
});

/* 들어와 있던 세션이 있으면 바로 연다. */
if (sess?.refresh_token) {
  refresh().then(enter).catch(gate);
} else {
  gate();
}

/* 애톡 운영 콘솔.
 *
 * 앱을 다시 내지 않고도 고칠 수 있어야 해서 웹으로 뺐다. 화면은 서버 함수
 * (ae_ops_*)가 돌려주는 것만 그린다 — **여기서 다시 세지 않는다.** 두 곳에서
 * 세면 같은 화면 안에서 숫자가 어긋나고, 어느 쪽이 맞는지 영영 모른다.
 *
 * 권한은 전부 DB 가 지킨다. 이 파일은 누구나 받아 볼 수 있지만, 관리자
 * 토큰이 없으면 함수가 42501 로 거절한다.
 */
'use strict';

const SUPA = 'https://hzdzbxhqezqszjputpzo.supabase.co';
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
  users: null, tickets: null, config: null, live: null, retention: null, audit: null,
  ticketId: null, userId: null,
  coupleSort: 'last_talk', coupleDesc: true,
  contentSort: 'total', contentDesc: true,
  lastFull: 0, lastLive: 0, failed: 0,
};

/* ══ 요약 ══════════════════════════════════════════════ */
const ACT_LABEL = {
  message: '메시지', attend: '출석', checkin: '체크인', balance: '밸런스',
  answer: '질문 답', know: '서로 알기', gift: '선물 참모', buy: '아이템 구매',
  reaction: '반응', ticket: '문의',
};

function renderLive() {
  const L = S.live, O = S.overview;
  if (!L) return;
  const u = O?.usage || {};
  const dY = Number(u.dau_yesterday || 0);
  const dT = Number(L.dau || 0);
  const diff = dT - dY;
  const tiles = [
    ['지금 접속', n(L.online), '채팅·게임 화면을 켜 둔 사람'],
    ['오늘 움직인 사람', n(L.dau),
      dY ? `<span class="${diff >= 0 ? 'up' : 'down'}">어제 이맘때까지 아니라 어제 하루 ${n(dY)}명</span>` : ''],
    ['오늘 메시지', n(L.msgs_today), `최근 5분 ${n(L.msgs_5m)}건`],
    ['오늘 가입', n(L.signups_today), '<span class="muted">아래 단계로 갈라 봅니다</span>'],
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

function renderTiers() {
  const p = S.overview?.people; if (!p) return;
  const parts = [
    ['active', '활동', 'var(--good)', p.active],
    ['paired', '연결만', 'var(--pink)', p.paired],
    ['visited', '둘러봄', 'var(--blue)', p.visited],
    ['signup', '가입만', 'var(--ink3)', p.signup],
  ];
  const tot = parts.reduce((a, x) => a + Number(x[3] || 0), 0) || 1;
  // **단계를 더해서 「이어진 사람」을 만들면 안 된다.** 활동 단계에는 커플이
  // 없는 사람도 들어 있어서 퍼널의 「커플 연결」과 어긋난다(실측 23 vs 21).
  const real = Number(S.overview?.funnel?.paired || 0);
  $('#tiers').innerHTML = `
    <div class="row2" style="margin-bottom:10px">
      <div><div class="k muted small">계정</div><div class="v" style="font-size:26px;font-weight:700">${n(p.total)}</div></div>
      <div style="margin-left:18px"><div class="k muted small">이 중 커플로 이어진 사람</div>
        <div class="v" style="font-size:26px;font-weight:700;color:var(--pink)">${n(real)}</div></div>
      <div style="margin-left:18px"><div class="k muted small">30일 안에 뭔가 한 사람</div>
        <div class="v" style="font-size:26px;font-weight:700;color:var(--good)">${n(p.active)}</div></div>
    </div>
    <div class="stack">${parts.map(([, , c, v]) => {
      const w = (Number(v || 0) / tot) * 100;
      return w <= 0 ? '' : `<div style="width:${w}%;background:${c}" title="${n(v)}">${w > 7 ? n(v) : ''}</div>`;
    }).join('')}</div>
    <div class="legend">${parts.map(([, l, c, v]) =>
      `<span><i style="background:${c}"></i>${l} ${n(v)}</span>`).join('')}</div>
    <div class="small muted" style="margin-top:10px">
      가입만 = 커플도 없고 기기 등록도 없고 아무 흔적도 없는 계정.
      최근 7일 신규 ${n(p.new_7d)}명 · 오늘 ${n(p.new_today)}명.
    </div>
    <div class="grid g2" style="margin-top:12px">
      <div><div class="muted small" style="margin-bottom:4px">가입 경로</div>${kv(p.by_provider)}</div>
      <div><div class="muted small" style="margin-bottom:4px">이어진 사람 · 나이</div>${kv(p.by_age)}</div>
    </div>`;
}

function kv(obj) {
  const e = Object.entries(obj || {}).sort((a, b) => Number(b[1]) - Number(a[1]));
  if (!e.length) return '<span class="muted small">아직 없어요</span>';
  return `<dl class="kv">${e.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${n(v)}</dd>`).join('')}</dl>`;
}

function renderFunnel() {
  const f = S.overview?.funnel; if (!f) return;
  const steps = [
    ['가입', f.signed], ['앱 열어봄', f.opened], ['커플 연결', f.paired],
    ['대화 시작', f.talked], ['7일 내 활동', f.kept_7d], ['하트 결제', f.paid],
  ];
  const top = Number(f.signed || 0) || 1;
  let prev = null;
  $('#funnel').innerHTML = steps.map(([k, v]) => {
    const val = Number(v || 0);
    const pct = (val / top) * 100;
    const drop = prev === null || prev === 0 ? '' :
      `<span class="muted"> · ${Math.round((val / prev) * 100)}%</span>`;
    prev = val;
    return `<div class="row"><span class="muted">${k}</span>
      <div class="track"><div class="fill" style="width:${Math.max(pct, 0.6)}%"></div></div>
      <span class="n">${n(val)}${drop}</span></div>`;
  }).join('');
}

/* 작은 면적 그래프. 라이브러리를 안 쓴다 — 이 화면은 바깥에서 아무것도
   받아 오지 않아야 열린다. */
function spark(rows, key, label, color) {
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
    <div class="small muted">기간 합계 ${n(sum)} · 최고 ${n(max)}</div>
  </div>`;
}

function renderSeries() {
  const rows = S.series || [];
  if (!rows.length) { $('#chart').innerHTML = '<span class="muted small">자료가 없어요</span>'; return; }
  $('#seriesNote').textContent =
    `${rows[0].d} ~ ${rows[rows.length - 1].d} · 한국 시간 자정 기준`;
  $('#chart').innerHTML = `<div class="grid g2">
    ${spark(rows, 'signups', '가입', 'var(--ink3)')}
    ${spark(rows, 'dau', '움직인 사람', 'var(--good)')}
    ${spark(rows, 'talkers', '말한 사람', 'var(--blue)')}
    ${spark(rows, 'messages', '메시지', 'var(--pink)')}
    ${spark(rows, 'hearts_spent', '하트 소모', 'var(--warn)')}
    ${spark(rows, 'ai_calls', '비서 호출', 'var(--blue)')}
  </div>`;
}

function renderMoney() {
  const m = S.overview?.money; if (!m) return;
  const prices = m.heart_prices || {};
  const hasPrice = Object.keys(prices).length > 0;
  const subs = (m.subs || []).map((s) =>
    `<span class="pill ${s.env === 'Production' ? 'good' : 'warn'}">${esc(s.env)} · ${esc(s.status)} ${n(s.n)}</span>`).join(' ');
  const sandboxOnly = Number(m.subs_live_prod || 0) === 0 && Number(m.subs_live_sandbox || 0) > 0;

  $('#money').innerHTML = `
    <div class="grid g4" style="margin-bottom:12px">
      <div class="tile"><div class="k">충전된 하트</div><div class="v">${n(m.hearts_bought)}</div>
        <div class="d">${n(m.heart_orders)}건 · 30일 ${n(m.heart_orders_30d)}건</div></div>
      <div class="tile"><div class="k">쓴 하트</div><div class="v">${n(m.hearts_spent)}</div>
        <div class="d">주고받은 건 뺐습니다</div></div>
      <div class="tile"><div class="k">남은 하트</div><div class="v">${n(m.hearts_held)}</div>
        <div class="d">모든 커플 지갑 합</div></div>
      <div class="tile"><div class="k">리포트 판매</div><div class="v">${n(m.reports_sold)}</div>
        <div class="d">인앱결제 + 하트</div></div>
    </div>
    <div class="row2" style="margin-bottom:8px">
      <span class="muted small">구독</span>${subs || '<span class="muted small">없음</span>'}
    </div>
    ${sandboxOnly ? `<div class="small" style="color:var(--warn)">
      살아 있는 구독이 전부 <b>샌드박스</b>입니다 — 실제 매출은 아직 0원입니다.</div>` : ''}
    ${hasPrice ? '' : `<div class="small muted" style="margin-top:6px">
      하트 팩 가격이 설정에 없어서 원 단위로 환산하지 않았습니다.
      설정 탭의 <span class="mono">heart_prices</span> 에 상품별 가격을 넣으면 매출로 보여 줍니다.</div>`}
    <div style="margin-top:12px"><div class="muted small" style="margin-bottom:4px">무엇에 썼나</div>
      ${kv(m.spend_by_reason)}</div>`;
}

function renderAi() {
  const a = S.overview?.ai; if (!a) return;
  const noCost = Number(a.cost_30d_usd || 0) === 0 && Number(a.calls_30d || 0) > 0;
  const h = a.health || {};
  $('#ai').innerHTML = `
    <div class="grid g4" style="margin-bottom:10px">
      <div class="tile"><div class="k">30일 호출</div><div class="v">${n(a.calls_30d)}</div>
        <div class="d">오늘 ${n(a.calls_today)}</div></div>
      <div class="tile"><div class="k">30일 대화</div><div class="v">${n(a.chat_30d)}</div>
        <div class="d">비서와 나눈 말</div></div>
      <div class="tile"><div class="k">토큰(넣은/받은)</div>
        <div class="v" style="font-size:18px">${n(a.in_30d)} / ${n(a.out_30d)}</div>
        <div class="d">캐시 ${n(a.cached_30d)}</div></div>
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
           <span class="small" style="color:var(--warn)">
             ${esc(h.wanted || '본래 모델')} 대신 ${esc(h.used || '대체 모델')} 로 답하고 있습니다
             ${h.why ? `(${esc(h.why)})` : ''} — 값이 몇 배로 뜁니다. 키부터 확인하세요.</span>`
        : `<span class="pill good">본래 모델로 돌고 있다</span>
           <span class="small muted">글은 OpenAI 가 씁니다.
             키가 비면 앱이 깜깜해지지 않게 <b>대체 모델</b>로 조용히 넘어가는데(값은 몇 배),
             지금은 넘어간 적이 없습니다${h.last_at ? ` · 마지막 대체 ${clock(h.last_at)}` : ''}.</span>`}
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
      <dt>기기</dt><dd>${n(s.devices)}</dd>
      ${Object.entries(s.devices_by_platform || {}).map(([k, v]) =>
        `<dt class="small">· ${esc(k)}</dt><dd class="small">${n(v)}</dd>`).join('')}
      <dt>멈춘 작업</dt><dd class="${stuck ? 'down' : ''}">${n(stuck)}</dd>
      <dt>만들다 만 코스</dt><dd>${n(p.course)} <span class="muted small">(실패 ${n(p.course_failed)})</span></dd>
      <dt>만들다 만 여행</dt><dd>${n(p.trip)} <span class="muted small">(실패 ${n(p.trip_failed)})</span></dd>
      <dt>만들다 만 2세</dt><dd>${n(p.child)}</dd>
      <dt>만들다 만 리포트</dt><dd>${n(p.report)}</dd>
    </dl>
    <div style="margin-top:10px" class="small">
      <span class="muted">공지</span>
      ${notice ? `<div class="mono" style="margin-top:4px">${esc(JSON.stringify(notice))}</div>`
               : ' <span class="muted">없음</span>'}
    </div>
    <div style="margin-top:8px" class="small">
      <span class="muted">플래그</span>
      <div class="mono" style="margin-top:4px">${esc(JSON.stringify(s.flags || {}))}</div>
    </div>`;
}

function renderRetention() {
  const d = S.retention; if (!d) return;
  const weeks = d.weeks || [];
  if (!weeks.length) { $('#retention').innerHTML = '<span class="muted small">아직 자료가 없어요</span>'; return; }
  const maxK = Math.max(...weeks.map((w) => (w.r || []).length));
  const heat = (pct) => pct <= 0 ? 'transparent'
    : `rgba(255,92,138,${(0.12 + 0.75 * Math.min(pct, 1)).toFixed(2)})`;
  $('#retention').innerHTML = `<div class="tblwrap"><table>
    <thead><tr><th class="noSort">가입한 주</th><th class="noSort">인원</th>
      ${Array.from({ length: maxK }, (_, k) => `<th class="noSort">${k === 0 ? '그 주' : `+${k}주`}</th>`).join('')}
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
    <div class="small muted" style="margin-top:8px">${esc(d.note || '')} ·
      「그 주」가 인원보다 훨씬 작으면 <b>가입하고 아무것도 안 한 사람</b>이 그만큼이라는 뜻입니다.</div>`;
}

const ORIGIN = {
  organic:  ['바깥 손님', 'good',  '우리가 만들지 않은 계정'],
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
    ${risky
      ? `<div class="small" style="color:var(--warn);margin-top:8px">
           뭉텅이로 분류됐는데 실제로 쓴 계정이 ${risky}개 있습니다 — 규칙이 사람을 잡아먹고 있습니다.
           ${(a.bulk_but_active || []).map((x) => esc(x.name || x.email)).join(', ')}</div>`
      : `<div class="small muted" style="margin-top:8px">
           뭉텅이로 분류된 계정 중 실제로 쓴 것은 <b>하나도 없습니다</b> — 규칙이 사람을 잘못 지우고 있지 않습니다.
           <br>잣대: 내부 <span class="mono">${esc(a.rules?.internal_email || '')}</span>
           · 뭉텅이 <span class="mono">${esc(a.rules?.bulk_email || '')}</span>
           (설정 탭의 <span class="mono">signup_audit</span> 에서 고칩니다)</div>`}`;
}

/* ══ 사람 ══════════════════════════════════════════════ */
const TIER = {
  active: ['활동', 'good'], paired: ['연결만', 'pink'],
  visited: ['둘러봄', 'warn'], signup: ['가입만', ''],
};

function renderUsers() {
  const d = S.users; if (!d) return;
  $('#userCount').textContent = `${n(d.total)}명`;
  const head = ['이름', '단계', '경로', '커플', '메시지', '행동', '마지막 활동', '가입'];
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
  $$('#userTbl tbody tr').forEach((tr) =>
    tr.onclick = () => openUser(tr.dataset.id));
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
        <dt>이메일</dt><dd class="small">${esc(w.email || '—')}</dd>
        <dt>경로</dt><dd class="small">${esc(w.provider || '?')}</dd>
        <dt>성별 · 생일</dt><dd class="small">${esc(w.gender || '—')} · ${esc(w.birthday || '—')}</dd>
        <dt>가입</dt><dd class="small">${clock(w.joined)}</dd>
        <dt>마지막 로그인</dt><dd class="small">${clock(w.last_sign_in)}</dd>
        <dt>마지막 활동</dt><dd class="small">${clock(w.last_act)}</dd>
        <dt>등록 기기</dt><dd>${n(w.devices)}</dd>
        <dt>메시지</dt><dd>${n(w.msgs)}</dd>
        <dt>행동(30일)</dt><dd>${n(w.acts_30d)} / ${n(w.acts)}</dd>
      </dl>
      <div style="margin-top:12px"><div class="muted small" style="margin-bottom:4px">무엇을 했나</div>
        ${kv(Object.fromEntries(Object.entries(d.acts_by_kind || {})
          .map(([k, v]) => [ACT_LABEL[k] || k, v])))}</div>
      <div style="margin-top:12px"><div class="muted small" style="margin-bottom:4px">하트 원장</div>
        ${(d.hearts || []).length ? `<div class="tblwrap"><table><tbody>${
          d.hearts.map((h) => `<tr><td class="small">${clock(h.created_at)}</td>
            <td class="small">${esc(h.memo || h.reason)}</td>
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
    sel.innerHTML = `<option value="">모든 갈래</option>` +
      grps.map((g) => `<option>${esc(g)}</option>`).join('');
  }
  const grp = sel.value;
  // **아무 커플도 안 쓴 컨텐츠는 열을 만들지 않는다.** 서른여덟 칸을 다
  // 그리면 표가 옆으로 흘러서 정작 볼 숫자를 못 찾는다.
  const used = new Set();
  for (const r of d.rows || []) {
    for (const [k, v] of Object.entries(r.counts || {})) if (Number(v) > 0) used.add(k);
  }
  const cols = srcs.filter((s) => (!grp || s.grp === grp) && (used.has(s.key) || $('#showAllCols').checked));

  let rows = [...(d.rows || [])];
  $('#coupleNote').textContent = `${rows.length}쌍`;
  if ($('#hideEmpty').checked) {
    rows = rows.filter((r) => Object.values(r.counts || {}).some((v) => Number(v) > 0));
  }
  const val = (r, k) => {
    if (k in r) return r[k];
    return Number(r.counts?.[k] || 0);
  };
  rows.sort((a, b) => {
    const x = val(a, S.coupleSort), y = val(b, S.coupleSort);
    const c = (x === null || x === undefined ? -Infinity : (typeof x === 'string' ? new Date(x).getTime() || 0 : Number(x)))
            - (y === null || y === undefined ? -Infinity : (typeof y === 'string' ? new Date(y).getTime() || 0 : Number(y)));
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
      const plan = r.plan === 'free'
        ? '<span class="pill">무료</span>' : `<span class="pill pink">${esc(r.plan)}</span>`;
      return `<tr>
        <td>${who} ${r.status !== 'active' ? `<span class="pill">${esc(r.status)}</span>` : ''}</td>
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

/* ══ 컨텐츠 ════════════════════════════════════════════ */
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
    <thead><tr><th class="noSort">컨텐츠</th><th class="noSort">갈래</th>
      ${cols.map(([k, l]) => `<th data-k="${k}">${l}${arrow(k)}</th>`).join('')}
      <th class="noSort" style="width:130px">30일</th></tr></thead>
    <tbody>${rows.map((r) => {
      const w = (Number(r.d30 || 0) / maxD30) * 100;
      return `<tr>
        <td>${esc(r.label)}</td>
        <td class="small muted">${esc(r.grp)}</td>
        ${cols.map(([k]) => {
          const v = Number(r[k] || 0);
          if (!r.timed && k !== 'total') return '<td class="muted small">—</td>';
          return `<td class="num ${v ? '' : 'zero'}">${v ? n(v) : '·'}</td>`;
        }).join('')}
        <td><div class="track" style="background:var(--panel2);border-radius:5px;height:9px">
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
    el.onclick = () => { S.ticketId = el.dataset.id; renderTickets(); renderTicket(); });
  if (!S.ticketId && list.length) { S.ticketId = list[0].id; renderTicket(); }
  else if (S.ticketId) renderTicket();
}

function renderTicket() {
  const t = (S.tickets || []).find((x) => x.id === S.ticketId);
  if (!t) { $('#ticketPane').innerHTML = '<span class="muted small">왼쪽에서 문의를 고르세요.</span>'; return; }
  const [l, c] = TSTATUS[t.status] || [t.status, ''];
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
    <textarea id="replyBox" placeholder="답장을 씁니다. 보내면 사용자 화면에 바로 뜹니다."></textarea>
    <div class="row2" style="margin-top:8px">
      <button class="btn" id="sendReply" type="button">답장 보내기</button>
      <button class="btn ghost" data-st="closed" type="button">닫기</button>
      <button class="btn ghost" data-st="open" type="button">다시 열기</button>
      <span class="err small" id="replyErr"></span>
    </div>`;

  $('#sendReply').onclick = async () => {
    const body = $('#replyBox').value.trim();
    if (!body) return;
    $('#sendReply').disabled = true;
    try {
      await rpc('ae_ops_reply', { p_ticket: t.id, p_body: body });
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

/* ══ 설정 ══════════════════════════════════════════════ */
const CONFIG_HELP = {
  min_build: '이 빌드보다 낮으면 앱이 업데이트를 요구합니다.',
  notice: '앱 안에 뜨는 공지.',
  flags: '기능 스위치. ad_banner 는 명시적으로 true 여야 켜집니다.',
  heart_prices: '하트 팩 상품별 원 가격. 넣으면 요약의 돈이 원으로 환산됩니다.',
  limits: '무료 사용 한도.',
};

function renderConfig() {
  const c = S.config; if (!c) return;
  const keys = Object.keys(c).sort();
  $('#configList').innerHTML = keys.map((k) => `
    <div style="border-bottom:1px solid var(--line);padding:12px 0">
      <div class="row2">
        <b class="mono">${esc(k)}</b>
        <span class="muted small">${esc(CONFIG_HELP[k] || '')}</span>
        <span class="spacer"></span>
        <span class="muted small">${ago(c[k].updated_at)}</span>
      </div>
      <textarea class="mono" data-k="${esc(k)}" style="margin-top:6px"
        >${esc(JSON.stringify(c[k].value, null, 2))}</textarea>
      <div class="row2" style="margin-top:6px">
        <button class="btn ghost" data-save="${esc(k)}" type="button">저장</button>
        <span class="err small" data-err="${esc(k)}"></span>
      </div>
    </div>`).join('');

  $$('#configList button[data-save]').forEach((b) => b.onclick = async () => {
    const k = b.dataset.save;
    const ta = $(`#configList textarea[data-k="${CSS.escape(k)}"]`);
    const err = $(`#configList [data-err="${CSS.escape(k)}"]`);
    err.textContent = '';
    let v;
    try { v = JSON.parse(ta.value); }
    catch { err.textContent = 'JSON 형식이 아닙니다'; return; }
    b.disabled = true;
    try {
      await rpc('ae_ops_set_config', { p_key: k, p_value: v });
      toast(`${k} 저장했습니다`);
      S.config = await rpc('ae_ops_config');
    } catch (e) { err.textContent = e.message; }
    finally { b.disabled = false; }
  });
}

/* ══ 불러오기 ══════════════════════════════════════════ */
async function loadLive() {
  S.live = await rpc('ae_ops_live');
  S.lastLive = Date.now();
  renderLive();
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
  renderRetention(); renderAudit(); renderLive();
  await Promise.all([loadUsers(), loadTickets()]);
}

/* 심장 박동. 가벼운 것은 자주, 무거운 것은 가끔.
   **화면이 안 보일 때는 아무것도 안 부른다** — 켜 둔 탭이 조용히
   요금을 만들면 안 된다. */
function beat() {
  const dot = $('#liveDot'), txt = $('#liveTxt');
  const tick = async () => {
    if (document.hidden || !sess) return;
    try {
      await loadLive();
      if (Date.now() - S.lastFull > 60e3) await loadAll();
      S.failed = 0;
      dot.className = 'dot on';
    } catch (e) {
      S.failed++;
      dot.className = S.failed > 2 ? 'dot off' : 'dot stale';
      if (/세션|no session/.test(e.message)) return gate();
    }
  };
  setInterval(tick, 8000);
  setInterval(() => {
    if (!S.lastLive) return;
    const s = Math.round((Date.now() - S.lastLive) / 1000);
    txt.textContent = document.hidden ? '멈춤(탭이 뒤에 있음)' :
      (s < 10 ? '실시간' : `${s}초 전`);
    if (!document.hidden && s > 40) $('#liveDot').className = 'dot stale';
  }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  tick();
}

/* ══ 뼈대 ══════════════════════════════════════════════ */
function gate() {
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
  try { await loadAll(); toast('새로 읽었습니다'); }
  catch (e) { toast(e.message); }
  finally { $('#refreshBtn').disabled = false; }
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

/* 운영 기록과 테스트 대화. app.js보다 먼저 읽되, DOM 연결은 wireLog/wireDump에서 한다. */
'use strict';

const LOG = {
  couple: null, who: '', grp: '', size: 100, page: 0, total: 0, rows: [],
  request: 0, loading: false, error: '',
};
const DUMP = {
  couple: null, size: 50, page: 0, total: 0, rows: [], visibleRows: [],
  snapshot: null, request: 0, loading: false, error: '', query: '',
};
const recordPagerFocus = new WeakMap();

function recordTotal(value) {
  const total = Number(value);
  return Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
}

function scrollRecords(id) {
  const el = $(id);
  if (!el) return;
  const scroller = id === '#logTbl' ? el.closest('.data-scroll') || el : el;
  scroller.scrollTop = 0;
  // 쪽 이동은 목록 안에서만 움직인다. 처음 여는 행동 기록 카드만 화면으로 가져온다.
  if (id === '#logCard') el.scrollIntoView({ behavior: 'auto', block: 'start' });
}

// 두 고르개는 같은 상태를 사용한다. 쪽 숫자는 언제나 1부터 최신순이다.
function renderRecordPager(prefix, state, move) {
  const pages = Math.max(1, Math.ceil(state.total / state.size));
  const targets = [0, pages - 1];
  for (let p = state.page - 2; p <= state.page + 2; p++) {
    if (p >= 0 && p < pages) targets.push(p);
  }
  const numbered = [...new Set(targets)].sort((a, b) => a - b);
  const button = (page, label, disabled = false, current = false, action = `page-${page}`) =>
    `<button type="button" class="btn ghost${current ? ' is-current' : ''}" data-page="${page}" data-action="${action}"`
    + `${disabled || state.loading ? ' disabled' : ''}${current ? ' aria-current="page"' : ''}>${label}</button>`;
  const from = state.total ? state.page * state.size + 1 : 0;
  const to = Math.min(state.total, (state.page + 1) * state.size);
  const html = state.total || state.loading ? `
    <span class="pager-summary">${n(state.total)}개 중 ${n(from)}–${n(to)} · ${n(state.page + 1)}/${n(pages)}쪽</span>
    <div class="pager-controls" aria-label="${prefix === 'dump' ? '대화' : '기록'} 쪽 이동">
      ${button(0, '처음', state.page === 0, false, 'first')}
      ${button(state.page - 1, '← 더 최근', state.page === 0, false, 'prev')}
      ${numbered.map((p, i) => `${i && p - numbered[i - 1] > 1 ? '<span class="pager-gap">…</span>' : ''}`
        + button(p, p === 0 ? '1 최신' : n(p + 1), p === state.page, p === state.page)).join('')}
      ${button(state.page + 1, '더 이전 →', state.page + 1 >= pages, false, 'next')}
      ${button(pages - 1, '마지막', state.page + 1 >= pages, false, 'last')}
    </div>` : '';
  for (const id of [`#${prefix}PagerTop`, `#${prefix}Pager`]) {
    const pager = $(id);
    if (!pager) continue;
    const active = document.activeElement;
    const hadFocus = Boolean(active && pager.contains(active));
    if (hadFocus && active.dataset?.action) recordPagerFocus.set(pager, active.dataset.action);
    pager.setAttribute('tabindex', '-1');
    pager.setAttribute('role', 'navigation');
    pager.setAttribute('aria-label', `${prefix === 'dump' ? '대화' : prefix === 'user' ? '사용자' : '기록'} 쪽 이동`);
    pager.innerHTML = html;
    const controls = $$('button[data-page]', pager);
    controls.forEach((b) => {
      b.onclick = () => {
        const page = Number(b.dataset.page);
        if (state.loading || b.disabled || page === state.page || page < 0 || page >= pages) return;
        move(page);
      };
    });
    if (hadFocus) {
      // 로딩 중에는 사라지지 않는 탐색 영역에, 완료 후에는 같은 동작에 초점을 둔다.
      // 그 사이 다른 입력으로 옮긴 초점은 가져오지 않는다.
      const control = !state.loading && controls.find((b) =>
        b.dataset.action === recordPagerFocus.get(pager) && !b.disabled);
      const fallback = html ? pager : prefix === 'dump' ? $('#dumpMessages')
        : $(`#${prefix}Tbl`)?.closest('.data-scroll');
      (control || fallback)?.focus({ preventScroll: true });
    }
  }
}

/* 행동 기록에는 대화 원문을 포함하지 않는다. 기존 RPC의 최신순을 유지한다. */
async function openLog(id, who) {
  if (!id) return;
  LOG.couple = id; LOG.who = who || ''; LOG.page = 0; LOG.total = 0;
  $('#logCard').hidden = false;
  $('#logWho').textContent = LOG.who;
  const groups = [...new Set((S.couples?.sources || []).map((c) => c.grp))];
  $('#logGrp').innerHTML = '<option value="">모든 갈래</option>'
    + groups.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
  if (!groups.includes(LOG.grp)) LOG.grp = '';
  $('#logGrp').value = LOG.grp;
  if (await loadLog()) scrollRecords('#logCard');
}

async function loadLog({ scroll = false, corrections = 0 } = {}) {
  const request = ++LOG.request;
  LOG.rows = []; LOG.error = ''; LOG.loading = Boolean(LOG.couple);
  renderLog();
  if (scroll) scrollRecords('#logTbl');
  if (!LOG.couple) return false;
  const args = {
    p_couple: LOG.couple, p_limit: LOG.size, p_offset: LOG.page * LOG.size,
    p_group: LOG.grp || null,
  };
  try {
    const data = await rpc('ae_ops_couple_log', args);
    if (request !== LOG.request) return false;
    LOG.total = recordTotal(data?.total);
    const lastPage = Math.max(0, Math.ceil(LOG.total / LOG.size) - 1);
    if (LOG.page > lastPage) {
      // 삭제가 연속해서 일어나도 최대 두 번 보정한 뒤 첫 쪽에 도착한다.
      LOG.page = corrections ? 0 : lastPage;
      return loadLog({ scroll, corrections: corrections + 1 });
    }
    LOG.rows = Array.isArray(data?.rows) ? data.rows : [];
    LOG.loading = false;
    renderLog();
    return true;
  } catch (error) {
    if (request !== LOG.request) return false;
    LOG.loading = false; LOG.total = 0; LOG.error = String(error);
    renderLog();
    return false;
  }
}

function renderLog() {
  const table = $('#logTbl');
  if (LOG.loading || LOG.error || !LOG.rows.length) {
    const message = LOG.loading ? '기록을 읽는 중…' : LOG.error
      ? `기록을 읽지 못했습니다 — ${LOG.error}` : '이 갈래에는 기록이 없습니다.';
    table.innerHTML = `<tbody><tr><td colspan="5"><div class="empty-state">${esc(message)}</div></td></tr></tbody>`;
  } else {
    table.innerHTML = `
      <thead><tr><th>시각</th><th>갈래</th><th>활동</th><th>사용자</th><th>상세</th></tr></thead>
      <tbody>${LOG.rows.map((r) => `<tr>
        <td class="small muted" title="${esc(r.at)}">${esc(clock(r.at))}</td>
        <td class="small"><span class="pill">${esc(r.grp || '')}</span></td>
        <td>${esc(r.label || '')}</td>
        <td class="small">${esc(r.who || '—')}</td>
        <td class="small">${esc(r.detail || '—')}</td>
      </tr>`).join('')}</tbody>`;
  }
  renderRecordPager('log', LOG, (page) => { LOG.page = page; loadLog({ scroll: true }); });
}

function wireLog() {
  const group = $('#logGrp'), size = $('#logSize'), close = $('#logClose');
  if (group) group.onchange = () => {
    LOG.grp = group.value; LOG.page = 0; LOG.total = 0; loadLog({ scroll: true });
  };
  if (size) size.onchange = () => {
    LOG.size = Math.min(500, Math.max(1, Number(size.value) || 100));
    LOG.page = 0; LOG.total = 0; loadLog({ scroll: true });
  };
  if (close) close.onclick = () => {
    ++LOG.request; LOG.couple = null; LOG.rows = []; LOG.loading = false;
    $('#logCard').hidden = true;
  };
}

/* 대화 원문은 커플을 직접 고르거나 새로 읽기를 눌렀을 때만 요청한다. */
function fillDumpCouples() {
  const select = $('#dumpCouple');
  if (!select) return;
  const list = (S.couples?.rows || []).filter((r) => r.id)
    .map((r) => ({ id: r.id, who: (r.people || []).map((p) => p.name).join(' · ') || '빈 방' }));
  select.innerHTML = '<option value="">커플을 고르세요</option>'
    + list.map((r) => `<option value="${esc(r.id)}">${esc(r.who)}</option>`).join('');
  if (DUMP.couple && !list.some((r) => r.id === DUMP.couple)) {
    resetDump(null);
    loadDump();
  }
  select.value = DUMP.couple || '';
}

function resetDump(couple = DUMP.couple) {
  DUMP.couple = couple; DUMP.page = 0; DUMP.total = 0; DUMP.snapshot = null;
  DUMP.query = '';
  const search = $('#dumpSearch');
  if (search) search.value = '';
}

async function loadDump({ scroll = false, corrections = 0 } = {}) {
  const request = ++DUMP.request;
  DUMP.rows = []; DUMP.visibleRows = []; DUMP.error = '';
  DUMP.loading = Boolean(DUMP.couple);
  renderDump();
  if (scroll) scrollRecords('#dumpMessages');
  if (!DUMP.couple) { DUMP.total = 0; DUMP.snapshot = null; renderDump(); return false; }
  const args = {
    p_couple: DUMP.couple, p_limit: DUMP.size, p_offset: DUMP.page * DUMP.size,
    p_snapshot: DUMP.snapshot,
  };
  try {
    const data = await rpc('ae_ops_chat_dump_v2', args);
    if (request !== DUMP.request) return false;
    if (data?.order !== 'newest_first' || !data.snapshot || !Number.isFinite(Date.parse(data.snapshot))) {
      throw new Error('최신순 대화 조회 응답을 확인할 수 없습니다. 서버 함수 배포를 확인해 주세요.');
    }
    DUMP.snapshot = data.snapshot;
    DUMP.total = recordTotal(data.total);
    const lastPage = Math.max(0, Math.ceil(DUMP.total / DUMP.size) - 1);
    if (DUMP.page > lastPage) {
      DUMP.page = corrections ? 0 : lastPage;
      return loadDump({ scroll, corrections: corrections + 1 });
    }
    // 서버가 전체에서 최신 쪽을 고른다. 클라이언트에서 일부 행만 뒤집지 않는다.
    DUMP.rows = Array.isArray(data.rows) ? data.rows : [];
    DUMP.loading = false;
    renderDump();
    return true;
  } catch (error) {
    if (request !== DUMP.request) return false;
    DUMP.loading = false; DUMP.total = 0; DUMP.error = String(error);
    renderDump();
    return false;
  }
}

function messageKind(type) {
  return ({ text: '텍스트', ai: '비서 답변', image: '사진', video: '영상', audio: '음성',
    sticker: '스티커', location: '위치', system: '시스템', file: '파일' })[type] || type || '메시지';
}

function messageBody(row) {
  if (row.body !== null && row.body !== undefined && String(row.body).trim()) return String(row.body);
  return ['text', 'ai', 'system'].includes(row.type)
    ? '텍스트 내용이 없습니다.' : `${messageKind(row.type)} 첨부`;
}

function filteredDumpRows() {
  const query = DUMP.query.trim().toLocaleLowerCase('ko-KR');
  return query ? DUMP.rows.filter((r) =>
    [r.who, messageBody(r), messageKind(r.type), r.ai ? '비서' : '', r.trio ? '셋이서' : '']
      .join(' ').toLocaleLowerCase('ko-KR').includes(query)) : DUMP.rows;
}

function renderDump() {
  const container = $('#dumpMessages');
  const selectedName = $('#dumpCouple')?.selectedOptions?.[0]?.textContent || '';
  $('#dumpNote').textContent = DUMP.couple ? selectedName : '';
  DUMP.visibleRows = DUMP.loading || DUMP.error ? [] : filteredDumpRows();
  const copy = $('#dumpCopy'), refresh = $('#dumpRefresh'), search = $('#dumpSearch');
  if (copy) {
    copy.disabled = DUMP.loading || Boolean(DUMP.error) || !DUMP.visibleRows.length;
    copy.textContent = DUMP.query.trim() ? '검색 결과 복사' : '이 페이지 복사';
  }
  if (refresh) refresh.disabled = !DUMP.couple;
  if (search) search.disabled = !DUMP.couple || DUMP.loading || Boolean(DUMP.error);
  container.setAttribute('aria-busy', String(DUMP.loading));
  const status = $('#dumpStatus');
  if (status) status.textContent = DUMP.loading ? '대화를 읽는 중…' : DUMP.error ? '조회 실패'
    : !DUMP.couple ? '커플을 선택하면 대화를 불러옵니다.'
    : DUMP.query.trim() ? `이 쪽 ${n(DUMP.rows.length)}개 중 ${n(DUMP.visibleRows.length)}개 검색됨 · 검색 범위: 현재 쪽`
    : `전체 ${n(DUMP.total)}개 · 최신순 · 1쪽이 가장 최근 대화입니다.${DUMP.snapshot ? ' 새 대화는 ‘최신 다시 읽기’로 확인하세요.' : ''}`;
  if (DUMP.loading || DUMP.error || !DUMP.visibleRows.length) {
    const message = DUMP.loading ? '대화를 읽는 중…' : DUMP.error
      ? `대화를 읽지 못했습니다 — ${DUMP.error}` : !DUMP.couple
        ? '커플을 고르면 대화가 나옵니다.' : !DUMP.rows.length
          ? '대화가 없습니다.' : '이 쪽에 검색어와 일치하는 대화가 없습니다.';
    container.innerHTML = `<div class="empty-state">${esc(message)}</div>`;
  } else {
    container.innerHTML = DUMP.visibleRows.map((r) => {
      const date = new Date(r.at);
      const iso = Number.isFinite(date.getTime()) ? date.toISOString() : '';
      const time = iso ? date.toLocaleString('ko-KR', {
        year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
      }) : '시각 없음';
      return `<article class="message-item${r.ai ? ' is-ai' : ''}">
        <div class="message-meta">
          <span class="message-author">${esc(r.who || (r.ai ? '비서' : '이름없음'))}</span>
          ${r.ai ? '<span class="pill pink">비서</span>' : ''}
          ${r.trio ? '<span class="pill">셋이서</span>' : ''}
          <span class="pill message-kind">${esc(messageKind(r.type))}</span>
          <time datetime="${esc(iso)}" title="${esc(iso)}">${esc(time)}</time>
          ${r.edited ? '<span class="message-edited">수정됨</span>' : ''}
        </div>
        <div class="message-body">${esc(messageBody(r))}</div>
      </article>`;
    }).join('');
  }
  renderRecordPager('dump', DUMP, (page) => { DUMP.page = page; loadDump({ scroll: true }); });
}

function wireDump() {
  const couple = $('#dumpCouple'), size = $('#dumpSize'), copy = $('#dumpCopy');
  const refresh = $('#dumpRefresh'), search = $('#dumpSearch');
  if (couple) couple.onchange = () => { resetDump(couple.value || null); loadDump({ scroll: true }); };
  if (size) {
    DUMP.size = Math.min(1000, Math.max(1, Number(size.value) || 50));
    size.onchange = () => {
      DUMP.size = Math.min(1000, Math.max(1, Number(size.value) || 50));
      resetDump(); loadDump({ scroll: true });
    };
  }
  if (refresh) refresh.onclick = () => { resetDump(); loadDump({ scroll: true }); };
  if (search) search.oninput = () => { DUMP.query = search.value; renderDump(); };
  if (copy) copy.onclick = async () => {
    if (DUMP.loading || DUMP.error || !DUMP.visibleRows.length) return;
    const text = DUMP.visibleRows.map((r) =>
      `[${clock(r.at)}] ${r.who || (r.ai ? '비서' : '이름없음')}${r.trio ? '(셋이서)' : ''}: ${messageBody(r)}`).join('\n');
    try { await navigator.clipboard.writeText(text); toast('화면에 표시된 대화를 복사했습니다'); }
    catch { toast('복사하지 못했습니다'); }
  };
  renderDump();
}

// 세션이 끝나면 진행 중인 응답도 폐기한다. app.js의 gate()에서 호출한다.
function clearPrivateRecords() {
  ++DUMP.request; ++LOG.request;
  resetDump(null);
  DUMP.rows = []; DUMP.visibleRows = []; DUMP.loading = false; DUMP.error = '';
  LOG.couple = null; LOG.rows = []; LOG.total = 0; LOG.loading = false; LOG.error = '';
  renderDump(); renderLog();
  $('#logCard').hidden = true;
}

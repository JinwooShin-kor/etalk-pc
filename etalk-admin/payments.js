/* 구매 원장을 읽는 관리자 전용 화면. 주문 정보는 ae_ops_payments에서만 가져온다. */
'use strict';

const PAYMENTS = {
  size: 25, page: 0, total: 0, rows: [], summary: null, snapshot: null,
  request: 0, loading: false, error: '', loaded: false, selectedId: null,
  query: '', environment: 'production', platform: '', from: '', to: '',
};
let paymentSearchTimer = null;

const paymentEnvironmentLabel = (value) => ({ production: '실결제', sandbox: '테스트', unknown: '환경 미확인' })[value] || '환경 미확인';
const paymentPlatformLabel = (value) => ({ ios: 'App Store', android: 'Google Play' })[value] || '스토어 미확인';
function paymentTime(value, full = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Date(value).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', ...(full ? { second: '2-digit' } : {}), hour12: false,
  });
}
function paymentMembers(couple) {
  return (couple?.members || []).map((member) => member.name || '이름 없음').join(' · ')
    || (couple?.id ? '구성원 정보 없음' : '연결된 커플 없음');
}
function paymentValue(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}
function paymentPrice(row) {
  return row.price_basis === 'current_config' && paymentValue(row.estimated_krw)
    ? `약 ${n(row.estimated_krw)}원` : '금액 정보 없음';
}
function resetPaymentResults() {
  clearTimeout(paymentSearchTimer);
  ++PAYMENTS.request;
  Object.assign(PAYMENTS, { page: 0, total: 0, rows: [], summary: null, snapshot: null,
    loading: false, error: '', loaded: false, selectedId: null });
}
function clearPayments() {
  resetPaymentResults();
  Object.assign(PAYMENTS, { query: '', environment: 'production', platform: '', from: '', to: '' });
  const values = { paymentQuery: '', paymentEnvironment: 'production', paymentPlatform: '',
    paymentPeriod: 'all', paymentFrom: '', paymentTo: '' };
  for (const [id, value] of Object.entries(values)) { const el = $(`#${id}`); if (el) el.value = value; }
  const dates = $('#paymentDateRange'); if (dates) dates.hidden = true;
  if ($('#paymentTbl')) renderPayments();
}
function openPayments() {
  if (!PAYMENTS.loaded && !PAYMENTS.loading) return loadPayments();
}
function paymentDateBounds() {
  const period = $('#paymentPeriod').value;
  $('#paymentDateRange').hidden = period !== 'custom';
  if (period === 'all') return { from: '', to: '' };
  if (period === 'custom') {
    const start = $('#paymentFrom').value, end = $('#paymentTo').value;
    if ((start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) || (end && !/^\d{4}-\d{2}-\d{2}$/.test(end))) {
      throw new Error('조회 날짜를 확인해 주세요.');
    }
    if (start && end && start > end) throw new Error('종료일은 시작일보다 빠를 수 없습니다.');
    const from = start ? new Date(`${start}T00:00:00+09:00`).toISOString() : '';
    const to = end ? new Date(Date.parse(`${end}T00:00:00+09:00`) + 86400e3).toISOString() : '';
    return { from, to };
  }
  const days = Number(period);
  if (![7, 30, 90].includes(days)) return { from: '', to: '' };
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const midnight = Date.parse(`${today}T00:00:00+09:00`);
  return { from: new Date(midnight - (days - 1) * 86400e3).toISOString(),
    to: new Date(midnight + 86400e3).toISOString() };
}
function applyPaymentFilters({ debounce = false } = {}) {
  resetPaymentResults();
  PAYMENTS.query = $('#paymentQuery').value.trim().slice(0, 200);
  PAYMENTS.environment = $('#paymentEnvironment').value;
  PAYMENTS.platform = $('#paymentPlatform').value;
  try { Object.assign(PAYMENTS, paymentDateBounds()); }
  catch (error) { PAYMENTS.error = error.message; renderPayments(); return; }
  if (debounce) {
    PAYMENTS.loading = true;
    renderPayments();
    paymentSearchTimer = setTimeout(() => loadPayments({ scroll: true }), 300);
  } else { return loadPayments({ scroll: true }); }
}
async function loadPayments({ scroll = false, corrections = 0 } = {}) {
  clearTimeout(paymentSearchTimer);
  const request = ++PAYMENTS.request, epoch = S.sessionEpoch;
  PAYMENTS.loading = true; PAYMENTS.error = ''; PAYMENTS.rows = []; PAYMENTS.selectedId = null;
  renderPayments();
  if (scroll) { const list = $('#paymentTbl').closest('.data-scroll'); if (list) list.scrollTop = 0; }
  try {
    const data = await rpc('ae_ops_payments', {
      p_limit: PAYMENTS.size, p_offset: PAYMENTS.page * PAYMENTS.size,
      p_query: PAYMENTS.query, p_environment: PAYMENTS.environment, p_platform: PAYMENTS.platform,
      p_from: PAYMENTS.from || null, p_to: PAYMENTS.to || null, p_snapshot: PAYMENTS.snapshot,
    });
    if (request !== PAYMENTS.request || epoch !== S.sessionEpoch) return false;
    if (data?.order !== 'newest_first' || !data.snapshot || !Number.isFinite(Date.parse(data.snapshot))
      || !Array.isArray(data.rows) || !Number.isFinite(Number(data.total))) {
      throw new Error('결제 조회 응답을 확인할 수 없습니다. 서버 배포 상태를 확인해 주세요.');
    }
    PAYMENTS.total = Math.max(0, Math.floor(Number(data.total)));
    PAYMENTS.snapshot = data.snapshot;
    const last = Math.max(0, Math.ceil(PAYMENTS.total / PAYMENTS.size) - 1);
    if (PAYMENTS.page > last) {
      PAYMENTS.page = corrections ? 0 : last;
      return loadPayments({ scroll, corrections: corrections + 1 });
    }
    PAYMENTS.rows = data.rows;
    PAYMENTS.summary = data.summary || null;
    PAYMENTS.loading = false; PAYMENTS.loaded = true;
    renderPayments();
    return true;
  } catch (error) {
    if (request !== PAYMENTS.request || epoch !== S.sessionEpoch) return false;
    PAYMENTS.loading = false; PAYMENTS.total = 0; PAYMENTS.summary = null;
    PAYMENTS.error = String(error.message || error);
    renderPayments();
    if (/no session|세션이 끊겼/.test(PAYMENTS.error) && typeof gate === 'function') gate();
    return false;
  }
}
function renderPaymentSummary() {
  const summary = PAYMENTS.summary;
  const amount = summary && paymentValue(summary.estimated_krw) ? `약 ${n(summary.estimated_krw)}원` : '확인 불가';
  const unpriced = Number(summary?.unpriced_orders || 0);
  const metrics = [
    ['조회된 구매', summary ? `${n(summary.orders)}건` : '—', '선택한 필터의 전체 기록'],
    ['지급된 하트', summary ? `${n(summary.hearts)}개` : '—', '구매 원장의 하트 합계'],
    ['구매자', summary ? `${n(summary.buyers)}명` : '—', summary ? `결제에 연결된 커플 ${n(summary.couples)}팀` : '필터 범위 기준'],
    ['구매액 추정', summary ? amount : '—', summary ? (unpriced ? `${n(unpriced)}건은 가격 정보 없음` : '현재 상품 가격 기준 · 실제 결제액 아님') : '실제 결제액은 저장되지 않습니다'],
  ];
  $('#paymentSummary').innerHTML = metrics.map(([label, value, note]) => `<div class="card payment-metric"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`).join('');
}
function renderPayments() {
  renderPaymentSummary();
  const table = $('#paymentTbl');
  table.setAttribute('aria-busy', String(PAYMENTS.loading));
  $('#paymentRefresh').disabled = PAYMENTS.loading;
  const state = $('#paymentStatus');
  if (PAYMENTS.loading || PAYMENTS.error || !PAYMENTS.rows.length) {
    const title = PAYMENTS.loading ? '결제 기록을 읽고 있습니다' : PAYMENTS.error
      ? '결제 기록을 불러오지 못했습니다' : PAYMENTS.loaded ? '조건에 맞는 구매 기록이 없습니다' : '결제 기록을 확인하세요';
    const subtitle = PAYMENTS.error || (PAYMENTS.loaded ? '기간이나 검색어, 결제 환경을 바꾸어 다시 확인해 주세요.' : '실결제 하트 구매부터 표시합니다.');
    table.innerHTML = `<tbody><tr><td><div class="empty-state"><strong>${esc(title)}</strong><p>${esc(subtitle)}</p>${PAYMENTS.error ? '<button type="button" class="btn ghost" id="paymentRetry">다시 조회</button>' : ''}</div></td></tr></tbody>`;
    const retry = $('#paymentRetry'); if (retry) retry.onclick = () => applyPaymentFilters();
    state.textContent = PAYMENTS.loading ? '조회 중…' : PAYMENTS.error ? '조회 실패' : PAYMENTS.loaded ? '구매 기록 0건' : '실결제 · 전체 기간';
  } else {
    table.innerHTML = `<thead><tr><th class="noSort">구매자 / 커플</th><th class="noSort">상품 / 하트</th><th class="noSort">환경 / 스토어</th><th class="noSort">하트 지급 시각</th><th class="noSort"><span class="sr-only">상세</span></th></tr></thead><tbody>${PAYMENTS.rows.map((row) => `<tr class="clickable${String(row.id) === PAYMENTS.selectedId ? ' selected' : ''}" data-payment-id="${esc(row.id)}">
      <td><strong>${esc(row.buyer?.name || '이름 없음')}</strong><span class="payment-cell-sub">${esc(row.buyer?.email || '이메일 정보 없음')}</span><span class="payment-cell-sub payment-couple">${esc(paymentMembers(row.purchase_couple))}</span></td>
      <td><strong class="payment-heart">${n(row.hearts)} 하트</strong><span class="payment-cell-sub mono">${esc(row.product_id || '상품 정보 없음')}</span><span class="payment-cell-sub">${esc(paymentPrice(row))}${row.price_basis === 'current_config' ? ' · 추정' : ''}</span></td>
      <td><span class="pill ${row.environment === 'production' ? 'good' : 'warn'}">${esc(paymentEnvironmentLabel(row.environment))}</span><span class="payment-cell-sub">${esc(paymentPlatformLabel(row.platform))}</span>${row.credit_status !== 'credited' ? '<span class="pill bad">지급 확인 필요</span>' : ''}</td>
      <td><time datetime="${esc(row.credited_at)}">${esc(paymentTime(row.credited_at))}</time><span class="payment-cell-sub">한국 시간</span></td>
      <td><button type="button" class="btn ghost payment-open" data-payment-open="${esc(row.id)}" aria-label="${esc(row.buyer?.name || '구매자')} 결제 상세 보기">상세 →</button></td>
    </tr>`).join('')}</tbody>`;
    $$('tr[data-payment-id]', table).forEach((row) => {
      row.onclick = () => openPayment(row.dataset.paymentId);
    });
    $$('button[data-payment-open]', table).forEach((button) => {
      button.onclick = (event) => { event.stopPropagation(); openPayment(button.dataset.paymentOpen, { focus: true }); };
    });
    const sum = PAYMENTS.summary;
    state.textContent = `${n(PAYMENTS.total)}건${sum && !PAYMENTS.environment ? ` · 실결제 ${n(sum.production_orders)} / 테스트 ${n(sum.sandbox_orders)} / 미확인 ${n(sum.unknown_orders)}` : ''} · ${paymentTime(PAYMENTS.snapshot)} 기준`;
  }
  renderPaymentDetail();
  renderRecordPager('payment', PAYMENTS, (page) => { PAYMENTS.page = page; loadPayments({ scroll: true }); });
}
function openPayment(id, { focus = false } = {}) {
  if (PAYMENTS.loading || !PAYMENTS.rows.some((row) => String(row.id) === String(id))) return;
  PAYMENTS.selectedId = String(id);
  $$('tr[data-payment-id]', $('#paymentTbl')).forEach((row) => row.classList.toggle('selected', row.dataset.paymentId === PAYMENTS.selectedId));
  renderPaymentDetail();
  const pane = $('#paymentDetail');
  if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1100px)').matches) pane.scrollIntoView({ behavior: 'auto', block: 'start' });
  if (focus) pane.focus({ preventScroll: true });
}
function renderPaymentDetail() {
  const pane = $('#paymentDetail');
  const row = PAYMENTS.rows.find((item) => String(item.id) === PAYMENTS.selectedId);
  if (!row) {
    pane.innerHTML = '<div class="empty-state"><span class="payment-detail-icon" aria-hidden="true">♡</span><strong>구매 기록을 선택하세요</strong><p>구매자와 커플, 하트 지급 내역을<br>자세히 확인할 수 있습니다.</p></div>';
    return;
  }
  const pair = (label, value, mono = false) => `<div><dt>${esc(label)}</dt><dd${mono ? ' class="mono"' : ''}>${esc(value ?? '—')}</dd></div>`;
  const transaction = row.transaction_id_status === 'available' && row.transaction_id ? row.transaction_id
    : row.transaction_id_status === 'hidden_token' ? '구매 토큰은 보안상 표시하지 않습니다' : '저장된 거래번호 없음';
  const differentCouple = row.current_couple?.id && row.current_couple.id !== row.purchase_couple?.id;
  const credited = row.credit_status === 'credited';
  pane.innerHTML = `<div class="payment-detail-head"><span class="payment-eyebrow">PURCHASE DETAIL</span><h2>${esc(row.buyer?.name || '이름 없음')}님의 구매</h2><span class="pill ${credited ? 'good' : 'warn'}">${credited ? '하트 지급 완료 · 원장 확인' : '하트 지급량 확인 필요'}</span></div>
    <div class="payment-detail-amount"><strong>${n(row.hearts)}<small>하트</small></strong><span>${esc(paymentPrice(row))}${row.price_basis === 'current_config' ? ' · 현재 가격 추정' : ''}</span></div>
    <div class="payment-detail-section"><h3>구매 정보</h3><dl class="payment-facts">
      ${pair('하트 지급 시각 (한국 시간)', paymentTime(row.credited_at, true))}${pair('결제 환경', paymentEnvironmentLabel(row.environment))}${pair('스토어', paymentPlatformLabel(row.platform))}${pair('상품 ID', row.product_id || '저장된 상품 정보 없음', true)}${pair('거래번호', transaction, row.transaction_id_status === 'available')}${pair('구매 원장 ID', row.id, true)}
    </dl><p class="payment-footnote">하트 지급 시각은 서버에 기록된 시각입니다. 스토어의 결제 시각과 다를 수 있습니다.</p></div>
    <div class="payment-detail-section"><h3>구매자</h3><dl class="payment-facts">
      ${pair('이름', row.buyer?.name || '이름 없음')}${pair('이메일', row.buyer?.email || '정보 없음')}${pair('사용자 ID', row.buyer?.id, true)}${pair('현재 보유 하트', paymentValue(row.buyer?.current_balance) ? `${n(row.buyer.current_balance)}개` : '정보 없음')}
    </dl><p class="payment-footnote">잔액은 현재 조회 시점 기준이며, 결제 직후 잔액이 아닙니다.</p></div>
    <div class="payment-detail-section"><h3>결제에 연결된 커플</h3><dl class="payment-facts">
      ${pair('구성원', paymentMembers(row.purchase_couple))}${pair('커플 ID', row.purchase_couple?.id || '연결 정보 없음', true)}${pair('연결 상태', ({ active: '연결됨', pending: '연결 대기', ended: '연결 종료' })[row.purchase_couple?.status] || '정보 없음')}
      ${differentCouple ? pair('현재 연결된 커플', paymentMembers(row.current_couple)) + pair('현재 커플 ID', row.current_couple.id, true) : ''}
    </dl><p class="payment-footnote">커플 ID는 구매 원장 기준, 이름과 구성원은 현재 정보입니다. 결제 당시 구성원 이력은 저장되어 있지 않습니다.</p></div>
    <div class="payment-limit-note"><strong>실제 청구 금액 · 환불 상태는 스토어에서 확인</strong><p>이 화면은 하트 지급 기록이며 지급 전 실패·보류 건은 포함하지 않습니다. 실제 결제 금액, 수수료, 정산액, 환불·취소 상태는 수집하지 않아 판단할 수 없습니다.</p><div class="row2"><a href="https://appstoreconnect.apple.com/" target="_blank" rel="noopener noreferrer">App Store Connect ↗</a><a href="https://play.google.com/console/" target="_blank" rel="noopener noreferrer">Google Play Console ↗</a></div></div>`;
}
function wirePayments() {
  $('#paymentFilters').onsubmit = (event) => { event.preventDefault(); applyPaymentFilters(); };
  $('#paymentQuery').oninput = () => applyPaymentFilters({ debounce: true });
  for (const id of ['#paymentEnvironment', '#paymentPlatform', '#paymentPeriod', '#paymentFrom', '#paymentTo']) {
    $(id).onchange = () => applyPaymentFilters();
  }
  $('#paymentRefresh').onclick = () => applyPaymentFilters();
}

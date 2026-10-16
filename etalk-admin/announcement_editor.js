/* Data-only home announcement editor. No network calls or automatic publishing. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AeAnnouncementEditor = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const releases = Object.freeze([
    ['letter', '편지함', 'route', '/games/letters'],
    ['coupon', '소원 쿠폰', 'route', '/games/coupons', true],
    ['games', '게임', 'route', '/games/list'],
    ['spin', '빙글빙글', 'route', '/games/spin'],
    ['match', '오늘의 궁합', 'feature', 'match'],
    ['tarot', '타로 살롱', 'feature', 'tarot'],
    ['court', '법정', 'route', '/games/court'],
    ['course', '데이트 코스', 'route', '/games/course'],
    ['trip', '여행 플래너', 'route', '/games/trip'],
    ['house', '우리 집', 'feature', 'house', true],
    ['gift', '선물 참모', 'feature', 'gift'],
    ['child', '우리 2세', 'route', '/games/child'],
    ['report', '보고서', 'route', '/report'],
  ].map(([key, label, action, target, hidden = false]) => Object.freeze({ key, label, action, target, hidden })));
  const byKey = new Map(releases.map((item) => [item.key, item]));
  const routes = new Set([
    '/home', '/chat', '/calendar', '/timeline', '/games', '/us', '/privacy', '/terms',
    '/games/list', '/games/list/gomoku', '/games/list/onecard', '/games/list/cube',
    '/games/list/draw', '/games/list/yaga', '/games/list/subhunt', '/games/list/mind',
    '/games/spin', '/games/court', '/games/course', '/games/child', '/games/trip',
    '/games/letters', '/report',
  ]);
  const features = new Set(['tarot', 'match', 'gift', 'hearts', 'stickers']);
  const actions = new Set(['detail', 'url', 'route', 'feature', 'none']);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isWebUrl = (value) => {
    if (typeof value !== 'string') return false;
    try { const url = new URL(value); return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password; }
    catch { return false; }
  };
  const releaseKey = (item) => item.content_release_key == null || item.content_release_key === '' ? null : item.content_release_key;
  const dateValue = (value) => typeof value === 'string' && /(Z|[+-]\d{2}:?\d{2})$/i.test(value) ? Date.parse(value) : NaN;

  // JSONB may return object keys in a different order. Array order is meaningful.
  function fingerprint(value) {
    function sorted(item) {
      if (Array.isArray(item)) return item.map(sorted);
      if (isObject(item)) return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sorted(item[key])]));
      return item;
    }
    return JSON.stringify(sorted(value));
  }

  function validate(value) {
    if (!Array.isArray(value)) return ['home_announcements는 공지 배열이어야 합니다. 공지가 없으면 []을 입력하세요.'];
    const errors = [], ids = new Set();
    value.forEach((item, index) => {
      const prefix = `${index + 1}번 공지`;
      const error = (message) => errors.push(`${prefix}: ${message}`);
      if (!isObject(item)) { error('객체 형식이어야 합니다.'); return; }
      if (typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(item.id)) error('id는 영문·숫자로 시작하는 1~80자의 영문·숫자·밑줄·하이픈이어야 합니다.');
      else if (ids.has(item.id)) error(`id '${item.id}'가 중복됩니다. 앱에는 첫 항목만 표시됩니다.`);
      ids.add(item.id);
      if (typeof item.title !== 'string' || !item.title.trim()) error('제목(title)을 입력하세요.');
      if (Object.hasOwn(item, 'enabled') && typeof item.enabled !== 'boolean') error('enabled는 true 또는 false여야 합니다. 문자열로 입력하지 마세요.');
      const start = item.starts_at == null ? null : dateValue(item.starts_at);
      const end = item.ends_at == null ? null : dateValue(item.ends_at);
      if (start !== null && !Number.isFinite(start)) error('starts_at은 시간대가 있는 날짜여야 합니다. 예: 2026-10-16T18:00:00+09:00');
      if (end !== null && !Number.isFinite(end)) error('ends_at은 시간대가 있는 날짜여야 합니다.');
      if (Number.isFinite(start) && Number.isFinite(end) && end <= start) error('ends_at은 starts_at보다 뒤여야 합니다.');
      if (item.min_build != null && (!Number.isInteger(item.min_build) || item.min_build < 0)) error('min_build는 0 이상의 정수여야 합니다.');
      const key = releaseKey(item);
      if (key !== null) {
        const release = typeof key === 'string' ? byKey.get(key) : null;
        if (!release) { error('content_release_key가 지원하는 콘텐츠 키가 아닙니다.'); return; }
        if (!Number.isInteger(item.min_build) || item.min_build < 304) error('출시 일정 연결 공지는 min_build가 304 이상이어야 합니다. 이전 앱에서는 출시 일정 조건을 처리할 수 없습니다.');
        if ((item.action != null && item.action !== '' && item.action !== release.action) ||
            (item.target != null && item.target !== '' && item.target !== release.target)) {
          error(`${release.label} 연결은 action='${release.action}', target='${release.target}'여야 합니다. 콘텐츠를 다시 선택하면 맞춰집니다.`);
        }
      } else {
        const action = item.action || 'detail';
        if (!actions.has(action)) error('action은 detail / url / route / feature / none 중에서 선택하세요.');
        if (action === 'route' && !routes.has(item.target)) error('앱에서 지원하지 않는 route입니다.');
        if (action === 'feature' && !features.has(item.target)) error('앱에서 지원하지 않는 feature입니다.');
        if (action === 'url' && !isWebUrl(item.target)) error('외부 이동 주소는 계정 정보가 없는 https URL이어야 합니다.');
      }
    });
    return errors;
  }

  function link(value, index, key) {
    if (!Array.isArray(value) || !Number.isInteger(index) || !isObject(value[index])) throw new Error('연결할 공지를 선택하세요.');
    if (key !== '' && !byKey.has(key)) throw new Error('지원하지 않는 콘텐츠입니다.');
    const next = value.map((item, i) => i === index ? { ...item } : item);
    if (key === '') {
      const previous = byKey.get(releaseKey(next[index]));
      delete next[index].content_release_key;
      if (previous?.hidden) Object.assign(next[index], { action: 'detail', target: '' });
    }
    else {
      const release = byKey.get(key);
      Object.assign(next[index], { content_release_key: key, action: release.action, target: release.target,
        min_build: Math.max(304, Number.isInteger(next[index].min_build) ? next[index].min_build : 0) });
    }
    return next;
  }

  function mount(container, textarea, onDraft) {
    let stopped = false;
    const render = () => {
      if (stopped) return;
      let value;
      try { value = JSON.parse(textarea.value); }
      catch { container.innerHTML = '<p class="err" role="status">JSON을 완성하면 공지 연결 도구와 미리보기가 표시됩니다.</p>'; return; }
      const errors = validate(value);
      const rows = Array.isArray(value) ? value : [];
      container.innerHTML = `
        <div class="announcement-guide"><b>신규 콘텐츠 공지 연결</b>
          <p>콘텐츠를 선택하면 이동 화면이 자동으로 맞춰지고, 해당 콘텐츠의 출시 일정이 켜진 동안에만 홈 공지와 샴페인 NEW 씰이 표시됩니다.</p>
          <p>출시 일정의 기간 변경·즉시 끄기·다시 노출은 앱 운영자 메뉴의 <b>신규 콘텐츠 노출</b>에서 관리합니다. 아래 공지의 starts_at / ends_at / min_build는 추가 노출 조건입니다. 연결 공지는 구버전 오노출을 막기 위해 최소 빌드 304 이상으로 맞춥니다. 두 조건을 모두 만족해야 표시됩니다.</p>
          <p>선택과 미리보기는 작성 중인 JSON만 바꿉니다. 아래 <b>저장</b>을 눌러야 반영됩니다. 연결 해제 시 기존 이동 화면을 유지합니다. 현재 숨긴 소원 쿠폰·우리 집은 공지 상세로 바뀝니다.</p>
        </div>
        ${errors.length ? `<div class="err" role="status">${errors.map(esc).join('<br>')}</div>` : '<p class="announcement-valid" role="status">입력 형식과 이동 화면을 확인했습니다. 실제 출시 일정 활성 여부는 이 미리보기에서 확인하지 않습니다.</p>'}
        ${rows.length ? rows.map((item, index) => {
          if (!isObject(item)) return '';
          const key = releaseKey(item), release = byKey.get(key);
          return `<div class="announcement-edit-row">
            <label for="announcement-release-${index}">${esc(item.title || '(제목 없음)')} <span class="muted small">${esc(item.id)}</span></label>
            <select id="announcement-release-${index}" data-release-index="${index}">
              <option value="" ${key === null ? 'selected' : ''}>일반 공지 — 출시 일정과 연결하지 않음</option>
              ${key !== null && !release ? `<option value="${esc(key)}" selected>잘못된 연결: ${esc(key)}</option>` : ''}
              ${releases.map((option) => `<option value="${option.key}" ${option.key === key ? 'selected' : ''}>${option.label}${option.hidden ? ' · 현재 콘텐츠 숨김' : ''}</option>`).join('')}
            </select>
            ${release?.hidden ? '<p class="announcement-note">현재 앱에서 숨긴 콘텐츠이므로 공지를 연결해도 노출되지 않습니다. 연결 설정이 콘텐츠 숨김을 해제하지 않습니다.</p>' : ''}
            <div class="announcement-preview" aria-label="${esc(item.title || '공지')} 문구와 이동 미리보기">
              ${release ? '<span class="announcement-seal" aria-label="출시 일정 노출 중일 때 NEW">NEW</span>' : ''}
              <strong>${esc(item.title || '(제목 없음)')}</strong>
              <p>${esc(item.body || '')}</p>
              <span class="announcement-preview-action">${esc(item.button_label || '보기')} → ${esc(release ? release.label : item.target || (item.action === 'none' ? '이동 없음' : '공지 상세'))}</span>
            </div>
            <p class="muted small">${release ? `연결: ${esc(release.key)} · 이동: ${esc(release.action)} / ${esc(release.target)}` : `이동: ${esc(item.action || 'detail')} / ${esc(item.target || '공지 상세')}`} · 공지 ${item.enabled === false ? '꺼짐' : '켜짐'}</p>
          </div>`;
        }).join('') : '<p class="muted">아직 공지가 없습니다. 기존 JSON 편집기에 공지를 추가하면 연결 대상을 선택할 수 있습니다.</p>'}`;
      container.querySelectorAll('[data-release-index]').forEach((select) => {
        select.onchange = () => {
          let current;
          try { current = JSON.parse(textarea.value); }
          catch { render(); return; }
          textarea.value = JSON.stringify(link(current, Number(select.dataset.releaseIndex), select.value), null, 2);
          onDraft(textarea.value);
          render();
        };
      });
    };
    render();
    return { render, dispose: () => { stopped = true; } };
  }

  return Object.freeze({ releases, validate, link, fingerprint, mount });
});

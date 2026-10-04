/* 메뉴 전환·화면 테마·검색. 데이터 조회와 쓰기는 app.js의 기존 경로를 쓴다. */
'use strict';
(() => {
  const savedScroll = new Map();
  const buttons = [...document.querySelectorAll('#tabs button')];
  function activate(button) {
    savedScroll.set(S.tab, window.scrollY);
    S.tab = button.dataset.tab;
    buttons.forEach((item) => {
      item.classList.toggle('on', item === button);
      item.setAttribute('aria-current', item === button ? 'page' : 'false');
    });
    document.querySelectorAll('main>section').forEach((section) => {
      section.classList.toggle('on', section.id === S.tab);
    });
    document.querySelector('#pageTitle').textContent = button.querySelector('span').textContent;
    document.title = `${button.querySelector('span').textContent} · 애톡 운영 콘솔`;
    window.scrollTo({ top: savedScroll.get(S.tab) || 0, behavior: 'instant' });
  }
  buttons.forEach((button) => { button.onclick = () => activate(button); });

  const theme = document.querySelector('#themeBtn');
  function applyTheme(value) {
    document.documentElement.dataset.theme = value;
    theme.textContent = value === 'dark' ? '밝은 화면' : '어두운 화면';
    theme.setAttribute('aria-label', `${theme.textContent}으로 전환`);
  }
  let initial = 'light';
  try { initial = localStorage.getItem('etalk.console.theme') === 'dark' ? 'dark' : 'light'; } catch {}
  applyTheme(initial);
  theme.onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('etalk.console.theme', next); } catch {}
  };

  function refreshConfig() {
    const query = document.querySelector('#configSearch').value.trim().toLocaleLowerCase();
    let visible = 0, total = 0;
    document.querySelectorAll('#configList .cfg').forEach((group) => {
      let matches = 0;
      group.querySelectorAll('.cfgrow').forEach((row) => {
        total++;
        const text = [row.querySelector('.head b')?.textContent, row.querySelector('.what')?.textContent,
          row.querySelector('.who')?.textContent, group.querySelector('h3')?.textContent].join(' ').toLocaleLowerCase();
        row.hidden = Boolean(query && !text.includes(query));
        if (!row.hidden) { visible++; matches++; }
      });
      group.hidden = matches === 0;
    });
    document.querySelector('#configResult').textContent = `${visible}개 항목${query ? ` / 전체 ${total}개` : ''}`;
    document.querySelector('#configEmpty').hidden = visible > 0 || total === 0;
  }
  document.querySelector('#configSearch').oninput = refreshConfig;
  window.AeConsoleUI = { refreshConfig };
  refreshConfig();
})();

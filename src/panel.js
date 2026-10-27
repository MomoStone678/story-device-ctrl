/**
 * QR 旁 Emoji → 半透明面板（R4 R5 R6 R7）
 */

/**
 * @param {object} api
 * @param {() => object} api.getSettings
 * @param {(profile: object, meta?: object) => string} api.importProfile
 * @param {(id: string) => Promise|void} api.setCurrentProfile
 * @param {(id: string, enabled: boolean) => Promise|void} api.setEnabled
 * @param {(id: string, name: string) => void} api.rename
 * @param {(id: string) => Promise|void} api.remove
 * @param {() => Promise|void} api.connect
 * @param {() => Promise|void} api.disconnect
 * @param {() => Promise|void} api.stopAll
 * @param {() => { status: string, connected: boolean, currentId: string|null }} api.getDriverState
 * @param {string} [api.emoji]
 */
export function mountPanel(api) {
  const emoji = api.emoji || '📡';
  ensureFab(emoji, () => openPanel(api));
}

function ensureFab(emoji, onClick) {
  if (document.getElementById('sdc-fab')) return;
  const fab = document.createElement('button');
  fab.id = 'sdc-fab';
  fab.type = 'button';
  fab.className = 'sdc-fab';
  fab.title = '剧情控设备';
  fab.textContent = emoji;
  fab.addEventListener('click', onClick);

  const place = () => {
    const bar = document.querySelector('#qr--bar') || document.querySelector('#send_form') || document.body;
    if (!fab.isConnected) {
      if (bar === document.body) {
        fab.classList.add('sdc-fab--fixed');
        bar.appendChild(fab);
      } else {
        bar.appendChild(fab);
      }
    }
  };
  place();
  // QR 可能晚加载
  const obs = new MutationObserver(() => place());
  obs.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => obs.disconnect(), 15000);
}

function openPanel(api) {
  let root = document.getElementById('sdc-panel-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'sdc-panel-root';
    document.body.appendChild(root);
  }
  root.innerHTML = '';
  root.classList.add('sdc-open');

  const backdrop = document.createElement('div');
  backdrop.className = 'sdc-backdrop';
  backdrop.addEventListener('click', () => closePanel());

  const panel = document.createElement('div');
  panel.className = 'sdc-panel';
  panel.setAttribute('role', 'dialog');

  const header = document.createElement('div');
  header.className = 'sdc-panel__header';
  header.innerHTML = `<span class="sdc-panel__title">剧情控设备</span>`;
  const btnClose = document.createElement('button');
  btnClose.type = 'button';
  btnClose.className = 'sdc-panel__close';
  btnClose.setAttribute('aria-label', '关闭');
  btnClose.textContent = '×';
  btnClose.addEventListener('click', () => closePanel());
  header.appendChild(btnClose);

  const body = document.createElement('div');
  body.className = 'sdc-panel__body';
  renderBody(body, api);

  panel.appendChild(header);
  panel.appendChild(body);
  root.appendChild(backdrop);
  root.appendChild(panel);
}

export function closePanel() {
  const root = document.getElementById('sdc-panel-root');
  if (root) {
    root.classList.remove('sdc-open');
    root.innerHTML = '';
  }
}

function renderBody(body, api) {
  body.innerHTML = '';
  const st = api.getDriverState();
  const settings = api.getSettings();

  const status = document.createElement('div');
  status.className = 'sdc-status';
  status.textContent = st.connected
    ? `已连接 · 当前档案 ${st.currentId || '—'}`
    : `未连接 · 状态 ${st.status}`;
  body.appendChild(status);

  const actions = document.createElement('div');
  actions.className = 'sdc-row';
  actions.appendChild(
    mkBtn('连接蓝牙', async () => {
      try {
        await api.connect();
        toast('已连接');
      } catch (e) {
        toast(e?.message || String(e), true);
      }
      renderBody(body, api);
    }),
  );
  actions.appendChild(
    mkBtn('断开', async () => {
      await api.disconnect();
      renderBody(body, api);
    }),
  );
  actions.appendChild(
    mkBtn('全局停止', async () => {
      await api.stopAll();
      toast('已停止');
    }),
  );
  body.appendChild(actions);

  const importBox = document.createElement('div');
  importBox.className = 'sdc-import';
  const ta = document.createElement('textarea');
  ta.placeholder = '粘贴实验室导出的设备档案 JSON…';
  ta.rows = 5;
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = '条目显示名（可空＝用档案设备名）';
  const importBtn = mkBtn('导入档案', async () => {
    try {
      const profile = JSON.parse(ta.value);
      api.importProfile(profile, { displayName: nameInput.value.trim() });
      ta.value = '';
      nameInput.value = '';
      toast('已导入');
      renderBody(body, api);
    } catch (e) {
      toast('JSON 无效：' + (e?.message || e), true);
    }
  });
  importBox.appendChild(ta);
  importBox.appendChild(nameInput);
  importBox.appendChild(importBtn);
  body.appendChild(importBox);

  const list = document.createElement('div');
  list.className = 'sdc-list';
  const ids = Object.keys(settings.profiles || {});
  if (!ids.length) {
    const empty = document.createElement('p');
    empty.className = 'sdc-muted';
    empty.textContent = '还没有档案。先在实验室导出，再粘贴导入。';
    list.appendChild(empty);
  }
  for (const id of ids) {
    list.appendChild(renderRow(id, settings.profiles[id], settings, api, body));
  }
  body.appendChild(list);
}

function renderRow(id, row, settings, api, body) {
  const el = document.createElement('div');
  el.className = 'sdc-card-row' + (settings.currentProfileId === id ? ' is-current' : '');

  const top = document.createElement('div');
  top.className = 'sdc-card-row__top';

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = !!row.enabled;
  toggle.title = '启用世界书';
  toggle.addEventListener('change', async () => {
    await api.setEnabled(id, toggle.checked);
    toast(toggle.checked ? '世界书已开' : '世界书已关');
  });

  const name = document.createElement('input');
  name.type = 'text';
  name.value = row.displayName || '';
  name.className = 'sdc-name';
  name.addEventListener('change', () => {
    api.rename(id, name.value.trim());
  });

  top.appendChild(toggle);
  top.appendChild(name);
  el.appendChild(top);

  const rowBtns = document.createElement('div');
  rowBtns.className = 'sdc-row';
  rowBtns.appendChild(
    mkBtn(settings.currentProfileId === id ? '当前连接' : '设为当前', async () => {
      const r = await api.setCurrentProfile(id);
      if (r?.needReconnect) toast('已切换，请重新点「连接蓝牙」');
      renderBody(body, api);
    }),
  );
  rowBtns.appendChild(
    mkBtn('删除', async () => {
      if (!confirm('删除该档案？')) return;
      await api.remove(id);
      renderBody(body, api);
    }, true),
  );
  el.appendChild(rowBtns);
  return el;
}

function mkBtn(label, onClick, danger = false) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sdc-btn' + (danger ? ' sdc-btn--danger' : '');
  b.textContent = label;
  b.addEventListener('click', (e) => {
    e.preventDefault();
    onClick();
  });
  return b;
}

function toast(msg, isErr = false) {
  try {
    if (window.toastr) {
      if (isErr) toastr.error(msg);
      else toastr.info(msg);
      return;
    }
  } catch (_) {
    /* ignore */
  }
  console.log('[story-device-ctrl]', msg);
}

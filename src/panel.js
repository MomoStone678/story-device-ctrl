/**
 * 可拖动悬浮圆标 → 半透明面板（R4 R5 R6 R7）
 * 不再挂快捷回复栏；手机弹窗贴底，避免顶到不可用区。
 */

const FAB_POS_KEY = 'sdc-fab-pos';
const DRAG_THRESHOLD_PX = 8;

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

function loadFabPos() {
  try {
    const raw = localStorage.getItem(FAB_POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.left === 'number' && typeof p?.top === 'number') return p;
  } catch (_) {
    /* ignore */
  }
  return null;
}

function saveFabPos(left, top) {
  try {
    localStorage.setItem(FAB_POS_KEY, JSON.stringify({ left, top }));
  } catch (_) {
    /* ignore */
  }
}

function clampFabPos(left, top, size) {
  const pad = 8;
  const vw = window.innerWidth || 320;
  const vh = window.innerHeight || 480;
  const maxL = Math.max(pad, vw - size - pad);
  const maxT = Math.max(pad, vh - size - pad);
  return {
    left: Math.min(maxL, Math.max(pad, left)),
    top: Math.min(maxT, Math.max(pad, top)),
  };
}

function defaultFabPos(size) {
  const vw = window.innerWidth || 320;
  const vh = window.innerHeight || 480;
  return clampFabPos(vw - size - 16, vh - size - 96, size);
}

function applyFabPos(fab, left, top) {
  const size = fab.offsetWidth || 44;
  const p = clampFabPos(left, top, size);
  fab.style.left = `${p.left}px`;
  fab.style.top = `${p.top}px`;
  fab.style.right = 'auto';
  fab.style.bottom = 'auto';
  return p;
}

function ensureFab(emoji, onClick) {
  let fab = document.getElementById('sdc-fab');
  if (fab) {
    fab.textContent = emoji;
    return;
  }

  fab = document.createElement('button');
  fab.id = 'sdc-fab';
  fab.type = 'button';
  fab.className = 'sdc-fab sdc-fab--float';
  fab.title = '戏控台（可拖动）';
  fab.setAttribute('aria-label', '戏控台');
  fab.textContent = emoji;
  document.body.appendChild(fab);

  const saved = loadFabPos();
  const size = 44;
  const startPos = saved || defaultFabPos(size);
  requestAnimationFrame(() => applyFabPos(fab, startPos.left, startPos.top));

  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let origL = 0;
  let origT = 0;
  let pointerId = null;

  const onPointerDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    pointerId = e.pointerId;
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = fab.getBoundingClientRect();
    origL = rect.left;
    origT = rect.top;
    fab.classList.add('is-dragging');
    try {
      fab.setPointerCapture(pointerId);
    } catch (_) {
      /* ignore */
    }
    e.preventDefault();
  };

  const onPointerMove = (e) => {
    if (!dragging || (pointerId != null && e.pointerId !== pointerId)) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
    moved = true;
    applyFabPos(fab, origL + dx, origT + dy);
  };

  const onPointerUp = (e) => {
    if (!dragging || (pointerId != null && e.pointerId !== pointerId)) return;
    dragging = false;
    fab.classList.remove('is-dragging');
    try {
      fab.releasePointerCapture(pointerId);
    } catch (_) {
      /* ignore */
    }
    pointerId = null;
    if (moved) {
      const rect = fab.getBoundingClientRect();
      const p = applyFabPos(fab, rect.left, rect.top);
      saveFabPos(p.left, p.top);
      return;
    }
    onClick();
  };

  fab.addEventListener('pointerdown', onPointerDown);
  fab.addEventListener('pointermove', onPointerMove);
  fab.addEventListener('pointerup', onPointerUp);
  fab.addEventListener('pointercancel', onPointerUp);
  // 避免系统长按菜单干扰拖动
  fab.addEventListener('contextmenu', (e) => e.preventDefault());

  const onResize = () => {
    const rect = fab.getBoundingClientRect();
    const p = applyFabPos(fab, rect.left, rect.top);
    saveFabPos(p.left, p.top);
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
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
  panel.setAttribute('aria-modal', 'true');

  const header = document.createElement('div');
  header.className = 'sdc-panel__header';
  header.innerHTML = `<span class="sdc-panel__title">戏控台</span>`;
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

  // 打开后滚到顶，避免手机上内容卡在可视区外
  requestAnimationFrame(() => {
    try {
      panel.scrollTop = 0;
      body.scrollTop = 0;
    } catch (_) {
      /* ignore */
    }
  });
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
  ta.placeholder = '粘贴信道台导出的设备档案 JSON…';
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
    empty.textContent = '还没有档案。先在信道台导出，再粘贴导入。';
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

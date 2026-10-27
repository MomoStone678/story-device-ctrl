/**
 * 聊天气泡内底部注入 CTRL 卡片（R3）
 * - 挂在本轮 .mes_text 最下面（不是浮窗）
 * - 不完整 / 流式未完成：不出卡
 * - 外观：对齐 Whisper 深色模式 toy-lane 扁卡（自带深色底，不跟酒馆主题走）
 */

import { parseCtrlCommands, stripCtrlTags, isRunnableCtrl } from './ctrl-parse.js';

/**
 * @param {object} deps
 * @param {import('./driver.js').StoryDeviceBleDriver} deps.driver
 * @param {() => string[]} deps.getEnabledLabels
 */
export function bindCtrlCards(deps) {
  const { eventSource, event_types } = deps;
  if (!eventSource || !event_types) return;

  let busy = false;

  const run = (mesId) => {
    if (busy) return;
    busy = true;
    try {
      injectForMessage(mesId, deps);
    } catch (e) {
      console.warn('[story-device-ctrl] card inject', e);
    } finally {
      busy = false;
    }
  };

  const scanTail = () => {
    try {
      const chat = deps.getChat?.() || [];
      const start = Math.max(0, chat.length - 5);
      for (let i = start; i < chat.length; i++) run(i);
    } catch (_) {
      /* ignore */
    }
  };

  eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, run);
  eventSource.on(event_types.USER_MESSAGE_RENDERED, run);
  eventSource.on(event_types.MESSAGE_UPDATED, run);
  if (event_types.GENERATION_ENDED) {
    eventSource.on(event_types.GENERATION_ENDED, scanTail);
  }

  const chatEl = document.getElementById('chat');
  if (chatEl) {
    let timer = null;
    const obs = new MutationObserver((mutations) => {
      if (busy) return;
      const selfOnly = mutations.every((m) => {
        const t = m.target;
        if (!(t instanceof Node)) return false;
        const el = t.nodeType === 1 ? t : t.parentElement;
        return !!(el && el.closest && el.closest('.sdc-cards, .sdc-ctrl-hide'));
      });
      if (selfOnly) return;
      clearTimeout(timer);
      timer = setTimeout(scanTail, 80);
    });
    obs.observe(chatEl, { childList: true, subtree: true, characterData: true });
  }

  try {
    const chat = deps.getChat?.() || [];
    chat.forEach((_, i) => run(i));
  } catch (_) {
    /* ignore */
  }
}

/** 还在吐字时先不挂卡，避免半截 CTRL 出空白卡 */
function isStreamingNow() {
  try {
    const stop = document.getElementById('mes_stop');
    if (stop) {
      const st = window.getComputedStyle(stop);
      if (st.display !== 'none' && st.visibility !== 'hidden' && stop.offsetParent !== null) {
        return true;
      }
    }
  } catch (_) {
    /* ignore */
  }
  return false;
}

/** 只保留可展示的完整命令（丢弃不完整 / 无效半截） */
function displayableCmds(cmds) {
  return (cmds || []).filter((cmd) => {
    if (!cmd) return false;
    if (cmd.stopAll || cmd.off) return true;
    if (cmd.incomplete) return false;
    return isRunnableCtrl(cmd);
  });
}

function resolveCmds(mes, textEl) {
  let cmds = parseCtrlCommands(mes.mes);
  if (!cmds.length && textEl) {
    cmds = parseCtrlCommands(textEl.textContent || '');
  }
  const shown = displayableCmds(cmds);
  if (shown.length) {
    mes._sdcCmds = shown;
    return shown;
  }
  // 仍有解析结果但全是半截：不缓存半截，避免下次「默认出空白卡」
  if (cmds.length && cmds.every((c) => c.incomplete)) {
    return [];
  }
  if (Array.isArray(mes._sdcCmds) && mes._sdcCmds.length) {
    return displayableCmds(mes._sdcCmds);
  }
  return [];
}

function ensureCardHost(mesRoot, textEl) {
  // 优先挂在本轮正文最底部；否则挂 mes_block 末尾
  const parent = textEl || mesRoot;
  let host = parent.querySelector(':scope > .sdc-cards');
  if (!host && mesRoot) {
    host = mesRoot.querySelector('.sdc-cards');
    if (host && host.parentElement !== parent) {
      host.remove();
      host = null;
    }
  }
  if (!host) {
    host = document.createElement('div');
    host.className = 'sdc-cards';
    parent.appendChild(host);
  } else if (host.parentElement !== parent) {
    parent.appendChild(host);
  }
  return host;
}

function clearCardHosts(mesRoot, textEl) {
  const roots = [textEl, mesRoot].filter(Boolean);
  for (const r of roots) {
    r.querySelectorAll('.sdc-cards').forEach((el) => el.remove());
  }
}

function injectForMessage(mesId, deps) {
  const chat = deps.getChat?.() || [];
  const mes = chat[mesId];
  if (!mes || typeof mes.mes !== 'string') return;

  const mesRoot =
    document.querySelector(`#chat .mes[mesid="${mesId}"] .mes_block`) ||
    document.querySelector(`#chat .mes[mesid="${mesId}"]`);
  if (!mesRoot) return;

  const textEl = mesRoot.querySelector('.mes_text');

  // 流式输出中：只藏 CTRL 字，不建卡
  if (isStreamingNow() && mesId === chat.length - 1) {
    hideCtrlInMesText(textEl);
    clearCardHosts(mesRoot, textEl);
    return;
  }

  const cmds = resolveCmds(mes, textEl);
  if (!cmds.length) {
    clearCardHosts(mesRoot, textEl);
    hideCtrlInMesText(textEl);
    return;
  }

  const host = ensureCardHost(mesRoot, textEl);
  host.innerHTML = '';
  const stack = document.createElement('div');
  stack.className = 'toy-lane-stack';
  host.appendChild(stack);

  const enabled = new Set((deps.getEnabledLabels?.() || []).map((s) => s.toLowerCase()));
  /** 本轮出现的角色短名顺序：第 1 个粉卡，第 2 个紫卡（对齐 Whisper 双人） */
  const actorOrder = [];
  const autoOns = [];

  cmds.forEach((cmd, idx) => {
    const actor = String(cmd.actor || 'Char').trim() || 'Char';
    if (!actorOrder.includes(actor)) actorOrder.push(actor);
    const actorSlot = actorOrder.indexOf(actor);
    // 0=第一角色粉，1=第二角色紫；再往后循环粉/紫
    const alt = actorSlot % 2 === 1;

    const wrap = document.createElement('div');
    wrap.className = 'sdc-lane-wrap' + (alt ? ' is-alt' : '');
    wrap.dataset.sdcActor = actor;
    wrap.dataset.sdcActorSlot = String(actorSlot);
    wrap.innerHTML = buildLaneCardHtml(cmd, { alt });

    const actions = document.createElement('div');
    actions.className = 'sdc-lane-actions';

    const btnStop = mkBtn('停止', async () => {
      try {
        if (cmd.stopAll || !cmd.fn) await deps.driver.stopAll();
        else await deps.driver.stopFunction(cmd.fn);
      } catch (e) {
        toast(e?.message || String(e), true);
      }
    });
    const btnCont = mkBtn('继续', async () => {
      try {
        if (cmd.stopAll) return;
        if (cmd.off) await deps.driver.stopFunction(cmd.fn);
        else if (!isRunnableCtrl(cmd)) toast('标记缺段，无法驱动', true);
        else {
          await deps.driver.setFunction(cmd.fn, {
            level: cmd.level,
            widthMs: cmd.widthMs,
            gapMs: cmd.gapMs,
            durationMs: cmd.durationMs,
          });
        }
      } catch (e) {
        toast(e?.message || String(e), true);
      }
    });
    const btnDisc = mkBtn('断开', async () => {
      try {
        await deps.driver.disconnect();
      } catch (e) {
        toast(e?.message || String(e), true);
      }
    });
    actions.appendChild(btnStop);
    actions.appendChild(btnCont);
    actions.appendChild(btnDisc);
    wrap.appendChild(actions);

    if (cmd.fn && enabled.size && !enabled.has(String(cmd.fn).toLowerCase()) && !cmd.stopAll && !cmd.off) {
      const warn = document.createElement('div');
      warn.className = 'sdc-ctrl-card__warn';
      warn.textContent = '该功能未在已启用档案中';
      wrap.insertBefore(warn, actions);
    }

    wrap.dataset.sdcIdx = String(idx);
    stack.appendChild(wrap);

    if (cmd.stopAll || cmd.off || isRunnableCtrl(cmd)) {
      autoOns.push(cmd);
    }
  });

  if (autoOns.length && !mes._sdcBatchExecuted) {
    mes._sdcBatchExecuted = true;
    queueMicrotask(() => {
      const run = deps.driver.applyCtrlBatch
        ? deps.driver.applyCtrlBatch(autoOns)
        : Promise.all(
            autoOns.map((cmd) => {
              if (cmd.stopAll) return deps.driver.stopAll();
              if (cmd.off) return deps.driver.stopFunction(cmd.fn);
              return deps.driver.setFunction(cmd.fn, {
                level: cmd.level,
                widthMs: cmd.widthMs,
                gapMs: cmd.gapMs,
                durationMs: cmd.durationMs,
              });
            }),
          );
      Promise.resolve(run).catch((e) => toast(e?.message || String(e), true));
    });
  }

  hideCtrlInMesText(textEl);
  void stripCtrlTags;
}

function hideCtrlInMesText(textEl) {
  if (!textEl) return;
  const CTRL_RE = /\[CTRL:[^\]]+\]/gi;

  let html = textEl.innerHTML;
  const kept = [];
  html = html.replace(/<span class="sdc-ctrl-hide">[\s\S]*?<\/span>/gi, (block) => {
    kept.push(block);
    return `\u0000SDC${kept.length - 1}\u0000`;
  });
  // 卡片宿主在 mes_text 内时，替换前先摘掉再塞回，避免被 HTML 重写冲掉
  const hostKeep = [];
  html = html.replace(/<div class="sdc-cards"[\s\S]*?<\/div>/gi, (block) => {
    // 只保护最外层简单情况；复杂嵌套靠 ensureCardHost 重建
    hostKeep.push(block);
    return `\u0000SDCH${hostKeep.length - 1}\u0000`;
  });

  if (CTRL_RE.test(html)) {
    CTRL_RE.lastIndex = 0;
    html = html.replace(CTRL_RE, '<span class="sdc-ctrl-hide">$&</span>');
    html = html.replace(/\u0000SDC(\d+)\u0000/g, (_, i) => kept[Number(i)] || '');
    html = html.replace(/\u0000SDCH(\d+)\u0000/g, (_, i) => hostKeep[Number(i)] || '');
    textEl.innerHTML = html;
    return;
  }

  html = html.replace(/\u0000SDC(\d+)\u0000/g, (_, i) => kept[Number(i)] || '');
  html = html.replace(/\u0000SDCH(\d+)\u0000/g, (_, i) => hostKeep[Number(i)] || '');

  const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
  const hits = [];
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue || !/\[CTRL:[^\]]+\]/i.test(node.nodeValue)) continue;
    if (node.parentElement?.closest?.('.sdc-ctrl-hide, .sdc-cards')) continue;
    hits.push(node);
  }
  for (const textNode of hits) {
    const raw = textNode.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;
    const re = /\[CTRL:[^\]]+\]/gi;
    let m;
    while ((m = re.exec(raw)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(raw.slice(last, m.index)));
      const span = document.createElement('span');
      span.className = 'sdc-ctrl-hide';
      span.textContent = m[0];
      frag.appendChild(span);
      last = m.index + m[0].length;
    }
    if (last < raw.length) frag.appendChild(document.createTextNode(raw.slice(last)));
    textNode.parentNode?.replaceChild(frag, textNode);
  }
}

function buildLaneCardHtml(cmd, { alt }) {
  const actor = esc(cmd.actor || 'Char');
  const heart = alt ? '💜' : '❤️';
  const altCls = alt ? ' alt' : '';

  if (cmd.stopAll) {
    return (
      `<article class="toy-lane-card compact special${altCls}">` +
      `<div class="toy-lane-who">` +
      `<span class="toy-lane-heart" aria-hidden="true">${heart}</span>` +
      `<span class="toy-lane-name">${actor}</span>` +
      `<span class="toy-lane-role">control</span>` +
      `</div>` +
      `<div class="toy-lane-detail"><span class="toy-lane-channel">STOP</span></div>` +
      `</article>`
    );
  }

  if (cmd.off) {
    return (
      `<article class="toy-lane-card compact special${altCls}">` +
      `<div class="toy-lane-who">` +
      `<span class="toy-lane-heart" aria-hidden="true">${heart}</span>` +
      `<span class="toy-lane-name">${actor}</span>` +
      `<span class="toy-lane-role">control</span>` +
      `</div>` +
      `<div class="toy-lane-detail"><span class="toy-lane-channel">${esc(cmd.fn || 'OFF')} · OFF</span></div>` +
      `</article>`
    );
  }

  const laneTone = pickLaneTone(cmd.fn);
  const level = Number(cmd.level);
  const barW = Math.max(0, Math.min(100, level * 10));
  const gap = Number(cmd.gapMs);
  const mode = gap === 0 ? 'Hold' : 'Pulse';

  const details = [];
  details.push(`<span class="toy-lane-channel">${esc(cmd.fn || '?')}</span>`);
  details.push(`<span class="toy-lane-mode">${mode}</span>`);
  if (mode === 'Hold') {
    details.push('<span class="toy-lane-hold">continuous</span>');
  } else {
    details.push(
      `<span class="toy-lane-chip"><span class="toy-lane-key">Width</span><span class="toy-lane-val">${esc(cmd.widthMs)}ms</span></span>`,
    );
    details.push(
      `<span class="toy-lane-chip"><span class="toy-lane-key">Gap</span><span class="toy-lane-val">${esc(cmd.gapMs)}ms</span></span>`,
    );
  }
  if (cmd.durationMs != null) {
    const durLabel = Number(cmd.durationMs) === 0 ? '∞' : `${cmd.durationMs}ms`;
    details.push(
      `<span class="toy-lane-chip"><span class="toy-lane-key">Dur</span><span class="toy-lane-val">${esc(durLabel)}</span></span>`,
    );
  }

  return (
    `<article class="toy-lane-card compact ${laneTone}${altCls}">` +
    `<div class="toy-lane-who">` +
    `<span class="toy-lane-heart" aria-hidden="true">${heart}</span>` +
    `<span class="toy-lane-name">${actor}</span>` +
    `<span class="toy-lane-role">control</span>` +
    `<span class="toy-lane-pct">${esc(level)}/10</span>` +
    `</div>` +
    `<div class="toy-lane-detail">${details.join('')}</div>` +
    `<div class="toy-lane-bar" aria-hidden="true"><i style="width:${barW}%"></i></div>` +
    `</article>`
  );
}

function pickLaneTone(fn) {
  const s = String(fn || '').toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i) * (i + 1)) % 3;
  return ['thrust', 'vibe', 'suck'][h];
}

function mkBtn(label, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sdc-lane-btn';
  b.textContent = label;
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  });
  return b;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toast(msg, isErr) {
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

/**
 * 聊天气泡下注入 CTRL 卡片（R3）
 * 逻辑对齐「旧版能看见卡」那版 + Intiface：事件 + 聊天区监听；显示层藏 [CTRL]
 * 外观仍用 Whisper 扁卡。
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

  // Intiface 同款：流式重绘会冲掉隐藏层/卡片，靠监听补回来
  const chatEl = document.getElementById('chat');
  if (chatEl) {
    let timer = null;
    const obs = new MutationObserver((mutations) => {
      if (busy) return;
      // 忽略我们自己改卡片/隐藏层引起的抖动
      const selfOnly = mutations.every((m) => {
        const t = m.target;
        if (!(t instanceof Node)) return false;
        const el = t.nodeType === 1 ? t : t.parentElement;
        return !!(el && el.closest && el.closest('.sdc-cards, .sdc-ctrl-hide'));
      });
      if (selfOnly) return;
      clearTimeout(timer);
      timer = setTimeout(scanTail, 60);
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

function resolveCmds(mes, textEl) {
  let cmds = parseCtrlCommands(mes.mes);
  // 正文里看得见命令但存档解析不到时，从气泡纯文本再抠一遍
  if (!cmds.length && textEl) {
    cmds = parseCtrlCommands(textEl.textContent || '');
  }
  if (cmds.length) {
    mes._sdcCmds = cmds;
    return cmds;
  }
  if (Array.isArray(mes._sdcCmds) && mes._sdcCmds.length) return mes._sdcCmds;
  return [];
}

function injectForMessage(mesId, deps) {
  const chat = deps.getChat?.() || [];
  const mes = chat[mesId];
  if (!mes || typeof mes.mes !== 'string') return;

  const root =
    document.querySelector(`#chat .mes[mesid="${mesId}"] .mes_block`) ||
    document.querySelector(`#chat .mes[mesid="${mesId}"]`);
  if (!root) return;

  const textEl = root.querySelector('.mes_text');
  const cmds = resolveCmds(mes, textEl);

  let host = root.querySelector(':scope > .sdc-cards');
  if (!cmds.length) {
    if (host) host.remove();
    // 即使无卡，也尽量把露在正文的命令藏掉
    hideCtrlInMesText(textEl);
    return;
  }

  if (!host) {
    host = document.createElement('div');
    host.className = 'sdc-cards';
    // 旧版：直接挂在 mes_block 末尾（验证过能看见）
    root.appendChild(host);
  }

  // 重建扁卡
  host.innerHTML = '';
  const stack = document.createElement('div');
  stack.className = 'toy-lane-stack sdc-lane-stack';
  host.appendChild(stack);

  const enabled = new Set((deps.getEnabledLabels?.() || []).map((s) => s.toLowerCase()));
  const seenActors = [];

  /** 本条消息要自动开的开控（整批一次，避免逐条开把前一路掐掉） */
  const autoOns = [];

  cmds.forEach((cmd, idx) => {
    const actor = cmd.actor || 'Char';
    if (!seenActors.includes(actor)) seenActors.push(actor);
    const alt = seenActors.indexOf(actor) % 2 === 1;

    const wrap = document.createElement('div');
    wrap.className = 'sdc-lane-wrap';
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
          // 单卡继续：只动本路，不掐其它路
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

    if (cmd.incomplete) {
      const warn = document.createElement('div');
      warn.className = 'sdc-ctrl-card__warn';
      warn.textContent = '格式不完整：须带 强度:开毫秒:空毫秒:总毫秒';
      wrap.insertBefore(warn, actions);
    }
    if (cmd.fn && enabled.size && !enabled.has(String(cmd.fn).toLowerCase()) && !cmd.stopAll) {
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

  // 整批自动执行一次（对齐「多路齐开」；勿逐条 click）
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

  // 旧版同款：在气泡 HTML 里包一层隐藏（每次都做，防酒馆重绘冲掉）
  hideCtrlInMesText(textEl);
  void stripCtrlTags;
}

/** 显示层藏 [CTRL:…]，不改聊天存档 */
function hideCtrlInMesText(textEl) {
  if (!textEl) return;
  const CTRL_RE = /\[CTRL:[^\]]+\]/gi;

  // 已包过的不要先拆再包（减少闪烁）；只处理还裸着的
  let html = textEl.innerHTML;
  // 跳过已在 sdc-ctrl-hide 里的：用占位保护
  const kept = [];
  html = html.replace(/<span class="sdc-ctrl-hide">[\s\S]*?<\/span>/gi, (block) => {
    kept.push(block);
    return `\u0000SDC${kept.length - 1}\u0000`;
  });

  if (CTRL_RE.test(html)) {
    CTRL_RE.lastIndex = 0;
    html = html.replace(CTRL_RE, '<span class="sdc-ctrl-hide">$&</span>');
    html = html.replace(/\u0000SDC(\d+)\u0000/g, (_, i) => kept[Number(i)] || '');
    textEl.innerHTML = html;
    return;
  }

  // HTML 对不上时扫文本节点（排除已在隐藏层内的）
  const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
  const hits = [];
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue || !/\[CTRL:[^\]]+\]/i.test(node.nodeValue)) continue;
    if (node.parentElement?.closest?.('.sdc-ctrl-hide')) continue;
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
  const level = cmd.incomplete ? null : Number(cmd.level);
  const barW = level != null ? Math.max(0, Math.min(100, level * 10)) : 0;
  const gap = Number(cmd.gapMs);
  const mode = !cmd.incomplete && gap === 0 ? 'Hold' : !cmd.incomplete ? 'Pulse' : '';

  const details = [];
  details.push(`<span class="toy-lane-channel">${esc(cmd.fn || '?')}</span>`);
  if (mode) details.push(`<span class="toy-lane-mode">${mode}</span>`);
  if (mode === 'Hold') {
    details.push('<span class="toy-lane-hold">continuous</span>');
  } else if (!cmd.incomplete) {
    details.push(
      `<span class="toy-lane-chip"><span class="toy-lane-key">Width</span><span class="toy-lane-val">${esc(cmd.widthMs)}ms</span></span>`,
    );
    details.push(
      `<span class="toy-lane-chip"><span class="toy-lane-key">Gap</span><span class="toy-lane-val">${esc(cmd.gapMs)}ms</span></span>`,
    );
  }
  if (!cmd.incomplete && cmd.durationMs != null) {
    const durLabel = Number(cmd.durationMs) === 0 ? '∞' : `${cmd.durationMs}ms`;
    details.push(
      `<span class="toy-lane-chip"><span class="toy-lane-key">Dur</span><span class="toy-lane-val">${esc(durLabel)}</span></span>`,
    );
  }

  const pctHtml =
    level != null
      ? `<span class="toy-lane-pct">${esc(level)}/10</span>`
      : '<span class="toy-lane-pct toy-lane-pct-empty">—</span>';

  const barHtml =
    level != null
      ? `<div class="toy-lane-bar" aria-hidden="true"><i style="width:${barW}%"></i></div>`
      : '';

  return (
    `<article class="toy-lane-card compact ${laneTone}${altCls}">` +
    `<div class="toy-lane-who">` +
    `<span class="toy-lane-heart" aria-hidden="true">${heart}</span>` +
    `<span class="toy-lane-name">${actor}</span>` +
    `<span class="toy-lane-role">control</span>` +
    pctHtml +
    `</div>` +
    `<div class="toy-lane-detail">${details.join('')}</div>` +
    barHtml +
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

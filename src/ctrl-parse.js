/**
 * 解析 [CTRL:…]（纯函数）
 * 开控形态：[CTRL:短名:功能:强度1-10:开毫秒:空毫秒:总毫秒] 四数缺一不可
 */

/**
 * @typedef {object} CtrlCommand
 * @property {string} actor
 * @property {string} [fn]
 * @property {number} [level] 1～10
 * @property {number} [widthMs]
 * @property {number} [gapMs]
 * @property {number} [durationMs]
 * @property {boolean} [off]
 * @property {boolean} [stopAll]
 * @property {boolean} [incomplete] 缺字段，不可驱动
 * @property {string} raw
 */

const CTRL_RE =
  /\[CTRL:([^:\]]+):([^:\]]+)(?::([^:\]]+))?(?::([^:\]]+))?(?::([^:\]]+))?(?::([^:\]]+))?\]/gi;

function num(s) {
  const n = Number(String(s || '').trim());
  return Number.isFinite(n) ? n : NaN;
}

/**
 * @param {string} text
 * @returns {CtrlCommand[]}
 */
export function parseCtrlCommands(text) {
  const out = [];
  const src = String(text || '');
  CTRL_RE.lastIndex = 0;
  let m;
  while ((m = CTRL_RE.exec(src)) !== null) {
    const actor = String(m[1] || '').trim();
    const second = String(m[2] || '').trim();
    const a = m[3] != null ? String(m[3]).trim() : null;
    const b = m[4] != null ? String(m[4]).trim() : null;
    const c = m[5] != null ? String(m[5]).trim() : null;
    const d = m[6] != null ? String(m[6]).trim() : null;
    const raw = m[0];

    if (/^STOPALL$/i.test(second) && a == null) {
      out.push({ actor, stopAll: true, raw });
      continue;
    }
    if (a != null && /^OFF$/i.test(a) && b == null) {
      out.push({ actor, fn: second, off: true, raw });
      continue;
    }

    // 完整开控：强度:开:空:总
    if (a != null && b != null && c != null && d != null) {
      const level = Math.round(num(a));
      const widthMs = Math.round(num(b));
      const gapMs = Math.round(num(c));
      const durationMs = Math.round(num(d));
      if (
        !Number.isFinite(level) ||
        !Number.isFinite(widthMs) ||
        !Number.isFinite(gapMs) ||
        !Number.isFinite(durationMs)
      ) {
        out.push({ actor, fn: second, incomplete: true, raw });
        continue;
      }
      out.push({
        actor,
        fn: second,
        level: Math.max(0, Math.min(10, level)),
        widthMs: Math.max(0, widthMs),
        gapMs: Math.max(0, gapMs),
        durationMs: Math.max(0, durationMs),
        raw,
      });
      continue;
    }

    // 旧式或缺段：标 incomplete，不驱动
    out.push({
      actor,
      fn: second,
      incomplete: true,
      raw,
    });
  }
  return out;
}

export const CTRL_HIDE_FIND = '\\[CTRL:[^\\]]+\\]';
export const CTRL_HIDE_REPLACE = '';

export function stripCtrlTags(text) {
  return String(text || '')
    .replace(/\[CTRL:[^\]]+\]/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** 是否可交给驱动执行 */
export function isRunnableCtrl(cmd) {
  if (!cmd || cmd.incomplete || cmd.off || cmd.stopAll) return false;
  return (
    !!cmd.fn &&
    cmd.level > 0 &&
    Number.isFinite(cmd.widthMs) &&
    Number.isFinite(cmd.gapMs) &&
    Number.isFinite(cmd.durationMs)
  );
}

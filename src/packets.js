/**
 * 开/关包与档位拼装（纯计算，不碰蓝牙）。
 * 对齐实验室：档位默认 1～10；levelScale===10 时发出前 ×10。
 */

export function parseHex(text) {
  const clean = String(text || '').replace(/[^0-9a-fA-F]/g, '');
  if (!clean || clean.length % 2) {
    throw new Error('十六进制长度须为偶数');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

export function toHex(buf) {
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

export function resolveLevelIndex(len, stored) {
  let idx = Number(stored);
  if (!Number.isFinite(idx)) idx = -2;
  if (idx < 0) idx = len + idx;
  if (idx < 0 || idx >= len) idx = Math.max(0, len - 1);
  return idx;
}

/**
 * @param {Uint8Array} onBytes
 * @param {number} level 设备档 0～levelMax（常用 1～10）
 * @param {number|null} levelByteIndex
 * @param {number} [levelScale] 为 10 时写出 10～100
 */
export function packetWithLevel(onBytes, level, levelByteIndex, levelScale = 1) {
  const out = new Uint8Array(onBytes);
  const idx = resolveLevelIndex(out.length, levelByteIndex);
  const lv = Math.max(0, Math.min(10, Number(level) || 0));
  const scaled = Number(levelScale) === 10 ? Math.round(lv * 10) : lv;
  out[idx] = scaled & 0xff;
  if (out.length >= 6 && out[0] === 0x55 && lv > 0) {
    out[out.length - 3] = 0x01;
  }
  return out;
}

/**
 * CTRL 强度（拍板 1～10）→ 档案档位。
 * 兼容误写 11～100：按 ÷10 收敛到档（不鼓励，世界书禁止）。
 */
export function mapCtrlLevelToDeviceLevel(level, levelMin = 1, levelMax = 10) {
  let p = Number(level) || 0;
  if (p <= 0) return 0;
  if (p > 10 && p <= 100) p = Math.round(p / 10);
  const lo = Number(levelMin) || 1;
  const hi = Number(levelMax) || 10;
  return Math.max(lo, Math.min(hi, Math.round(p)));
}

/** @deprecated 用 mapCtrlLevelToDeviceLevel */
export function mapCtrlPowerToDeviceLevel(power, levelMin = 1, levelMax = 10) {
  return mapCtrlLevelToDeviceLevel(power, levelMin, levelMax);
}

function frame55Off(cmd) {
  return new Uint8Array([0x55, cmd & 0xff, 0, 0, 0, 0, 0xaa]);
}

export function extractOnOff(fn) {
  let onHex = String(fn?.onPacketHex || '').trim();
  let offHex = String(fn?.offPacketHex || fn?.offHex || '').trim();
  const samples = fn?.samplePacketsHex || [];
  for (const s of samples) {
    const t = String(s || '').trim();
    if (/^开\s*:/i.test(t)) onHex = t.replace(/^开\s*:/i, '').trim();
    else if (/^关\s*:/i.test(t)) offHex = t.replace(/^关\s*:/i, '').trim();
  }
  return { onHex, offHex };
}

export function buildStopPackets(fn) {
  const { onHex, offHex } = extractOnOff(fn);
  const list = [];
  try {
    const on = parseHex(onHex);
    if (on.length >= 6 && on[0] === 0x55) {
      list.push(frame55Off(on[1]));
      list.push(new Uint8Array([0x55, 0x04, 0, 0, 0, 0, 0xaa]));
      for (const cmd of [0x03, 0x08, 0x09, 0x01, on[1]]) {
        list.push(frame55Off(cmd));
      }
    }
  } catch (_) {
    /* ignore */
  }
  try {
    if (offHex) list.push(parseHex(offHex));
  } catch (_) {
    /* ignore */
  }
  if (!list.length) list.push(new Uint8Array([0x00]));
  return list;
}

/** 按 label 或 functions 键查找功能 */
export function findFunction(profile, name) {
  const want = String(name || '').trim();
  if (!want || !profile?.functions) return null;
  const funcs = profile.functions;
  if (funcs[want]) return { key: want, fn: funcs[want] };
  const lower = want.toLowerCase();
  for (const [key, fn] of Object.entries(funcs)) {
    const label = String(fn?.label || fn?.note || key).trim();
    if (label === want || label.toLowerCase() === lower || key.toLowerCase() === lower) {
      return { key, fn };
    }
  }
  return null;
}

export function collectOptionalServices(profile) {
  const set = new Set();
  const funcs = profile?.functions || {};
  for (const fn of Object.values(funcs)) {
    const s = String(fn?.serviceUuid || '').trim();
    if (s) set.add(s.toLowerCase());
  }
  return [...set];
}

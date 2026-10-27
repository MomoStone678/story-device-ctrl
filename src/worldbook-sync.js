/**
 * 档案 ⇔ 酒馆世界书条目同步（R5）
 * 一书一档：书名「戏控台 · 显示名」（不再用 SDC__id）；面板开关 ↔ entry.disable + 是否勾进全局世界书
 */

import {
  createNewWorldInfo,
  createWorldInfoEntry,
  loadWorldInfo,
  saveWorldInfo,
  selected_world_info,
  updateWorldInfoList,
  world_names,
} from '../../../../world-info.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { buildWorldbookBody, worldbookCommentFor } from './worldbook-body.js';

/** @deprecated 旧版书名；同步时若仍存在会迁走 */
export function bookNameForProfileId(profileId) {
  return `SDC__${String(profileId)}`;
}

export function preferredBookName(displayName) {
  const name = String(displayName || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 40)
    .trim();
  return `戏控台 · ${name || '设备档案'}`;
}

function isOurEntry(entry) {
  const c = String(entry?.comment || '');
  return c.startsWith('戏控台') || c.startsWith('SDC ·');
}

/**
 * 解析本书应用的世界书名：优先沿用已记录的；从 SDC__ 迁到正常名；重名则加短后缀。
 * @param {string} profileId
 * @param {{ displayName?: string, worldbook?: string|null }} row
 */
export function resolveBookName(profileId, row) {
  const desired = preferredBookName(row?.displayName);
  const prev = row?.worldbook ? String(row.worldbook) : '';

  // 已是目标名
  if (prev === desired) return desired;
  // 已是「目标名 · 后缀」且未改显示名意图时沿用
  if (prev.startsWith(`${desired} · `)) return prev;
  // 仍挂在旧 SDC__ 上：改用正常名
  if (!prev || prev.startsWith('SDC__')) {
    if (!world_names.includes(desired)) return desired;
    // 目标名被占：若占的就是 prev（不应发生）或加短码
    const short = String(profileId).replace(/^p_/, '').slice(-6) || '1';
    const tagged = `${desired} · ${short}`;
    return world_names.includes(tagged) ? `${desired} · ${profileId}` : tagged;
  }
  // 用户改过显示名：尽量换到新名；被占则保留旧书名以免串档
  if (!world_names.includes(desired)) return desired;
  return prev || desired;
}

async function ensureBook(bookName) {
  await updateWorldInfoList();
  if (world_names.includes(bookName)) {
    return loadWorldInfo(bookName);
  }
  const ok = await createNewWorldInfo(bookName, { interactive: false });
  if (!ok) {
    await updateWorldInfoList();
    const data = await loadWorldInfo(bookName);
    if (data) return data;
    throw new Error('无法创建世界书：' + bookName);
  }
  return loadWorldInfo(bookName);
}

function pickOrCreateEntry(data, comment) {
  const entries = data.entries || {};
  for (const e of Object.values(entries)) {
    if (isOurEntry(e)) return e;
  }
  const entry = createWorldInfoEntry('戏控台', data);
  if (!entry) throw new Error('无法创建世界书条目');
  entry.comment = comment;
  entry.addMemo = true;
  entry.constant = true;
  entry.key = [];
  entry.keysecondary = [];
  entry.disable = false;
  entry.order = 100;
  return entry;
}

function setBookSelected(bookName, enabled) {
  const idx = selected_world_info.indexOf(bookName);
  if (enabled && idx === -1) {
    selected_world_info.push(bookName);
  } else if (!enabled && idx !== -1) {
    selected_world_info.splice(idx, 1);
  }
  try {
    const $sel = $('#world_info');
    if ($sel.length) {
      $sel.find('option').each(function () {
        const t = $(this).text();
        if (t === bookName) $(this).prop('selected', enabled);
      });
      $sel.trigger('change');
    }
  } catch (_) {
    /* ignore */
  }
  saveSettingsDebounced();
}

/**
 * 导入/更新后同步世界书
 * @param {string} profileId
 * @param {object} profile
 * @param {{ displayName: string, enabled: boolean, worldbook?: string|null }} row
 */
export async function syncProfileWorldbook(profileId, profile, row) {
  await updateWorldInfoList();
  const bookName = resolveBookName(profileId, row);
  const data = await ensureBook(bookName);
  const comment = worldbookCommentFor(row.displayName);
  const entry = pickOrCreateEntry(data, comment);
  entry.comment = comment;
  entry.content = buildWorldbookBody(profile, { displayName: row.displayName });
  entry.constant = true;
  entry.disable = !row.enabled;
  entry.position = entry.position ?? 4;
  entry.depth = entry.depth ?? 2;
  entry.order = entry.order ?? 100;
  entry.probability = 100;
  entry.useProbability = true;
  await saveWorldInfo(bookName, data, true);
  await updateWorldInfoList();
  setBookSelected(bookName, !!row.enabled);

  // 若从旧 SDC__ 迁出，取消勾选旧书（不删文件，免误伤）
  const legacy = bookNameForProfileId(profileId);
  if (legacy !== bookName && world_names.includes(legacy)) {
    setBookSelected(legacy, false);
  }
  return bookName;
}

/**
 * @param {string} profileId
 * @param {boolean} enabled
 * @param {string} [bookNameHint] 档案里记下的世界书名
 */
export async function setProfileWorldbookEnabled(profileId, enabled, bookNameHint) {
  await updateWorldInfoList();
  const candidates = [bookNameHint, bookNameForProfileId(profileId)].filter(Boolean);
  let used = '';
  let data = null;
  for (const name of candidates) {
    if (!world_names.includes(name)) continue;
    data = await loadWorldInfo(name);
    if (data?.entries) {
      used = name;
      break;
    }
  }
  if (data?.entries && used) {
    for (const e of Object.values(data.entries)) {
      if (isOurEntry(e)) e.disable = !enabled;
    }
    await saveWorldInfo(used, data, true);
    setBookSelected(used, enabled);
  }
}

/**
 * 档案 ⇔ 酒馆世界书条目同步（R5）
 * 一书一档：书名 SDC__{id}；常量条目；面板开关 ↔ entry.disable + 是否勾进全局世界书
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

export function bookNameForProfileId(profileId) {
  return `SDC__${String(profileId)}`;
}

async function ensureBook(bookName) {
  await updateWorldInfoList();
  if (world_names.includes(bookName)) {
    return loadWorldInfo(bookName);
  }
  const ok = await createNewWorldInfo(bookName, { interactive: false });
  if (!ok) {
    // 可能已存在或命名冲突：再试加载
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
    if (e && String(e.comment || '').startsWith('SDC ·')) return e;
  }
  const entry = createWorldInfoEntry(bookNameForProfileId('x'), data);
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
 * @param {{ displayName: string, enabled: boolean }} row
 */
export async function syncProfileWorldbook(profileId, profile, row) {
  const bookName = bookNameForProfileId(profileId);
  const data = await ensureBook(bookName);
  const entry = pickOrCreateEntry(data, worldbookCommentFor(row.displayName, profileId));
  entry.comment = worldbookCommentFor(row.displayName, profileId);
  entry.content = buildWorldbookBody(profile, { displayName: row.displayName });
  entry.constant = true;
  entry.disable = !row.enabled;
  // 对齐 Intiface 世界书常用注入：@D 深度、靠后插入，避免被淹没
  entry.position = entry.position ?? 4;
  entry.depth = entry.depth ?? 2;
  entry.order = entry.order ?? 100;
  entry.probability = 100;
  entry.useProbability = true;
  await saveWorldInfo(bookName, data, true);
  await updateWorldInfoList();
  setBookSelected(bookName, !!row.enabled);
  return bookName;
}

export async function setProfileWorldbookEnabled(profileId, enabled) {
  const bookName = bookNameForProfileId(profileId);
  const data = await loadWorldInfo(bookName);
  if (data?.entries) {
    for (const e of Object.values(data.entries)) {
      if (e && String(e.comment || '').startsWith('SDC ·')) {
        e.disable = !enabled;
      }
    }
    await saveWorldInfo(bookName, data, true);
  }
  setBookSelected(bookName, enabled);
}

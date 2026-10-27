/**
 * SillyTavern 扩展入口 · story-device-ctrl
 * S2 驱动 + S3 面板/世界书/卡片。不启动外置桥进程。
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types, chat } from '../../../../script.js';
import { StoryDeviceBleDriver } from './src/driver.js';
import { mountPanel } from './src/panel.js';
import { bindCtrlCards } from './src/cards.js';
import { syncProfileWorldbook, setProfileWorldbookEnabled } from './src/worldbook-sync.js';

export const EXTENSION_NAME = 'story-device-ctrl';
const MODULE = 'story-device-ctrl';

const defaultSettings = {
  profiles: {},
  currentProfileId: null,
  emoji: '📡',
};

/** @type {StoryDeviceBleDriver} */
export let driver = null;

function ensureSettings() {
  if (!extension_settings[MODULE]) {
    extension_settings[MODULE] = structuredClone(defaultSettings);
  }
  const s = extension_settings[MODULE];
  if (!s.profiles || typeof s.profiles !== 'object') s.profiles = {};
  if (!s.emoji) s.emoji = defaultSettings.emoji;
  return s;
}

function syncDriverProfiles() {
  const s = ensureSettings();
  const entries = Object.entries(s.profiles).map(([id, row]) => [id, row.profile || row]);
  driver.setProfiles(entries);
  if (s.currentProfileId) {
    driver.setCurrentProfileId(s.currentProfileId).catch(() => {});
  }
}

export function importProfile(profile, meta = {}) {
  const s = ensureSettings();
  if (!profile || typeof profile !== 'object' || !profile.functions) {
    throw new Error('档案缺少 functions');
  }
  const id = meta.id || `p_${Date.now().toString(36)}`;
  const deviceName = String(profile?.deviceName || '').trim();
  const displayName =
    String(meta.displayName || '').trim() ||
    deviceName ||
    `设备档案 ${Object.keys(s.profiles).length + 1}`;
  s.profiles[id] = {
    displayName,
    enabled: true,
    profile,
    worldbook: null,
  };
  if (!s.currentProfileId) s.currentProfileId = id;
  saveSettingsDebounced();
  syncDriverProfiles();
  syncProfileWorldbook(id, profile, s.profiles[id])
    .then((book) => {
      s.profiles[id].worldbook = book;
      saveSettingsDebounced();
    })
    .catch((e) => console.warn(`[${EXTENSION_NAME}] worldbook`, e));
  return id;
}

export async function setCurrentProfile(id) {
  const s = ensureSettings();
  if (id && !s.profiles[id]) throw new Error('档案不存在');
  s.currentProfileId = id || null;
  saveSettingsDebounced();
  return driver.setCurrentProfileId(s.currentProfileId);
}

export async function setEnabled(id, enabled) {
  const s = ensureSettings();
  const row = s.profiles[id];
  if (!row) return;
  row.enabled = !!enabled;
  saveSettingsDebounced();
  try {
    await setProfileWorldbookEnabled(id, row.enabled);
  } catch (e) {
    console.warn(`[${EXTENSION_NAME}] toggle WI`, e);
  }
}

export function renameProfile(id, displayName) {
  const s = ensureSettings();
  const row = s.profiles[id];
  if (!row) return;
  row.displayName = displayName || row.displayName;
  saveSettingsDebounced();
  syncProfileWorldbook(id, row.profile, row).catch(() => {});
}

export async function removeProfile(id) {
  const s = ensureSettings();
  delete s.profiles[id];
  if (s.currentProfileId === id) s.currentProfileId = Object.keys(s.profiles)[0] || null;
  saveSettingsDebounced();
  syncDriverProfiles();
  await driver.setCurrentProfileId(s.currentProfileId);
}

function getEnabledLabels() {
  const s = ensureSettings();
  const labels = [];
  for (const row of Object.values(s.profiles)) {
    if (!row?.enabled) continue;
    const funcs = row.profile?.functions || {};
    for (const [key, fn] of Object.entries(funcs)) {
      labels.push(String(fn?.label || fn?.note || key).trim());
    }
  }
  return labels.filter(Boolean);
}

/**
 * 对齐 Intiface：显示期正则把 [CTRL] 包进隐藏层（不要空替换）。
 * markdownOnly=true → 只动气泡显示，不改存档、不影响出卡解析。
 */
function ensureDisplayRegex() {
  try {
    if (!extension_settings.regex) extension_settings.regex = [];
    const NAME = 'SDC · 隐藏 [CTRL] 标记';
    const findRegex = '/(\\[CTRL:[^\\]]+\\])/gi';
    const replaceString = '<span class="sdc-ctrl-hide">$1</span>';
    const existing = extension_settings.regex.find((r) => r?.scriptName === NAME);
    if (existing) {
      existing.findRegex = findRegex;
      existing.replaceString = replaceString;
      existing.placement = [1, 2];
      existing.disabled = false;
      existing.markdownOnly = true;
      existing.promptOnly = false;
      existing.runOnEdit = true;
    } else {
      extension_settings.regex.push({
        id: `sdc-hide-ctrl-${Date.now().toString(36)}`,
        scriptName: NAME,
        findRegex,
        replaceString,
        trimStrings: [],
        placement: [1, 2],
        disabled: false,
        markdownOnly: true,
        promptOnly: false,
        runOnEdit: true,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
      });
    }
    saveSettingsDebounced();
  } catch (e) {
    console.warn(`[${EXTENSION_NAME}] ensureDisplayRegex`, e);
  }
}

jQuery(async () => {
  ensureSettings();
  ensureDisplayRegex();
  driver = new StoryDeviceBleDriver({
    log: (m) => console.debug(`[${EXTENSION_NAME}]`, m),
  });
  syncDriverProfiles();

  // 启动时把已导入档案的世界书正文刷成最新模板（不改用户显示名/开关）
  (async () => {
    const s = ensureSettings();
    for (const [id, row] of Object.entries(s.profiles || {})) {
      if (!row?.profile) continue;
      try {
        const book = await syncProfileWorldbook(id, row.profile, row);
        row.worldbook = book;
      } catch (e) {
        console.warn(`[${EXTENSION_NAME}] refresh WI`, id, e);
      }
    }
    saveSettingsDebounced();
  })();

  try {
    const html = `
      <div class="story-device-ctrl-settings">
        <div class="inline-drawer">
          <div class="inline-drawer-toggle inline-drawer-header">
            <b>Story Device Ctrl</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
          </div>
          <div class="inline-drawer-content">
            <p>主面板：点快捷回复一带的 Emoji（默认 📡）。</p>
            <p>驱动在扩展内用网页蓝牙，不另开进程。</p>
          </div>
        </div>
      </div>`;
    $('#extensions_settings').append(html);
  } catch (e) {
    console.warn(`[${EXTENSION_NAME}] settings UI skip`, e);
  }

  mountPanel({
    emoji: ensureSettings().emoji,
    getSettings: ensureSettings,
    importProfile,
    setCurrentProfile,
    setEnabled,
    rename: renameProfile,
    remove: removeProfile,
    connect: () => driver.connect(),
    disconnect: () => driver.disconnect(),
    stopAll: () => driver.stopAll(),
    getDriverState: () => ({
      status: driver.status,
      connected: driver.isConnected,
      currentId: driver.currentProfileId,
    }),
  });

  bindCtrlCards({
    driver,
    eventSource,
    event_types,
    getChat: () => chat,
    getEnabledLabels,
  });

  window.StoryDeviceCtrl = {
    driver,
    importProfile,
    setCurrentProfile,
    setEnabled,
    getSettings: ensureSettings,
  };

  console.info(`[${EXTENSION_NAME}] loaded · panel + Web Bluetooth (no external process)`);
});

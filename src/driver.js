/**
 * 扩展内网页蓝牙驱动（R2 / R7 / R10）。
 * HOLD：空毫秒=0 连续开；PULSE：开→真停→空 循环；总毫秒到点自动停。
 * 多功能：各路独立跑；同批注入先全停再齐开（避免「后开的把先开的掐掉」）。
 */

import {
  buildStopPackets,
  collectOptionalServices,
  extractOnOff,
  findFunction,
  mapCtrlLevelToDeviceLevel,
  packetWithLevel,
  parseHex,
  toHex,
} from './packets.js';
import { WriteQueue } from './write-queue.js';

/** 同批多路：全停后歇多久再齐开（毫秒）。给链路排空，不是私有通道名。 */
export const BATCH_AFTER_STOP_MS = 500;
/** 同批多路脉冲时，开着的时间至少这么久，避免写包排队后体感只剩一路 */
export const MIN_MULTI_PULSE_ON_MS = 550;

function sleep(ms, timers) {
  return new Promise((r) => timers.setTimeout(r, ms));
}

function emptyRun() {
  return {
    timer: null,
    durationTimer: null,
    stopFlag: false,
    epoch: 0,
    loopActive: false,
    /** 本路硬件是否仍视为「开着」；写关或同特征被关后变 false，保活须再软启 */
    hwOn: false,
  };
}

function sameChar(fn, serviceUuid, characteristicUuid) {
  if (!fn) return false;
  return (
    String(fn.serviceUuid || '').toLowerCase() === String(serviceUuid || '').toLowerCase() &&
    String(fn.characteristicUuid || '').toLowerCase() === String(characteristicUuid || '').toLowerCase()
  );
}

export class StoryDeviceBleDriver {
  /**
   * @param {object} [opts]
   * @param {Bluetooth} [opts.bluetooth]
   * @param {number} [opts.keepaliveMs]
   * @param {number} [opts.batchAfterStopMs]
   * @param {{ setTimeout: Function, clearInterval: Function, setInterval: Function, clearTimeout?: Function }} [opts.timers]
   * @param {(msg: string) => void} [opts.log]
   */
  constructor(opts = {}) {
    this._bt = opts.bluetooth ?? (typeof navigator !== 'undefined' ? navigator.bluetooth : null);
    this._keepaliveMs = opts.keepaliveMs ?? 500;
    this._batchAfterStopMs = opts.batchAfterStopMs ?? BATCH_AFTER_STOP_MS;
    this._timers = opts.timers ?? {
      setTimeout: (...a) => setTimeout(...a),
      clearTimeout: (...a) => clearTimeout(...a),
      clearInterval: (...a) => clearInterval(...a),
      setInterval: (...a) => setInterval(...a),
    };
    this._log = opts.log ?? (() => {});

    /** @type {Map<string, object>} */
    this._profiles = new Map();
    this._currentId = null;

    this._device = null;
    this._server = null;
    this._charCache = new Map();

    /** @type {Map<string, ReturnType<typeof emptyRun>>} 按功能 key 分路 */
    this._runs = new Map();
    this._queue = new WriteQueue();
    this.writes = [];
    this._status = 'idle';
    this._lastError = '';
  }

  get status() {
    return this._status;
  }

  get lastError() {
    return this._lastError;
  }

  get currentProfileId() {
    return this._currentId;
  }

  get currentProfile() {
    return this._currentId ? this._profiles.get(this._currentId) || null : null;
  }

  get isConnected() {
    return !!(this._server && this._server.connected);
  }

  /** 当前正在跑的功能 key 列表（自测/面板用） */
  get activeFunctionKeys() {
    return [...this._runs.keys()].filter((k) => {
      const r = this._runs.get(k);
      return r && !r.stopFlag && (r.timer || r.loopActive || r.durationTimer != null || r.hwOn);
    });
  }

  usesExternalProcess() {
    return false;
  }

  setProfiles(entries) {
    this._profiles = new Map(entries || []);
  }

  upsertProfile(id, profile) {
    this._profiles.set(String(id), profile);
  }

  removeProfile(id) {
    const key = String(id);
    this._profiles.delete(key);
    if (this._currentId === key) this._currentId = null;
  }

  async setCurrentProfileId(id) {
    const next = id == null || id === '' ? null : String(id);
    if (next && !this._profiles.has(next)) {
      throw new Error('档案不存在：' + next);
    }
    const changed = next !== this._currentId;
    if (changed && this.isConnected) {
      await this.disconnect();
    }
    this._currentId = next;
    return { needReconnect: changed && !!next };
  }

  async connect() {
    if (!this._currentId) throw new Error('未选择当前档案');
    const profile = this.currentProfile;
    if (!profile) throw new Error('当前档案无效');
    if (!this._bt || typeof this._bt.requestDevice !== 'function') {
      throw new Error('当前环境不支持网页蓝牙（请用 Chrome，且无外置桥）');
    }
    this._status = 'connecting';
    this._lastError = '';
    try {
      const optionalServices = collectOptionalServices(profile);
      this._device = await this._bt.requestDevice({
        acceptAllDevices: true,
        optionalServices: optionalServices.length ? optionalServices : undefined,
      });
      this._device.addEventListener?.('gattserverdisconnected', () => {
        this._onDisconnected();
      });
      this._server = await this._device.gatt.connect();
      this._charCache.clear();
      this._status = 'connected';
      this._log('已连接 GATT');
    } catch (e) {
      this._status = 'error';
      this._lastError = e?.message || String(e);
      this._server = null;
      this._device = null;
      throw e;
    }
  }

  async connectWithServer(server, device = null) {
    this._server = server;
    this._device = device;
    this._charCache.clear();
    this._status = server?.connected ? 'connected' : 'idle';
  }

  async disconnect() {
    await this.stopAll().catch(() => {});
    try {
      if (this._device?.gatt?.connected) this._device.gatt.disconnect();
    } catch (_) {
      /* ignore */
    }
    this._onDisconnected();
  }

  _onDisconnected() {
    this._clearAllTimers();
    this._runs.clear();
    this._server = null;
    this._charCache.clear();
    if (this._status !== 'error') this._status = 'idle';
  }

  _getRun(key) {
    if (!this._runs.has(key)) this._runs.set(key, emptyRun());
    return this._runs.get(key);
  }

  _clearRunTimers(run) {
    if (!run) return;
    if (run.timer) {
      this._timers.clearInterval(run.timer);
      run.timer = null;
    }
    if (run.durationTimer != null) {
      (this._timers.clearTimeout || this._timers.clearInterval)(run.durationTimer);
      run.durationTimer = null;
    }
  }

  _clearAllTimers() {
    for (const run of this._runs.values()) this._clearRunTimers(run);
  }

  async _getCharacteristic(serviceUuid, characteristicUuid) {
    if (!this._server?.connected) throw new Error('未连接设备');
    const cacheKey = `${serviceUuid}::${characteristicUuid}`.toLowerCase();
    if (this._charCache.has(cacheKey)) return this._charCache.get(cacheKey);
    const svc = await this._server.getPrimaryService(serviceUuid);
    const ch = await svc.getCharacteristic(characteristicUuid);
    this._charCache.set(cacheKey, ch);
    return ch;
  }

  async _rawWrite(ch, bytes, writeMode) {
    const mode = String(writeMode || '').toLowerCase();
    const preferNr = !mode || mode.includes('without') || mode === 'nr';
    const order = preferNr ? ['nr', 'wr'] : ['wr', 'nr'];
    let lastErr = null;
    for (const kind of order) {
      try {
        if (kind === 'nr') {
          if (typeof ch.writeValueWithoutResponse === 'function') {
            await ch.writeValueWithoutResponse(bytes);
          } else {
            await ch.writeValue(bytes);
          }
        } else if (typeof ch.writeValueWithResponse === 'function') {
          await ch.writeValueWithResponse(bytes);
        } else {
          await ch.writeValue(bytes);
        }
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('写入失败');
  }

  async _write(fn, bytes, role) {
    const ch = await this._getCharacteristic(fn.serviceUuid, fn.characteristicUuid);
    await this._rawWrite(ch, bytes, fn.writeMode);
    this.writes.push({ role, hex: toHex(bytes), at: Date.now(), label: fn.label || '' });
    this._log(`${role} → ${toHex(bytes)}`);
    // 同特征上的关包会把其它路也打灭 → 那些路保活时必须再软启，不能直开高档
    if (role === '关') {
      this._markCharHwOff(fn.serviceUuid, fn.characteristicUuid);
    }
  }

  _markCharHwOff(serviceUuid, characteristicUuid) {
    const profile = this.currentProfile;
    if (!profile) return;
    for (const [key, run] of this._runs) {
      const fn = profile.functions?.[key];
      if (sameChar(fn, serviceUuid, characteristicUuid)) {
        run.hwOn = false;
      }
    }
  }

  async _writeOff(fn, run, epoch) {
    const packets = buildStopPackets(fn);
    for (const pkt of packets) {
      if (run.epoch !== epoch || run.stopFlag) return;
      await this._write(fn, pkt, '关');
      await sleep(40, this._timers);
    }
    if (run) run.hwOn = false;
  }

  /**
   * 软启阶梯写开。已在转则不要每拍重爬（由调用方用 hwOn 判断）。
   * @returns {Promise<boolean>} 是否完整写完
   */
  async _softRampOn(writeOn, level, run, epoch) {
    const ramp = level >= 5 ? [3, 5, level] : [level];
    for (const step of ramp) {
      if (run.stopFlag || run.epoch !== epoch) return false;
      await this._queue.enqueue(async () => {
        if (run.stopFlag || run.epoch !== epoch) return;
        await writeOn(step);
      });
      await sleep(60, this._timers);
    }
    return !run.stopFlag && run.epoch === epoch;
  }

  /**
   * 同消息多条 CTRL：先全停→歇→再齐开（单条点「继续」仍走 setFunction，不掐其它路）
   * @param {Array<{ fn?: string, level?: number, widthMs?: number, gapMs?: number, durationMs?: number, off?: boolean, stopAll?: boolean }>} cmds
   */
  async applyCtrlBatch(cmds) {
    const list = Array.isArray(cmds) ? cmds.filter(Boolean) : [];
    if (!list.length) return;

    if (list.some((c) => c.stopAll)) {
      await this.stopAll();
      return;
    }

    const offs = list.filter((c) => c.off && c.fn);
    const ons = list.filter(
      (c) =>
        !c.off &&
        !c.stopAll &&
        c.fn &&
        Number(c.level) > 0 &&
        Number.isFinite(Number(c.widthMs)) &&
        Number.isFinite(Number(c.gapMs)) &&
        Number.isFinite(Number(c.durationMs)),
    );

    for (const c of offs) {
      await this.stopFunction(c.fn);
    }
    if (!ons.length) return;

    // 对齐参考工程的批注入：先清场再齐开，避免后写盖前写
    await this.stopAll();
    await this._queue.drain();
    await sleep(this._batchAfterStopMs, this._timers);

    const multiPulse = ons.filter((c) => Number(c.gapMs) > 0).length >= 2;
    // 并行启动各路；GATT 写仍经同一队列串行
    await Promise.all(
      ons.map((c) => {
        let widthMs = Math.max(50, Number(c.widthMs) || 200);
        if (multiPulse) widthMs = Math.max(widthMs, MIN_MULTI_PULSE_ON_MS);
        return this.setFunction(c.fn, {
          level: c.level,
          widthMs,
          gapMs: c.gapMs,
          durationMs: c.durationMs,
          _fromBatch: true,
        });
      }),
    );
  }

  /**
   * @param {string} name
   * @param {number|object} levelOrOpts 强度 1～10，或 { level, widthMs, gapMs, durationMs }
   * @param {object} [maybeOpts]
   */
  async setFunction(name, levelOrOpts, maybeOpts) {
    const opts =
      typeof levelOrOpts === 'object' && levelOrOpts
        ? levelOrOpts
        : { level: levelOrOpts, ...(maybeOpts || {}) };

    const widthMs = Math.max(50, Number(opts.widthMs) || 200);
    const gapMs = Math.max(0, Number(opts.gapMs) || 0);
    const durationMs = Math.max(0, Number(opts.durationMs) || 0);

    const profile = this.currentProfile;
    if (!profile) throw new Error('未选择当前档案');
    if (!this.isConnected) throw new Error('未连接设备');
    const hit = findFunction(profile, name);
    if (!hit) throw new Error('功能不存在：' + name);

    const level = mapCtrlLevelToDeviceLevel(
      opts.level,
      hit.fn.levelMin ?? 1,
      hit.fn.levelMax ?? 10,
    );
    if (level <= 0) {
      await this.stopFunction(name);
      return;
    }

    // 只停本路再重开；其它路继续（旧逻辑会 stop 其它 key → 多功能只剩最后一个）
    await this._stopRunOnly(hit.key, { writeOff: false });
    await this._queue.drain();

    const run = this._getRun(hit.key);
    run.stopFlag = false;
    run.epoch += 1;
    const myEpoch = run.epoch;
    run.loopActive = false;
    this._clearRunTimers(run);

    const { onHex } = extractOnOff(hit.fn);
    const baseOn = parseHex(onHex);
    const levelIdx =
      hit.fn.levelByteIndex != null ? hit.fn.levelByteIndex : resolveDefaultLevelIndex(baseOn);
    const scale = hit.fn.levelScale;

    const writeOn = async (lv) => {
      await this._write(hit.fn, packetWithLevel(baseOn, lv, levelIdx, scale), '开');
    };

    // 首次软启
    run.hwOn = false;
    const started = await this._softRampOn(writeOn, level, run, myEpoch);
    if (!started) return;
    run.hwOn = true;

    if (durationMs > 0) {
      run.durationTimer = this._timers.setTimeout(() => {
        if (run.epoch !== myEpoch) return;
        this.stopFunction(hit.key).catch(() => {});
      }, durationMs);
    }

    if (gapMs <= 0) {
      // HOLD：异步保活（勿只用 setInterval：关后直开高档会被拒，体感「只动一下」）
      run.loopActive = true;
      const holdLoop = async () => {
        while (!run.stopFlag && run.epoch === myEpoch && run.loopActive) {
          await sleep(this._keepaliveMs, this._timers);
          if (run.stopFlag || run.epoch !== myEpoch) return;
          try {
            if (!run.hwOn) {
              // 同特征被关过 / 写失败：高档必须再软启（对齐参考工程）
              const ok = await this._softRampOn(writeOn, level, run, myEpoch);
              if (!ok) {
                run.hwOn = false;
                continue;
              }
              run.hwOn = true;
            } else {
              await this._queue.enqueue(async () => {
                if (run.stopFlag || run.epoch !== myEpoch) return;
                await writeOn(level);
              });
              run.hwOn = true;
            }
          } catch (e) {
            run.hwOn = false;
            this._log('保活失败: ' + (e?.message || e));
          }
        }
      };
      holdLoop().catch((e) => this._log('连续结束: ' + (e?.message || e)));
      return;
    }

    // PULSE：开 WIDTH → 真停 → GAP（各路独立；写包仍排队）
    // 高档每一拍开都软启（写 0 后不能当「还在高档」直开）
    run.loopActive = true;
    const pulseOnce = async () => {
      while (!run.stopFlag && run.epoch === myEpoch && run.loopActive) {
        try {
          if (!run.hwOn && level >= 5) {
            const ok = await this._softRampOn(writeOn, level, run, myEpoch);
            if (!ok) break;
          } else {
            await this._queue.enqueue(async () => {
              if (run.stopFlag || run.epoch !== myEpoch) return;
              await writeOn(level);
            });
          }
          run.hwOn = true;
        } catch (e) {
          run.hwOn = false;
          this._log('脉冲开失败: ' + (e?.message || e));
          await sleep(120, this._timers);
          continue;
        }
        await sleep(widthMs, this._timers);
        if (run.stopFlag || run.epoch !== myEpoch) return;
        await this._queue.enqueue(async () => {
          if (run.stopFlag || run.epoch !== myEpoch) return;
          await this._writeOff(hit.fn, run, myEpoch);
        });
        run.hwOn = false;
        await sleep(gapMs, this._timers);
      }
    };
    pulseOnce().catch((e) => this._log('脉冲结束: ' + (e?.message || e)));
  }

  /**
   * 只停某一路的定时器/epoch，可选是否写关包
   */
  async _stopRunOnly(key, { writeOff = true } = {}) {
    if (!key) return;
    const run = this._runs.get(key);
    if (!run) return;
    run.epoch += 1;
    const stopEpoch = run.epoch;
    run.stopFlag = true;
    run.loopActive = false;
    this._clearRunTimers(run);

    if (!writeOff) {
      this._runs.delete(key);
      return;
    }

    const profile = this.currentProfile;
    const fn = profile?.functions?.[key];
    this._runs.delete(key);
    if (!fn || !this.isConnected) return;

    await this._queue.enqueue(async () => {
      // 若同 key 已又被新 setFunction 抬了 epoch，仍允许写关（stopEpoch 已固定）
      const packets = buildStopPackets(fn);
      for (const pkt of packets) {
        await this._write(fn, pkt, '关');
        await sleep(80, this._timers);
      }
      for (let r = 0; r < 2; r++) {
        await this._write(fn, packets[0], '关');
        await sleep(100, this._timers);
      }
      void stopEpoch;
    });
  }

  async stopFunction(name) {
    const profile = this.currentProfile;
    let key = null;
    if (name && profile) {
      const hit = findFunction(profile, name);
      if (hit) key = hit.key;
      else if (this._runs.has(String(name))) key = String(name);
    }
    if (!key) return;
    await this._stopRunOnly(key, { writeOff: true });
  }

  async stopAll() {
    const keys = [...this._runs.keys()];
    // 先抬所有 epoch，打断循环
    for (const key of keys) {
      const run = this._runs.get(key);
      if (!run) continue;
      run.epoch += 1;
      run.stopFlag = true;
      run.loopActive = false;
      this._clearRunTimers(run);
    }
    const profile = this.currentProfile;
    if (!profile || !this.isConnected) {
      this._runs.clear();
      return;
    }
    await this._queue.enqueue(async () => {
      for (const key of keys) {
        const fn = profile.functions?.[key];
        if (!fn) continue;
        const packets = buildStopPackets(fn);
        for (const pkt of packets) {
          await this._write(fn, pkt, '关');
          await sleep(60, this._timers);
        }
      }
    });
    this._runs.clear();
  }
}

function resolveDefaultLevelIndex(onBytes) {
  if (onBytes.length >= 2) return 1;
  return 0;
}

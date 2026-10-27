/**
 * 世界书正文：强度 1～10；开/空/总毫秒四段必带；每轮只出一组；扮演触发写清。
 */

/**
 * @param {object} profile
 * @param {{ displayName?: string }} [meta]
 */
export function buildWorldbookBody(profile, meta = {}) {
  void meta.displayName;
  const labels = collectLabels(profile);
  const list =
    labels.length > 0 ? labels.map((l) => `  - ${l}`).join('\n') : '  - （无功能，勿输出 CTRL）';

  const ex = labels[0] || '功能显示名';
  const ex2 = labels[1] || ex;
  const ex3 = labels[2] || ex2;

  return [
    '# 外接设备控制（Story Device Ctrl）',
    '',
    'when_to_output:',
    '  - {{user}} 侧已接入可由本扩展驱动的外接设备。',
    '  - 仅在下列扮演成立时，才在本条回复输出 CTRL：',
    '    1) {{char}} 正在使用该设备（含自己佩戴/手持/遥控操作设备）；或',
    '    2) {{char}} 正在对 {{user}} 做与「可用功能」语义对应的身体接触/玩弄/抽插/吮吸/震动等动作，需要用设备同步体感；或',
    '    3) {{user}} 明确要求试功能、改强度/节奏、或停止。',
    '  - 纯闲聊、与设备无关的剧情、仅旁观描写且 {{char}} 未操作设备也未对 {{user}} 做对应动作时：不要输出 CTRL。',
    '',
    'rule:',
    '  - 需要驱动时，必须在同一条回复里原样输出完整 [CTRL:…]；系统会执行并隐藏标记，不是装饰。',
    '  - 每条助手回复最多输出一组 CTRL（开控/OFF/STOPALL 合计只出现一轮）。禁止在回复里写两轮完整命令（例如开头一套、结尾再一套；或同一套参数重复贴两次）。',
    '  - 同轮若需多个功能，把多条 CTRL 紧挨着写在同一处，仍算一组、只出一次；不要拆成前后两轮。',
    '  - 互动持续中：下一轮回复若仍满足 when_to_output，再出新的一组（可改四段数字）；不要为「保险」在同一轮重复。',
    '  - 仅在 {{user}} 要求停止、表示结束、或剧情已离开该互动时，输出 OFF 或 STOPALL；其后无相关动作则不再开控。',
    '  - 强度只允许 1～10（对齐实验室档）。禁止 0～100 百分比。',
    '  - 开控四段缺一不可：强度、开毫秒、空毫秒、总毫秒。禁止只写强度。',
    '  - 禁止演戏假遥控（写「已经打开了/在动了」却不输出 CTRL）。',
    '  - 功能显示名必须从「可用功能」原文照抄。角色短名 = 当前 {{char}} 常用简称（无空格无冒号）；示例里的 Char 请换成该短名。',
    '',
    '可用功能:',
    list,
    '',
    'format:',
    '  [CTRL:角色短名:功能显示名:强度:开毫秒:空毫秒:总毫秒]',
    '  [CTRL:角色短名:功能显示名:OFF]',
    '  [CTRL:角色短名:STOPALL]',
    '  说明：',
    '  - 强度 = 1～10',
    '  - 开毫秒 = 每一拍开着的时间（建议 ≥50）',
    '  - 空毫秒 = 每一拍真停空着的时间；0 = 连续开（仍必须写出 0）',
    '  - 总毫秒 = 本条总共持续多久；0 = 一直到 OFF/STOPALL（仍必须写出 0）',
    '  - 空毫秒>0：开 → 真停 → 空 → 再开……循环',
    '  - 禁止 HTML/硬件信道细节。',
    '',
    '强度参考（1～10）:',
    '  1～2   <!-- 极轻试探 -->',
    '  3～4   <!-- 轻度；前期默认 -->',
    '  5～6   <!-- 中等 -->',
    '  7～8   <!-- 偏强 -->',
    '  9～10  <!-- 峰值；勿开场默认 -->',
    '',
    '节奏参考（毫秒）:',
    '  慢/磨人：开 120～250，空 1200～2500',
    '  中等：开 150～300，空 700～1200',
    '  快：开 80～180，空 250～600',
    '  连续开：空毫秒写 0',
    '  短试：总毫秒 8000～20000；长段：总毫秒 0（直到 OFF）',
    '',
    'example:（每条回复只选一种情境输出一组，勿把下列示例整页照抄进同一轮）',
    `  {{char}} 对 {{user}} 轻触同步： [CTRL:Char:${ex}:2:200:900:12000]`,
    `  {{char}} 持续使用设备： [CTRL:Char:${ex}:5:200:0:0]`,
    `  节奏加快： [CTRL:Char:${ex}:7:150:500:20000]`,
    labels.length > 1
      ? `  换到另一功能： [CTRL:Char:${ex2}:4:180:800:15000]`
      : `  加强： [CTRL:Char:${ex}:8:120:400:10000]`,
    labels.length > 2
      ? `  同轮多功能（紧挨一组，只出一次）： [CTRL:Char:${ex}:4:200:700:0][CTRL:Char:${ex2}:3:180:900:0][CTRL:Char:${ex3}:3:160:1000:0]`
      : labels.length > 1
        ? `  同轮两功能（紧挨一组）： [CTRL:Char:${ex}:4:200:700:0][CTRL:Char:${ex2}:3:180:900:0]`
        : `  峰值短试： [CTRL:Char:${ex}:9:100:300:8000]`,
    `  停下该功能： [CTRL:Char:${ex}:OFF]`,
    '  全部停止： [CTRL:Char:STOPALL]',
    '',
    'position:',
    '  紧跟本轮最关键的「{{char}} 用设备 / 对 {{user}} 做对应动作」描写之后，插入一组 CTRL；整条回复只插入这一处。不必向 {{user}} 解说语法。',
    '',
    'channel_hint:',
    '  叙事动作选「可用功能」里语义最近的一项；没有对应项不要硬编名，也不要空输出 CTRL。',
  ].join('\n');
}

function collectLabels(profile) {
  const funcs = profile?.functions || {};
  const labels = [];
  for (const [key, fn] of Object.entries(funcs)) {
    const label = String(fn?.label || fn?.note || key).trim();
    if (label) labels.push(label);
  }
  return labels;
}

export function worldbookCommentFor(displayName, profileId) {
  const name = String(displayName || '').trim() || '设备档案';
  return `SDC · ${name} · ${profileId}`;
}

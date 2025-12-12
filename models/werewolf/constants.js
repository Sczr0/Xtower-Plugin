// --- 插件名称和功能开关 ---
export const PLUGIN_NAME = '狼人杀';
export const SELF_DESTRUCT_ENABLED = true; // 硬编码的自爆功能开关

// --- 游戏常量定义 ---
export const ROLES = {
  WEREWOLF: 'WEREWOLF',
  VILLAGER: 'VILLAGER',
  SEER: 'SEER',
  WITCH: 'WITCH',
  HUNTER: 'HUNTER',
  GUARD: 'GUARD',
  WOLF_KING: 'WOLF_KING',
  WHITE_WOLF_KING: 'WHITE_WOLF_KING',
  IDIOT: 'IDIOT',
};

// --- 游戏板子预设 ---
export const GAME_PRESETS = {
  'default': {
    name: '默认板子 (6-12人)',
    playerCount: { min: 3, max: 12 },
    roles: null,
    ruleset: '屠城' // 默认规则是屠城
  },
  '屠边局': {
    name: '经典屠边局 (9人)',
    playerCount: { min: 9, max: 9 },
    roles: {
      [ROLES.WEREWOLF]: 3,
      [ROLES.SEER]: 1,
      [ROLES.WITCH]: 1,
      [ROLES.HUNTER]: 1,
      [ROLES.VILLAGER]: 3
    },
    ruleset: '屠边'
  },
  '预女猎白': {
    name: '预女猎白 (12人)',
    playerCount: { min: 12, max: 12 },
    roles: {
      [ROLES.WEREWOLF]: 4,
      [ROLES.SEER]: 1,
      [ROLES.WITCH]: 1,
      [ROLES.HUNTER]: 1,
      [ROLES.IDIOT]: 1,
      [ROLES.VILLAGER]: 4
    },
    ruleset: '屠边' //这个板子通常是屠边规则
  }
};
export const AUTO_MUTE_ENABLED = true; // 自动禁言功能开关

export const TAGS = {
  GUARDED: 'GUARDED',                 // 被守护
  DYING: 'DYING',                     // 濒死状态 (被狼人刀或女巫毒)
  SAVED_BY_WITCH: 'SAVED_BY_WITCH',   // 被女巫解药救
  POISONED_BY_WITCH: 'POISONED_BY_WITCH', // 被女巫毒药毒
  REVEALED_IDIOT: 'REVEALED_IDIOT',   // 已翻牌的白痴
  WOLF_KING_CLAW_PENDING: 'WOLF_KING_CLAW_PENDING', // 狼王等待发动技能
};

// --- 数据存储与管理常量 ---
export const GAME_KEY_PREFIX = 'werewolf:game:'
export const USER_GROUP_KEY_PREFIX = 'werewolf:user_to_group:'
export const DEADLINE_KEY = 'werewolf:deadlines'
export const GAME_DATA_EXPIRATION = 6 * 60 * 60 // 6小时后自动过期

// model/werewolf/constants.js

export const PLUGIN_NAME = '狼人杀';

// 游戏状态常量
export const GAME_STATUS = {
  WAITING: 'waiting',     // 等待玩家加入
  RUNNING: 'running',     // 游戏进行中
  ENDED: 'ended',         // 游戏已结束
};

// 游戏阶段常量
export const GAME_PHASE = {
  NIGHT_START: 'night_start',     // 夜晚开始（分配行动）
  DAY_ANNOUNCEMENT: 'day_announcement', // 白天公布死亡
  SHERIFF_ELECTION: 'sheriff_election', // 警长竞选
  SHERIFF_VOTE: 'sheriff_vote',   // 警上投票
  DAY_SPEAK: 'day_speak',         // 白天发言
  DAY_VOTE: 'day_vote',           // 白天投票
  VOTE_RESULT: 'vote_result',     // 投票结果公布
  HUNTER_SHOOT: 'hunter_shoot',   // 猎人开枪
  LAST_WORDS: 'last_words',       // 遗言阶段
  PK_VOTE: 'pk_vote',             // PK投票阶段
  WOLF_KING_CLAW: 'wolf_king_claw', // 狼王爪发动阶段
  IDIOT_FLIP: 'idiot_flip',         // 白痴翻牌阶段
};

// 角色ID常量
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

// 阵营常量
export const TEAMS = {
  GOOD: 'good',
  WOLF: 'wolf',
};

// 狼人阵营身份集合
export const WOLF_TEAM_ROLES = [ROLES.WEREWOLF, ROLES.WOLF_KING, ROLES.WHITE_WOLF_KING];

// 标签常量
export const TAGS = {
  // 临时状态标签 (每晚清除)
  GUARDED: 'GUARDED',                 // 被守护
  DYING_FROM_WOLF: 'DYING_FROM_WOLF', // 被狼刀
  SAVED_BY_WITCH: 'SAVED_BY_WITCH',   // 被女巫解药救
  POISONED_BY_WITCH: 'POISONED_BY_WITCH', // 被女巫毒药毒
  WOLF_KING_SELF_STAB: 'WOLF_KING_SELF_STAB', // 狼王自刀
  
  // 持久状态标签
  REVEALED_IDIOT: 'REVEALED_IDIOT',   // 已翻牌的白痴
  CANDIDATE: 'CANDIDATE',             // 警长候选人
  IDIOT_FLIPPED: 'IDIOT_FLIPPED',     // 白痴已翻牌（新增）
};

// 数据存储常量
export const REDIS_KEYS = {
  ROOM_PREFIX: 'werewolf:room:',
  USER_GROUP_PREFIX: 'werewolf:user_to_group:',
  DEADLINE_ZSET: 'werewolf:deadlines',
};

export const DATA_EXPIRATION = 6 * 60 * 60; // 6小时

export const GAME_PRESETS = {
    '预女猎守': {
      name: '预女猎守 (9人)',
      playerCount: 9,
      roles: {
        [ROLES.WEREWOLF]: 3,
        [ROLES.SEER]: 1,
        [ROLES.WITCH]: 1,
        [ROLES.HUNTER]: 1,
        [ROLES.VILLAGER]: 3
      }
    },
    '预女猎白': {
      name: '预女猎白 (12人)',
      playerCount: 12,
      roles: {
        [ROLES.WEREWOLF]: 4,
        [ROLES.SEER]: 1,
        [ROLES.WITCH]: 1,
        [ROLES.HUNTER]: 1,
        [ROLES.IDIOT]: 1,
        [ROLES.VILLAGER]: 4
      }
    },
  };
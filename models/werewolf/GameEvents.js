/**
 * @module GameEvents
 * @description 游戏事件定义
 * 包含游戏中使用的所有事件名称常量
 */

// 游戏生命周期事件
export const GAME_EVENTS = {
  // 游戏创建和管理
  GAME_CREATED: 'game-created',
  GAME_STARTED: 'game-started',
  GAME_ENDED: 'game-ended',
  GAME_DESTROYED: 'game-destroyed',
  
  // 玩家相关事件
  PLAYER_JOINED: 'player-joined',
  PLAYER_LEFT: 'player-left',
  PLAYER_DIED: 'player-died',
  PLAYER_REVIVED: 'player-revived',
  
  // 阶段转换事件
  PHASE_CHANGED: 'phase-changed',
  NIGHT_STARTED: 'night-started',
  NIGHT_ENDED: 'night-ended',
  DAY_STARTED: 'day-started',
  DAY_ENDED: 'day-ended',
  
  // 夜晚行动事件
  NIGHT_ACTION_RECEIVED: 'night-action-received',
  NIGHT_ACTION_PROCESSED: 'night-action-processed',
  NIGHT_ACTIONS_RESOLVED: 'night-actions-resolved',
  
  // 发言和投票事件
  SPEECH_STARTED: 'speech-started',
  SPEECH_ENDED: 'speech-ended',
  VOTE_STARTED: 'vote-started',
  VOTE_RECEIVED: 'vote-received',
  VOTE_ENDED: 'vote-ended',
  
  // 警长相关事件
  SHERIFF_ELECTION_STARTED: 'sheriff-election-started',
  SHERIFF_CANDIDATE_ADDED: 'sheriff-candidate-added',
  SHERIFF_CANDIDATE_WITHDRAWN: 'sheriff-candidate-withdrawn',
  SHERIFF_ELECTED: 'sheriff-elected',
  SHERIFF_DIED: 'sheriff-died',
  SHERIFF_BADGE_PASSED: 'sheriff-badge-passed',
  
  // 特殊技能事件
  HUNTER_SHOOT_STARTED: 'hunter-shoot-started',
  HUNTER_SHOT: 'hunter-shot',
  WOLF_KING_CLAW_STARTED: 'wolf-king-claw-started',
  WOLF_KING_CLAWED: 'wolf-king-clawed',
  WHITE_WOLF_KING_EXPLODED: 'white-wolf-king-exploded',
  
  // 角色技能事件
  SEER_CHECK_RESULT: 'seer-check-result',
  WITCH_POTION_USED: 'witch-potion-used',
  GUARD_PROTECTED: 'guard-protected',
  
  // 计时器事件
  TIMER_STARTED: 'timer-started',
  TIMER_WARNING: 'timer-warning',
  TIMER_EXPIRED: 'timer-expired',
  
  // 胜负判定事件
  VICTORY_CHECK: 'victory-check',
  GAME_WON: 'game-won'
};

// 外部交互事件（用于与Yunzai-Bot通信）
export const INTERACTION_EVENTS = {
  // 消息发送
  SEND_GROUP_MESSAGE: 'send-group-message',
  SEND_PRIVATE_MESSAGE: 'send-private-message',
  SEND_SYSTEM_MESSAGE: 'send-system-message',
  
  // 群管理
  MUTE_PLAYER: 'mute-player',
  UNMUTE_PLAYER: 'unmute-player',
  MUTE_ALL_PLAYERS: 'mute-all-players',
  UNMUTE_ALL_PLAYERS: 'unmute-all-players',
  
  // 数据持久化
  SAVE_GAME_DATA: 'save-game-data',
  LOAD_GAME_DATA: 'load-game-data',
  DELETE_GAME_DATA: 'delete-game-data',
  
  // 错误处理
  ERROR_OCCURRED: 'error-occurred',
  WARNING_ISSUED: 'warning-issued'
};

// 角色特定事件
export const ROLE_EVENTS = {
  // 狼人
  WEREWOLF_KILL_TARGET: 'werewolf-kill-target',
  WEREWOLF_CHAT_MESSAGE: 'werewolf-chat-message',
  
  // 预言家
  SEER_CHECK_PLAYER: 'seer-check-player',
  
  // 女巫
  WITCH_USE_SAVE_POTION: 'witch-use-save-potion',
  WITCH_USE_POISON_POTION: 'witch-use-poison-potion',
  
  // 守卫
  GUARD_PROTECT_PLAYER: 'guard-protect-player',
  
  // 猎人
  HUNTER_SHOOT_PLAYER: 'hunter-shoot-player',
  
  // 狼王
  WOLF_KING_CLAW_PLAYER: 'wolf-king-claw-player',
  
  // 白狼王
  WHITE_WOLF_KING_EXPLODE: 'white-wolf-king-explode'
};

// 游戏状态常量
export const GAME_STATES = {
  WAITING: 'waiting',
  STARTING: 'starting',
  NIGHT_PHASE: 'night-phase',
  DAY_SPEECH: 'day-speech',
  DAY_VOTE: 'day-vote',
  SHERIFF_ELECTION: 'sheriff-election',
  SHERIFF_SPEECH: 'sheriff-speech',
  SHERIFF_VOTE: 'sheriff-vote',
  SHERIFF_RUNOFF_VOTE: 'sheriff-runoff-vote', // 警长二次投票
  LAST_WORDS: 'last-words',
  HUNTER_SHOOT: 'hunter-shoot',
  WOLF_KING_CLAW: 'wolf-king-claw',
  ENDED: 'ended'
};

// 角色常量
export const ROLES = {
  WEREWOLF: 'WEREWOLF',
  VILLAGER: 'VILLAGER',
  SEER: 'SEER',
  WITCH: 'WITCH',
  HUNTER: 'HUNTER',
  GUARD: 'GUARD',
  WOLF_KING: 'WOLF_KING',
  WHITE_WOLF_KING: 'WHITE_WOLF_KING',
  IDIOT: 'IDIOT'
};

// 胜利条件
export const VICTORY_CONDITIONS = {
  WEREWOLF_WIN: 'werewolf-win',
  VILLAGER_WIN: 'villager-win',
  DRAW: 'draw'
};
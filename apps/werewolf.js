// --- 插件名称和功能开关 ---
const PLUGIN_NAME = '狼人杀';
const SELF_DESTRUCT_ENABLED = true; // 硬编码的自爆功能开关

// --- 游戏常量定义 ---
const ROLES = {
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
const GAME_PRESETS = {
  'default': {
    name: '默认板子 (6-12人)',
    playerCount: { min: 3, max: 12 },
    roles: null,
    hasSheriff: false,
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
    hasSheriff: false,
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
    hasSheriff: true,
    ruleset: '屠边' //这个板子通常是屠边规则
  }
};
const AUTO_MUTE_ENABLED = true; // 自动禁言功能开关

const TAGS = {
  GUARDED: 'GUARDED',                 // 被守护
  DYING: 'DYING',                     // 濒死状态 (被狼人刀或女巫毒)
  SAVED_BY_WITCH: 'SAVED_BY_WITCH',   // 被女巫解药救
  POISONED_BY_WITCH: 'POISONED_BY_WITCH', // 被女巫毒药毒
  REVEALED_IDIOT: 'REVEALED_IDIOT',   // 已翻牌的白痴
  WOLF_KING_CLAW_PENDING: 'WOLF_KING_CLAW_PENDING', // 狼王等待发动技能
};

// --- 数据存储与管理常量 ---
const GAME_KEY_PREFIX = 'werewolf:game:'
const USER_GROUP_KEY_PREFIX = 'werewolf:user_to_group:'
const DEADLINE_KEY = 'werewolf:deadlines'
const GAME_DATA_EXPIRATION = 6 * 60 * 60 // 6小时后自动过期

/**
 * @class GameDataManager
 * @description 负责狼人杀游戏数据在 Redis 中的存取。
 * 职责：加载、保存、更新特定字段、删除游戏数据，并生成临时玩家ID。
 */
class GameDataManager {
  /**
   * 获取指定群组ID对应的Redis键名。
   * @param {string} groupId - 群组ID。
   * @returns {string} Redis键名。
   */
  static getRedisKey(groupId) {
    return `${GAME_KEY_PREFIX}${groupId}`
  }

  /**
   * 从Redis加载指定群组的游戏数据。
   * @param {string} groupId - 群组ID。
   * @returns {Promise<object|null>} 游戏数据对象或null。
   */
  static async load(groupId) {
    const key = this.getRedisKey(groupId)
    try {
      const hashData = await redis.hGetAll(key)
      if (!hashData || Object.keys(hashData).length === 0) return null

      // 从Hash的各个字段重组游戏数据
      const gameData = {
        players: JSON.parse(hashData.players || '[]'),
        roles: JSON.parse(hashData.roles || '{}'),
        gameState: JSON.parse(hashData.gameState || '{}'),
        potions: JSON.parse(hashData.potions || '{}'),
        userGroupMap: JSON.parse(hashData.userGroupMap || '{}'),
      }
      return gameData
    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 从 Redis 读取或解析游戏数据失败 (${groupId}):`, err)
      await redis.del(key) // 出现解析错误时，删除可能损坏的数据
      return null
    }
  }

  /**
   * 全量保存游戏数据到Redis。
   * @param {string} groupId - 群组ID。
   * @param {object} data - 完整的游戏数据对象。
   * @returns {Promise<void>}
   */
  static async saveAll(groupId, data) {
    const key = this.getRedisKey(groupId)
    try {
      const multi = redis.multi(); // 获取一个事务对象

      multi.hSet(key, 'players', JSON.stringify(data.players || []));
      multi.hSet(key, 'roles', JSON.stringify(data.roles || {}));
      multi.hSet(key, 'gameState', JSON.stringify(data.gameState || {}));
      multi.hSet(key, 'potions', JSON.stringify(data.potions || {}));
      multi.hSet(key, 'userGroupMap', JSON.stringify(data.userGroupMap || {}));
      multi.expire(key, GAME_DATA_EXPIRATION); // 设置过期时间

      await multi.exec(); // 执行所有排队的命令

    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 全量保存游戏数据到 Redis 失败 (${groupId}):`, err)
    }
  }

  /**
   * 更新Redis中游戏数据的单个字段。
   * @param {string} groupId - 群组ID。
   * @param {string} fieldName - 要更新的字段名。
   * @param {any} data - 字段的新数据。
   * @returns {Promise<void>}
   */
  static async saveField(groupId, fieldName, data) {
    const key = this.getRedisKey(groupId)
    try {
      await redis.hSet(key, fieldName, JSON.stringify(data))
      await redis.expire(key, GAME_DATA_EXPIRATION) // 每次更新也刷新过期时间
    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 更新游戏字段 [${fieldName}] 到 Redis 失败 (${groupId}):`, err)
    }
  }

  /**
   * 从Redis删除指定群组的游戏数据。
   * @param {string} groupId - 群组ID。
   * @returns {Promise<void>}
   */
  static async delete(groupId) {
    const key = this.getRedisKey(groupId)
    try {
      await redis.del(key)
    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 从 Redis 删除游戏数据失败 (${groupId}):`, err)
    }
  }

  /**
   * 为新玩家生成一个不重复的两位数字临时ID。
   * @param {Array<object>} players - 当前游戏中的玩家列表。
   * @returns {string} 生成的临时ID (例如 '01', '02')。
   */
  static generateTempId(players) {
    // 获取所有已存在的编号，并转换为数字
    const existingIds = players
      .map(p => p.tempId ? parseInt(p.tempId, 10) : 0)
      .filter(id => !isNaN(id) && id > 0);

    // 如果没有玩家，从1号开始
    if (existingIds.length === 0) {
      return '01';
    }

    // 排序，方便查找
    existingIds.sort((a, b) => a - b);

    let nextId = 1;
    // 遍历已存在的编号，找到第一个空缺位
    for (const id of existingIds) {
      if (id === nextId) {
        nextId++;
      } else {
        // 找到了空缺，比如现有 [1, 3, 4]，当 nextId=2 时，id=3，不相等，所以空缺就是 2
        break;
      }
    }

    // 返回找到的空缺编号，或者如果没有空缺就返回最大编号+1
    return String(nextId).padStart(2, '0');
  }
}

/**
 * @class GameCleaner
 * @description 负责管理游戏超时自动清理机制。
 * 职责：注册、清理单个游戏或所有游戏的超时计时器。
 */
class GameCleaner {
  static cleanupTimers = new Map() // 存储每个群组的清理计时器
  static CLEANUP_DELAY = 2 * 60 * 60 * 1000 // 2小时无活动后检查是否强制结束游戏

  /**
   * 为一个游戏注册自动清理计时器。
   * 如果游戏在指定时间内无活动，将尝试强制结束。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfPlugin} instance - WerewolfPlugin的实例，用于调用forceEndGame。
   */
  static registerGame(groupId, instance) {
    this.cleanupGame(groupId) // 注册前先清理旧的计时器
    const timer = setTimeout(async () => {
      console.log(`[${PLUGIN_NAME}] [自动清理] 开始检查超时游戏 (${groupId})...`)
      const gameData = await GameDataManager.load(groupId)
      // 只有游戏正在运行才强制结束
      if (gameData && gameData.gameState && gameData.gameState.isRunning) {
        console.log(`[${PLUGIN_NAME}] [自动清理] 强制结束2小时无活动的游戏 (${groupId})...`)
        // 构造一个模拟的event对象，以便forceEndGame可以正常运行
        const fakeEvent = {
          group_id: groupId,
          user_id: gameData.hostUserId, // 使用房主ID作为操作者
          reply: (msg) => instance.sendSystemGroupMsg(groupId, `[自动清理] ${msg}`),
          sender: { card: '系统', nickname: '系统' },
          isMaster: true, // 赋予系统最高权限
          member: { is_admin: true } // 模拟群管理员权限
        }
        await instance.forceEndGame(fakeEvent, true) // 调用强制结束，并标记为自动清理
      }
      this.cleanupTimers.delete(groupId) // 计时器执行完毕后删除
    }, this.CLEANUP_DELAY)
    this.cleanupTimers.set(groupId, timer)
  }

  /**
   * 清理指定群组的自动清理计时器。
   * @param {string} groupId - 群组ID。
   */
  static cleanupGame(groupId) {
    const timer = this.cleanupTimers.get(groupId)
    if (timer) {
      clearTimeout(timer)
      this.cleanupTimers.delete(groupId)
    }
  }

  /**
   * 清理所有注册的自动清理计时器。
   */
  static cleanupAll() {
    for (const [, timer] of this.cleanupTimers) clearTimeout(timer)
    this.cleanupTimers.clear()
  }
}

/**
 * @class WerewolfGame
 * @description 狼人杀游戏的核心逻辑类。
 * 职责：管理游戏状态、玩家、角色分配、游戏流程（夜晚、白天、投票等）和角色专属行为。
 */
class WerewolfGame {
  /**
   * 构造函数，初始化游戏状态和玩家数据。
   * @param {object} initialData - 初始游戏数据，用于从Redis加载时重建游戏。
   */
  constructor(initialData = {}) {
    this.players = initialData.players || []
    // 默认角色名称映射
    this.roles = initialData.roles || { [ROLES.WEREWOLF]: '狼人', [ROLES.VILLAGER]: '村民', [ROLES.SEER]: '预言家', [ROLES.WITCH]: '女巫', [ROLES.HUNTER]: '猎人', [ROLES.GUARD]: '守卫', [ROLES.WOLF_KING]: '狼王', [ROLES.WHITE_WOLF_KING]: '白狼王', [ROLES.IDIOT]: '白痴' }
    // 游戏状态机
    this.gameState = initialData.gameState || {
      isRunning: false,        // 游戏是否正在进行
      currentPhase: null,      // 当前阶段 (例如 `night_phase_1`, 'day_speak', 'day_vote')
      currentDay: 0,           // 当前天数
      status: 'waiting',       // 游戏状态 (waiting, starting, night_phase_1, night_phase_2, day_speak, day_vote, hunter_shooting, wolf_king_clawing, ended)
      hostUserId: null,        // 房主ID
      nightActions: {},        // 夜晚行动记录 (按角色分类)
      pendingNightActions: [],
      lastProtectedId: null,   // 守卫上晚守护的目标ID，用于防止连守
      hunterNeedsToShoot: null,// 死亡猎人ID，等待开枪
      wolfKingNeedsToClaw: null, // 死亡狼王ID，等待发动技能
      currentSpeakerUserId: null, // 当前发言玩家ID
      sheriffUserId: null,         // 警长玩家的ID
      isSheriffElection: false,    // 是否正在进行警长竞选的总开关
      candidateList: [],         // 警长候选人列表 (存放userId)
      sheriffVotes: {},          // 警长投票的专门记录
      speakingOrder: [],       // 白天发言顺序
      currentSpeakerOrderIndex: -1, // 当前发言玩家在顺序中的索引
      votes: {},               // 投票记录
      eventLog: [],            // 游戏事件日志
      deadline: null,          // 当前阶段的截止时间戳
      hasPermission: false,    // 机器人是否有禁言/解禁权限
      presetName: 'default', // 用于记录板子名称
    }
    this.potions = initialData.potions || { save: true, kill: true } // 女巫药剂状态
    this.userGroupMap = initialData.userGroupMap || {} // 用户ID到群组ID的映射
    this.addPlayerPromise = Promise.resolve() // 用于串行化玩家加入操作
  }

  /**
   * 内部角色行为映射表，集中管理角色的专属技能逻辑。
   * 当需要执行某个角色的技能时，通过 `this._roleActions[player.role].someSkill()` 来调用。
   * 这样可以降低添加新角色时的修改范围，提高可维护性。
   */
  _roleActions = {
    [ROLES.WEREWOLF]: {
      /**
       * 记录狼人袭击意图。实际结算在 `processNightActions` 中进行。
       * @param {WerewolfGame} game - 游戏实例。
       * @param {object} player - 狼人玩家对象。
       * @param {string} targetPlayerId - 目标玩家的临时ID。
       * @returns {object} 操作结果。
       */
      performNightKill: (game, player, targetPlayerId) => {
        const targetPlayer = game.players.find(p => p.tempId === targetPlayerId && p.isAlive);
        if (!targetPlayer) return { success: false, message: '目标玩家无效或已死亡。' };
        return { success: true, message: `已记录狼人对 ${targetPlayer.nickname}(${targetPlayer.tempId}号) 的袭击意图。` };
      },
      /**
       * 发送狼人频道消息给所有狼队友。
       * @param {WerewolfGame} game - 游戏实例。
       * @param {object} sender - 发送消息的狼人玩家对象。
       * @param {Array<object>} teammates - 其他狼队友列表。
       * @param {string} chatContent - 聊天内容。
       * @param {Function} sendDirectMessageFunc - 用于发送私聊消息的函数。
       * @returns {object} 操作结果。
       */
      sendWerewolfChat: async (game, sender, teammates, chatContent, sendDirectMessageFunc) => {
        const formattedMessage = `[狼人频道] ${sender.nickname}(${sender.tempId}号): ${chatContent}`;
        for (const teammate of teammates) {
          await sendDirectMessageFunc(teammate.userId, formattedMessage, sender.groupId);
          await new Promise(resolve => setTimeout(resolve, 200)); // 添加延迟，避免消息发送过快
        }
        return { success: true, message: '消息已成功发送至狼人频道。' };
      }
    },
    [ROLES.SEER]: {
      /**
       * 查验玩家身份。
       * @param {WerewolfGame} game - 游戏实例。
       * @param {object} player - 预言家玩家对象。
       * @param {string} targetPlayerId - 目标玩家的临时ID。
       * @returns {object} 操作结果和查验反馈。
       */
      checkPlayer: (game, player, targetPlayerId) => {
        const targetPlayer = game.players.find(p => p.tempId === targetPlayerId && p.isAlive);
        if (!targetPlayer) return { success: false, message: '目标玩家无效或已死亡。' };
        const isWerewolf = [ROLES.WEREWOLF, ROLES.WOLF_KING, ROLES.WHITE_WOLF_KING].includes(targetPlayer.role);
        const feedbackMsg = `[查验结果] ${targetPlayer.nickname}(${targetPlayer.tempId}号) 的身份是 【${isWerewolf ? '狼人' : '好人'}】。`;
        // 记录事件
        game.gameState.eventLog.push({
          day: game.gameState.currentDay,
          phase: 'night',
          type: 'SEER_CHECK',
          actor: game.getPlayerInfo(player.userId),
          target: game.getPlayerInfo(targetPlayer.userId),
          result: isWerewolf ? ROLES.WEREWOLF : 'GOOD_PERSON'
        });
        return { success: true, message: feedbackMsg };
      }
    },
    [ROLES.WITCH]: {
      /**
       * 女巫使用解药或毒药。实际结算在 `processNightActions` 中进行。
       * @param {WerewolfGame} game - 游戏实例。
       * @param {object} witchPlayer - 女巫玩家对象。
       * @param {string} actionType - 行动类型 ('save' 或 'kill')。
       * @param {string} targetPlayerId - 目标玩家的临时ID。
       * @returns {object} 操作结果。
       */
      performAction: (game, witchPlayer, actionType, targetPlayerId) => {
        if (actionType === 'save' && !game.potions.save) return { success: false, message: '你的解药已经用完了。' };
        if (actionType === 'kill' && !game.potions.kill) return { success: false, message: '你的毒药已经用完了。' };
        // 检查女巫是否已行动过，防止重复行动记录
        if (game.gameState.nightActions[ROLES.WITCH]?.[witchPlayer.userId]) return { success: false, message: '你今晚已经行动过了。' };

        const targetPlayer = game.players.find(p => p.tempId === targetPlayerId && p.isAlive);
        if (!targetPlayer) return { success: false, message: '目标玩家无效或已死亡。' };

        return { success: true, message: `[狼人杀] 已收到您的行动指令，请等待夜晚结束。` };
      }
    },
    [ROLES.GUARD]: {
      /**
       * 守卫守护玩家。实际结算在 `processNightActions` 中进行。
       * @param {WerewolfGame} game - 游戏实例。
       * @param {object} guardPlayer - 守卫玩家对象。
       * @param {string} targetPlayerId - 目标玩家的临时ID。
       * @returns {object} 操作结果。
       */
      performProtection: (game, guardPlayer, targetPlayerId) => {
        const targetPlayer = game.players.find(p => p.tempId === targetPlayerId && p.isAlive);
        if (!targetPlayer) return { success: false, message: '目标玩家无效或已死亡。' };
        if (targetPlayer.userId === game.gameState.lastProtectedId) return { success: false, message: '不能连续两晚守护同一个人。' };
        return { success: true, message: `[狼人杀] 已收到您的行动指令，请等待夜晚结束。` };
      }
    },
    [ROLES.HUNTER]: {
      /**
       * 猎人开枪带人。
       * @param {WerewolfGame} game - 游戏实例。
       * @param {object} hunterPlayer - 猎人玩家对象。
       * @param {string} targetPlayerId - 目标玩家的临时ID。
       * @returns {object} 操作结果和消息。
       */
      shoot: (game, hunterPlayer, targetPlayerId) => {
        const targetPlayer = game.players.find(p => p.tempId === targetPlayerId && p.isAlive);
        if (!targetPlayer) return { success: false, message: "目标无效或已死亡。" };
        if (targetPlayer.userId === hunterPlayer.userId) return { success: false, message: "你不能对自己开枪。" };
        return { success: true, message: `猎人 ${game.getPlayerInfo(hunterPlayer.userId)} 开枪带走了 ${game.getPlayerInfo(targetPlayer.userId)}！` };
      }
    },
    [ROLES.WOLF_KING]: {
      /**
       * 狼王发动技能带人。
       * @param {WerewolfGame} game - 游戏实例。
       * @param {object} wolfKingPlayer - 狼王玩家对象。
       * @param {string} targetPlayerId - 目标玩家的临时ID。
       * @returns {object} 操作结果和消息。
       */
      claw: (game, wolfKingPlayer, targetPlayerId) => {
        const targetPlayer = game.players.find(p => p.tempId === targetPlayerId && p.isAlive);
        if (!targetPlayer) return { success: false, message: "目标无效或已死亡。" };
        if (targetPlayer.userId === wolfKingPlayer.userId) return { success: false, message: "你不能对自己使用技能。" };
        return { success: true, message: `狼王 ${game.getPlayerInfo(wolfKingPlayer.userId)} 发动技能，带走了 ${game.getPlayerInfo(targetPlayer.userId)}！` };
      }
    },
    [ROLES.WHITE_WOLF_KING]: {
      /**
       * 白狼王自爆并带人。
       * @param {WerewolfGame} game - 游戏实例。
       * @param {object} whiteWolfKingPlayer - 白狼王玩家对象。
       * @param {string} targetPlayerId - 目标玩家的临时ID (自爆时可能为null)。
       * @returns {object} 操作结果和消息。
       */
      selfDestructClaw: (game, whiteWolfKingPlayer, targetPlayerId) => {
        // 白狼王自爆时，targetPlayerId可能为null，因为带人是后续操作
        if (targetPlayerId) { // 如果指定了目标，则进行目标验证
          const targetPlayer = game.players.find(p => p.tempId === targetPlayerId && p.isAlive);
          if (!targetPlayer) return { success: false, message: "目标无效或已死亡。" };
          if (targetPlayer.userId === whiteWolfKingPlayer.userId) return { success: false, message: "你不能对自己使用技能。" };
          return { success: true, message: `白狼王 ${game.getPlayerInfo(whiteWolfKingPlayer.userId)} 自爆并带走了 ${game.getPlayerInfo(targetPlayer.userId)}！` };
        }
        return { success: true, message: `白狼王 ${game.getPlayerInfo(whiteWolfKingPlayer.userId)} 选择自爆！` };
      }
    }
  };

  /**
   * 初始化一个新的狼人杀游戏。
   * @param {string} hostUserId - 房主的用户ID。
   * @param {string} hostNickname - 房主的昵称。
   * @param {string} groupId - 游戏所在的群组ID。
   * @param {string} presetName - 板子名称。
   * @returns {Promise<object>} 初始化结果。
   */
  async initGame(hostUserId, hostNickname, groupId, presetName = 'default') {
    this.gameState = {
      isRunning: false, currentPhase: null, currentDay: 0, status: 'waiting',
      hostUserId: hostUserId, nightActions: {}, lastProtectedId: null, hunterNeedsToShoot: null,
      hasSheriff: false,
      wolfKingNeedsToClaw: null,
      currentSpeakerUserId: null, speakingOrder: [], currentSpeakerOrderIndex: -1, votes: {},
      eventLog: [],
      deadline: null,
      hasPermission: false,
      lastStableStatus: null,
      presetName: presetName || 'default',
    };
    this.gameState.pendingNightActions = []; // 用于存储本晚待处理的行动
    this.players = [];
    this.potions = { save: true, kill: true };
    this.userGroupMap = {};

    await this.addPlayer(hostUserId, hostNickname, groupId);

    const preset = GAME_PRESETS[this.gameState.presetName] || GAME_PRESETS['default'];
    return { success: true, message: `游戏创建成功！当前为【${preset.name}】板子，等待玩家加入...\n房主可以 #开始狼人杀` };
  }

  /**
   * 添加玩家到游戏中。
   * @param {string} userId - 玩家的用户ID。
   * @param {string} nickname - 玩家的昵称。
   * @param {string} groupId - 游戏所在的群组ID。
   * @returns {Promise<object>} 加入结果。
   */
  async addPlayer(userId, nickname, groupId) {
    // 使用Promise链来确保玩家加入操作的串行执行
    const executionPromise = this.addPlayerPromise.then(async () => {
      if (this.players.some(p => p.userId === userId)) {
        return { success: false, message: '你已经加入游戏了。' }
      }
      if (!['waiting', 'starting'].includes(this.gameState.status)) {
        return { success: false, message: '游戏已经开始或结束，无法加入。' }
      }
      const player = {
        userId,
        nickname,
        role: null,
        isAlive: true,
        tempId: GameDataManager.generateTempId(this.players),
        tags: [] // 使用数组记录状态标签，便于JSON序列化
      }
      this.players.push(player)
      this.userGroupMap[userId] = groupId
      // 在Redis中记录用户ID到群组ID的映射，并设置过期时间
      await redis.set(`${USER_GROUP_KEY_PREFIX}${userId}`, groupId, { EX: GAME_DATA_EXPIRATION })
      return { success: true, message: `${nickname} (${player.tempId}号) 加入了游戏。当前人数: ${this.players.length}` }
    })

    // 无论成功或失败，都将 promise 链向下传递，以确保下一个调用可以排队
    // 使用 .catch(() => {}) 来处理可能的拒绝，防止 UnhandledPromiseRejectionWarning
    this.addPlayerPromise = executionPromise.catch(() => { })

    return executionPromise
  }

  /**
   * 从游戏中移除玩家。
   * @param {string} userId - 要移除的玩家的用户ID。
   * @returns {Promise<object>} 移除结果。
   */
  async removePlayer(userId) {
    const playerIndex = this.players.findIndex(p => p.userId === userId);
    if (playerIndex === -1) {
      return { success: false, message: '你不在游戏中。' };
    }
    if (!['waiting', 'starting'].includes(this.gameState.status)) {
      return { success: false, message: '游戏已经开始，无法退出。请联系房主结束游戏。' };
    }
    const removedPlayer = this.players.splice(playerIndex, 1)[0];
    // 如果房主退出，则解散游戏
    if (removedPlayer.userId === this.gameState.hostUserId) {
      this.gameState.status = 'ended';
      return { success: true, message: `房主 ${removedPlayer.nickname} 退出了游戏，游戏已解散。`, gameDissolved: true };
    }
    delete this.userGroupMap[userId];
    await redis.del(`${USER_GROUP_KEY_PREFIX}${removedPlayer.userId}`); // 从Redis中删除用户群组映射
    return { success: true, message: `${removedPlayer.nickname} 退出了游戏。当前人数: ${this.players.length}` };
  }

  /**
   * 根据玩家人数计算角色分配。
   * @returns {object} 角色分配对象。
   */
  calculateRoleDistribution() {
    const playerCount = this.players.length;
    // 预设的角色分配配置
    const distributionConfig = {
      3: { werewolf: 1, god: 1, villager: 1 },
      4: { werewolf: 1, god: 1, villager: 2 },
      5: { werewolf: 1, god: 1, villager: 3 },
      6: { werewolf: 2, god: 2, villager: 2 },
      7: { werewolf: 2, god: 2, villager: 3 },
      8: { werewolf: 3, god: 3, villager: 2 },
      9: { werewolf: 3, god: 3, villager: 3 },
      10: { werewolf: 3, god: 3, villager: 4 },
      11: { werewolf: 4, god: 4, villager: 3 },
      12: { werewolf: 4, god: 4, villager: 4 },
      13: { werewolf: 4, god: 4, villager: 5 },
      14: { werewolf: 5, god: 5, villager: 4 },
      15: { werewolf: 5, god: 5, villager: 5 },
      18: { werewolf: 6, god: 6, villager: 6 },
    };

    const config = distributionConfig[playerCount];
    if (!config) {
      throw new Error(`[${PLUGIN_NAME}] 玩家人数 ${playerCount} 不在支持的配置范围内。`);
    }

    let distribution = {
      [ROLES.WEREWOLF]: config.werewolf,
      [ROLES.VILLAGER]: config.villager,
    };

    // 确保预言家被分配
    if (config.god > 0) {
      distribution[ROLES.SEER] = 1;
    }

    const remainingGodCount = config.god - 1;
    let otherGodRoles = [];
    if (playerCount === 6) {
      // 6人局的另一个神是守卫
      otherGodRoles = [ROLES.GUARD];
    } else {
      // 其他人数局的神职（除预言家外）
      otherGodRoles = [ROLES.WITCH, ROLES.HUNTER, ROLES.GUARD, ROLES.IDIOT];
    }

    // 分配剩下的神职
    const otherGodsToAssignCount = Math.min(remainingGodCount, otherGodRoles.length);
    for (let i = 0; i < otherGodsToAssignCount; i++) {
      distribution[otherGodRoles[i]] = 1;
    }

    const actualGodsDistributed = Object.keys(distribution).filter(role =>
      [ROLES.SEER, ROLES.WITCH, ROLES.HUNTER, ROLES.GUARD, ROLES.IDIOT].includes(role) && distribution[role] === 1
    ).length;

    if (config.god > actualGodsDistributed) {
      distribution[ROLES.VILLAGER] += (config.god - actualGodsDistributed);
    }

    this.gameState.roleDistribution = distribution;
    return distribution;
  }

  /**
   * 从预设板子分配角色。
   * @param {object} preset - 预设板子对象。
   * @returns {object} 角色分配对象。
   */
  assignRolesFromPreset(preset) {
    const distribution = {};
    for (const role in preset.roles) {
      distribution[role] = preset.roles[role];
    }
    this.gameState.roleDistribution = distribution;
    return distribution;
  }


  /**
   * 将计算好的角色分配给玩家。
   * @param {object} distribution - 角色分配对象。
   * @returns {object} 分配结果。
   */
  assignRoles(distribution) {
    const playerCount = this.players.length;
    let allRoles = [];
    for (const role in distribution) {
      for (let i = 0; i < distribution[role]; i++) allRoles.push(role)
    }

    if (allRoles.length !== playerCount) {
      return { success: false, message: `角色分配错误：总角色数 ${allRoles.length} 不等于玩家数 ${playerCount}。` };
    }

    allRoles.sort(() => Math.random() - 0.5) // 随机打乱角色顺序
    this.players.forEach((player, index) => { player.role = allRoles[index] })
    return { success: true }
  }

  /**
   * 准备游戏开始前的检查。
   * @returns {Promise<object>} 准备结果。
   */
  async prepareGameStart() {
    const validPlayerCounts = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 18];
    if (!validPlayerCounts.includes(this.players.length)) {
      return { success: false, message: `当前玩家人数 ${this.players.length} 不支持。支持的人数配置为: ${validPlayerCounts.join(', ')}。` };
    }
    if (this.gameState.status !== 'waiting') return { success: false, message: '游戏状态不正确。' }
    this.gameState.status = 'starting' // 标记为正在开始
    return { success: true }
  }

  /**
   * 记录玩家在夜晚的行动。
   * @param {string} role - 玩家的角色。
   * @param {string} userId - 玩家的用户ID。
   * @param {object} action - 玩家的行动详情 (例如 { type: 'kill', targetTempId: '01' })。
   * @returns {object} 行动记录结果。
   */

  recordNightAction(role, userId, action) {
    if (!this.gameState.status.startsWith('night_phase')) return { success: false, message: '当前不是夜晚行动时间。' };
    const player = this.players.find(p => p.userId === userId && p.isAlive);
    if (!player || player.role !== role) return { success: false, message: '无效操作：你的身份或状态不符。' };

    const roleActionHandler = this._roleActions[role];
    if (!roleActionHandler) return { success: false, message: '该角色没有对应的夜晚行动。' };

    let result;
    // 根据角色调用其在 _roleActions 中定义的具体行动方法进行验证或即时反馈
    switch (role) {
      case ROLES.WEREWOLF:
        result = roleActionHandler.performNightKill(this, player, action.targetTempId);
        break;
      case ROLES.SEER:
        result = roleActionHandler.checkPlayer(this, player, action.targetTempId);
        break;
      case ROLES.WITCH:
        // 防止女巫重复行动
        if (this.gameState.pendingNightActions.some(a => a.userId === userId)) {
          return { success: false, message: '你今晚已经行动过了。' };
        }
        result = roleActionHandler.performAction(this, player, action.type, action.targetTempId);
        break;
      case ROLES.GUARD:
        result = roleActionHandler.performProtection(this, player, action.targetTempId);
        break;
      default:
        return { success: false, message: '该角色没有可记录的夜晚行动。' };
    }

    if (result.success) {
      // 移除之前的行动记录，确保每个玩家每晚只有一个最终行动被记录
      const existingActionIndex = this.gameState.pendingNightActions.findIndex(a => a.userId === userId);
      if (existingActionIndex > -1) {
        this.gameState.pendingNightActions.splice(existingActionIndex, 1);
      }

      // 验证成功后，将最终行动意图存储到 pendingNightActions
      this.gameState.pendingNightActions.push({ role, userId, action });
      console.log(`[${PLUGIN_NAME}] [DEBUG] Action recorded. Current pendingNightActions:`, JSON.stringify(this.gameState.pendingNightActions));
      // --- FIX END ---
    }
    return result;
  }

  /**
   * 结算夜晚所有角色的行动。
   * @returns {object} 结算结果，包括死亡摘要和游戏是否结束。
   */
  processNightActions() {
    if (this.gameState.status !== 'night_phase_2') {
      return { message: '非夜晚，无法结算' };
    }

    const currentDay = this.gameState.currentDay;
    const logEvent = (event) => this.gameState.eventLog.push({ day: currentDay, phase: 'night', ...event });

    // 1. 初始化: 清理上一晚的临时标签
    this.players.forEach(p => {
      p.tags = p.tags.filter(tag => tag === TAGS.REVEALED_IDIOT);
    });

    // 将本晚所有待处理的行动从 pendingNightActions 转移到 nightActions
    this.gameState.nightActions = {};
    this.gameState.pendingNightActions.forEach(({ role, userId, action }) => {
      if (!this.gameState.nightActions[role]) this.gameState.nightActions[role] = {};
      this.gameState.nightActions[role][userId] = action;
    });
    this.gameState.pendingNightActions = [];

    // --- 阶段一：守卫行动 ---
    const guardAction = Object.values(this.gameState.nightActions[ROLES.GUARD] || {})[0];
    if (guardAction) {
      const guard = this.players.find(p => p.role === ROLES.GUARD && p.isAlive);
      const target = this.players.find(p => p.tempId === guardAction.targetTempId && p.isAlive);
      if (guard && target && target.userId !== this.gameState.lastProtectedId) {
        target.tags.push(TAGS.GUARDED);
        this.gameState.lastProtectedId = target.userId;
        logEvent({ type: 'GUARD_PROTECT', actor: this.getPlayerInfo(guard.userId), target: this.getPlayerInfo(target.userId) });
        console.log(`[${PLUGIN_NAME}] [DEBUG] Guard protected: ${this.getPlayerInfo(target.userId)}`);
      } else {
        this.gameState.lastProtectedId = null;
      }
    } else {
      this.gameState.lastProtectedId = null;
    }

    // --- 阶段二：狼人袭击 ---
    const killedByWerewolfId = this.getWerewolfAttackTargetId();
    console.log(`[${PLUGIN_NAME}] [DEBUG] processNightActions - killedByWerewolfId: ${killedByWerewolfId}`);

    if (killedByWerewolfId) {
      // 确保数据类型一致，都转换为字符串进行比较
      const target = this.players.find(p => String(p.userId) === String(killedByWerewolfId));
      console.log(`[${PLUGIN_NAME}] [DEBUG] processNightActions - Found target:`, target ? `${target.nickname}(${target.tempId})` : 'null');

      if (target) {
        console.log(`[${PLUGIN_NAME}] [DEBUG] processNightActions - Target tags before DYING:`, target.tags);
        target.tags.push(TAGS.DYING);
        console.log(`[${PLUGIN_NAME}] [DEBUG] processNightActions - Target tags after DYING:`, target.tags);

        const werewolfActors = this.players.filter(p => [ROLES.WEREWOLF, ROLES.WOLF_KING, ROLES.WHITE_WOLF_KING].includes(p.role) && p.isAlive).map(p => this.getPlayerInfo(p.userId));
        logEvent({ type: 'WEREWOLF_ATTACK', actors: werewolfActors, target: this.getPlayerInfo(target.userId) });
      } else {
        console.log(`[${PLUGIN_NAME}] [DEBUG] processNightActions - Target not found for userId: ${killedByWerewolfId} (type: ${typeof killedByWerewolfId})`);
      }
    }

    // --- 阶段三：女巫行动 ---
    const witchAction = Object.values(this.gameState.nightActions[ROLES.WITCH] || {})[0];
    if (witchAction) {
      const witch = this.players.find(p => p.role === ROLES.WITCH && p.isAlive);
      if (witch) {
        const target = this.players.find(p => p.tempId === witchAction.targetTempId && p.isAlive);
        if (target) {
          if (witchAction.type === 'save' && this.potions.save) {
            target.tags.push(TAGS.SAVED_BY_WITCH);
            this.potions.save = false;
            logEvent({ type: 'WITCH_SAVE', actor: this.getPlayerInfo(witch.userId), target: this.getPlayerInfo(target.userId) });
            console.log(`[${PLUGIN_NAME}] [DEBUG] Witch saved: ${this.getPlayerInfo(target.userId)}`);
          }
          if (witchAction.type === 'kill' && this.potions.kill) {
            target.tags.push(TAGS.DYING, TAGS.POISONED_BY_WITCH);
            this.potions.kill = false;
            logEvent({ type: 'WITCH_KILL', actor: this.getPlayerInfo(witch.userId), target: this.getPlayerInfo(target.userId) });
            console.log(`[${PLUGIN_NAME}] [DEBUG] Witch poisoned: ${this.getPlayerInfo(target.userId)}`);
          }
        }
      }
    }

    // --- 阶段四：确定最终死亡玩家 ---
    let actualDeaths = [];
    let deathCauses = {};

    console.log(`[${PLUGIN_NAME}] [DEBUG] Night Action Processing - Checking for deaths...`);
    this.players.filter(p => p.isAlive).forEach(player => {

      if (!player.tags.includes(TAGS.DYING)) {
        return;
      }

      let shouldDie = true;
      let causeOfDeath = 'UNKNOWN';

      const isGuarded = player.tags.includes(TAGS.GUARDED);
      const isSavedByWitch = player.tags.includes(TAGS.SAVED_BY_WITCH);
      const isPoisoned = player.tags.includes(TAGS.POISONED_BY_WITCH);

      if (isPoisoned) {
        causeOfDeath = 'WITCH';
        shouldDie = true;
      } else {
        if (isGuarded && isSavedByWitch) {
          causeOfDeath = 'GUARD_WITCH_CONFLICT';
          shouldDie = true;
        } else if (isGuarded || isSavedByWitch) {
          shouldDie = false;
          causeOfDeath = isGuarded ? 'GUARDED' : 'SAVED_BY_WITCH';
        } else {
          causeOfDeath = 'WEREWOLF';
          shouldDie = true;
        }
      }

      if (shouldDie) {
        deathCauses[player.userId] = causeOfDeath;
        actualDeaths.push(player);
      } else {
      }
    });

    // --- 阶段五：天亮，结算后续状态 ---
    let finalSummary = ["夜晚结束，现在公布昨晚发生的事情："];
    if (actualDeaths.length > 0) {
      const deathNames = actualDeaths.map(p => `${p.nickname} (${p.tempId}号)`).join('、');
      finalSummary.push(`${deathNames} 昨晚死亡了。`);
    } else {
      finalSummary.push("昨晚是个平安夜。");
    }

    this.gameState.nightActions = {};

    const deadHunter = actualDeaths.find(p => p.role === ROLES.HUNTER);
    if (deadHunter && deathCauses[deadHunter.userId] !== 'WITCH') {
      this.gameState.status = 'hunter_shooting';
      this.gameState.hunterNeedsToShoot = deadHunter.userId;
      this.gameState.currentPhase = 'NIGHT_RESULT';
      actualDeaths.forEach(p => { p.isAlive = false; });
      return { success: true, summary: finalSummary.join('\n'), gameEnded: false, needsHunterShoot: true, deadPlayers: actualDeaths };
    }

    const deadWolfKing = actualDeaths.find(p => p.role === ROLES.WOLF_KING);
    if (deadWolfKing) {
      this.gameState.status = 'wolf_king_clawing';
      this.gameState.wolfKingNeedsToClaw = deadWolfKing.userId;
      this.gameState.currentPhase = 'NIGHT_RESULT';
      actualDeaths.forEach(p => { p.isAlive = false; });
      return { success: true, summary: finalSummary.join('\n'), gameEnded: false, needsWolfKingClaw: true, deadPlayers: actualDeaths };
    }

    actualDeaths.forEach(p => { p.isAlive = false; });

    const gameStatus = this.checkGameStatus();
    if (gameStatus.isEnd) {
      return {
        success: true,
        summary: finalSummary.join('\n'),
        gameEnded: true,
        winner: gameStatus.winner,
        finalRoles: this.getFinalRoles(),
        needsHunterShoot: false,
        deadPlayers: actualDeaths
      };
    } else {
      this.gameState.status = 'day_speak';
      return {
        success: true,
        summary: finalSummary.join('\n'),
        gameEnded: false,
        needsHunterShoot: false,
        deadPlayers: actualDeaths
      };
    }
  }

  /**
   * 添加一名玩家到警长候选人列表。
   * @param {string} userId - 玩家的用户ID。
   * @returns {object} 包含 success(布尔值) 和 message(字符串) 的结果对象。
   */
  addSheriffCandidate(userId) {
    const player = this.players.find(p => p.userId === userId);
    // 检查玩家是否存在且存活
    if (!player || !player.isAlive) {
      return { success: false, message: '你已出局或不在游戏中，无法上警。' };
    }

    // 检查是否已经上过警了
    if (this.gameState.candidateList.includes(userId)) {
      return { success: false, message: '你已经上警了，请勿重复操作。' };
    }

    // 将玩家ID添加到候选人列表
    this.gameState.candidateList.push(userId);

    return {
      success: true,
      message: '你已成功加入警长竞选！',
      player: this.getPlayerInfo(userId) // 顺便返回玩家信息，方便外部使用
    };
  }

  /**
   * 从警长竞选中退水。
   * @param {string} userId - 想要退水的玩家ID。
   * @returns {object} 包含 success 和 message 的结果对象。
   */
  withdrawFromSheriffElection(userId) {
    // 检查玩家是否是候选人
    const candidateIndex = this.gameState.candidateList.indexOf(userId);
    if (candidateIndex === -1) {
      return { success: false, message: '你不在警长候选人名单中，无法退水。' };
    }

    // 从候选人名单中移除
    this.gameState.candidateList.splice(candidateIndex, 1);

    // 如果当前正在发言的是退水者，我们需要把发言权移交给下一个人
    // （这部分逻辑可以做得更复杂，为了简化我们暂时不处理，超时会自动跳过）

    return {
      success: true,
      message: '你已成功退水。',
      remainingCandidates: this.gameState.candidateList.length
    };
  }

  /**
   * 记录玩家的投票。
   * @param {string} voterUserId - 投票者的用户ID。
   * @param {string} targetTempId - 投票目标的临时ID ('00'表示弃票)。
   * @returns {object} 投票结果。
   */
  recordVote(voterUserId, targetTempId) {
    if (this.gameState.status !== 'day_vote') return { success: false, message: '当前不是投票时间。' }
    const voter = this.players.find(p => p.userId === voterUserId && p.isAlive)
    if (!voter) return { success: false, message: '你无法投票。' }

    // 添加调试日志
    console.log(`[${PLUGIN_NAME}] [DEBUG] Vote attempt by ${voter.nickname}(${voter.tempId}), tags:`, voter.tags);

    if (voter.tags.includes(TAGS.REVEALED_IDIOT)) {
      console.log(`[${PLUGIN_NAME}] [DEBUG] Vote blocked: ${voter.nickname} is revealed idiot`);
      return { success: false, message: '白痴翻牌后无法投票。' };
    }
    if (voter.tags.includes(TAGS.REVEALED_IDIOT)) return { success: false, message: '白痴翻牌后无法投票。' }; // 白痴翻牌后失去投票权
    if (this.gameState.votes[voterUserId]) return { success: false, message: '你已经投过票了。' }
    if (targetTempId === '00' || targetTempId === '0') { // 弃票
      this.gameState.votes[voter.userId] = '弃票'
      return { success: true, message: `${voter.nickname} (${voter.tempId}号) 选择了弃票。` }
    }
    const targetPlayer = this.players.find(p => p.tempId === targetTempId && p.isAlive)
    if (!targetPlayer) return { success: false, message: '投票目标无效或已死亡。' }
    if (voter.userId === targetPlayer.userId) {
      return { success: false, message: '你不能投票给自己。' };
    }
    this.gameState.votes[voter.userId] = targetTempId
    return { success: true, message: `${voter.nickname} (${voter.tempId}号) 投票给了 ${targetPlayer.nickname} (${targetPlayer.tempId}号)。` }
  }

  /**
   * 移动到下一个发言者，并更新内部状态。
   * @returns {string|null} 下一个发言者的ID，如果没有则返回null。
   */
  moveToNextSpeaker() {
    // 先将索引+1，移动到下一个位置
    this.gameState.currentSpeakerOrderIndex++;
    const currentIndex = this.gameState.currentSpeakerOrderIndex;
    const speakingOrder = this.gameState.speakingOrder;

    // 再判断新的索引是否超出了范围
    if (currentIndex >= speakingOrder.length) {
      this.gameState.currentSpeakerUserId = null; // 清理当前发言人
      return null; // 明确地告诉外面：没有下一个了
    }

    // 如果没超出范围，就获取并设置新的发言人
    const nextSpeakerId = speakingOrder[currentIndex];
    this.gameState.currentSpeakerUserId = nextSpeakerId;
    return nextSpeakerId;
  }

  /**
   * 结算警长投票。
   * @returns {object} 包含计票摘要和结果的对象。
   */
  processSheriffVotes() {
    const votes = this.gameState.sheriffVotes;
    const voteCounts = {}; // { targetId: count }

    // 初始化所有候选人的票数为0
    this.gameState.candidateList.forEach(id => {
      voteCounts[id] = 0;
    });

    // 计票
    for (const voterId in votes) {
      const targetId = votes[voterId];
      if (voteCounts.hasOwnProperty(targetId)) {
        voteCounts[targetId]++;
      }
    }

    // 生成计票摘要
    let summaryLines = ["--- 警长投票结果 ---"];
    for (const targetId in voteCounts) {
      const targetInfo = this.getPlayerInfo(targetId);
      const voters = Object.keys(votes).filter(voterId => votes[voterId] === targetId);
      const voterInfos = voters.map(vId => this.getPlayerInfo(vId).nickname).join('、') || '无人';
      summaryLines.push(`${targetInfo.nickname}(${targetInfo.tempId}号): ${voteCounts[targetId]}票 (来自: ${voterInfos})`);
    }
    const summary = summaryLines.join('\n');

    // 找出最高票数和候选人
    let maxVotes = 0;
    let topCandidates = [];
    for (const targetId in voteCounts) {
      if (voteCounts[targetId] > maxVotes) {
        maxVotes = voteCounts[targetId];
        topCandidates = [targetId];
      } else if (voteCounts[targetId] === maxVotes && maxVotes > 0) {
        topCandidates.push(targetId);
      }
    }

    // 判断结果
    if (maxVotes === 0 || topCandidates.length === 0) {
      return { summary, sheriffElected: false, isTie: false }; // 无人投票
    }
    if (topCandidates.length === 1) {
      this.gameState.sheriffUserId = topCandidates[0];
      return { summary, sheriffElected: true, isTie: false, sheriffId: topCandidates[0] }; // 唯一警长
    }

    // 平票，更新候选人列表为平票者，为PK做准备
    this.gameState.candidateList = topCandidates;
    return { summary, sheriffElected: false, isTie: true }; // 平票
  }

  /**
   * 结算白天投票结果。
   * @returns {object} 结算结果，包括投票摘要、游戏是否结束以及被票出局的玩家(playerKicked)。
   */
  processVotes() {
    if (this.gameState.status !== 'day_vote') return { message: '非投票阶段，无法计票' };

    const currentDay = this.gameState.currentDay;
    const logEvent = (event) => this.gameState.eventLog.push({ day: currentDay, phase: 'day', ...event });

    // --- 计票逻辑---
    const voteCounts = {} // 记录每个玩家获得的票数
    const voteDetails = {} // 记录每个玩家被谁投票
    this.players.filter(p => p.isAlive && !p.tags.includes(TAGS.REVEALED_IDIOT)).forEach(voter => { // 确保白痴不参与计票
      const targetTempId = this.gameState.votes[voter.userId];

      // 判断投票权重，警长为1.5票，其他人为1票
      const voteWeight = (voter.userId === this.gameState.sheriffUserId) ? 1.5 : 1;

      if (targetTempId && targetTempId !== '弃票') { // 如果投票给某个人
        voteCounts[targetTempId] = (voteCounts[targetTempId] || 0) + voteWeight;
        if (!voteDetails[targetTempId]) voteDetails[targetTempId] = [];
        voteDetails[targetTempId].push(`${voter.nickname}(${voter.tempId}号)`);
      } else { // 如果是弃票
        // 注意：弃票不计入权重，始终算1票
        voteCounts['弃票'] = (voteCounts['弃票'] || 0) + 1;
        if (!voteDetails['弃票']) voteDetails['弃票'] = [];
        voteDetails['弃票'].push(`${voter.nickname}(${voter.tempId}号)`);
      }
    });

    let voteSummary = ["投票结果："];
    for (const targetTempId in voteCounts) {
      if (targetTempId === '弃票') continue;
      const targetPlayer = this.players.find(p => p.tempId === targetTempId);
      if (targetPlayer) voteSummary.push(`${targetPlayer.nickname}(${targetTempId}号): ${voteCounts[targetTempId]}票 (${(voteDetails[targetTempId] || []).join(', ')})`);
    }
    if (voteCounts['弃票']) voteSummary.push(`弃票: ${voteCounts['弃票']}票 (${(voteDetails['弃票'] || []).join(', ')})`);

    let maxVotes = 0;
    let tiedPlayers = [];
    for (const targetTempId in voteCounts) {
      if (targetTempId === '弃票') continue;
      if (voteCounts[targetTempId] > maxVotes) {
        maxVotes = voteCounts[targetTempId];
        tiedPlayers = [targetTempId];
      } else if (voteCounts[targetTempId] === maxVotes && maxVotes > 0) {
        tiedPlayers.push(targetTempId);
      }
    }

    // --- 处理出局玩家的逻辑 ---

    this.gameState.votes = {}; // 清空旧的投票记录

    let playerKickedToday = null; // 定义一个变量，用来存放今天被票出去的玩家

    if (tiedPlayers.length === 1) { // 有唯一最高票玩家
      const eliminatedPlayer = this.players.find(p => p.tempId === tiedPlayers[0]);
      if (eliminatedPlayer) {
        const voters = voteDetails[eliminatedPlayer.tempId] || [];
        logEvent({ type: 'VOTE_OUT', target: this.getPlayerInfo(eliminatedPlayer.userId), voters: voters });

        if (eliminatedPlayer.role === ROLES.IDIOT) { // 如果是白痴
          eliminatedPlayer.tags.push(TAGS.REVEALED_IDIOT);
          voteSummary.push(`${eliminatedPlayer.nickname}(${eliminatedPlayer.tempId}号) 被投票出局，但他/她亮出了【白痴】的身份！他/她不会死亡，但将失去后续的投票权。`);
          // 白痴没死，所以 playerKickedToday 保持为 null
          return {
            success: true, summary: voteSummary.join('\n'), gameEnded: false,
            idiotRevealed: true, revealedIdiotId: eliminatedPlayer.userId, playerKicked: null
          };
        } else { // 如果是其他角色
          eliminatedPlayer.isAlive = false;
          playerKickedToday = eliminatedPlayer; // 记录下这个被票出局的玩家
          voteSummary.push(`${eliminatedPlayer.nickname} (${eliminatedPlayer.tempId}号) 被投票出局。`);

          // 如果是猎人，直接返回，并带上死者信息
          if (eliminatedPlayer.role === ROLES.HUNTER) {
            this.gameState.status = 'hunter_shooting';
            this.gameState.hunterNeedsToShoot = eliminatedPlayer.userId;
            this.gameState.currentPhase = 'DAY';
            return { success: true, summary: voteSummary.join('\n'), gameEnded: false, needsHunterShoot: true, playerKicked: playerKickedToday };
          }
          // 如果是狼王，直接返回，并带上死者信息
          if (eliminatedPlayer.role === ROLES.WOLF_KING) {
            this.gameState.status = 'wolf_king_clawing';
            this.gameState.wolfKingNeedsToClaw = eliminatedPlayer.userId;
            this.gameState.currentPhase = 'DAY';
            return { success: true, summary: voteSummary.join('\n'), gameEnded: false, needsWolfKingClaw: true, playerKicked: playerKickedToday };
          }
        }
      }
    } else if (tiedPlayers.length > 1) { // 平票
      const sortedTiedPlayers = [...tiedPlayers].sort();
      voteSummary.push(`出现平票 (${sortedTiedPlayers.map(id => `${id}号`).join(', ')})，本轮无人出局。`);
    } else { // 无人被投票或全部弃票
      voteSummary.push("所有人都弃票或投票无效，本轮无人出局。");
    }

    const gameStatus = this.checkGameStatus();
    if (gameStatus.isEnd) {
      this.endGame(gameStatus.winner);
      return {
        success: true, summary: voteSummary.join('\n'), gameEnded: true,
        winner: gameStatus.winner, finalRoles: this.getFinalRoles(), playerKicked: playerKickedToday
      };
    } else {
      this.gameState.status = 'night_phase_1';
      return {
        success: true, summary: voteSummary.join('\n'), gameEnded: false, playerKicked: playerKickedToday
      };
    }
  }

  /**
   * 获取狼人袭击的最终目标ID。
   * @returns {string|null} 被袭击玩家的用户ID，如果没有则返回null。
   */
  getWerewolfAttackTargetId() {
    const werewolfActions = this.gameState.nightActions['WEREWOLF'] || {};

    const killTargets = {}; // 统计每个目标获得的刀数
    const actionValues = Object.values(werewolfActions);

    if (actionValues.length === 0) {
      console.log(`[${PLUGIN_NAME}] [DEBUG] getWerewolfAttackTargetId - No werewolf actions recorded.`);
      return null; // 明确返回 null
    }

    actionValues.forEach(action => {
      // 防御性检查，确保 action 和 targetTempId 存在
      if (!action || !action.targetTempId) {
        console.warn(`[${PLUGIN_NAME}] [DEBUG] getWerewolfAttackTargetId - Found an invalid action object:`, action);
        return;
      }
      const target = this.players.find(p => p.tempId === action.targetTempId && p.isAlive);
      if (target) {
        killTargets[target.userId] = (killTargets[target.userId] || 0) + 1;
      } else {
        console.log(`[${PLUGIN_NAME}] [DEBUG] getWerewolfAttackTargetId - Target ${action.targetTempId} not found or not alive.`);
      }
    });

    console.log(`[${PLUGIN_NAME}] [DEBUG] getWerewolfAttackTargetId - Vote counts:`, JSON.stringify(killTargets));

    let maxVotes = 0;
    let topCandidates = []; // 获得最高票数的候选人
    for (const userId in killTargets) {
      if (killTargets[userId] > maxVotes) {
        maxVotes = killTargets[userId];
        topCandidates = [userId];
      } else if (killTargets[userId] === maxVotes && maxVotes > 0) {
        topCandidates.push(userId);
      }
    }

    if (topCandidates.length === 0) {
      console.log(`[${PLUGIN_NAME}] [DEBUG] getWerewolfAttackTargetId - No valid targets were voted on. Result is null.`);
      return null; // 无人被刀
    }
    if (topCandidates.length === 1) {
      console.log(`[${PLUGIN_NAME}] [DEBUG] getWerewolfAttackTargetId - Unique target found: ${topCandidates[0]}`);
      return topCandidates[0]; // 唯一目标
    }

    // 平票情况，随机选择一个
    const randomIndex = Math.floor(Math.random() * topCandidates.length);
    const finalTarget = topCandidates[randomIndex];
    console.log(`[${PLUGIN_NAME}] [DEBUG] getWerewolfAttackTargetId - Tied vote, randomly selected: ${finalTarget}`);
    return finalTarget;
  }

  /**
   * 检查游戏是否达到结束条件 (支持屠城和屠边规则)。
   * @returns {object} 包含 `isEnd` (布尔值) 和 `winner` (胜利阵营名称) 的对象。
   */
  checkGameStatus() {
    // --- 第一步：定义好人和狼人阵营的角色 ---
    const goodGuyRoles = [ROLES.VILLAGER, ROLES.SEER, ROLES.WITCH, ROLES.HUNTER, ROLES.GUARD, ROLES.IDIOT];
    const godRoles = [ROLES.SEER, ROLES.WITCH, ROLES.HUNTER, ROLES.GUARD, ROLES.IDIOT];
    const villagerRoles = [ROLES.VILLAGER];
    const wolfRoles = [ROLES.WEREWOLF, ROLES.WOLF_KING, ROLES.WHITE_WOLF_KING];

    // --- 第二步：统计各类角色的存活数量 ---
    const alivePlayers = this.players.filter(p => p.isAlive);
    const aliveWerewolves = alivePlayers.filter(p => wolfRoles.includes(p.role)).length;
    const aliveGods = alivePlayers.filter(p => godRoles.includes(p.role)).length;
    const aliveVillagers = alivePlayers.filter(p => villagerRoles.includes(p.role)).length;
    const aliveGoodGuys = alivePlayers.filter(p => goodGuyRoles.includes(p.role)).length;

    // --- 第三步：根据规则进行胜负判断 ---

    // 规则一：好人胜利条件 (所有规则通用)
    // 场上没有存活的狼人了。
    if (aliveWerewolves === 0) {
      return { isEnd: true, winner: '好人' };
    }

    // 规则二：狼人胜利条件 (需要区分游戏模式)

    if (this.ruleset === '屠边') {
      // 场上已经没有神民了，或者场上已经没有普通村民了。
      if (aliveGods === 0 || aliveVillagers === 0) {
        return { isEnd: true, winner: '狼人' };
      }
    } else { // 默认使用屠城规则
      // 存活的狼人数量大于或等于存活的好人数量。
      if (aliveGoodGuys === 0) {
        return { isEnd: true, winner: '狼人' };
      }
    }

    // 如果以上条件都不满足，则游戏继续
    return { isEnd: false };
  }

  /**
   * 结束游戏，更新游戏状态。
   * @param {string} winner - 获胜阵营的名称。
   */
  endGame() {
    this.gameState.isRunning = false
    this.gameState.status = 'ended'
  }

  /**
   * 获取所有玩家的最终身份列表。
   * @returns {string} 格式化后的身份列表字符串。
   */
  getFinalRoles() {
    return this.players.map(p => `${p.nickname}(${p.tempId}号): ${this.roles[p.role] || '未知'}`).join('\n')
  }

  /**
   * 根据用户ID或临时ID获取玩家的昵称和临时ID信息。
   * @param {string} userIdOrTempId - 玩家的用户ID或临时ID。
   * @returns {string} 格式化后的玩家信息字符串，如果未找到则返回'未知玩家'。
   */
  getPlayerInfo(userIdOrTempId) {
    const player = this.players.find(p => p.userId === userIdOrTempId || p.tempId === userIdOrTempId)
    return player ? `${player.nickname}(${player.tempId}号)` : '未知玩家'
  }

  /**
   * 获取当前存活玩家的列表。
   * @returns {string} 格式化后的存活玩家列表字符串。
   */
  getAlivePlayerList() {
    return this.players.filter(p => p.isAlive).map(p => `${p.tempId}号: ${p.nickname}`).join('\n')
  }

  /**
   * 获取当前游戏的所有数据。
   * @returns {object} 包含玩家、角色、游戏状态、药剂和用户群组映射的数据对象。
   */
  getGameData() {
    return { players: this.players, roles: this.roles, gameState: this.gameState, potions: this.potions, userGroupMap: this.userGroupMap }
  }
}

/**
 * @class WerewolfPlugin
 * @description Yunzai机器人插件的入口类，负责命令注册、用户交互、消息发送和计时器管理。
 * 职责：处理用户指令，协调游戏核心逻辑（WerewolfGame）和数据管理（GameDataManager），并进行消息反馈。
 */
export class WerewolfPlugin extends plugin {
  /**
   * 构造函数，注册插件命令和初始化内部状态。
   */
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: '狼人杀游戏插件',
      event: 'message',
      priority: 50,
      rule: [
        { reg: '^#创建狼人杀$', fnc: 'createGame' },
        { reg: '^#加入狼人杀$', fnc: 'joinGame' },
        { reg: '^#退出狼人杀$', fnc: 'leaveGame' },
        { reg: '^#开始狼人杀$', fnc: 'startGame' },
        { reg: '^#(强制)?结束狼人杀$', fnc: 'forceEndGame' },
        { reg: '^#狼人杀状态$', fnc: 'showGameStatus' },
        { reg: '^#?(杀|刀)\\s*(\\d+)$', fnc: 'handleNightAction', permission: 'private' },
        { reg: '^#(狼聊|w)\\s*(.+)$', fnc: 'handleWerewolfChat', permission: 'private' },
        { reg: '^#?查验\\s*(\\d+)$', fnc: 'handleNightAction', permission: 'private' },
        { reg: '^#?救\\s*(\\d+)$', fnc: 'handleNightAction', permission: 'private' },
        { reg: '^#?毒\\s*(\\d+)$', fnc: 'handleNightAction', permission: 'private' },
        { reg: '^#?守\\s*(\\d+)$', fnc: 'handleNightAction', permission: 'private' },
        { reg: '^#上警$', fnc: 'handleSheriffSignup' },
        { reg: '^#退水$', fnc: 'handleSheriffWithdraw' },
        { reg: '^#投警长\\s*(\\d+)$', fnc: 'handleSheriffVote' },
        { reg: '^#移交警徽\\s*(\\d+)$', fnc: 'handleSheriffPassBadge', permission: 'private' },
        { reg: '^#?(结束发言|过)$', fnc: 'handleEndSpeech' },
        { reg: '^#投票\\s*(\\d+|弃票)$', fnc: 'handleVote' },
        { reg: '^#开枪\\s*(\\d+)$', fnc: 'handleHunterShoot', permission: 'private' },
        { reg: '^#自爆(?:\\s*(.*))?$', fnc: 'handleSelfDestruct' },
        { reg: '^#狼爪\\s*(\\d+)$', fnc: 'handleWolfKingClaw', permission: 'private' }
      ]
    });

    // 设置定时器，定期检查所有游戏的截止时间
    setInterval(() => this.checkAllGameTimers(), 5000);

    this.gameInstances = new Map();    // 内存中的游戏实例缓存
    this.userToGroupCache = new Map(); // 用户ID到群组ID的映射缓存
    this.phaseTimers = new Map();      // 存储每个群组的阶段计时器
    // 游戏阶段持续时间常量
    this.WEREWOLF_PHASE_DURATION = 60 * 1000; // 狼人行动阶段时长
    this.WITCH_ACTION_DURATION = 30 * 1000;   // 女巫单独行动阶段时长
    this.SHERIFF_SIGNUP_DURATION = 60 * 1000;   // 警长竞选报名时长
    this.SHERIFF_SPEECH_DURATION = 60 * 1000;   // 警长竞选发言时长
    this.SHERIFF_VOTE_DURATION = 45 * 1000;     // 警长竞选投票时长
    this.SPEECH_DURATION = 60 * 1000;         // 白天发言时长
    this.VOTE_DURATION = 60 * 1000;           // 投票阶段时长
    this.HUNTER_SHOOT_DURATION = 30 * 1000;   // 猎人开枪时长
    this.WOLF_KING_CLAW_DURATION = 30 * 1000; // 狼王发动技能时长
  }

  /**
   * 清除指定群组的阶段计时器。
   * @param {string} groupId - 群组ID。
   */
  clearPhaseTimer(groupId) {
    if (this.phaseTimers.has(groupId)) {
      clearTimeout(this.phaseTimers.get(groupId));
      this.phaseTimers.delete(groupId);
      console.log(`[${PLUGIN_NAME}] Cleared phase timer for group ${groupId}.`);
    }
  }

  /**
   * 获取指定群组的游戏实例。如果不存在且 `createIfNotExist` 为true，则创建新实例。
   * @param {string} groupId - 群组ID。
   * @param {boolean} [createIfNotExist=false] - 如果游戏不存在是否创建。
   * @param {string} [hostUserId=null] - 房主用户ID (创建时需要)。
   * @param {string} [hostNickname=null] - 房主昵称 (创建时需要)。
   * @returns {Promise<WerewolfGame|null>} 游戏实例或null。
   */
  async getGameInstance(groupId, createIfNotExist = false, hostUserId = null, hostNickname = null) {
    // Always attempt to load from Redis first to ensure the latest state
    const gameData = await GameDataManager.load(groupId);
    let game = null; // Initialize game to null

    if (gameData) {
      game = new WerewolfGame(gameData); // Reconstruct instance from loaded data
      this.gameInstances.set(groupId, game); // Update memory cache with the fresh instance

      // If game is running, re-register auto-cleanup timer
      if (game.gameState.isRunning) {
        GameCleaner.registerGame(groupId, this);
      }
    } else if (createIfNotExist && hostUserId && hostNickname) {
      // Only create a new game if it wasn't found in Redis and createIfNotExist is true
      game = new WerewolfGame(); // Create new instance
      this.gameInstances.set(groupId, game); // Cache new instance
      GameCleaner.registerGame(groupId, this); // Register new game's auto cleanup
    }
    // If gameData is null and createIfNotExist is false, game remains null.

    return game;
  }

  /**
   * 只更新内存中的游戏实例缓存。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 要缓存的游戏实例。
   */
  updateMemoryCache(groupId, game) {
    if (game) {
      this.gameInstances.set(groupId, game);
    }
  }

  /**
   * 全量保存游戏数据到Redis，并更新内存缓存。
   * 用于游戏创建、阶段转换等需要全量保存的场景。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   * @returns {Promise<void>}
   */
  async saveGameAll(groupId, game) {
    if (game) {
      await GameDataManager.saveAll(groupId, game.getGameData());
      this.updateMemoryCache(groupId, game); // Update memory cache after saving
    }
  }

  /**
   * 保存游戏实例的某个字段到Redis，并更新内存缓存。
   * 用于只更新某个字段的场景，例如只更新gameState。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   * @param {string} fieldName - 要保存的字段名。
   * @returns {Promise<void>}
   */
  async saveGameField(groupId, game, fieldName) {
    if (game) { // Ensure game object exists before accessing its properties
      const dataToSave = game.getGameData()[fieldName] !== undefined ? game.getGameData()[fieldName] : game[fieldName];
      if (dataToSave !== undefined) {
        await GameDataManager.saveField(groupId, fieldName, dataToSave);
        this.updateMemoryCache(groupId, game); // Update memory cache after saving
      } else {
        console.warn(`[${PLUGIN_NAME}] Attempted to save non-existent field "${fieldName}" for group ${groupId}.`);
      }
    }
  }

  /**
   * 删除指定群组的游戏数据（包括Redis和内存缓存）。
   * @param {string} groupId - 群组ID。
   * @returns {Promise<void>}
   */
  async deleteGame(groupId) {
    this.clearPhaseTimer(groupId) // 清除阶段计时器
    GameCleaner.cleanupGame(groupId) // 清除自动清理计时器
    const game = this.gameInstances.get(groupId)
    if (game) {
      const userIds = game.players.map(p => p.userId)
      if (userIds.length > 0) {
        // 从内存缓存中删除玩家到群组的映射
        userIds.forEach(id => this.userToGroupCache.delete(id));
        // 从Redis中删除用户到群组的映射
        const keysToDelete = userIds.map(id => `${USER_GROUP_KEY_PREFIX}${id}`)
        await redis.del(keysToDelete)
      }
    }
    this.gameInstances.delete(groupId) // 从内存中删除游戏实例
    await GameDataManager.delete(groupId) // 从Redis中删除游戏数据
    await redis.zRem(DEADLINE_KEY, String(groupId)) // 从截止时间ZSET中移除
    console.log(`[${PLUGIN_NAME}] 已删除游戏数据 (${groupId})`)
  }

  // --- 命令处理函数 ---

  /**
   * 处理 #创建狼人杀 命令。
   * @param {object} e - 消息事件对象。
   * @returns {Promise<boolean>} 是否成功处理。
   */
  async createGame(e) {
    const groupId = e.group_id;
    if (!groupId) return e.reply("请在群聊中使用此命令。");

    let game = await this.getGameInstance(groupId);
    if (game && game.gameState.status !== 'ended') {
      return e.reply(`本群已有游戏（状态: ${game.gameState.status}）。\n请先 #结束狼人杀。`);
    }

    // 解析板子名称
    const match = e.msg.match(/^#创建狼人杀(?:\s+(.*))?$/);
    const presetName = match && match[1] ? match[1].trim() : 'default';

    game = await this.getGameInstance(groupId, true, e.user_id, e.sender.card || e.sender.nickname);
    const initResult = await game.initGame(e.user_id, e.sender.card || e.sender.nickname, groupId, presetName);

    await this.saveGameAll(groupId, game);
    return e.reply(initResult.message, true);
  }

  /**
   * 处理 #加入狼人杀 命令。
   * @param {object} e - 消息事件对象。
   * @returns {Promise<boolean>} 是否成功处理。
   */
  async joinGame(e) {
    const groupId = e.group_id
    if (!groupId) return e.reply("请在群聊中使用此命令。", true)
    const game = await this.getGameInstance(groupId)
    if (!game || game.gameState.status === 'ended') return e.reply("本群当前没有等待加入的游戏。", true)
    if (!['waiting', 'starting'].includes(game.gameState.status)) return e.reply("游戏已经开始或结束，无法加入。", true)

    // 尝试发送私聊消息，确认机器人可以私聊玩家
    const reachable = await this.sendDirectMessage(
      e.user_id,
      `[${PLUGIN_NAME}] 游戏加入成功！\n我们已确认可以向您发送私聊消息。`,
      groupId,
      false // 不在私聊失败时通知群聊，因为此时玩家可能还未加入
    );

    if (!reachable) {
      return e.reply(
        `[!] 加入失败！无法向您发送私聊消息。\n请先添加机器人为好友，或检查是否已屏蔽机器人。解决后请重新加入。`,
        true,
        { at: true }
      );
    }

    const result = await game.addPlayer(e.user_id, e.sender.card || e.sender.nickname, groupId)
    if (result.success) {
      this.userToGroupCache.set(e.user_id, groupId); // 更新内存缓存
      // 更新 players 和 userGroupMap 字段到Redis
      await this.saveGameField(groupId, game, 'players');
      await this.saveGameField(groupId, game, 'userGroupMap');
    }
    return e.reply(result.message, false, { at: true })
  }

  /**
   * 处理 #退出狼人杀 命令。
   * @param {object} e - 消息事件对象。
   * @returns {Promise<boolean>} 是否成功处理。
   */
  async leaveGame(e) {
    const groupId = e.group_id;
    if (!groupId) return e.reply("请在群聊中使用此命令。", true);
    const game = await this.getGameInstance(groupId);
    if (!game || game.gameState.status === 'ended') return e.reply("本群当前没有游戏。", true);
    if (!['waiting', 'starting'].includes(game.gameState.status)) return e.reply("游戏已经开始，无法退出。", true);

    const result = await game.removePlayer(e.user_id);
    if (result.success) {
      this.userToGroupCache.delete(e.user_id); // 更新内存缓存
      if (result.gameDissolved) { // 如果房主退出导致游戏解散
        await this.deleteGame(groupId);
      } else {
        // 更新 players 和 userGroupMap 字段到Redis
        await this.saveGameField(groupId, game, 'players');
        await this.saveGameField(groupId, game, 'userGroupMap');
      }
    }
    return e.reply(result.message, false, { at: true });
  }

  /**
   * 处理 #开始狼人杀 命令。
   * @param {object} e - 消息事件对象。
   * @returns {Promise<boolean>} 是否成功处理。
   */
  async startGame(e) {
    const groupId = e.group_id
    if (!groupId) return e.reply("请在群聊中使用此命令。", true)
    const game = await this.getGameInstance(groupId)
    if (!game || game.gameState.status === 'ended') return e.reply("本群当前没有游戏。", true)
    if (game.gameState.hostUserId !== e.user_id) return e.reply("只有房主才能开始游戏。", true)
    if (game.gameState.status !== 'waiting') return e.reply(`游戏状态为 ${game.gameState.status}，无法开始。`, true)

    // 1. 准备阶段：检查玩家人数是否符合要求
    const prepareResult = await game.prepareGameStart()
    if (!prepareResult.success) {
      return e.reply(prepareResult.message, true)
    }

    // 2. 权限检查与宣告：机器人是否拥有禁言权限
    if (AUTO_MUTE_ENABLED) {
      game.gameState.hasPermission = e.group.is_admin; // 判断机器人是否为群管理员
      const permissionMsg = game.gameState.hasPermission ?
        '【有权限模式】机器人将自动进行禁言/解禁。' :
        '【无权限模式】机器人权限不足，请玩家自觉遵守发言规则。';
      await e.reply(permissionMsg, true);
    }

    await this.saveGameField(groupId, game, 'gameState') // 保存权限状态
    await e.reply("游戏即将开始，正在生成本局游戏配置...", true)

    // 3. 检查并获取游戏配置
    const playerCount = game.players.length;
    let preset = GAME_PRESETS[game.gameState.presetName] || GAME_PRESETS['default'];

    // 检查人数是否符合板子要求
    if (preset.player_count && preset.player_count !== playerCount) {
      await e.reply(`当前人数(${playerCount}人)不符合预设板子“${preset.name}”(${preset.player_count}人)的要求，将自动切换至默认配置。`);
      preset = GAME_PRESETS['default'];
      game.gameState.presetName = 'default'; // 更新游戏状态中的板子名称
    }

    // 把板子配置中的胜利规则，设置到当前游戏实例上
    game.ruleset = preset.ruleset;

    // 把板子配置中的“是否有警长”，设置到游戏实例上
    game.gameState.hasSheriff = preset.hasSheriff;

    // 根据板子或默认规则计算角色分配
    const distribution = preset.roles ? game.assignRolesFromPreset(preset) : game.calculateRoleDistribution();

    let distributionMessage = `--- 本局配置 (${playerCount}人 | ${preset.name}) ---\n`;
    for (const role in distribution) {
      if (distribution[role] > 0) {
        distributionMessage += `${game.roles[role]}: ${distribution[role]}人\n`;
      }
    }
    await this.sendSystemGroupMsg(groupId, distributionMessage.trim());

    // 4. 分配角色
    const assignResult = game.assignRoles(distribution);
    if (!assignResult.success) {
      game.gameState.status = 'waiting'; // 状态回滚
      await this.saveGameAll(groupId, game);
      return e.reply(assignResult.message, true);
    }

    // 5. 发送身份并开始游戏
    await this.saveGameAll(groupId, game) // 保存已分配的角色
    await this.sendRolesToPlayers(groupId, game) // 私聊发送身份
    game.gameState.isRunning = true
    await this.saveGameAll(groupId, game) // 保存 isRunning 状态
    await this.startNightPhase(groupId, game) // 进入夜晚阶段
  }

  /**
   * 处理夜晚行动命令（杀、查验、救、毒、守）。
   * @param {object} e - 消息事件对象。
   * @returns {Promise<boolean>} 是否成功处理。
   */
  async handleNightAction(e) {
    const userId = e.user_id;
    console.log(`[${PLUGIN_NAME}] [DEBUG] handleNightAction - Entry: user_id=${userId}, message=${e.msg}`);

    const gameInfo = await this.findUserActiveGame(userId);
    if (!gameInfo) {
      return;
    }
    const { instance: game, groupId } = gameInfo;

    if (!game.gameState.isRunning || !game.gameState.status.startsWith('night_phase')) {
      return;
    }

    const player = game.players.find(p => p.userId === userId && p.isAlive);
    if (!player) {
      return;
    }

    console.log(`[${PLUGIN_NAME}] [DEBUG] handleNightAction - Player: ${player.nickname}(${player.tempId}), Role: ${player.role}`);

    const actionMap = {
      '杀': { role: ROLES.WEREWOLF, type: 'kill' },
      '刀': { role: ROLES.WEREWOLF, type: 'kill' },
      '查验': { role: ROLES.SEER, type: 'check' },
      '救': { role: ROLES.WITCH, type: 'save' },
      '毒': { role: ROLES.WITCH, type: 'kill' },
      '守': { role: ROLES.GUARD, type: 'protect' }
    };

    let role = null, type = null, targetTempId = null;
    const match = e.msg.match(/^#?(杀|刀|查验|救|毒|守)\s*(\d+)$/);

    if (match) {
      const command = match[1];
      targetTempId = match[2].padStart(2, '0');
      const mappedAction = actionMap[command];
      if (mappedAction) {
        role = mappedAction.role;
        type = mappedAction.type;
      }
    }

    if (!role) return;

    const actionPlayer = game.players.find(p => p.userId === userId);
    if (!actionPlayer || actionPlayer.role !== role) return e.reply('你的身份不符。');

    // 调用 recordNightAction，它内部会负责验证和 push 到 pendingNightActions
    const result = game.recordNightAction(role, userId, { type, targetTempId });

    if (result.success) {
      // 成功后，只保存 gameState 字段即可，因为 pendingNightActions 在里面
      await this.saveGameField(groupId, game, 'gameState');
      e.reply(result.message);
    } else {
      e.reply(result.message);
    }
  }

  /**
   * 处理 #狼聊 或 #w 命令。
   * @param {object} e - 消息事件对象。
   * @returns {Promise<boolean>} 是否成功处理。
   */
  async handleWerewolfChat(e) {
    const userId = e.user_id;

    // 1. 查找玩家所在的游戏
    const gameInfo = await this.findUserActiveGame(userId);
    if (!gameInfo) {
      return e.reply('你当前不在任何一场进行中的游戏中，或游戏状态非夜晚，无法使用狼人频道。');
    }

    const { groupId, instance: game } = gameInfo;

    // 2. 验证游戏阶段：必须是夜晚
    if (game.gameState.status !== 'night_phase_1') {
      return e.reply('非狼人行动时间，狼人频道已关闭。');
    }

    // 3. 验证发送者身份：必须是存活的狼人阵营成员
    const senderPlayer = game.players.find(p => p.userId === userId && p.isAlive);
    const wolfRoles = [ROLES.WEREWOLF, ROLES.WOLF_KING, ROLES.WHITE_WOLF_KING];
    if (!senderPlayer || !wolfRoles.includes(senderPlayer.role)) {
      return e.reply('你不是狼人阵营的成员，无法使用狼人频道。');
    }

    // 4. 提取聊天内容
    const match = e.msg.match(/^#(狼聊|w)\s*(.+)$/);
    if (!match || !match[2]) {
      return e.reply('狼聊内容不能为空。');
    }
    const chatContent = match[2].trim();
    if (!chatContent) {
      return e.reply('狼聊内容不能为空。');
    }

    // 5. 找到所有其他的狼队友
    const werewolfTeammates = game.players.filter(p =>
      p.isAlive &&
      wolfRoles.includes(p.role) &&
      p.userId !== userId // 排除发送者自己
    );

    // 6. 如果没有其他狼队友，则告知发送者
    if (werewolfTeammates.length === 0) {
      return e.reply('你是唯一的狼人，没有其他队友可以交流。');
    }

    // 7. 调用WerewolfGame中定义的狼人聊天行为
    const sendDirectMessageFunc = async (userId, msg, sourceGroupId) => {
      return await this.sendDirectMessage(userId, msg, sourceGroupId, false);
    };

    const result = await game._roleActions[ROLES.WEREWOLF].sendWerewolfChat(game, senderPlayer, werewolfTeammates, chatContent, sendDirectMessageFunc);

    // 8. 给发送者一个确认回执
    return e.reply(result.message);
  }

  /**
     * 处理 #结束发言 或 #过 命令。
     * @param {object} e - 消息事件对象。
     * @returns {Promise<boolean>} 是否成功处理。
     */
  async handleEndSpeech(e) {
    const groupId = e.group_id;
    if (!groupId) return;
    const game = await this.getGameInstance(groupId);
    if (!game || game.gameState.status !== 'day_speak') return;
    if (game.gameState.currentSpeakerUserId !== e.user_id) return e.reply("现在不是你的发言时间哦。", false, { at: true });

    const speaker = game.players.find(p => p.userId === e.user_id);
    await this.sendSystemGroupMsg(groupId, `${speaker?.nickname || '玩家'} (${speaker?.tempId || '??'}号) 已结束发言。`);

    if (game.gameState.hasPermission) {
      await this.mutePlayer(groupId, e.user_id, 3600); // 重新禁言发言结束的玩家
    }

    game.gameState.deadline = null; // 清除发言截止时间
    await redis.zRem(DEADLINE_KEY, String(groupId)); // 从ZSET中移除

    const nextSpeakerUserId = game.moveToNextSpeaker(); // 移动到下一个发言人
    if (nextSpeakerUserId) {
      await this.announceAndSetSpeechTimer(groupId, game); // 宣布并设置下一个发言人的计时器
    } else {
      await this.sendSystemGroupMsg(groupId, "所有玩家发言完毕，进入投票阶段。");
      await this.startVotingPhase(groupId, game); // 进入投票阶段
    }
  }

  /**
   * 处理 #投票 命令。
   * @param {object} e - 消息事件对象。
   * @returns {Promise<boolean>} 是否成功处理。
   */
  async handleVote(e) {
    const groupId = e.group_id
    if (!groupId) return e.reply("请在群聊中使用此命令。", true)
    const game = await this.getGameInstance(groupId)
    if (!game || game.gameState.status !== 'day_vote') return e.reply("当前不是投票时间。", true)

    // 使用正确的解析逻辑提取投票目标
    const match = e.msg.match(/#投票\s*(.+)$/);
    if (!match || !match[1]) {
      return;
    }
    const targetInput = match[1].trim();

    let targetTempId;
    if (targetInput === '弃票' || targetInput === '0' || targetInput === '00') {
      targetTempId = '00'; // 统一用 '00' 代表弃票
    } else if (/^\d+$/.test(targetInput)) {
      targetTempId = targetInput.padStart(2, '0'); // 确保临时ID是两位数
    } else {
      return e.reply("投票指令无效，请发送 #投票 [编号] 或 #投票 弃票", true);
    }

    const result = game.recordVote(e.user_id, targetTempId)
    if (result.success) {
      await this.saveGameField(groupId, game, 'gameState'); // 只更新 gameState 字段
    }
    // 无论成功与否都回复，让用户知道操作已被接收
    await e.reply(result.message, false, { at: true })

    // 检查是否所有存活玩家都已投票，如果是则立即结算
    const activePlayerCount = game.players.filter(p => p.isAlive).length;
    const votedCount = Object.keys(game.gameState.votes).length;

    if (activePlayerCount > 0 && votedCount >= activePlayerCount) {
      console.log(`[${PLUGIN_NAME}] 所有玩家投票完毕，立即结算 (${groupId})`);
      // 清除计时器，立即结算
      if (this.phaseTimers && this.phaseTimers.has(groupId)) {
        this.clearPhaseTimer(groupId);
      }
      game.gameState.deadline = null;
      await redis.zRem(DEADLINE_KEY, String(groupId));
      await this.processVoteEnd(groupId, game);
    }
  }

  /**
   * 处理 #开枪 命令（猎人技能）。
   * @param {object} e - 消息事件对象。
   * @returns {Promise<boolean>} 是否成功处理。
   */
  async handleHunterShoot(e) {
    const userId = e.user_id
    // 查找用户所在的游戏，包括已死亡的玩家（因为猎人可能已死亡）
    const gameInfo = await this.findUserActiveGame(e.user_id, true);
    if (!gameInfo) return e.reply('未找到你参与的游戏。');
    const game = gameInfo.instance;
    // 严格检查当前游戏状态和是否轮到该猎人开枪
    if (game.gameState.status !== 'hunter_shooting' || game.gameState.hunterNeedsToShoot !== e.user_id) {
      return e.reply("现在不是你开枪的时间。");
    }

    const targetTempId = e.msg.match(/\d+/)?.[0].padStart(2, '0')
    if (!targetTempId) return e.reply("指令格式错误，请发送 #开枪 编号");

    const hunterPlayer = game.players.find(p => p.userId === userId);
    // 调用WerewolfGame中定义的猎人开枪行为
    const result = game._roleActions[ROLES.HUNTER].shoot(game, hunterPlayer, targetTempId);

    if (!result.success) return e.reply(result.message);

    game.gameState.deadline = null; // 清除猎人开枪计时器对应的 deadline
    await redis.zRem(DEADLINE_KEY, String(gameInfo.groupId)); // 从ZSET中移除

    const targetPlayer = game.players.find(p => p.tempId === targetTempId);
    if (targetPlayer) targetPlayer.isAlive = false; // 被带走的玩家死亡
    if (hunterPlayer) hunterPlayer.isAlive = false; // 猎人死亡

    const hunterInfo = game.getPlayerInfo(userId);
    const targetInfo = game.getPlayerInfo(targetPlayer.userId);
    // 根据当前阶段判断事件记录的阶段
    const deathPhase = game.gameState.currentPhase === 'NIGHT_RESULT' ? 'night' : 'day';
    game.gameState.eventLog.push({
      day: game.gameState.currentDay,
      phase: deathPhase,
      type: 'HUNTER_SHOOT',
      actor: hunterInfo,
      target: targetInfo
    });

    await this.sendSystemGroupMsg(gameInfo.groupId, result.message);

    const gameStatus = game.checkGameStatus();
    if (gameStatus.isEnd) {
      await this.endGameFlow(gameInfo.groupId, game, gameStatus.winner);
    } else {
      // 猎人开枪后，如果游戏未结束，应该回到白天继续发言/投票
      game.gameState.status = 'day_speak'; // 回到白天发言阶段
      await this.saveGameAll(gameInfo.groupId, game);
      await this.continueAfterDeathEvent(gameInfo.groupId, game);
    }
  }

  /**
   * 处理 #自爆 命令（白狼王自爆）。
   * @param {object} e - 消息事件对象。
   * @returns {Promise<boolean>} 是否成功处理。
   */
  async handleSelfDestruct(e) {
    if (!SELF_DESTRUCT_ENABLED) return e.reply("自爆功能当前未开启。");

    const groupId = e.group_id;
    if (!groupId) return;

    const game = await this.getGameInstance(groupId);
    if (!game || !game.gameState.isRunning) return;

    const player = game.players.find(p => p.userId === e.user_id && p.isAlive);
    if (!player) return;

    const wolfRoles = [ROLES.WEREWOLF, ROLES.WOLF_KING, ROLES.WHITE_WOLF_KING];
    if (!wolfRoles.includes(player.role)) {
      return e.reply("只有狼人阵营才能自爆。");
    }

    if (game.gameState.status !== 'day_speak') {
      return e.reply("只能在白天发言阶段自爆。");
    }

    const match = e.msg.match(/^#自爆(?:\s*(.*))?$/);
    const lastWords = match && match[1] ? match[1].trim() : null;

    if (player.role === ROLES.WHITE_WOLF_KING) {
      // 白狼王自爆，调用其专属技能，此时不带人，带人操作在后续阶段
      const result = game._roleActions[ROLES.WHITE_WOLF_KING].selfDestructClaw(game, player, null);
      if (!result.success) return e.reply(result.message);

      let message = `${player.nickname}(${player.tempId}号) 选择自爆！`;
      if (lastWords) {
        message += `\n遗言是：“${lastWords}”`;
      }
      message += `\n发言阶段立即结束，跳过投票，直接进入黑夜。`;
      await this.sendSystemGroupMsg(groupId, message);

      player.isAlive = false; // 白狼王自爆死亡
      game.gameState.eventLog.push({
        day: game.gameState.currentDay,
        phase: 'day',
        type: 'SELF_DESTRUCT',
        actor: game.getPlayerInfo(player.userId),
        message: lastWords
      });

      game.gameState.status = 'wolf_king_clawing'; // 进入狼王技能阶段
      game.gameState.wolfKingNeedsToClaw = player.userId;
      await this.saveGameAll(groupId, game);
      await this.startWolfKingClawPhase(groupId, game, true); // true表示是白狼王自爆
      return;
    } else { // 普通狼人自爆
      let message = `${player.nickname}(${player.tempId}号) 选择自爆！`;
      if (lastWords) {
        message += `\n遗言是：“${lastWords}”`;
      }
      message += `\n发言阶段立即结束，跳过投票，直接进入黑夜。`;
      await this.sendSystemGroupMsg(groupId, message);

      player.isAlive = false; // 狼人自爆死亡
      game.gameState.eventLog.push({
        day: game.gameState.currentDay,
        phase: 'day',
        type: 'SELF_DESTRUCT',
        actor: game.getPlayerInfo(player.userId),
        message: lastWords
      });
    }

    const gameStatus = game.checkGameStatus();
    if (gameStatus.isEnd) {
      await this.endGameFlow(groupId, game, gameStatus.winner);
    } else {
      game.gameState.status = 'night_phase_1'; // 进入夜晚第一阶段
      await this.saveGameAll(groupId, game);
      await this.transitionToNextPhase(groupId, game, 'night_phase_1');
    }
  }

  /**
   * 处理 #狼爪 命令（狼王技能）。
   * @param {object} e - 消息事件对象。
   * @returns {Promise<boolean>} 是否成功处理。
   */
  async handleWolfKingClaw(e) {
    const userId = e.user_id;
    // 查找用户所在的游戏，包括已死亡的玩家（因为狼王可能已死亡）
    const gameInfo = await this.findUserActiveGame(userId, true);
    if (!gameInfo) return e.reply('未找到你参与的游戏。');

    const { groupId, instance: game } = gameInfo;
    // 严格检查当前游戏状态和是否轮到该狼王发动技能
    if (game.gameState.status !== 'wolf_king_clawing' || game.gameState.wolfKingNeedsToClaw !== userId) {
      return e.reply("现在不是你使用狼王之爪的时间。");
    }

    const targetTempId = e.msg.match(/\d+/)?.[0].padStart(2, '0');
    if (!targetTempId) return e.reply("指令格式错误，请发送 #狼爪 编号");

    const wolfKingPlayer = game.players.find(p => p.userId === userId);
    // 调用WerewolfGame中定义的狼王技能行为
    const result = game._roleActions[wolfKingPlayer.role].claw(game, wolfKingPlayer, targetTempId);

    if (!result.success) return e.reply(result.message);

    game.gameState.deadline = null; // 清除狼王技能计时器对应的 deadline
    await redis.zRem(DEADLINE_KEY, String(groupId));

    const targetPlayer = game.players.find(p => p.tempId === targetTempId);
    if (targetPlayer) targetPlayer.isAlive = false; // 被带走的玩家死亡

    const wolfKingInfo = game.getPlayerInfo(userId);
    const targetInfo = game.getPlayerInfo(targetPlayer.userId);

    // 记录事件
    game.gameState.eventLog.push({
      day: game.gameState.currentDay,
      phase: game.gameState.currentPhase === 'DAY' ? 'day' : 'night',
      type: 'WOLF_KING_CLAW',
      actor: wolfKingInfo,
      target: targetInfo
    });

    await this.sendSystemGroupMsg(groupId, result.message);

    const gameStatus = game.checkGameStatus();
    if (gameStatus.isEnd) {
      await this.endGameFlow(groupId, game, gameStatus.winner);
    } else {
      game.gameState.status = 'night_phase_1'; // 进入夜晚第一阶段
      await this.saveGameAll(groupId, game);
      await this.transitionToNextPhase(groupId, game, 'night_phase_1');
    }
  }

  /**
   * 处理 #强制结束狼人杀 命令。
   * @param {object} e - 消息事件对象。
   * @param {boolean} [isAutoCleanup=false] - 是否为自动清理触发。
   * @returns {Promise<boolean|null>} 是否成功处理，如果游戏不存在且非自动清理则返回null。
   */
  async forceEndGame(e, isAutoCleanup = false) {
    const groupId = e.group_id
    if (!groupId) return
    const game = await this.getGameInstance(groupId)
    if (!game) return isAutoCleanup ? null : e.reply("本群当前没有游戏。", true)

    let canEnd = false
    // 检查权限：自动清理、主人、群管理员、群主、房主
    if (isAutoCleanup || e.isMaster || (e.member && ['owner', 'admin'].includes(e.member.role)) || (e.sender && e.sender.role === 'owner') || game.gameState.hostUserId === e.user_id) {
      canEnd = true;
    }
    if (!canEnd) return e.reply("只有房主、群管或主人才能强制结束游戏。", true)

    const enderNickname = isAutoCleanup ? '系统自动' : (e.sender.card || e.sender.nickname)
    await this.sendSystemGroupMsg(groupId, `游戏已被 ${enderNickname} 强制结束。`)

    // 如果游戏不是在等待或已结束状态被强制结束，则发送战报和身份
    if (game.gameState.status !== 'waiting' && game.gameState.status !== 'ended') {
      console.log(`[${PLUGIN_NAME}] [DEBUG] forceEndGame - Generating summary and roles for forced end.`);
      const gameSummary = this.generateGameSummary(game);
      const finalRoles = "--- 最终身份公布 ---\n" + game.getFinalRoles();
      const finalMessage = `游戏结束！\n\n` + gameSummary + "\n\n" + finalRoles; // 组合消息
      await this.sendSystemGroupMsg(groupId, finalMessage); // 发送组合消息
    } else {
      console.log(`[${PLUGIN_NAME}] [DEBUG] forceEndGame - Game was in status ${game.gameState.status}, skipping summary/roles.`);
    }

    await this.deleteGame(groupId) // 删除游戏数据
    return true
  }

  /**
   * 生成本局游戏的战报摘要。
   * @param {WerewolfGame} game - 游戏实例。
   * @returns {string} 格式化后的战报摘要字符串。
   */
  generateGameSummary(game) {
    if (!game.gameState.eventLog || game.gameState.eventLog.length === 0) {
      return "本局游戏没有详细的事件记录。";
    }

    let summary = "--- 本局战报回放 ---\n";

    // 1. 按天分组事件
    const eventsByDay = {};
    game.gameState.eventLog.forEach(event => {
      if (!eventsByDay[event.day]) {
        eventsByDay[event.day] = { night: [], day: [] };
      }
      if (event.phase === 'night') {
        eventsByDay[event.day].night.push(event);
      } else {
        eventsByDay[event.day].day.push(event);
      }
    });

    // 2. 遍历每一天生成战报
    for (const day in eventsByDay) {
      if (day === '0') continue; // 通常第0天没有事件，跳过
      summary += `\n【第 ${day} 天】\n`;
      const { night: nightEvents, day: dayPhaseEvents } = eventsByDay[day];

      // --- 夜晚部分 ---
      if (nightEvents.length > 0) {
        summary += "  [夜晚]\n";
        const guardAction = nightEvents.find(e => e.type === 'GUARD_PROTECT');
        if (guardAction) summary += `    - 守卫 ${guardAction.actor} 守护了 ${guardAction.target}。\n`;

        const seerAction = nightEvents.find(e => e.type === 'SEER_CHECK');
        if (seerAction) summary += `    - 预言家 ${seerAction.actor} 查验了 ${seerAction.target}，结果为【${seerAction.result === ROLES.WEREWOLF ? '狼人' : '好人'}】。\n`;

        const wolfAction = nightEvents.find(e => e.type === 'WEREWOLF_ATTACK');
        const witchSave = nightEvents.find(e => e.type === 'WITCH_SAVE');
        const witchKill = nightEvents.find(e => e.type === 'WITCH_KILL');

        if (wolfAction) summary += `    - 狼人团队袭击了 ${wolfAction.target}。\n`;
        if (witchSave) summary += `    - 女巫 ${witchSave.actor} 使用了解药，救活了 ${witchSave.target}。\n`;
        if (witchKill) summary += `    - 女巫 ${witchKill.actor} 使用了毒药，毒杀了 ${witchKill.target}。\n`;

        const nightHunterShoot = nightEvents.find(e => e.type === 'HUNTER_SHOOT');
        if (nightHunterShoot) summary += `    - 死亡的猎人 ${nightHunterShoot.actor} 在夜晚开枪带走了 ${nightHunterShoot.target}。\n`;

        const nightWolfKingClaw = nightEvents.find(e => e.type === 'WOLF_KING_CLAW');
        if (nightWolfKingClaw) summary += `    - 死亡的狼王 ${nightWolfKingClaw.actor} 在夜晚发动技能带走了 ${nightWolfKingClaw.target}。\n`;
      }

      // --- 白天部分 ---
      if (dayPhaseEvents.length > 0) {
        summary += "  [白天]\n";
        const selfDestruct = dayPhaseEvents.find(e => e.type === 'SELF_DESTRUCT');
        if (selfDestruct) {
          let selfDestructMsg = `    - ${selfDestruct.actor} 选择了自爆。`;
          if (selfDestruct.message) {
            selfDestructMsg += ` 遗言：“${selfDestruct.message}”。\n`;
          } else {
            selfDestructMsg += `\n`;
          }
          summary += selfDestructMsg;
        }


        const sheriffElected = dayPhaseEvents.find(e => e.type === 'SHERIFF_ELECTED');
        if (sheriffElected) summary += `    - 经过竞选，${sheriffElected.actor} 当选为警长。\n`;

        const voteOut = dayPhaseEvents.find(e => e.type === 'VOTE_OUT');
        if (voteOut) summary += `    - 经过投票，${voteOut.target} 被放逐 (投票者: ${voteOut.voters.join(', ')})。\n`;

        const badgePass = dayPhaseEvents.find(e => e.type === 'SHERIFF_PASS_BADGE');
        if (badgePass) summary += `    - 死亡的警长 ${badgePass.actor} 将警徽移交给了 ${badgePass.target}。\n`;

        const dayHunterShoot = dayPhaseEvents.find(e => e.type === 'HUNTER_SHOOT');
        if (dayHunterShoot) summary += `    - 被放逐的猎人 ${dayHunterShoot.actor} 开枪带走了 ${dayHunterShoot.target}。\n`;

        const dayWolfKingClaw = dayPhaseEvents.find(e => e.type === 'WOLF_KING_CLAW');
        if (dayWolfKingClaw) summary += `    - 被放逐的狼王 ${dayWolfKingClaw.actor} 发动技能带走了 ${dayWolfKingClaw.target}。\n`;
      }
    }
    return summary.trim();
  }

  /**
   * 处理 #狼人杀状态 命令，显示当前游戏状态。
   * @param {object} e - 消息事件对象。
   * @returns {Promise<boolean>} 是否成功处理。
   */
  async showGameStatus(e) {
    const groupId = e.group_id
    if (!groupId) return
    const game = await this.getGameInstance(groupId)
    if (!game || game.gameState.status === 'ended') return e.reply("本群当前没有游戏。", true)

    let statusMsg = `--- ${PLUGIN_NAME} 游戏状态 ---\n`
    statusMsg += `状态: ${game.gameState.status}\n`
    statusMsg += `天数: ${game.gameState.currentDay}\n`
    statusMsg += `房主: ${game.getPlayerInfo(game.gameState.hostUserId)}\n`
    statusMsg += `存活玩家 (${game.players.filter(p => p.isAlive).length}/${game.players.length}):\n`
    statusMsg += game.getAlivePlayerList()
    if (game.gameState.status === 'day_speak' && game.gameState.currentSpeakerUserId) {
      statusMsg += `\n当前发言: ${game.getPlayerInfo(game.gameState.currentSpeakerUserId)}`
    }
    if (game.gameState.deadline) {
      const remaining = Math.round((game.gameState.deadline - Date.now()) / 1000);
      if (remaining > 0) statusMsg += `\n当前阶段剩余时间: ${remaining}秒`
    }
    return e.reply(statusMsg, true)
  }

  // --- 游戏流程与计时器管理函数 ---

  /**
   * 私聊发送玩家角色身份和技能说明。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   * @returns {Promise<void>}
   */
  async sendRolesToPlayers(groupId, game) {
    await this.sendSystemGroupMsg(groupId, "正在私聊发送角色身份和临时编号...");

    // 提前找出所有狼人，用于告知狼队友信息
    const wolfRoles = [ROLES.WEREWOLF, ROLES.WOLF_KING, ROLES.WHITE_WOLF_KING];
    const werewolfPlayers = game.players.filter(p => wolfRoles.includes(p.role));
    const werewolfTeamInfo = werewolfPlayers.map(p => `${p.nickname}(${p.tempId}号) - [${game.roles[p.role]}]`).join('、');

    // 角色技能描述映射
    const roleDescriptions = {
      WEREWOLF: '【技能说明】\n每晚可以和队友共同袭击一名玩家。\n可使用#狼聊或者#w开头在夜晚的狼人频道进行发言，你的发言会广播给其他狼人\n请在夜晚阶段私聊我：杀 [编号]',
      VILLAGER: '【技能说明】\n你是一个普通村民，白天努力分析局势，投票放逐可疑的玩家。',
      SEER: '【技能说明】\n每晚可以查验一名玩家的阵营（狼人或好人）。\n请在夜晚阶段私聊我：查验 [编号]',
      WITCH: '【技能说明】\n你有一瓶解药和一瓶毒药。\n解药可以救活当晚被袭击的玩家，毒药可以毒死一名玩家。解药和毒药整局游戏只能各使用一次。',
      HUNTER: '【技能说明】\n当你被投票出局或被狼人袭击身亡时，可以开枪带走场上任意一名玩家。',
      GUARD: '【技能说明】\n每晚可以守护一名玩家，使其免受狼人袭击。但不能连续两晚守护同一个人。',
      WOLF_KING: '【技能说明】\n狼人阵营。出局时可以发动“狼王之爪”，带走场上任意一名玩家。',
      WHITE_WOLF_KING: '【技能说明】\n狼人阵营。只能在白天发言阶段自爆，并带走一名玩家。非自爆出局时，技能无法发动。',
      IDIOT: '【身份说明】\n好人阵营。若在白天被投票出局，会翻开身份牌，免于死亡，但会失去后续的投票权。若在夜间被杀，则直接死亡。'
    };

    for (const player of game.players) {
      const roleName = game.roles[player.role] || '未知角色';
      let message = `你在本局狼人杀中的身份是：【${roleName}】\n你的临时编号是：【${player.tempId}号】`;

      // 附加技能描述
      const description = roleDescriptions[player.role];
      if (description) {
        message += `\n\n${description}`;
      }

      // 对狼人发送特殊消息，告知狼队友
      if (wolfRoles.includes(player.role)) {
        if (werewolfPlayers.length > 1) {
          message += `\n\n你的狼队友是：${werewolfTeamInfo}。`;
        } else {
          message += `\n\n你是本局唯一的狼人。`;
        }
      }

      await this.sendDirectMessage(player.userId, message, groupId);
      await new Promise(resolve => setTimeout(resolve, 300)); // 添加延迟，避免消息发送过快
    }
    await this.sendSystemGroupMsg(groupId, "所有身份已发送完毕！");
  }

  /**
   * 开始夜晚阶段。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   * @returns {Promise<void>}
   */
  async startNightPhase(groupId, game) {
    if (!game) return
    game.gameState.status = 'night_phase_1'; // 使用更明确的状态
    game.gameState.currentDay++; // 天数增加

    //截止时间只计算狼人阶段
    game.gameState.deadline = Date.now() + this.WEREWOLF_PHASE_DURATION;
    await redis.zAdd(DEADLINE_KEY, [{ score: game.gameState.deadline, value: String(groupId) }]);
    await this.saveGameAll(groupId, game);

    await this.sendSystemGroupMsg(groupId, `--- 第 ${game.gameState.currentDay} 天 - 夜晚 ---`);
    await this.sendSystemGroupMsg(groupId, `天黑请闭眼... 狼人等角色行动阶段开始，时长 ${this.WEREWOLF_PHASE_DURATION / 1000} 秒。\n【夜晚行动阶段】有身份的玩家请根据私聊提示进行操作。`);

    if (AUTO_MUTE_ENABLED && game.gameState.hasPermission) { // 使用AUTO_MUTE_ENABLED常量
      await this.sendSystemGroupMsg(groupId, "正在禁言所有存活玩家...");
      await this.muteAllPlayers(groupId, game, true, 3600); // 禁言所有存活玩家
    }

    const alivePlayerList = game.getAlivePlayerList();
    for (const player of game.players.filter(p => p.isAlive)) {
      let prompt = null;
      switch (player.role) {
        case 'WEREWOLF':
          prompt = `狼人请行动。\n请私聊我：杀 [编号]\n可使用#狼聊或#w开头在夜晚的狼人频道进行发言。\n请在 ${this.WEREWOLF_PHASE_DURATION / 1000} 秒内完成操作。\n${alivePlayerList}`;
          break;
        case 'SEER':
          prompt = `预言家请行动。\n请私聊我：查验 [编号]\n请在 ${this.WEREWOLF_PHASE_DURATION / 1000} 秒内完成操作。\n${alivePlayerList}`;
          break;
        case 'GUARD':
          let guardPrompt = `守卫请行动。\n`;
          if (game.gameState.lastProtectedId) guardPrompt += `（你上晚守护了 ${game.getPlayerInfo(game.gameState.lastProtectedId)}，不能连守）\n`;
          prompt = guardPrompt + `请私聊我：守 [编号]\n请在 ${this.WEREWOLF_PHASE_DURATION / 1000} 秒内完成操作。\n${alivePlayerList}`;
          break;
      }
      if (prompt) await this.sendDirectMessage(player.userId, prompt, groupId);
    }

  }

  /**
   * 过渡到夜晚阶段二 - 女巫行动。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   * @returns {Promise<void>}
   */
  async transitionToWitchPhase(groupId, game) {
    if (!game || game.gameState.status !== 'night_phase_1') return; // 确保是从正确的阶段过来

    game.gameState.status = 'night_phase_2'; // 进入女巫阶段

    // 将狼人的"待处理"行动转移到"最终决定"
    // 注意：这里我们只转移狼人的行动，其他行动暂时不动
    if (game.gameState.pendingNightActions['WEREWOLF']) {
      game.gameState.nightActions['WEREWOLF'] = game.gameState.pendingNightActions['WEREWOLF'];
    }

    const attackTargetId = game.getWerewolfAttackTargetId();

    // 设置女巫阶段的截止时间
    game.gameState.deadline = Date.now() + this.WITCH_ACTION_DURATION;
    await redis.zAdd(DEADLINE_KEY, [{ score: game.gameState.deadline, value: String(groupId) }]);
    await this.saveGameAll(groupId, game);

    // 准备并发送给女巫的私聊信息
    const witchPlayer = game.players.find(p => p.role === 'WITCH' && p.isAlive);
    if (!witchPlayer) return; // 如果女巫死了，就什么也不做

    let witchPrompt = `女巫请行动。\n`;
    if (attackTargetId) {
      witchPrompt += `昨晚 ${game.getPlayerInfo(attackTargetId)} 被袭击了。\n`;
    } else {
      witchPrompt += `昨晚无人被袭击（狼人未行动或平票未统一）。\n`;
    }
    witchPrompt += `药剂状态：解药 ${game.potions.save ? '可用' : '已用'}，毒药 ${game.potions.kill ? '可用' : '已用'}。\n`;
    if (game.potions.save) witchPrompt += `使用解药请私聊我：救 [编号]\n`;
    if (game.potions.kill) witchPrompt += `使用毒药请私聊我：毒 [编号]\n`;
    witchPrompt += `你的行动时间为 ${this.WITCH_ACTION_DURATION / 1000} 秒。\n${game.getAlivePlayerList()}`;

    await this.sendDirectMessage(witchPlayer.userId, witchPrompt, groupId);
    await this.sendSystemGroupMsg(groupId, `狼人行动结束，开始女巫单独行动...`);
  }

  /**
   * 处理夜晚阶段结束，进行结算。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   * @returns {Promise<void>}
   */
  async processNightEnd(groupId, game) {
    if (!game || game.gameState.status !== 'night_phase_2') return;

    this.clearPhaseTimer(groupId); // 清除阶段计时器
    game.gameState.deadline = null; // 清理 deadline

    await this.sendSystemGroupMsg(groupId, "天亮了，进行夜晚结算...");

    // 结算夜晚行动。这个方法会修改 game 实例内部的 players 数组 (例如添加 DYING 标签)
    const result = game.processNightActions();

    game.gameState.recentlyDeceased = result.deadPlayers || []; // 记录最近死亡玩家

    await this.saveGameAll(groupId, game); // 保存最新游戏状态到Redis，并更新内存缓存

    await this.sendSystemGroupMsg(groupId, result.summary); // 公布夜晚摘要

    // 后续的逻辑（检查游戏是否结束、进入下一阶段）会基于这个已经保存的最新 game 状态进行判断
    const deadSheriff = result.deadPlayers.find(p => p.userId === game.gameState.sheriffUserId);

    if (result.gameEnded) {
      await this.endGameFlow(groupId, game, result.winner);
    } else if (deadSheriff) {
      game.gameState.lastStableStatus = game.gameState.status;
      await this.startSheriffPassBadgePhase(groupId, game, deadSheriff.userId);
    } else if (result.needsHunterShoot) {
      game.gameState.lastStableStatus = game.gameState.status;
      await this.startHunterShootPhase(groupId, game);
    } else if (result.needsWolfKingClaw) {
      await this.startWolfKingClawPhase(groupId, game);
    } else {
      if (game.gameState.currentDay === 1 && game.gameState.hasSheriff && !game.gameState.sheriffUserId) {
        await this.startSheriffElectionPhase(groupId, game);
      } else {
        await this.transitionToNextPhase(groupId, game, 'day_speak');
      }
    }
  }

  /**
   * 处理 #上警 命令。
   * @param {object} e - 消息事件对象。
   * @returns {Promise<boolean>}
   */
  async handleSheriffSignup(e) {
    // 1. 获取当前游戏实例
    const gameInfo = await this.findUserActiveGame(e.user_id);
    if (!gameInfo) return; // 如果玩家不在任何游戏中，则不作响应
    const game = gameInfo.instance;
    const groupId = gameInfo.groupId;

    // 2. 验证游戏阶段
    if (game.gameState.status !== 'sheriff_election_signup') {
      return e.reply("当前不是竞选警长报名时间。");
    }

    // 3. 调用逻辑处理上警
    const result = game.addSheriffCandidate(e.user_id);

    // 4. 根据处理结果，给玩家反馈
    if (result.success) {
      // 成功上警，私聊回复
      await e.reply(result.message, true); // at发送者并回复
      // 也可以考虑在群里发一个公告
      await this.sendSystemGroupMsg(groupId, `${e.sender.card} (${result.player.tempId}号) 已上警！`);
    } else {
      // 如果上警失败（比如重复上警），则私聊回复他原因
      return e.reply(result.message, true);
    }

    // 5. 保存游戏状态的变更
    await this.saveGameAll(groupId, game);
  }

  /**
   * 处理发言超时。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   */
  async processSpeechTimeout(groupId, game) {
    // 1. 检查是否是有效的发言阶段
    const validStatuses = ['day_speak', 'sheriff_speech'];
    if (!game || !validStatuses.includes(game.gameState.status)) {
      return;
    }

    const timedOutSpeaker = game.getPlayerInfo(game.gameState.currentSpeakerUserId);
    if (!timedOutSpeaker) return;

    await this.sendSystemGroupMsg(groupId, `${timedOutSpeaker.nickname}(${timedOutSpeaker.tempId}号) 发言时间到。`);

    if (game.gameState.hasPermission) {
      await this.mutePlayer(groupId, timedOutSpeaker.userId, 3600);
    }

    // 2. 移动到下一个发言人
    const nextSpeakerUserId = game.moveToNextSpeaker();

    // 3. 根据是否有下一个人，以及当前是什么阶段，决定下一步
    if (nextSpeakerUserId) {
      // 只要有下一个人，就调用我们改造好的通用方法
      await this.announceAndSetSpeechTimer(groupId, game);
    } else {
      // 如果没有下一个发言人了
      if (game.gameState.status === 'day_speak') {
        await this.sendSystemGroupMsg(groupId, "所有玩家发言完毕，进入投票阶段。");
        await this.startVotingPhase(groupId, game); // 白天发言结束 -> 进入公投
      } else if (game.gameState.status === 'sheriff_speech') {
        await this.sendSystemGroupMsg(groupId, "所有竞选者发言完毕，现在开始投票。");
        await this.startSheriffVotePhase(groupId, game); // 警长发言结束 -> 进入警长投票
      }
    }
  }

  /**
   * 处理警长竞选报名阶段结束（超时）。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   * @returns {Promise<void>}
   */
  async processSheriffSignupEnd(groupId, game) {
    const candidates = game.gameState.candidateList;

    // 情况一：无人上警
    if (candidates.length === 0) {
      game.gameState.isSheriffElection = false; // 警长竞选流程结束
      await this.sendSystemGroupMsg(groupId, "报名时间结束，无人竞选警长。本局游戏将没有警长。");
      // 警长竞选失败，直接进入正常的白天发言阶段
      game.gameState.status = 'day_speak';
      await this.saveGameAll(groupId, game);
      await this.transitionToNextPhase(groupId, game, 'day_speak');
      return;
    }

    // 情况二：只有一人上警
    if (candidates.length === 1) {
      const newSheriffId = candidates[0];
      game.gameState.sheriffUserId = newSheriffId; // 直接当选
      game.gameState.isSheriffElection = false; // 警长竞选流程结束

      const sheriffInfo = game.getPlayerInfo(newSheriffId);
      await this.sendSystemGroupMsg(groupId, `只有 ${sheriffInfo.nickname}(${sheriffInfo.tempId}号) 一人竞选，TA将自动当选为本局游戏的警长！`);

      // 同样，直接进入正常的白天发言阶段
      game.gameState.status = 'day_speak';
      await this.saveGameAll(groupId, game);
      await this.transitionToNextPhase(groupId, game, 'day_speak');
      return;
    }

    // 情况三：有多人上警，进入竞选发言阶段
    if (candidates.length > 1) {
      // 我们将调用一个新的方法来开启竞选发言
      await this.startSheriffSpeechPhase(groupId, game);
    }
  }

  /**
 * 开始警长竞选的发言阶段。
 * @param {string} groupId - 群组ID。
 * @param {WerewolfGame} game - 游戏实例。
 */
  async startSheriffSpeechPhase(groupId, game) {
    // 1. 设置游戏状态为“警长发言”
    game.gameState.status = 'sheriff_speech';

    // 2. 设置发言顺序
    game.gameState.speakingOrder = [...game.gameState.candidateList];
    game.gameState.currentSpeakerOrderIndex = -1;

    // 3. 发布公告
    const candidateInfos = game.gameState.speakingOrder.map(userId =>
      `${game.getPlayerInfo(userId).nickname}(${game.getPlayerInfo(userId).tempId}号)`
    ).join('、');
    await this.sendSystemGroupMsg(groupId, `--- 警长竞选发言 ---\n上警玩家为：${candidateInfos}。\n现在将按照此顺序进行竞选发言。`);

    // 4. 【关键】调用游戏核心逻辑，移动到第一个发言人
    const firstSpeakerId = game.moveToNextSpeaker();

    // 5. 调用已有的方法，让第一个人开始发言
    if (firstSpeakerId) {
      await this.announceAndSetSpeechTimer(groupId, game);
    } else {
      // 如果意外地没有候选人，直接进入投票（虽然不太可能发生）
      await this.sendSystemGroupMsg(groupId, "没有有效的竞选者可以发言。");
      await this.startSheriffVotePhase(groupId, game);
    }
  }

  /**
   * 处理 #投警长 命令。
   * @param {object} e - 消息事件对象。
   * @returns {Promise<boolean>}
   */
  async handleSheriffVote(e) {
    // 1. 获取游戏实例和玩家信息
    const gameInfo = await this.findUserActiveGame(e.user_id);
    if (!gameInfo) return;
    const game = gameInfo.instance;
    const groupId = gameInfo.groupId;
    const voterId = e.user_id;

    // 2. 验证游戏阶段
    if (game.gameState.status !== 'sheriff_vote') {
      return; // 不是警长投票时间，静默处理
    }

    // 3. 解析投票目标
    const targetTempId = e.msg.match(/\d+/)?.[0].padStart(2, '0');
    if (!targetTempId) {
      return e.reply("指令格式错误，请发送 #投警长 编号", true);
    }

    // 4. 调用逻辑来处理投票
    const result = game.recordSheriffVote(voterId, targetTempId);

    // 5. 根据结果给玩家反馈
    if (result.success) {
      await e.reply(`你已成功投票给 ${result.targetInfo.nickname}(${result.targetInfo.tempId}号)。`, true);
    } else {
      await e.reply(result.message, true); // 投票失败，告知原因
    }

    // 注意：这里我们不需要保存游戏状态，因为投票是临时的。
    // 我们会在投票结束后，一次性处理和保存。
  }

  /**
   * 记录一票警长投票。
   * @param {string} voterId - 投票者的用户ID。
   * @param {string} targetTempId - 投票目标的临时编号。
   * @returns {object} 包含 success 和 message 的结果对象。
   */
  recordSheriffVote(voterId, targetTempId) {
    const voter = this.getPlayerInfo(voterId);
    if (!voter || !voter.isAlive) {
      return { success: false, message: '你已出局或不在游戏中，无法投票。' };
    }

    // 检查投票者是否是警长候选人（警上不能投票）
    if (this.gameState.candidateList.includes(voterId)) {
      return { success: false, message: '你是警长候选人，不能参与投票。' };
    }

    const target = this.players.find(p => p.tempId === targetTempId);
    if (!target) {
      return { success: false, message: '投票目标不存在。' };
    }

    // 检查投票目标是否是警长候选人
    if (!this.gameState.candidateList.includes(target.userId)) {
      return { success: false, message: '投票目标不是警长候选人。' };
    }

    // 记录投票
    this.gameState.sheriffVotes[voterId] = target.userId;

    return {
      success: true,
      targetInfo: this.getPlayerInfo(target.userId)
    };
  }

  /**
   * 处理警长投票阶段结束，进行计票和结算。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   * @returns {Promise<void>}
   */
  async processSheriffVoteEnd(groupId, game) {
    if (!game || game.gameState.status !== 'sheriff_vote') return;

    await this.sendSystemGroupMsg(groupId, "警长投票时间结束，正在计票...");

    // 调用核心逻辑进行计票
    const result = game.processSheriffVotes();

    // 在群里公布计票结果
    await this.sendSystemGroupMsg(groupId, result.summary);

    // 根据计票结果，决定下一步
    if (result.sheriffElected) {
      // 【情况一】警长已诞生
      game.gameState.isSheriffElection = false; // 警长竞选流程结束
      const sheriffInfo = game.getPlayerInfo(result.sheriffId);
      await this.sendSystemGroupMsg(groupId, `恭喜 ${sheriffInfo.nickname}(${sheriffInfo.tempId}号) 当选为本局警长！`);

      game.gameState.eventLog.push({
        day: game.gameState.currentDay,
        phase: 'day',
        type: 'SHERIFF_ELECTED',
        actor: sheriffInfo
      });

      // 警长诞生后，进入正常的白天发言阶段
      await this.transitionToNextPhase(groupId, game, 'day_speak');

    } else if (result.isTie) {
      // 【情况二】出现平票，需要进行PK
      await this.sendSystemGroupMsg(groupId, `出现平票！平票玩家将进入PK环节。`);
      // PK环节就是让平票的玩家再进行一轮发言，然后警下玩家再投一次
      // 为了简化，我们暂时先不实现复杂的PK逻辑，可以先视为流局
      // TODO: 实现PK发言和第二轮投票
      game.gameState.isSheriffElection = false;
      await this.sendSystemGroupMsg(groupId, `（PK功能暂未实现）本轮警长竞选流局，本局游戏将没有警长。`);
      await this.transitionToNextPhase(groupId, game, 'day_speak');

    } else {
      // 【情况三】无人投票或所有票无效，视为流局
      game.gameState.isSheriffElection = false;
      await this.sendSystemGroupMsg(groupId, `无人投票，警长竞选流局，本局游戏将没有警长。`);
      await this.transitionToNextPhase(groupId, game, 'day_speak');
    }
  }

  /**
   * 宣布当前发言玩家并设置发言计时器。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   */
  async announceAndSetSpeechTimer(groupId, game) {
    // 1. 根据当前游戏状态，决定使用哪个时长常量
    let currentPhaseDuration = 0;
    if (game.gameState.status === 'day_speak') {
      currentPhaseDuration = this.SPEECH_DURATION;
    } else if (game.gameState.status === 'sheriff_speech') {
      currentPhaseDuration = this.SHERIFF_SPEECH_DURATION;
    } else {
      return; // 如果不是任何发言阶段，则直接退出
    }

    const speakerId = game.gameState.currentSpeakerUserId;
    if (!speakerId) return;

    const speaker = game.getPlayerInfo(speakerId);
    if (!speaker) return;

    // 2. 使用动态获取的时长来设置deadline
    game.gameState.deadline = Date.now() + currentPhaseDuration;
    await redis.zAdd(DEADLINE_KEY, [{ score: game.gameState.deadline, value: String(groupId) }]);
    await this.saveGameField(groupId, game, 'gameState');

    // 3. 准备公告信息
    let msg;

    if (speaker.isAlive) {
      // 分支一：如果玩家是活着的，就@他进行正常发言
      msg = [
        segment.at(speaker.userId),
        ` 请开始发言 (${currentPhaseDuration / 1000}秒)\n`
      ];
    } else {
      // 分支二：如果玩家已死亡（发表遗言），就只说出昵称，避免@报错
      msg = `现在轮到 ${speaker.nickname}(${speaker.tempId}号) 发表遗言 (${currentPhaseDuration / 1000}秒)\n`;
    }

    // 为了让后续代码能统一处理，我们确保 msg 是一个数组
    if (typeof msg === 'string') {
      msg = [msg];
    }

    // 根据阶段添加不同的提示
    if (game.gameState.status === 'day_speak') {
      msg.push('发送#结束发言或“过”以结束你的发言。');
    } else if (game.gameState.status === 'sheriff_speech') {
      msg.push('你可以随时发送【#退水】来退出竞选。');
    }

    // 4. 解禁操作
    if (game.gameState.hasPermission) {
      // 在单独解禁前，先禁言所有活着的玩家
      await this.muteAllPlayers(groupId, game);
      await this.mutePlayer(groupId, speaker.userId, 0); // 解禁当前发言者
    }

    await this.sendSystemGroupMsg(groupId, msg);
  }

  /**
   * 处理 #退水 命令。
   * @param {object} e - 消息事件对象。
   * @returns {Promise<boolean>}
   */
  async handleSheriffWithdraw(e) {
    const gameInfo = await this.findUserActiveGame(e.user_id);
    if (!gameInfo) return;
    const game = gameInfo.instance;
    const groupId = gameInfo.groupId;
    const userId = e.user_id;

    // 验证游戏阶段：只有在警长发言或准备投票时才能退水
    const validStatuses = ['sheriff_speech', 'sheriff_vote'];
    if (!validStatuses.includes(game.gameState.status)) {
      return; // 不是退水时间，不作响应
    }

    // 调用核心逻辑处理退水
    const result = game.withdrawFromSheriffElection(userId);

    if (result.success) {
      // 在群里公告谁退水了
      const playerInfo = game.getPlayerInfo(userId);
      await this.sendSystemGroupMsg(groupId, `${playerInfo.nickname}(${playerInfo.tempId}号) 已退水，不再参与警长竞选。`);

      // 检查退水后是否只剩一人，如果只剩一人，他自动当选
      if (result.remainingCandidates === 1) {
        const winnerId = game.gameState.candidateList[0];
        const winnerInfo = game.getPlayerInfo(winnerId);
        game.gameState.sheriffUserId = winnerId; // 直接当选
        game.gameState.isSheriffElection = false;

        await this.sendSystemGroupMsg(groupId, `场上只剩一名候选人，${winnerInfo.nickname}(${winnerInfo.tempId}号) 自动当选为警长！`);
        // 竞选结束，直接进入白天发言
        await this.transitionToNextPhase(groupId, game, 'day_speak');
      }

      await this.saveGameAll(groupId, game);
    } else {
      // 失败则私聊回复
      await e.reply(result.message, true);
    }
  }

  /**
   * 开始警徽移交阶段。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   * @param {string} deadSheriffId - 死亡警长的用户ID。
   */
  async startSheriffPassBadgePhase(groupId, game, deadSheriffId) {
    game.gameState.status = 'sheriff_pass_badge';

    const duration = 60 * 1000; // 60秒移交时间
    game.gameState.deadline = Date.now() + duration;
    await redis.zAdd(DEADLINE_KEY, [{ score: game.gameState.deadline, value: String(groupId) }]);
    await this.saveGameAll(groupId, game);

    const announcement = `警长倒牌！请警长在 ${duration / 1000} 秒内私聊我【#移交警徽 编号】来选择新的警长。\n超时或移交给非存活玩家，警徽将会被撕毁。`;
    // 这个消息需要同时发给群里和私聊给死去的警长
    await this.sendSystemGroupMsg(groupId, announcement);
    await this.sendDirectMessage(deadSheriffId, announcement, groupId);
  }

  /**
   * 处理 #移交警徽 命令。
   * @param {object} e - 消息事件对象。
   */
  async handleSheriffPassBadge(e) {
    const gameInfo = await this.findUserActiveGame(e.user_id);
    if (!gameInfo) return;
    const game = gameInfo.instance;
    const groupId = gameInfo.groupId;

    // 验证：必须是警徽移交阶段，且操作者必须是刚刚死去的那个警长
    if (game.gameState.status !== 'sheriff_pass_badge' || e.user_id !== game.gameState.sheriffUserId) {
      return;
    }

    const targetTempId = e.msg.match(/\d+/)?.[0].padStart(2, '0');
    if (!targetTempId) return e.reply("指令格式错误，请发送 #移交警徽 编号", true);

    const targetPlayer = game.players.find(p => p.tempId === targetTempId && p.isAlive);
    if (!targetPlayer) {
      return e.reply("移交目标不存在或已出局，请重新选择。", true);
    }

    // 更新警长
    game.gameState.sheriffUserId = targetPlayer.userId;
    const oldSheriffInfo = game.getPlayerInfo(e.user_id);
    const newSheriffInfo = game.getPlayerInfo(targetPlayer.userId);

    await this.sendSystemGroupMsg(groupId, `${oldSheriffInfo.nickname} 将警徽移交给了 ${newSheriffInfo.nickname}(${newSheriffInfo.tempId}号)！`);

    game.gameState.eventLog.push({
      day: game.gameState.currentDay,
      phase: 'day', // 移交通常发生在白天死亡后
      type: 'SHERIFF_PASS_BADGE',
      actor: oldSheriffInfo,
      target: newSheriffInfo
    });

    // 警徽移交完毕，流程继续
    await this.continueAfterDeathEvent(groupId, game);
  }

  /**
   * 开始白天发言阶段。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   * @returns {Promise<void>}
   */
  async startDayPhase(groupId, game) {
    if (!game) return;
    game.gameState.status = 'day_speak';

    // 判断是从投票阶段过来的还是从夜晚阶段过来的
    const cameFromVote = game.gameState.lastStableStatus === 'day_vote';

    // --- 构建发言顺序 ---
    let speechOrder = [];
    const deceasedPlayers = game.gameState.recentlyDeceased || [];

    console.log('--- [调试信息] 开始检查死亡玩家数据 ---');
    console.log('变量 deceasedPlayers 的内容是:', JSON.stringify(deceasedPlayers, null, 2));
    console.log('--- [调试信息] 检查结束 ---');

    // 判断是否需要留遗言
    // 条件：第一天晚上死的，或者白天被投票出局的
    const isFirstNightDeath = game.gameState.currentDay === 1 && game.gameState.lastStableStatus === 'night_phase_2';

    if (deceasedPlayers.length > 0 && (isFirstNightDeath || cameFromVote)) {
      const lastWordsPlayers = deceasedPlayers.map(p => p.userId).filter(id => id);
      speechOrder.push(...lastWordsPlayers); // 让死者先发言

      // 准备一个简单的遗言通知
      const announcementParts = lastWordsPlayers.map(userId => {
        const playerInfo = game.getPlayerByUserId(userId);
        return playerInfo ? `${playerInfo.number}号玩家` : "一位玩家";
      });
      await this.sendSystemGroupMsg(groupId, `现在是 ${announcementParts.join('、')} 发表遗言时间。`);
    }

    // 只有在不是从投票阶段过来的时候，才安排活人发言
    if (!cameFromVote) {
      const alivePlayers = game.players.filter(p => p.isAlive).map(p => p.userId);
      speechOrder.push(...alivePlayers);
    }

    // 清理本次死亡记录，防止后续流程错误引用
    game.gameState.recentlyDeceased = [];

    // --- 开始发言流程 ---
    game.gameState.speakingOrder = speechOrder;
    game.gameState.currentSpeakerOrderIndex = -1;
    const nextSpeakerId = game.moveToNextSpeaker();

    if (nextSpeakerId) {
      // 只有在真的有人要发言时，才宣布并设置计时器
      await this.announceAndSetSpeechTimer(groupId, game);
    } else {
      // 如果没有人可以发言（例如，投票出局者发表完遗言后，流程就该结束了）
      if (cameFromVote) {
        await this.sendSystemGroupMsg(groupId, "遗言发表结束，天黑请闭眼。");
        await this.transitionToNextPhase(groupId, game, 'night_phase_1');
      } else {
        // 正常白天没人可发言（例如所有人都死了），就直接进入投票（虽然不太可能）
        await this.sendSystemGroupMsg(groupId, "所有玩家发言结束，现在开始投票。");
        await this.startVotingPhase(groupId, game);
      }
    }
  }

  /**
   * 开始投票阶段。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   * @returns {Promise<void>}
   */
  async startVotingPhase(groupId, game) {
    game.gameState.status = 'day_vote'
    game.gameState.deadline = Date.now() + this.VOTE_DURATION // 设置投票截止时间
    await redis.zAdd(DEADLINE_KEY, [{ score: game.gameState.deadline, value: String(groupId) }]) // 添加到截止时间ZSET
    await this.saveGameField(groupId, game, 'gameState')

    const alivePlayerList = game.getAlivePlayerList()

    if (game.gameState.hasPermission) {
      await this.sendSystemGroupMsg(groupId, "进入投票阶段，解除所有存活玩家禁言。");
      await this.unmuteAllPlayers(groupId, game, true); // FIX: 只解禁存活玩家
    }

    await this.sendSystemGroupMsg(groupId, `现在开始投票，请选择你要投出的人。\n发送 #投票 [编号] 或 #投票 弃票\n你有 ${this.VOTE_DURATION / 1000} 秒时间。\n存活玩家：\n${alivePlayerList}`)

    this.clearPhaseTimer(groupId); // 清理可能存在的旧计时器，以防万一

    const reminderDelay = this.VOTE_DURATION - 15 * 1000; // 提前15秒提醒
    if (reminderDelay > 0) {
      const timerId = setTimeout(async () => {
        const currentGame = await this.getGameInstance(groupId); // 再次获取最新的游戏实例，确保状态没有改变
        // 如果游戏已不在投票阶段、已结束或未在运行，则不发送提醒
        if (!currentGame || currentGame.gameState.status !== 'day_vote' || !currentGame.gameState.isRunning) {
          this.phaseTimers.delete(groupId) // 清理自身
          return
        }

        const alivePlayers = currentGame.players.filter(p => p.isAlive);
        const votedUserIds = Object.keys(currentGame.gameState.votes);

        const unvotedPlayers = alivePlayers.filter(p => !votedUserIds.includes(p.userId));

        if (unvotedPlayers.length > 0) {
          let reminderMsg = [
            segment.text('【投票提醒】投票时间剩余15秒，请以下玩家尽快投票：\n')
          ];
          unvotedPlayers.forEach(p => {
            reminderMsg.push(segment.at(p.userId));
            reminderMsg.push(segment.text(' '));
          });
          await this.sendSystemGroupMsg(groupId, reminderMsg);
        }
        this.phaseTimers.delete(groupId); // 任务完成，清理自身
      }, reminderDelay);

      this.phaseTimers.set(groupId, timerId); // 存储新的计时器ID
    }
  }

  /**
   * 处理投票阶段结束，进行计票和结算。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   * @returns {Promise<void>}
   */
  async processVoteEnd(groupId, game) {
    game = await this.getGameInstance(groupId); // 确认我们操作的是最新的游戏实例
    if (!game || game.gameState.status !== 'day_vote') return
    game.gameState.deadline = null
    await this.sendSystemGroupMsg(groupId, "投票时间结束，正在计票...")

    const result = game.processVotes() // 结算投票

    if (result.playerKicked) {
      game.gameState.recentlyDeceased = [result.playerKicked];
    } else {
      game.gameState.recentlyDeceased = [];
    }

    // 如果白痴翻牌，需要额外保存玩家数据
    if (result.idiotRevealed) {
      await this.saveGameField(groupId, game, 'players'); // 保存玩家状态（包括白痴标签）
      console.log(`[${PLUGIN_NAME}] [DEBUG] Idiot revealed, saved player data for group ${groupId}`);
    }

    await this.saveGameAll(groupId, game) // 保存最新游戏状态
    await this.sendSystemGroupMsg(groupId, result.summary) // 公布投票摘要

    const playerKicked = result.playerKicked;

    if (result.gameEnded) {
      await this.endGameFlow(groupId, game, result.winner);
    } else if (playerKicked && playerKicked.userId === game.gameState.sheriffUserId) {
      // 如果被票出去的是警长，优先处理警徽移交
      game.gameState.lastStableStatus = game.gameState.status;
      await this.startSheriffPassBadgePhase(groupId, game, playerKicked.userId);
    } else if (result.needsHunterShoot) {
      game.gameState.lastStableStatus = game.gameState.status;
      await this.startHunterShootPhase(groupId, game);
    } else if (result.needsWolfKingClaw) {
      await this.startWolfKingClawPhase(groupId, game);
    } else {
      // 如果没有其他特殊事件，就进入夜晚
      await this.transitionToNextPhase(groupId, game, 'night_phase_1');
    }
  }

  /**
   * 开始猎人开枪阶段。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   * @returns {Promise<void>}
   */
  async startHunterShootPhase(groupId, game) {
    if (!game || game.gameState.status !== 'hunter_shooting' || !game.gameState.hunterNeedsToShoot) return
    const hunterUserId = game.gameState.hunterNeedsToShoot
    game.gameState.deadline = Date.now() + this.HUNTER_SHOOT_DURATION // 设置截止时间
    await redis.zAdd(DEADLINE_KEY, [{ score: game.gameState.deadline, value: String(groupId) }]) // 添加到截止时间ZSET
    await this.saveGameField(groupId, game, 'gameState')

    const hunterInfo = game.getPlayerInfo(hunterUserId)
    const alivePlayerList = game.getAlivePlayerList()
    await this.sendSystemGroupMsg(groupId, `${hunterInfo} 是猎人！临死前可以选择开枪带走一人！\n你有 ${this.HUNTER_SHOOT_DURATION / 1000} 秒时间。\n存活玩家：\n${alivePlayerList}`)
    await this.sendDirectMessage(hunterUserId, `你是猎人，请开枪！\n发送 #开枪 [编号]\n你有 ${this.HUNTER_SHOOT_DURATION / 1000} 秒时间。\n${alivePlayerList}`, groupId)
  }

  /**
   * 处理猎人开枪阶段结束（超时或未开枪）。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   * @returns {Promise<void>}
   */
  async processHunterShootEnd(groupId, game) {
    if (!game || game.gameState.status !== 'hunter_shooting') return

    game.gameState.deadline = null // 清除计时器
    await redis.zRem(DEADLINE_KEY, String(groupId));

    const hunterInfo = game.getPlayerInfo(game.gameState.hunterNeedsToShoot)
    await this.sendSystemGroupMsg(groupId, `猎人 ${hunterInfo} 选择不开枪（或超时）。`)

    const gameStatus = game.checkGameStatus()
    if (gameStatus.isEnd) {
      await this.endGameFlow(groupId, game, gameStatus.winner);
    } else {
      game.gameState.status = 'day_speak'; // 回到白天发言阶段
      await this.saveGameAll(groupId, game)
      await this.transitionToNextPhase(groupId, game, 'day_speak')
    }
  }

  /**
   * 开始狼王发动技能阶段。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   * @param {boolean} [isWhiteWolfKing=false] - 是否为白狼王自爆触发。
   * @returns {Promise<void>}
   */
  async startWolfKingClawPhase(groupId, game, isWhiteWolfKing = false) {
    if (!game || (game.gameState.status !== 'wolf_king_clawing' && !isWhiteWolfKing) || !game.gameState.wolfKingNeedsToClaw) return;

    const wolfKingUserId = game.gameState.wolfKingNeedsToClaw;
    game.gameState.deadline = Date.now() + this.WOLF_KING_CLAW_DURATION; // 设置截止时间
    await redis.zAdd(DEADLINE_KEY, [{ score: game.gameState.deadline, value: String(groupId) }]); // 添加到截止时间ZSET
    await this.saveGameField(groupId, game, 'gameState');

    const wolfKingInfo = game.getPlayerInfo(wolfKingUserId);
    const alivePlayerList = game.getAlivePlayerList();
    const promptMsg = isWhiteWolfKing ?
      `白狼王 ${wolfKingInfo} 自爆了！请选择一名玩家带走！` :
      `${wolfKingInfo} 是狼王！临死前可以选择发动技能带走一人！`;

    await this.sendSystemGroupMsg(groupId, `${promptMsg}\n你有 ${this.WOLF_KING_CLAW_DURATION / 1000} 秒时间。\n存活玩家：\n${alivePlayerList}`);
    await this.sendDirectMessage(wolfKingUserId, `你是${isWhiteWolfKing ? '白狼王' : '狼王'}，请发动技能！\n发送 #狼爪 [编号]\n你有 ${this.WOLF_KING_CLAW_DURATION / 1000} 秒时间。\n${alivePlayerList}`, groupId);
  }

  /**
   * 处理狼王发动技能阶段结束（超时或未发动）。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   * @returns {Promise<void>}
   */
  async processWolfKingClawEnd(groupId, game) {
    if (!game || game.gameState.status !== 'wolf_king_clawing') return;

    game.gameState.deadline = null; // 清除计时器
    await redis.zRem(DEADLINE_KEY, String(groupId));

    const wolfKingInfo = game.getPlayerInfo(game.gameState.wolfKingNeedsToClaw);
    await this.sendSystemGroupMsg(groupId, `狼王 ${wolfKingInfo} 选择不发动技能（或超时）。`);

    // 记录事件
    game.gameState.eventLog.push({
      day: game.gameState.currentDay,
      phase: game.gameState.currentPhase === 'DAY' ? 'day' : 'night',
      type: 'WOLF_KING_CLAW_TIMEOUT',
      actor: wolfKingInfo
    });

    const gameStatus = game.checkGameStatus();
    if (gameStatus.isEnd) {
      await this.endGameFlow(groupId, game, gameStatus.winner);
    } else {
      game.gameState.status = 'night_phase_1'; // 进入夜晚第一阶段
      await this.saveGameAll(groupId, game);
      await this.transitionToNextPhase(groupId, game, 'night_phase_1');
    }
  }

  /**
   * 转换到下一个游戏阶段。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   * @param {string} nextStatus - 明确指定要进入的下一个状态。
   * @returns {Promise<void>}
   */
  async transitionToNextPhase(groupId, game, nextStatus) { // <-- 增加一个参数
    if (!game || !nextStatus || game.gameState.status === 'ended') return;

    console.log(`[${PLUGIN_NAME}] 状态转换: ${game.gameState.status} -> ${nextStatus} (群: ${groupId})`);

    // 直接更新游戏状态
    game.gameState.status = nextStatus;

    // 根据要进入的下一个状态，调用对应的开始方法
    switch (nextStatus) {
      case 'night_phase_1':
        await this.startNightPhase(groupId, game);
        break;
      case 'day_speak':
        await this.startDayPhase(groupId, game);
        break;
      case 'day_vote':
        await this.startVotingPhase(groupId, game);
        break;

      // 把警长流程也加进来，虽然它们不是被这样调用的
      case 'sheriff_election_signup':
        await this.startSheriffElectionPhase(groupId, game);
        break;
      case 'sheriff_speech':
        await this.startSheriffSpeechPhase(groupId, game);
        break;
      case 'sheriff_vote':
        await this.startSheriffVotePhase(groupId, game);
        break;

      default:
        console.warn(`[${PLUGIN_NAME}] 未知或非自动转换状态: ${nextStatus}`);
    }
  }

  /**
   * 在死亡相关事件（猎人开枪、警徽移交等）处理完毕后，继续游戏流程。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   */
  async continueAfterDeathEvent(groupId, game) {
    // 1. 清理可能存在的计时器和deadline
    this.clearPhaseTimer(groupId);
    game.gameState.deadline = null;
    await redis.zRem(DEADLINE_KEY, String(groupId));

    // 2. 检查游戏是否结束
    const gameStatus = game.checkGameStatus();
    if (gameStatus.isEnd) {
      // 如果游戏结束，则直接走结束流程
      await this.endGameFlow(groupId, game, gameStatus.winner);
      return;
    }
    // 3. 如果游戏没结束，判断下一步该去哪
    let nextStatus = '';
    switch (game.gameState.lastStableStatus) {
      case 'night_phase_2':
        // 晚上死人，下一步是白天
        // 但我们还要考虑第一天警长竞选的情况
        if (game.gameState.currentDay === 1 && game.gameState.hasSheriff && !game.gameState.sheriffUserId) {
          await this.startSheriffElectionPhase(groupId, game);
        } else {
          await this.transitionToNextPhase(groupId, game, 'day_speak');
        }
        break;

      case 'day_vote':
        // 白天死人，放逐遗言
        await this.transitionToNextPhase(groupId, game, 'day_speak');
        break;

      default:
        // 如果没有上一个状态记录（作为保险），默认进入夜晚
        console.warn(`[${PLUGIN_NAME}] 无法确定上一个稳定状态，默认进入夜晚。`);
        await this.transitionToNextPhase(groupId, game, 'night_phase_1');
        break;
    }
  }

  /**
   * 结束游戏流程，包括发送战报、公布身份和清理数据。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   * @param {string} winner - 获胜阵营。
   * @returns {Promise<void>}
   */
  async endGameFlow(groupId, game, winner) {
    console.log(`[${PLUGIN_NAME}] [DEBUG] endGameFlow - Game ending for group ${groupId}. Winner: ${winner}`);
    const gameSummary = this.generateGameSummary(game); // 生成详细战报
    console.log(`[${PLUGIN_NAME}] [DEBUG] endGameFlow - Generated game summary:\n`, gameSummary);

    const finalRoles = "--- 最终身份公布 ---\n" + game.getFinalRoles(); // 公布最终身份
    console.log(`[${PLUGIN_NAME}] [DEBUG] endGameFlow - Generated final roles:\n`, finalRoles);

    const finalMessage = `游戏结束！${winner} 阵营获胜！\n\n` + gameSummary + "\n\n" + finalRoles; // 组合消息
    console.log(`[${PLUGIN_NAME}] [DEBUG] endGameFlow - Final message to send:\n`, finalMessage);

    await this.sendSystemGroupMsg(groupId, finalMessage); // 发送组合消息

    if (game.gameState.hasPermission) {
      await this.unmuteAllPlayers(groupId, game, false); // 解禁所有玩家
    }

    await this.deleteGame(groupId); // 删除游戏数据
    console.log(`[${PLUGIN_NAME}] [DEBUG] endGameFlow - Game data deleted for group ${groupId}.`);
  }

  /**
   * 定时检查所有游戏的截止时间，处理超时事件。
   * @returns {Promise<void>}
   */
  async checkAllGameTimers() {
    try {
      // 从Redis的ZSET中获取所有已过期的游戏ID
      const expiredGameIds = await redis.zRangeByScore(DEADLINE_KEY, '-inf', Date.now())
      if (!expiredGameIds || expiredGameIds.length === 0) return

      for (const groupId of expiredGameIds) {
        // 尝试从ZSET中移除，如果移除成功（说明是第一次处理该超时），则继续处理
        const removedCount = await redis.zRem(DEADLINE_KEY, String(groupId));
        if (removedCount === 0) {
          continue; // 如果已经被其他进程处理，则跳过
        }

        const game = await this.getGameInstance(groupId)
        if (!game || !game.gameState.isRunning) {
          continue // 游戏不存在或未运行，则跳过
        }

        console.log(`[${PLUGIN_NAME}] [轮询] 检测到 ${game.gameState.status} 超时 (${groupId})`)

        // 根据当前游戏状态调用相应的超时处理函数
        switch (game.gameState.status) {
          case 'night_phase_1':
            await this.transitionToWitchPhase(groupId, game); // 狼人阶段超时，进入女巫阶段
            break;
          case 'night_phase_2':
            await this.processNightEnd(groupId, game); // 女巫阶段超时，进行夜晚最终结算
            break;
          case 'sheriff_election_signup':
            await this.processSheriffSignupEnd(groupId, game);
            break;
          case 'day_speak':
          case 'sheriff_speech':
            await this.processSpeechTimeout(groupId, game); // 直接调用，不再传递第二个参数
            break;
          case 'sheriff_vote':
            await this.processSheriffVoteEnd(groupId, game);
            break;
          case 'sheriff_pass_badge':
            // 如果超时，视为撕毁警徽
            await this.sendSystemGroupMsg(groupId, "警长移交警徽超时，警徽被撕毁！");
            game.gameState.sheriffUserId = null; // 警徽没了
            await this.saveGameAll(groupId, game);
            // 调用收尾方法继续流程
            await this.continueAfterDeathEvent(groupId, game);
            break;
          case 'day_vote': await this.processVoteEnd(groupId, game); break
          case 'hunter_shooting': await this.processHunterShootEnd(groupId, game); break
          case 'wolf_king_clawing': await this.processWolfKingClawEnd(groupId, game); break
        }
      }
    } catch (error) {
      console.error(`[${PLUGIN_NAME}] 轮询检查计时器时发生错误:`, error)
    }
  }

  /**
   * 查找用户当前参与的活跃游戏。
   * @param {string} userId - 用户ID。
   * @param {boolean} [includeDead=false] - 是否包含已死亡的玩家（用于猎人/狼王技能）。
   * @returns {Promise<object|null>} 包含群组ID和游戏实例的对象，如果未找到则返回null。
   */
  async findUserActiveGame(userId, includeDead = false) {
    try {
      // 优先从内存缓存中查找
      let groupId = this.userToGroupCache.get(userId);

      // 如果内存缓存中没有，则从Redis中查找
      if (!groupId) {
        groupId = await redis.get(`${USER_GROUP_KEY_PREFIX}${userId}`);
        if (groupId) {
          this.userToGroupCache.set(userId, groupId); // 缓存到内存
        }
      }

      if (groupId) {
        const game = await this.getGameInstance(groupId);
        // 检查玩家是否在游戏中且是否存活（除非includeDead为true）
        const playerExists = game && game.players.some(p => p.userId === userId && (includeDead || p.isAlive));
        if (playerExists) {
          return { groupId: groupId, instance: game };
        }
      }
    } catch (error) {
      console.error(`[${PLUGIN_NAME}] 查找用户游戏时出错:`, error);
    }
    return null;
  }

  // --- 辅助函数 (QQ消息发送和禁言) ---

  /**
   * 向指定群组发送系统消息。
   * @param {string} groupId - 群组ID。
   * @param {string|Array<object>} msg - 要发送的消息内容，可以是字符串或segment数组。
   * @returns {Promise<void>}
   */
  async sendSystemGroupMsg(groupId, msg) {
    if (!groupId || !msg) return
    try { await Bot.pickGroup(groupId).sendMsg(msg) }
    catch (err) { console.error(`[${PLUGIN_NAME}] 发送系统群消息失败 (${groupId}):`, err) }
  }

  /**
   * 向指定用户发送私聊消息。
   * @param {string} userId - 用户ID。
   * @param {string|Array<object>} msg - 要发送的消息内容。
   * @param {string} [sourceGroupId=null] - 消息来源群组ID，用于私聊失败时通知群组。
   * @param {boolean} [notifyGroupOnError=true] - 私聊失败时是否通知来源群组。
   * @returns {Promise<boolean>} 是否成功发送。
   */
  async sendDirectMessage(userId, msg, sourceGroupId = null, notifyGroupOnError = true) {
    if (!userId || !msg) return false
    try {
      await Bot.pickUser(userId).sendMsg(msg)
      return true
    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 发送私聊消息失败 (userId: ${userId}):`, err)
      if (sourceGroupId && notifyGroupOnError) {
        await this.sendSystemGroupMsg(sourceGroupId, `[!] 无法向玩家 QQ:${userId} 发送私聊消息，请检查好友关系或机器人是否被屏蔽。`)
      }
      return false
    }
  }

  /**
   * 禁言或解禁指定玩家。
   * @param {string} groupId - 群组ID。
   * @param {string} userId - 玩家用户ID。
   * @param {number} duration - 禁言时长（秒），0表示解禁。
   * @returns {Promise<void>}
   */
  async mutePlayer(groupId, userId, duration) {
    try {
      const group = Bot.pickGroup(groupId);
      await group.muteMember(userId, duration);
    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 禁言/解禁玩家 ${userId} 失败 (群: ${groupId}):`, err);
    }
  }

  /**
   * 禁言群组内所有玩家。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   * @param {boolean} [onlyAlive=true] - 是否只禁言存活玩家。
   * @param {number} [duration=3600] - 禁言时长（秒）。
   * @returns {Promise<void>}
   */
  async muteAllPlayers(groupId, game, onlyAlive = true, duration = 3600) {
    const playersToMute = onlyAlive ? game.players.filter(p => p.isAlive) : game.players;
    for (const player of playersToMute) {
      await this.mutePlayer(groupId, player.userId, duration);
      await new Promise(resolve => setTimeout(resolve, 200)); // 防止频率过快
    }
  }

  /**
   * 解禁群组内所有玩家。
   * @param {string} groupId - 群组ID。
   * @param {WerewolfGame} game - 游戏实例。
   * @param {boolean} [onlyAlive=false] - 是否只解禁存活的玩家。
   * @returns {Promise<void>}
   */
  async unmuteAllPlayers(groupId, game, onlyAlive = false) {
    // 根据 onlyAlive 标志决定要解禁的玩家列表
    const playersToUnmute = onlyAlive ? game.players.filter(p => p.isAlive) : game.players;

    // 如果是解禁所有参与者，也包括已死亡的，以确保游戏结束后所有人都解除禁言
    const logMessage = onlyAlive ? '存活玩家' : '所有玩家';
    console.log(`[${PLUGIN_NAME}] [解禁] 正在解禁 ${logMessage} (群: ${groupId})`);

    for (const player of playersToUnmute) {
      await this.mutePlayer(groupId, player.userId, 0); // duration为0表示解禁
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}
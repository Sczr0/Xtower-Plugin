import GameDataManager from '../infra/GameDataManager.js'
import { ROLES, TAGS, GAME_PRESETS, PLUGIN_NAME, USER_GROUP_KEY_PREFIX, GAME_DATA_EXPIRATION } from '../constants.js'
import createRoleActions from './roleActions.js'
import { resolveNightActions } from './NightResolver.js'
import { resolveVotes } from './VoteResolver.js'

/**
 * @class WerewolfGame
 * @description 狼人杀游戏的核心逻辑类。
 * 职责：管理游戏状态、玩家、角色分配、游戏流程（夜晚、白天、投票等）和角色专属行为。
 */
export default class WerewolfGame {
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
      lastProtectedId: null,   // 守卫上晚守护的目标ID，用于防止连守
      hunterNeedsToShoot: null,// 死亡猎人ID，等待开枪
      wolfKingNeedsToClaw: null, // 死亡狼王ID，等待发动技能
      currentSpeakerUserId: null, // 当前发言玩家ID
      speakingOrder: [],       // 白天发言顺序
      currentSpeakerOrderIndex: -1, // 当前发言玩家在顺序中的索引
      votes: {},               // 投票记录
      eventLog: [],            // 游戏事件日志
      deadline: null,          // 当前阶段的截止时间戳
      hasPermission: false,    // 机器人是否有禁言/解禁权限
    }
    this.potions = initialData.potions || { save: true, kill: true } // 女巫药剂状态
    this.userGroupMap = initialData.userGroupMap || {} // 用户ID到群组ID的映射
    this.addPlayerPromise = Promise.resolve() // 用于串行化玩家加入操作
    this._roleActions = createRoleActions()
  }

  // 角色专属行为映射表已抽离到 core/roleActions.js

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
      wolfKingNeedsToClaw: null,
      currentSpeakerUserId: null, speakingOrder: [], currentSpeakerOrderIndex: -1, votes: {},
      eventLog: [],
      deadline: null,
      hasPermission: false,
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
    this.addPlayerPromise = executionPromise.catch(() => {})

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
      // --- FIX START ---
      // 核心修复：移除之前的行动记录，确保每个玩家每晚只有一个最终行动被记录
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
   * 逻辑已抽离到 core/NightResolver.js。
   */
  processNightActions() {
    return resolveNightActions(this)
  }

  // 已迁移的旧实现，保留用于对照与回归验证。
  processNightActionsLegacy() {
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
  
  // 添加调试日志：打印所有玩家的用户ID
  console.log(`[${PLUGIN_NAME}] [DEBUG] processNightActions - All players:`, this.players.map(p => `${p.nickname}(${p.tempId}) userId: ${p.userId} (type: ${typeof p.userId})`));
  
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
      console.log(`[${PLUGIN_NAME}] [DEBUG] Checking player ${this.getPlayerInfo(player.userId)}, tags:`, player.tags);
      
      if (!player.tags.includes(TAGS.DYING)) {
          console.log(`[${PLUGIN_NAME}] [DEBUG] Player ${this.getPlayerInfo(player.userId)} is alive and not marked as DYING.`);
          return;
      }

      console.log(`[${PLUGIN_NAME}] [DEBUG] Player ${this.getPlayerInfo(player.userId)} is marked as DYING. Checking protection/save status.`);
      let shouldDie = true;
      let causeOfDeath = 'UNKNOWN';

      const isGuarded = player.tags.includes(TAGS.GUARDED);
      const isSavedByWitch = player.tags.includes(TAGS.SAVED_BY_WITCH);
      const isPoisoned = player.tags.includes(TAGS.POISONED_BY_WITCH);

      console.log(`[${PLUGIN_NAME}] [DEBUG] Player ${this.getPlayerInfo(player.userId)}: isGuarded=${isGuarded}, isSavedByWitch=${isSavedByWitch}, isPoisoned=${isPoisoned}`);

      if (isPoisoned) {
          causeOfDeath = 'WITCH';
          shouldDie = true;
          console.log(`[${PLUGIN_NAME}] [DEBUG] Player ${this.getPlayerInfo(player.userId)} was poisoned by Witch.`);
      } else {
          if (isGuarded && isSavedByWitch) {
              causeOfDeath = 'GUARD_WITCH_CONFLICT';
              shouldDie = true;
              console.log(`[${PLUGIN_NAME}] [DEBUG] Player ${this.getPlayerInfo(player.userId)} was wolf-attacked, guarded AND saved by Witch (同守同救).`);
          } else if (isGuarded || isSavedByWitch) {
              shouldDie = false;
              causeOfDeath = isGuarded ? 'GUARDED' : 'SAVED_BY_WITCH';
              console.log(`[${PLUGIN_NAME}] [DEBUG] Player ${this.getPlayerInfo(player.userId)} was wolf-attacked and ${causeOfDeath}, survived.`);
          } else {
              causeOfDeath = 'WEREWOLF';
              shouldDie = true;
              console.log(`[${PLUGIN_NAME}] [DEBUG] Player ${this.getPlayerInfo(player.userId)} was wolf-attacked and NOT protected/saved, will die.`);
          }
      }

      if (shouldDie) {
          deathCauses[player.userId] = causeOfDeath;
          actualDeaths.push(player);
          console.log(`[${PLUGIN_NAME}] [DEBUG] Player ${this.getPlayerInfo(player.userId)} added to actualDeaths list. Cause: ${causeOfDeath}`);
      } else {
          console.log(`[${PLUGIN_NAME}] [DEBUG] Player ${this.getPlayerInfo(player.userId)} will NOT die.`);
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
      return { success: true, summary: finalSummary.join('\n'), gameEnded: false, needsHunterShoot: true };
  }

  const deadWolfKing = actualDeaths.find(p => p.role === ROLES.WOLF_KING);
  if (deadWolfKing) {
      this.gameState.status = 'wolf_king_clawing';
      this.gameState.wolfKingNeedsToClaw = deadWolfKing.userId;
      this.gameState.currentPhase = 'NIGHT_RESULT';
      actualDeaths.forEach(p => { p.isAlive = false; });
      return { success: true, summary: finalSummary.join('\n'), gameEnded: false, needsWolfKingClaw: true };
  }

  actualDeaths.forEach(p => { p.isAlive = false; });

  const gameStatus = this.checkGameStatus();
  if (gameStatus.isEnd) {
      this.endGame();
      return { 
          success: true, 
          summary: finalSummary.join('\n'),
          gameEnded: true, 
          winner: gameStatus.winner, 
          finalRoles: this.getFinalRoles(),
          needsHunterShoot: false 
      };
  } else {
      this.gameState.status = 'day_speak';
      return { 
          success: true, 
          summary: finalSummary.join('\n'), 
          gameEnded: false, 
          needsHunterShoot: false 
      };
  }
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
   * 移动到下一个发言玩家。
   * @returns {string|null} 下一个发言玩家的ID，如果没有则返回null。
   */
  moveToNextSpeaker() {
    if (this.gameState.currentSpeakerOrderIndex >= this.gameState.speakingOrder.length - 1) {
      this.gameState.currentSpeakerUserId = null;
      return null;
    }
    this.gameState.currentSpeakerOrderIndex++;
    const nextSpeakerId = this.gameState.speakingOrder[this.gameState.currentSpeakerOrderIndex];
    this.gameState.currentSpeakerUserId = nextSpeakerId;
    return nextSpeakerId;
  }

  /**
   * 结算白天投票结果。
   * 逻辑已抽离到 core/VoteResolver.js。
   */
  processVotes() {
    return resolveVotes(this)
  }

  // 已迁移的旧实现，保留用于对照与回归验证。
  processVotesLegacy() {
    if (this.gameState.status !== 'day_vote') return { message: '非投票阶段，无法计票' }

    const currentDay = this.gameState.currentDay;
    const logEvent = (event) => this.gameState.eventLog.push({ day: currentDay, phase: 'day', ...event });

    const voteCounts = {} // 记录每个玩家获得的票数
    const voteDetails = {} // 记录每个玩家被谁投票
    this.players.filter(p => p.isAlive).forEach(voter => {
      const targetTempId = this.gameState.votes[voter.userId]
      if (targetTempId) {
        voteCounts[targetTempId] = (voteCounts[targetTempId] || 0) + 1
        if (!voteDetails[targetTempId]) voteDetails[targetTempId] = []
        voteDetails[targetTempId].push(`${voter.nickname}(${voter.tempId}号)`)
      } else { // 弃票
        voteCounts['弃票'] = (voteCounts['弃票'] || 0) + 1
        if (!voteDetails['弃票']) voteDetails['弃票'] = []
        voteDetails['弃票'].push(`${voter.nickname}(${voter.tempId}号)`)
      }
    })

    let voteSummary = ["投票结果："]
    for (const targetTempId in voteCounts) {
      if (targetTempId === '弃票') continue // 跳过弃票的统计
      const targetPlayer = this.players.find(p => p.tempId === targetTempId)
      if (targetPlayer) voteSummary.push(`${targetPlayer.nickname}(${targetTempId}号): ${voteCounts[targetTempId]}票 (${(voteDetails[targetTempId] || []).join(', ')})`)
    }
    if (voteCounts['弃票']) voteSummary.push(`弃票: ${voteCounts['弃票']}票 (${(voteDetails['弃票'] || []).join(', ')})`)

    let maxVotes = 0
    let tiedPlayers = [] // 记录平票的玩家
    for (const targetTempId in voteCounts) {
      if (targetTempId === '弃票') continue
      if (voteCounts[targetTempId] > maxVotes) {
        maxVotes = voteCounts[targetTempId]
        tiedPlayers = [targetTempId]
      } else if (voteCounts[targetTempId] === maxVotes && maxVotes > 0) {
        tiedPlayers.push(targetTempId)
      }
    }

    this.gameState.votes = {} // 清空投票记录
    if (tiedPlayers.length === 1) { // 有唯一被投出玩家
    const eliminatedPlayer = this.players.find(p => p.tempId === tiedPlayers[0])
    if (eliminatedPlayer) {
      const voters = voteDetails[eliminatedPlayer.tempId] || [];
      logEvent({ type: 'VOTE_OUT', target: this.getPlayerInfo(eliminatedPlayer.userId), voters: voters });
      
      if (eliminatedPlayer.role === ROLES.IDIOT) { // 白痴被投出
          eliminatedPlayer.tags.push(TAGS.REVEALED_IDIOT);
          voteSummary.push(`${eliminatedPlayer.nickname}(${eliminatedPlayer.tempId}号) 被投票出局，但他/她亮出了【白痴】的身份！他/她不会死亡，但将失去后续的投票权。`);
          // 不在这里保存数据，而是在返回结果中标记需要保存
          return { 
            success: true, 
            summary: voteSummary.join('\n'), 
            gameEnded: false, 
            idiotRevealed: true, // 新增标记
            revealedIdiotId: eliminatedPlayer.userId 
          };
      } else { // 其他角色被投出
          eliminatedPlayer.isAlive = false
          voteSummary.push(`${eliminatedPlayer.nickname} (${eliminatedPlayer.tempId}号) 被投票出局。`)

          if (eliminatedPlayer.role === ROLES.HUNTER) { // 猎人被投出
            this.gameState.status = 'hunter_shooting'
            this.gameState.hunterNeedsToShoot = eliminatedPlayer.userId
            this.gameState.currentPhase = 'DAY' // 标记为白天阶段的开枪
            return { success: true, summary: voteSummary.join('\n'), gameEnded: false, needsHunterShoot: true }
          }
          if (eliminatedPlayer.role === ROLES.WOLF_KING) { // 狼王被投出
              this.gameState.status = 'wolf_king_clawing';
              this.gameState.wolfKingNeedsToClaw = eliminatedPlayer.userId;
              this.gameState.currentPhase = 'DAY'; // 标记为白天阶段的狼王技能
              return { success: true, summary: voteSummary.join('\n'), gameEnded: false, needsWolfKingClaw: true };
          }
      }
    }
  } else if (tiedPlayers.length > 1) { // 平票
    const sortedTiedPlayers = [...tiedPlayers].sort();
    voteSummary.push(`出现平票 (${sortedTiedPlayers.map(id => `${id}号`).join(', ')})，本轮无人出局。`);
  } else { // 无人被投票或全部弃票
    voteSummary.push("所有人都弃票或投票无效，本轮无人出局。")
  }

  const gameStatus = this.checkGameStatus()
  if (gameStatus.isEnd) {
    this.endGame(gameStatus.winner)
    return { success: true, summary: voteSummary.join('\n'), gameEnded: true, winner: gameStatus.winner, finalRoles: this.getFinalRoles() }
  } else {
    this.gameState.status = 'night_phase_1' // 进入夜晚第一阶段
    return { success: true, summary: voteSummary.join('\n'), gameEnded: false }
    }
  }
  /**
   * 获取狼人袭击的最终目标ID。
   * @returns {string|null} 被袭击玩家的用户ID，如果没有则返回null。
   */
  getWerewolfAttackTargetId() {
    // 添加的诊断日志 - START
    console.log(`[${PLUGIN_NAME}] [DEBUG] getWerewolfAttackTargetId - Received nightActions for WEREWOLF:`, JSON.stringify(this.gameState.nightActions[ROLES.WEREWOLF] || {}, null, 2));
    // 添加的诊断日志 - END
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
      if (aliveWerewolves >= aliveGoodGuys) {
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

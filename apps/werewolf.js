const PLUGIN_NAME = '狼人杀';

const SELF_DESTRUCT_ENABLED = true; // 硬编码的自爆功能开关
const AUTO_MUTE_ENABLED = true; // 自动禁言功能开关

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

const TAGS = {
  GUARDED: 'GUARDED',                 // 被守护
  DYING: 'DYING',                     // 濒死状态 (被狼人刀或女巫毒)
  SAVED_BY_WITCH: 'SAVED_BY_WITCH',   // 被女巫解药救
  POISONED_BY_WITCH: 'POISONED_BY_WITCH', // 被女巫毒药毒
  REVEALED_IDIOT: 'REVEALED_IDIOT',   // 已翻牌的白痴
  WOLF_KING_CLAW_PENDING: 'WOLF_KING_CLAW_PENDING', // 狼王等待发动技能
};

// --- 数据存储与管理---
const GAME_KEY_PREFIX = 'werewolf:game:'
const USER_GROUP_KEY_PREFIX = 'werewolf:user_to_group:'
const DEADLINE_KEY = 'werewolf:deadlines'
const GAME_DATA_EXPIRATION = 6 * 60 * 60 // 6小时后自动过期

class GameDataManager {
  static getRedisKey(groupId) {
    return `${GAME_KEY_PREFIX}${groupId}`
  }

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
      await redis.del(key)
      return null
    }
  }

  static async saveAll(groupId, data) {
    const key = this.getRedisKey(groupId)
    try {
      const multi = redis.multi(); // 获取一个事务对象

      multi.hSet(key, 'players', JSON.stringify(data.players || []));
      multi.hSet(key, 'roles', JSON.stringify(data.roles || {}));
      multi.hSet(key, 'gameState', JSON.stringify(data.gameState || {}));
      multi.hSet(key, 'potions', JSON.stringify(data.potions || {}));
      multi.hSet(key, 'userGroupMap', JSON.stringify(data.userGroupMap || {}));
      multi.expire(key, GAME_DATA_EXPIRATION);

      await multi.exec(); // 执行所有排队的命令

    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 全量保存游戏数据到 Redis 失败 (${groupId}):`, err)
    }
  }

  static async saveField(groupId, fieldName, data) {
    const key = this.getRedisKey(groupId)
    try {
      await redis.hSet(key, fieldName, JSON.stringify(data))
      await redis.expire(key, GAME_DATA_EXPIRATION)
    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 更新游戏字段 [${fieldName}] 到 Redis 失败 (${groupId}):`, err)
    }
  }

  static async delete(groupId) {
    const key = this.getRedisKey(groupId)
    try {
      await redis.del(key)
    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 从 Redis 删除游戏数据失败 (${groupId}):`, err)
    }
  }

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

// --- 游戏超时清理器 ---
class GameCleaner {
  static cleanupTimers = new Map()
  static CLEANUP_DELAY = 2 * 60 * 60 * 1000

  static registerGame(groupId, instance) {
    this.cleanupGame(groupId)
    const timer = setTimeout(async () => {
      console.log(`[${PLUGIN_NAME}] [自动清理] 开始检查超时游戏 (${groupId})...`)
      const gameData = await GameDataManager.load(groupId)
      if (gameData && gameData.gameState && gameData.gameState.isRunning) {
        console.log(`[${PLUGIN_NAME}] [自动清理] 强制结束2小时无活动的游戏 (${groupId})...`)
        const fakeEvent = {
          group_id: groupId,
          user_id: gameData.hostUserId,
          reply: (msg) => instance.sendSystemGroupMsg(groupId, `[自动清理] ${msg}`),
          sender: { card: '系统', nickname: '系统' },
          isMaster: true,
          member: { is_admin: true }
        }
        await instance.forceEndGame(fakeEvent, true)
      }
      this.cleanupTimers.delete(groupId)
    }, this.CLEANUP_DELAY)
    this.cleanupTimers.set(groupId, timer)
  }

  static cleanupGame(groupId) {
    const timer = this.cleanupTimers.get(groupId)
    if (timer) {
      clearTimeout(timer)
      this.cleanupTimers.delete(groupId)
    }
  }

  static cleanupAll() {
    for (const [, timer] of this.cleanupTimers) clearTimeout(timer)
    this.cleanupTimers.clear()
  }
}

// --- 游戏核心逻辑  ---
class WerewolfGame {
  constructor(initialData = {}) {
    this.players = initialData.players || []
    this.roles = initialData.roles || { [ROLES.WEREWOLF]: '狼人', [ROLES.VILLAGER]: '村民', [ROLES.SEER]: '预言家', [ROLES.WITCH]: '女巫', [ROLES.HUNTER]: '猎人', [ROLES.GUARD]: '守卫', [ROLES.WOLF_KING]: '狼王', [ROLES.WHITE_WOLF_KING]: '白狼王', [ROLES.IDIOT]: '白痴' }
    this.gameState = initialData.gameState || {
      isRunning: false,
      currentPhase: null,
      currentDay: 0,
      status: 'waiting',
      hostUserId: null,
      nightActions: {},
      lastProtectedId: null,
      hunterNeedsToShoot: null,
      wolfKingNeedsToClaw: null, // 新增：待发动技能的狼王ID
      currentSpeakerUserId: null,
      speakingOrder: [],
      currentSpeakerOrderIndex: -1,
      votes: {},
      eventLog: [], // 确保 eventLog 初始化
      deadline: null,
      hasPermission: false, // 新增：机器人是否有权限
    }
    this.potions = initialData.potions || { save: true, kill: true }
    this.userGroupMap = initialData.userGroupMap || {}
    this.addPlayerPromise = Promise.resolve()
  }

  async initGame(hostUserId, hostNickname, groupId) {
    this.gameState = {
      isRunning: false, currentPhase: null, currentDay: 0, status: 'waiting',
      hostUserId: hostUserId, nightActions: {}, lastProtectedId: null, hunterNeedsToShoot: null,
      currentSpeakerUserId: null, speakingOrder: [], currentSpeakerOrderIndex: -1, votes: {},
      eventLog: [],
      deadline: null
    };
    this.players = [];
    this.potions = { save: true, kill: true };
    this.userGroupMap = {};
    
    await this.addPlayer(hostUserId, hostNickname, groupId); 

    return { success: true, message: `狼人杀游戏已创建！你是房主。\n发送 #加入狼人杀 参与游戏。` };
  }
  async addPlayer(userId, nickname, groupId) {
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
      await redis.set(`${USER_GROUP_KEY_PREFIX}${userId}`, groupId, { EX: GAME_DATA_EXPIRATION })
      return { success: true, message: `${nickname} (${player.tempId}号) 加入了游戏。当前人数: ${this.players.length}` }
    })

    // 无论成功或失败，都将 promise 链向下传递，以确保下一个调用可以排队
    // 使用 .catch(() => {}) 来处理可能的拒绝，防止 UnhandledPromiseRejectionWarning
    this.addPlayerPromise = executionPromise.catch(() => {})

    return executionPromise
  }

  async removePlayer(userId) {
    const playerIndex = this.players.findIndex(p => p.userId === userId);
    if (playerIndex === -1) {
        return { success: false, message: '你不在游戏中。' };
    }
    if (!['waiting', 'starting'].includes(this.gameState.status)) {
         return { success: false, message: '游戏已经开始，无法退出。请联系房主结束游戏。' };
    }
    const removedPlayer = this.players.splice(playerIndex, 1)[0];
    if (removedPlayer.userId === this.gameState.hostUserId) {
        this.gameState.status = 'ended';
         return { success: true, message: `房主 ${removedPlayer.nickname} 退出了游戏，游戏已解散。`, gameDissolved: true };
    }
    delete this.userGroupMap[userId];
    await redis.del(`${USER_GROUP_KEY_PREFIX}${removedPlayer.userId}`);
    return { success: true, message: `${removedPlayer.nickname} 退出了游戏。当前人数: ${this.players.length}` };
  }

  calculateRoleDistribution() {
    const playerCount = this.players.length;
    let werewolfCount;
    if (playerCount >= 12) werewolfCount = 4;
    else if (playerCount >= 9) werewolfCount = 3;
    else werewolfCount = 2;

    let distribution = { [ROLES.WEREWOLF]: werewolfCount, [ROLES.SEER]: 1, [ROLES.WITCH]: 1, [ROLES.HUNTER]: 1, [ROLES.GUARD]: 1 };
    distribution[ROLES.VILLAGER] = playerCount - Object.values(distribution).reduce((a, b) => a + b, 0);

    if (distribution.VILLAGER < 0) {
        distribution.VILLAGER = 0;
        console.warn(`[${PLUGIN_NAME}] 玩家人数 (${playerCount}) 过少，导致村民数量为负，已调整为0。`);
    }
    
    this.gameState.roleDistribution = distribution;
    return distribution;
  }

  assignRoles(distribution) {
    const playerCount = this.players.length;
    let allRoles = [];
    for (const role in distribution) {
      for (let i = 0; i < distribution[role]; i++) allRoles.push(role)
    }

    if (allRoles.length !== playerCount) {
        return { success: false, message: `角色分配错误：总角色数 ${allRoles.length} 不等于玩家数 ${playerCount}。` };
    }

    allRoles.sort(() => Math.random() - 0.5)
    this.players.forEach((player, index) => { player.role = allRoles[index] })
    return { success: true }
  }

  async prepareGameStart() {
    if (this.players.length < 6) return { success: false, message: '玩家数量不足，至少需要6名玩家。' }
    if (this.gameState.status !== 'waiting') return { success: false, message: '游戏状态不正确。' }
    this.gameState.status = 'starting'
    return { success: true }
  }

  recordNightAction(role, userId, action) {
    if (this.gameState.status !== 'night') return { success: false, message: '当前不是夜晚行动时间。' }
    const currentDay = this.gameState.currentDay;
    const logEvent = (event) => this.gameState.eventLog.push({ day: currentDay, phase: 'night', ...event });
    const player = this.players.find(p => p.userId === userId && p.isAlive)
    if (!player || player.role !== role) return { success: false, message: '无效操作：你的身份或状态不符。' }
    if (!this.gameState.nightActions[role]) this.gameState.nightActions[role] = {}
    let validation = this.validateTarget(action.targetTempId)
    if (!validation.success) return validation
    action.targetUserId = validation.targetPlayer.userId
    if (role === 'WITCH') validation = this.validateWitchAction(player, action)
    if (role === 'GUARD') validation = this.validateGuardAction(action)
    if (!validation.success) return validation
    this.gameState.nightActions[role][userId] = action
    let feedbackMsg = `[狼人杀] 已收到您的行动指令，请等待夜晚结束。`
    if (role === 'SEER') {
      const targetRole = validation.targetPlayer.role;
      const isWerewolf = targetRole === ROLES.WEREWOLF;
      feedbackMsg += `\n[查验结果] ${validation.targetPlayer.nickname}(${validation.targetPlayer.tempId}号) 的身份是 【${isWerewolf ? '狼人' : '好人'}】。`;
      logEvent({
          type: 'SEER_CHECK',
          actor: this.getPlayerInfo(userId),
          target: this.getPlayerInfo(action.targetUserId),
          result: isWerewolf ? ROLES.WEREWOLF : 'GOOD_PERSON'
      });
    }
    return { success: true, message: feedbackMsg }
  }

  validateTarget(targetTempId) {
    const targetPlayer = this.players.find(p => p.tempId === targetTempId && p.isAlive)
    if (!targetPlayer) return { success: false, message: '目标玩家编号无效或玩家已死亡。' }
    return { success: true, targetPlayer: targetPlayer }
  }

  validateWitchAction(witchPlayer, action) {
    if (action.type === 'save' && !this.potions.save) return { success: false, message: '你的解药已经用完了。' }
    if (action.type === 'kill' && !this.potions.kill) return { success: false, message: '你的毒药已经用完了。' }
    if (this.gameState.nightActions['WITCH']?.[witchPlayer.userId]) return { success: false, message: '你今晚已经行动过了。' }
    return { success: true }
  }

  validateGuardAction(action) {
    if (action.targetUserId === this.gameState.lastProtectedId) return { success: false, message: '不能连续两晚守护同一个人。' }
    return { success: true }
  }

  processNightActions() {
    if (this.gameState.status !== 'night') {
      return { message: '非夜晚，无法结算' };
    }

    const currentDay = this.gameState.currentDay;
    const logEvent = (event) => this.gameState.eventLog.push({ day: currentDay, phase: 'night', ...event });

    // 1. 初始化: 清理上一晚的临时标签
    this.players.forEach(p => {
      p.tags = [];
    });

    // --- 阶段一：狼人前行动 (守卫、狼人) ---
    
    // 守卫行动
    const guardAction = Object.values(this.gameState.nightActions[ROLES.GUARD] || {})[0];
    if (guardAction) {
      const guard = this.players.find(p => p.role === ROLES.GUARD && p.isAlive);
      const target = this.players.find(p => p.tempId === guardAction.targetTempId && p.isAlive);
      if (guard && target && target.userId !== this.gameState.lastProtectedId) {
        target.tags.push(TAGS.GUARDED);
        this.gameState.lastProtectedId = target.userId;
        logEvent({ type: 'GUARD_PROTECT', actor: this.getPlayerInfo(guard.userId), target: this.getPlayerInfo(target.userId) });
      } else {
        this.gameState.lastProtectedId = null;
      }
    } else {
      this.gameState.lastProtectedId = null;
    }

    // 狼人行动
    const killedByWerewolfId = this.getWerewolfAttackTargetId();
    if (killedByWerewolfId) {
        const target = this.players.find(p => p.userId === killedByWerewolfId);
        if (target) {
            target.tags.push(TAGS.DYING);
            const werewolfActors = this.players.filter(p => p.role === ROLES.WEREWOLF && p.isAlive).map(p => this.getPlayerInfo(p.userId));
            logEvent({ type: 'WEREWOLF_ATTACK', actors: werewolfActors, target: this.getPlayerInfo(killedByWerewolfId) });
        }
    }

    // --- 阶段二：狼人后行动 (女巫) ---
    const witchAction = Object.values(this.gameState.nightActions[ROLES.WITCH] || {})[0];
    if (witchAction) {
        const witch = this.players.find(p => p.role === ROLES.WITCH && p.isAlive);
        if (witch) {
            const witchInfo = this.getPlayerInfo(witch.userId);
            if (witchAction.type === 'save' && this.potions.save) {
                const target = this.players.find(p => p.tempId === witchAction.targetTempId && p.isAlive);
                if (target) {
                    target.tags.push(TAGS.SAVED_BY_WITCH);
                    this.potions.save = false;
                    logEvent({ type: 'WITCH_SAVE', actor: witchInfo, target: this.getPlayerInfo(target.userId) });
                }
            }
            if (witchAction.type === 'kill' && this.potions.kill) {
                const target = this.players.find(p => p.tempId === witchAction.targetTempId && p.isAlive);
                if (target) {
                    target.tags.push(TAGS.DYING, TAGS.POISONED_BY_WITCH);
                    this.potions.kill = false;
                    logEvent({ type: 'WITCH_KILL', actor: witchInfo, target: this.getPlayerInfo(target.userId) });
                }
            }
        }
    }

    // --- 阶段三：尾判定 ---
    let actualDeaths = [];
    let deathCauses = {};

    this.players.filter(p => p.isAlive && p.tags.includes(TAGS.DYING)).forEach(player => {
        let shouldDie = true;
        let causeOfDeath = 'UNKNOWN';

        const isGuarded = player.tags.includes(TAGS.GUARDED);
        const isSavedByWitch = player.tags.includes(TAGS.SAVED_BY_WITCH);
        const isPoisoned = player.tags.includes(TAGS.POISONED_BY_WITCH);

        if (isPoisoned) {
            causeOfDeath = 'WITCH';
        } else { // 被狼人刀
            if (isGuarded && isSavedByWitch) { // 同守同救，死亡
                causeOfDeath = 'GUARD_WITCH_CONFLICT';
            } 
            else if (isGuarded || isSavedByWitch) { // 被守护或被救，存活
                shouldDie = false;
            } 
            else { // 无人救，死亡
                causeOfDeath = 'WEREWOLF';
            }
        }

        if (shouldDie) {
            deathCauses[player.userId] = causeOfDeath;
            actualDeaths.push(player);
        }
    });

    // --- 阶段四：天亮，结算后续状态 ---
    let finalSummary = ["夜晚结束，现在公布昨晚发生的事情："];
    if (actualDeaths.length > 0) {
        const deathNames = actualDeaths.map(p => `${p.nickname} (${p.tempId}号)`).join('、');
        finalSummary.push(`${deathNames} 昨晚死亡了。`);
    } else {
        finalSummary.push("昨晚是个平安夜。");
    }
    
    this.gameState.nightActions = {}; // 清空当晚行动记录

    const deadHunter = actualDeaths.find(p => p.role === ROLES.HUNTER);
    if (deadHunter && deathCauses[deadHunter.userId] !== 'WITCH') {
        this.gameState.status = 'hunter_shooting';
        this.gameState.hunterNeedsToShoot = deadHunter.userId;
        this.gameState.currentPhase = 'NIGHT_RESULT';
        actualDeaths.filter(p => p.userId !== deadHunter.userId).forEach(p => p.isAlive = false);
        return { success: true, summary: finalSummary.join('\n'), gameEnded: false, needsHunterShoot: true };
    }

    const deadWolfKing = actualDeaths.find(p => p.role === ROLES.WOLF_KING);
    if (deadWolfKing) {
        this.gameState.status = 'wolf_king_clawing';
        this.gameState.wolfKingNeedsToClaw = deadWolfKing.userId;
        this.gameState.currentPhase = 'NIGHT_RESULT';
        actualDeaths.filter(p => p.userId !== deadWolfKing.userId).forEach(p => p.isAlive = false);
        return { success: true, summary: finalSummary.join('\n'), gameEnded: false, needsWolfKingClaw: true };
    }

    actualDeaths.forEach(p => {
        p.isAlive = false;
    });

    const gameStatus = this.checkGameStatus();
    if (gameStatus.isEnd) {
        this.endGame(gameStatus.winner);
        return { 
            success: true, 
            summary: finalSummary.join('\n') + `\n游戏结束！${gameStatus.winner} 阵营获胜！`, 
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

  recordVote(voterUserId, targetTempId) {
    if (this.gameState.status !== 'day_vote') return { success: false, message: '当前不是投票时间。' }
    const voter = this.players.find(p => p.userId === voterUserId && p.isAlive)
    if (!voter) return { success: false, message: '你无法投票。' }
    if (voter.tags.includes(TAGS.REVEALED_IDIOT)) return { success: false, message: '白痴翻牌后无法投票。' };
    if (this.gameState.votes[voterUserId]) return { success: false, message: '你已经投过票了。' }
    if (targetTempId === '00' || targetTempId === '0') {
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

  processVotes() {
    if (this.gameState.status !== 'day_vote') return { message: '非投票阶段，无法计票' }

    const currentDay = this.gameState.currentDay;
    const logEvent = (event) => this.gameState.eventLog.push({ day: currentDay, phase: 'day', ...event });

    const voteCounts = {}
    const voteDetails = {}
    this.players.filter(p => p.isAlive).forEach(voter => {
      const targetTempId = this.gameState.votes[voter.userId]
      if (targetTempId) {
        voteCounts[targetTempId] = (voteCounts[targetTempId] || 0) + 1
        if (!voteDetails[targetTempId]) voteDetails[targetTempId] = []
        voteDetails[targetTempId].push(`${voter.nickname}(${voter.tempId}号)`)
      } else {
        voteCounts['弃票'] = (voteCounts['弃票'] || 0) + 1
        if (!voteDetails['弃票']) voteDetails['弃票'] = []
        voteDetails['弃票'].push(`${voter.nickname}(${voter.tempId}号)`)
      }
    })

    let voteSummary = ["投票结果："]
    for (const targetTempId in voteCounts) {
      if (targetTempId === '弃票') continue
      const targetPlayer = this.players.find(p => p.tempId === targetTempId)
      if (targetPlayer) voteSummary.push(`${targetPlayer.nickname}(${targetTempId}号): ${voteCounts[targetTempId]}票 (${(voteDetails[targetTempId] || []).join(', ')})`)
    }
    if (voteCounts['弃票']) voteSummary.push(`弃票: ${voteCounts['弃票']}票 (${(voteDetails['弃票'] || []).join(', ')})`)

    let maxVotes = 0
    let tiedPlayers = []
    for (const targetTempId in voteCounts) {
      if (targetTempId === '弃票') continue
      if (voteCounts[targetTempId] > maxVotes) {
        maxVotes = voteCounts[targetTempId]
        tiedPlayers = [targetTempId]
      } else if (voteCounts[targetTempId] === maxVotes && maxVotes > 0) {
        tiedPlayers.push(targetTempId)
      }
    }

    this.gameState.votes = {}
    if (tiedPlayers.length === 1) {
      const eliminatedPlayer = this.players.find(p => p.tempId === tiedPlayers[0])
      if (eliminatedPlayer) {
        const voters = voteDetails[eliminatedPlayer.tempId] || [];
        logEvent({ type: 'VOTE_OUT', target: this.getPlayerInfo(eliminatedPlayer.userId), voters: voters });
        
        if (eliminatedPlayer.role === ROLES.IDIOT) {
            eliminatedPlayer.tags.push(TAGS.REVEALED_IDIOT);
            voteSummary.push(`${eliminatedPlayer.nickname}(${eliminatedPlayer.tempId}号) 被投票出局，但他/她亮出了【白痴】的身份！他/她不会死亡，但将失去投票权。`);
        } else {
            eliminatedPlayer.isAlive = false
            voteSummary.push(`${eliminatedPlayer.nickname} (${eliminatedPlayer.tempId}号) 被投票出局。`)

            if (eliminatedPlayer.role === ROLES.HUNTER) {
              this.gameState.status = 'hunter_shooting'
              this.gameState.hunterNeedsToShoot = eliminatedPlayer.userId
              this.gameState.currentPhase = 'DAY'
              return { success: true, summary: voteSummary.join('\n'), gameEnded: false, needsHunterShoot: true }
            }
            if (eliminatedPlayer.role === ROLES.WOLF_KING) {
                this.gameState.status = 'wolf_king_clawing';
                this.gameState.wolfKingNeedsToClaw = eliminatedPlayer.userId;
                this.gameState.currentPhase = 'DAY';
                return { success: true, summary: voteSummary.join('\n'), gameEnded: false, needsWolfKingClaw: true };
            }
        }
      }
    } else if (tiedPlayers.length > 1) {
      const sortedTiedPlayers = [...tiedPlayers].sort();
      voteSummary.push(`出现平票 (${sortedTiedPlayers.map(id => `${id}号`).join(', ')})，本轮无人出局。`);
    } else {
      voteSummary.push("所有人都弃票或投票无效，本轮无人出局。")
    }

    const gameStatus = this.checkGameStatus()
    if (gameStatus.isEnd) {
      this.endGame(gameStatus.winner)
      return { success: true, summary: voteSummary.join('\n') + `\n游戏结束！${gameStatus.winner} 阵营获胜！`, gameEnded: true, winner: gameStatus.winner, finalRoles: this.getFinalRoles() }
    } else {
      this.gameState.status = 'night'
      return { success: true, summary: voteSummary.join('\n'), gameEnded: false }
    }
  }

  getWerewolfAttackTargetId() {
    const werewolfActions = this.gameState.nightActions['WEREWOLF'] || {};
    console.log(`[${PLUGIN_NAME}] [DEBUG] getWerewolfAttackTargetId - Night actions for WEREWOLF:`, JSON.stringify(werewolfActions)); // 增强日志

    const killTargets = {};
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
    let topCandidates = [];
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

  checkGameStatus() {
    const alivePlayers = this.players.filter(p => p.isAlive)
    const wolfRoles = [ROLES.WEREWOLF, ROLES.WOLF_KING, ROLES.WHITE_WOLF_KING];
    const aliveWerewolves = alivePlayers.filter(p => wolfRoles.includes(p.role)).length
    const aliveHumans = alivePlayers.length - aliveWerewolves
    if (aliveWerewolves === 0) return { isEnd: true, winner: '好人' }
    if (aliveWerewolves >= aliveHumans) return { isEnd: true, winner: '狼人' }
    return { isEnd: false }
  }

  endGame() {
    this.gameState.isRunning = false
    this.gameState.status = 'ended'
  }

  getFinalRoles() {
    return this.players.map(p => `${p.nickname}(${p.tempId}号): ${this.roles[p.role] || '未知'}`).join('\n')
  }

  getPlayerInfo(userIdOrTempId) {
    const player = this.players.find(p => p.userId === userIdOrTempId || p.tempId === userIdOrTempId)
    return player ? `${player.nickname}(${player.tempId}号)` : '未知玩家'
  }

  getAlivePlayerList() {
    return this.players.filter(p => p.isAlive).map(p => `${p.tempId}号: ${p.nickname}`).join('\n')
  }

  getGameData() {
    return { players: this.players, roles: this.roles, gameState: this.gameState, potions: this.potions, userGroupMap: this.userGroupMap }
  }
}

// --- Yunzai 插件类 ---
export class WerewolfPlugin extends plugin {
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
        { reg: '^#?(结束发言|过)$', fnc: 'handleEndSpeech' },
        { reg: '^#投票\\s*(\\d+|弃票)$', fnc: 'handleVote' },
        { reg: '^#开枪\\s*(\\d+)$', fnc: 'handleHunterShoot', permission: 'private' },
        { reg: '^#自爆$', fnc: 'handleSelfDestruct' },
        { reg: '^#狼爪\\s*(\\d+)$', fnc: 'handleWolfKingClaw', permission: 'private' }
      ]
    });

    setInterval(() => this.checkAllGameTimers(), 5000);

    this.gameInstances = new Map();
    this.userToGroupCache = new Map();
    this.phaseTimers = new Map();
    this.NIGHT_INIT_DURATION = 40 * 1000;
    this.WITCH_ACTION_DURATION = 30 * 1000;
    this.SPEECH_DURATION = 45 * 1000;
    this.VOTE_DURATION = 60 * 1000;
    this.HUNTER_SHOOT_DURATION = 30 * 1000;
    this.WOLF_KING_CLAW_DURATION = 30 * 1000;
  }

  clearPhaseTimer(groupId) {
    if (this.phaseTimers.has(groupId)) {
      clearTimeout(this.phaseTimers.get(groupId));
      this.phaseTimers.delete(groupId);
      console.log(`[${PLUGIN_NAME}] Cleared phase timer for group ${groupId}.`);
    }
  }

  async getGameInstance(groupId, createIfNotExist = false, hostUserId = null, hostNickname = null) {
    let game = this.gameInstances.get(groupId);
    if (!game) {
      const gameData = await GameDataManager.load(groupId);
      if (gameData) {
        game = new WerewolfGame(gameData);
        this.gameInstances.set(groupId, game);
        
        // 加载游戏后，预热 userToGroupCache
        if (game.players) {
            for (const player of game.players) {
                this.userToGroupCache.set(player.userId, groupId);
            }
        }

        if (game.gameState.isRunning) {
          GameCleaner.registerGame(groupId, this);
        }
      } else if (createIfNotExist && hostUserId && hostNickname) {
        game = new WerewolfGame();
        this.gameInstances.set(groupId, game);
        GameCleaner.registerGame(groupId, this);
      }
    }
    return game;
  }

  // 只更新内存缓存
  updateMemoryCache(groupId, game) {
    if (game) {
      this.gameInstances.set(groupId, game);
    }
  }

  // 用于游戏创建、阶段转换等需要全量保存的场景
  async saveGameAll(groupId, game) {
    if (game) {
      await GameDataManager.saveAll(groupId, game.getGameData());
      this.updateMemoryCache(groupId, game);
    }
  }
  
  // 用于只更新某个字段的场景
  async saveGameField(groupId, game, fieldName) {
    if (game && game[fieldName]) {
        await GameDataManager.saveField(groupId, fieldName, game[fieldName]);
        this.updateMemoryCache(groupId, game);
    } else if (game && typeof game.getGameData === 'function' && game.getGameData()[fieldName]) {
        // 兼容 getGameData() 的情况
        await GameDataManager.saveField(groupId, fieldName, game.getGameData()[fieldName]);
        this.updateMemoryCache(groupId, game);
    }
  }

  async deleteGame(groupId) {
    this.clearPhaseTimer(groupId)
    GameCleaner.cleanupGame(groupId)
    const game = this.gameInstances.get(groupId)
    if (game) {
      const userIds = game.players.map(p => p.userId)
      if (userIds.length > 0) {
        // 从内存缓存中删除玩家
        userIds.forEach(id => this.userToGroupCache.delete(id));
        const keysToDelete = userIds.map(id => `${USER_GROUP_KEY_PREFIX}${id}`)
        await redis.del(keysToDelete)
      }
    }
    this.gameInstances.delete(groupId)
    await GameDataManager.delete(groupId)
    await redis.zRem(DEADLINE_KEY, String(groupId))
    console.log(`[${PLUGIN_NAME}] 已删除游戏数据 (${groupId})`)
  }

  async createGame(e) {
    const groupId = e.group_id
    if (!groupId) return e.reply("请在群聊中使用此命令。")
    let game = await this.getGameInstance(groupId)
    if (game && game.gameState.status !== 'ended') return e.reply(`本群已有游戏（状态: ${game.gameState.status}）。\n请先 #结束狼人杀。`)

    game = await this.getGameInstance(groupId, true, e.user_id, e.sender.card || e.sender.nickname)
    const initResult = await game.initGame(e.user_id, e.sender.card || e.sender.nickname, groupId)
    
    await this.saveGameAll(groupId, game)
    return e.reply(initResult.message, true)
  }
  async joinGame(e) {
    const groupId = e.group_id
    if (!groupId) return e.reply("请在群聊中使用此命令。", true)
    const game = await this.getGameInstance(groupId)
    if (!game || game.gameState.status === 'ended') return e.reply("本群当前没有等待加入的游戏。", true)
    if (!['waiting', 'starting'].includes(game.gameState.status)) return e.reply("游戏已经开始或结束，无法加入。", true)

    const reachable = await this.sendDirectMessage(
      e.user_id, 
      `[${PLUGIN_NAME}] 游戏加入成功！\n我们已确认可以向您发送私聊消息。`,
      groupId,
      false 
    );

    if (!reachable) {
      return e.reply(
        `[!] 加入失败！无法向您发送私聊消息。\n请先添加机器人为好友，或检查是否已屏蔽机器人。解决后请重新加入。`, 
        true, 
        { at: true }
      );
    }

    const result = await game.addPlayer(e.user_id, e.sender.card || e.sender.nickname, groupId)
    if(result.success) {
        this.userToGroupCache.set(e.user_id, groupId); // 更新缓存
        // 更新 players 和 userGroupMap 字段
        await this.saveGameField(groupId, game, 'players');
        await this.saveGameField(groupId, game, 'userGroupMap');
    }
    return e.reply(result.message, false, { at: true })
  }

  async leaveGame(e) {
    const groupId = e.group_id;
    if (!groupId) return e.reply("请在群聊中使用此命令。", true);
    const game = await this.getGameInstance(groupId);
    if (!game || game.gameState.status === 'ended') return e.reply("本群当前没有游戏。", true);
    if (!['waiting', 'starting'].includes(game.gameState.status)) return e.reply("游戏已经开始，无法退出。", true);

    const result = await game.removePlayer(e.user_id);
    if (result.success) {
      this.userToGroupCache.delete(e.user_id); // 更新缓存
      if (result.gameDissolved) {
          await this.deleteGame(groupId);
      } else {
          // 更新 players 和 userGroupMap 字段
          await this.saveGameField(groupId, game, 'players');
          await this.saveGameField(groupId, game, 'userGroupMap');
      }
    }
    return e.reply(result.message, false, { at: true });
  }

  async startGame(e) {
    const groupId = e.group_id
    if (!groupId) return e.reply("请在群聊中使用此命令。", true)
    const game = await this.getGameInstance(groupId)
    if (!game || game.gameState.status === 'ended') return e.reply("本群当前没有游戏。", true)
    if (game.gameState.hostUserId !== e.user_id) return e.reply("只有房主才能开始游戏。", true)
    if (game.gameState.status !== 'waiting') return e.reply(`游戏状态为 ${game.gameState.status}，无法开始。`, true)

    // 1. 准备阶段
    const prepareResult = await game.prepareGameStart()
    if (!prepareResult.success) {
        return e.reply(prepareResult.message, true)
    }

    // 2. 权限检查与宣告
    if (AUTO_MUTE_ENABLED) {
        game.gameState.hasPermission = e.group.is_admin;
        const permissionMsg = game.gameState.hasPermission ?
            '【有权限模式】机器人将自动进行禁言/解禁。' :
            '【无权限模式】机器人权限不足，请玩家自觉遵守发言规则。';
        await e.reply(permissionMsg, true);
    }

    await this.saveGameField(groupId, game, 'gameState')
    await e.reply("游戏即将开始，正在生成本局游戏配置...", true)

    // 3. 计算并公布配置
    const distribution = game.calculateRoleDistribution();
    let distributionMessage = `--- 本局配置 (${game.players.length}人) ---\n`;
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
    await this.sendRolesToPlayers(groupId, game)
    game.gameState.isRunning = true
    await this.saveGameAll(groupId, game) // 保存 isRunning 状态
    await this.startNightPhase(groupId, game)
  }

  async handleNightAction(e) {
    const userId = e.user_id
    const gameInfo = await this.findUserActiveGame(userId)
    if (!gameInfo) return e.reply('未找到你参与的有效游戏。')

    const { groupId, instance: game } = gameInfo;
    if (game.gameState.status !== 'night') return e.reply('当前不是夜晚行动时间。')

    let role = null, type = null, targetTempId = null;
    let match;
    if ((match = e.msg.match(/^#?(杀|刀)\s*(\d+)$/))) {
      role = 'WEREWOLF'; type = 'kill'; targetTempId = match[2].padStart(2, '0');
    } else if ((match = e.msg.match(/^#?查验\s*(\d+)$/))) {
      role = 'SEER'; type = 'check'; targetTempId = match[1].padStart(2, '0');
    } else if ((match = e.msg.match(/^#?救\s*(\d+)$/))) {
      role = 'WITCH'; type = 'save'; targetTempId = match[1].padStart(2, '0');
    } else if ((match = e.msg.match(/^#?毒\s*(\d+)$/))) {
      role = 'WITCH'; type = 'kill'; targetTempId = match[1].padStart(2, '0');
    } else if ((match = e.msg.match(/^#?守\s*(\d+)$/))) {
      role = 'GUARD'; type = 'protect'; targetTempId = match[1].padStart(2, '0');
    }

    if (!role) return;
    if (game.players.find(p => p.userId === userId)?.role !== role) return e.reply('你的身份不符。')

    const result = game.recordNightAction(role, userId, { type, targetTempId })
    if (result.success) {
        // 只更新 gameState 字段
        await this.saveGameField(groupId, game, 'gameState');
    }

    return e.reply(result.message)
  }
    async handleWerewolfChat(e) {
    const userId = e.user_id;

    // 1. 查找玩家所在的游戏
    const gameInfo = await this.findUserActiveGame(userId);
    if (!gameInfo) {
      // 修正点：当找不到游戏时，给予明确反馈
      return e.reply('你当前不在任何一场进行中的游戏中，或游戏状态非夜晚，无法使用狼人频道。');
    }

    const { groupId, instance: game } = gameInfo;

    // 2. 验证游戏阶段：必须是夜晚
    if (game.gameState.status !== 'night') {
      return e.reply('非夜晚时间，狼人频道已关闭。');
    }

    // 3. 验证发送者身份：必须是存活的狼人
    const senderPlayer = game.players.find(p => p.userId === userId && p.isAlive);
    const wolfRoles = [ROLES.WEREWOLF, ROLES.WOLF_KING, ROLES.WHITE_WOLF_KING];
    if (!senderPlayer || !wolfRoles.includes(senderPlayer.role)) {
      return e.reply('你不是狼人阵营的成员，无法使用狼人频道。');
    }

    // 4. 提取聊天内容
    const match = e.msg.match(/^#(狼聊|w)\s*(.+)$/);
    // 增加一个健壮性检查
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
    
    // 7. 格式化并转发消息
    const formattedMessage = `[狼人频道] ${senderPlayer.nickname}(${senderPlayer.tempId}号): ${chatContent}`;

    for (const teammate of werewolfTeammates) {
      // 使用已有的私聊发送函数，并不在失败时通知群聊
      await this.sendDirectMessage(teammate.userId, formattedMessage, groupId, false);
      // 添加一个短暂的延迟，避免因快速发送多条消息而被平台限制
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // 8. 给发送者一个确认回执
    return e.reply('消息已成功发送至狼人频道。');
  }

  async handleEndSpeech(e) {
    const groupId = e.group_id
    if (!groupId) return
    const game = await this.getGameInstance(groupId)
    if (!game || game.gameState.status !== 'day_speak') return
    if (game.gameState.currentSpeakerUserId !== e.user_id) return e.reply("现在不是你的发言时间哦。", false, { at: true })

    const speaker = game.players.find(p => p.userId === e.user_id)
    await this.sendSystemGroupMsg(groupId, `${speaker?.nickname || '玩家'} (${speaker?.tempId || '??'}号) 已结束发言。`)

    if (game.gameState.hasPermission) {
        await this.mutePlayer(groupId, e.user_id, 3600); // 重新禁言发言结束的玩家
    }

    game.gameState.deadline = null;
    await redis.zRem(DEADLINE_KEY, String(groupId));

    const nextSpeakerUserId = game.moveToNextSpeaker()
    if (nextSpeakerUserId) {
      await this.announceAndSetSpeechTimer(groupId, game)
    } else {
      await this.sendSystemGroupMsg(groupId, "所有玩家发言完毕，进入投票阶段。")
      await this.startVotingPhase(groupId, game)
    }
  }

  async handleVote(e) {
    const groupId = e.group_id
    if (!groupId) return e.reply("请在群聊中使用此命令。", true)
    const game = await this.getGameInstance(groupId)
    if (!game || game.gameState.status !== 'day_vote') return e.reply("当前不是投票时间。", true)

    // 修正点：使用正确的解析逻辑
    const match = e.msg.match(/#投票\s*(.+)$/);
    if (!match || !match[1]) {
      // 这个判断理论上不会触发，因为外层正则已经保证了格式，但作为健壮性检查
      return; 
    }
    const targetInput = match[1].trim();

    let targetTempId;
    if (targetInput === '弃票' || targetInput === '0' || targetInput === '00') {
      targetTempId = '00'; // 统一用 '00' 代表弃票
    } else if (/^\d+$/.test(targetInput)) {
      targetTempId = targetInput.padStart(2, '0');
    } else {
      return e.reply("投票指令无效，请发送 #投票 [编号] 或 #投票 弃票", true);
    }

    const result = game.recordVote(e.user_id, targetTempId)
    if (result.success) {
      // 只更新 gameState 字段
      await this.saveGameField(groupId, game, 'gameState');
    }
    // 无论成功与否都回复，让用户知道操作已被接收
    await e.reply(result.message, false, { at: true })

    // 检查是否所有存活玩家都已投票
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

  async handleHunterShoot(e) {
    const userId = e.user_id
    const gameInfo = await this.findUserActiveGame(e.user_id, true); // 传入 true
    if (!gameInfo) return e.reply('未找到你参与的游戏或你不是猎人。'); // 调整提示信息
    const game = gameInfo.instance;
    // 增加一个严格的猎人身份和状态检查
    if(game.gameState.status !== 'hunter_shooting' || game.gameState.hunterNeedsToShoot !== e.user_id) {
       return e.reply("现在不是你开枪的时间。");
    }

    const targetTempId = e.msg.match(/\d+/)?.[0].padStart(2, '0')
    if (!targetTempId) return e.reply("指令格式错误，请发送 #开枪 编号")

    const targetPlayer = game.players.find(p => p.tempId === targetTempId && p.isAlive)
    if (!targetPlayer) return e.reply("目标无效或已死亡。")
    if (targetPlayer.userId === userId) return e.reply("你不能对自己开枪。")

    game.gameState.deadline = null; // 清除猎人开枪计时器对应的 deadline
    await redis.zRem(DEADLINE_KEY, String(gameInfo.groupId)); // 从ZSET中移除

    targetPlayer.isAlive = false // 被带走的玩家死亡
    
    const hunterInfo = game.getPlayerInfo(userId);
    const targetInfo = game.getPlayerInfo(targetPlayer.userId);
    // deathPhase 应在 WerewolfGame.processNightActions 中被设置 currentPhase
    const deathPhase = game.gameState.currentPhase === 'NIGHT' ? 'night' : 'day'; 
    game.gameState.eventLog.push({ 
        day: game.gameState.currentDay, 
        phase: deathPhase,
        type: 'HUNTER_SHOOT', 
        actor: hunterInfo, 
        target: targetInfo 
    });

    const summary = `猎人 ${hunterInfo} 开枪带走了 ${targetInfo}！`
    await this.sendSystemGroupMsg(gameInfo.groupId, summary)

    const gameStatus = game.checkGameStatus()
    if (gameStatus.isEnd) {
      await this.endGameFlow(gameInfo.groupId, game, gameStatus.winner);
    } else {
      // --- 修正：猎人开枪后，如果游戏未结束，应该回到白天继续发言/投票 ---
      game.gameState.status = 'day_speak'; // 回到白天发言阶段
      await this.saveGameAll(gameInfo.groupId, game)
      await this.transitionToNextPhase(gameInfo.groupId, game)
    }
  }
  
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

    await this.sendSystemGroupMsg(groupId, `${player.nickname}(${player.tempId}号) 选择自爆！发言阶段立即结束，跳过投票，直接进入黑夜。`);
    
    player.isAlive = false;
    game.gameState.eventLog.push({
        day: game.gameState.currentDay,
        phase: 'day',
        type: 'SELF_DESTRUCT',
        actor: game.getPlayerInfo(player.userId)
    });

    if (player.role === ROLES.WHITE_WOLF_KING) {
        game.gameState.status = 'wolf_king_clawing';
        game.gameState.wolfKingNeedsToClaw = player.userId;
        game.gameState.currentPhase = 'DAY';
        await this.saveGameAll(groupId, game);
        await this.startWolfKingClawPhase(groupId, game, true); // true表示是白狼王自爆
        return;
    }

    const gameStatus = game.checkGameStatus();
    if (gameStatus.isEnd) {
        await this.endGameFlow(groupId, game, gameStatus.winner);
    } else {
        game.gameState.status = 'night';
        await this.saveGameAll(groupId, game);
        await this.transitionToNextPhase(groupId, game);
    }
  }

  async handleWolfKingClaw(e) {
      const userId = e.user_id;
      const gameInfo = await this.findUserActiveGame(userId, true);
      if (!gameInfo) return e.reply('未找到你参与的游戏。');

      const { groupId, instance: game } = gameInfo;
      if (game.gameState.status !== 'wolf_king_clawing' || game.gameState.wolfKingNeedsToClaw !== userId) {
          return e.reply("现在不是你使用狼王之爪的时间。");
      }

      const targetTempId = e.msg.match(/\d+/)?.[0].padStart(2, '0');
      if (!targetTempId) return e.reply("指令格式错误，请发送 #狼爪 编号");

      const targetPlayer = game.players.find(p => p.tempId === targetTempId && p.isAlive);
      if (!targetPlayer) return e.reply("目标无效或已死亡。");
      if (targetPlayer.userId === userId) return e.reply("你不能对自己使用技能。");

      game.gameState.deadline = null;
      await redis.zRem(DEADLINE_KEY, String(groupId));

      targetPlayer.isAlive = false;
      const wolfKingInfo = game.getPlayerInfo(userId);
      const targetInfo = game.getPlayerInfo(targetPlayer.userId);
      
      // 记录事件
      game.gameState.eventLog.push({
          day: game.gameState.currentDay,
          phase: game.gameState.currentPhase === 'DAY' ? 'day' : 'night', // 根据当前阶段判断
          type: 'WOLF_KING_CLAW',
          actor: wolfKingInfo,
          target: targetInfo
      });
      
      await this.sendSystemGroupMsg(groupId, `狼王 ${wolfKingInfo} 发动技能，带走了 ${targetInfo}！`);

      const gameStatus = game.checkGameStatus();
      if (gameStatus.isEnd) {
          await this.endGameFlow(groupId, game, gameStatus.winner);
      } else {
          game.gameState.status = 'night';
          await this.saveGameAll(groupId, game);
          await this.transitionToNextPhase(groupId, game);
      }
  }

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
      console.log(`[${PLUGIN_NAME}] [DEBUG] forceEndGame - Generating summary and roles for forced end.`); // 添加日志
      const gameSummary = this.generateGameSummary(game);
      const finalRoles = "--- 最终身份公布 ---\n" + game.getFinalRoles();
      const finalMessage = `游戏结束！\n\n` + gameSummary + "\n\n" + finalRoles; // 组合消息
      await this.sendSystemGroupMsg(groupId, finalMessage); // 发送组合消息
    } else {
        console.log(`[${PLUGIN_NAME}] [DEBUG] forceEndGame - Game was in status ${game.gameState.status}, skipping summary/roles.`); // 添加日志
    }

    await this.deleteGame(groupId)
    return true
  }

  generateGameSummary(game) {
    if (!game.gameState.eventLog || game.gameState.eventLog.length === 0) {
      return "本局游戏没有详细的事件记录。";
    }

    let summary = "--- 本局战报回放 ---\n\n";
    let lastDay = -1;

    for (const event of game.gameState.eventLog) {
      if (event.day !== lastDay) {
        summary += `\n【第 ${event.day} 天】\n`;
        lastDay = event.day;
      }

      if (event.phase === 'night') {
        switch (event.type) {
          case 'WEREWOLF_ATTACK':
            summary += `  - [夜晚] 狼人团队袭击了 ${event.target}。\n`;
            break;
          case 'GUARD_PROTECT':
            summary += `  - [夜晚] 守卫 ${event.actor} 守护了 ${event.target}。\n`;
            break;
          case 'WITCH_SAVE':
            summary += `  - [夜晚] 女巫 ${event.actor} 使用了解药，救了 ${event.target}。\n`;
            break;
          case 'WITCH_KILL':
            summary += `  - [夜晚] 女巫 ${event.actor} 使用了毒药，毒杀了 ${event.target}。\n`;
            break;
          case 'HUNTER_SHOOT':
            summary += `  - [夜晚] 猎人 ${event.actor} 开枪带走了 ${event.target}。\n`;
            break;
          case 'WOLF_KING_CLAW':
            summary += `  - [夜晚] 狼王 ${event.actor} 发动技能带走了 ${event.target}。\n`;
            break;
        }
      } else if (event.phase === 'day') {
        switch (event.type) {
          case 'VOTE_OUT':
            summary += `  - [白天] ${event.target} 被投票出局 (投票者: ${event.voters.join(', ')})。\n`;
            break;
          case 'HUNTER_SHOOT':
            summary += `  - [白天] 猎人 ${event.actor} 开枪带走了 ${event.target}。\n`;
            break;
          case 'SELF_DESTRUCT':
            summary += `  - [白天] ${event.actor} 选择了自爆。\n`;
            break;
          case 'WOLF_KING_CLAW':
            summary += `  - [白天] 狼王 ${event.actor} 发动技能带走了 ${event.target}。\n`;
            break;
        }
      }
    }
    return summary;
  }

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

  // --- 游戏流程与计时器管理 ---
  async sendRolesToPlayers(groupId, game) {
    await this.sendSystemGroupMsg(groupId, "正在私聊发送角色身份和临时编号...");

    // 提前找出所有狼人
    const wolfRoles = [ROLES.WEREWOLF, ROLES.WOLF_KING, ROLES.WHITE_WOLF_KING];
    const werewolfPlayers = game.players.filter(p => wolfRoles.includes(p.role));
    const werewolfTeamInfo = werewolfPlayers.map(p => `${p.nickname}(${p.tempId}号) - [${game.roles[p.role]}]`).join('、');

    // --- 新增：角色技能描述 ---
    const roleDescriptions = {
      WEREWOLF: '【技能说明】\n每晚可以和队友共同袭击一名玩家。\n可使用#狼聊或者#w在夜晚的狼人频道进行发言，你的发言会广播给其他狼人\n请在夜晚阶段私聊我：杀 [编号]',
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

      // --- 修改点：附加技能描述 ---
      const description = roleDescriptions[player.role];
      if (description) {
        message += `\n\n${description}`;
      }

      // 对狼人发送特殊消息
      if (wolfRoles.includes(player.role)) {
        if (werewolfPlayers.length > 1) {
          message += `\n\n你的狼队友是：${werewolfTeamInfo}。`;
        } else {
          message += `\n\n你是本局唯一的狼人。`;
        }
      }
      
      await this.sendDirectMessage(player.userId, message, groupId);
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    await this.sendSystemGroupMsg(groupId, "所有身份已发送完毕！");
  }

  async startNightPhase(groupId, game) {
    if (!game) return
    game.gameState.status = 'night'
    game.gameState.currentDay++

    const totalNightDuration = this.NIGHT_INIT_DURATION + this.WITCH_ACTION_DURATION
    game.gameState.deadline = Date.now() + totalNightDuration
    await redis.zAdd(DEADLINE_KEY, [{ score: game.gameState.deadline, value: String(groupId) }])
    await this.saveGameAll(groupId, game)

    await this.sendSystemGroupMsg(groupId, `--- 第 ${game.gameState.currentDay} 天 - 夜晚 ---`)
    await this.sendSystemGroupMsg(groupId, `天黑请闭眼... 夜晚行动阶段开始，总时长 ${totalNightDuration / 1000} 秒。\n【夜晚行动阶段】有身份的玩家请根据私聊提示进行操作。`)

    if (game.gameState.hasPermission) {
        await this.sendSystemGroupMsg(groupId, "正在禁言所有玩家...");
        await this.muteAllPlayers(groupId, game, true, 3600); // 禁言所有存活玩家
    }

    const alivePlayerList = game.getAlivePlayerList()
    for (const player of game.players.filter(p => p.isAlive)) {
      let prompt = null
      switch (player.role) {
        case 'WEREWOLF': prompt = `狼人请行动。\n请私聊我：杀 [编号]\n${alivePlayerList}`; break
        case 'SEER': prompt = `预言家请行动。\n请私聊我：查验 [编号]\n${alivePlayerList}`; break
        case 'GUARD':
          let guardPrompt = `守卫请行动。\n`
          if (game.gameState.lastProtectedId) guardPrompt += `（你上晚守护了 ${game.getPlayerInfo(game.gameState.lastProtectedId)}，不能连守）\n`
          prompt = guardPrompt + `请私聊我：守 [编号]\n${alivePlayerList}`
          break
      }
      if (prompt) await this.sendDirectMessage(player.userId, prompt, groupId)
    }

    setTimeout(async () => {
      const currentGame = await this.getGameInstance(groupId)
      if (!currentGame || currentGame.gameState.status !== 'night') return
      const witchPlayer = currentGame.players.find(p => p.role === 'WITCH' && p.isAlive)
      if (!witchPlayer) return

      const attackTargetId = currentGame.getWerewolfAttackTargetId()
      let witchPrompt = `女巫请行动。\n`
      if (attackTargetId) witchPrompt += `昨晚 ${currentGame.getPlayerInfo(attackTargetId)} 被袭击了。\n`
      else witchPrompt += `昨晚无人被袭击。\n`
      witchPrompt += `药剂状态：解药 ${currentGame.potions.save ? '可用' : '已用'}，毒药 ${currentGame.potions.kill ? '可用' : '已用'}。\n`
      if (currentGame.potions.save) witchPrompt += `使用解药请私聊我：救 [编号]\n`
      if (currentGame.potions.kill) witchPrompt += `使用毒药请私聊我：毒 [编号]\n`
      witchPrompt += `你的行动时间将在夜晚结束时截止。\n${currentGame.getAlivePlayerList()}`
      await this.sendDirectMessage(witchPlayer.userId, witchPrompt, groupId)
    }, this.NIGHT_INIT_DURATION)
  }

  async processNightEnd(groupId, game) {
    // 确认我们操作的是最新的游戏实例
    game = await this.getGameInstance(groupId);
    if (!game || game.gameState.status !== 'night') return;

    this.clearPhaseTimer(groupId);
    game.gameState.deadline = null;
    await this.sendSystemGroupMsg(groupId, "天亮了，进行夜晚结算...");

    const result = game.processNightActions(); 
    
    // 保存状态
    await this.saveGameAll(groupId, game);

    await this.sendSystemGroupMsg(groupId, result.summary);

    if (result.gameEnded) {
      await this.endGameFlow(groupId, game, result.winner);
    } else if (result.needsHunterShoot) {
      await this.startHunterShootPhase(groupId, game);
    } else if (result.needsWolfKingClaw) {
      await this.startWolfKingClawPhase(groupId, game);
    } else {
      await this.transitionToNextPhase(groupId, game);
    }
  }


  async processSpeechTimeout(groupId, game, context) {
    // 检查1：游戏状态必须是发言阶段
    if (!game || game.gameState.status !== 'day_speak') {
        console.log(`[${PLUGIN_NAME}] [超时处理-废弃] 游戏(群:${groupId})状态已不是day_speak，忽略过期的发言超时。`);
        return;
    }
    // 检查2：超时的发言人必须是当前记录的发言人
    if (context?.speakerId && context.speakerId !== game.gameState.currentSpeakerUserId) {
        console.log(`[${PLUGIN_NAME}] [超时处理-废弃] 游戏(群:${groupId})当前发言人已变更，忽略过期的发言超时。`);
        return;
    }

    const timedOutSpeaker = game.players.find(p => p.userId === game.gameState.currentSpeakerUserId);
    // 如果找不到发言人，也可能是状态已经变更，直接返回
    if (!timedOutSpeaker) return;

    await this.sendSystemGroupMsg(groupId, `${timedOutSpeaker.nickname}(${timedOutSpeaker.tempId}号) 发言时间到。`);
    
    if (game.gameState.hasPermission) {
        await this.mutePlayer(groupId, timedOutSpeaker.userId, 3600); // 重新禁言超时的玩家
    }
    
    // 清理一下当前超时的deadline，防止重复触发
    game.gameState.deadline = null;
    await this.saveGameField(groupId, game, 'gameState'); 

    const nextSpeakerUserId = game.moveToNextSpeaker();

    if (nextSpeakerUserId) {
      await this.announceAndSetSpeechTimer(groupId, game);
    } else {
      await this.sendSystemGroupMsg(groupId, "所有玩家发言完毕，进入投票阶段。");
      await this.startVotingPhase(groupId, game);
    }
  }

  async announceAndSetSpeechTimer(groupId, game) {
    if (!game || game.gameState.status !== 'day_speak' || !game.gameState.currentSpeakerUserId) return
    const speaker = game.players.find(p => p.userId === game.gameState.currentSpeakerUserId)
    if (!speaker) return

    game.gameState.deadline = Date.now() + this.SPEECH_DURATION
    await redis.zAdd(DEADLINE_KEY, [{ score: game.gameState.deadline, value: String(groupId) }])
    await this.saveGameField(groupId, game, 'gameState')

    const msg = [segment.at(speaker.userId), ` 请开始发言 (${this.SPEECH_DURATION / 1000}秒)\n发送#结束发言或“过”以结束你的发言。`]
    
    if (game.gameState.hasPermission) {
        await this.mutePlayer(groupId, speaker.userId, 0); // 解禁当前发言者
    }
    
    await this.sendSystemGroupMsg(groupId, msg)
  }

  async startDayPhase(groupId, game) {
    if (!game) return
    game.gameState.status = 'day_speak'
    await this.sendSystemGroupMsg(groupId, `--- 第 ${game.gameState.currentDay} 天 - 白天 ---`)

    const speechOrder = game.players.filter(p => p.isAlive).map(p => p.userId)
    game.gameState.speakingOrder = speechOrder
    game.gameState.currentSpeakerOrderIndex = -1

    const nextSpeakerId = game.moveToNextSpeaker()

    if (nextSpeakerId) {
      await this.announceAndSetSpeechTimer(groupId, game)
    } else {
      await this.sendSystemGroupMsg(groupId, "没有存活玩家可以发言，直接进入投票。")
      await this.startVotingPhase(groupId, game)
    }
  }

  async startVotingPhase(groupId, game) {
    game.gameState.status = 'day_vote'
    game.gameState.deadline = Date.now() + this.VOTE_DURATION
    await redis.zAdd(DEADLINE_KEY, [{ score: game.gameState.deadline, value: String(groupId) }])
    await this.saveGameField(groupId, game, 'gameState')

    const alivePlayerList = game.getAlivePlayerList()
    
    if (game.gameState.hasPermission) {
        await this.sendSystemGroupMsg(groupId, "进入投票阶段，解除所有玩家禁言。");
        await this.unmuteAllPlayers(groupId, game);
    }

    await this.sendSystemGroupMsg(groupId, `现在开始投票，请选择你要投出的人。\n发送 #投票 [编号] 或 #投票 弃票\n你有 ${this.VOTE_DURATION / 1000} 秒时间。\n存活玩家列表：\n${alivePlayerList}`)
    
    // 清理可能存在的旧计时器，以防万一
    this.clearPhaseTimer(groupId);

    const reminderDelay = this.VOTE_DURATION - 15 * 1000; // 提前15秒提醒
    if (reminderDelay > 0) {
      const timerId = setTimeout(async () => {
        // 再次获取最新的游戏实例，确保状态没有改变
        const currentGame = await this.getGameInstance(groupId);
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
      
      // 存储新的计时器ID
      this.phaseTimers.set(groupId, timerId);
    }
  }

  async processVoteEnd(groupId, game) {
    // 确认我们操作的是最新的游戏实例
    game = await this.getGameInstance(groupId);
    if (!game || game.gameState.status !== 'day_vote') return
    game.gameState.deadline = null
    await this.sendSystemGroupMsg(groupId, "投票时间结束，正在计票...")

    const result = game.processVotes()
    await this.saveGameAll(groupId, game)
    await this.sendSystemGroupMsg(groupId, result.summary)

    if (result.gameEnded) {
      await this.endGameFlow(groupId, game, result.winner)
    } else if (result.needsHunterShoot) {
      await this.startHunterShootPhase(groupId, game)
    } else if (result.needsWolfKingClaw) {
      await this.startWolfKingClawPhase(groupId, game);
    } else {
      await this.transitionToNextPhase(groupId, game)
    }
  }

  async startHunterShootPhase(groupId, game) {
    if (!game || game.gameState.status !== 'hunter_shooting' || !game.gameState.hunterNeedsToShoot) return
    const hunterUserId = game.gameState.hunterNeedsToShoot
    game.gameState.deadline = Date.now() + this.HUNTER_SHOOT_DURATION
    await redis.zAdd(DEADLINE_KEY, [{ score: game.gameState.deadline, value: String(groupId) }])
    await this.saveGameField(groupId, game, 'gameState')

    const hunterInfo = game.getPlayerInfo(hunterUserId)
    const alivePlayerList = game.getAlivePlayerList()
    await this.sendSystemGroupMsg(groupId, `${hunterInfo} 是猎人！临死前可以选择开枪带走一人！\n你有 ${this.HUNTER_SHOOT_DURATION / 1000} 秒时间。\n存活玩家：\n${alivePlayerList}`)
    await this.sendDirectMessage(hunterUserId, `你是猎人，请开枪！\n发送 #开枪 [编号]\n你有 ${this.HUNTER_SHOOT_DURATION / 1000} 秒时间。\n${alivePlayerList}`, groupId)
  }

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
        game.gameState.status = 'day_speak';
        await this.saveGameAll(groupId, game)
        await this.transitionToNextPhase(groupId, game)
    }
  }

  async startWolfKingClawPhase(groupId, game, isWhiteWolfKing = false) {
      if (!game || (game.gameState.status !== 'wolf_king_clawing' && !isWhiteWolfKing) || !game.gameState.wolfKingNeedsToClaw) return;
      
      const wolfKingUserId = game.gameState.wolfKingNeedsToClaw;
      game.gameState.deadline = Date.now() + this.WOLF_KING_CLAW_DURATION;
      await redis.zAdd(DEADLINE_KEY, [{ score: game.gameState.deadline, value: String(groupId) }]);
      await this.saveGameField(groupId, game, 'gameState');

      const wolfKingInfo = game.getPlayerInfo(wolfKingUserId);
      const alivePlayerList = game.getAlivePlayerList();
      const promptMsg = isWhiteWolfKing ? 
          `白狼王 ${wolfKingInfo} 自爆了！请选择一名玩家带走！` :
          `${wolfKingInfo} 是狼王！临死前可以选择发动技能带走一人！`;
      
      await this.sendSystemGroupMsg(groupId, `${promptMsg}\n你有 ${this.WOLF_KING_CLAW_DURATION / 1000} 秒时间。\n存活玩家：\n${alivePlayerList}`);
      await this.sendDirectMessage(wolfKingUserId, `你是${isWhiteWolfKing ? '白狼王' : '狼王'}，请发动技能！\n发送 #狼爪 [编号]\n你有 ${this.WOLF_KING_CLAW_DURATION / 1000} 秒时间。\n${alivePlayerList}`, groupId);
  }

  async processWolfKingClawEnd(groupId, game) {
      if (!game || game.gameState.status !== 'wolf_king_clawing') return;

      game.gameState.deadline = null;
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
          game.gameState.status = 'night';
          await this.saveGameAll(groupId, game);
          await this.transitionToNextPhase(groupId, game);
      }
  }

  async transitionToNextPhase(groupId, game) {
    if (!game || game.gameState.status === 'ended') return
    const nextStatus = game.gameState.status
    console.log(`[${PLUGIN_NAME}] 状态转换 -> ${nextStatus} (群: ${groupId})`)
    switch (nextStatus) {
      case 'night': await this.startNightPhase(groupId, game); break
      case 'day_speak': await this.startDayPhase(groupId, game); break
      default: console.warn(`[${PLUGIN_NAME}] 未知或非自动转换状态: ${nextStatus} (群: ${groupId})`)
    }
  }

async endGameFlow(groupId, game, winner) {
    console.log(`[${PLUGIN_NAME}] [DEBUG] endGameFlow - Game ending for group ${groupId}. Winner: ${winner}`); // Log start of endGameFlow
    // 生成详细战报
    const gameSummary = this.generateGameSummary(game);
    console.log(`[${PLUGIN_NAME}] [DEBUG] endGameFlow - Generated game summary:\n`, gameSummary); // Log generated summary

    // 公布最终身份
    const finalRoles = "--- 最终身份公布 ---\n" + game.getFinalRoles();
    console.log(`[${PLUGIN_NAME}] [DEBUG] endGameFlow - Generated final roles:\n`, finalRoles); // Log generated roles

    // 组合消息
    const finalMessage = `游戏结束！${winner} 阵营获胜！\n\n` + gameSummary + "\n\n" + finalRoles;
    console.log(`[${PLUGIN_NAME}] [DEBUG] endGameFlow - Final message to send:\n`, finalMessage); // Log final message

    await this.sendSystemGroupMsg(groupId, finalMessage);
    
    if (game.gameState.hasPermission) {
        await this.unmuteAllPlayers(groupId, game);
    }

    await this.deleteGame(groupId);
    console.log(`[${PLUGIN_NAME}] [DEBUG] endGameFlow - Game data deleted for group ${groupId}.`); // Log deletion
  }

  async checkAllGameTimers() {
    try {
      const expiredGameIds = await redis.zRangeByScore(DEADLINE_KEY, '-inf', Date.now())
      if (!expiredGameIds || expiredGameIds.length === 0) return

      for (const groupId of expiredGameIds) {
        const removedCount = await redis.zRem(DEADLINE_KEY, String(groupId));
        if (removedCount === 0) {
          continue;
        }

        const game = await this.getGameInstance(groupId)
        if (!game || !game.gameState.isRunning) {
          continue
        }

        console.log(`[${PLUGIN_NAME}] [轮询] 检测到 ${game.gameState.status} 超时 (${groupId})`)

        switch (game.gameState.status) {
          case 'night': await this.processNightEnd(groupId, game); break
          case 'day_speak': await this.processSpeechTimeout(groupId, game, { speakerId: game.gameState.currentSpeakerUserId }); break
          case 'day_vote': await this.processVoteEnd(groupId, game); break
          case 'hunter_shooting': await this.processHunterShootEnd(groupId, game); break
          case 'wolf_king_clawing': await this.processWolfKingClawEnd(groupId, game); break
        }
      }
    } catch (error) {
      console.error(`[${PLUGIN_NAME}] 轮询检查计时器时发生错误:`, error)
    }
  }

  async findUserActiveGame(userId, includeDead = false) {
  try {
    let groupId = this.userToGroupCache.get(userId);
    
    if (!groupId) {
        groupId = await redis.get(`${USER_GROUP_KEY_PREFIX}${userId}`);
        if (groupId) {
            this.userToGroupCache.set(userId, groupId);
        }
    }

    if (groupId) {
      const game = await this.getGameInstance(groupId);
      // 如果 includeDead 为 true，则不检查 isAlive
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

  async sendSystemGroupMsg(groupId, msg) {
    if (!groupId || !msg) return
    try { await Bot.pickGroup(groupId).sendMsg(msg) }
    catch (err) { console.error(`[${PLUGIN_NAME}] 发送系统群消息失败 (${groupId}):`, err) }
  }

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

  // --- 禁言辅助函数 ---
  async mutePlayer(groupId, userId, duration) {
    try {
      const group = Bot.pickGroup(groupId);
      await group.muteMember(userId, duration);
    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 禁言/解禁玩家 ${userId} 失败 (群: ${groupId}):`, err);
    }
  }

  async muteAllPlayers(groupId, game, onlyAlive = true, duration = 3600) {
    const playersToMute = onlyAlive ? game.players.filter(p => p.isAlive) : game.players;
    for (const player of playersToMute) {
      await this.mutePlayer(groupId, player.userId, duration);
      await new Promise(resolve => setTimeout(resolve, 200)); // 防止频率过快
    }
  }

  async unmuteAllPlayers(groupId, game) {
    // 解禁所有参与过游戏的玩家，以防有中途死亡的玩家仍被禁言
    for (const player of game.players) {
      await this.mutePlayer(groupId, player.userId, 0);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

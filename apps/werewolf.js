const PLUGIN_NAME = '狼人杀'

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
      const pipeline = redis.pipeline()
      pipeline.hSet(key, 'players', JSON.stringify(data.players || []))
      pipeline.hSet(key, 'roles', JSON.stringify(data.roles || {}))
      pipeline.hSet(key, 'gameState', JSON.stringify(data.gameState || {}))
      pipeline.hSet(key, 'potions', JSON.stringify(data.potions || {}))
      pipeline.hSet(key, 'userGroupMap', JSON.stringify(data.userGroupMap || {}))
      pipeline.expire(key, GAME_DATA_EXPIRATION)
      await pipeline.exec()
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
    this.roles = initialData.roles || { WEREWOLF: '狼人', VILLAGER: '村民', SEER: '预言家', WITCH: '女巫', HUNTER: '猎人', GUARD: '守卫' }
    this.gameState = initialData.gameState || {
      isRunning: false,
      currentPhase: null,
      currentDay: 0,
      status: 'waiting',
      hostUserId: null,
      nightActions: {},
      lastProtectedId: null,
      hunterNeedsToShoot: null,
      currentSpeakerUserId: null,
      speakingOrder: [],
      currentSpeakerOrderIndex: -1,
      votes: {},
      deadline: null
    }
    this.potions = initialData.potions || { save: true, kill: true }
    this.userGroupMap = initialData.userGroupMap || {}
  }

  initGame(hostUserId, hostNickname, groupId) {
    this.gameState = {
      isRunning: false, currentPhase: null, currentDay: 0, status: 'waiting',
      hostUserId: hostUserId, nightActions: {}, lastProtectedId: null, hunterNeedsToShoot: null,
      currentSpeakerUserId: null, speakingOrder: [], currentSpeakerOrderIndex: -1, votes: {},
      eventLog: [],
      deadline: null
    }
    this.players = []
    this.potions = { save: true, kill: true }
    this.userGroupMap = {}
    this.addPlayer(hostUserId, hostNickname, groupId)
    return { success: true, message: `狼人杀游戏已创建！你是房主。\n发送 #加入狼人杀 参与游戏。` }
  }

  async addPlayer(userId, nickname, groupId) {
    if (this.players.some(p => p.userId === userId)) return { success: false, message: '你已经加入游戏了。' }
    if (!['waiting', 'starting'].includes(this.gameState.status)) return { success: false, message: '游戏已经开始或结束，无法加入。' }
    const player = {
      userId, nickname, role: null, isAlive: true, isProtected: false,
      tempId: GameDataManager.generateTempId(this.players), isDying: false
    }
    this.players.push(player)
    this.userGroupMap[userId] = groupId
    await redis.set(`${USER_GROUP_KEY_PREFIX}${userId}`, groupId, { EX: GAME_DATA_EXPIRATION })
    return { success: true, message: `${nickname} (${player.tempId}号) 加入了游戏。当前人数: ${this.players.length}` }
  }

  async removePlayer(userId) {
    const playerIndex = this.players.findIndex(p => p.userId === userId)
    if (playerIndex === -1) return { success: false, message: '你不在游戏中。' }
    if (!['waiting', 'starting'].includes(this.gameState.status)) return { success: false, message: '游戏已经开始，无法退出。' }
    const removedPlayer = this.players.splice(playerIndex, 1)[0]
    if (removedPlayer.userId === this.gameState.hostUserId) {
      this.gameState.status = 'ended'
      return { success: true, message: `房主 ${removedPlayer.nickname} 退出了游戏，游戏已解散。`, gameDissolved: true }
    }
    delete this.userGroupMap[userId]
    await redis.del(`${USER_GROUP_KEY_PREFIX}${removedPlayer.userId}`)
    return { success: true, message: `${removedPlayer.nickname} 退出了游戏。当前人数: ${this.players.length}` }
  }

  assignRoles() {
    const playerCount = this.players.length
    if (playerCount < 6) return { success: false, message: '玩家数量不足，至少需要6名玩家。' }
    let werewolfCount = playerCount >= 12 ? 4 : (playerCount >= 9 ? 3 : 2)
    let distribution = { WEREWOLF: werewolfCount, SEER: 1, WITCH: 1, HUNTER: 1, GUARD: 1 }
    distribution.VILLAGER = playerCount - Object.values(distribution).reduce((a, b) => a + b, 0)
    let allRoles = []
    for (const role in distribution) {
      for (let i = 0; i < distribution[role]; i++) allRoles.push(role)
    }
    allRoles.sort(() => Math.random() - 0.5)
    this.players.forEach((player, index) => { player.role = allRoles[index] })
    return { success: true }
  }

  async prepareGameStart(pluginInstance) {
    if (this.players.length < 6) return { success: false, message: '玩家数量不足，至少需要6名玩家。' }
    if (this.gameState.status !== 'waiting') return { success: false, message: '游戏状态不正确。' }
    this.gameState.status = 'starting'
    const groupId = this.userGroupMap[this.gameState.hostUserId]
    await pluginInstance.sendSystemGroupMsg(groupId, "所有玩家私聊权限已在加入时验证，现在开始分配角色...")
    const assignResult = this.assignRoles()
    if (!assignResult.success) {
      this.gameState.status = 'waiting'
      return assignResult
    }
    return { success: true, message: '角色分配完毕！准备发送身份...' }
  }

  recordNightAction(role, userId, action) {
    if (this.gameState.status !== 'night') return { success: false, message: '当前不是夜晚行动时间。' }
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
      const targetRole = validation.targetPlayer.role
      feedbackMsg += `\n[查验结果] ${validation.targetPlayer.nickname}(${validation.targetPlayer.tempId}号) 的身份是 【${targetRole === 'WEREWOLF' ? '狼人' : '好人'}】。`
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

    // 1. 初始化状态
    this.players.forEach(p => {
      p.isProtected = false;
      p.isDying = false;
    });

    let guardTargetId = null;
    let killedByWerewolfId = null;
    let witchSavedPlayerId = null;
    let deathCauses = {};

    // 2. 处理守卫行动并记录
    const guardAction = Object.values(this.gameState.nightActions.GUARD || {})[0];
    if (guardAction) {
      const target = this.players.find(p => p.tempId === guardAction.targetTempId && p.isAlive);
      if (target && target.userId !== this.gameState.lastProtectedId) {
        target.isProtected = true; // <--- 恢复的核心逻辑
        guardTargetId = target.userId;
        this.gameState.lastProtectedId = guardTargetId;
        logEvent({ type: 'GUARD_PROTECT', actor: this.getPlayerInfo(Object.keys(this.gameState.nightActions.GUARD)[0]), target: this.getPlayerInfo(target.userId) });
      } else {
        this.gameState.lastProtectedId = null;
      }
    } else {
      this.gameState.lastProtectedId = null;
    }

    // 3. 处理狼人行动并记录
    killedByWerewolfId = this.getWerewolfAttackTargetId();
    if (killedByWerewolfId) {
      const targetPlayer = this.players.find(p => p.userId === killedByWerewolfId);
      if (targetPlayer) {
        targetPlayer.isDying = true; // <--- 恢复的核心逻辑
        deathCauses[targetPlayer.userId] = 'WEREWOLF';
        const werewolfActors = this.players.filter(p => p.role === 'WEREWOLF' && p.isAlive).map(p => this.getPlayerInfo(p.userId));
        logEvent({ type: 'WEREWOLF_ATTACK', actors: werewolfActors, target: this.getPlayerInfo(killedByWerewolfId) });
      }
    }

    // 4. 处理女巫行动并记录
    const witchAction = Object.values(this.gameState.nightActions.WITCH || {})[0];
    if (witchAction) {
      const witchInfo = this.getPlayerInfo(Object.keys(this.gameState.nightActions.WITCH)[0]);
      if (witchAction.type === 'save' && this.potions.save) {
        this.potions.save = false;
        const savedTarget = this.players.find(p => p.tempId === witchAction.targetTempId && p.isAlive);
        if (savedTarget && savedTarget.isDying) {
          savedTarget.isDying = false; // <--- 恢复的核心逻辑
          witchSavedPlayerId = savedTarget.userId;
          delete deathCauses[savedTarget.userId];
          logEvent({ type: 'WITCH_SAVE', actor: witchInfo, target: this.getPlayerInfo(savedTarget.userId) });
        }
      } else if (witchAction.type === 'kill' && this.potions.kill) {
        this.potions.kill = false;
        const poisonedTarget = this.players.find(p => p.tempId === witchAction.targetTempId && p.isAlive);
        if (poisonedTarget) {
          poisonedTarget.isDying = true; // <--- 恢复的核心逻辑
          deathCauses[poisonedTarget.userId] = 'WITCH';
          logEvent({ type: 'WITCH_KILL', actor: witchInfo, target: this.getPlayerInfo(poisonedTarget.userId) });
        }
      }
    }

    // 5. 最终结算死亡
    let actualDeaths = [];
    this.players.forEach(p => {
      if (p.isDying) {
        let savedByGuard = false;
        if (p.isProtected && deathCauses[p.userId] === 'WEREWOLF') {
            savedByGuard = true;
        }
        if (!savedByGuard) {
          p.isAlive = false;
          actualDeaths.push(p);
        }
      }
    });

    if (killedByWerewolfId && killedByWerewolfId === guardTargetId && killedByWerewolfId === witchSavedPlayerId) {
      const unluckyPlayer = this.players.find(p => p.userId === killedByWerewolfId);
      if (unluckyPlayer && !actualDeaths.some(dead => dead.userId === unluckyPlayer.userId)) {
        unluckyPlayer.isAlive = false;
        actualDeaths.push(unluckyPlayer);
      }
    }

    // 6. 生成夜晚总结报告
    let finalSummary = ["夜晚结束，现在公布昨晚发生的事情："];
    if (actualDeaths.length > 0) {
      actualDeaths.forEach(p => {
        finalSummary.push(`${p.nickname} (${p.tempId}号) 昨晚死亡了。`);
      });
    } else {
      if (killedByWerewolfId && (witchSavedPlayerId === killedByWerewolfId || guardTargetId === killedByWerewolfId)) {
        finalSummary.push("昨晚是个平安夜。");
      } else {
        finalSummary.push("昨晚无人死亡。");
      }
    }

    // 7. 清理并决定下一阶段
    this.gameState.nightActions = {};
    const gameStatus = this.checkGameStatus();
    const deadHunter = actualDeaths.find(p => p.role === 'HUNTER');

    if (deadHunter) {
      this.gameState.status = 'hunter_shooting';
      this.gameState.hunterNeedsToShoot = deadHunter.userId;
      this.gameState.currentPhase = 'NIGHT'; // <--- 修正：标记猎人夜晚死亡
      return {
        success: true,
        summary: finalSummary.join('\n'),
        gameEnded: false,
        needsHunterShoot: true
      };
    }

    if (gameStatus.isEnd) {
      this.endGame(gameStatus.winner);
      return {
        success: true,
        summary: finalSummary.join('\n') + `\n游戏结束！${gameStatus.winner} 阵营获胜！`,
        gameEnded: true,
        winner: gameStatus.winner,
        finalRoles: this.getFinalRoles()
      };
    } else {
      this.gameState.status = 'day_speak';
      return { success: true, summary: finalSummary.join('\n'), gameEnded: false };
    }
  }

  recordVote(voterUserId, targetTempId) {
    if (this.gameState.status !== 'day_vote') return { success: false, message: '当前不是投票时间。' }
    const voter = this.players.find(p => p.userId === voterUserId && p.isAlive)
    if (!voter) return { success: false, message: '你无法投票。' }
    if (this.gameState.votes[voterUserId]) return { success: false, message: '你已经投过票了。' }
    // 允许弃票（0），允许投自己
    if (targetTempId === '00' || targetTempId === '0') {
      this.gameState.votes[voter.userId] = '弃票'
      return { success: true, message: `${voter.nickname} (${voter.tempId}号) 选择了弃票。` }
    }
    const targetPlayer = this.players.find(p => p.tempId === targetTempId && p.isAlive)
    if (!targetPlayer) return { success: false, message: '投票目标无效或已死亡。' }
    // 允许投自己
    this.gameState.votes[voter.userId] = targetTempId
    return { success: true, message: `${voter.nickname} (${voter.tempId}号) 投票给了 ${targetPlayer.nickname} (${targetTempId}号)。` }
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
        voteDetails[targetTempId].push(`${voter.nickname}(${voter.tempId})`)
      } else {
        voteCounts['弃票'] = (voteCounts['弃票'] || 0) + 1
        if (!voteDetails['弃票']) voteDetails['弃票'] = []
        voteDetails['弃票'].push(`${voter.nickname}(${voter.tempId})`)
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
        eliminatedPlayer.isAlive = false
        voteSummary.push(`${eliminatedPlayer.nickname} (${eliminatedPlayer.tempId}号) 被投票出局。`)
        
        const voters = voteDetails[eliminatedPlayer.tempId] || [];
        logEvent({ type: 'VOTE_OUT', target: this.getPlayerInfo(eliminatedPlayer.userId), voters: voters });

        if (eliminatedPlayer.role === 'HUNTER') {
          this.gameState.status = 'hunter_shooting'
          this.gameState.hunterNeedsToShoot = eliminatedPlayer.userId
          this.gameState.currentPhase = 'DAY'
          return { success: true, summary: voteSummary.join('\n'), gameEnded: false, needsHunterShoot: true }
        }
      }
    } else if (tiedPlayers.length > 1) {
      voteSummary.push(`出现平票 (${tiedPlayers.join(', ')}号)，本轮无人出局。`)
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
    const killTargets = {};
    Object.values(werewolfActions).forEach(action => {
      const target = this.players.find(p => p.tempId === action.targetTempId && p.isAlive);
      if (target) {
        killTargets[target.userId] = (killTargets[target.userId] || 0) + 1;
      }
    });

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
      return null; // 无人被刀
    }
    if (topCandidates.length === 1) {
      return topCandidates[0]; // 唯一目标
    }
    // 平票情况，随机选择一个
    const randomIndex = Math.floor(Math.random() * topCandidates.length);
    return topCandidates[randomIndex];
  }

  checkGameStatus() {
    const alivePlayers = this.players.filter(p => p.isAlive)
    const aliveWerewolves = alivePlayers.filter(p => p.role === 'WEREWOLF').length
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
      priority: 500,
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
        { reg: '^#投票\\s*(\\d+)$', fnc: 'handleVote' },
        { reg: '^#开枪\\s*(\\d+)$', fnc: 'handleHunterShoot', permission: 'private' }
      ]
    });

    this.timerCheckInterval = setInterval(() => this.checkAllGameTimers(), 5000);

    this.gameInstances = new Map();
    this.userToGroupCache = new Map();
    this.NIGHT_INIT_DURATION = 40 * 1000;
    this.WITCH_ACTION_DURATION = 30 * 1000;
    this.SPEECH_DURATION = 45 * 1000;
    this.VOTE_DURATION = 60 * 1000;
    this.HUNTER_SHOOT_DURATION = 30 * 1000;
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
    const initResult = game.initGame(e.user_id, e.sender.card || e.sender.nickname, groupId)
    await this.saveGameAll(groupId, game) // 使用全量保存
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

    const prepareResult = await game.prepareGameStart(this)
    await this.saveGameAll(groupId, game)
    if (!prepareResult.success) return e.reply(prepareResult.message, true)

    await e.reply(prepareResult.message, true)

    await this.sendRolesToPlayers(groupId, game)
    game.gameState.isRunning = true
    await this.saveGameAll(groupId, game)
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
      // 如果找不到活跃游戏，则不作任何回复或给一个通用提示
      return; 
    }

    const { groupId, instance: game } = gameInfo;

    // 2. 验证游戏阶段：必须是夜晚
    if (game.gameState.status !== 'night') {
      return e.reply('非夜晚时间，狼人频道已关闭。');
    }

    // 3. 验证发送者身份：必须是存活的狼人
    const senderPlayer = game.players.find(p => p.userId === userId && p.isAlive);
    if (!senderPlayer || senderPlayer.role !== 'WEREWOLF') {
      return e.reply('你不是存活的狼人，无法使用狼人频道。');
    }

    // 4. 提取聊天内容
    const match = e.msg.match(/^#(狼聊|w)\s*(.+)$/);
    const chatContent = match[2].trim();
    if (!chatContent) {
      return e.reply('狼聊内容不能为空。');
    }

    // 5. 找到所有其他的狼队友
    const werewolfTeammates = game.players.filter(p =>
      p.isAlive &&
      p.role === 'WEREWOLF' &&
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
    let targetTempId = e.msg.match(/\d+/)?.[0]
    if (!targetTempId) return
    if (targetTempId === '0' || targetTempId === '00') targetTempId = '00'
    else targetTempId = targetTempId.padStart(2, '0')

    const result = game.recordVote(e.user_id, targetTempId)
    // 只更新 gameState 字段
    await this.saveGameField(groupId, game, 'gameState');
    await e.reply(result.message, false, { at: true })

    const activePlayerCount = game.players.filter(p => p.isAlive).length
    if (Object.keys(game.gameState.votes).length === activePlayerCount) {
      await this.processVoteEnd(groupId, game)
    }
  }

  async handleHunterShoot(e) {
    const userId = e.user_id
    const gameInfo = await this.findUserActiveGame(userId)
    if (!gameInfo) return e.reply("未找到你参与的游戏。")
    const game = gameInfo.instance
    if (game.gameState.status !== 'hunter_shooting' || game.gameState.hunterNeedsToShoot !== userId) return e.reply("现在不是你开枪的时间。")
    const targetTempId = e.msg.match(/\d+/)?.[0].padStart(2, '0')
    if (!targetTempId) return e.reply("指令格式错误，请发送 #开枪 编号")

    const targetPlayer = game.players.find(p => p.tempId === targetTempId && p.isAlive)
    if (!targetPlayer) return e.reply("目标无效或已死亡。")
    if (targetPlayer.userId === userId) return e.reply("你不能对自己开枪。")

    game.gameState.deadline = null
    await redis.zRem(DEADLINE_KEY, String(gameInfo.groupId))
    targetPlayer.isAlive = false
    
    // --- 修正：定义 deathPhase 变量 ---
    const hunterInfo = game.getPlayerInfo(userId);
    const targetInfo = game.getPlayerInfo(targetPlayer.userId);
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
      game.gameState.status = 'night';
      await this.saveGameAll(gameInfo.groupId, game)
      await this.transitionToNextPhase(gameInfo.groupId, game)
    }
  }

  async forceEndGame(e, isAutoCleanup = false) {
    const groupId = e.group_id
    if (!groupId) return
    const game = await this.getGameInstance(groupId)
    if (!game) return isAutoCleanup ? null : e.reply("本群当前没有游戏。", true)

    let canEnd = false
    if (isAutoCleanup || e.isMaster || (e.member && await e.member.is_admin()) || game.gameState.hostUserId === e.user_id) {
      canEnd = true;
    }
    if (!canEnd) return e.reply("只有房主、群管或主人才能强制结束游戏。", true)

    const enderNickname = isAutoCleanup ? '系统自动' : (e.sender.card || e.sender.nickname)
    await this.sendSystemGroupMsg(groupId, `游戏已被 ${enderNickname} 强制结束。`)

    if (game.gameState.status !== 'waiting' && game.gameState.status !== 'ended') {
      await this.sendSystemGroupMsg(groupId, "公布所有玩家身份：\n" + game.getFinalRoles())
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
        }
      } else if (event.phase === 'day') {
        switch (event.type) {
          case 'VOTE_OUT':
            summary += `  - [白天] ${event.target} 被投票出局 (投票者: ${event.voters.join(', ')})。\n`;
            break;
          case 'HUNTER_SHOOT':
            summary += `  - [白天] 猎人 ${event.actor} 开枪带走了 ${event.target}。\n`;
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
    const werewolfPlayers = game.players.filter(p => p.role === 'WEREWOLF');
    const werewolfTeamInfo = werewolfPlayers.map(p => `${p.nickname}(${p.tempId}号)`).join('、');

    // --- 新增：角色技能描述 ---
    const roleDescriptions = {
      WEREWOLF: '【技能说明】\n每晚可以和队友共同袭击一名玩家。\n可使用#狼聊或者#w在夜晚的狼人频道进行发言，你的发言会广播给其他狼人\n请在夜晚阶段私聊我：杀 [编号]',
      VILLAGER: '【技能说明】\n你是一个普通村民，白天努力分析局势，投票放逐可疑的玩家。',
      SEER: '【技能说明】\n每晚可以查验一名玩家的阵营（狼人或好人）。\n请在夜晚阶段私聊我：查验 [编号]',
      WITCH: '【技能说明】\n你有一瓶解药和一瓶毒药。\n解药可以救活当晚被袭击的玩家，毒药可以毒死一名玩家。解药和毒药整局游戏只能各使用一次。',
      HUNTER: '【技能说明】\n当你被投票出局或被狼人袭击身亡时，可以开枪带走场上任意一名玩家。',
      GUARD: '【技能说明】\n每晚可以守护一名玩家，使其免受狼人袭击。但不能连续两晚守护同一个人。'
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
      if (player.role === 'WEREWOLF') {
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

    game.gameState.deadline = null;
    await this.sendSystemGroupMsg(groupId, "天亮了，进行夜晚结算...");

    const result = game.processNightActions(); 
    
    // 保存状态
    await this.saveGameAll(groupId, game);

    await this.sendSystemGroupMsg(groupId, result.summary);

    if (result.gameEnded) {
      await this.endGameFlow(groupId, game, result.winner);
    } else if (result.needsHunterShoot) {
      // 如果需要猎人开枪，则进入开枪阶段
      await this.startHunterShootPhase(groupId, game);
    } else {
      // 否则，正常进入下一阶段（白天发言）
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

    const msg = [segment.at(speaker.userId), ` 请开始发言 (${this.SPEECH_DURATION / 1000}秒)。`]
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
    await this.sendSystemGroupMsg(groupId, `现在开始投票，请选择你要投出的人。\n发送 #投票 [编号]\n你有 ${this.VOTE_DURATION / 1000} 秒时间。\n存活玩家列表：\n${alivePlayerList}`)
    
    const reminderDelay = this.VOTE_DURATION - 15 * 1000; // 提前15秒提醒
    if (reminderDelay > 0) {
      setTimeout(async () => {
        // 再次获取最新的游戏实例，确保状态没有改变
        const currentGame = await this.getGameInstance(groupId);
        // 如果游戏已不在投票阶段，或已结束，则不发送提醒
        if (!currentGame || currentGame.gameState.status !== 'day_vote') {
          return;
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
      }, reminderDelay);
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
    game.gameState.deadline = null

    const hunterInfo = game.getPlayerInfo(game.gameState.hunterNeedsToShoot)
    await this.sendSystemGroupMsg(groupId, `猎人 ${hunterInfo} 选择不开枪（或超时）。`)

    // game.gameState.status = game.gameState.currentPhase === 'DAY' ? 'night' : 'day_speak' // 移除对 currentPhase 的依赖
    game.gameState.status = 'night'; // 猎人开枪后，如果游戏未结束，进入夜晚
    await this.saveGameAll(groupId, game)
    await this.transitionToNextPhase(groupId, game)
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
    // 生成详细战报
    const gameSummary = this.generateGameSummary(game);
    
    // 公布最终身份
    const finalRoles = "--- 最终身份公布 ---\n" + game.getFinalRoles();

    // 组合消息
    const finalMessage = `游戏结束！${winner} 阵营获胜！\n\n` + gameSummary + "\n\n" + finalRoles;

    await this.sendSystemGroupMsg(groupId, finalMessage);
    await this.deleteGame(groupId);
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
        }
      }
    } catch (error) {
      console.error(`[${PLUGIN_NAME}] 轮询检查计时器时发生错误:`, error)
    }
  }

    async findUserActiveGame(userId) {
    try {
      // 1. 优先从内存缓存中查找
      let groupId = this.userToGroupCache.get(userId);
      
      // 2. 如果内存缓存没有，再查 Redis (作为回退)
      if (!groupId) {
          groupId = await redis.get(`${USER_GROUP_KEY_PREFIX}${userId}`);
          if (groupId) {
              // 如果 Redis 中有，则更新内存缓存
              this.userToGroupCache.set(userId, groupId);
          }
      }

      if (groupId) {
        const game = await this.getGameInstance(groupId);
        // 确保玩家确实在游戏中并且存活
        if (game && game.players.some(p => p.userId === userId && p.isAlive)) {
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
}
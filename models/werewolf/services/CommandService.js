import { PLUGIN_NAME, ROLES, SELF_DESTRUCT_ENABLED, DEADLINE_KEY } from '../constants.js'

/**
 * @class CommandService
 * @description 狼人杀指令业务服务（非生命周期指令）。
 * 职责：夜晚行动、狼人频道、发言结束、投票、猎人/狼王技能、自爆、状态查询、强制结束。
 * 说明：本服务不直接持有插件上下文，只依赖 repo / phase / message / mute。
 */
export default class CommandService {
  /**
   * @param {object} deps
   * @param {object} deps.repo GameRepository 实例
   * @param {object} deps.phase PhaseService 实例
   * @param {object} deps.message MessageService 实例
   * @param {object} deps.mute MuteService 实例
   */
  constructor({ repo, phase, message, mute }) {
    this.repo = repo
    this.phase = phase
    this.message = message
    this.mute = mute
  }

  /**
   * 处理夜晚行动命令（杀、查验、救、毒、守）。
   * @param {object} e 消息事件对象
   */
  async handleNightAction(e) {
    const userId = e.user_id
    console.log(`[${PLUGIN_NAME}] [DEBUG] handleNightAction - Entry: user_id=${userId}, message=${e.msg}`)

    const gameInfo = await this.repo.findUserActiveGame(userId)
    if (!gameInfo) return
    const { instance: game, groupId } = gameInfo

    if (!game.gameState.isRunning || !game.gameState.status.startsWith('night_phase')) return

    const player = game.players.find(p => p.userId === userId && p.isAlive)
    if (!player) return

    const actionMap = {
      '杀': { role: ROLES.WEREWOLF, type: 'kill' },
      '刀': { role: ROLES.WEREWOLF, type: 'kill' },
      '查验': { role: ROLES.SEER, type: 'check' },
      '救': { role: ROLES.WITCH, type: 'save' },
      '毒': { role: ROLES.WITCH, type: 'kill' },
      '守': { role: ROLES.GUARD, type: 'protect' }
    }

    let role = null, type = null, targetTempId = null
    const match = e.msg.match(/^#?(杀|刀|查验|救|毒|守)\s*(\d+)$/)
    if (match) {
      const command = match[1]
      targetTempId = match[2].padStart(2, '0')
      const mappedAction = actionMap[command]
      if (mappedAction) {
        role = mappedAction.role
        type = mappedAction.type
      }
    }
    if (!role) return

    const actionPlayer = game.players.find(p => p.userId === userId)
    if (!actionPlayer || actionPlayer.role !== role) return e.reply('你的身份不符。')

    const result = game.recordNightAction(role, userId, { type, targetTempId })
    if (result.success) {
      await this.repo.saveGameField(groupId, game, 'gameState')
    }
    e.reply(result.message)
  }

  /**
   * 处理狼人频道（#狼聊 / #w）。
   */
  async handleWerewolfChat(e) {
    const userId = e.user_id
    const gameInfo = await this.repo.findUserActiveGame(userId)
    if (!gameInfo) {
      return e.reply('你当前不在任何一场进行中的游戏中，或游戏状态非夜晚，无法使用狼人频道。')
    }

    const { groupId, instance: game } = gameInfo
    if (game.gameState.status !== 'night_phase_1') {
      return e.reply('非狼人行动时间，狼人频道已关闭。')
    }

    const senderPlayer = game.players.find(p => p.userId === userId && p.isAlive)
    const wolfRoles = [ROLES.WEREWOLF, ROLES.WOLF_KING, ROLES.WHITE_WOLF_KING]
    if (!senderPlayer || !wolfRoles.includes(senderPlayer.role)) {
      return e.reply('你不是狼人阵营的成员，无法使用狼人频道。')
    }

    const match = e.msg.match(/^#(狼聊|w)\s*(.+)$/)
    if (!match || !match[2]) return e.reply('狼聊内容不能为空。')
    const chatContent = match[2].trim()
    if (!chatContent) return e.reply('狼聊内容不能为空。')

    const werewolfTeammates = game.players.filter(p =>
      p.isAlive && wolfRoles.includes(p.role) && p.userId !== userId
    )
    if (werewolfTeammates.length === 0) {
      return e.reply('你是唯一的狼人，没有其他队友可以交流。')
    }

    const sendDirectMessageFunc = async (targetUserId, msg, sourceGroupId) => {
      return await this.message.sendDirectMessage(targetUserId, msg, sourceGroupId, false)
    }

    const result = await game._roleActions[ROLES.WEREWOLF]
      .sendWerewolfChat(game, senderPlayer, werewolfTeammates, chatContent, sendDirectMessageFunc)
    return e.reply(result.message)
  }

  /**
   * 处理发言结束（#结束发言 / #过）。
   */
  async handleEndSpeech(e) {
    const groupId = e.group_id
    if (!groupId) return
    const game = await this.repo.getGameInstance(groupId)
    if (!game || game.gameState.status !== 'day_speak') return
    if (game.gameState.currentSpeakerUserId !== e.user_id) {
      return e.reply("现在不是你的发言时间哦。", false, { at: true })
    }

    const speaker = game.players.find(p => p.userId === e.user_id)
    await this.message.sendSystemGroupMsg(groupId, `${speaker?.nickname || '玩家'} (${speaker?.tempId || '??'}号) 已结束发言。`)

    if (game.gameState.hasPermission) {
      await this.mute.mutePlayer(groupId, e.user_id, 3600)
    }

    game.gameState.deadline = null
    await redis.zRem(DEADLINE_KEY, String(groupId))

    const nextSpeakerUserId = game.moveToNextSpeaker()
    if (nextSpeakerUserId) {
      await this.phase.announceAndSetSpeechTimer(groupId, game)
    } else {
      await this.message.sendSystemGroupMsg(groupId, "所有玩家发言完毕，进入投票阶段。")
      await this.phase.startVotingPhase(groupId, game)
    }
  }

  /**
   * 处理投票（#投票）。
   */
  async handleVote(e) {
    const groupId = e.group_id
    if (!groupId) return e.reply("请在群聊中使用此命令。", true)
    const game = await this.repo.getGameInstance(groupId)
    if (!game || game.gameState.status !== 'day_vote') return e.reply("当前不是投票时间。", true)

    const match = e.msg.match(/#投票\s*(.+)$/)
    if (!match || !match[1]) return
    const targetInput = match[1].trim()

    let targetTempId
    if (targetInput === '弃票' || targetInput === '0' || targetInput === '00') {
      targetTempId = '00'
    } else if (/^\d+$/.test(targetInput)) {
      targetTempId = targetInput.padStart(2, '0')
    } else {
      return e.reply("投票指令无效，请发送 #投票 [编号] 或 #投票 弃票", true)
    }

    const result = game.recordVote(e.user_id, targetTempId)
    if (result.success) {
      await this.repo.saveGameField(groupId, game, 'gameState')
    }

    await e.reply(result.message, false, { at: true })

    const activePlayerCount = game.players.filter(p => p.isAlive).length
    const votedCount = Object.keys(game.gameState.votes).length
    if (activePlayerCount > 0 && votedCount >= activePlayerCount) {
      console.log(`[${PLUGIN_NAME}] 所有玩家投票完毕，立即结算 (${groupId})`)
      this.phase.clearPhaseTimer(groupId)
      game.gameState.deadline = null
      await redis.zRem(DEADLINE_KEY, String(groupId))
      await this.phase.processVoteEnd(groupId, game)
    }
  }

  /**
   * 处理猎人开枪（#开枪）。
   */
  async handleHunterShoot(e) {
    const userId = e.user_id
    const gameInfo = await this.repo.findUserActiveGame(userId, true)
    if (!gameInfo) return e.reply('未找到你参与的游戏。')
    const game = gameInfo.instance

    if (game.gameState.status !== 'hunter_shooting' || game.gameState.hunterNeedsToShoot !== userId) {
      return e.reply("现在不是你开枪的时间。")
    }

    const targetTempId = e.msg.match(/\d+/)?.[0].padStart(2, '0')
    if (!targetTempId) return e.reply("指令格式错误，请发送 #开枪 编号")

    const hunterPlayer = game.players.find(p => p.userId === userId)
    const result = game._roleActions[ROLES.HUNTER].shoot(game, hunterPlayer, targetTempId)
    if (!result.success) return e.reply(result.message)

    game.gameState.deadline = null
    await redis.zRem(DEADLINE_KEY, String(gameInfo.groupId))

    const targetPlayer = game.players.find(p => p.tempId === targetTempId)
    if (targetPlayer) targetPlayer.isAlive = false
    if (hunterPlayer) hunterPlayer.isAlive = false

    const hunterInfo = game.getPlayerInfo(userId)
    const targetInfo = game.getPlayerInfo(targetPlayer.userId)
    const deathPhase = game.gameState.currentPhase === 'NIGHT_RESULT' ? 'night' : 'day'
    game.gameState.eventLog.push({
      day: game.gameState.currentDay,
      phase: deathPhase,
      type: 'HUNTER_SHOOT',
      actor: hunterInfo,
      target: targetInfo
    })

    await this.message.sendSystemGroupMsg(gameInfo.groupId, result.message)

    const gameStatus = game.checkGameStatus()
    if (gameStatus.isEnd) {
      await this.phase.endGameFlow(gameInfo.groupId, game, gameStatus.winner)
    } else {
      game.gameState.status = 'day_speak'
      await this.repo.saveGameAll(gameInfo.groupId, game)
      await this.phase.transitionToNextPhase(gameInfo.groupId, game)
    }
  }

  /**
   * 处理自爆（#自爆）。
   */
  async handleSelfDestruct(e) {
    if (!SELF_DESTRUCT_ENABLED) return e.reply("自爆功能当前未开启。")

    const groupId = e.group_id
    if (!groupId) return

    const game = await this.repo.getGameInstance(groupId)
    if (!game || !game.gameState.isRunning) return

    const player = game.players.find(p => p.userId === e.user_id && p.isAlive)
    if (!player) return

    const wolfRoles = [ROLES.WEREWOLF, ROLES.WOLF_KING, ROLES.WHITE_WOLF_KING]
    if (!wolfRoles.includes(player.role)) return e.reply("只有狼人阵营才能自爆。")
    if (game.gameState.status !== 'day_speak') return e.reply("只能在白天发言阶段自爆。")

    const match = e.msg.match(/^#自爆(?:\s*(.*))?$/)
    const lastWords = match && match[1] ? match[1].trim() : null

    if (player.role === ROLES.WHITE_WOLF_KING) {
      const result = game._roleActions[ROLES.WHITE_WOLF_KING].selfDestructClaw(game, player, null)
      if (!result.success) return e.reply(result.message)

      let message = `${player.nickname}(${player.tempId}号) 选择自爆！`
      if (lastWords) message += `\n遗言是：“${lastWords}”`
      message += `\n发言阶段立即结束，跳过投票，直接进入黑夜。`
      await this.message.sendSystemGroupMsg(groupId, message)

      player.isAlive = false
      game.gameState.eventLog.push({
        day: game.gameState.currentDay,
        phase: 'day',
        type: 'SELF_DESTRUCT',
        actor: game.getPlayerInfo(player.userId),
        message: lastWords
      })

      game.gameState.status = 'wolf_king_clawing'
      game.gameState.wolfKingNeedsToClaw = player.userId
      await this.repo.saveGameAll(groupId, game)
      await this.phase.startWolfKingClawPhase(groupId, game, true)
      return
    }

    let message = `${player.nickname}(${player.tempId}号) 选择自爆！`
    if (lastWords) message += `\n遗言是：“${lastWords}”`
    message += `\n发言阶段立即结束，跳过投票，直接进入黑夜。`
    await this.message.sendSystemGroupMsg(groupId, message)

    player.isAlive = false
    game.gameState.eventLog.push({
      day: game.gameState.currentDay,
      phase: 'day',
      type: 'SELF_DESTRUCT',
      actor: game.getPlayerInfo(player.userId),
      message: lastWords
    })

    const gameStatus = game.checkGameStatus()
    if (gameStatus.isEnd) {
      await this.phase.endGameFlow(groupId, game, gameStatus.winner)
    } else {
      game.gameState.status = 'night_phase_1'
      await this.repo.saveGameAll(groupId, game)
      await this.phase.transitionToNextPhase(groupId, game)
    }
  }

  /**
   * 处理狼王/白狼王带人（#狼爪）。
   */
  async handleWolfKingClaw(e) {
    const userId = e.user_id
    const gameInfo = await this.repo.findUserActiveGame(userId, true)
    if (!gameInfo) return e.reply('未找到你参与的游戏。')

    const { groupId, instance: game } = gameInfo
    if (game.gameState.status !== 'wolf_king_clawing' || game.gameState.wolfKingNeedsToClaw !== userId) {
      return e.reply("现在不是你使用狼王之爪的时间。")
    }

    const targetTempId = e.msg.match(/\d+/)?.[0].padStart(2, '0')
    if (!targetTempId) return e.reply("指令格式错误，请发送 #狼爪 编号")

    const wolfKingPlayer = game.players.find(p => p.userId === userId)
    const result = game._roleActions[wolfKingPlayer.role].claw(game, wolfKingPlayer, targetTempId)
    if (!result.success) return e.reply(result.message)

    game.gameState.deadline = null
    await redis.zRem(DEADLINE_KEY, String(groupId))

    const targetPlayer = game.players.find(p => p.tempId === targetTempId)
    if (targetPlayer) targetPlayer.isAlive = false

    const wolfKingInfo = game.getPlayerInfo(userId)
    const targetInfo = game.getPlayerInfo(targetPlayer.userId)
    game.gameState.eventLog.push({
      day: game.gameState.currentDay,
      phase: game.gameState.currentPhase === 'DAY' ? 'day' : 'night',
      type: 'WOLF_KING_CLAW',
      actor: wolfKingInfo,
      target: targetInfo
    })

    await this.message.sendSystemGroupMsg(groupId, result.message)

    const gameStatus = game.checkGameStatus()
    if (gameStatus.isEnd) {
      await this.phase.endGameFlow(groupId, game, gameStatus.winner)
    } else {
      game.gameState.status = 'night_phase_1'
      await this.repo.saveGameAll(groupId, game)
      await this.phase.transitionToNextPhase(groupId, game)
    }
  }

  /**
   * 强制结束游戏（#结束狼人杀 / 自动清理）。
   * @param {object} e 消息事件对象
   * @param {boolean} isAutoCleanup 是否自动清理触发
   */
  async forceEndGame(e, isAutoCleanup = false) {
    const groupId = e.group_id
    if (!groupId) return
    const game = await this.repo.getGameInstance(groupId)
    if (!game) return isAutoCleanup ? null : e.reply("本群当前没有游戏。", true)

    let canEnd = false
    if (
      isAutoCleanup ||
      e.isMaster ||
      (e.member && ['owner', 'admin'].includes(e.member.role)) ||
      (e.sender && e.sender.role === 'owner') ||
      game.gameState.hostUserId === e.user_id
    ) {
      canEnd = true
    }
    if (!canEnd) return e.reply("只有房主、群管或主人才能强制结束游戏。", true)

    const enderNickname = isAutoCleanup ? '系统自动' : (e.sender.card || e.sender.nickname)
    await this.message.sendSystemGroupMsg(groupId, `游戏已被 ${enderNickname} 强制结束。`)

    if (game.gameState.status !== 'waiting' && game.gameState.status !== 'ended') {
      const gameSummary = this.phase.generateGameSummary(game)
      const finalRoles = "--- 最终身份公布 ---\n" + game.getFinalRoles()
      const finalMessage = `游戏结束！\n\n` + gameSummary + "\n\n" + finalRoles
      await this.message.sendSystemGroupMsg(groupId, finalMessage)
    }

    if (game.gameState.hasPermission) {
      await this.mute.unmuteAllPlayers(groupId, game, false)
    }

    await this.phase.deleteGame(groupId)
    return true
  }

  /**
   * 查询游戏状态（#狼人杀状态）。
   */
  async showGameStatus(e) {
    const groupId = e.group_id
    if (!groupId) return
    const game = await this.repo.getGameInstance(groupId)
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
      const remaining = Math.round((game.gameState.deadline - Date.now()) / 1000)
      if (remaining > 0) statusMsg += `\n当前阶段剩余时间: ${remaining}秒`
    }
    return e.reply(statusMsg, true)
  }
}


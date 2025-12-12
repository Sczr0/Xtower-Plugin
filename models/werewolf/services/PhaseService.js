import { getConfigSection } from '../../../utils/config.js'
import { PLUGIN_NAME, ROLES, AUTO_MUTE_ENABLED, DEADLINE_KEY } from '../constants.js'

/**
 * @class PhaseService
 * @description 游戏流程与阶段计时器服务。
 * 职责：夜晚/白天/投票/技能阶段推进、deadline ZSET 维护、阶段内提醒计时器。
 */
export default class PhaseService {
  /**
   * @param {object} deps
   * @param {object} deps.repo GameRepository 实例
   * @param {object} deps.message MessageService 实例
   * @param {object} deps.mute MuteService 实例
   */
  constructor({ repo, message, mute }) {
    this.repo = repo
    this.message = message
    this.mute = mute
    this.phaseTimers = new Map()

    const cfg = getConfigSection('werewolf') || {}
    const toMs = (val, fallbackSec) => {
      const n = Number(val)
      const sec = Number.isFinite(n) && n > 0 ? n : fallbackSec
      return sec * 1000
    }

    // 阶段时长全部由配置驱动（秒 -> ms），缺失时回退到历史默认值
    this.WEREWOLF_PHASE_DURATION = toMs(cfg.nightActionDuration, 40)
    this.WITCH_ACTION_DURATION = toMs(cfg.nightActionDuration, 30)
    this.SPEECH_DURATION = toMs(cfg.daySpeakDuration, 45)
    this.VOTE_DURATION = toMs(cfg.dayVoteDuration, 60)
    this.HUNTER_SHOOT_DURATION = toMs(cfg.nightActionDuration, 30)
    this.WOLF_KING_CLAW_DURATION = toMs(cfg.nightActionDuration, 30)
  }

  /**
   * 清除指定群组的阶段计时器（如投票提醒）。
   * @param {string} groupId 群组ID
   */
  clearPhaseTimer(groupId) {
    if (this.phaseTimers.has(groupId)) {
      clearTimeout(this.phaseTimers.get(groupId))
      this.phaseTimers.delete(groupId)
      console.log(`[${PLUGIN_NAME}] Cleared phase timer for group ${groupId}.`)
    }
  }

  /**
   * 生成本局游戏的战报摘要。
   * @param {object} game 游戏实例
   * @returns {string}
   */
  generateGameSummary(game) {
    if (!game.gameState.eventLog || game.gameState.eventLog.length === 0) {
      return "本局游戏没有详细的事件记录。"
    }

    let summary = "--- 本局战报回放 ---\n"
    const eventsByDay = {}
    game.gameState.eventLog.forEach(event => {
      if (!eventsByDay[event.day]) {
        eventsByDay[event.day] = { night: [], day: [] }
      }
      if (event.phase === 'night') {
        eventsByDay[event.day].night.push(event)
      } else {
        eventsByDay[event.day].day.push(event)
      }
    })

    for (const day in eventsByDay) {
      if (day === '0') continue
      summary += `\n【第 ${day} 天】\n`
      const { night: nightEvents, day: dayPhaseEvents } = eventsByDay[day]

      if (nightEvents.length > 0) {
        summary += "  [夜晚]\n"
        const guardAction = nightEvents.find(e => e.type === 'GUARD_PROTECT')
        if (guardAction) summary += `    - 守卫 ${guardAction.actor} 守护了 ${guardAction.target}。\n`

        const seerAction = nightEvents.find(e => e.type === 'SEER_CHECK')
        if (seerAction) summary += `    - 预言家 ${seerAction.actor} 查验了 ${seerAction.target}，结果为【${seerAction.result === ROLES.WEREWOLF ? '狼人' : '好人'}】。\n`

        const wolfAction = nightEvents.find(e => e.type === 'WEREWOLF_ATTACK')
        const witchSave = nightEvents.find(e => e.type === 'WITCH_SAVE')
        const witchKill = nightEvents.find(e => e.type === 'WITCH_KILL')

        if (wolfAction) summary += `    - 狼人团队袭击了 ${wolfAction.target}。\n`
        if (witchSave) summary += `    - 女巫 ${witchSave.actor} 使用了解药，救活了 ${witchSave.target}。\n`
        if (witchKill) summary += `    - 女巫 ${witchKill.actor} 使用了毒药，毒杀了 ${witchKill.target}。\n`

        const nightHunterShoot = nightEvents.find(e => e.type === 'HUNTER_SHOOT')
        if (nightHunterShoot) summary += `    - 死亡的猎人 ${nightHunterShoot.actor} 在夜晚开枪带走了 ${nightHunterShoot.target}。\n`

        const nightWolfKingClaw = nightEvents.find(e => e.type === 'WOLF_KING_CLAW')
        if (nightWolfKingClaw) summary += `    - 死亡的狼王 ${nightWolfKingClaw.actor} 在夜晚发动技能带走了 ${nightWolfKingClaw.target}。\n`
      }

      if (dayPhaseEvents.length > 0) {
        summary += "  [白天]\n"
        const selfDestruct = dayPhaseEvents.find(e => e.type === 'SELF_DESTRUCT')
        if (selfDestruct) {
          let selfDestructMsg = `    - ${selfDestruct.actor} 选择了自爆。`
          if (selfDestruct.message) {
            selfDestructMsg += ` 遗言：“${selfDestruct.message}”。\n`
          } else {
            selfDestructMsg += `\n`
          }
          summary += selfDestructMsg
        }

        const voteOut = dayPhaseEvents.find(e => e.type === 'VOTE_OUT')
        if (voteOut) summary += `    - 经过投票，${voteOut.target} 被放逐 (投票者: ${voteOut.voters.join(', ')})。\n`

        const dayHunterShoot = dayPhaseEvents.find(e => e.type === 'HUNTER_SHOOT')
        if (dayHunterShoot) summary += `    - 被放逐的猎人 ${dayHunterShoot.actor} 开枪带走了 ${dayHunterShoot.target}。\n`

        const dayWolfKingClaw = dayPhaseEvents.find(e => e.type === 'WOLF_KING_CLAW')
        if (dayWolfKingClaw) summary += `    - 被放逐的狼王 ${dayWolfKingClaw.actor} 发动技能带走了 ${dayWolfKingClaw.target}。\n`
      }
    }
    return summary.trim()
  }

  /**
   * 私聊发送玩家角色身份和技能说明。
   */
  async sendRolesToPlayers(groupId, game) {
    await this.sendSystemGroupMsg(groupId, "正在私聊发送角色身份和临时编号...")

    const wolfRoles = [ROLES.WEREWOLF, ROLES.WOLF_KING, ROLES.WHITE_WOLF_KING]
    const werewolfPlayers = game.players.filter(p => wolfRoles.includes(p.role))
    const werewolfTeamInfo = werewolfPlayers.map(p => `${p.nickname}(${p.tempId}号) - [${game.roles[p.role]}]`).join('、')

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
    }

    for (const player of game.players) {
      const roleName = game.roles[player.role] || '未知角色'
      let message = `你在本局狼人杀中的身份是：【${roleName}】\n你的临时编号是：【${player.tempId}号】`

      const description = roleDescriptions[player.role]
      if (description) message += `\n\n${description}`

      if (wolfRoles.includes(player.role)) {
        message += werewolfPlayers.length > 1
          ? `\n\n你的狼队友是：${werewolfTeamInfo}。`
          : `\n\n你是本局唯一的狼人。`
      }

      await this.sendDirectMessage(player.userId, message, groupId)
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    await this.sendSystemGroupMsg(groupId, "所有身份已发送完毕！")
  }

  /**
   * 开始夜晚阶段（狼人/预言家/守卫行动）。
   */
  async startNightPhase(groupId, game) {
    if (!game) return
    game.gameState.status = 'night_phase_1'
    game.gameState.currentDay++

    game.gameState.deadline = Date.now() + this.WEREWOLF_PHASE_DURATION
    await redis.zAdd(DEADLINE_KEY, [{ score: game.gameState.deadline, value: String(groupId) }])
    await this.saveGameAll(groupId, game)

    await this.sendSystemGroupMsg(groupId, `--- 第 ${game.gameState.currentDay} 天 - 夜晚 ---`)
    await this.sendSystemGroupMsg(groupId, `天黑请闭眼... 狼人等角色行动阶段开始，时长 ${this.WEREWOLF_PHASE_DURATION / 1000} 秒。\n【夜晚行动阶段】有身份的玩家请根据私聊提示进行操作。`)

    if (AUTO_MUTE_ENABLED && game.gameState.hasPermission) {
      await this.sendSystemGroupMsg(groupId, "正在禁言所有存活玩家...")
      await this.muteAllPlayers(groupId, game, true, 3600)
    }

    const alivePlayerList = game.getAlivePlayerList()
    for (const player of game.players.filter(p => p.isAlive)) {
      let prompt = null
      switch (player.role) {
        case 'WEREWOLF':
          prompt = `狼人请行动。\n请私聊我：杀 [编号]\n可使用#狼聊或#w开头在夜晚的狼人频道进行发言。\n请在 ${this.WEREWOLF_PHASE_DURATION / 1000} 秒内完成操作。\n${alivePlayerList}`
          break
        case 'SEER':
          prompt = `预言家请行动。\n请私聊我：查验 [编号]\n请在 ${this.WEREWOLF_PHASE_DURATION / 1000} 秒内完成操作。\n${alivePlayerList}`
          break
        case 'GUARD': {
          let guardPrompt = `守卫请行动。\n`
          if (game.gameState.lastProtectedId) guardPrompt += `（你上晚守护了 ${game.getPlayerInfo(game.gameState.lastProtectedId)}，不能连守）\n`
          prompt = guardPrompt + `请私聊我：守 [编号]\n请在 ${this.WEREWOLF_PHASE_DURATION / 1000} 秒内完成操作。\n${alivePlayerList}`
          break
        }
      }
      if (prompt) await this.sendDirectMessage(player.userId, prompt, groupId)
    }
  }

  /**
   * 过渡到夜晚阶段二 - 女巫行动。
   */
  async transitionToWitchPhase(groupId, game) {
    if (!game || game.gameState.status !== 'night_phase_1') return
    game.gameState.status = 'night_phase_2'

    if (game.gameState.pendingNightActions['WEREWOLF']) {
      game.gameState.nightActions['WEREWOLF'] = game.gameState.pendingNightActions['WEREWOLF']
    }

    const attackTargetId = game.getWerewolfAttackTargetId()

    game.gameState.deadline = Date.now() + this.WITCH_ACTION_DURATION
    await redis.zAdd(DEADLINE_KEY, [{ score: game.gameState.deadline, value: String(groupId) }])
    await this.saveGameAll(groupId, game)

    const witchPlayer = game.players.find(p => p.role === 'WITCH' && p.isAlive)
    if (!witchPlayer) return

    let witchPrompt = `女巫请行动。\n`
    if (attackTargetId) {
      witchPrompt += `昨晚 ${game.getPlayerInfo(attackTargetId)} 被袭击了。\n`
    } else {
      witchPrompt += `昨晚无人被袭击（狼人未行动或平票未统一）。\n`
    }
    witchPrompt += `药剂状态：解药 ${game.potions.save ? '可用' : '已用'}，毒药 ${game.potions.kill ? '可用' : '已用'}。\n`
    if (game.potions.save) witchPrompt += `使用解药请私聊我：救 [编号]\n`
    if (game.potions.kill) witchPrompt += `使用毒药请私聊我：毒 [编号]\n`
    witchPrompt += `你的行动时间为 ${this.WITCH_ACTION_DURATION / 1000} 秒。\n${game.getAlivePlayerList()}`

    await this.sendDirectMessage(witchPlayer.userId, witchPrompt, groupId)
    await this.sendSystemGroupMsg(groupId, `狼人行动结束，开始女巫单独行动...`)
  }

  /**
   * 夜晚阶段结束，进行结算并推进下一阶段。
   */
  async processNightEnd(groupId, game) {
    if (!game || game.gameState.status !== 'night_phase_2') return

    this.clearPhaseTimer(groupId)
    game.gameState.deadline = null

    await this.sendSystemGroupMsg(groupId, "天亮了，进行夜晚结算...")
    const result = game.processNightActions()

    await this.saveGameAll(groupId, game)
    await this.sendSystemGroupMsg(groupId, result.summary)

    if (result.gameEnded) {
      await this.endGameFlow(groupId, game, result.winner)
    } else if (result.needsHunterShoot) {
      await this.startHunterShootPhase(groupId, game)
    } else if (result.needsWolfKingClaw) {
      await this.startWolfKingClawPhase(groupId, game)
    } else {
      await this.transitionToNextPhase(groupId, game)
    }
  }

  /**
   * 发言超时处理。
   */
  async processSpeechTimeout(groupId, game, context) {
    if (!game || game.gameState.status !== 'day_speak') {
      console.log(`[${PLUGIN_NAME}] [超时处理-废弃] 游戏(群:${groupId})状态已不是day_speak，忽略过期的发言超时。`)
      return
    }
    if (context?.speakerId && context.speakerId !== game.gameState.currentSpeakerUserId) {
      console.log(`[${PLUGIN_NAME}] [超时处理-废弃] 游戏(群:${groupId})当前发言人已变更，忽略过期的发言超时。`)
      return
    }

    const timedOutSpeaker = game.players.find(p => p.userId === game.gameState.currentSpeakerUserId)
    if (!timedOutSpeaker) return

    await this.sendSystemGroupMsg(groupId, `${timedOutSpeaker.nickname}(${timedOutSpeaker.tempId}号) 发言时间到。`)

    if (game.gameState.hasPermission) {
      await this.mutePlayer(groupId, timedOutSpeaker.userId, 3600)
    }

    game.gameState.deadline = null
    await this.saveGameField(groupId, game, 'gameState')

    const nextSpeakerUserId = game.moveToNextSpeaker()

    if (nextSpeakerUserId) {
      await this.announceAndSetSpeechTimer(groupId, game)
    } else {
      await this.sendSystemGroupMsg(groupId, "所有玩家发言完毕，进入投票阶段。")
      await this.startVotingPhase(groupId, game)
    }
  }

  /**
   * 宣布当前发言玩家并设置发言计时器。
   */
  async announceAndSetSpeechTimer(groupId, game) {
    if (!game || game.gameState.status !== 'day_speak' || !game.gameState.currentSpeakerUserId) return
    const speaker = game.players.find(p => p.userId === game.gameState.currentSpeakerUserId)
    if (!speaker) return

    game.gameState.deadline = Date.now() + this.SPEECH_DURATION
    await redis.zAdd(DEADLINE_KEY, [{ score: game.gameState.deadline, value: String(groupId) }])
    await this.saveGameField(groupId, game, 'gameState')

    const msg = [segment.at(speaker.userId), ` 请开始发言 (${this.SPEECH_DURATION / 1000}秒)\n发送#结束发言或“过”以结束你的发言。`]

    if (game.gameState.hasPermission) {
      await this.mutePlayer(groupId, speaker.userId, 0)
    }

    await this.sendSystemGroupMsg(groupId, msg)
  }

  /**
   * 开始白天发言阶段。
   */
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

  /**
   * 开始投票阶段。
   */
  async startVotingPhase(groupId, game) {
    game.gameState.status = 'day_vote'
    game.gameState.deadline = Date.now() + this.VOTE_DURATION
    await redis.zAdd(DEADLINE_KEY, [{ score: game.gameState.deadline, value: String(groupId) }])
    await this.saveGameField(groupId, game, 'gameState')

    const alivePlayerList = game.getAlivePlayerList()

    if (game.gameState.hasPermission) {
      await this.sendSystemGroupMsg(groupId, "进入投票阶段，解除所有存活玩家禁言。")
      await this.unmuteAllPlayers(groupId, game, true)
    }

    await this.sendSystemGroupMsg(groupId, `现在开始投票，请选择你要投出的人。\n发送 #投票 [编号] 或 #投票 弃票\n你有 ${this.VOTE_DURATION / 1000} 秒时间。\n存活玩家：\n${alivePlayerList}`)

    this.clearPhaseTimer(groupId)

    const reminderDelay = this.VOTE_DURATION - 15 * 1000
    if (reminderDelay > 0) {
      const timerId = setTimeout(async () => {
        const currentGame = await this.getGameInstance(groupId)
        if (!currentGame || currentGame.gameState.status !== 'day_vote' || !currentGame.gameState.isRunning) {
          this.phaseTimers.delete(groupId)
          return
        }

        const alivePlayers = currentGame.players.filter(p => p.isAlive)
        const votedUserIds = Object.keys(currentGame.gameState.votes)
        const unvotedPlayers = alivePlayers.filter(p => !votedUserIds.includes(p.userId))

        if (unvotedPlayers.length > 0) {
          let reminderMsg = [segment.text('【投票提醒】投票时间剩余15秒，请以下玩家尽快投票：\n')]
          unvotedPlayers.forEach(p => {
            reminderMsg.push(segment.at(p.userId))
            reminderMsg.push(segment.text(' '))
          })
          await this.sendSystemGroupMsg(groupId, reminderMsg)
        }
        this.phaseTimers.delete(groupId)
      }, reminderDelay)

      this.phaseTimers.set(groupId, timerId)
    }
  }

  /**
   * 投票阶段结束，计票并结算。
   */
  async processVoteEnd(groupId, game) {
    game = await this.getGameInstance(groupId)
    if (!game || game.gameState.status !== 'day_vote') return
    game.gameState.deadline = null
    await this.sendSystemGroupMsg(groupId, "投票时间结束，正在计票...")

    const result = game.processVotes()

    if (result.idiotRevealed) {
      await this.saveGameField(groupId, game, 'players')
      console.log(`[${PLUGIN_NAME}] [DEBUG] Idiot revealed, saved player data for group ${groupId}`)
    }

    await this.saveGameAll(groupId, game)
    await this.sendSystemGroupMsg(groupId, result.summary)

    if (result.gameEnded) {
      await this.endGameFlow(groupId, game, result.winner)
    } else if (result.needsHunterShoot) {
      await this.startHunterShootPhase(groupId, game)
    } else if (result.needsWolfKingClaw) {
      await this.startWolfKingClawPhase(groupId, game)
    } else {
      await this.transitionToNextPhase(groupId, game)
    }
  }

  /**
   * 猎人开枪阶段。
   */
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

  /**
   * 猎人开枪阶段结束。
   */
  async processHunterShootEnd(groupId, game) {
    if (!game || game.gameState.status !== 'hunter_shooting') return

    game.gameState.deadline = null
    await redis.zRem(DEADLINE_KEY, String(groupId))

    const hunterInfo = game.getPlayerInfo(game.gameState.hunterNeedsToShoot)
    await this.sendSystemGroupMsg(groupId, `猎人 ${hunterInfo} 选择不开枪（或超时）。`)

    const gameStatus = game.checkGameStatus()
    if (gameStatus.isEnd) {
      await this.endGameFlow(groupId, game, gameStatus.winner)
    } else {
      game.gameState.status = 'day_speak'
      await this.saveGameAll(groupId, game)
      await this.transitionToNextPhase(groupId, game)
    }
  }

  /**
   * 狼王（或白狼王自爆）发动技能阶段。
   */
  async startWolfKingClawPhase(groupId, game, isWhiteWolfKing = false) {
    if (!game || (game.gameState.status !== 'wolf_king_clawing' && !isWhiteWolfKing) || !game.gameState.wolfKingNeedsToClaw) return

    const wolfKingUserId = game.gameState.wolfKingNeedsToClaw
    game.gameState.deadline = Date.now() + this.WOLF_KING_CLAW_DURATION
    await redis.zAdd(DEADLINE_KEY, [{ score: game.gameState.deadline, value: String(groupId) }])
    await this.saveGameField(groupId, game, 'gameState')

    const wolfKingInfo = game.getPlayerInfo(wolfKingUserId)
    const alivePlayerList = game.getAlivePlayerList()
    const promptMsg = isWhiteWolfKing
      ? `白狼王 ${wolfKingInfo} 自爆了！请选择一名玩家带走！`
      : `${wolfKingInfo} 是狼王！临死前可以选择发动技能带走一人！`

    await this.sendSystemGroupMsg(groupId, `${promptMsg}\n你有 ${this.WOLF_KING_CLAW_DURATION / 1000} 秒时间。\n存活玩家：\n${alivePlayerList}`)
    await this.sendDirectMessage(wolfKingUserId, `你是${isWhiteWolfKing ? '白狼王' : '狼王'}，请发动技能！\n发送 #狼爪 [编号]\n你有 ${this.WOLF_KING_CLAW_DURATION / 1000} 秒时间。\n${alivePlayerList}`, groupId)
  }

  /**
   * 狼王技能阶段结束。
   */
  async processWolfKingClawEnd(groupId, game) {
    if (!game || game.gameState.status !== 'wolf_king_clawing') return

    game.gameState.deadline = null
    await redis.zRem(DEADLINE_KEY, String(groupId))

    const wolfKingInfo = game.getPlayerInfo(game.gameState.wolfKingNeedsToClaw)
    await this.sendSystemGroupMsg(groupId, `狼王 ${wolfKingInfo} 选择不发动技能（或超时）。`)

    game.gameState.eventLog.push({
      day: game.gameState.currentDay,
      phase: game.gameState.currentPhase === 'DAY' ? 'day' : 'night',
      type: 'WOLF_KING_CLAW_TIMEOUT',
      actor: wolfKingInfo
    })

    const gameStatus = game.checkGameStatus()
    if (gameStatus.isEnd) {
      await this.endGameFlow(groupId, game, gameStatus.winner)
    } else {
      game.gameState.status = 'night_phase_1'
      await this.saveGameAll(groupId, game)
      await this.transitionToNextPhase(groupId, game)
    }
  }

  /**
   * 根据当前状态推进下一阶段。
   */
  async transitionToNextPhase(groupId, game) {
    if (!game || game.gameState.status === 'ended') return
    const nextStatus = game.gameState.status
    console.log(`[${PLUGIN_NAME}] 状态转换 -> ${nextStatus} (群: ${groupId})`)
    switch (nextStatus) {
      case 'night_phase_1': await this.startNightPhase(groupId, game); break
      case 'day_speak': await this.startDayPhase(groupId, game); break
      default: console.warn(`[${PLUGIN_NAME}] 未知或非自动转换状态: ${nextStatus} (群: ${groupId})`)
    }
  }

  /**
   * 结束游戏流程：战报 + 最终身份 + 数据清理。
   */
  async endGameFlow(groupId, game, winner) {
    console.log(`[${PLUGIN_NAME}] [DEBUG] endGameFlow - Game ending for group ${groupId}. Winner: ${winner}`)
    const gameSummary = this.generateGameSummary(game)

    const finalRoles = "--- 最终身份公布 ---\n" + game.getFinalRoles()
    const finalMessage = `游戏结束！${winner} 阵营获胜！\n\n` + gameSummary + "\n\n" + finalRoles

    await this.sendSystemGroupMsg(groupId, finalMessage)

    if (game.gameState.hasPermission) {
      await this.unmuteAllPlayers(groupId, game, false)
    }

    await this.deleteGame(groupId)
  }

  /**
   * 轮询检查所有游戏 deadline，处理超时事件。
   */
  async checkAllGameTimers() {
    try {
      const expiredGameIds = await redis.zRangeByScore(DEADLINE_KEY, '-inf', Date.now())
      if (!expiredGameIds || expiredGameIds.length === 0) return

      for (const groupId of expiredGameIds) {
        const removedCount = await redis.zRem(DEADLINE_KEY, String(groupId))
        if (removedCount === 0) continue

        const game = await this.getGameInstance(groupId)
        if (!game || !game.gameState.isRunning) continue

        console.log(`[${PLUGIN_NAME}] [轮询] 检测到 ${game.gameState.status} 超时 (${groupId})`)

        switch (game.gameState.status) {
          case 'night_phase_1':
            await this.transitionToWitchPhase(groupId, game)
            break
          case 'night_phase_2':
            await this.processNightEnd(groupId, game)
            break
          case 'day_speak':
            await this.processSpeechTimeout(groupId, game, { speakerId: game.gameState.currentSpeakerUserId })
            break
          case 'day_vote':
            await this.processVoteEnd(groupId, game)
            break
          case 'hunter_shooting':
            await this.processHunterShootEnd(groupId, game)
            break
          case 'wolf_king_clawing':
            await this.processWolfKingClawEnd(groupId, game)
            break
        }
      }
    } catch (error) {
      console.error(`[${PLUGIN_NAME}] 轮询检查计时器时发生错误:`, error)
    }
  }

  // --- 以下为依赖透传，保持阶段逻辑代码可读性 ---
  async getGameInstance(...args) { return this.repo.getGameInstance(...args) }
  async saveGameAll(...args) { return this.repo.saveGameAll(...args) }
  async saveGameField(...args) { return this.repo.saveGameField(...args) }
  async deleteGame(groupId) {
    this.clearPhaseTimer(groupId)
    return this.repo.deleteGame(groupId)
  }
  async sendSystemGroupMsg(...args) { return this.message.sendSystemGroupMsg(...args) }
  async sendDirectMessage(...args) { return this.message.sendDirectMessage(...args) }
  async mutePlayer(...args) { return this.mute.mutePlayer(...args) }
  async muteAllPlayers(...args) { return this.mute.muteAllPlayers(...args) }
  async unmuteAllPlayers(...args) { return this.mute.unmuteAllPlayers(...args) }
}

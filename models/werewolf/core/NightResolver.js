import { ROLES, TAGS, PLUGIN_NAME } from '../constants.js'

/**
 * 夜晚结算解析器。
 * 说明：原逻辑内嵌在 WerewolfGame.processNightActions 中，现迁出以降低核心类体积。
 * 该解析器会原地修改 game 实例（players/gameState/potions），并返回结算结果。
 *
 * @param {object} game WerewolfGame 实例
 * @returns {object} 结算结果
 */
export function resolveNightActions(game) {
  if (game.gameState.status !== 'night_phase_2') {
    return { message: '非夜晚，无法结算' }
  }

  const currentDay = game.gameState.currentDay
  const logEvent = (event) => game.gameState.eventLog.push({ day: currentDay, phase: 'night', ...event })

  // 1. 初始化: 清理上一晚的临时标签
  game.players.forEach(p => {
    p.tags = p.tags.filter(tag => tag === TAGS.REVEALED_IDIOT)
  })

  // 将本晚所有待处理的行动从 pendingNightActions 转移到 nightActions
  game.gameState.nightActions = {}
  game.gameState.pendingNightActions.forEach(({ role, userId, action }) => {
    if (!game.gameState.nightActions[role]) game.gameState.nightActions[role] = {}
    game.gameState.nightActions[role][userId] = action
  })
  game.gameState.pendingNightActions = []

  // --- 阶段一：守卫行动 ---
  const guardAction = Object.values(game.gameState.nightActions[ROLES.GUARD] || {})[0]
  if (guardAction) {
    const guard = game.players.find(p => p.role === ROLES.GUARD && p.isAlive)
    const target = game.players.find(p => p.tempId === guardAction.targetTempId && p.isAlive)
    if (guard && target && target.userId !== game.gameState.lastProtectedId) {
      target.tags.push(TAGS.GUARDED)
      game.gameState.lastProtectedId = target.userId
      logEvent({ type: 'GUARD_PROTECT', actor: game.getPlayerInfo(guard.userId), target: game.getPlayerInfo(target.userId) })
      console.log(`[${PLUGIN_NAME}] [DEBUG] Guard protected: ${game.getPlayerInfo(target.userId)}`)
    } else {
      game.gameState.lastProtectedId = null
    }
  } else {
    game.gameState.lastProtectedId = null
  }

  // --- 阶段二：狼人袭击 ---
  const killedByWerewolfId = game.getWerewolfAttackTargetId()
  console.log(`[${PLUGIN_NAME}] [DEBUG] processNightActions - killedByWerewolfId: ${killedByWerewolfId}`)

  console.log(`[${PLUGIN_NAME}] [DEBUG] processNightActions - All players:`, game.players.map(p => `${p.nickname}(${p.tempId}) userId: ${p.userId} (type: ${typeof p.userId})`))

  if (killedByWerewolfId) {
    const target = game.players.find(p => String(p.userId) === String(killedByWerewolfId))
    console.log(`[${PLUGIN_NAME}] [DEBUG] processNightActions - Found target:`, target ? `${target.nickname}(${target.tempId})` : 'null')

    if (target) {
      console.log(`[${PLUGIN_NAME}] [DEBUG] processNightActions - Target tags before DYING:`, target.tags)
      target.tags.push(TAGS.DYING)
      console.log(`[${PLUGIN_NAME}] [DEBUG] processNightActions - Target tags after DYING:`, target.tags)

      const werewolfActors = game.players
        .filter(p => [ROLES.WEREWOLF, ROLES.WOLF_KING, ROLES.WHITE_WOLF_KING].includes(p.role) && p.isAlive)
        .map(p => game.getPlayerInfo(p.userId))
      logEvent({ type: 'WEREWOLF_ATTACK', actors: werewolfActors, target: game.getPlayerInfo(target.userId) })
    } else {
      console.log(`[${PLUGIN_NAME}] [DEBUG] processNightActions - Target not found for userId: ${killedByWerewolfId} (type: ${typeof killedByWerewolfId})`)
    }
  }

  // --- 阶段三：女巫行动 ---
  const witchAction = Object.values(game.gameState.nightActions[ROLES.WITCH] || {})[0]
  if (witchAction) {
    const witch = game.players.find(p => p.role === ROLES.WITCH && p.isAlive)
    if (witch) {
      const target = game.players.find(p => p.tempId === witchAction.targetTempId && p.isAlive)
      if (target) {
        if (witchAction.type === 'save' && game.potions.save) {
          target.tags.push(TAGS.SAVED_BY_WITCH)
          game.potions.save = false
          logEvent({ type: 'WITCH_SAVE', actor: game.getPlayerInfo(witch.userId), target: game.getPlayerInfo(target.userId) })
          console.log(`[${PLUGIN_NAME}] [DEBUG] Witch saved: ${game.getPlayerInfo(target.userId)}`)
        }
        if (witchAction.type === 'kill' && game.potions.kill) {
          target.tags.push(TAGS.DYING, TAGS.POISONED_BY_WITCH)
          game.potions.kill = false
          logEvent({ type: 'WITCH_KILL', actor: game.getPlayerInfo(witch.userId), target: game.getPlayerInfo(target.userId) })
          console.log(`[${PLUGIN_NAME}] [DEBUG] Witch poisoned: ${game.getPlayerInfo(target.userId)}`)
        }
      }
    }
  }

  // --- 阶段四：确定最终死亡玩家 ---
  let actualDeaths = []
  let deathCauses = {}

  console.log(`[${PLUGIN_NAME}] [DEBUG] Night Action Processing - Checking for deaths...`)
  game.players.filter(p => p.isAlive).forEach(player => {
    console.log(`[${PLUGIN_NAME}] [DEBUG] Checking player ${game.getPlayerInfo(player.userId)}, tags:`, player.tags)

    if (!player.tags.includes(TAGS.DYING)) {
      console.log(`[${PLUGIN_NAME}] [DEBUG] Player ${game.getPlayerInfo(player.userId)} is alive and not marked as DYING.`)
      return
    }

    console.log(`[${PLUGIN_NAME}] [DEBUG] Player ${game.getPlayerInfo(player.userId)} is marked as DYING. Checking protection/save status.`)
    let shouldDie = true
    let causeOfDeath = 'UNKNOWN'

    const isGuarded = player.tags.includes(TAGS.GUARDED)
    const isSavedByWitch = player.tags.includes(TAGS.SAVED_BY_WITCH)
    const isPoisoned = player.tags.includes(TAGS.POISONED_BY_WITCH)

    console.log(`[${PLUGIN_NAME}] [DEBUG] Player ${game.getPlayerInfo(player.userId)}: isGuarded=${isGuarded}, isSavedByWitch=${isSavedByWitch}, isPoisoned=${isPoisoned}`)

    if (isPoisoned) {
      causeOfDeath = 'WITCH'
      shouldDie = true
      console.log(`[${PLUGIN_NAME}] [DEBUG] Player ${game.getPlayerInfo(player.userId)} was poisoned by Witch.`)
    } else {
      if (isGuarded && isSavedByWitch) {
        causeOfDeath = 'GUARD_WITCH_CONFLICT'
        shouldDie = true
        console.log(`[${PLUGIN_NAME}] [DEBUG] Player ${game.getPlayerInfo(player.userId)} was wolf-attacked, guarded AND saved by Witch (同守同救).`)
      } else if (isGuarded || isSavedByWitch) {
        shouldDie = false
        causeOfDeath = isGuarded ? 'GUARDED' : 'SAVED_BY_WITCH'
        console.log(`[${PLUGIN_NAME}] [DEBUG] Player ${game.getPlayerInfo(player.userId)} was wolf-attacked and ${causeOfDeath}, survived.`)
      } else {
        causeOfDeath = 'WEREWOLF'
        shouldDie = true
        console.log(`[${PLUGIN_NAME}] [DEBUG] Player ${game.getPlayerInfo(player.userId)} was wolf-attacked and NOT protected/saved, will die.`)
      }
    }

    if (shouldDie) {
      deathCauses[player.userId] = causeOfDeath
      actualDeaths.push(player)
      console.log(`[${PLUGIN_NAME}] [DEBUG] Player ${game.getPlayerInfo(player.userId)} added to actualDeaths list. Cause: ${causeOfDeath}`)
    } else {
      console.log(`[${PLUGIN_NAME}] [DEBUG] Player ${game.getPlayerInfo(player.userId)} will NOT die.`)
    }
  })

  // --- 阶段五：天亮，结算后续状态 ---
  let finalSummary = ["夜晚结束，现在公布昨晚发生的事情："]
  if (actualDeaths.length > 0) {
    const deathNames = actualDeaths.map(p => `${p.nickname} (${p.tempId}号)`).join('、')
    finalSummary.push(`${deathNames} 昨晚死亡了。`)
  } else {
    finalSummary.push("昨晚是个平安夜。")
  }

  game.gameState.nightActions = {}

  const deadHunter = actualDeaths.find(p => p.role === ROLES.HUNTER)
  if (deadHunter && deathCauses[deadHunter.userId] !== 'WITCH') {
    game.gameState.status = 'hunter_shooting'
    game.gameState.hunterNeedsToShoot = deadHunter.userId
    game.gameState.currentPhase = 'NIGHT_RESULT'
    actualDeaths.forEach(p => { p.isAlive = false })
    return { success: true, summary: finalSummary.join('\n'), gameEnded: false, needsHunterShoot: true }
  }

  const deadWolfKing = actualDeaths.find(p => p.role === ROLES.WOLF_KING)
  if (deadWolfKing) {
    game.gameState.status = 'wolf_king_clawing'
    game.gameState.wolfKingNeedsToClaw = deadWolfKing.userId
    game.gameState.currentPhase = 'NIGHT_RESULT'
    actualDeaths.forEach(p => { p.isAlive = false })
    return { success: true, summary: finalSummary.join('\n'), gameEnded: false, needsWolfKingClaw: true }
  }

  actualDeaths.forEach(p => { p.isAlive = false })

  const gameStatus = game.checkGameStatus()
  if (gameStatus.isEnd) {
    game.endGame()
    return {
      success: true,
      summary: finalSummary.join('\n'),
      gameEnded: true,
      winner: gameStatus.winner,
      finalRoles: game.getFinalRoles(),
      needsHunterShoot: false
    }
  }

  game.gameState.status = 'day_speak'
  return {
    success: true,
    summary: finalSummary.join('\n'),
    gameEnded: false,
    needsHunterShoot: false
  }
}


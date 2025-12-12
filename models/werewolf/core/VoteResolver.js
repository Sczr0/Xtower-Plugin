import { ROLES, TAGS } from '../constants.js'

/**
 * 白天投票结算解析器。
 * 说明：原逻辑内嵌在 WerewolfGame.processVotes 中，现迁出以降低核心类体积。
 * 该解析器会原地修改 game 实例（players/gameState），并返回结算结果。
 *
 * @param {object} game WerewolfGame 实例
 * @returns {object} 结算结果
 */
export function resolveVotes(game) {
  if (game.gameState.status !== 'day_vote') return { message: '非投票阶段，无法计票' }

  const currentDay = game.gameState.currentDay
  const logEvent = (event) => game.gameState.eventLog.push({ day: currentDay, phase: 'day', ...event })

  const voteCounts = {} // 记录每个玩家获得的票数
  const voteDetails = {} // 记录每个玩家被谁投票
  game.players.filter(p => p.isAlive).forEach(voter => {
    const targetTempId = game.gameState.votes[voter.userId]
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

  let voteSummary = ['投票结果：']
  for (const targetTempId in voteCounts) {
    if (targetTempId === '弃票') continue
    const targetPlayer = game.players.find(p => p.tempId === targetTempId)
    if (targetPlayer) {
      voteSummary.push(`${targetPlayer.nickname}(${targetTempId}号): ${voteCounts[targetTempId]}票 (${(voteDetails[targetTempId] || []).join(', ')})`)
    }
  }
  if (voteCounts['弃票']) {
    voteSummary.push(`弃票: ${voteCounts['弃票']}票 (${(voteDetails['弃票'] || []).join(', ')})`)
  }

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

  game.gameState.votes = {} // 清空投票记录

  if (tiedPlayers.length === 1) { // 有唯一被投出玩家
    const eliminatedPlayer = game.players.find(p => p.tempId === tiedPlayers[0])
    if (eliminatedPlayer) {
      const voters = voteDetails[eliminatedPlayer.tempId] || []
      logEvent({ type: 'VOTE_OUT', target: game.getPlayerInfo(eliminatedPlayer.userId), voters })

      if (eliminatedPlayer.role === ROLES.IDIOT) { // 白痴被投出
        eliminatedPlayer.tags.push(TAGS.REVEALED_IDIOT)
        voteSummary.push(`${eliminatedPlayer.nickname}(${eliminatedPlayer.tempId}号) 被投票出局，但他/她亮出了【白痴】的身份！他/她不会死亡，但将失去后续的投票权。`)
        return {
          success: true,
          summary: voteSummary.join('\n'),
          gameEnded: false,
          idiotRevealed: true,
          revealedIdiotId: eliminatedPlayer.userId
        }
      }

      // 其他角色被投出
      eliminatedPlayer.isAlive = false
      voteSummary.push(`${eliminatedPlayer.nickname} (${eliminatedPlayer.tempId}号) 被投票出局。`)

      if (eliminatedPlayer.role === ROLES.HUNTER) { // 猎人被投出
        game.gameState.status = 'hunter_shooting'
        game.gameState.hunterNeedsToShoot = eliminatedPlayer.userId
        game.gameState.currentPhase = 'DAY'
        return { success: true, summary: voteSummary.join('\n'), gameEnded: false, needsHunterShoot: true }
      }

      if (eliminatedPlayer.role === ROLES.WOLF_KING) { // 狼王被投出
        game.gameState.status = 'wolf_king_clawing'
        game.gameState.wolfKingNeedsToClaw = eliminatedPlayer.userId
        game.gameState.currentPhase = 'DAY'
        return { success: true, summary: voteSummary.join('\n'), gameEnded: false, needsWolfKingClaw: true }
      }
    }
  } else if (tiedPlayers.length > 1) { // 平票
    const sortedTiedPlayers = [...tiedPlayers].sort()
    voteSummary.push(`出现平票 (${sortedTiedPlayers.map(id => `${id}号`).join(', ')})，本轮无人出局。`)
  } else { // 无人被投票或全部弃票
    voteSummary.push('所有人都弃票或投票无效，本轮无人出局。')
  }

  const gameStatus = game.checkGameStatus()
  if (gameStatus.isEnd) {
    game.endGame(gameStatus.winner)
    return {
      success: true,
      summary: voteSummary.join('\n'),
      gameEnded: true,
      winner: gameStatus.winner,
      finalRoles: game.getFinalRoles()
    }
  }

  game.gameState.status = 'night_phase_1'
  return { success: true, summary: voteSummary.join('\n'), gameEnded: false }
}


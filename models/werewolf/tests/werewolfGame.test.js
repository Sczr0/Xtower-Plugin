import test from 'node:test'
import assert from 'node:assert/strict'

import WerewolfGame from '../core/WerewolfGame.js'
import { ROLES, TAGS } from '../constants.js'

/**
 * 离线回归测试：不依赖机器人环境。
 * 只验证核心引擎的关键行为与不变量。
 */

function makePlayers(count) {
  return Array.from({ length: count }, (_, i) => ({
    userId: `u${i + 1}`,
    nickname: `p${i + 1}`,
    tempId: String(i + 1).padStart(2, '0'),
    isAlive: true,
    tags: [],
    role: null
  }))
}

test('calculateRoleDistribution for 6 players', () => {
  const game = new WerewolfGame({ players: makePlayers(6), gameState: { status: 'waiting' } })
  const distribution = game.calculateRoleDistribution()

  assert.equal(distribution[ROLES.WEREWOLF], 2)
  assert.equal(distribution[ROLES.VILLAGER], 2)
  assert.equal(distribution[ROLES.SEER], 1)
  assert.equal(distribution[ROLES.GUARD], 1)
})

test('assignRoles respects distribution counts', () => {
  const game = new WerewolfGame({ players: makePlayers(6), gameState: { status: 'waiting' } })
  const distribution = {
    [ROLES.WEREWOLF]: 2,
    [ROLES.VILLAGER]: 2,
    [ROLES.SEER]: 1,
    [ROLES.GUARD]: 1
  }
  const result = game.assignRoles(distribution)
  assert.equal(result.success, true)

  const counts = {}
  for (const p of game.players) {
    counts[p.role] = (counts[p.role] || 0) + 1
  }
  assert.equal(counts[ROLES.WEREWOLF], 2)
  assert.equal(counts[ROLES.VILLAGER], 2)
  assert.equal(counts[ROLES.SEER], 1)
  assert.equal(counts[ROLES.GUARD], 1)
})

test('recordNightAction + processNightActions kills target when unprotected', () => {
  const players = makePlayers(2)
  players[0].role = ROLES.WEREWOLF
  players[1].role = ROLES.VILLAGER

  const game = new WerewolfGame({
    players,
    gameState: {
      status: 'night_phase_1',
      currentDay: 1,
      pendingNightActions: [],
      nightActions: {},
      eventLog: [],
      lastProtectedId: null
    },
    potions: { save: true, kill: true }
  })

  const wolf = players[0]
  const target = players[1]

  const rec = game.recordNightAction(ROLES.WEREWOLF, wolf.userId, { type: 'kill', targetTempId: target.tempId })
  assert.equal(rec.success, true)

  game.gameState.status = 'night_phase_2'
  const res = game.processNightActions()
  assert.equal(res.success, true)
  assert.equal(target.isAlive, false)
})

test('processVotes reveals idiot and blocks further voting', () => {
  const players = makePlayers(3)
  players[0].role = ROLES.IDIOT
  players[1].role = ROLES.VILLAGER
  players[2].role = ROLES.WEREWOLF

  const game = new WerewolfGame({
    players,
    gameState: {
      status: 'day_vote',
      currentDay: 1,
      votes: {
        [players[1].userId]: players[0].tempId,
        [players[2].userId]: players[0].tempId,
        [players[0].userId]: players[1].tempId
      },
      eventLog: []
    }
  })

  const res = game.processVotes()
  assert.equal(res.success, true)
  assert.equal(res.idiotRevealed, true)
  assert.equal(res.revealedIdiotId, players[0].userId)
  assert.equal(players[0].isAlive, true)
  assert.ok(players[0].tags.includes(TAGS.REVEALED_IDIOT))

  game.gameState.status = 'day_vote'
  const voteRes = game.recordVote(players[0].userId, players[2].tempId)
  assert.equal(voteRes.success, false)
  assert.match(voteRes.message, /白痴翻牌后无法投票/)
})

test('processNightActions makes target die on guard+witch save conflict', () => {
  const players = makePlayers(4)
  const [wolf, guard, witch, target] = players
  wolf.role = ROLES.WEREWOLF
  guard.role = ROLES.GUARD
  witch.role = ROLES.WITCH
  target.role = ROLES.VILLAGER

  const game = new WerewolfGame({
    players,
    gameState: {
      status: 'night_phase_1',
      currentDay: 1,
      pendingNightActions: [],
      nightActions: {},
      eventLog: [],
      lastProtectedId: null
    },
    potions: { save: true, kill: true }
  })

  assert.equal(game.recordNightAction(ROLES.WEREWOLF, wolf.userId, { type: 'kill', targetTempId: target.tempId }).success, true)
  assert.equal(game.recordNightAction(ROLES.GUARD, guard.userId, { targetTempId: target.tempId }).success, true)
  assert.equal(game.recordNightAction(ROLES.WITCH, witch.userId, { type: 'save', targetTempId: target.tempId }).success, true)

  game.gameState.status = 'night_phase_2'
  const res = game.processNightActions()
  assert.equal(res.success, true)
  assert.equal(target.isAlive, false)
})

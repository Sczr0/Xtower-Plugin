import { PLUGIN_NAME } from '../constants.js'

/**
 * @class MuteService
 * @description 统一封装狼人杀模块的禁言/解禁能力。
 * 职责：单人禁言、全体禁言、全体解禁。
 */
export default class MuteService {
  /**
   * 禁言或解禁指定玩家。
   * @param {string} groupId 群组ID
   * @param {string} userId 用户ID
   * @param {number} duration 禁言时长（秒），0 表示解禁
   */
  async mutePlayer(groupId, userId, duration) {
    try {
      const group = Bot.pickGroup(groupId)
      await group.muteMember(userId, duration)
    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 禁言/解禁玩家 ${userId} 失败 (群: ${groupId}):`, err)
    }
  }

  /**
   * 禁言群组内所有玩家。
   * @param {string} groupId 群组ID
   * @param {object} game 游戏实例
   * @param {boolean} onlyAlive 是否只禁言存活玩家
   * @param {number} duration 禁言时长（秒）
   */
  async muteAllPlayers(groupId, game, onlyAlive = true, duration = 3600) {
    const playersToMute = onlyAlive ? game.players.filter(p => p.isAlive) : game.players
    for (const player of playersToMute) {
      await this.mutePlayer(groupId, player.userId, duration)
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  /**
   * 解禁群组内所有玩家。
   * @param {string} groupId 群组ID
   * @param {object} game 游戏实例
   * @param {boolean} onlyAlive 是否只解禁存活玩家
   */
  async unmuteAllPlayers(groupId, game, onlyAlive = false) {
    const playersToUnmute = onlyAlive ? game.players.filter(p => p.isAlive) : game.players
    const logMessage = onlyAlive ? '存活玩家' : '所有玩家'
    console.log(`[${PLUGIN_NAME}] [解禁] 正在解禁 ${logMessage} (群: ${groupId})`)

    for (const player of playersToUnmute) {
      await this.mutePlayer(groupId, player.userId, 0)
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
}


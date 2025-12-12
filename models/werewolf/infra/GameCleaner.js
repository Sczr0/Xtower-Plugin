import GameDataManager from './GameDataManager.js'
import { PLUGIN_NAME } from '../constants.js'

/**
 * @class GameCleaner
 * @description 负责管理游戏超时自动清理机制。
 * 职责：注册、清理单个游戏或所有游戏的超时计时器。
 */
export default class GameCleaner {
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

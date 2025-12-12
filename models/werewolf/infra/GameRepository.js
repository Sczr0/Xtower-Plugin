import WerewolfGame from '../core/WerewolfGame.js'
import GameDataManager from './GameDataManager.js'
import GameCleaner from './GameCleaner.js'
import { PLUGIN_NAME, DEADLINE_KEY, USER_GROUP_KEY_PREFIX } from '../constants.js'

/**
 * @class GameRepository
 * @description 游戏实例与持久化仓储。
 * 职责：
 * 1) 管理内存缓存（gameInstances / userToGroupCache）
 * 2) 与 Redis 交互加载/保存/删除
 * 3) 负责自动清理计时器的注册与清理
 */
export default class GameRepository {
  /**
   * @param {object} pluginInstance WerewolfPlugin 实例（用于自动清理回调）
   */
  constructor(pluginInstance) {
    this.plugin = pluginInstance
    this.gameInstances = new Map()
    this.userToGroupCache = new Map()
  }

  /**
   * 获取指定群组的游戏实例。
   * @param {string} groupId 群组ID
   * @param {boolean} createIfNotExist 不存在时是否创建
   * @param {string|null} hostUserId 创建时的房主ID
   * @param {string|null} hostNickname 创建时的房主昵称
   * @returns {Promise<WerewolfGame|null>}
   */
  async getGameInstance(groupId, createIfNotExist = false, hostUserId = null, hostNickname = null) {
    if (this.gameInstances.has(groupId)) {
      return this.gameInstances.get(groupId)
    }

    const gameData = await GameDataManager.load(groupId)
    let game = null

    if (gameData) {
      game = new WerewolfGame(gameData)
      this.gameInstances.set(groupId, game)
      if (game.gameState?.isRunning) {
        GameCleaner.registerGame(groupId, this.plugin)
      }
    } else if (createIfNotExist && hostUserId && hostNickname) {
      game = new WerewolfGame()
      this.gameInstances.set(groupId, game)
      GameCleaner.registerGame(groupId, this.plugin)
    }

    return game
  }

  /**
   * 更新内存缓存中的游戏实例。
   */
  updateMemoryCache(groupId, game) {
    if (game) this.gameInstances.set(groupId, game)
  }

  /**
   * 全量保存游戏数据到 Redis。
   */
  async saveGameAll(groupId, game) {
    if (!game) return
    await GameDataManager.saveAll(groupId, game.getGameData())
    this.updateMemoryCache(groupId, game)
  }

  /**
   * 保存游戏实例的单个字段到 Redis。
   */
  async saveGameField(groupId, game, fieldName) {
    if (!game) return
    const dataToSave = game.getGameData()[fieldName] !== undefined ? game.getGameData()[fieldName] : game[fieldName]
    if (dataToSave === undefined) {
      console.warn(`[${PLUGIN_NAME}] Attempted to save non-existent field "${fieldName}" for group ${groupId}.`)
      return
    }
    await GameDataManager.saveField(groupId, fieldName, dataToSave)
    this.updateMemoryCache(groupId, game)
  }

  /**
   * 删除指定群组的游戏数据（Redis + 内存 + 玩家映射）。
   * 注意：阶段计时器应由 PhaseService 先行清理。
   */
  async deleteGame(groupId) {
    GameCleaner.cleanupGame(groupId)
    const game = this.gameInstances.get(groupId)
    if (game) {
      const userIds = game.players.map(p => p.userId)
      if (userIds.length > 0) {
        userIds.forEach(id => this.userToGroupCache.delete(id))
        const keysToDelete = userIds.map(id => `${USER_GROUP_KEY_PREFIX}${id}`)
        await redis.del(keysToDelete)
      }
    }

    this.gameInstances.delete(groupId)
    await GameDataManager.delete(groupId)
    await redis.zRem(DEADLINE_KEY, String(groupId))
    console.log(`[${PLUGIN_NAME}] 已删除游戏数据 (${groupId})`)
  }

  /**
   * 查找用户当前参与的活跃游戏。
   * @param {string} userId 用户ID
   * @param {boolean} includeDead 是否允许已死亡玩家匹配
   * @returns {Promise<{groupId:string, instance:WerewolfGame}|null>}
   */
  async findUserActiveGame(userId, includeDead = false) {
    try {
      let groupId = this.userToGroupCache.get(userId)
      if (!groupId) {
        groupId = await redis.get(`${USER_GROUP_KEY_PREFIX}${userId}`)
        if (groupId) this.userToGroupCache.set(userId, groupId)
      }

      if (groupId) {
        const game = await this.getGameInstance(groupId)
        const playerExists = game && game.players.some(p => p.userId === userId && (includeDead || p.isAlive))
        if (playerExists) return { groupId, instance: game }
      }
    } catch (error) {
      console.error(`[${PLUGIN_NAME}] 查找用户游戏时出错:`, error)
    }
    return null
  }

  /**
   * 写入用户->群组的内存映射。
   */
  cacheUserGroup(userId, groupId) {
    this.userToGroupCache.set(userId, groupId)
  }

  /**
   * 清理用户->群组的内存映射。
   */
  uncacheUserGroup(userId) {
    this.userToGroupCache.delete(userId)
  }
}


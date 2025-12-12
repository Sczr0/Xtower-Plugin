import { PLUGIN_NAME, GAME_KEY_PREFIX, GAME_DATA_EXPIRATION } from '../constants.js'

/**
 * @class GameDataManager
 * @description 负责狼人杀游戏数据在 Redis 中的存取。
 * 职责：加载、保存、更新特定字段、删除游戏数据，并生成临时玩家ID。
 */
export default class GameDataManager {
  /**
   * 获取指定群组ID对应的Redis键名。
   * @param {string} groupId - 群组ID。
   * @returns {string} Redis键名。
   */
  static getRedisKey(groupId) {
    return `${GAME_KEY_PREFIX}${groupId}`
  }

  /**
   * 从Redis加载指定群组的游戏数据。
   * @param {string} groupId - 群组ID。
   * @returns {Promise<object|null>} 游戏数据对象或null。
   */
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
      await redis.del(key) // 出现解析错误时，删除可能损坏的数据
      return null
    }
  }

  /**
   * 全量保存游戏数据到Redis。
   * @param {string} groupId - 群组ID。
   * @param {object} data - 完整的游戏数据对象。
   * @returns {Promise<void>}
   */
  static async saveAll(groupId, data) {
    const key = this.getRedisKey(groupId)
    try {
      const multi = redis.multi(); // 获取一个事务对象

      multi.hSet(key, 'players', JSON.stringify(data.players || []));
      multi.hSet(key, 'roles', JSON.stringify(data.roles || {}));
      multi.hSet(key, 'gameState', JSON.stringify(data.gameState || {}));
      multi.hSet(key, 'potions', JSON.stringify(data.potions || {}));
      multi.hSet(key, 'userGroupMap', JSON.stringify(data.userGroupMap || {}));
      multi.expire(key, GAME_DATA_EXPIRATION); // 设置过期时间

      await multi.exec(); // 执行所有排队的命令

    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 全量保存游戏数据到 Redis 失败 (${groupId}):`, err)
    }
  }

  /**
   * 更新Redis中游戏数据的单个字段。
   * @param {string} groupId - 群组ID。
   * @param {string} fieldName - 要更新的字段名。
   * @param {any} data - 字段的新数据。
   * @returns {Promise<void>}
   */
  static async saveField(groupId, fieldName, data) {
    const key = this.getRedisKey(groupId)
    try {
      await redis.hSet(key, fieldName, JSON.stringify(data))
      await redis.expire(key, GAME_DATA_EXPIRATION) // 每次更新也刷新过期时间
    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 更新游戏字段 [${fieldName}] 到 Redis 失败 (${groupId}):`, err)
    }
  }

  /**
   * 从Redis删除指定群组的游戏数据。
   * @param {string} groupId - 群组ID。
   * @returns {Promise<void>}
   */
  static async delete(groupId) {
    const key = this.getRedisKey(groupId)
    try {
      await redis.del(key)
    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 从 Redis 删除游戏数据失败 (${groupId}):`, err)
    }
  }

  /**
   * 为新玩家生成一个不重复的两位数字临时ID。
   * @param {Array<object>} players - 当前游戏中的玩家列表。
   * @returns {string} 生成的临时ID (例如 '01', '02')。
   */
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

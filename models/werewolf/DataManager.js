/**
 * @class DataManager
 * @description 负责狼人杀游戏数据在 Redis 中的存取
 * 职责：加载、保存、更新特定字段、删除游戏数据，并生成临时玩家ID
 */

const GAME_KEY_PREFIX = 'werewolf_v2:game:';
const USER_GROUP_KEY_PREFIX = 'werewolf_v2:user_to_group:';
const GAME_DATA_EXPIRATION = 6 * 60 * 60; // 6小时后自动过期

export class DataManager {
  /**
   * 获取指定群组ID对应的Redis键名
   * @param {string} groupId - 群组ID
   * @returns {string} Redis键名
   */
  static getRedisKey(groupId) {
    return `${GAME_KEY_PREFIX}${groupId}`;
  }

  /**
   * 获取用户群组映射的Redis键名
   * @param {string} userId - 用户ID
   * @returns {string} Redis键名
   */
  static getUserGroupKey(userId) {
    return `${USER_GROUP_KEY_PREFIX}${userId}`;
  }

  /**
   * 从Redis加载指定群组的游戏数据
   * @param {string} groupId - 群组ID
   * @returns {Promise<object|null>} 游戏数据对象或null
   */
  static async load(groupId) {
    const key = this.getRedisKey(groupId);
    try {
      const hashData = await redis.hGetAll(key);
      if (!hashData || Object.keys(hashData).length === 0) return null;

      // 从Hash的各个字段重组游戏数据
      const gameData = {
        players: JSON.parse(hashData.players || '[]'),
        gameState: JSON.parse(hashData.gameState || '{}'),
        potions: JSON.parse(hashData.potions || '{}'),
        userGroupMap: JSON.parse(hashData.userGroupMap || '{}'),
        metadata: JSON.parse(hashData.metadata || '{}')
      };
      return gameData;
    } catch (err) {
      console.error(`[DataManager] 从 Redis 读取或解析游戏数据失败 (${groupId}):`, err);
      await redis.del(key); // 出现解析错误时，删除可能损坏的数据
      return null;
    }
  }

  /**
   * 全量保存游戏数据到Redis
   * @param {string} groupId - 群组ID
   * @param {object} data - 完整的游戏数据对象
   * @returns {Promise<void>}
   */
  static async saveAll(groupId, data) {
    const key = this.getRedisKey(groupId);
    try {
      const multi = redis.multi();

      multi.hSet(key, 'players', JSON.stringify(data.players || []));
      multi.hSet(key, 'gameState', JSON.stringify(data.gameState || {}));
      multi.hSet(key, 'potions', JSON.stringify(data.potions || {}));
      multi.hSet(key, 'userGroupMap', JSON.stringify(data.userGroupMap || {}));
      multi.hSet(key, 'metadata', JSON.stringify(data.metadata || {}));
      multi.expire(key, GAME_DATA_EXPIRATION);

      await multi.exec();
    } catch (err) {
      console.error(`[DataManager] 全量保存游戏数据到 Redis 失败 (${groupId}):`, err);
    }
  }

  /**
   * 更新Redis中游戏数据的单个字段
   * @param {string} groupId - 群组ID
   * @param {string} fieldName - 要更新的字段名
   * @param {any} data - 字段的新数据
   * @returns {Promise<void>}
   */
  static async saveField(groupId, fieldName, data) {
    const key = this.getRedisKey(groupId);
    try {
      await redis.hSet(key, fieldName, JSON.stringify(data));
      await redis.expire(key, GAME_DATA_EXPIRATION);
    } catch (err) {
      console.error(`[DataManager] 更新游戏字段 [${fieldName}] 到 Redis 失败 (${groupId}):`, err);
    }
  }

  /**
   * 从Redis删除指定群组的游戏数据
   * @param {string} groupId - 群组ID
   * @returns {Promise<void>}
   */
  static async delete(groupId) {
    const key = this.getRedisKey(groupId);
    try {
      await redis.del(key);
    } catch (err) {
      console.error(`[DataManager] 从 Redis 删除游戏数据失败 (${groupId}):`, err);
    }
  }

  /**
   * 设置用户到群组的映射
   * @param {string} userId - 用户ID
   * @param {string} groupId - 群组ID
   * @returns {Promise<void>}
   */
  static async setUserGroup(userId, groupId) {
    const key = this.getUserGroupKey(userId);
    try {
      await redis.set(key, groupId, 'EX', GAME_DATA_EXPIRATION);
    } catch (err) {
      console.error(`[DataManager] 设置用户群组映射失败 (${userId} -> ${groupId}):`, err);
    }
  }

  /**
   * 获取用户所在的群组ID
   * @param {string} userId - 用户ID
   * @returns {Promise<string|null>} 群组ID或null
   */
  static async getUserGroup(userId) {
    const key = this.getUserGroupKey(userId);
    try {
      return await redis.get(key);
    } catch (err) {
      console.error(`[DataManager] 获取用户群组映射失败 (${userId}):`, err);
      return null;
    }
  }

  /**
   * 删除用户到群组的映射
   * @param {string} userId - 用户ID
   * @returns {Promise<void>}
   */
  static async deleteUserGroup(userId) {
    const key = this.getUserGroupKey(userId);
    try {
      await redis.del(key);
    } catch (err) {
      console.error(`[DataManager] 删除用户群组映射失败 (${userId}):`, err);
    }
  }

  /**
   * 为新玩家生成一个不重复的两位数字临时ID
   * @param {Array<object>} players - 当前游戏中的玩家列表
   * @returns {string} 生成的临时ID (例如 '01', '02')
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
        // 找到了空缺
        break;
      }
    }

    // 返回找到的空缺编号，或者如果没有空缺就返回最大编号+1
    return String(nextId).padStart(2, '0');
  }

  /**
   * 批量删除多个用户的群组映射
   * @param {Array<string>} userIds - 用户ID数组
   * @returns {Promise<void>}
   */
  static async deleteMultipleUserGroups(userIds) {
    if (!userIds || userIds.length === 0) return;
    
    try {
      const keys = userIds.map(userId => this.getUserGroupKey(userId));
      await redis.del(...keys);
    } catch (err) {
      console.error(`[DataManager] 批量删除用户群组映射失败:`, err);
    }
  }
}
// model/werewolf/utils.js
import { PLUGIN_NAME, REDIS_KEYS } from "./constants.js";

/**
 * 统一的日志记录器
 * @param  {...any} args - 要打印的日志内容
 */
export function logger(...args) {
  console.log(`[${PLUGIN_NAME}]`, ...args);
}

/**
 * 获取指定群组ID对应的房间Redis键名
 * @param {string} groupId - 群组ID
 * @returns {string}
 */
export function getRoomRedisKey(groupId) {
  return `${REDIS_KEYS.ROOM_PREFIX}${groupId}`;
}

/**
 * 获取用户到群组映射的Redis键名
 * @param {string} userId - 用户ID
 * @returns {string}
 */
export function getUserGroupRedisKey(userId) {
  return `${REDIS_KEYS.USER_GROUP_PREFIX}${userId}`;
}

/**
 * Fisher-Yates 洗牌算法，用于打乱数组
 * @param {Array<any>} array - 要打乱的数组
 * @returns {Array<any>} 打乱后的新数组
 */
export function shuffleArray(array) {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
}
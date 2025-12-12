import { PLUGIN_NAME } from '../constants.js'

/**
 * @class MessageService
 * @description 统一封装狼人杀模块的消息发送能力。
 * 职责：群聊系统消息、私聊消息（含错误兜底通知）。
 */
export default class MessageService {
  /**
   * 向指定群组发送系统消息。
   * @param {string} groupId 群组ID
   * @param {string|Array<object>} msg 消息内容
   */
  async sendSystemGroupMsg(groupId, msg) {
    if (!groupId || !msg) return
    try {
      await Bot.pickGroup(groupId).sendMsg(msg)
    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 发送系统群消息失败 (${groupId}):`, err)
    }
  }

  /**
   * 向指定用户发送私聊消息。
   * @param {string} userId 用户ID
   * @param {string|Array<object>} msg 消息内容
   * @param {string|null} sourceGroupId 来源群组ID（用于失败提示）
   * @param {boolean} notifyGroupOnError 私聊失败时是否通知来源群
   * @returns {Promise<boolean>} 是否成功发送
   */
  async sendDirectMessage(userId, msg, sourceGroupId = null, notifyGroupOnError = true) {
    if (!userId || !msg) return false
    try {
      await Bot.pickUser(userId).sendMsg(msg)
      return true
    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 发送私聊消息失败 (userId: ${userId}):`, err)
      if (sourceGroupId && notifyGroupOnError) {
        await this.sendSystemGroupMsg(
          sourceGroupId,
          `[!] 无法向玩家 QQ:${userId} 发送私聊消息，请检查好友关系或机器人是否被屏蔽。`
        )
      }
      return false
    }
  }
}


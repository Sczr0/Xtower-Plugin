/**
 * 处理 #开始狼人杀 指令
 * @param {object} e - Yunzai的事件对象
 * @param {GameManager} gameManager - 游戏管理器实例
 */
export default function (e, gameManager) {
  const groupId = e.group_id
  const room = gameManager.rooms.get(groupId)

  if (!room) {
    e.reply('没有正在等待开始的游戏。')
    return
  }

  if (e.user_id !== room.ownerId) {
    e.reply('只有房主才能开始游戏哦。')
    return
  }

  // 在 GameManager.js 中我们设置了最少6人
  if (room.players.size < 6) {
    e.reply(`当前玩家人数为 ${room.players.size}，至少需要6人才能开始游戏。`)
    return
  }

  room.startGame()
}
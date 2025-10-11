/**
 * 处理 #结束狼人杀 指令
 * @param {object} e - Yunzai的事件对象
 * @param {GameManager} gameManager - 游戏管理器实例
 */
export default function (e, gameManager) {
  const groupId = e.group_id
  const room = gameManager.rooms.get(groupId)

  if (!room) {
    e.reply('当前没有游戏在进行哦。')
    return
  }

  // 增加一个管理员也可以结束游戏的权限
  if (e.user_id !== room.ownerId && !e.isMaster) {
    e.reply('只有房主或机器人管理员才能强制结束游戏！')
    return
  }

  gameManager.rooms.delete(groupId)
  e.reply('游戏已被解散。')
}
/**
 * 处理 #创建狼人杀 指令
 * @param {object} e - Yunzai的事件对象
 * @param {GameManager} gameManager - 游戏管理器实例
 */
export default function (e, gameManager) {
  const groupId = e.group_id
  const room = gameManager.rooms.get(groupId)

  if (room) {
    e.reply('本群已经有一场游戏正在进行或准备中啦！')
    return
  }

  gameManager.createRoom(groupId, e.user_id)
  
  e.reply(`狼人杀房间创建成功！\n发送【#加入狼人杀】参与对局。`)
}
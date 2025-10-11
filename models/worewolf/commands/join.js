/**
 * 处理 #加入狼人杀 指令
 * @param {object} e - Yunzai的事件对象
 * @param {GameManager} gameManager - 游戏管理器实例
 */
export default function (e, gameManager) {
  const groupId = e.group_id
  const room = gameManager.rooms.get(groupId)

  if (!room) {
    e.reply('当前没有可以加入的游戏。')
    return
  }

  const player = room.players.get(e.user_id)
  if (player) {
    e.reply('你已经在这场游戏里了。')
    return
  }

  room.addPlayer(e.user_id, e.sender.card || e.sender.nickname)
  
  const playerList = Array.from(room.players.values()).map((p, i) => `${i + 1}. ${p.nickname}`).join('\n')
  e.reply(`【${e.sender.card || e.sender.nickname}】已加入游戏！\n\n当前玩家列表：\n${playerList}`)
}
/**
 * 预言家角色逻辑
 */
export default class Prophet {
  constructor (player) {
    this.player = player
  }

  /**
   * 预言家查验技能
   * @param {GameRoom} room - 当前游戏房间
   * @param {string} targetPlayerId - 目标玩家ID
   */
  check (room, targetPlayerId) {
    const target = room.players.get(targetPlayerId)
    if (!target || !target.isAlive) {
      Bot.pickUser(this.player.id).sendMsg('无效的目标或目标已死亡。')
      return false
    }

    const targetRole = room.players.get(targetPlayerId).role
    const isWerewolf = targetRole === 'WEREWOLF'

    const resultText = `你查验的玩家【${target.nickname}】是... ${isWerewolf ? '狼人' : '好人'}。`
    Bot.pickUser(this.player.id).sendMsg(resultText)
    
    return true
  }
}
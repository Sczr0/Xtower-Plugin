/**
 * 猎人角色逻辑
 */
export default class Hunter {
  constructor (player) {
    this.player = player
    this.canShoot = true // 猎人只能开一次枪
  }

  /**
   * 猎人死亡时触发的开枪技能 (被动)
   * @param {GameRoom} room - 当前游戏房间
   * @param {object} eventData - 事件数据, e.g., { deceasedPlayer: Player }
   */
  onPlayerDied (room, eventData) {
    if (eventData.deceasedPlayer.id === this.player.id && this.canShoot) {
      // 是猎人自己死了，并且他还能开枪
      this.canShoot = false // 标记为已开枪
      
      // 通知猎人开枪
      Bot.pickUser(this.player.id).sendMsg('你已死亡，请在60秒内选择一名玩家开枪带走。格式：开枪 <编号>')
      
      // TODO: 设置一个临时状态和计时器，等待猎人开枪
      room.setTemporaryState('HUNTER_SHOOTING', 60)
    }
  }

  /**
   * 猎人开枪的主动操作
   * @param {GameRoom} room - 当前游戏房间
   * @param {string} targetPlayerId - 目标玩家ID
   */
  shoot (room, targetPlayerId) {
    const target = room.players.get(targetPlayerId)
    if (!target || !target.isAlive) {
      Bot.pickUser(this.player.id).sendMsg('无效的目标或目标已死亡。')
      return false
    }

    // 立即结算枪杀结果
    target.isAlive = false
    room.broadcast('playerDied', { deceasedPlayer: target, reason: 'shot_by_hunter' })
    
    Bot.sendGroupMsg(room.groupId, `猎人 ${this.player.nickname} 发动了他的技能，${target.nickname} 被一枪带走！`)
    
    // TODO: 清除临时状态
    room.clearTemporaryState('HUNTER_SHOOTING')
    return true
  }
}
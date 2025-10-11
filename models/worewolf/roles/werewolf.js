/**
 * 狼人角色逻辑
 */
export default class Werewolf {
  constructor (player) {
    this.player = player
  }

  /**
   * 狼人刀人技能
   * @param {GameRoom} room - 当前游戏房间
   * @param {string} targetPlayerId - 目标玩家ID
   */
  kill (room, targetPlayerId) {
    const target = room.players.get(targetPlayerId)
    if (!target || !target.isAlive) {
      Bot.pickUser(this.player.id).sendMsg('无效的目标或目标已死亡。')
      return false
    }

    // 检查是否刀了队友
    const targetRole = room.players.get(targetPlayerId).role
    if (targetRole === 'WEREWOLF') {
        Bot.pickUser(this.player.id).sendMsg('你不能选择狼人同伴作为目标。')
        return false
    }

    // 记录刀人动作，但不立即结算
    // 结算将在夜晚结束时统一进行
    room.nightActions.set('wolf_kill', targetPlayerId)
    
    // 通知所有狼人队友
    const wolves = Array.from(room.players.values()).filter(p => p.role === 'WEREWOLF' && p.isAlive)
    for (const wolf of wolves) {
        Bot.pickUser(wolf.id).sendMsg(`（狼人频道）\n你和你的队友决定今晚袭击 ${target.nickname}。`)
    }
    
    return true
  }
}
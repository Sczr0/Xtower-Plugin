/**
 * 女巫角色逻辑
 */
export default class Witch {
  constructor (player) {
    this.player = player
    this.hasSavePotion = true
    this.hasPoisonPotion = true
  }

  /**
   * 女巫使用药剂的技能
   * @param {GameRoom} room - ��前游戏房间
   * @param {string} action - 'save' 或 'poison'
   * @param {string} [targetPlayerId] - 目标玩家ID (仅在 'poison' 时需要)
   */
  use (room, action, targetPlayerId) {
    if (action === 'save') {
      if (!this.hasSavePotion) {
        Bot.pickUser(this.player.id).sendMsg('你的解药已经用完了。')
        return false
      }
      const killedPlayerId = room.nightActions.get('wolf_kill')
      if (!killedPlayerId) {
        Bot.pickUser(this.player.id).sendMsg('今晚是平安夜，没有人被刀。')
        return false
      }
      
      this.hasSavePotion = false
      room.nightActions.set('witch_save', killedPlayerId)
      Bot.pickUser(this.player.id).sendMsg(`你使用了珍贵的解药，救下了 ${room.players.get(killedPlayerId).nickname}。`)
      return true

    } else if (action === 'poison') {
      if (!this.hasPoisonPotion) {
        Bot.pickUser(this.player.id).sendMsg('你的毒药已经用完了。')
        return false
      }
      const target = room.players.get(targetPlayerId)
      if (!target || !target.isAlive) {
        Bot.pickUser(this.player.id).sendMsg('无效的目标或目标已死亡。')
        return false
      }

      this.hasPoisonPotion = false
      room.nightActions.set('witch_poison', targetPlayerId)
      Bot.pickUser(this.player.id).sendMsg(`你使用了致命的毒药，撒向了 ${target.nickname}。`)
      return true
    }
    
    Bot.pickUser(this.player.id).sendMsg('无效的指令，请输入 救 或 毒 <编号>。')
    return false
  }
}
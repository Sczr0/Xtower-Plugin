// model/werewolf/roles/Idiot.js
import { BaseRole } from './BaseRole.js';
import { ROLES, TEAMS } from '../constants.js';

export class Idiot extends BaseRole {
  constructor() {
    super({
      roleId: ROLES.IDIOT,
      name: '白痴',
      team: TEAMS.GOOD,
      description: '好人阵营。被投票出局后可翻牌，继续留在场上但失去投票权。',
    });
  }

  /**
   * 白痴被投票出局时触发的钩子函数。
   * @param {GameEngine} game - 游戏引擎实例
   * @param {Player} player - 被放逐的白痴玩家
   * @returns {object|null} 返回一个事件对象，指示白痴翻牌
   */
  onVoteOut(game, player) {
    // 实际逻辑在GameEngine中处理，这里仅返回一个事件类型
    return {
      event: 'idiot_flip_card',
      data: { idiotId: player.userId, groupId: game.groupId }
    };
  }
}
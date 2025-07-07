// model/werewolf/roles/Guard.js
import { BaseRole } from './BaseRole.js';
import { ROLES, TEAMS } from '../constants.js';

export class Guard extends BaseRole {
  constructor() {
    super({
      roleId: ROLES.GUARD,
      name: '守卫',
      actionPriority: 30, // 守卫行动优先级，在狼人之后，女巫之前
      description: '每晚可以守护一名玩家，使其免受狼人袭击。不能连续两晚守护同一名玩家。',
    });
    this.lastGuardedPlayerId = null; // 上次守护的玩家ID
  }

  /**
   * 执行夜晚守护行动。
   * @param {GameEngine} game - 游戏引擎实例
   * @param {Player} player - 执行行动的守卫玩家
   * @param {object} actionData - 行动数据，如 { target }
   * @returns {Promise<string|null>} 返回给玩家的私聊反馈消息
   */
  async performNightAction(game, player, { target }) {
    if (!target) return '无效的目标。';
    if (!target.isAlive) return `${target.info} 已经死亡。`;
    if (target.userId === this.lastGuardedPlayerId) return '不能连续两晚守护同一名玩家。';

    // 为目标添加守护标签
    target.addTag('GUARDED', { sourceId: player.userId });
    this.lastGuardedPlayerId = target.userId; // 记录本次守护的玩家

    return `你已守护 ${target.info}。`;
  }
}
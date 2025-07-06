// model/werewolf/roles/WolfKing.js
import { BaseRole } from './BaseRole.js';
import { ROLES } from '../constants.js';

export class WolfKing extends BaseRole {
  constructor() {
    super({
      roleId: ROLES.WOLF_KING,
      name: '狼王',
      actionPriority: 20, // 与普通狼人相同，或更高以体现自刀优先级
      description: '狼人阵营，每晚可以刀人或自刀。出局后可发动狼王爪带走一人。',
    });
  }

  /**
   * 狼王夜晚行动，可以刀人也可以自刀。
   * @param {GameEngine} game - 游戏引擎实例
   * @param {Player} player - 执行行动的狼王玩家
   * @param {object} actionData - 行动数据，如 { target }
   * @returns {Promise<string|null>} 返回给玩家的私聊反馈消息
   */
  async performNightAction(game, player, { target }) {
    if (!target) return '无效的目标。';
    if (!target.isAlive) return `${target.info} 已经死亡。`;

    // 狼王自刀逻辑：如果目标是自己，则标记为自刀
    if (target.userId === player.userId) {
      // 可以在此处添加特殊的自刀标记或处理
      // 暂时只返回消息，具体自刀效果留待GameEngine处理
      return `你选择了自刀。请等待其他狼队友的决定。`;
    }

    // 否则，作为普通狼人进行刀人操作
    // 为目标添加一个可追溯的濒死标签
    target.addTag(TAGS.DYING_FROM_WOLF, { sourceId: player.userId });

    return `你已标记袭击目标为 ${target.info}。请等待其他狼队友的决定。`;
  }

  /**
   * 狼王出局时触发狼王爪技能。
   * @param {GameEngine} game - 游戏引擎实例
   * @param {Player} player - 死亡的狼王玩家
   * @returns {object|null} 返回一个事件对象，指示狼王爪技能激活
   */
  onDeath(game, player) {
    // 狼王爪技能：出局后可选择一名玩家一并出局
    // 实际逻辑在GameEngine中处理，这里仅返回一个事件类型
    return {
      event: 'wolf_king_claw_prompt',
      data: { wolfKingId: player.userId, groupId: game.groupId }
    };
  }

  /**
   * 狼王自爆逻辑（在白天发言阶段）。
   * @param {GameEngine} game - 游戏引擎实例
   * @param {Player} player - 执行自爆的狼王玩家
   * @returns {object|null} 返回一个事件对象，指示自爆发生
   */
  async selfExplode(game, player) {
    // 狼王自爆，结束发言阶段，不进行放逐投票
    // 实际逻辑在GameEngine中处理，这里仅返回一个事件类型
    return {
      event: 'wolf_king_self_explode',
      data: { exploderId: player.userId, groupId: game.groupId }
    };
  }
}
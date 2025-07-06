// model/werewolf/roles/WhiteWolfKing.js
import { BaseRole } from './BaseRole.js';
import { ROLES, TAGS } from '../constants.js';

export class WhiteWolfKing extends BaseRole {
  constructor() {
    super({
      roleId: ROLES.WHITE_WOLF_KING,
      name: '白狼王',
      actionPriority: 20, // 与普通狼人相同
      description: '狼人阵营。可以在白天自爆时选择带走一名玩家，非自爆出局不得发动技能。',
    });
  }

  async performNightAction(game, player, { target }) {
    if (!target) return '无效的目标。';
    if (!target.isAlive) return `${target.info} 已经死亡。`;

    // 白狼王夜间行动与普通狼人相同
    target.addTag(TAGS.DYING_FROM_WOLF, { sourceId: player.userId });

    return `你已标记袭击目标为 ${target.info}。请等待其他狼队友的决定。`;
  }

  /**
   * 白狼王自爆逻辑。
   * @param {GameEngine} game - 游戏引擎实例
   * @param {Player} player - 执行自爆的白狼王玩家
   * @param {Player} target - 自爆时选择带走的目标玩家
   * @returns {object|null} 返回一个事件对象，指示自爆发生并带走玩家
   */
  async selfExplode(game, player, target) {
    if (!target) return { success: false, message: '自爆时必须选择一名玩家带走。' };
    if (!target.isAlive) return { success: false, message: `${target.info} 已经死亡，无法带走。` };
    if (target.userId === player.userId) return { success: false, message: '不能带走自己。' };

    // 白狼王自爆并带走一人
    // 实际逻辑在GameEngine中处理，这里仅返回一个事件类型
    return {
      success: true,
      event: 'white_wolf_king_self_explode',
      data: { exploderId: player.userId, targetId: target.userId, groupId: game.groupId }
    };
  }

  /**
   * 白狼王出局时触发的钩子函数。
   * @param {GameEngine} game - 游戏引擎实例
   * @param {Player} player - 死亡的白狼王玩家
   * @returns {object|null}
   */
  onDeath(game, player) {
    // 白狼王非自爆出局不得发动技能
    // 只有当玩家是自爆出局时，才返回事件。
    // 假设 GameEngine 在调用 onDeath 时，会将死亡类型作为 player 对象的一个属性传递。
    if (player.deathType === 'self_explode') {
      // 这里可以返回一个事件，例如 'white_wolf_king_skill_activated'，以便GameEngine处理
      // 由于用户明确要求“非自爆出局不得发动技能”，这里仅返回 null，
      // 实际技能逻辑（带走一人）已在 selfExplode 方法中处理。
      return null; 
    }
    return null;
  }
}
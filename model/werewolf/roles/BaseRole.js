// model/werewolf/roles/BaseRole.js
import { TEAMS, WOLF_TEAM_ROLES } from "../constants.js";

/**
 * @class BaseRole
 * @description 所有角色的基类，定义了角色的通用接口和属性。
 */
export class BaseRole {
  constructor(options = {}) {
    this.roleId = options.roleId;
    this.name = options.name;
    this.team = WOLF_TEAM_ROLES.includes(this.roleId) ? TEAMS.WOLF : TEAMS.GOOD;
    this.actionPriority = options.actionPriority || 999; // 行动优先级，越小越优先
    this.description = options.description || '一个神秘的角色。';
  }

  /**
   * 判断此角色是否需要进行夜晚行动
   * @returns {boolean}
   */
  hasNightAction() {
    return this.actionPriority < 999;
  }

  /**
   * 执行夜晚行动。子类需要重写此方法。
   * @param {GameEngine} game - 游戏引擎实例
   * @param {Player} player - 执行行动的玩家
   * @param {object} actionData - 行动数据，如 { target }
   * @returns {Promise<string|null>} 返回给玩家的私聊反馈消息
   */
  async performNightAction(game, player, actionData) {
    return "你的角色在夜晚没有特殊行动。";
  }

  /**
   * 当持有该角色的玩家死亡时触发的钩子函数。
   * @param {GameEngine} game - 游戏引擎实例
   * @param {Player} player - 死亡的玩家
   * @returns {object|null} 返回一个事件对象，如 { event: 'hunter_shoot', data: { shooterId: player.userId } }
   */
  onDeath(game, player) {
    return null;
  }
  
  /**
   * 当持有该角色的玩家被投票出局时触发的钩子函数。
   * @param {GameEngine} game - 游戏引擎实例
   * @param {Player} player - 被放逐的玩家
   * @returns {object|null}
   */
  onVoteOut(game, player) {
    return null;
  }
}
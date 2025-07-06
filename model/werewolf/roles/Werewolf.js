// model/werewolf/roles/Werewolf.js
import { BaseRole } from './BaseRole.js';
import { ROLES, TAGS } from '../constants.js';

export class Werewolf extends BaseRole {
  constructor() {
    super({
      roleId: ROLES.WEREWOLF,
      name: '狼人',
      actionPriority: 20,
      description: '每晚可以和队友共同袭击一名玩家。',
    });
  }

  async performNightAction(game, player, { target }) {
    if (!target) return '无效的目标。';
    if (!target.isAlive) return `${target.info} 已经死亡。`;

    // 为目标添加一个可追溯的濒死标签
    target.addTag(TAGS.DYING_FROM_WOLF, { sourceId: player.userId });

    return `你已标记袭击目标为 ${target.info}。请等待其他狼队友的决定。`;
  }
}
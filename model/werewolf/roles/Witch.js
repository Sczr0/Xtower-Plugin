// model/werewolf/roles/Witch.js
import { BaseRole } from './BaseRole.js';
import { ROLES, TAGS } from '../constants.js';

export class Witch extends BaseRole {
  constructor() {
    super({
      roleId: ROLES.WITCH,
      name: '女巫',
      actionPriority: 50,
      description: '你有一瓶解药和一瓶毒药，整局游戏只能各使用一次。',
    });
  }

  async performNightAction(game, player, { actionType, target }) {
    if (actionType === 'save') {
      if (!game.gameState.witchPotions.antidote) return '你的解药已经用完了。';
      
      const attackedPlayer = game.getAttackedByWolfTarget();
      if (!attackedPlayer) return '今晚无人被袭击，不能使用解药。';
      if (attackedPlayer.userId !== target.userId) return `你只能对被袭击的玩家 ${attackedPlayer.info} 使用解药。`;

      target.addTag(TAGS.SAVED_BY_WITCH, { sourceId: player.userId });
      game.gameState.witchPotions.antidote = false; // 消耗解药
      return `你对 ${target.info} 使用了解药。`;

    } else if (actionType === 'kill') {
      if (!game.gameState.witchPotions.poison) return '你的毒药已经用完了。';
      if (!target) return '无效的目标。';
      if (!target.isAlive) return `${target.info} 已经死亡。`;

      target.addTag(TAGS.POISONED_BY_WITCH, { sourceId: player.userId });
      game.gameState.witchPotions.poison = false; // 消耗毒药
      return `你对 ${target.info} 使用了毒药。`;
    }
    return '无效的行动类型。';
  }
}
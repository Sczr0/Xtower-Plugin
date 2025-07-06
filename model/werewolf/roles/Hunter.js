// model/werewolf/roles/Hunter.js
import { BaseRole } from './BaseRole.js';
import { ROLES, GAME_PHASE, TAGS } from '../constants.js';

export class Hunter extends BaseRole {
  constructor() {
    super({
      roleId: ROLES.HUNTER,
      name: '猎人',
      description: '当你死亡时，可以开枪带走场上任意一名玩家。被女巫毒死时无法发动技能。',
    });
    this.wasPoisoned = false;
  }
  
  // 猎人有特殊的死亡逻辑
  onDeath(game, player) {
    // 检查死亡原因是否为毒药
    if (player.hasTag(TAGS.POISONED_BY_WITCH)) {
      this.wasPoisoned = true;
    }
    if (this.wasPoisoned) {
      return { event: 'info', message: `${player.info} 是猎人，但他被女巫毒杀，无法开枪。` };
    }
    // 如果不是被毒死，则触发开枪事件
    return { event: GAME_PHASE.HUNTER_SHOOT, data: { shooterId: player.userId } };
  }
}
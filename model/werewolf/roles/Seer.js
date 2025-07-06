// model/werewolf/roles/Seer.js
import { BaseRole } from './BaseRole.js';
import { ROLES, TEAMS } from '../constants.js';

export class Seer extends BaseRole {
  constructor() {
    super({
      roleId: ROLES.SEER,
      name: '预言家',
      actionPriority: 10,
      description: '每晚可以查验一名玩家的阵营（好人或狼人）。',
    });
  }

  async performNightAction(game, player, { target }) {
    if (!target) return '无效的目标。';
    
    const targetIsWolf = target.role.team === TEAMS.WOLF;
    const resultText = targetIsWolf ? '【狼人】' : '【好人】';

    return `查验结果：${target.info} 的身份是 ${resultText}。`;
  }
}
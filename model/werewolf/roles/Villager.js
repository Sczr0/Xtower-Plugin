// model/werewolf/roles/Villager.js
import { BaseRole } from './BaseRole.js';
import { ROLES, TEAMS } from '../constants.js';

export class Villager extends BaseRole {
  constructor() {
    super({
      roleId: ROLES.VILLAGER,
      name: '平民',
      team: TEAMS.GOOD,
      description: '无特殊技能',
    });
  }
}
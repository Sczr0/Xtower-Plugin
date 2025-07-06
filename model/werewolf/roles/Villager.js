// model/werewolf/roles/Villager.js
import { BaseRole } from './BaseRole.js';
import { ROLES } from '../constants.js';

export class Villager extends BaseRole {
  constructor(player) {
    super(player, ROLES.VILLAGER, '好人', '平民', '无特殊技能');
  }
}
// model/werewolf/Player.js
import { logger } from './utils.js';
import { TAGS } from './constants.js';

// 导入所有角色类
import { Werewolf } from './roles/Werewolf.js';
import { Villager } from './roles/Villager.js';
import { Seer } from './roles/Seer.js';
import { Witch } from './roles/Witch.js';
import { Hunter } from './roles/Hunter.js';
// ... import other roles

// 映射表，方便通过 roleId 创建实例
const roleClassMap = {
  WEREWOLF: Werewolf,
  VILLAGER: Villager,
  SEER: Seer,
  WITCH: Witch,
  HUNTER: Hunter,
  // ... map other roles
};


/**
 * @class Player
 * @description 代表游戏中的一个玩家。
 */
export class Player {
  constructor(userId, nickname, tempId) {
    this.userId = userId;
    this.nickname = nickname;
    this.tempId = tempId;

    this.isAlive = true;
    this.role = null; // 将持有角色类的实例
    this.tags = [];   // 存储玩家的状态标签，如 { name: 'GUARDED', sourceId: '...', round: 1 }
  }
  
  /**
   * 给玩家分配角色
   * @param {string} roleId - 角色ID
   */
  assignRole(roleId) {
    const RoleClass = roleClassMap[roleId] || Villager; // 找不到默认为村民
    this.role = new RoleClass();
  }
  
  get info() {
    return `${this.nickname}(${this.tempId}号)`;
  }
  
  // --- Tag Management ---
  addTag(tagName, details = {}) {
    this.tags.push({ name: tagName, ...details });
  }

  hasTag(tagName) {
    return this.tags.some(tag => tag.name === tagName);
  }

  getTags(tagName) {
    return this.tags.filter(tag => tag.name === tagName);
  }

  removeTag(tagName) {
    this.tags = this.tags.filter(tag => tag.name !== tagName);
  }

  clearTemporaryTags() {
    // 定义哪些标签是临时的
    const temporaryTags = [
      TAGS.GUARDED,
      TAGS.DYING_FROM_WOLF,
      TAGS.SAVED_BY_WITCH,
      TAGS.POISONED_BY_WITCH,
    ];
    this.tags = this.tags.filter(tag => !temporaryTags.includes(tag.name));
  }

  /**
   * 从 Player 对象序列化为可存储在 Redis 的纯 JSON 对象
   * @returns {object}
   */
  serialize() {
    return {
      userId: this.userId,
      nickname: this.nickname,
      tempId: this.tempId,
      isAlive: this.isAlive,
      roleId: this.role ? this.role.roleId : null,
      tags: this.tags,
    };
  }
  
  /**
   * 从纯 JSON 对象反序列化为 Player 实例
   * @param {object} data - 纯 JSON 对象
   * @returns {Player}
   */
  static deserialize(data) {
    const player = new Player(data.userId, data.nickname, data.tempId);
    player.isAlive = data.isAlive;
    player.tags = data.tags || [];
    if (data.roleId) {
      player.assignRole(data.roleId);
    }
    return player;
  }
}
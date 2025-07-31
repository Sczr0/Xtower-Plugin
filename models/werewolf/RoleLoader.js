import { ROLES } from './GameEvents.js';

/**
 * @class RoleLoader
 * @description 角色加载器，负责动态加载和管理角色逻辑
 * 职责：读取角色文件、实例化角色对象、管理角色生命周期
 */
export class RoleLoader {
  constructor() {
    this.roleClasses = new Map();
    this.roleInstances = new Map(); // groupId -> Map<userId, roleInstance>
  }

  /**
   * 初始化角色加载器，加载所有角色类
   */
  async initialize() {
    try {
      // 动态导入所有角色模块
      const roleModules = await Promise.all([
        import('./roles/Werewolf.js'),
        import('./roles/Seer.js'),
        import('./roles/Witch.js'),
        import('./roles/Hunter.js'),
        import('./roles/Guard.js'),
        import('./roles/WolfKing.js'),
        import('./roles/WhiteWolfKing.js'),
        import('./roles/Idiot.js'),
        import('./roles/Villager.js')
      ]);

      // 注册角色类
      this.roleClasses.set(ROLES.WEREWOLF, roleModules[0].Werewolf);
      this.roleClasses.set(ROLES.SEER, roleModules[1].Seer);
      this.roleClasses.set(ROLES.WITCH, roleModules[2].Witch);
      this.roleClasses.set(ROLES.HUNTER, roleModules[3].Hunter);
      this.roleClasses.set(ROLES.GUARD, roleModules[4].Guard);
      this.roleClasses.set(ROLES.WOLF_KING, roleModules[5].WolfKing);
      this.roleClasses.set(ROLES.WHITE_WOLF_KING, roleModules[6].WhiteWolfKing);
      this.roleClasses.set(ROLES.IDIOT, roleModules[7].Idiot);
      this.roleClasses.set(ROLES.VILLAGER, roleModules[8].Villager);

      console.log('[RoleLoader] 角色模块加载完成');
    } catch (error) {
      console.error('[RoleLoader] 角色模块加载失败:', error);
    }
  }

  /**
   * 为游戏中的玩家创建角色实例
   * @param {string} groupId - 群组ID
   * @param {object} gameEngine - 游戏引擎实例
   * @param {Array} players - 玩家列表
   */
  createRoleInstances(groupId, gameEngine, players) {
    if (!this.roleInstances.has(groupId)) {
      this.roleInstances.set(groupId, new Map());
    }

    const groupRoles = this.roleInstances.get(groupId);

    players.forEach(player => {
      if (player.role && this.roleClasses.has(player.role)) {
        const RoleClass = this.roleClasses.get(player.role);
        const roleInstance = new RoleClass(gameEngine, player);
        groupRoles.set(player.userId, roleInstance);
        
        console.log(`[RoleLoader] 为玩家 ${player.nickname} 创建角色实例: ${player.role}`);
      }
    });
  }

  /**
   * 获取指定玩家的角色实例
   * @param {string} groupId - 群组ID
   * @param {string} userId - 用户ID
   * @returns {object|null} 角色实例或null
   */
  getRoleInstance(groupId, userId) {
    const groupRoles = this.roleInstances.get(groupId);
    return groupRoles ? groupRoles.get(userId) : null;
  }

  /**
   * 获取指定群组的所有角色实例
   * @param {string} groupId - 群组ID
   * @returns {Map} 角色实例映射
   */
  getGroupRoleInstances(groupId) {
    return this.roleInstances.get(groupId) || new Map();
  }

  /**
   * 清理指定群组的所有角色实例
   * @param {string} groupId - 群组ID
   */
  cleanupGroupRoles(groupId) {
    const groupRoles = this.roleInstances.get(groupId);
    if (groupRoles) {
      // 调用每个角色实例的清理方法
      groupRoles.forEach(roleInstance => {
        if (typeof roleInstance.cleanup === 'function') {
          roleInstance.cleanup();
        }
      });
      
      this.roleInstances.delete(groupId);
      console.log(`[RoleLoader] 已清理群组 ${groupId} 的所有角色实例`);
    }
  }

  /**
   * 移除指定玩家的角色实例
   * @param {string} groupId - 群组ID
   * @param {string} userId - 用户ID
   */
  removeRoleInstance(groupId, userId) {
    const groupRoles = this.roleInstances.get(groupId);
    if (groupRoles && groupRoles.has(userId)) {
      const roleInstance = groupRoles.get(userId);
      if (typeof roleInstance.cleanup === 'function') {
        roleInstance.cleanup();
      }
      groupRoles.delete(userId);
      console.log(`[RoleLoader] 已移除玩家 ${userId} 的角色实例`);
    }
  }

  /**
   * 获取角色的中文名称
   * @param {string} role - 角色常量
   * @returns {string} 角色中文名称
   */
  getRoleName(role) {
    const roleNames = {
      [ROLES.WEREWOLF]: '狼人',
      [ROLES.VILLAGER]: '村民',
      [ROLES.SEER]: '预言家',
      [ROLES.WITCH]: '女巫',
      [ROLES.HUNTER]: '猎人',
      [ROLES.GUARD]: '守卫',
      [ROLES.WOLF_KING]: '狼王',
      [ROLES.WHITE_WOLF_KING]: '白狼王',
      [ROLES.IDIOT]: '白痴'
    };
    return roleNames[role] || '未知角色';
  }

  /**
   * 获取角色的描述信息
   * @param {string} role - 角色常量
   * @returns {string} 角色描述
   */
  getRoleDescription(role) {
    const descriptions = {
      [ROLES.WEREWOLF]: '夜晚可以杀死一名玩家，与其他狼人为同伙。',
      [ROLES.VILLAGER]: '普通村民，没有特殊技能，通过投票和推理帮助好人阵营获胜。',
      [ROLES.SEER]: '每晚可以查验一名玩家的身份（好人或狼人）。',
      [ROLES.WITCH]: '拥有一瓶解药和一瓶毒药，解药可以救人，毒药可以杀人。',
      [ROLES.HUNTER]: '死亡时可以开枪带走一名玩家。',
      [ROLES.GUARD]: '每晚可以守护一名玩家，被守护的玩家当晚不会死亡。',
      [ROLES.WOLF_KING]: '狼人阵营，死亡时可以发动技能带走一名玩家。',
      [ROLES.WHITE_WOLF_KING]: '狼人阵营，可以自爆并带走一名玩家。',
      [ROLES.IDIOT]: '被投票出局时不会死亡，但失去投票权。'
    };
    return descriptions[role] || '暂无描述';
  }

  /**
   * 检查角色是否属于狼人阵营
   * @param {string} role - 角色常量
   * @returns {boolean} 是否为狼人阵营
   */
  isWerewolfTeam(role) {
    return [ROLES.WEREWOLF, ROLES.WOLF_KING, ROLES.WHITE_WOLF_KING].includes(role);
  }

  /**
   * 检查角色是否属于好人阵营
   * @param {string} role - 角色常量
   * @returns {boolean} 是否为好人阵营
   */
  isVillagerTeam(role) {
    return !this.isWerewolfTeam(role);
  }

  /**
   * 获取所有可用的角色列表
   * @returns {Array} 角色列表
   */
  getAvailableRoles() {
    return Array.from(this.roleClasses.keys());
  }
}

// 创建全局角色加载器实例
export const roleLoader = new RoleLoader();
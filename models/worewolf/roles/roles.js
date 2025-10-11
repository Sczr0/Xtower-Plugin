/**
 * 角色配置文件
 * 定义了游戏中的所有角色及其属性。
 * 'skills' 数组是关键，它将角色与 'phases.js' 中定义的阶段关联起来。
 */

import { PHASES } from '../core/phases.js'

export const ROLES = {
  // --- 狼人阵营 ---
  WEREWOLF: {
    id: 'WEREWOLF',
    name: '狼人',
    faction: 'WEREWOLVES',
    description: '夜晚出动，袭击一名玩家。',
    winCondition: 'KILL_ALL_VILLAGERS', // 杀死所有村民
    skills: [
      {
        phase: PHASES.WOLF_KILL.id, // 在狼人行动阶段触发
        command: 'kill', // 对应的私聊指令
        description: '刀 <编号>',
        type: 'active'
      }
    ]
  },

  // --- 神民阵营 ---
  PROPHET: {
    id: 'PROPHET',
    name: '预言家',
    faction: 'GODS',
    description: '每晚可以查验一名玩家的真实身份。',
    winCondition: 'KILL_ALL_WEREWOLVES', // 杀死所有狼人
    skills: [
      {
        phase: PHASES.PROPHET_CHECK.id,
        command: 'check',
        description: '查验 <编号>',
        type: 'active'
      }
    ]
  },
  WITCH: {
    id: 'WITCH',
    name: '女巫',
    faction: 'GODS',
    description: '拥有一瓶解药和一瓶毒药，每晚可以选择使用其中一瓶或都不使用。',
    winCondition: 'KILL_ALL_WEREWOLVES',
    skills: [
      {
        phase: PHASES.WITCH_ACTION.id,
        command: 'use', // 复合指令，如 'use save' 或 'use poison 2'
        description: '救 / 毒 <编号>',
        type: 'active'
      }
    ]
  },
  HUNTER: {
    id: 'HUNTER',
    name: '猎人',
    faction: 'GODS',
    description: '当猎人死亡时，他可以开枪带走一名玩家。',
    winCondition: 'KILL_ALL_WEREWOLVES',
    skills: [
      {
        event: 'playerDied', // 监听 playerDied 事件
        function: 'shootOnDeath',
        description: '开枪 <编号>',
        type: 'passive'
      }
    ]
  },

  // --- 平民阵营 ---
  VILLAGER: {
    id: 'VILLAGER',
    name: '村民',
    faction: 'VILLAGERS',
    description: '没有任何特殊能力，但需要通过逻辑和推理找出狼人。',
    winCondition: 'KILL_ALL_WEREWOLVES',
    skills: [] // 没有技能
  }
}

// 方便按阵营查找角色
export const ROLES_BY_FACTION = {
  WEREWOLVES: Object.values(ROLES).filter(r => r.faction === 'WEREWOLVES'),
  GODS: Object.values(ROLES).filter(r => r.faction === 'GODS'),
  VILLAGERS: Object.values(ROLES).filter(r => r.faction === 'VILLAGERS')
}
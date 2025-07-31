import { ROLES } from './GameEvents.js';

/**
 * @typedef {object} BoardPreset
 * @property {string} name - 板子名称
 * @property {string} description - 板子描述
 * @property {Array<string>} roles - 包含的角色列表，使用 ROLES 常量
 * @property {object} rules - 特殊游戏规则（待定）
 */

/**
 * 狼人杀板子预设
 * 定义了不同玩家数量和角色配置的预设板子
 */
export const BoardPresets = {
  // 6人新手局
  SIX_PLAYER_NOVICE: {
    name: '6人新手局',
    description: '适合新手的6人基础局，包含少量神职和狼人。',
    roles: [
      ROLES.WEREWOLF, ROLES.WEREWOLF,
      ROLES.SEER, ROLES.WITCH,
      ROLES.VILLAGER, ROLES.VILLAGER
    ],
    rules: {
      hasSheriff: true // 默认有警长竞选
    }
  },
  // 8人标准局
  EIGHT_PLAYER_STANDARD: {
    name: '8人标准局',
    description: '经典的8人标准局，平衡性较好。',
    roles: [
      ROLES.WEREWOLF, ROLES.WEREWOLF, ROLES.WOLF_KING,
      ROLES.SEER, ROLES.WITCH, ROLES.HUNTER,
      ROLES.VILLAGER, ROLES.VILLAGER
    ],
    rules: {
      hasSheriff: true
    }
  },
  // 9人标准局
  NINE_PLAYER_STANDARD: {
    name: '9人标准局',
    description: '经典的9人标准局，增加一个民或神职。',
    roles: [
      ROLES.WEREWOLF, ROLES.WEREWOLF, ROLES.WOLF_KING,
      ROLES.SEER, ROLES.WITCH, ROLES.HUNTER, ROLES.GUARD,
      ROLES.VILLAGER, ROLES.VILLAGER
    ],
    rules: {
      hasSheriff: true
    }
  },
  // 10人进阶局
  TEN_PLAYER_ADVANCED: {
    name: '10人进阶局',
    description: '10人进阶局，引入更多功能角色。',
    roles: [
      ROLES.WEREWOLF, ROLES.WEREWOLF, ROLES.WEREWOLF, ROLES.WHITE_WOLF_KING,
      ROLES.SEER, ROLES.WITCH, ROLES.HUNTER, ROLES.GUARD,
      ROLES.VILLAGER, ROLES.VILLAGER
    ],
    rules: {
      hasSheriff: true
    }
  }
};

/**
 * 获取指定名称的板子预设
 * @param {string} presetName - 板子预设的名称（如 'SIX_PLAYER_NOVICE'）
 * @returns {BoardPreset|undefined} 对应的板子预设对象
 */
export function getBoardPreset(presetName) {
  return BoardPresets[presetName];
}

/**
 * 根据玩家数量推荐板子
 * @param {number} playerCount - 玩家数量
 * @returns {Array<BoardPreset>} 推荐的板子列表
 */
export function recommendPresets(playerCount) {
  const recommended = [];
  for (const key in BoardPresets) {
    if (Object.hasOwnProperty.call(BoardPresets, key)) {
      const preset = BoardPresets[key];
      if (preset.roles.length === playerCount) {
        recommended.push(preset);
      }
    }
  }
  return recommended;
}

/**
 * 获取所有板子预设的列表
 * @returns {Array<BoardPreset>} 所有板子预设的数组
 */
export function getAllPresets() {
  return Object.values(BoardPresets);
}
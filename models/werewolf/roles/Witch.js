import { GAME_EVENTS, ROLE_EVENTS, INTERACTION_EVENTS, ROLES } from '../GameEvents.js';

/**
 * @class Witch
 * @description 女巫角色逻辑
 * 职责：监听游戏事件，使用解药和毒药
 */
export class Witch {
  constructor(engine, player) {
    this.engine = engine;
    this.player = player;
    this.hasActed = false; // 当晚是否已行动
    this.potions = { save: true, kill: true }; // 药剂状态
    
    // 监听游戏事件
    this.setupEventListeners();
  }

  /**
   * 设置事件监听器
   */
  setupEventListeners() {
    // 监听夜晚开始事件
    this.engine.on(GAME_EVENTS.NIGHT_STARTED, this.onNightStarted.bind(this));
    
    // 监听夜晚行动处理事件
    this.engine.on(GAME_EVENTS.NIGHT_ACTION_RECEIVED, this.onNightActionReceived.bind(this));
    
    // 监听夜晚结束事件
    this.engine.on(GAME_EVENTS.NIGHT_ENDED, this.onNightEnded.bind(this));
  }

  /**
   * 夜晚开始时的处理
   * @param {object} data - 事件数据
   */
  onNightStarted(data) {
    // 如果女巫已死亡，不执行任何操作
    if (!this.player.isAlive) {
      return;
    }

    this.hasActed = false;

    // 发送女巫行动提示
    let message = `🧙‍♀️ 女巫请行动！\n\n`;
    
    // 显示药剂状态
    message += `💊 药剂状态：\n`;
    message += `- 解药：${this.potions.save ? '✅ 可用' : '❌ 已用'}\n`;
    message += `- 毒药：${this.potions.kill ? '✅ 可用' : '❌ 已用'}\n\n`;
    
    if (this.potions.save || this.potions.kill) {
      message += `🔮 行动指令：\n`;
      if (this.potions.save) {
        message += `- "#救 编号" 使用解药救人\n`;
      }
      if (this.potions.kill) {
        message += `- "#毒 编号" 使用毒药杀人\n`;
      }
      message += `- "#跳过" 本回合不使用药剂\n\n`;
      message += `例如：#救 03 或 #毒 05`;
    } else {
      message += `你的药剂已全部用完，无法行动。`;
    }
    
    this.engine.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, {
      userId: this.player.userId,
      message: message,
      groupId: data.groupId
    });
  }

  /**
   * 处理夜晚行动
   * @param {object} data - 行动数据
   */
  onNightActionReceived(data) {
    const { action } = data;
    
    // 只处理女巫的药剂行动
    if (action.userId !== this.player.userId || 
        !['SAVE', 'POISON', 'SKIP'].includes(action.type)) {
      return;
    }

    let result;
    
    switch (action.type) {
      case 'SAVE':
        result = this.useSavePotion(action.targetId);
        break;
      case 'POISON':
        result = this.usePoisonPotion(action.targetId);
        break;
      case 'SKIP':
        result = this.skipAction();
        break;
      default:
        result = { success: false, message: '❌ 无效的行动类型。' };
    }
    
    if (result.success) {
      this.hasActed = true;
    }
    
    // 发送结果消息给女巫
    this.engine.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, {
      userId: this.player.userId,
      message: result.message,
      groupId: data.groupId
    });

    // 如果使用了药剂，记录事件
    if (result.success && action.type !== 'SKIP') {
      this.engine.emit(GAME_EVENTS.WITCH_POTION_USED, {
        groupId: data.groupId,
        witch: this.player,
        target: result.target,
        potionType: action.type,
        day: this.engine.gameState.currentDay
      });
    }
  }

  /**
   * 使用解药
   * @param {string} targetTempId - 目标玩家的临时ID
   * @returns {object} 使用结果
   */
  useSavePotion(targetTempId) {
    if (!this.potions.save) {
      return {
        success: false,
        message: '❌ 你的解药已经用完了。'
      };
    }

    // 查找目标玩家
    const targetPlayer = this.engine.players.find(p => p.tempId === targetTempId && p.isAlive);
    
    if (!targetPlayer) {
      return {
        success: false,
        message: '❌ 目标玩家无效或已死亡，请重新选择。'
      };
    }

    // 使用解药
    this.potions.save = false;
    
    return {
      success: true,
      message: `💊 你使用了解药救治 ${targetPlayer.nickname}(${targetPlayer.tempId}号)。`,
      target: targetPlayer
    };
  }

  /**
   * 使用毒药
   * @param {string} targetTempId - 目标玩家的临时ID
   * @returns {object} 使用结果
   */
  usePoisonPotion(targetTempId) {
    if (!this.potions.kill) {
      return {
        success: false,
        message: '❌ 你的毒药已经用完了。'
      };
    }

    // 查找目标玩家
    const targetPlayer = this.engine.players.find(p => p.tempId === targetTempId && p.isAlive);
    
    if (!targetPlayer) {
      return {
        success: false,
        message: '❌ 目标玩家无效或已死亡，请重新选择。'
      };
    }

    // 不能毒死自己
    if (targetPlayer.userId === this.player.userId) {
      return {
        success: false,
        message: '❌ 你不能对自己使用毒药。'
      };
    }

    // 使用毒药
    this.potions.kill = false;
    
    return {
      success: true,
      message: `☠️ 你使用了毒药毒死 ${targetPlayer.nickname}(${targetPlayer.tempId}号)。`,
      target: targetPlayer
    };
  }

  /**
   * 跳过行动
   * @returns {object} 跳过结果
   */
  skipAction() {
    return {
      success: true,
      message: `⏭️ 你选择本回合不使用任何药剂。`
    };
  }

  /**
   * 夜晚结束时的处理
   * @param {object} data - 事件数据
   */
  onNightEnded(data) {
    // 重置行动状态
    this.hasActed = false;
  }

  /**
   * 获取角色状态信息
   * @returns {object} 状态信息
   */
  getStatus() {
    return {
      role: '女巫',
      isAlive: this.player.isAlive,
      hasActed: this.hasActed,
      potions: { ...this.potions },
      description: '拥有一瓶解药和一瓶毒药，解药可以救人，毒药可以杀人'
    };
  }

  /**
   * 清理资源
   */
  cleanup() {
    // 移除所有事件监听器
    this.engine.removeAllListeners();
  }
}
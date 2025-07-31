import { GAME_EVENTS, ROLE_EVENTS, INTERACTION_EVENTS, ROLES } from '../GameEvents.js';

/**
 * @class Seer
 * @description 预言家角色逻辑
 * 职责：监听游戏事件，执行查验技能，处理查验结果
 */
export class Seer {
  constructor(engine, player) {
    this.engine = engine;
    this.player = player;
    this.hasActed = false; // 当晚是否已行动
    
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
    // 如果预言家已死亡，不执行任何操作
    if (!this.player.isAlive) {
      return;
    }

    this.hasActed = false;

    // 发送查验提示给预言家
    const message = `🔮 预言家请行动！\n\n请发送 "#查验 编号" 来查验一名玩家的身份。\n例如：#查验 03`;
    
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
    
    // 只处理预言家的查验行动
    if (action.userId !== this.player.userId || action.type !== 'CHECK') {
      return;
    }

    // 执行查验逻辑
    const result = this.performCheck(action.targetId);
    
    if (result.success) {
      this.hasActed = true;
      
      // 发送查验结果给预言家
      this.engine.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, {
        userId: this.player.userId,
        message: result.message,
        groupId: data.groupId
      });

      // 记录查验事件到游戏日志
      this.engine.emit(GAME_EVENTS.SEER_CHECK_RESULT, {
        groupId: data.groupId,
        seer: this.player,
        target: result.target,
        result: result.isWerewolf ? 'WEREWOLF' : 'GOOD_PERSON',
        day: this.engine.gameState.currentDay
      });
    }
  }

  /**
   * 执行查验操作
   * @param {string} targetTempId - 目标玩家的临时ID
   * @returns {object} 查验结果
   */
  performCheck(targetTempId) {
    // 查找目标玩家
    const targetPlayer = this.engine.players.find(p => p.tempId === targetTempId && p.isAlive);
    
    if (!targetPlayer) {
      return {
        success: false,
        message: '❌ 目标玩家无效或已死亡，请重新选择。'
      };
    }

    // 不能查验自己
    if (targetPlayer.userId === this.player.userId) {
      return {
        success: false,
        message: '❌ 你不能查验自己，请选择其他玩家。'
      };
    }

    // 判断目标是否为狼人
    const isWerewolf = this.isWerewolfRole(targetPlayer.role);
    
    const resultMessage = `🔮 查验结果：\n\n${targetPlayer.nickname}(${targetPlayer.tempId}号) 的身份是 【${isWerewolf ? '狼人' : '好人'}】`;

    return {
      success: true,
      message: resultMessage,
      target: targetPlayer,
      isWerewolf: isWerewolf
    };
  }

  /**
   * 判断角色是否为狼人阵营
   * @param {string} role - 角色类型
   * @returns {boolean} 是否为狼人
   */
  isWerewolfRole(role) {
    return [ROLES.WEREWOLF, ROLES.WOLF_KING, ROLES.WHITE_WOLF_KING].includes(role);
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
      role: '预言家',
      isAlive: this.player.isAlive,
      hasActed: this.hasActed,
      description: '每晚可以查验一名玩家的身份（好人或狼人）'
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
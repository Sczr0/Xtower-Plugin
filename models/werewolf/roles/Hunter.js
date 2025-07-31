import { GAME_EVENTS, INTERACTION_EVENTS } from '../GameEvents.js';

/**
 * @class Hunter
 * @description 猎人角色逻辑
 * 职责：死亡时可以开枪带走一名玩家
 */
export class Hunter {
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
    // 监听玩家死亡事件
    this.engine.on(GAME_EVENTS.PLAYER_DIED, this.onPlayerDied.bind(this));
    
    // 监听夜晚结束事件
    this.engine.on(GAME_EVENTS.NIGHT_ENDED, this.onNightEnded.bind(this));
  }

  /**
   * 玩家死亡时的处理
   * @param {object} data - 事件数据
   */
  onPlayerDied(data) {
    if (data.player.userId === this.player.userId) {
      // 如果猎人自己死亡，不能再行动
      return;
    }

    // 如果猎人还活着，提示猎人选择开枪
    if (this.player.isAlive && !this.hasActed) {
      const message = `🔫 猎人，请选择开枪带走一名玩家。\n\n` +
                      `请发送 "#开枪 编号" 来选择目标。\n` +
                      `例如：#开枪 03`;
      
      this.engine.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, {
        userId: this.player.userId,
        message: message,
        groupId: data.groupId
      });
    }
  }

  /**
   * 开枪操作
   * @param {string} targetTempId - 目标玩家的临时ID
   * @returns {object} 开枪结果
   */
  shoot(targetTempId) {
    if (this.hasActed) {
      return { success: false, message: '❌ 你今晚已经开过枪了。' };
    }

    const targetPlayer = this.engine.players.find(p => p.tempId === targetTempId && p.isAlive);
    
    if (!targetPlayer) {
      return { success: false, message: '❌ 目标玩家无效或已死亡。' };
    }

    this.hasActed = true; // 标记为已行动

    // 处理目标玩家死亡
    targetPlayer.isAlive = false;
    this.engine.emit(GAME_EVENTS.PLAYER_DIED, {
      groupId: this.engine.groupId,
      player: targetPlayer,
      cause: 'hunter_shoot'
    });

    return {
      success: true,
      message: `🔫 你选择开枪带走 ${targetPlayer.nickname}(${targetPlayer.tempId}号)。`
    };
  }

  /**
   * 夜晚结束时的处理
   * @param {object} data - 事件数据
   */
  onNightEnded(data) {
    this.hasActed = false; // 重置行动状态
  }

  /**
   * 获取角色状态信息
   * @returns {object} 状态信息
   */
  getStatus() {
    return {
      role: '猎人',
      isAlive: this.player.isAlive,
      hasActed: this.hasActed,
      description: '死亡时可以开枪带走一名玩家'
    };
  }

  /**
   * 清理资源
   */
  cleanup() {
    this.engine.removeAllListeners();
  }
}
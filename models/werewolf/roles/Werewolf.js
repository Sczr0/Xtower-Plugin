import { GAME_EVENTS, ROLE_EVENTS, INTERACTION_EVENTS, ROLES } from '../GameEvents.js';

/**
 * @class Werewolf
 * @description 狼人角色逻辑
 * 职责：监听游戏事件，执行杀人技能，处理狼人聊天
 */
export class Werewolf {
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
    
    // 监听狼人聊天事件
    this.engine.on(ROLE_EVENTS.WEREWOLF_CHAT_MESSAGE, this.onWerewolfChat.bind(this));
  }

  /**
   * 夜晚开始时的处理
   * @param {object} data - 事件数据
   */
  onNightStarted(data) {
    // 如果狼人已死亡，不执行任何操作
    if (!this.player.isAlive) {
      return;
    }

    this.hasActed = false;

    // 获取所有活着的狼队友
    const aliveWerewolves = this.getAliveWerewolves();
    
    // 发送夜晚行动提示给狼人
    let message = `🐺 狼人请行动！\n\n`;
    message += `请发送 "#杀 编号" 来选择击杀目标。\n`;
    message += `例如：#杀 03\n\n`;
    
    if (aliveWerewolves.length > 1) {
      message += `🗣️ 狼人频道：\n`;
      message += `发送 "#狼人 消息内容" 可以与队友私聊。\n`;
      message += `例如：#狼人 我们杀谁？\n\n`;
      
      message += `👥 存活的狼队友：\n`;
      aliveWerewolves.forEach(wolf => {
        if (wolf.userId !== this.player.userId) {
          message += `- ${wolf.nickname}(${wolf.tempId}号)\n`;
        }
      });
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
    
    // 只处理狼人的杀人行动
    if (action.userId !== this.player.userId || action.type !== 'KILL') {
      return;
    }

    // 执行杀人逻辑
    const result = this.performKill(action.targetId);
    
    if (result.success) {
      this.hasActed = true;
      
      // 发送确认消息给狼人
      this.engine.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, {
        userId: this.player.userId,
        message: result.message,
        groupId: data.groupId
      });

      // 通知其他狼队友
      this.notifyWerewolfTeam(result.target, data.groupId);
    } else {
      // 发送错误消息
      this.engine.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, {
        userId: this.player.userId,
        message: result.message,
        groupId: data.groupId
      });
    }
  }

  /**
   * 执行杀人操作
   * @param {string} targetTempId - 目标玩家的临时ID
   * @returns {object} 杀人结果
   */
  performKill(targetTempId) {
    // 查找目标玩家
    const targetPlayer = this.engine.players.find(p => p.tempId === targetTempId && p.isAlive);
    
    if (!targetPlayer) {
      return {
        success: false,
        message: '❌ 目标玩家无效或已死亡，请重新选择。'
      };
    }

    // 不能杀死狼队友
    if (this.isWerewolfRole(targetPlayer.role)) {
      return {
        success: false,
        message: '❌ 你不能杀死狼队友，请选择其他目标。'
      };
    }

    const resultMessage = `🐺 已选择击杀 ${targetPlayer.nickname}(${targetPlayer.tempId}号)，等待夜晚结束。`;

    return {
      success: true,
      message: resultMessage,
      target: targetPlayer
    };
  }

  /**
   * 通知狼人队友击杀选择
   * @param {object} target - 目标玩家
   * @param {string} groupId - 群组ID
   */
  notifyWerewolfTeam(target, groupId) {
    const aliveWerewolves = this.getAliveWerewolves();
    const message = `🐺 [狼人频道] ${this.player.nickname}(${this.player.tempId}号) 选择击杀 ${target.nickname}(${target.tempId}号)`;

    aliveWerewolves.forEach(wolf => {
      if (wolf.userId !== this.player.userId) {
        this.engine.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, {
          userId: wolf.userId,
          message: message,
          groupId: groupId
        });
      }
    });
  }

  /**
   * 处理狼人聊天
   * @param {object} data - 聊天数据
   */
  onWerewolfChat(data) {
    const { senderId, message, groupId } = data;
    
    // 只有活着的狼人才能参与聊天
    if (!this.player.isAlive || senderId === this.player.userId) {
      return;
    }

    const sender = this.engine.players.find(p => p.userId === senderId);
    if (!sender || !this.isWerewolfRole(sender.role)) {
      return;
    }

    const chatMessage = `🐺 [狼人频道] ${sender.nickname}(${sender.tempId}号): ${message}`;
    
    this.engine.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, {
      userId: this.player.userId,
      message: chatMessage,
      groupId: groupId
    });
  }

  /**
   * 获取所有活着的狼人
   * @returns {Array} 活着的狼人列表
   */
  getAliveWerewolves() {
    return this.engine.players.filter(p => 
      p.isAlive && this.isWerewolfRole(p.role)
    );
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
      role: '狼人',
      isAlive: this.player.isAlive,
      hasActed: this.hasActed,
      description: '夜晚可以杀死一名玩家，与其他狼人为同伙'
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
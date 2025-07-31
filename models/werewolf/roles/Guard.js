import { GAME_EVENTS, INTERACTION_EVENTS } from '../GameEvents.js';

/**
 * @class Guard
 * @description 守卫角色逻辑
 * 职责：每晚可以守护一名玩家，被守护的玩家当晚不会死亡
 */
export class Guard {
  constructor(engine, player) {
    this.engine = engine;
    this.player = player;
    this.hasActed = false;
    this.lastProtectedId = null;
    
    this.setupEventListeners();
  }

  setupEventListeners() {
    this.engine.on(GAME_EVENTS.NIGHT_STARTED, this.onNightStarted.bind(this));
    this.engine.on(GAME_EVENTS.NIGHT_ACTION_RECEIVED, this.onNightActionReceived.bind(this));
    this.engine.on(GAME_EVENTS.NIGHT_ENDED, this.onNightEnded.bind(this));
  }

  onNightStarted(data) {
    if (!this.player.isAlive) return;
    
    this.hasActed = false;
    let message = `🛡️ 守卫请行动！\n\n请发送 "#守护 编号" 来守护一名玩家。\n例如：#守护 03\n\n`;
    
    if (this.lastProtectedId) {
      const lastProtected = this.engine.players.find(p => p.userId === this.lastProtectedId);
      if (lastProtected) {
        message += `⚠️ 注意：你不能连续两晚守护同一个人 (${lastProtected.nickname})`;
      }
    }
    
    this.engine.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, {
      userId: this.player.userId,
      message: message,
      groupId: data.groupId
    });
  }

  onNightActionReceived(data) {
    const { action } = data;
    if (action.userId !== this.player.userId || action.type !== 'PROTECT') return;
    
    const result = this.performProtection(action.targetId);
    if (result.success) {
      this.hasActed = true;
      this.lastProtectedId = result.target.userId;
    }
    
    this.engine.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, {
      userId: this.player.userId,
      message: result.message,
      groupId: data.groupId
    });
  }

  performProtection(targetTempId) {
    const targetPlayer = this.engine.players.find(p => p.tempId === targetTempId && p.isAlive);
    
    if (!targetPlayer) {
      return { success: false, message: '❌ 目标玩家无效或已死亡。' };
    }
    
    if (targetPlayer.userId === this.lastProtectedId) {
      return { success: false, message: '❌ 不能连续两晚守护同一个人。' };
    }
    
    return {
      success: true,
      message: `🛡️ 你选择守护 ${targetPlayer.nickname}(${targetPlayer.tempId}号)。`,
      target: targetPlayer
    };
  }

  onNightEnded(data) {
    this.hasActed = false;
  }

  getStatus() {
    return {
      role: '守卫',
      isAlive: this.player.isAlive,
      hasActed: this.hasActed,
      description: '每晚可以守护一名玩家，被守护的玩家当晚不会死亡'
    };
  }

  cleanup() {
    this.engine.removeAllListeners();
  }
}
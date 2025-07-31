import { GAME_EVENTS, INTERACTION_EVENTS, ROLES } from '../GameEvents.js';

export class WhiteWolfKing {
  constructor(engine, player) {
    this.engine = engine;
    this.player = player;
    this.hasActed = false;
    this.setupEventListeners();
  }

  setupEventListeners() {
    this.engine.on(GAME_EVENTS.NIGHT_STARTED, this.onNightStarted.bind(this));
    this.engine.on(GAME_EVENTS.NIGHT_ACTION_RECEIVED, this.onNightActionReceived.bind(this));
    this.engine.on(ROLE_EVENTS.WEREWOLF_CHAT_MESSAGE, this.onWerewolfChat.bind(this));
  }

  onNightStarted(data) {
    if (!this.player.isAlive) return;
    
    this.hasActed = false;
    const aliveWerewolves = this.getAliveWerewolves();
    
    let message = `⚪👑🐺 白狼王请行动！\n\n`;
    message += `请选择以下行动之一：\n`;
    message += `- "#杀 编号" 选择击杀目标\n`;
    message += `- "#自爆 编号" 自爆并带走一名玩家\n`;
    message += `例如：#杀 03 或 #自爆 05\n\n`;
    
    if (aliveWerewolves.length > 1) {
      message += `🗣️ 狼人频道：发送 "#狼人 消息内容" 可以与队友私聊。\n\n`;
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

  onNightActionReceived(data) {
    const { action } = data;
    if (action.userId !== this.player.userId) return;
    
    let result;
    if (action.type === 'KILL') {
      result = this.performKill(action.targetId);
      if (result.success) {
        this.notifyWerewolfTeam(result.target, data.groupId);
      }
    } else if (action.type === 'EXPLODE') {
      result = this.explode(action.targetId);
    } else {
      return;
    }
    
    if (result.success) {
      this.hasActed = true;
    }
    
    this.engine.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, {
      userId: this.player.userId,
      message: result.message,
      groupId: data.groupId
    });
  }

  performKill(targetTempId) {
    const targetPlayer = this.engine.players.find(p => p.tempId === targetTempId && p.isAlive);
    
    if (!targetPlayer) {
      return { success: false, message: '❌ 目标玩家无效或已死亡。' };
    }
    
    if (this.isWerewolfRole(targetPlayer.role)) {
      return { success: false, message: '❌ 你不能杀死狼队友。' };
    }
    
    return {
      success: true,
      message: `⚪👑🐺 已选择击杀 ${targetPlayer.nickname}(${targetPlayer.tempId}号)。`,
      target: targetPlayer
    };
  }

  explode(targetTempId) {
    const targetPlayer = this.engine.players.find(p => p.tempId === targetTempId && p.isAlive);
    
    if (!targetPlayer) {
      return { success: false, message: '❌ 目标玩家无效或已死亡。' };
    }
    
    if (targetPlayer.userId === this.player.userId) {
      return { success: false, message: '❌ 你不能对自己使用技能。' };
    }
    
    // 白狼王自爆
    this.player.isAlive = false;
    targetPlayer.isAlive = false;
    
    // 触发死亡事件
    this.engine.emit(GAME_EVENTS.PLAYER_DIED, {
      groupId: this.engine.groupId,
      player: this.player,
      cause: 'white_wolf_king_explode'
    });
    
    this.engine.emit(GAME_EVENTS.PLAYER_DIED, {
      groupId: this.engine.groupId,
      player: targetPlayer,
      cause: 'white_wolf_king_explode'
    });
    
    // 广播自爆消息
    this.engine.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, {
      groupId: this.engine.groupId,
      message: `💥 白狼王 ${this.player.nickname}(${this.player.tempId}号) 自爆了！带走了 ${targetPlayer.nickname}(${targetPlayer.tempId}号)！`
    });
    
    return {
      success: true,
      message: `💥 你选择自爆并带走 ${targetPlayer.nickname}(${targetPlayer.tempId}号)！`
    };
  }

  notifyWerewolfTeam(target, groupId) {
    const aliveWerewolves = this.getAliveWerewolves();
    const message = `⚪👑🐺 [狼人频道] 白狼王${this.player.nickname}(${this.player.tempId}号) 选择击杀 ${target.nickname}(${target.tempId}号)`;

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

  onWerewolfChat(data) {
    const { senderId, message, groupId } = data;
    if (!this.player.isAlive || senderId === this.player.userId) return;

    const sender = this.engine.players.find(p => p.userId === senderId);
    if (!sender || !this.isWerewolfRole(sender.role)) return;

    const chatMessage = `🐺 [狼人频道] ${sender.nickname}(${sender.tempId}号): ${message}`;
    
    this.engine.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, {
      userId: this.player.userId,
      message: chatMessage,
      groupId: groupId
    });
  }

  getAliveWerewolves() {
    return this.engine.players.filter(p => 
      p.isAlive && this.isWerewolfRole(p.role)
    );
  }

  isWerewolfRole(role) {
    return [ROLES.WEREWOLF, ROLES.WOLF_KING, ROLES.WHITE_WOLF_KING].includes(role);
  }

  getStatus() {
    return {
      role: '白狼王',
      isAlive: this.player.isAlive,
      hasActed: this.hasActed,
      description: '狼人阵营，可以自爆并带走一名玩家'
    };
  }

  cleanup() {
    this.engine.removeAllListeners();
  }
}
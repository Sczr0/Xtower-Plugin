import { GAME_EVENTS, INTERACTION_EVENTS } from '../GameEvents.js';

export class Idiot {
  constructor(engine, player) {
    this.engine = engine;
    this.player = player;
    this.isRevealed = false;
    this.setupEventListeners();
  }

  setupEventListeners() {
    this.engine.on(GAME_EVENTS.VOTE_ENDED, this.onVoteEnded.bind(this));
  }

  onVoteEnded(data) {
    if (data.targetId === this.player.userId && !this.isRevealed) {
      this.isRevealed = true;
      this.player.isAlive = true; // 确保不死亡
      
      const message = `🃏 ${this.player.nickname}(${this.player.tempId}号) 翻牌了！他是白痴，不会死亡但失去投票权。`;
      
      this.engine.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, {
        groupId: data.groupId,
        message: message
      });
    }
  }

  getStatus() {
    return {
      role: '白痴',
      isAlive: this.player.isAlive,
      isRevealed: this.isRevealed,
      description: '被投票出局时不会死亡，但失去投票权'
    };
  }

  cleanup() {
    this.engine.removeAllListeners();
  }
}
import { GAME_EVENTS, INTERACTION_EVENTS } from '../GameEvents.js';

/**
 * @class Villager
 * @description 村民角色逻辑
 * 职责：普通村民，没有特殊技能，主要参与白天的发言和投票
 */
export class Villager {
  constructor(engine, player) {
    this.engine = engine;
    this.player = player;
    
    // 监听游戏事件
    this.setupEventListeners();
  }

  /**
   * 设置事件监听器
   */
  setupEventListeners() {
    // 监听游戏开始事件
    this.engine.on(GAME_EVENTS.GAME_STARTED, this.onGameStarted.bind(this));
    
    // 监听白天开始事件
    this.engine.on(GAME_EVENTS.DAY_STARTED, this.onDayStarted.bind(this));
    
    // 监听投票开始事件
    this.engine.on(GAME_EVENTS.VOTE_STARTED, this.onVoteStarted.bind(this));
  }

  /**
   * 游戏开始时的处理
   * @param {object} data - 事件数据
   */
  onGameStarted(data) {
    // 发送角色信息给村民
    const message = `👨‍🌾 你的身份是：村民\n\n` +
                   `📝 角色说明：\n` +
                   `- 你是好人阵营的一员\n` +
                   `- 你没有特殊的夜晚技能\n` +
                   `- 通过白天的发言和投票帮助好人阵营获胜\n` +
                   `- 仔细观察和分析，找出狼人！\n\n` +
                   `🎯 胜利条件：投票出所有狼人`;
    
    this.engine.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, {
      userId: this.player.userId,
      message: message,
      groupId: data.groupId
    });
  }

  /**
   * 白天开始时的处理
   * @param {object} data - 事件数据
   */
  onDayStarted(data) {
    if (!this.player.isAlive) {
      return;
    }

    // 发送白天阶段提示
    const message = `☀️ 白天 ${data.day} 开始了！\n\n` +
                   `现在是自由发言时间，请仔细分析昨夜的情况，\n` +
                   `与其他玩家讨论，找出可疑的狼人。\n\n` +
                   `💡 提示：\n` +
                   `- 注意观察其他玩家的发言\n` +
                   `- 分析逻辑是否合理\n` +
                   `- 留意投票的倾向`;
    
    this.engine.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, {
      userId: this.player.userId,
      message: message,
      groupId: data.groupId
    });
  }

  /**
   * 投票开始时的处理
   * @param {object} data - 事件数据
   */
  onVoteStarted(data) {
    if (!this.player.isAlive) {
      return;
    }

    // 发送投票提示
    const message = `🗳️ 投票阶段开始！\n\n` +
                   `请发送 "#投票 编号" 来投票出局一名玩家。\n` +
                   `例如：#投票 05\n\n` +
                   `⚠️ 请谨慎投票，这关系到游戏的胜负！`;
    
    this.engine.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, {
      userId: this.player.userId,
      message: message,
      groupId: data.groupId
    });
  }

  /**
   * 获取角色状态信息
   * @returns {object} 状态信息
   */
  getStatus() {
    return {
      role: '村民',
      isAlive: this.player.isAlive,
      hasSpecialAbility: false,
      description: '普通村民，没有特殊技能，通过投票和推理帮助好人阵营获胜'
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
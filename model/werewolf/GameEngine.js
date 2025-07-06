// model/werewolf/GameEngine.js
import { ROLES, TAGS, TEAMS, GAME_PHASE, GAME_PRESETS, WOLF_TEAM_ROLES } from "./constants.js";
import { shuffleArray } from "./utils.js";
import { Player } from "./Player.js"; // 导入 Player 类
import werewolfConfig from './config.js';

/**
 * @class GameEngine
 * @description 游戏的核心引擎，管理状态机和游戏规则。
 */
export class GameEngine {
  constructor(players) {
    this.players = players;
    this.config = werewolfConfig;
    this.gameState = {
      day: 0,
      phase: null,
      sheriffId: null,
      sheriffCandidates: [],
      sheriffVotes: {},
      speakingOrder: [],
      currentSpeakerIndex: -1,
      votes: {},
      nightActionStatus: {},
      witchPotions: { antidote: true, poison: true },
      lastWordPlayerId: null,
      lastWordEndTime: null,
      pkPlayers: [],
      pkVotes: {},
      wolfKingClawTargetId: null, // 狼王爪目标ID
      // 计时器相关状态
      timerId: null, // 存储 setTimeout 返回的 ID
      timerEndTime: null, // 计时器结束的时间戳
      timerPhase: null, // 当前计时器所属的游戏阶段
    };
    this.eventQueue = [];
    this.pendingDeaths = [];
    this.gameLog = [];
    void Player;
  }

  // --- 辅助函数 ---

  /**
   * 根据 userId 获取玩家实例
   * @param {string} userId
   * @returns {Player|undefined}
   */
  getPlayer(userId) {
    return this.players.find(p => p.userId === userId);
  }

  /**
   * 根据临时编号获取玩家实例
   * @param {string} tempId
   * @returns {Player|undefined}
   */
  getPlayerByTempId(tempId) {
    return this.players.find(p => p.tempId === tempId);
  }

  /**
   * 获取所有存活玩家
   * @returns {Array<Player>}
   */
  getAlivePlayers() {
    return this.players.filter(p => p.isAlive);
  }

  /**
   * 获取狼人夜晚刀的目标
   * @returns {Player|null} 被刀的目标玩家，如果没有统一目标则返回 null
   */
  getAttackedByWolfTarget() {
    const wolfVotes = {};
    const aliveWolves = this.getAlivePlayers().filter(p => WOLF_TEAM_ROLES.includes(p.role.roleId));

    // 统计狼人投票
    for (const wolf of aliveWolves) {
      const action = wolf.role.nightActionData; // 假设狼人角色会存储他们的刀人目标
      if (action && action.targetId) {
        wolfVotes[action.targetId] = (wolfVotes[action.targetId] || 0) + 1;
      }
    }

    let maxVotes = 0;
    let targetPlayerId = null;
    let hasTie = false;

    for (const targetId in wolfVotes) {
      if (wolfVotes[targetId] > maxVotes) {
        maxVotes = wolfVotes[targetId];
        targetPlayerId = targetId;
        hasTie = false;
      } else if (wolfVotes[targetId] === maxVotes) {
        hasTie = true;
      }
    }

    if (hasTie || !targetPlayerId) {
      return null; // 有平票或没有刀人目标
    }

    return this.getPlayer(targetPlayerId);
  }

  /**
   * 初始化游戏，分配角色并生成初始事件
   * @param {string} boardName 游戏板子名称
   * @returns {{error?: string, events: Array<object>}} 包含错误信息或初始事件的数组
   */
  initializeGame(boardName) {
    const events = [];
    // 1. 根据板子名称获取角色配置
    const roleConfig = this.config.rolePresets[boardName];
    if (!roleConfig) {
      return { error: `未找到板子【${boardName}】的角色配置。` };
    }
    const totalRolesCount = Object.values(roleConfig).reduce((sum, count) => sum + count, 0);
    if (this.players.length !== totalRolesCount) {
      return { error: `玩家人数 (${this.players.length}) 与板子【${boardName}】所需角色数 (${totalRolesCount}) 不匹配。` };
    }

    // 2. 分配角色
    let rolesToAssign = [];
    for (const roleId in roleConfig) {
      for (let i = 0; i < roleConfig[roleId]; i++) {
        rolesToAssign.push(roleId);
      }
    }
    shuffleArray(rolesToAssign); // 打乱角色顺序

    this.players.forEach((player, index) => {
      const roleId = rolesToAssign[index];
      const RoleClass = this.config.roleClasses[roleId];
      if (!RoleClass) {
        throw new Error(`未找到角色ID ${roleId} 对应的类。`);
      }
      player.role = new RoleClass(player);
      events.push({ type: 'private_message', userId: player.userId, content: `你的身份是：${player.role.name}。` });
      player.isAlive = true; // 确保玩家初始状态为存活
    });

    // 3. 设置游戏初始状态
    this.gameState.day = 0; // 游戏从第0天开始，夜晚行动后进入第1天
    this.gameState.phase = GAME_PHASE.NIGHT_START; // 游戏开始直接进入夜晚
    this.gameLog.push({ type: 'game_start', day: 0, board: boardName }); // 记录游戏开始事件

    return { events };
  }

  // --- 核心状态机 ---

  async transitionTo(phase, data = {}) {
    this.stopTimer(); // 切换阶段时停止当前计时器
    this.gameState.phase = phase;
    let events = [];
    switch (phase) {
      case GAME_PHASE.NIGHT_START:
        events = this.startNightPhase();
        this.startTimer(GAME_PHASE.NIGHT_START, this.config.nightActionDuration);
        break;
      case GAME_PHASE.DAY_ANNOUNCEMENT:
        events = await this.processPendingDeaths();
        break;
      case GAME_PHASE.SHERIFF_ELECTION:
        events = this.startSheriffElection();
        this.startTimer(GAME_PHASE.SHERIFF_ELECTION, this.config.sheriffSpeakDuration);
        break;
      case GAME_PHASE.SHERIFF_VOTE:
        events = this.startSheriffVote();
        this.startTimer(GAME_PHASE.SHERIFF_VOTE, this.config.sheriffVoteDuration);
        break;
      case GAME_PHASE.DAY_SPEAK:
        events = this.startDaySpeakPhase();
        this.startTimer(GAME_PHASE.DAY_SPEAK, this.config.daySpeakDuration);
        break;
      case GAME_PHASE.DAY_VOTE:
        events = this.startVotePhase();
        this.startTimer(GAME_PHASE.DAY_VOTE, this.config.dayVoteDuration);
        break;
      case GAME_PHASE.VOTE_RESULT:
        events = await this.processVoteResults();
        break;
      case GAME_PHASE.HUNTER_SHOOT:
        events = this.startHunterShootPhase(data);
        // 猎人开枪通常没有固定计时器，等待玩家操作或手动结束
        break;
      case GAME_PHASE.LAST_WORDS:
        events = this.startLastWordsPhase(data.playerId);
        // 遗言计时器在 startLastWordsPhase 内部管理
        break;
      case GAME_PHASE.PK_VOTE:
        events = this.startPkVotePhase(data.pkPlayers);
        // PK投票计时器在 startPkVotePhase 内部管理
        break;
      case GAME_PHASE.WOLF_KING_CLAW: // 狼王爪阶段
        events = this.startWolfKingClawPhase(data.wolfKingId, data.groupId);
        // 狼王爪计时器待定，通常是等待玩家操作
        break;
      case GAME_PHASE.IDIOT_FLIP: // 白痴翻牌阶段
        events = this.startIdiotFlipPhase(data.idiotId, data.groupId);
        // 白痴翻牌通常没有计时器，是即时事件
        break;
      // ... 其他阶段
    }
    return events;
  }

  /**
   * 核心事件循环处理器
   * @description 循环处理事件队列，直到队列为空
   */
  async processEventQueue() {
    let allGeneratedEvents = [];
    while (this.eventQueue.length > 0) {
      const eventToProcess = this.eventQueue.shift();
      const newEvents = await this.transitionTo(eventToProcess.event, eventToProcess.data);
      allGeneratedEvents.push(...newEvents);
    }
    return allGeneratedEvents;
  }

  // --- 计时器管理 ---
  startTimer(phase, duration) {
    this.stopTimer(); // 确保只有一个计时器在运行
    this.gameState.timerPhase = phase;
    this.gameState.timerEndTime = Date.now() + duration * 1000;
    this.gameState.timerId = setTimeout(async () => {
      logger(`计时器超时：阶段 ${this.gameState.timerPhase}`);
      let events = [];
      switch (this.gameState.timerPhase) {
        case GAME_PHASE.NIGHT_START:
          // 夜晚行动超时，强制进入白天公布结果
          events.push({ type: 'group_message', content: '夜晚行动时间到，将自动进入白天。' });
          events.push(...(await this.processNightResults()));
          break;
        case GAME_PHASE.SHERIFF_ELECTION:
          // 上警发言超时，强制进入警上投票或白天发言
          events.push({ type: 'group_message', content: '警长竞选发言时间到，将自动进入警上投票。' });
          events.push(...(await this.processSheriffVoteResults())); // 警上发言结束后直接进入投票结果处理
          break;
        case GAME_PHASE.SHERIFF_VOTE:
          // 警上投票超时，强制进入警上投票结果
          events.push({ type: 'group_message', content: '警上投票时间到，将自动公布警长结果。' });
          events.push(...(await this.processSheriffVoteResults()));
          break;
        case GAME_PHASE.DAY_SPEAK:
          // 白天发言超时，强制跳到下一位玩家或进入投票
          events.push({ type: 'group_message', content: '发言时间到，将自动切换到下一位玩家。' });
          events.push(...(await this.nextSpeaker())); // nextSpeaker 内部会判断是否进入投票
          break;
        case GAME_PHASE.DAY_VOTE:
          // 白天投票超时，强制进行投票结果
          events.push({ type: 'group_message', content: '投票时间到，将自动公布投票结果。' });
          events.push(...(await this.processVoteResults()));
          break;
        // 其他计时器，例如遗言计时器在 startLastWordsPhase 内部管理
      }
      // 触发事件
      if (events.length > 0) {
        this.eventQueue.push({ event: 'timer_timeout_events', data: { events: events, groupId: this.groupId } });
        await this.processEventQueue();
      }
      this.stopTimer(); // 计时器处理完毕后停止计时器
    }, duration * 1000);
  }

  stopTimer() {
    if (this.gameState.timerId) {
      clearTimeout(this.gameState.timerId);
      this.gameState.timerId = null;
      this.gameState.timerEndTime = null;
      this.gameState.timerPhase = null;
      logger('计时器已停止。');
    }
  }

  // --- 流程实现 ---

  startNightPhase() {
    this.gameState.day++;
    this.players.forEach(p => p.clearTemporaryTags());
    this.gameState.votes = {};
    this.gameState.nightActionStatus = {};
    const actionTakers = this.getAlivePlayers().filter(p => p.role.hasNightAction());
    actionTakers.forEach(p => {
      this.gameState.nightActionStatus[p.userId] = 'pending';
    });

    let events = [{ type: 'group_message', content: `--- 第 ${this.gameState.day} 天 - 夜晚 ---\n天黑请闭眼...` }];
    this.gameLog.push({ type: 'night_start', day: this.gameState.day }); // 记录事件
    
    // 按优先级通知行动
    const actionsByPriority = actionTakers.reduce((acc, player) => {
        const priority = player.role.actionPriority;
        if (!acc[priority]) acc[priority] = [];
        acc[priority].push(player);
        return acc;
    }, {});
    
    const sortedPriorities = Object.keys(actionsByPriority).sort((a,b) => a - b);
    for (const priority of sortedPriorities) {
        for (const player of actionsByPriority[priority]) {
            events.push({ 
                type: 'private_message', 
                userId: player.userId, 
                content: player.role.getNightActionPrompt(this) || `请开始你的夜晚行动。`
            });
        }
    }
    return events;
  }

  async handleNightAction(player, actionData) {
    if (this.gameState.phase !== GAME_PHASE.NIGHT_START) return "当前不是夜晚行动时间。";
    if (!player.isAlive || this.gameState.nightActionStatus[player.userId] !== 'pending') return "你无法行动或已经行动过了。";
    
    const message = await player.role.performNightAction(this, player, actionData);
    this.gameState.nightActionStatus[player.userId] = 'done';
    
    // 记录夜晚行动事件
    const logEntry = { 
        type: 'night_action', 
        day: this.gameState.day, 
        actor: player.info, 
        action: actionData.actionType, 
        target: actionData.target ? actionData.target.info : '无' 
    };

    // 根据角色类型添加更详细的日志信息
    switch (player.role.roleId) {
        case ROLES.WITCH:
            if (actionData.actionType === 'save') {
                logEntry.type = 'witch_potion';
                logEntry.potion = 'antidote';
                logEntry.target = actionData.target.info;
            } else if (actionData.actionType === 'kill') {
                logEntry.type = 'witch_potion';
                logEntry.potion = 'poison';
                logEntry.target = actionData.target.info;
            }
            break;
        case ROLES.SEER:
            logEntry.type = 'seer_check';
            logEntry.target = actionData.target.info;
            const targetIsWolf = actionData.target.role.team === TEAMS.WOLF;
            logEntry.result = targetIsWolf ? '狼人' : '好人';
            break;
        case ROLES.WOLF_KING: // 狼王自刀
            if (actionData.target && actionData.target.userId === player.userId) {
                logEntry.type = 'wolf_king_self_stab';
                logEntry.target = player.info;
            }
            break;
        // 其他角色如果需要详细日志，可在此添加
    }

    this.gameLog.push(logEntry);

    return message;
  }

  checkNightActionsComplete() {
    return Object.values(this.gameState.nightActionStatus).every(status => status === 'done');
  }

  async processNightResults() {
    this.gameState.phase = 'night_processing';
    let events = [{ type: 'group_message', content: `天亮了，正在结算夜晚事件...` }];
    
    // 1. 结算狼刀
    const wolfTarget = this.getAttackedByWolfTarget(); // 调用改进后的方法

    // 通知所有狼人刀人结果
    const wolfTeamPlayers = this.players.filter(p => WOLF_TEAM_ROLES.includes(p.role.roleId));
    if (wolfTarget) {
        const message = `[狼人频道] 你们的刀人目标是：${wolfTarget.info}`;
        wolfTeamPlayers.forEach(p => {
            if (p.isAlive) { // 只有存活的狼人才能收到消息
                events.push({ type: 'private_message', userId: p.userId, content: message });
            }
        });
        // 将被刀对象加入 pendingDeaths
        wolfTarget.clearTemporaryTags(TAGS.DYING_FROM_WOLF);
        wolfTarget.addTag(TAGS.DYING_FROM_WOLF, { source: 'WOLF_TEAM' });
        this.gameLog.push({ type: 'wolf_kill', day: this.gameState.day, target: wolfTarget.info }); // 记录事件
    } else {
        const message = `[狼人频道] 昨晚没有统一的刀人目标，或所有狼人均未刀人。`;
        wolfTeamPlayers.forEach(p => {
            if (p.isAlive) { // 只有存活的狼人才能收到消息
                events.push({ type: 'private_message', userId: p.userId, content: message });
            }
        });
        this.gameLog.push({ type: 'wolf_kill_none', day: this.gameState.day }); // 记录空刀事件
    }

    // 2. 尾判定，确定死亡名单
    this.getAlivePlayers().forEach(p => {
      const isPoisoned = p.hasTag(TAGS.POISONED_BY_WITCH);
      const isWolfAttacked = p.hasTag(TAGS.DYING_FROM_WOLF);
      const isGuarded = p.hasTag(TAGS.GUARDED);
      const isSaved = p.hasTag(TAGS.SAVED_BY_WITCH);

      let shouldDie = false;
      if (isPoisoned) {
          shouldDie = true;
      } else if (isWolfAttacked) {
          if (isGuarded && isSaved) shouldDie = true; // 同守同救死
          else if (!isGuarded && !isSaved) shouldDie = true;
      }
      
      if (shouldDie) {
        this.pendingDeaths.push(p);
      }
    });

    // 3. 进入白天，处理死亡事件
    events.push(...(await this.transitionTo(GAME_PHASE.DAY_ANNOUNCEMENT)));
    return events;
  }
  
  /**
   * 处理所有待定死亡，并触发相应技能
   */
  async processPendingDeaths() {
    let events = [];
    if (this.pendingDeaths.length === 0) {
      events.push({ type: 'group_message', content: '昨晚是个平安夜。' });
      this.gameLog.push({ type: 'peaceful_night', day: this.gameState.day }); // 记录事件
    } else {
      let deathAnnouncement = '昨晚死亡的玩家是：';
      const currentPendingDeaths = [...this.pendingDeaths]; // 复制一份，因为onDeath可能会添加新的pendingDeaths
      this.pendingDeaths = []; // 清空待处理死亡
      
      for (const player of currentPendingDeaths) {
        if (!player.isAlive) continue; // 玩家可能在之前处理的技能中已经死亡
        player.isAlive = false;
        deathAnnouncement += `${player.info} `;
        this.gameLog.push({ type: 'night_death', day: this.gameState.day, player: player.info, role: player.role.name }); // 记录事件
        const deathEvent = player.role.onDeath(this, player);
        if (deathEvent) this.eventQueue.push(deathEvent);
      }
      events.push({ type: 'group_message', content: deathAnnouncement });
    }
    this.pendingDeaths = []; // 确保清空
    
    const endStatus = this.checkGameEnd();
    if (endStatus.isEnd) {
        events.push({ type: 'game_end', ...endStatus });
        return events;
    }

    if (this.eventQueue.length > 0) {
      events.push(...(await this.processEventQueue()));
    } else {
        if (this.gameState.day === 1 && this.config.enableSheriff) { // 根据配置判断是否进入警长竞选
            events.push(...(await this.transitionTo(GAME_PHASE.SHERIFF_ELECTION)));
        } else {
            events.push(...this.startDaySpeakPhase());
        }
    }
    return events;
  }

  startSheriffElection() {
    this.gameState.phase = GAME_PHASE.SHERIFF_ELECTION;
    this.gameState.sheriffCandidates = [];
    this.gameLog.push({ type: 'sheriff_election_start', day: this.gameState.day }); // 记录事件
    return [{
        type: 'group_message',
        content: `现在是警长竞选环节。所有玩家可以发送 #上警 参与竞选，或发送 #退水 退出竞选。`
    }];
  }

  electSheriff(userId) {
      const player = this.getPlayer(userId);
      if (!player || !player.isAlive) return { success: false, message: '你不是存活玩家，无法上警。' };
      if (this.gameState.sheriffCandidates.includes(userId)) return { success: false, message: '你已是警长候选人。' };
      this.gameState.sheriffCandidates.push(userId);
      player.addTag(TAGS.CANDIDATE);
      this.gameLog.push({ type: 'sheriff_candidate', day: this.gameState.day, player: player.info }); // 记录事件
      return { success: true, message: `${player.info} 成功上警。` };
  }

  withdrawSheriff(userId) {
      const player = this.getPlayer(userId);
      if (!player || !player.isAlive) return { success: false, message: '你不是存活玩家，无法退水。' };
      const index = this.gameState.sheriffCandidates.indexOf(userId);
      if (index === -1) return { success: false, message: '你不是警长候选人。' };
      this.gameState.sheriffCandidates.splice(index, 1);
      player.removeTag(TAGS.CANDIDATE);
      this.gameLog.push({ type: 'sheriff_withdraw', day: this.gameState.day, player: player.info }); // 记录事件
      return { success: true, message: `${player.info} 成功退水。` };
  }

  startSheriffVote() {
      this.gameState.phase = GAME_PHASE.SHERIFF_VOTE;
      this.gameState.sheriffVotes = {};
      this.gameLog.push({ type: 'sheriff_vote_start', day: this.gameState.day }); // 记录事件
      const candidatesInfo = this.gameState.sheriffCandidates.map(id => this.getPlayer(id).info).join('\n');
      return [{
          type: 'group_message',
          content: `警长候选人：\n${candidatesInfo}\n请所有玩家私聊我发送 #警上投票 [玩家编号] 进行投票。`
      }];
  }

  handleSheriffVote(voterId, targetTempId) {
      if (this.gameState.phase !== GAME_PHASE.SHERIFF_VOTE) return { success: false, message: '当前不是警上投票时间。' };
      const voter = this.getPlayer(voterId);
      if (!voter || !voter.isAlive) return { success: false, message: '你不是存活玩家，无法投票。' };
      if (this.gameState.sheriffVotes[voterId]) return { success: false, message: '你已投过票了。' };
      const target = this.getPlayerByTempId(targetTempId);
      if (!target || !target.isAlive || !this.gameState.sheriffCandidates.includes(target.userId)) {
          return { success: false, message: '投票目标无效或不是警长候选人。' };
      }

      this.gameState.sheriffVotes[voterId] = target.userId;
      this.gameLog.push({ type: 'sheriff_vote', day: this.gameState.day, voter: voter.info, target: target.info }); // 记录事件
      return { success: true, message: `你投票给了 ${target.info}` };
  }

  checkAllSheriffVoted() {
      const alivePlayers = this.getAlivePlayers();
      // 只有非候选人玩家需要投票
      return alivePlayers.filter(p => !this.gameState.sheriffCandidates.includes(p.userId)).every(p => this.gameState.sheriffVotes[p.userId]);
  }

  async processSheriffVoteResults() {
      this.gameState.phase = 'sheriff_vote_processing';
      const voteCounts = {};
      for (const voterId in this.gameState.sheriffVotes) {
          const targetId = this.gameState.sheriffVotes[voterId];
          voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
      }

      let maxVotes = 0;
      let electedSheriffIds = [];
      for (const targetId in voteCounts) {
          if (voteCounts[targetId] > maxVotes) {
              maxVotes = voteCounts[targetId];
              electedSheriffIds = [targetId];
          } else if (voteCounts[targetId] === maxVotes) {
              electedSheriffIds.push(targetId);
          }
      }

      let events = [];
      let voteSummary = '警上投票结果：\n' + Object.entries(voteCounts).sort((a, b) => b[1] - a[1]).map(([tid, c]) => `${this.getPlayer(tid).info}: ${c}票`).join('\n');
      events.push({ type: 'group_message', content: voteSummary });
      this.gameLog.push({ type: 'vote_results', day: this.gameState.day, summary: voteSummary }); // 记录事件

      if (electedSheriffIds.length === 1) {
          this.gameState.sheriffId = electedSheriffIds[0];
          events.push({ type: 'group_message', content: `${this.getPlayer(this.gameState.sheriffId).info} 成功当选警长！` });
          this.gameLog.push({ type: 'sheriff_elected', day: this.gameState.day, sheriff: this.getPlayer(this.gameState.sheriffId).info }); // 记录事件
          events.push(...(await this.transitionTo(GAME_PHASE.DAY_SPEAK)));
      } else {
          events.push({ type: 'group_message', content: '警上平票，警长流失。' });
          this.gameLog.push({ type: 'sheriff_none', day: this.gameState.day }); // 记录事件
          events.push(...(await this.transitionTo(GAME_PHASE.DAY_SPEAK)));
      }
      return events;
  }

  startDaySpeakPhase() {
    this.gameState.phase = GAME_PHASE.DAY_SPEAK;
    this.gameLog.push({ type: 'day_speak_start', day: this.gameState.day }); // 记录事件
    
    if (this.gameState.sheriffId) {
        const sheriff = this.getPlayer(this.gameState.sheriffId);
        const otherAlivePlayers = this.getAlivePlayers().filter(p => p.userId !== this.gameState.sheriffId);
        this.gameState.speakingOrder = [sheriff.userId, ...shuffleArray(otherAlivePlayers).map(p => p.userId)];
    } else {
        const alivePlayers = this.getAlivePlayers();
        this.gameState.speakingOrder = shuffleArray(alivePlayers).map(p => p.userId);
    }
    this.gameState.currentSpeakerIndex = 0;
    
    const firstSpeaker = this.getPlayer(this.gameState.speakingOrder[0]);
    
    return [{
      type: 'group_message',
      content: `进入白天发言阶段。\n发言顺序为：${this.gameState.speakingOrder.map(uid => this.getPlayer(uid).info).join(' -> ')}\n请 ${firstSpeaker.info} 开始发言。`
    }];
  }

  nextSpeaker() {
    this.gameState.currentSpeakerIndex++;
    this.gameLog.push({ type: 'next_speaker', day: this.gameState.day, speaker: this.getPlayer(this.gameState.speakingOrder[this.gameState.currentSpeakerIndex -1]).info }); // 记录事件
    if (this.gameState.currentSpeakerIndex >= this.gameState.speakingOrder.length) {
      return this.transitionTo(GAME_PHASE.DAY_VOTE);
    } else {
      const nextSpeakerId = this.gameState.speakingOrder[this.gameState.currentSpeakerIndex];
      const speaker = this.getPlayer(nextSpeakerId);
      return [{ type: 'group_message', content: `请 ${speaker.info} 发言。` }];
    }
  }

  startVotePhase() {
    this.gameState.phase = GAME_PHASE.DAY_VOTE;
    this.gameState.votes = {};
    this.gameLog.push({ type: 'day_vote_start', day: this.gameState.day }); // 记录事件
    const alivePlayersInfo = this.getAlivePlayers().map(p => p.info).join('\n');
    return [{
      type: 'group_message',
      content: `所有玩家发言结束，现在开始投票。\n存活玩家：\n${alivePlayersInfo}\n请私聊我使用 #投票 [玩家编号] 进行投票。`
    }];
  }

  handleVote(voterId, targetTempId) {
    if (this.gameState.phase !== GAME_PHASE.DAY_VOTE) return { success: false, message: '当前不是投票时间。' };
    const voter = this.getPlayer(voterId);
    if (!voter || !voter.isAlive) return { success: false, message: '你不是存活玩家，无法投票。' };
    if (this.gameState.votes[voterId]) return { success: false, message: '你已投过票了。' };
    const target = this.getPlayerByTempId(targetTempId);
    if (!target || !target.isAlive) return { success: false, message: '投票目标无效。' };

    this.gameState.votes[voterId] = target.userId;
    this.gameLog.push({ type: 'player_vote', day: this.gameState.day, voter: voter.info, target: target.info }); // 记录事件
    return { success: true, message: `你投票给了 ${target.info}` };
  }

  checkAllVoted() {
    const alivePlayers = this.getAlivePlayers();
    return alivePlayers.every(p => this.gameState.votes[p.userId]);
  }

  async processVoteResults() {
    this.gameState.phase = 'vote_processing';
    const voteCounts = {};
    for (const voterId in this.gameState.votes) {
      const targetId = this.gameState.votes[voterId];
      voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    }

    let maxVotes = 0;
    let exiledPlayerIds = [];
    for (const targetId in voteCounts) {
      if (voteCounts[targetId] > maxVotes) {
        maxVotes = voteCounts[targetId];
        exiledPlayerIds = [targetId];
      } else if (voteCounts[targetId] === maxVotes) {
        exiledPlayerIds.push(targetId);
      }
    }

    let events = [];
    let voteSummary = '投票结果：\n' + Object.entries(voteCounts).sort((a, b) => b[1] - a[1]).map(([tid, c]) => `${this.getPlayer(tid).info}: ${c}票`).join('\n');
    events.push({ type: 'group_message', content: voteSummary });
    this.gameLog.push({ type: 'vote_results', day: this.gameState.day, summary: voteSummary }); // 记录事件

    if (exiledPlayerIds.length === 1) {
      const exiledPlayer = this.getPlayer(exiledPlayerIds[0]);
      events.push({ type: 'group_message', content: `${exiledPlayer.info} 被放逐出局。` });
      this.gameLog.push({ type: 'exiled', day: this.gameState.day, player: exiledPlayer.info, role: exiledPlayer.role.name }); // 记录事件
      exiledPlayer.isAlive = false;
      const onVoteOutEvent = exiledPlayer.role.onVoteOut(this, exiledPlayer); // 触发被放逐技能
      if (onVoteOutEvent) this.eventQueue.push(onVoteOutEvent);
    } else if (exiledPlayerIds.length > 1) {
      events.push({ type: 'group_message', content: `多位玩家平票，进入PK环节：${exiledPlayerIds.map(id => this.getPlayer(id).info).join('、')}` });
      this.gameLog.push({ type: 'exile_pk_pending', day: this.gameState.day, players: exiledPlayerIds.map(id => this.getPlayer(id).info) }); // 记录事件
      this.eventQueue.push({ event: GAME_PHASE.PK_VOTE, data: { pkPlayers: exiledPlayerIds } });
    } else {
      events.push({ type: 'group_message', content: '无人被放逐。' });
    }

    const endStatus = this.checkGameEnd();
    if (endStatus.isEnd) {
        events.push({ type: 'game_end', ...endStatus });
        return events;
    }

    if (this.eventQueue.length > 0) {
        events.push(...(await this.processEventQueue()));
    } else {
        events.push(...(await this.transitionTo(GAME_PHASE.NIGHT_START)));
    }
    return events;
  }

  startHunterShootPhase(data) {
    this.gameState.phase = GAME_PHASE.HUNTER_SHOOT;
    const hunter = this.getPlayer(data.hunterId);
    if (!hunter || !hunter.isAlive) { // 猎人可能在被投票出局后又被狼王带走
        return [{ type: 'group_message', content: '猎人已死亡，无法开枪。' }];
    }
    return [{
        type: 'private_message',
        userId: hunter.userId,
        content: `猎人，你已被出局，请选择你要带走的玩家。发送 #开枪 [玩家编号]`
    }];
  }

  async handleHunterShoot(hunterId, targetTempId) {
    if (this.gameState.phase !== GAME_PHASE.HUNTER_SHOOT) return { success: false, message: '当前不是猎人开枪时间。' };
    const hunter = this.getPlayer(hunterId);
    if (!hunter || hunter.role.roleId !== ROLES.HUNTER || hunter.hasTag(TAGS.HUNTER_SHOT)) {
        return { success: false, message: '你不是猎人或已开过枪。' };
    }
    const target = this.getPlayerByTempId(targetTempId);
    if (!target || !target.isAlive) {
        return { success: false, message: '目标玩家无效或已死亡。' };
    }

    hunter.addTag(TAGS.HUNTER_SHOT);
    target.isAlive = false;
    this.gameLog.push({ type: 'hunter_shoot', day: this.gameState.day, shooter: hunter.info, target: target.info }); // 记录事件
    
    let events = [{ type: 'group_message', content: `猎人 ${hunter.info} 开枪带走了 ${target.info}！` }];
    const onDeathEvent = target.role.onDeath(this, target);
    if (onDeathEvent) this.eventQueue.push(onDeathEvent);

    const endStatus = this.checkGameEnd();
    if (endStatus.isEnd) {
        events.push({ type: 'game_end', ...endStatus });
        return { success: true, events };
    }

    events.push(...(await this.processEventQueue()));
    if (events.length === 0) { // 如果事件队列处理完毕后没有新事件，则进入夜晚
        events.push(...(await this.transitionTo(GAME_PHASE.NIGHT_START)));
    }
    return { success: true, events };
  }

  startLastWordsPhase(playerId) {
    this.gameState.phase = GAME_PHASE.LAST_WORDS;
    const player = this.getPlayer(playerId);
    if (!player || !player.isAlive) { // 玩家可能因其他技能（如狼王爪）再次死亡
        return [{ type: 'group_message', content: '该玩家已死亡，无法发表遗言。' }];
    }
    this.gameState.lastWordPlayerId = playerId;
    this.gameState.lastWordEndTime = Date.now() + this.config.lastWordsDuration * 1000;
    
    this.gameLog.push({ type: 'last_words_start', day: this.gameState.day, player: player.info }); // 记录事件
    
    const events = [{
        type: 'private_message',
        userId: playerId,
        content: `请发送你的遗言。你有 ${this.config.lastWordsDuration} 秒时间。发送 #遗言 [你的遗言内容]`
    }, {
        type: 'last_words_prompt',
        userId: playerId,
        duration: this.config.lastWordsDuration
    }];

    // 遗言计时器
    this.gameState.timerId = setTimeout(async () => {
        logger(`遗言时间到，玩家 ${player.info} 未发表遗言。`);
        const timeoutEvents = [{ type: 'group_message', content: `${player.info} 未发表遗言，游戏继续。` }];
        this.gameLog.push({ type: 'last_words_timeout', day: this.gameState.day, player: player.info }); // 记录事件
        
        // 遗言结束后进入夜晚或处理事件队列
        if (this.eventQueue.length > 0) {
            timeoutEvents.push(...(await this.processEventQueue()));
        } else {
            timeoutEvents.push(...(await this.transitionTo(GAME_PHASE.NIGHT_START)));
        }
        this.eventQueue.push({ event: 'timer_timeout_events', data: { events: timeoutEvents, groupId: this.groupId } });
        // processEventQueue 会在 apps/werewolf.js 中被调用，无需在此处再次调用
    }, this.config.lastWordsDuration * 1000);

    return events;
  }

  async handleLastWord(userId, content) {
    if (this.gameState.phase !== GAME_PHASE.LAST_WORDS || this.gameState.lastWordPlayerId !== userId) {
        return { success: false, message: '当前不是你发表遗言的时间。' };
    }
    const player = this.getPlayer(userId);
    if (!player) return { success: false, message: '玩家不存在。' };

    this.stopTimer(); // 停止遗言计时器
    this.gameLog.push({ type: 'last_word', day: this.gameState.day, player: player.info, content: content }); // 记录事件
    
    let events = [{ type: 'group_message', content: `${player.info} 的遗言：\n${content}` }];
    
    // 遗言结束后进入夜晚或处理事件队列
    if (this.eventQueue.length > 0) {
        events.push(...(await this.processEventQueue()));
    } else {
        events.push(...(await this.transitionTo(GAME_PHASE.NIGHT_START)));
    }
    return { success: true, events };
  }

  startPkVotePhase(pkPlayerIds) {
    this.gameState.phase = GAME_PHASE.PK_VOTE;
    this.gameState.pkPlayers = pkPlayerIds;
    this.gameState.pkVotes = {};
    this.gameLog.push({ type: 'pk_vote_start', day: this.gameState.day, players: pkPlayerIds.map(id => this.getPlayer(id).info) }); // 记录事件
    
    const pkPlayersInfo = pkPlayerIds.map(id => this.getPlayer(id).info).join('、');
    
    const events = [{
        type: 'group_message',
        content: `进入PK环节，PK玩家：${pkPlayersInfo}\n请所有存活玩家私聊我发送 #PK投票 [玩家编号] 进行投票。`
    }];

    // PK投票计时器
    this.gameState.timerId = setTimeout(async () => {
        logger(`PK投票时间到，将自动处理PK投票结果。`);
        const timeoutEvents = [{ type: 'group_message', content: 'PK投票时间到，将自动公布PK投票结果。' }];
        timeoutEvents.push(...(await this.processPkVoteResults()));
        this.eventQueue.push({ event: 'timer_timeout_events', data: { events: timeoutEvents, groupId: this.groupId } });
    }, this.config.pkVoteDuration * 1000);

    return events;
  }

  handlePkVote(voterId, targetTempId) {
    if (this.gameState.phase !== GAME_PHASE.PK_VOTE) return { success: false, message: '当前不是PK投票时间。' };
    const voter = this.getPlayer(voterId);
    if (!voter || !voter.isAlive) return { success: false, message: '你不是存活玩家，无法投票。' };
    if (this.gameState.pkVotes[voterId]) return { success: false, message: '你已投过票了。' };
    const target = this.getPlayerByTempId(targetTempId);
    if (!target || !target.isAlive || !this.gameState.pkPlayers.includes(target.userId)) {
        return { success: false, message: '投票目标无效或不是PK玩家。' };
    }

    this.gameState.pkVotes[voterId] = target.userId;
    this.gameLog.push({ type: 'pk_player_vote', day: this.gameState.day, voter: voter.info, target: target.info }); // 记录事件
    return { success: true, message: `你PK投票给了 ${target.info}` };
  }

  checkAllPkVoted() {
    const alivePlayers = this.getAlivePlayers();
    return alivePlayers.every(p => this.gameState.pkVotes[p.userId]);
  }

  async processPkVoteResults() {
    this.stopTimer(); // 停止PK投票计时器
    this.gameState.phase = 'pk_vote_processing';
    const voteCounts = {};
    for (const voterId in this.gameState.pkVotes) {
      const targetId = this.gameState.pkVotes[voterId];
      voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    }

    let maxVotes = 0;
    let exiledPlayerIds = [];
    for (const targetId in voteCounts) {
      if (voteCounts[targetId] > maxVotes) {
        maxVotes = voteCounts[targetId];
        exiledPlayerIds = [targetId];
      } else if (voteCounts[targetId] === maxVotes) {
        exiledPlayerIds.push(targetId);
      }
    }

    let events = [];
    let voteSummary = 'PK投票结果：\n' + Object.entries(voteCounts).sort((a, b) => b[1] - a[1]).map(([tid, c]) => `${this.getPlayer(tid).info}: ${c}票`).join('\n');
    events.push({ type: 'group_message', content: voteSummary });
    this.gameLog.push({ type: 'pk_vote_results', day: this.gameState.day, summary: voteSummary }); // 记录事件

    if (exiledPlayerIds.length === 1) {
      const exiledPlayer = this.getPlayer(exiledPlayerIds[0]);
      events.push({ type: 'group_message', content: `${exiledPlayer.info} 在PK环节中被放逐出局。` });
      this.gameLog.push({ type: 'pk_exiled', day: this.gameState.day, player: exiledPlayer.info, role: exiledPlayer.role.name }); // 记录事件
      exiledPlayer.isAlive = false;
      const onVoteOutEvent = exiledPlayer.role.onVoteOut(this, exiledPlayer); // 触发被放逐技能
      if (onVoteOutEvent) this.eventQueue.push(onVoteOutEvent);
    } else if (exiledPlayerIds.length > 1) {
      // PK再次平票
      events.push({ type: 'group_message', content: 'PK再次平票，将随机选择一名玩家放逐。' });
      const randomExiledPlayer = this.getPlayer(shuffleArray(exiledPlayerIds)[0]);
      events.push({ type: 'group_message', content: `${randomExiledPlayer.info} 被随机放逐出局。` });
      this.gameLog.push({ type: 'pk_exile_random', day: this.gameState.day, player: randomExiledPlayer.info, role: randomExiledPlayer.role.name }); // 记录事件
      randomExiledPlayer.isAlive = false;
      const onVoteOutEvent = randomExiledPlayer.role.onVoteOut(this, randomExiledPlayer); // 触发被放逐技能
      if (onVoteOutEvent) this.eventQueue.push(onVoteOutEvent);
    } else {
      events.push({ type: 'group_message', content: 'PK投票结果无人被放逐。' });
      this.gameLog.push({ type: 'pk_exile_no_one', day: this.gameState.day }); // 记录事件
    }

    const endStatus = this.checkGameEnd();
    if (endStatus.isEnd) {
        events.push({ type: 'game_end', ...endStatus });
        return events;
    }

    if (this.eventQueue.length > 0) {
        events.push(...(await this.processEventQueue()));
    } else {
        events.push(...(await this.transitionTo(GAME_PHASE.NIGHT_START)));
    }
    return events;
  }

  startWolfKingClawPhase(wolfKingId, groupId) {
    this.gameState.phase = GAME_PHASE.WOLF_KING_CLAW;
    const wolfKing = this.getPlayer(wolfKingId);
    if (!wolfKing || wolfKing.role.roleId !== ROLES.WOLF_KING) {
      return [{ type: 'group_message', content: '狼王不存在或身份不正确。' }];
    }
    
    // 狼王爪计时器
    this.gameState.timerId = setTimeout(async () => {
      logger(`狼王爪时间到，狼王 ${wolfKing.info} 未发动技能。`);
      const timeoutEvents = [{ type: 'group_message', content: `狼王 ${wolfKing.info} 未发动狼王爪，游戏继续。` }];
      this.gameLog.push({ type: 'wolf_king_claw_timeout', day: this.gameState.day, wolfKing: wolfKing.info }); // 记录事件
      
      // 狼王爪结束后进入夜晚或处理事件队列
      if (this.eventQueue.length > 0) {
          timeoutEvents.push(...(await this.processEventQueue()));
      } else {
          timeoutEvents.push(...(await this.transitionTo(GAME_PHASE.NIGHT_START)));
      }
      this.eventQueue.push({ event: 'timer_timeout_events', data: { events: timeoutEvents, groupId: groupId } });
    }, this.config.wolfKingClawDuration * 1000);

    return [{
      type: 'private_message',
      userId: wolfKingId,
      content: `狼王，你已出局，请发动狼王爪带走一名玩家。你有 ${this.config.wolfKingClawDuration} 秒时间。发送 #狼王爪 [玩家编号]`
    }, {
      type: 'wolf_king_claw_prompt',
      userId: wolfKingId,
      duration: this.config.wolfKingClawDuration
    }];
  }

  async handleWolfKingClaw(wolfKingId, targetTempId) {
    if (this.gameState.phase !== GAME_PHASE.WOLF_KING_CLAW || this.gameState.wolfKingClawTargetId) {
        return { success: false, message: '当前不是狼王爪发动时间或已发动过。' };
    }
    const wolfKing = this.getPlayer(wolfKingId);
    if (!wolfKing || wolfKing.role.roleId !== ROLES.WOLF_KING) {
        return { success: false, message: '你不是狼王，无法使用狼王爪。' };
    }
    const target = this.getPlayerByTempId(targetTempId);
    if (!target || !target.isAlive) {
        return { success: false, message: '目标玩家无效或已死亡。' };
    }

    this.stopTimer(); // 停止狼王爪计时器
    this.gameState.wolfKingClawTargetId = target.userId; // 记录狼王爪目标

    target.isAlive = false;
    this.gameLog.push({ type: 'wolf_king_claw', day: this.gameState.day, wolfKing: wolfKing.info, target: target.info }); // 记录事件
    
    let events = [{ type: 'group_message', content: `狼王 ${wolfKing.info} 发动狼王爪，带走了 ${target.info}！` }];
    const onDeathEvent = target.role.onDeath(this, target);
    if (onDeathEvent) this.eventQueue.push(onDeathEvent);

    const endStatus = this.checkGameEnd();
    if (endStatus.isEnd) {
        events.push({ type: 'game_end', ...endStatus });
        return { success: true, events };
    }

    events.push(...(await this.processEventQueue()));
    if (events.length === 0) { // 如果事件队列处理完毕后没有新事件，则进入夜晚
        events.push(...(await this.transitionTo(GAME_PHASE.NIGHT_START)));
    }
    return { success: true, events };
  }

  async startIdiotFlipPhase(idiotId, groupId) {
    this.gameState.phase = GAME_PHASE.IDIOT_FLIP;
    const idiot = this.getPlayer(idiotId);
    if (!idiot || idiot.role.roleId !== ROLES.IDIOT) {
      return [{ type: 'group_message', content: '白痴不存在或身份不正确。' }];
    }
    
    idiot.addTag(TAGS.IDIOT_FLIPPED); // 白痴翻牌标记
    this.gameLog.push({ type: 'idiot_flip_card', day: this.gameState.day, idiot: idiot.info }); // 记录事件
    
    let events = [{ type: 'group_message', content: `白痴 ${idiot.info} 翻牌了！他将继续留在场上，但失去投票权。` }];
    events.push({ type: 'idiot_flip_card_prompt', userId: idiotId }); // 提示白痴已翻牌

    const endStatus = this.checkGameEnd();
    if (endStatus.isEnd) {
        events.push({ type: 'game_end', ...endStatus });
        return events;
    }

    // 白痴翻牌后，继续之前的游戏流程（通常是白天发言或投票）
    if (this.eventQueue.length > 0) {
        events.push(...(await this.processEventQueue()));
    } else {
        // 如果没有其他待处理事件，则回到白天发言阶段（或根据当前游戏状态决定）
        // 假设白痴翻牌发生在白天被放逐后，那么接下来应该回到白天发言或投票
        // 这里需要根据实际情况调整，例如如果是在投票结果公布后，就应该继续执行投票结果后的流程
        // 为了简化，这里先假设回到白天发言
        events.push(...(await this.transitionTo(GAME_PHASE.DAY_SPEAK))); 
    }
    return events;
  }

  // --- 辅助方法 ---

  /**
   * 获取存活玩家列表
   * @returns {Array<Player>}
   */
  getAlivePlayers() {
    return this.players.filter(p => p.isAlive);
  }

  /**
   * 通过 userId 获取玩家
   * @param {string} userId
   * @returns {Player|undefined}
   */
  getPlayer(userId) {
    return this.players.find(p => p.userId === userId);
  }

  /**
   * 通过 tempId 获取玩家
   * @param {string} tempId
   * @returns {Player|undefined}
   */
  getPlayerByTempId(tempId) {
    return this.players.find(p => p.tempId === tempId);
  }

  /**
   * 获取狼人刀人目标
   * 如果有多个目标票数相同，随机选择一个
   * 如果所有狼人均未刀人，则返回 null
   * @returns {Player|null} 被狼人刀的玩家
   */
  getAttackedByWolfTarget() {
    const wolfActions = this.players.filter(p => p.role.roleId === ROLES.WOLF && p.isAlive && p.role.nightActionTarget);
    if (wolfActions.length === 0) {
        // 检查是否有狼王自刀
        const wolfKingSelfStab = this.players.find(p => p.role.roleId === ROLES.WOLF_KING && p.isAlive && p.role.nightActionTarget && p.role.nightActionTarget.userId === p.userId);
        if (wolfKingSelfStab) {
            return wolfKingSelfStab;
        }
        return null; // 所有狼人均未刀人
    }

    const targetCounts = {};
    for (const wolf of wolfActions) {
      const targetId = wolf.role.nightActionTarget.userId;
      targetCounts[targetId] = (targetCounts[targetId] || 0) + 1;
    }

    let maxVotes = 0;
    let candidates = [];
    for (const targetId in targetCounts) {
      if (targetCounts[targetId] > maxVotes) {
        maxVotes = targetCounts[targetId];
        candidates = [targetId];
      } else if (targetCounts[targetId] === maxVotes) {
        candidates.push(targetId);
      }
    }

    if (candidates.length === 0) {
        return null; // 理论上不会发生，除非所有狼人都没有目标
    }
    
    // 如果有多个目标票数相同，随机选择一个
    const chosenTargetId = shuffleArray(candidates)[0];
    return this.getPlayer(chosenTargetId);
  }

  /**
   * 检查游戏是否结束
   * @returns {{isEnd: boolean, winner?: string, reason?: string}}
   */

  checkGameEnd() {
    const alivePlayers = this.getAlivePlayers();
    const aliveWolfCount = alivePlayers.filter(p => WOLF_TEAM_ROLES.includes(p.role.roleId)).length;
    const aliveGoodCount = alivePlayers.filter(p => !WOLF_TEAM_ROLES.includes(p.role.roleId)).length;
    const aliveGodCount = alivePlayers.filter(p => p.role.team === TEAMS.GOOD && p.role.isGod).length; // 神职数量

    // 狼人胜利条件：狼人数量大于等于好人数量
    if (aliveWolfCount >= aliveGoodCount) {
      return { isEnd: true, winner: TEAMS.WOLF, reason: '狼人数量大于或等于好人数量' };
    }

    // 好人胜利条件：所有狼人出局
    if (aliveWolfCount === 0) {
      return { isEnd: true, winner: TEAMS.GOOD, reason: '所有狼人出局' };
    }

    // 特殊角色胜利条件
    // 白痴翻牌后，好人胜利条件改变
    const idiotPlayer = alivePlayers.find(p => p.role.roleId === ROLES.IDIOT && p.hasTag(TAGS.IDIOT_FLIPPED));
    if (idiotPlayer) { // 白痴翻牌后，好人需要放逐所有狼人才能胜利
      if (aliveWolfCount > 0) {
        return { isEnd: false }; // 游戏继续
      } else {
        return { isEnd: true, winner: TEAMS.GOOD, reason: '所有狼人出局' }; // 白痴翻牌后，所有狼人出局则好人胜利
      }
    }

    // 白狼王胜利条件：当只剩白狼王一个狼人时，如果他自爆带走了场上唯一一个神职，且场上好人数量 >= 1，则白狼王胜利
    const whiteWolfKingPlayer = alivePlayers.find(p => p.role.roleId === ROLES.WHITE_WOLF_KING);
    if (whiteWolfKingPlayer && aliveWolfCount === 1 && whiteWolfKingPlayer.hasTag(TAGS.WHITE_WOLF_KING_EXPLODED_GOD)) {
        if (aliveGoodCount >= 1) {
            return { isEnd: true, winner: TEAMS.WOLF, reason: '白狼王自爆带走了最后一个神职' };
        }
    }

    // 狼王胜利条件：当只剩狼王一个狼人时，如果他发动狼王爪带走了场上唯一一个神职，且场上好人数量 >= 1，则狼王胜利
    const wolfKingPlayer = alivePlayers.find(p => p.role.roleId === ROLES.WOLF_KING);
    if (wolfKingPlayer && aliveWolfCount === 1 && wolfKingPlayer.hasTag(TAGS.WOLF_KING_CLAWED_GOD)) {
        if (aliveGoodCount >= 1) {
            return { isEnd: true, winner: TEAMS.WOLF, reason: '狼王爪带走了最后一个神职' };
        }
    }

    return { isEnd: false }; // 游戏继续
  }

  /**
   * 序列化 GameEngine 实例
   * @returns {object} 可序列化的对象
   */
  serialize() {
    return {
      players: this.players.map(p => p.serialize()),
      gameState: this.gameState,
      eventQueue: this.eventQueue,
      pendingDeaths: this.pendingDeaths.map(p => p.serialize()),
      gameLog: this.gameLog,
    };
  }

  /**
   * 反序列化 GameEngine 实例
   * @param {object} data 序列化数据
   * @returns {GameEngine} GameEngine 实例
   */
  static deserialize(data) {
    const engine = new GameEngine([]); // 玩家列表在反序列化后填充
    engine.players = data.players.map(pData => Player.deserialize(pData));
    engine.gameState = data.gameState;
    // 恢复计时器ID为null，因为setTimeout ID在进程重启后无效
    engine.gameState.timerId = null;
    engine.eventQueue = data.eventQueue;
    engine.pendingDeaths = data.pendingDeaths.map(pData => Player.deserialize(pData));
    engine.gameLog = data.gameLog;
    return engine;
  }
}

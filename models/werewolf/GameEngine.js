import { EventEmitter } from './EventEmitter.js';
import { GAME_EVENTS, INTERACTION_EVENTS, GAME_STATES, ROLES, VICTORY_CONDITIONS } from './GameEvents.js';
import { DataManager } from './DataManager.js';
import { RoleLoader } from './RoleLoader.js'; // 导入角色加载器
import { getBoardPreset } from './BoardPresets.js'; // 导入板子预设

/**
 * @class GameEngine
 * @description 狼人杀游戏的核心状态机
 * 职责：管理游戏状态、处理玩家动作、广播事件、推进游戏流程
 * 不直接与外部平台交互，通过事件系统与外界通信
 */
export class GameEngine extends EventEmitter {
  constructor(groupId, initialData = {}) {
    super();
    
    this.groupId = groupId;
    this.players = initialData.players || [];
    this.gameState = initialData.gameState || this.createInitialGameState();
    this.potions = initialData.potions || { save: true, kill: true };
    this.metadata = initialData.metadata || {};

    // 角色加载器实例
    this.roleLoader = new RoleLoader();
    
    // 动作队列，用于处理玩家的夜晚行动
    this.actionQueue = [];
    
    // 计时器管理
    this.phaseTimer = null;
    this.phaseTimeouts = {
      [GAME_STATES.NIGHT_PHASE]: 120, // 夜晚阶段2分钟
      [GAME_STATES.DAY_SPEECH]: 60,   // 发言阶段1分钟
      [GAME_STATES.DAY_VOTE]: 90,     // 投票阶段1.5分钟
      [GAME_STATES.SHERIFF_ELECTION]: 60, // 警长竞选1分钟
      [GAME_STATES.SHERIFF_SPEECH]: 30,   // 警长发言30秒
      [GAME_STATES.SHERIFF_VOTE]: 60,     // 警长投票1分钟
      [GAME_STATES.LAST_WORDS]: 30,       // 遗言30秒
      [GAME_STATES.HUNTER_SHOOT]: 30,     // 猎人开枪30秒
      [GAME_STATES.WOLF_KING_CLAW]: 30    // 狼王技能30秒
    };
  }

  /**
   * 创建初始游戏状态
   * @returns {object} 初始游戏状态对象
   */
  createInitialGameState() {
    return {
      isRunning: false,
      currentPhase: GAME_STATES.WAITING,
      currentDay: 0,
      hostUserId: null,
      
      // 夜晚行动相关
      nightActions: {},
      lastProtectedId: null,
      
      // 发言和投票相关
      currentSpeakerUserId: null,
      speakingOrder: [],
      currentSpeakerIndex: -1,
      votes: {},
      
      // 警长相关
      sheriffUserId: null,
      isSheriffElection: false,
      candidateList: [],
      sheriffVotes: {},
      
      // 特殊状态
      hunterNeedsToShoot: null,
      wolfKingNeedsToClaw: null,
      
      // 游戏配置
      presetName: 'default',
      hasSheriff: true,
      
      // 事件日志
      eventLog: [],
      
      // 计时器相关
      deadline: null
    };
  }

  /**
   * 初始化游戏
   * @param {string} hostUserId - 房主用户ID
   */
  initGame(hostUserId) {
    this.gameState.hostUserId = hostUserId;
    this.gameState.currentPhase = GAME_STATES.WAITING;
    // 默认板子预设名称，如果之前没有设置过
    if (!this.gameState.presetName) {
      this.gameState.presetName = 'SIX_PLAYER_NOVICE'; // 默认设置为6人新手局
    }
    
    this.emit(GAME_EVENTS.GAME_CREATED, {
      groupId: this.groupId,
      hostUserId: hostUserId,
      presetName: this.gameState.presetName // 使用this.gameState.presetName
    });
    
    this.emit(INTERACTION_EVENTS.SAVE_GAME_DATA, {
      groupId: this.groupId,
      data: this.getGameData()
    });
  }

  /**
   * 添加玩家到游戏
   * @param {string} userId - 用户ID
   * @param {string} nickname - 用户昵称
   * @returns {object} 操作结果
   */
  addPlayer(userId, nickname) {
    // 检查游戏状态
    if (this.gameState.isRunning) {
      return { success: false, message: '游戏已经开始，无法加入。' };
    }

    // 检查玩家是否已存在
    if (this.players.find(p => p.userId === userId)) {
      return { success: false, message: '你已经在游戏中了。' };
    }

    // 检查人数限制
    if (this.players.length >= 15) {
      return { success: false, message: '游戏人数已满。' };
    }

    // 生成临时ID并添加玩家
    const tempId = DataManager.generateTempId(this.players);
    const player = {
      userId: userId,
      nickname: nickname,
      tempId: tempId,
      role: null,
      isAlive: true,
      tags: [],
      joinTime: Date.now()
    };

    this.players.push(player);

    this.emit(GAME_EVENTS.PLAYER_JOINED, {
      groupId: this.groupId,
      player: player,
      playerCount: this.players.length
    });
    this.logEvent('PLAYER_JOINED', { userId: player.userId, nickname: player.nickname, tempId: player.tempId });

    this.emit(INTERACTION_EVENTS.SAVE_GAME_DATA, {
      groupId: this.groupId,
      data: this.getGameData()
    });

    return { 
      success: true, 
      message: `${nickname} 加入游戏，编号 ${tempId}。当前人数：${this.players.length}`,
      player: player
    };
  }

  /**
   * 移除玩家
   * @param {string} userId - 用户ID
   * @returns {object} 操作结果
   */
  removePlayer(userId) {
    if (this.gameState.isRunning) {
      return { success: false, message: '游戏已经开始，无法退出。' };
    }

    const playerIndex = this.players.findIndex(p => p.userId === userId);
    if (playerIndex === -1) {
      return { success: false, message: '你不在游戏中。' };
    }

    const player = this.players[playerIndex];
    this.players.splice(playerIndex, 1);

    this.emit(GAME_EVENTS.PLAYER_LEFT, {
      groupId: this.groupId,
      player: player,
      playerCount: this.players.length
    });
    this.logEvent('PLAYER_LEFT', { userId: player.userId, nickname: player.nickname });

    this.emit(INTERACTION_EVENTS.SAVE_GAME_DATA, {
      groupId: this.groupId,
      data: this.getGameData()
    });

    return { 
      success: true, 
      message: `${player.nickname} 退出游戏。当前人数：${this.players.length}`,
      player: player
    };
  }

  /**
   * 获取游戏数据
   * @returns {object} 游戏数据
   */
  getGameData() {
    return {
      players: this.players,
      gameState: this.gameState,
      potions: this.potions,
      metadata: this.metadata
    };
  }

  /**
   * 设置板子预设
   * @param {string} presetName - 板子预设名称
   * @returns {object} 操作结果
   */
  setBoardPreset(presetName) {
    if (this.gameState.isRunning) {
      return { success: false, message: '游戏已开始，无法更改板子。' };
    }
    const preset = getBoardPreset(presetName);
    if (!preset) {
      return { success: false, message: '无效的板子预设名称。' };
    }
    if (preset.roles.length !== this.players.length) {
      return { success: false, message: `选择的板子需要 ${preset.roles.length} 人，当前有 ${this.players.length} 人。` };
    }
    this.gameState.presetName = presetName;
    this.gameState.hasSheriff = preset.rules?.hasSheriff ?? true; // 从预设中读取是否警长竞选
    this.emit(INTERACTION_EVENTS.SAVE_GAME_DATA, {
      groupId: this.groupId,
      data: this.getGameData()
    });
    return { success: true, message: `板子已设置为 ${preset.name}。` };
  }

  /**
   * 开始游戏
   * @returns {object} 操作结果
   */
  startGame() {
    if (this.gameState.isRunning) {
      return { success: false, message: '游戏已经开始。' };
    }
    if (this.players.length < 6) { // 最少人数可以根据板子预设来确定
      return { success: false, message: `人数不足，至少需要6人才能开始游戏。当前人数：${this.players.length}。` };
    }

    const preset = getBoardPreset(this.gameState.presetName);
    if (!preset) {
      return { success: false, message: '未找到板子预设，请先设置板子。' };
    }
    if (preset.roles.length !== this.players.length) {
      return { success: false, message: `当前板子需要 ${preset.roles.length} 人，但当前玩家有 ${this.players.length} 人，请调整人数或重新选择板子。` };
    }

    this.gameState.isRunning = true;
    this.gameState.currentDay = 1;
    this.potions = { save: true, kill: true }; // 重置女巫药水
    
    // 分配角色
    let shuffledRoles = this.shuffleArray([...preset.roles]);
    this.players.forEach(player => {
      player.role = shuffledRoles.pop();
      player.isAlive = true;
      player.tags = [];
    });

    this.gameState.currentPhase = GAME_STATES.NIGHT_PHASE;
    this.gameState.eventLog.push({ type: 'GAME_STARTED', timestamp: Date.now(), players: this.players.map(p => ({ userId: p.userId, nickname: p.nickname, role: p.role })) });
    
    this.emit(GAME_EVENTS.GAME_STARTED, { groupId: this.groupId });
    this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: '天黑请闭眼...' });
    
    // 给玩家发送私聊角色信息
    this.players.forEach(player => {
      this.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, {
        userId: player.userId,
        message: `你的角色是：${player.role}`
      });
    });

    this.emit(INTERACTION_EVENTS.SAVE_GAME_DATA, {
      groupId: this.groupId,
      data: this.getGameData()
    });

    this.startPhaseTimer(GAME_STATES.NIGHT_PHASE);

    return { success: true, message: '游戏开始！角色已分配，请留意私聊信息。天黑请闭眼。' };
  }

  /**
   * 随机打乱数组
   * @param {Array} array - 要打乱的数组
   * @returns {Array} 打乱后的数组
   */
  shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  /**
   * 启动阶段计时器
   * @param {string} phaseName - 阶段名称
   */
  startPhaseTimer(phaseName) {
    if (this.phaseTimer) {
      clearTimeout(this.phaseTimer);
      this.phaseTimer = null;
    }

    const duration = this.phaseTimeouts[phaseName];
    if (duration) {
      this.gameState.deadline = Date.now() + duration * 1000;
      this.phaseTimer = setTimeout(() => {
        this.emit(GAME_EVENTS.TIMER_EXPIRED, { groupId: this.groupId, phase: phaseName });
        // 处理超时逻辑，例如强制进入下一阶段或默认跳过行动
        this.handlePhaseTimeout(phaseName);
      }, duration * 1000);

      // 发送倒计时提醒
      if (duration > 60) {
        setTimeout(() => {
          this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: `距离${phaseName}结束还有1分钟！` });
        }, (duration - 60) * 1000);
      }
    }
  }

  /**
   * 处理阶段超时
   * @param {string} phaseName - 超时的阶段名称
   */
  handlePhaseTimeout(phaseName) {
    console.log(`[GameEngine] 阶段超时: ${phaseName}`);
    switch (phaseName) {
      case GAME_STATES.NIGHT_PHASE:
        this.processNightActions(); // 强制处理夜晚行动
        break;
      case GAME_STATES.DAY_SPEECH:
        this.nextSpeaker(); // 强制跳到下一位发言
        break;
      case GAME_STATES.DAY_VOTE:
        this.processDayVote(); // 强制处理白天投票
        break;
      case GAME_STATES.SHERIFF_ELECTION:
        if (this.gameState.candidateList.length > 0) {
          // 有候选人，进入警长发言阶段
          this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: '警长竞选时间到，现在进入警长候选人发言环节。' });
          this.advanceGameStage();
        } else {
          // 没有候选人，警长流失，直接进入白天发言阶段
          this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: '无人竞选警长，警长流失。' });
          this.gameState.sheriffId = null;
          this.advanceGameStage(); // 直接进入白天发言
        }
        break;
      case GAME_STATES.SHERIFF_VOTE:
      case GAME_STATES.SHERIFF_RUNOFF_VOTE:
        this.calculateSheriffResult(); // 强制计算警长投票结果
        break;
      case GAME_STATES.LAST_WORDS:
        // 遗言超时，进入下一个阶段
        this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: '遗言时间到。' });
        this.advanceGameStage();
        break;
      case GAME_STATES.HUNTER_SHOOT:
        this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: '猎人超时未开枪，技能失效。' });
        this.gameState.hunterNeedsToShoot = null;
        this.checkGameEnd(); // 检查游戏是否结束
        break;
      case GAME_STATES.WOLF_KING_CLAW:
        this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: '狼王超时未撕咬，技能失效。' });
        this.gameState.wolfKingNeedsToClaw = null;
        this.checkGameEnd(); // 检查游戏是否结束
        break;
      default:
        this.advanceGameStage(); // 默认情况下，推进到下一个阶段
        break;
    }
  }

  /**
   * 记录游戏事件到日志
   * @param {string} type - 事件类型
   * @param {object} data - 事件数据
   */
  logEvent(type, data = {}) {
    this.gameState.eventLog.push({
      type,
      timestamp: Date.now(),
      ...data
    });
    this.emit(INTERACTION_EVENTS.SAVE_GAME_DATA, {
      groupId: this.groupId,
      data: this.getGameData()
    });
  }


  /**
   * 处理玩家行动 (夜晚行动和白天投票等)
   * @param {object} action - 玩家行动对象 { userId, type, targetId }
   */
  handlePlayerAction(action) {
    // 根据当前阶段和行动类型进行处理
    switch (this.gameState.currentPhase) {
      case GAME_STATES.NIGHT_PHASE:
        this.actionQueue.push(action);
        this.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, { userId: action.userId, message: '你的行动已记录。' });
        // 检查所有夜晚行动是否完成
        this.checkAllNightActionsReceived();
        break;
      case GAME_STATES.DAY_VOTE:
        // 处理投票
        this.handleVote(action.userId, action.targetId);
        break;
      case GAME_STATES.SHERIFF_ELECTION:
        // 处理警长竞选
        this.handleSheriffCandidate(action.userId);
        break;
      case GAME_STATES.SHERIFF_VOTE:
      case GAME_STATES.SHERIFF_RUNOFF_VOTE: // 处理二次投票
        // 处理警长选举投票
        this.handleSheriffVote(action.userId, action.targetId);
        break;
      case GAME_STATES.DAY_SPEECH:
      case GAME_STATES.SHERIFF_SPEECH:
      case GAME_STATES.LAST_WORDS:
        // 在这些阶段，玩家通常是发言，可以记录或忽略，等待超时
        this.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, { userId: action.userId, message: '当前是发言阶段，请直接发言。' });
        break;
      case GAME_STATES.HUNTER_SHOOT:
        // 猎人开枪
        this.handleHunterShoot(action.userId, action.targetId);
        break;
      case GAME_STATES.WOLF_KING_CLAW:
        // 狼王撕咬
        this.handleWolfKingClaw(action.userId, action.targetId);
        break;
      default:
        this.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, { userId: action.userId, message: '当前阶段无法执行此操作。' });
        break;
    }
  }

  /**
   * 检查所有夜晚行动是否已收到
   */
  checkAllNightActionsReceived() {
    // 获取需要行动的角色
    const actingRoles = Object.values(ROLES).filter(roleName => {
       const roleInstance = this.roleLoader.getRoleInstance(roleName);
       return roleInstance && roleInstance.hasNightAction;
    });

    const receivedUserIds = new Set(this.actionQueue.map(a => a.userId));
    const allActionsReceived = actingRoles.every(roleName => {
      const rolePlayer = this.players.find(p => p.role === roleName && p.isAlive);
      return !rolePlayer || receivedUserIds.has(rolePlayer.userId);
    });

    if (allActionsReceived) {
      this.processNightActions();
    } else {
      // 提醒未行动的玩家 (可选)
    }
  }

  /**
   * 处理夜晚行动
   */
  processNightActions() {
    this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: '天亮了...' });
    this.gameState.eventLog.push({ type: 'NIGHT_ACTIONS_RESOLVED', timestamp: Date.now(), actions: this.actionQueue });

    const nightResults = {
      protected: null,
      attacked: null,
      killed: [],
      saved: null,
      poisoned: null,
      inspected: null,
      inspectedRole: null,
      hunterShoot: null,
      wolfKingClaw: null,
    };

    // 1. 守卫行动 (优先级最高)
    const guardAction = this.actionQueue.find(a => this.getPlayerRole(a.userId) === ROLES.GUARD);
    if (guardAction) {
      nightResults.protected = guardAction.targetId;
      this.gameState.lastProtectedId = guardAction.targetId;
      this.logEvent('GUARD_PROTECTED', { protectorId: guardAction.userId, targetId: guardAction.targetId });
    } else {
      this.gameState.lastProtectedId = null; // 如果守卫未行动或无守卫，则清空上次守卫目标
    }

    // 2. 狼人行动 (投票决定攻击目标)
    const werewolfActions = this.actionQueue.filter(a => this.getPlayerRole(a.userId) === ROLES.WEREWOLF);
    if (werewolfActions.length > 0) {
      const wolfVotes = {};
      werewolfActions.forEach(action => {
        wolfVotes[action.targetId] = (wolfVotes[action.targetId] || 0) + 1;
      });

      let attackedTarget = null;
      let maxVotes = 0;
      for (const targetId in wolfVotes) {
        if (wolfVotes[targetId] > maxVotes) {
          maxVotes = wolfVotes[targetId];
          attackedTarget = targetId;
        } else if (wolfVotes[targetId] === maxVotes) {
          // 平票，狼人今晚无法击杀
          attackedTarget = null;
          break;
        }
      }

      if (attackedTarget) {
        nightResults.attacked = attackedTarget;
        this.logEvent('WEREWOLF_ATTACKED', { targetId: attackedTarget });
      }
    }

    // 3. 结算被攻击者和被守护者
    if (nightResults.attacked && nightResults.attacked !== nightResults.protected) {
      nightResults.killed.push(nightResults.attacked);
    }

    // 4. 女巫行动
    const witchAction = this.actionQueue.find(a => this.getPlayerRole(a.userId) === ROLES.WITCH);
    if (witchAction) {
      // 女巫解药
      if (witchAction.type === 'save' && this.potions.save && nightResults.attacked) {
        nightResults.saved = nightResults.attacked;
        nightResults.killed = nightResults.killed.filter(id => id !== nightResults.attacked); // 被救者不被杀死
        this.potions.save = false;
        this.logEvent('WITCH_SAVED', { witchId: witchAction.userId, targetId: witchAction.targetId });
      }
      // 女巫毒药
      if (witchAction.type === 'poison' && this.potions.kill && witchAction.targetId) {
        if (!nightResults.killed.includes(witchAction.targetId) && witchAction.targetId !== nightResults.saved) {
          nightResults.killed.push(witchAction.targetId);
          nightResults.poisoned = witchAction.targetId;
          this.potions.kill = false;
          this.logEvent('WITCH_POISONED', { witchId: witchAction.userId, targetId: witchAction.targetId });
        } else if (witchAction.targetId === nightResults.saved) {
          this.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, { 
            userId: witchAction.userId, 
            message: `你不能毒杀你刚刚救下的人！` 
          });
        }
      }
    }

    // 5. 预言家行动
    const seerAction = this.actionQueue.find(a => this.getPlayerRole(a.userId) === ROLES.SEER);
    if (seerAction) {
      const inspectedPlayer = this.players.find(p => p.userId === seerAction.targetId);
      if (inspectedPlayer) {
        nightResults.inspected = inspectedPlayer.userId;
        nightResults.inspectedRole = (inspectedPlayer.role === ROLES.WEREWOLF || inspectedPlayer.role === ROLES.WOLF_KING || inspectedPlayer.role === ROLES.WHITE_WOLF_KING) ? '狼人' : '好人';
        this.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, {
          userId: seerAction.userId,
          message: `你查验的 ${inspectedPlayer.nickname} 是 ${nightResults.inspectedRole}。`
        });
        this.logEvent('SEER_INSPECTED', { seerId: seerAction.userId, targetId: inspectedPlayer.userId, result: nightResults.inspectedRole });
      }
    }
    
    // 6. 结算死亡 (按死亡顺序：狼人击杀 > 女巫毒杀)
    const deadTonight = new Set();
    nightResults.killed.forEach(userId => deadTonight.add(userId));

    let messages = [];
    let someoneDied = false;
    
    if (nightResults.attacked && nightResults.attacked === nightResults.protected) {
      messages.push(`昨晚是平安夜，没有人死亡。`);
    } else {
      if (deadTonight.size > 0) {
        messages.push('天亮了，昨晚有人死亡。');
        deadTonight.forEach(userId => {
          const player = this.players.find(p => p.userId === userId);
          if (player && player.isAlive) {
            this.killPlayer(userId, '夜晚死亡');
            messages.push(`${player.nickname} 死亡了。`);
            someoneDied = true;
          }
        });
      } else {
         messages.push(`昨晚是平安夜，没有人死亡。`);
      }
    }

    messages.forEach(msg => {
      this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: msg });
    });
    
    // 检查游戏是否结束
    this.checkGameEnd();
    
    this.actionQueue = []; // 清空行动队列
    // 统一通过 advanceGameStage 来推进阶段
    this.advanceGameStage();
  }

  /**
   * 获取玩家角色
   * @param {string} userId - 用户ID
   * @returns {string|null} 玩家角色名称或null
   */
  getPlayerRole(userId) {
    const player = this.players.find(p => p.userId === userId);
    return player ? player.role : null;
  }

  /**
   * 处理白天投票
   * @param {string} voterId - 投票人ID
   * @param {string} targetTempId - 被投票目标临时ID
   */
  handleVote(voterId, targetTempId) {
    const voter = this.players.find(p => p.userId === voterId && p.isAlive);
    const target = this.players.find(p => p.tempId === targetTempId && p.isAlive);

    if (!voter) {
      this.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, { userId: voterId, message: '你已出局，无法投票。' });
      return;
    }
    if (!target) {
      this.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, { userId: voterId, message: '投票目标无效或已出局。' });
      return;
    }

    this.gameState.votes[voterId] = target.userId;
    this.logEvent('PLAYER_VOTED', { voterId, targetId: target.userId, targetTempId });
    this.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, { userId: voterId, message: `你已投票给 ${target.nickname}。` });

    // 检查所有活着的玩家是否都已投票
    const livingPlayers = this.players.filter(p => p.isAlive);
    if (Object.keys(this.gameState.votes).length === livingPlayers.length) {
      this.processDayVote();
    }
  }

  /**
   * 统计并处理白天投票结果
   */
  processDayVote() {
    const voteCounts = {};
    for (const voterId in this.gameState.votes) {
      const targetId = this.gameState.votes[voterId];
      voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    }

    let executedPlayerId = null;
    let maxVotes = 0;
    let candidates = [];

    for (const userId in voteCounts) {
      if (voteCounts[userId] > maxVotes) {
        maxVotes = voteCounts[userId];
        candidates = [userId];
      } else if (voteCounts[userId] === maxVotes) {
        candidates.push(userId);
      }
    }

    if (candidates.length === 1) {
      executedPlayerId = candidates[0];
      const executedPlayer = this.players.find(p => p.userId === executedPlayerId);
      this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: `投票结果：${executedPlayer.nickname} 被出局。` });
      this.killPlayer(executedPlayerId, '白天投票出局');
    } else {
      this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: '平票，没有人出局。' });
    }

    // 清空投票数据
    this.gameState.votes = {};
    this.gameState.players.forEach(p => p.hasVoted = false); // 清空投票状态

    // 检查游戏是否结束
    // 如果没有游戏结束，且有人出局，则进入遗言阶段
    if (!this.checkGameEnd() && executedPlayerId) {
      const executedPlayer = this.players.find(p => p.userId === executedPlayerId);
      if (executedPlayer && executedPlayer.isAlive === false) { // 确保玩家确实死亡
        this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: `${executedPlayer.nickname} 请留遗言。` });
        this.gameState.currentPhase = GAME_STATES.LAST_WORDS;
        this.gameState.currentSpeakerUserId = executedPlayerId; // 遗言者
        this.startPhaseTimer(GAME_STATES.LAST_WORDS);
        this.logEvent('LAST_WORDS_STARTED', { userId: executedPlayerId });
      } else {
        // 如果没人出局或者游戏已经结束，直接进入下一个阶段
        this.advanceGameStage();
      }
    } else {
      // 如果游戏已经结束，或者没有人出局，直接进入下一个阶段
      this.advanceGameStage();
    }
  }

  /**
   * 杀死玩家
   * @param {string} userId - 要杀死的玩家ID
   * @param {string} reason - 死亡原因
   */
  killPlayer(userId, reason) {
    const player = this.players.find(p => p.userId === userId);
    if (player && player.isAlive) {
      player.isAlive = false;
      this.emit(GAME_EVENTS.PLAYER_DIED, { groupId: this.groupId, userId: userId, reason: reason });
      this.logEvent('PLAYER_DIED', { userId: userId, reason: reason });
      
      // 如果是警长死亡，触发警徽流失或移交
      if (this.gameState.sheriffId === userId) {
        this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: `${player.nickname} 作为警长死亡，警徽流失。` });
        this.gameState.sheriffId = null; // 警长死亡警徽流失，未来可以扩展警徽移交功能
        this.logEvent('SHERIFF_BADGE_LOST', { sheriffId: userId }); // 更改日志事件类型
      }
      
      // 处理猎人技能 (只有猎人牌在场，且猎人死亡时触发)
      if (player.role === ROLES.HUNTER && !player.isAlive) {
        this.gameState.hunterNeedsToShoot = player.userId;
        this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: `猎人 ${player.nickname} 死亡了，他可以发动技能选择带走一个人。` });
        this.logEvent('HUNTER_SKILL_TRIGGERED', { hunterId: player.userId });
        this.startPhaseTimer(GAME_STATES.HUNTER_SHOOT); // 启动猎人开枪计时
      }

      // 处理狼王技能 (只有狼王牌在场，且狼王死亡时触发)
      if (player.role === ROLES.WOLF_KING && !player.isAlive) {
        this.gameState.wolfKingNeedsToClaw = player.userId;
        this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: `狼王 ${player.nickname} 死亡了，他可以发动技能选择撕咬一个人。` });
        this.logEvent('WOLF_KING_SKILL_TRIGGERED', { wolfKingId: player.userId });
        this.startPhaseTimer(GAME_STATES.WOLF_KING_CLAW); // 启动狼王撕咬计时
      }
    }
    // 检查是否进入遗言阶段
    // 遗言判断逻辑可以更复杂，例如只有部分角色可以留遗言
    if (!this.checkGameEnd() && !this.gameState.hunterNeedsToShoot && !this.gameState.wolfKingNeedsToClaw) { // 确保游戏未结束，且不是猎人/狼王发动技能阶段
      this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: `${player.nickname} 请留遗言。` });
      this.gameState.currentPhase = GAME_STATES.LAST_WORDS;
      this.gameState.currentSpeakerUserId = userId; // 遗言者
      this.startPhaseTimer(GAME_STATES.LAST_WORDS);
      this.logEvent('LAST_WORDS_STARTED', { userId: userId });
    } else if (!this.gameState.hunterNeedsToShoot && !this.gameState.wolfKingNeedsToClaw) {
      // 如果游戏结束或者有猎人狼王技能待发动，直接进入下一个阶段
      this.advanceGameStage();
    }
  }

  /**
   * 处理猎人开枪
   * @param {string} hunterId - 猎人ID
   * @param {string} targetTempId - 被带走目标临时ID
   */
  handleHunterShoot(hunterId, targetTempId) {
    const game = this.gameState;
    const hunterPlayer = this.players.find(p => p.userId === hunterId);

    if (!hunterPlayer || hunterPlayer.role !== ROLES.HUNTER || hunterPlayer.isAlive || game.hunterNeedsToShoot !== hunterId) {
      this.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, { userId: hunterId, message: '你无法执行开枪操作。' });
      return;
    }

    const targetPlayer = this.players.find(p => p.tempId === targetTempId);
    if (!targetPlayer || !targetPlayer.isAlive) {
      this.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, { userId: hunterId, message: '无效的开枪目标。' });
      return;
    }

    this.killPlayer(targetPlayer.userId, '猎人开枪带走');
    this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: `猎人 ${hunterPlayer.nickname} 开枪带走了 ${targetPlayer.nickname}。` });
    this.logEvent('HUNTER_SHOT', { hunterId: hunterId, targetId: targetPlayer.userId });
    game.hunterNeedsToShoot = null; // 清除猎人开枪标记
    this.checkGameEnd(); // 检查游戏是否结束
  }

  /**
   * 处理狼王撕咬
   * @param {string} wolfKingId - 狼王ID
   * @param {string} targetTempId - 被撕咬目标临时ID
   */
  handleWolfKingClaw(wolfKingId, targetTempId) {
    const game = this.gameState;
    const wolfKingPlayer = this.players.find(p => p.userId === wolfKingId);

    if (!wolfKingPlayer || wolfKingPlayer.role !== ROLES.WOLF_KING || wolfKingPlayer.isAlive || game.wolfKingNeedsToClaw !== wolfKingId) {
      this.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, { userId: wolfKingId, message: '你无法执行撕咬操作。' });
      return;
    }

    const targetPlayer = this.players.find(p => p.tempId === targetTempId);
    if (!targetPlayer || !targetPlayer.isAlive) {
      this.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, { userId: wolfKingId, message: '无效的撕咬目标。' });
      return;
    }

    this.killPlayer(targetPlayer.userId, '狼王撕咬');
    this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: `狼王 ${wolfKingPlayer.nickname} 撕咬了 ${targetPlayer.nickname}。` });
    this.logEvent('WOLF_KING_CLAWED', { wolfKingId: wolfKingId, targetId: targetPlayer.userId });
    game.wolfKingNeedsToClaw = null; // 清除狼王撕咬标记
    this.checkGameEnd(); // 检查游戏是否结束
  }

  /**
   * 检查游戏是否结束
   */
  checkGameEnd() {
    const alivePlayers = this.players.filter(p => p.isAlive);
    const aliveWerewolves = alivePlayers.filter(p => [ROLES.WEREWOLF, ROLES.WOLF_KING, ROLES.WHITE_WOLF_KING].includes(p.role));
    const aliveVillagers = alivePlayers.filter(p => ![ROLES.WEREWOLF, ROLES.WOLF_KING, ROLES.WHITE_WOLF_KING].includes(p.role));

    if (aliveWerewolves.length === 0) {
      this.endGame(VICTORY_CONDITIONS.VILLAGER_WIN);
      return;
    }

    if (aliveWerewolves.length >= aliveVillagers.length) {
      this.endGame(VICTORY_CONDITIONS.WEREWOLF_WIN);
      return;
    }

    if (alivePlayers.length <= 2) { // 例如，只剩下两人，且未触发胜负条件，可以设置为平局
      // TODO: 更复杂的平局判断逻辑
      this.endGame(VICTORY_CONDITIONS.DRAW);
      return;
    }
  }

  /**
   * 结束游戏
   * @param {string} winner - 胜利方
   */
  endGame(winner) {
    this.gameState.isRunning = false;
    this.emit(GAME_EVENTS.GAME_ENDED, { groupId: this.groupId, winner: winner });
    this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: `游戏结束！胜利方：${winner}` });
    this.logEvent('GAME_ENDED', { winner: winner });
    this.emit(INTERACTION_EVENTS.SAVE_GAME_DATA, {
      groupId: this.groupId,
      data: this.getGameData()
    });
  }

  /**
   * 计算警长选举结果
   */
  calculateSheriffResult() {
    const game = this.gameState;
    const voteCounts = {}; // { userId: count }

    // 统计票数
    for (const voterId in game.sheriffVotes) {
      const targetId = game.sheriffVotes[voterId];
      voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    }

    let maxVotes = 0;
    let sheriffCandidates = [];

    // 找出得票最高的玩家
    for (const userId in voteCounts) {
      if (voteCounts[userId] > maxVotes) {
        maxVotes = voteCounts[userId];
        sheriffCandidates = [userId];
      } else if (voteCounts[userId] === maxVotes) {
        sheriffCandidates.push(userId);
      }
    }

    let electedSheriffId = null;

    if (sheriffCandidates.length === 1) {
      // 只有一个最高得票者，直接选出警长
      electedSheriffId = sheriffCandidates[0];
    } else if (sheriffCandidates.length > 1) {
      // 平局，进入二次投票
      game.currentPhase = GAME_STATES.SHERIFF_RUNOFF_VOTE;
      game.candidateList = sheriffCandidates; // 记录候选人，用于二次投票
      this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: `警长选举出现平局！请在 ${sheriffCandidates.map(id => this.players.find(p => p.userId === id)?.tempId + '号').join(' ')} 玩家中进行二次投票。` });
      this.startPhaseTimer(GAME_STATES.SHERIFF_VOTE); // 复用警长投票的计时器
      this.logEvent('SHERIFF_RUNOFF_VOTE_STARTED', { candidates: sheriffCandidates });
      // 清理投票数据，准备进行二次投票
      game.sheriffVotes = {};
      game.players.forEach(p => p.hasVoted = false);
      return; // 暂停流程，等待二次投票
    } else {
      // 没有人投票或没有人获得票数，表示警长流失
      this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: '警长流失，没有人成为警长。' });
      this.logEvent('SHERIFF_LOST');
      game.sheriffId = null;
      // 进入下一个阶段
      this.advanceGameStage();
      return;
    }

    // 清理投票数据 (只有在选出警长或警长流失时才清理)
    game.sheriffVotes = {};
    game.players.forEach(p => p.hasVoted = false);

    // 公布警长并更新游戏状态
    const electedSheriffPlayer = game.players.find(p => p.userId === electedSheriffId);
    if (electedSheriffPlayer) {
      game.sheriffId = electedSheriffId;
      this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: `恭喜 ${electedSheriffPlayer.tempId}号玩家当选警长！` });
      this.logEvent('SHERIFF_ELECTED', { sheriffId: electedSheriffId });
    }

    // 进入下一个阶段
    this.advanceGameStage();
  }

  /**
   * 处理警长竞选
   * @param {string} userId - 竞选人ID
   */
  handleSheriffCandidate(userId) {
    const game = this.gameState;
    const player = game.players.find(p => p.userId === userId);

    if (!player || !player.isAlive) {
      this.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, { userId: userId, message: '你不能竞选警长。' });
      return;
    }

    if (game.currentPhase !== GAME_STATES.SHERIFF_ELECTION) {
      this.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, { userId: userId, message: '当前不是警长竞选阶段。' });
      return;
    }

    if (!game.candidateList.includes(userId)) {
      game.candidateList.push(userId);
      this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: `${player.nickname} 竞选警长。` });
      this.logEvent('SHERIFF_CANDIDATE_ADDED', { userId: userId });
    } else {
      this.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, { userId: userId, message: '你已经竞选过警长了。' });
    }
    this.emit(INTERACTION_EVENTS.SAVE_GAME_DATA, {
      groupId: this.groupId,
      data: this.getGameData()
    });
  }

  /**
   * 处理警长选举投票
   * @param {string} voterId - 投票人ID
   * @param {string} targetTempId - 被投票目标临时ID
   */
  handleSheriffVote(voterId, targetTempId) {
    const game = this.gameState;
    const player = game.players.find(p => p.userId === voterId);
    if (!player) {
      this.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, { userId: voterId, message: '你不在游戏中。' });
      return;
    }

    if (game.currentPhase !== GAME_STATES.SHERIFF_VOTE && game.currentPhase !== GAME_STATES.SHERIFF_RUNOFF_VOTE) {
      this.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, { userId: voterId, message: '当前不是警长选举投票阶段。' });
      return;
    }

    const targetPlayer = game.players.find(p => p.tempId === targetTempId);
    if (!targetPlayer) {
      this.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, { userId: voterId, message: '无效的投票目标。' });
      return;
    }

    if (game.currentPhase === GAME_STATES.SHERIFF_RUNOFF_VOTE && !game.candidateList.includes(targetPlayer.userId)) {
      this.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, { userId: voterId, message: '二次投票只能投给警长候选人。' });
      return;
    }

    // 记录投票
    if (!game.sheriffVotes) {
      game.sheriffVotes = {};
    }
    game.sheriffVotes[voterId] = targetPlayer.userId;
    player.hasVoted = true;

    this.emit(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, { userId: voterId, message: `你已投票给 ${targetPlayer.tempId}号玩家。` });

    // 检查是否所有在场玩家都已投票
    const livingPlayers = game.players.filter(p => p.isAlive);
    const allVoted = livingPlayers.every(p => p.hasVoted);

    if (allVoted) {
      this.calculateSheriffResult();
    }
  }

  /**
   * 推进游戏阶段
   */
  advanceGameStage() {
    const game = this.gameState;
    // 清除上次的阶段计时器
    if (this.phaseTimer) {
      clearTimeout(this.phaseTimer);
      this.phaseTimer = null;
    }

    switch (game.currentPhase) {
      case GAME_STATES.NIGHT_PHASE:
        // 夜晚结束后，如果是第一天，并且开启了警长竞选，则进入警长竞选阶段
        if (game.currentDay === 1 && game.hasSheriff) {
          game.currentPhase = GAME_STATES.SHERIFF_ELECTION;
          this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: '警长竞选开始，请各位玩家发送"竞选警长"参与竞选。' });
          this.startPhaseTimer(GAME_STATES.SHERIFF_ELECTION);
          this.logEvent('SHERIFF_ELECTION_STARTED');
        } else {
          // 否则进入白天发言阶段
          game.currentPhase = GAME_STATES.DAY_SPEECH;
          this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: '现在是白天发言阶段。' });
          // 初始化发言顺序和当前发言人
          this.initializeSpeakingOrder();
          this.nextSpeaker();
        }
        break;
      case GAME_STATES.SHERIFF_ELECTION:
        // 警长竞选结束后判断是否有候选人
        if (game.candidateList.length > 0) {
          game.currentPhase = GAME_STATES.SHERIFF_SPEECH;
          this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: '警长候选人发言阶段。' });
          // 警长候选人发言顺序，通常是按座位号或报名顺序
          game.speakingOrder = game.candidateList; // 候选人作为发言顺序
          game.currentSpeakerIndex = -1;
          this.nextSpeaker(); // 开始警长候选人发言
          this.logEvent('SHERIFF_SPEECH_STARTED');
        } else {
          // 没有候选人，警长流失，直接进入白天发言阶段
          this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: '无人竞选警长，警长流失。' });
          game.sheriffId = null;
          game.currentPhase = GAME_STATES.DAY_SPEECH;
          this.initializeSpeakingOrder();
          this.nextSpeaker();
          this.logEvent('SHERIFF_LOST');
        }
        break;
      case GAME_STATES.SHERIFF_SPEECH:
        // 警长发言结束后进入警长投票阶段
        game.currentPhase = GAME_STATES.SHERIFF_VOTE;
        this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: '警长投票阶段，请各位玩家发送"投票 <编号>"给支持的警长候选人。' });
        this.startPhaseTimer(GAME_STATES.SHERIFF_VOTE);
        this.logEvent('SHERIFF_VOTE_STARTED');
        break;
      case GAME_STATES.SHERIFF_VOTE:
      case GAME_STATES.SHERIFF_RUNOFF_VOTE: // 二次投票结束后也进入白天发言阶段
        // 警长投票结束后进入白天发言阶段
        game.currentPhase = GAME_STATES.DAY_SPEECH;
        this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: '现在是白天发言阶段。' });
        this.initializeSpeakingOrder();
        this.nextSpeaker();
        break;
      case GAME_STATES.DAY_SPEECH:
        // 白天发言结束后进入白天投票阶段
        game.currentPhase = GAME_STATES.DAY_VOTE;
        this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: '现在是投票阶段，请各位玩家发送"投票 <编号>"。' });
        this.startPhaseTimer(GAME_STATES.DAY_VOTE);
        this.logEvent('DAY_VOTE_STARTED');
        break;
      case GAME_STATES.DAY_VOTE:
        // 白天投票结束后进入夜晚
        game.currentDay++;
        game.currentPhase = GAME_STATES.NIGHT_PHASE;
        this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: `天黑请闭眼，第 ${game.currentDay} 晚。` });
        this.startPhaseTimer(GAME_STATES.NIGHT_PHASE);
        this.logEvent('NIGHT_STARTED', { day: game.currentDay });
        break;
      default:
        // 默认进入夜晚
        game.currentPhase = GAME_STATES.NIGHT_PHASE;
        this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: '游戏阶段异常，强制进入夜晚。' });
        this.startPhaseTimer(GAME_STATES.NIGHT_PHASE);
        this.logEvent('STAGE_ADVANCE_DEFAULT_TO_NIGHT');
        break;
    }
    this.emit(INTERACTION_EVENTS.SAVE_GAME_DATA, {
      groupId: this.groupId,
      data: this.getGameData()
    });
  }

  /**
   * 初始化发言顺序
   */
  initializeSpeakingOrder() {
    // 警长优先发言，然后是其他玩家按座位号顺序
    const game = this.gameState;
    const livingPlayers = this.players.filter(p => p.isAlive).sort((a, b) => a.tempId - b.tempId);
    let speakingOrder = [];

    if (game.sheriffId) {
      const sheriffPlayer = livingPlayers.find(p => p.userId === game.sheriffId);
      if (sheriffPlayer) {
        speakingOrder.push(sheriffPlayer.userId);
        // 将警长从剩余玩家中移除
        livingPlayers.splice(livingPlayers.findIndex(p => p.userId === sheriffPlayer.userId), 1);
      }
    }
    speakingOrder = speakingOrder.concat(livingPlayers.map(p => p.userId));
    game.speakingOrder = speakingOrder;
    game.currentSpeakerIndex = -1; // 准备开始第一个发言人
  }

  /**
   * 切换到下一位发言人
   */
  nextSpeaker() {
    const game = this.gameState;
    game.currentSpeakerIndex++;
    if (game.currentSpeakerIndex < game.speakingOrder.length) {
      game.currentSpeakerUserId = game.speakingOrder[game.currentSpeakerIndex];
      const speakerPlayer = this.players.find(p => p.userId === game.currentSpeakerUserId);
      this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: `现在请 ${speakerPlayer.tempId}号玩家发言。` });
      this.startPhaseTimer(GAME_STATES.DAY_SPEECH); // 为当前发言人启动计时器
      this.logEvent('SPEAKER_CHANGED', { userId: speakerPlayer.userId });
    } else {
      // 所有人都发言完毕，进入投票阶段
      game.currentSpeakerUserId = null;
      this.emit(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, { groupId: this.groupId, message: '所有玩家发言完毕。' });
      this.advanceGameStage(); // 进入下一个阶段 (投票)
    }
    this.emit(INTERACTION_EVENTS.SAVE_GAME_DATA, {
      groupId: this.groupId,
      data: this.getGameData()
    });
  }

  /**
   * 获取游戏日志摘要
   * @returns {string} 游戏日志摘要
   */
  getGameLogSummary() {
    const getPlayerInfo = (userId) => {
      const player = this.players.find(p => p.userId === userId);
      return player ? `${player.nickname}(${player.tempId})` : `未知玩家(${userId})`;
    };

    const getPlayerRole = (userId) => {
      const player = this.players.find(p => p.userId === userId);
      return player ? player.role : '未知角色';
    };

    let summary = `游戏群组ID: ${this.groupId}\n`;
    summary += `游戏状态: ${this.gameState.isRunning ? '进行中' : '未开始/已结束'}\n`;
    summary += `当前阶段: ${this.gameState.currentPhase}\n`;
    summary += `当前天数: ${this.gameState.currentDay}\n`;
    summary += `玩家列表 (${this.players.length}人):\n`;
    this.players.forEach(p => {
      summary += `- ${getPlayerInfo(p.userId)} [${getPlayerRole(p.userId)}] - ${p.isAlive ? '存活' : '死亡'}\n`;
    });
    summary += `\n近期事件:\n`;

    // 限制日志输出数量，例如只输出最近20条
    const recentEvents = this.gameState.eventLog.slice(-20); 
    recentEvents.forEach(event => {
      let eventStr = `- [${new Date(event.timestamp).toLocaleString()}] `;
      switch (event.type) {
        case 'GAME_STARTED':
          eventStr += `游戏开始。`;
          break;
        case 'PLAYER_JOINED':
          eventStr += `${event.nickname}(${event.tempId}) 加入游戏。`;
          break;
        case 'PLAYER_LEFT':
          eventStr += `${event.nickname} 退出游戏。`;
          break;
        case 'NIGHT_ACTIONS_RESOLVED':
          eventStr += `夜晚行动结算。`;
          // 可以选择更详细地列出夜晚行动，但可能会很长
          break;
        case 'GUARD_PROTECTED':
          eventStr += `${getPlayerInfo(event.protectorId)} 守护了 ${getPlayerInfo(event.targetId)}。`;
          break;
        case 'WEREWOLF_ATTACKED':
          eventStr += `狼人袭击了 ${getPlayerInfo(event.targetId)}。`;
          break;
        case 'WITCH_SAVED':
          eventStr += `${getPlayerInfo(event.witchId)} 使用解药救了 ${getPlayerInfo(event.targetId)}。`;
          break;
        case 'WITCH_POISONED':
          eventStr += `${getPlayerInfo(event.witchId)} 使用毒药毒杀了 ${getPlayerInfo(event.targetId)}。`;
          break;
        case 'SEER_INSPECTED':
          eventStr += `${getPlayerInfo(event.seerId)} 查验了 ${getPlayerInfo(event.targetId)}，结果是 ${event.result}。`;
          break;
        case 'PLAYER_DIED':
          eventStr += `${getPlayerInfo(event.userId)} 死亡，原因：${event.reason}。`;
          break;
        case 'PLAYER_VOTED':
          eventStr += `${getPlayerInfo(event.voterId)} 投票给 ${event.targetTempId}号玩家。`;
          break;
        case 'SHERIFF_BADGE_LOST': // 新增事件
          eventStr += `${getPlayerInfo(event.sheriffId)} 警长警徽流失。`;
          break;
        case 'SHERIFF_ELECTED':
          eventStr += `${getPlayerInfo(event.sheriffId)} 当选警长。` ;
          break;
        case 'SHERIFF_LOST':
          eventStr += `警长流失。`;
          break;
        case 'GAME_ENDED':
          eventStr += `游戏结束，胜利方：${event.winner}。`;
          break;
        case 'HUNTER_SKILL_TRIGGERED': // 新增事件
          eventStr += `${getPlayerInfo(event.hunterId)} 猎人发动技能。`;
          break;
        case 'WOLF_KING_SKILL_TRIGGERED': // 新增事件
          eventStr += `${getPlayerInfo(event.wolfKingId)} 狼王发动技能。`;
          break;
        case 'SHERIFF_ELECTION_STARTED':
          eventStr += `警长竞选开始。`;
          break;
        case 'SHERIFF_SPEECH_STARTED': // 新增事件
          eventStr += `警长候选人发言开始。`;
          break;
        case 'SHERIFF_VOTE_STARTED':
          eventStr += `警长投票开始。`;
          break;
        case 'SHERIFF_RUNOFF_VOTE_STARTED':
          eventStr += `警长二次投票开始，候选人：${event.candidates.map(getPlayerInfo).join(', ')}。`;
          break;
        case 'DAY_VOTE_STARTED':
          eventStr += `白天投票开始。`;
          break;
        case 'NIGHT_STARTED':
          eventStr += `第 ${event.day} 晚开始。`;
          break;
        case 'SPEAKER_CHANGED':
          eventStr += `现在是 ${getPlayerInfo(event.userId)} 发言。`;
          break;
        case 'STAGE_ADVANCE_DEFAULT_TO_NIGHT':
          eventStr += `游戏阶段异常，强制进入夜晚。`;
          break;
        default:
          eventStr += `未知事件: ${event.type}`;
      }
      summary += `${eventStr}\n`;
    });

    return summary;
  }
}

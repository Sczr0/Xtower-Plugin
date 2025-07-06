// model/werewolf/GameEngine.js
import { ROLES, TAGS, TEAMS, GAME_PHASE, WOLF_TEAM_ROLES } from "./constants.js";
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
   * 根据玩家人数生成默认板子配置
   * @param {number} playerCount 玩家人数
   * @returns {object} 角色配置对象
   */
  generateDefaultBoard(playerCount) {
    const roles = {};
    let wolfCount = Math.floor(playerCount / 3);
    let godCount = Math.floor(playerCount / 3);
    let villagerCount = Math.floor(playerCount / 3);

    // 处理余数，优先给平民，其次是狼人
    const remainder = playerCount % 3;
    if (remainder === 1) {
      villagerCount++;
    } else if (remainder === 2) {
      villagerCount++;
      wolfCount++;
    }

    // 确保有预言家，并从神职名额中扣除
    roles[ROLES.SEER] = 1;
    godCount--; // 预言家占用一个神职名额

    // 将基础狼人和平民数量加入角色配置
    roles[ROLES.WEREWOLF] = wolfCount;
    roles[ROLES.VILLAGER] = villagerCount;

    // 添加其他神职，优先级：守卫 > 猎人 > 女巫
    const godRolesPriority = [ROLES.GUARD, ROLES.HUNTER, ROLES.WITCH];
    for (const roleId of godRolesPriority) {
      if (godCount > 0) {
        roles[roleId] = (roles[roleId] || 0) + 1;
        godCount--;
      } else {
        break; // 没有多余神职名额了
      }
    }
    
    // 如果还有多余神职名额，则转换为平民
    if (godCount > 0) {
       roles[ROLES.VILLAGER] += godCount;
    }

    // 确保每个角色至少有1个，如果计算结果为0，则调整
    for (const roleId in roles) {
        if (roles[roleId] === 0) {
            delete roles[roleId];
        }
    }

    return roles;
  }

  /**
   * 初始化游戏，分配角色并生成初始事件
   * @param {string} boardName 游戏板子名称
   * @returns {{error?: string, events: Array<object>}} 包含错误信息或初始事件的数组
   */
  initializeGame(boardName) {
    const events = [];
    const playerCount = this.players.length;
    let roleConfig = this.config.rolePresets[boardName];

    // 如果没有指定板子名称，或者板子名称是默认的自动生成板子名称，或者找不到预设板子，则自动生成
    if (!boardName || boardName === this.config.DEFAULT_BOARD_NAME || !roleConfig) {
        roleConfig = {
            name: `自动生成板子 (${playerCount}人)`,
            playerCount: playerCount,
            roles: this.generateDefaultBoard(playerCount)
        };
        this.gameLog.push({ type: 'board_generated', day: 0, roles: roleConfig.roles }); // 记录自动生成板子事件
        boardName = roleConfig.name; // 更新板子名称为自动生成的名称
    } else {
        // 检查预设板子人数是否匹配
        const totalRolesCount = Object.values(roleConfig.roles).reduce((sum, count) => sum + count, 0);
        if (playerCount !== totalRolesCount) {
            return { error: `玩家人数 (${playerCount}) 与板子【${boardName}】所需角色数 (${totalRolesCount}) 不匹配。` };
        }
    }
    
    // 2. 分配角色
    let rolesToAssign = [];
    for (const roleId in roleConfig.roles) {
      for (let i = 0; i < roleConfig.roles[roleId]; i++) {
        rolesToAssign.push(roleId);
      }
    }
    shuffleArray(rolesToAssign); // 打乱角色顺序

    this.players.forEach((player, index) => {
      const roleId = rolesToAssign[index];
      const RoleClass = werewolfConfig.ROLES_MAP[roleId]; // 使用 werewolfConfig.ROLES_MAP
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
      }
      if (isWolfAttacked && !isGuarded && !isSaved) {
          shouldDie = true;
      }
      if (isWolfAttacked && isGuarded && isSaved) { // 被守卫守护且被女巫救了，但狼人自刀的情况
          // 检查是否有狼人自刀
          const wolfKing = this.players.find(p => p.role.roleId === ROLES.WOLF_KING && p.hasTag(TAGS.WOLF_KING_SELF_STAB));
          if (wolfKing && wolfKing.userId === p.userId) {
              shouldDie = true; // 狼王自刀成功
          }
      }

      if (shouldDie) {
          this.pendingDeaths.push(p.userId);
      }
    });

    // 清理狼王自刀标记
    this.players.forEach(p => p.clearTemporaryTags(TAGS.WOLF_KING_SELF_STAB));

    // 如果没有死亡，直接进入白天发言阶段
    if (this.pendingDeaths.length === 0) {
        events.push({ type: 'group_message', content: '昨晚平安夜，没有人死亡。' });
        this.gameLog.push({ type: 'peaceful_night', day: this.gameState.day }); // 记录事件
        this.eventQueue.push({ event: GAME_PHASE.DAY_ANNOUNCEMENT }); // 进入白天公布阶段
    } else {
        this.eventQueue.push({ event: GAME_PHASE.DAY_ANNOUNCEMENT }); // 进入白天公布阶段
    }

    // 清理所有夜间行动数据
    this.players.forEach(p => {
      if (p.role && typeof p.role.clearNightAction === 'function') {
        p.role.clearNightAction();
      }
    });
    
    return events;
  }

  async processPendingDeaths() {
    let events = [];
    // 检查游戏是否已经结束 (例如，狼人或好人胜利)
    const checkResult = this.checkGameEnd();
    if (checkResult.isEnd) {
        this.gameState.phase = GAME_PHASE.GAME_OVER;
        events.push({ type: 'game_over', winner: checkResult.winner, reason: checkResult.reason });
        return events;
    }

    if (this.pendingDeaths.length > 0) {
        const deadPlayerIds = [...this.pendingDeaths]; // 复制一份，防止在循环中修改
        this.pendingDeaths = []; // 清空待处理死亡列表

        for (const userId of deadPlayerIds) {
            const player = this.getPlayer(userId);
            if (player && player.isAlive) {
                player.isAlive = false;
                events.push({ type: 'group_message', content: `玩家 ${player.info} 死亡。` });
                this.gameLog.push({ type: 'player_death', day: this.gameState.day, player: player.info }); // 记录事件

                // 检查是否有遗言
                if (player.role.canLeaveLastWords) {
                    // 触发遗言阶段
                    this.eventQueue.push({ event: GAME_PHASE.LAST_WORDS, data: { playerId: player.userId } });
                }

                // 检查猎人是否发动技能
                if (player.role.roleId === ROLES.HUNTER && player.hasTag(TAGS.HUNTER_CAN_SHOOT)) {
                    this.eventQueue.push({ event: GAME_PHASE.HUNTER_SHOOT, data: { hunterId: player.userId } });
                }

                // 检查狼王是否发动技能
                if (player.role.roleId === ROLES.WOLF_KING && player.hasTag(TAGS.WOLF_KING_CAN_CLAW)) {
                    this.eventQueue.push({ event: GAME_PHASE.WOLF_KING_CLAW, data: { wolfKingId: player.userId, groupId: this.groupId } });
                }
                
                // 检查白痴是否翻牌
                if (player.role.roleId === ROLES.IDIOT && player.hasTag(TAGS.IDIOT_CAN_FLIP)) {
                    this.eventQueue.push({ event: GAME_PHASE.IDIOT_FLIP, data: { idiotId: player.userId, groupId: this.groupId } });
                }
            }
        }
    } else {
        // 如果没有待处理的死亡，直接进入警长竞选阶段
        this.eventQueue.push({ event: GAME_PHASE.SHERIFF_ELECTION });
    }

    // 检查游戏是否已经结束 (例如，狼人或好人胜利)
    const finalCheckResult = this.checkGameEnd();
    if (finalCheckResult.isEnd) {
        this.gameState.phase = GAME_PHASE.GAME_OVER;
        events.push({ type: 'game_over', winner: finalCheckResult.winner, reason: finalCheckResult.reason });
        this.eventQueue = []; // 清空事件队列，阻止后续阶段
    }
    return events;
  }

  startSheriffElection() {
    const events = [];
    this.gameState.sheriffCandidates = [];
    this.gameState.sheriffVotes = {};
    this.gameLog.push({ type: 'sheriff_election_start', day: this.gameState.day }); // 记录事件

    // 只有存活的玩家才能上警
    const alivePlayers = this.getAlivePlayers();
    if (alivePlayers.length > 0) {
        events.push({ type: 'group_message', content: '警长竞选开始！想上警的玩家请发送“上警”。' });
    } else {
        events.push({ type: 'group_message', content: '没有存活玩家，无法进行警长竞选。游戏结束。' });
        this.eventQueue.push({ event: GAME_PHASE.GAME_OVER, data: { winner: 'NONE', reason: '所有玩家死亡' } });
    }
    return events;
  }

  async declareSheriffCandidate(userId) {
    if (this.gameState.phase !== GAME_PHASE.SHERIFF_ELECTION) return "当前不是警长竞选时间。";
    const player = this.getPlayer(userId);
    if (!player || !player.isAlive) return "你已出局，无法上警。";
    if (this.gameState.sheriffCandidates.includes(userId)) return "你已经上警了。";

    this.gameState.sheriffCandidates.push(userId);
    this.gameLog.push({ type: 'declare_sheriff_candidate', day: this.gameState.day, player: player.info }); // 记录事件
    return `${player.info} 参与警长竞选。`;
  }

  startSheriffVote() {
    const events = [];
    this.gameState.sheriffVotes = {}; // 清空投票
    this.gameLog.push({ type: 'sheriff_vote_start', day: this.gameState.day, candidates: this.gameState.sheriffCandidates.map(id => this.getPlayer(id).info) }); // 记录事件

    if (this.gameState.sheriffCandidates.length === 0) {
      events.push({ type: 'group_message', content: '没有人上警，本局无警长。直接进入白天发言阶段。' });
      this.eventQueue.push({ event: GAME_PHASE.DAY_SPEAK });
    } else if (this.gameState.sheriffCandidates.length === 1) {
      const sheriff = this.getPlayer(this.gameState.sheriffCandidates[0]);
      this.gameState.sheriffId = sheriff.userId;
      events.push({ type: 'group_message', content: `只有 ${sheriff.info} 一人上警，自动当选警长。` });
      this.gameLog.push({ type: 'sheriff_elected_auto', day: this.gameState.day, sheriff: sheriff.info }); // 记录事件
      this.eventQueue.push({ event: GAME_PHASE.DAY_SPEAK });
    } else {
      const candidateNames = this.gameState.sheriffCandidates.map(id => this.getPlayer(id).info).join('，');
      events.push({ type: 'group_message', content: `警长候选人：${candidateNames}。请大家投票选出警长。` });
    }
    return events;
  }

  async voteSheriff(voterId, targetId) {
    if (this.gameState.phase !== GAME_PHASE.SHERIFF_VOTE) return "当前不是警长投票时间。";
    const voter = this.getPlayer(voterId);
    const target = this.getPlayer(targetId);

    if (!voter || !voter.isAlive) return "你已出局，无法投票。";
    if (!target || !target.isAlive || !this.gameState.sheriffCandidates.includes(targetId)) return "投票目标无效或不是警长候选人。";

    this.gameState.sheriffVotes[voterId] = targetId;
    this.gameLog.push({ type: 'sheriff_vote', day: this.gameState.day, voter: voter.info, target: target.info }); // 记录事件
    return `${voter.info} 投给了 ${target.info}。`;
  }

  async processSheriffVoteResults() {
    let events = [];
    const votes = this.gameState.sheriffVotes;
    const candidateVotes = {};
    this.gameState.sheriffCandidates.forEach(candidateId => candidateVotes[candidateId] = 0);

    for (const voterId in votes) {
      const targetId = votes[voterId];
      if (candidateVotes[targetId] !== undefined) {
        candidateVotes[targetId]++;
      }
    }

    let maxVotes = 0;
    let topCandidates = [];
    for (const candidateId in candidateVotes) {
      if (candidateVotes[candidateId] > maxVotes) {
        maxVotes = candidateVotes[candidateId];
        topCandidates = [candidateId];
      } else if (candidateVotes[candidateId] === maxVotes) {
        topCandidates.push(candidateId);
      }
    }

    if (topCandidates.length === 1) {
      const sheriff = this.getPlayer(topCandidates[0]);
      this.gameState.sheriffId = sheriff.userId;
      events.push({ type: 'group_message', content: `警长是：${sheriff.info}！` });
      this.gameLog.push({ type: 'sheriff_elected', day: this.gameState.day, sheriff: sheriff.info }); // 记录事件
      this.eventQueue.push({ event: GAME_PHASE.DAY_SPEAK });
    } else if (topCandidates.length > 1 && maxVotes > 0) {
      // 平票，进入 PK 环节
      const pkPlayerNames = topCandidates.map(id => this.getPlayer(id).info).join('，');
      events.push({ type: 'group_message', content: `警长竞选平票，进入PK环节：${pkPlayerNames}。` });
      this.gameState.pkPlayers = topCandidates; // 设置PK玩家
      this.eventQueue.push({ event: GAME_PHASE.PK_VOTE, data: { pkPlayers: topCandidates } });
    } else {
      events.push({ type: 'group_message', content: '警长竞选没有结果，本局无警长。直接进入白天发言阶段。' });
      this.gameLog.push({ type: 'no_sheriff', day: this.gameState.day }); // 记录事件
      this.eventQueue.push({ event: GAME_PHASE.DAY_SPEAK });
    }
    return events;
  }

  startPkVotePhase(pkPlayers) {
    const events = [];
    this.gameState.pkVotes = {}; // 清空PK投票
    this.gameLog.push({ type: 'pk_vote_start', day: this.gameState.day, pkPlayers: pkPlayers.map(id => this.getPlayer(id).info) }); // 记录事件

    const pkPlayerNames = pkPlayers.map(id => this.getPlayer(id).info).join('，');
    events.push({ type: 'group_message', content: `PK投票环节，请从 ${pkPlayerNames} 中选择一名玩家投票。` });
    this.startTimer(GAME_PHASE.PK_VOTE, this.config.pkVoteDuration);
    return events;
  }

  async votePk(voterId, targetId) {
    if (this.gameState.phase !== GAME_PHASE.PK_VOTE) return "当前不是PK投票时间。";
    const voter = this.getPlayer(voterId);
    const target = this.getPlayer(targetId);

    if (!voter || !voter.isAlive) return "你已出局，无法投票。";
    if (!target || !target.isAlive || !this.gameState.pkPlayers.includes(targetId)) return "投票目标无效或不是PK候选人。";

    this.gameState.pkVotes[voterId] = targetId;
    this.gameLog.push({ type: 'pk_vote', day: this.gameState.day, voter: voter.info, target: target.info }); // 记录事件
    return `${voter.info} 在PK中投给了 ${target.info}。`;
  }

  async processPkVoteResults() {
    let events = [];
    const votes = this.gameState.pkVotes;
    const pkCandidateVotes = {};
    this.gameState.pkPlayers.forEach(candidateId => pkCandidateVotes[candidateId] = 0);

    for (const voterId in votes) {
      const targetId = votes[voterId];
      if (pkCandidateVotes[targetId] !== undefined) {
        pkCandidateVotes[targetId]++;
      }
    }

    let maxVotes = 0;
    let topCandidates = [];
    for (const candidateId in pkCandidateVotes) {
      if (pkCandidateVotes[candidateId] > maxVotes) {
        maxVotes = pkCandidateVotes[candidateId];
        topCandidates = [candidateId];
      } else if (pkCandidateVotes[candidateId] === maxVotes) {
        topCandidates.push(candidateId);
      }
    }

    if (topCandidates.length === 1) {
      const sheriff = this.getPlayer(topCandidates[0]);
      this.gameState.sheriffId = sheriff.userId;
      events.push({ type: 'group_message', content: `PK结果，警长是：${sheriff.info}！` });
      this.gameLog.push({ type: 'sheriff_elected_pk', day: this.gameState.day, sheriff: sheriff.info }); // 记录事件
      this.eventQueue.push({ event: GAME_PHASE.DAY_SPEAK });
    } else {
      events.push({ type: 'group_message', content: 'PK投票再次平票，本局仍无警长。直接进入白天发言阶段。' });
      this.gameLog.push({ type: 'no_sheriff_pk_tie', day: this.gameState.day }); // 记录事件
      this.eventQueue.push({ event: GAME_PHASE.DAY_SPEAK });
    }
    return events;
  }

  startDaySpeakPhase() {
    const events = [];
    this.gameState.speakingOrder = shuffleArray(this.getAlivePlayers().map(p => p.userId));
    // 如果有警长，警长第一个发言
    if (this.gameState.sheriffId && this.getAlivePlayers().some(p => p.userId === this.gameState.sheriffId)) {
        const sheriffIndex = this.gameState.speakingOrder.indexOf(this.gameState.sheriffId);
        if (sheriffIndex > -1) {
            const [sheriffId] = this.gameState.speakingOrder.splice(sheriffIndex, 1);
            this.gameState.speakingOrder.unshift(sheriffId);
        }
    }
    this.gameState.currentSpeakerIndex = -1; // 从-1开始，第一次调用 nextSpeaker 会变成0
    this.gameLog.push({ type: 'day_speak_start', day: this.gameState.day, order: this.gameState.speakingOrder.map(id => this.getPlayer(id).info) }); // 记录事件
    
    this.eventQueue.push({ event: 'next_speaker_trigger' }); // 立即触发第一个人发言
    return events;
  }

  async nextSpeaker() {
    let events = [];
    this.stopTimer(); // 停止当前发言计时器

    this.gameState.currentSpeakerIndex++;
    if (this.gameState.currentSpeakerIndex < this.gameState.speakingOrder.length) {
      const speakerId = this.gameState.speakingOrder[this.gameState.currentSpeakerIndex];
      const speaker = this.getPlayer(speakerId);
      if (speaker && speaker.isAlive) {
        events.push({ type: 'group_message', content: `现在是 ${speaker.info} 发言。` });
        this.gameLog.push({ type: 'speaker_change', day: this.gameState.day, speaker: speaker.info }); // 记录事件
        this.startTimer(GAME_PHASE.DAY_SPEAK, this.config.daySpeakDuration);
      } else {
        // 如果当前玩家已死亡，跳过并尝试下一个
        events.push({ type: 'group_message', content: `${speaker ? speaker.info : '一位玩家'} 已死亡，跳过发言。` });
        events.push(...(await this.nextSpeaker())); // 递归调用直到找到存活玩家或发言结束
      }
    } else {
      events.push({ type: 'group_message', content: '所有玩家发言完毕，进入投票环节。' });
      this.gameLog.push({ type: 'all_speak_end', day: this.gameState.day }); // 记录事件
      this.eventQueue.push({ event: GAME_PHASE.DAY_VOTE });
    }
    return events;
  }

  startVotePhase() {
    const events = [];
    this.gameState.votes = {}; // 清空投票
    this.gameLog.push({ type: 'day_vote_start', day: this.gameState.day }); // 记录事件
    events.push({ type: 'group_message', content: '现在是投票环节，请大家投票选出怀疑的玩家。' });
    this.startTimer(GAME_PHASE.DAY_VOTE, this.config.dayVoteDuration);
    return events;
  }

  async vote(voterId, targetId) {
    if (this.gameState.phase !== GAME_PHASE.DAY_VOTE && this.gameState.phase !== GAME_PHASE.PK_VOTE && this.gameState.phase !== GAME_PHASE.SHERIFF_VOTE) {
        return "当前不是投票时间。";
    }
    const voter = this.getPlayer(voterId);
    const target = this.getPlayer(targetId);

    if (!voter || !voter.isAlive) return "你已出局，无法投票。";
    if (!target || !target.isAlive) return "投票目标无效或已出局。";

    // 警长有双倍投票权
    const voteWeight = (this.gameState.sheriffId === voterId && voter.isAlive && this.gameState.phase === GAME_PHASE.DAY_VOTE) ? 2 : 1;

    this.gameState.votes[voterId] = { targetId: targetId, weight: voteWeight };
    this.gameLog.push({ type: 'vote', day: this.gameState.day, voter: voter.info, target: target.info, weight: voteWeight }); // 记录事件
    return `${voter.info} 投给了 ${target.info}。`;
  }

  async processVoteResults() {
    let events = [];
    const votes = this.gameState.votes;
    const candidateVotes = {};
    this.getAlivePlayers().forEach(p => candidateVotes[p.userId] = 0);

    for (const voterId in votes) {
      const { targetId, weight } = votes[voterId];
      if (candidateVotes[targetId] !== undefined) {
        candidateVotes[targetId] += weight;
      }
    }

    let maxVotes = 0;
    let topCandidates = [];
    for (const candidateId in candidateVotes) {
      if (candidateVotes[candidateId] > maxVotes) {
        maxVotes = candidateVotes[candidateId];
        topCandidates = [candidateId];
      } else if (candidateVotes[candidateId] === maxVotes) {
        topCandidates.push(candidateId);
      }
    }

    if (topCandidates.length === 1 && maxVotes > 0) {
      const executedPlayer = this.getPlayer(topCandidates[0]);
      events.push({ type: 'group_message', content: `投票结果：${executedPlayer.info} 被公投出局。` });
      this.gameLog.push({ type: 'player_executed', day: this.gameState.day, player: executedPlayer.info }); // 记录事件
      this.pendingDeaths.push(executedPlayer.userId);
      this.eventQueue.push({ event: GAME_PHASE.DAY_ANNOUNCEMENT }); // 进入白天公布阶段
    } else if (topCandidates.length > 1 && maxVotes > 0) {
      // 平票，进入 PK 环节
      const pkPlayerNames = topCandidates.map(id => this.getPlayer(id).info).join('，');
      events.push({ type: 'group_message', content: `投票平票，进入PK环节：${pkPlayerNames}。` });
      this.gameState.pkPlayers = topCandidates; // 设置PK玩家
      this.eventQueue.push({ event: GAME_PHASE.PK_VOTE, data: { pkPlayers: topCandidates } });
    } else {
      events.push({ type: 'group_message', content: '没有人被投票出局。进入夜晚。' });
      this.gameLog.push({ type: 'no_execution', day: this.gameState.day }); // 记录事件
      this.eventQueue.push({ event: GAME_PHASE.NIGHT_START });
    }
    return events;
  }

  startHunterShootPhase(data) {
    const events = [];
    const hunter = this.getPlayer(data.hunterId);
    if (hunter && hunter.isAlive && hunter.role.roleId === ROLES.HUNTER) {
      events.push({ type: 'private_message', userId: hunter.userId, content: '猎人请选择你的枪杀目标。' });
      this.gameLog.push({ type: 'hunter_shoot_start', day: this.gameState.day, hunter: hunter.info }); // 记录事件
    } else {
      // 猎人已死亡或无法开枪，继续下一个事件
      this.eventQueue.push({ event: GAME_PHASE.DAY_ANNOUNCEMENT }); // 重新进入白天公布阶段，处理其他死亡
    }
    return events;
  }

  async handleHunterShoot(hunterId, targetId) {
    if (this.gameState.phase !== GAME_PHASE.HUNTER_SHOOT) return "当前不是猎人开枪时间。";
    const hunter = this.getPlayer(hunterId);
    const target = this.getPlayer(targetId);

    if (!hunter || hunter.role.roleId !== ROLES.HUNTER || !hunter.hasTag(TAGS.HUNTER_CAN_SHOOT)) return "你不是猎人或无法开枪。";
    if (!target || !target.isAlive) return "目标无效或已出局。";

    this.pendingDeaths.push(target.userId);
    hunter.clearTemporaryTags(TAGS.HUNTER_CAN_SHOOT); // 猎人开枪后移除标记
    this.gameLog.push({ type: 'hunter_shoot', day: this.gameState.day, hunter: hunter.info, target: target.info }); // 记录事件

    this.eventQueue.push({ event: GAME_PHASE.DAY_ANNOUNCEMENT }); // 重新进入白天公布阶段，处理猎人击杀的死亡
    return `${hunter.info} 枪杀了 ${target.info}。`;
  }

  startLastWordsPhase(playerId) {
    const events = [];
    const player = this.getPlayer(playerId);
    if (player && !player.isAlive && player.role.canLeaveLastWords) {
      events.push({ type: 'group_message', content: `玩家 ${player.info} 请留遗言。` });
      this.gameLog.push({ type: 'last_words_start', day: this.gameState.day, player: player.info }); // 记录事件
      this.gameState.lastWordPlayerId = playerId;
      this.gameState.lastWordEndTime = Date.now() + this.config.lastWordDuration * 1000;
      this.startTimer(GAME_PHASE.LAST_WORDS, this.config.lastWordDuration);
    } else {
      // 无法留遗言，继续下一个事件
      this.eventQueue.push({ event: GAME_PHASE.DAY_ANNOUNCEMENT });
    }
    return events;
  }

  async handleLastWords(playerId, content) {
    if (this.gameState.phase !== GAME_PHASE.LAST_WORDS || this.gameState.lastWordPlayerId !== playerId) return "当前不是你留遗言的时间。";
    const player = this.getPlayer(playerId);
    if (!player) return "玩家不存在。";

    this.stopTimer(); // 停止遗言计时器
    events.push({ type: 'group_message', content: `${player.info} 的遗言：${content}` });
    this.gameLog.push({ type: 'last_words_content', day: this.gameState.day, player: player.info, content: content }); // 记录事件
    this.gameState.lastWordPlayerId = null;
    this.gameState.lastWordEndTime = null;
    this.eventQueue.push({ event: GAME_PHASE.DAY_ANNOUNCEMENT }); // 遗言结束后继续处理死亡
    return events;
  }

  startWolfKingClawPhase(wolfKingId, groupId) {
    const events = [];
    const wolfKing = this.getPlayer(wolfKingId);
    if (wolfKing && !wolfKing.isAlive && wolfKing.role.roleId === ROLES.WOLF_KING && wolfKing.hasTag(TAGS.WOLF_KING_CAN_CLAW)) {
      events.push({ type: 'private_message', userId: wolfKing.userId, content: '狼王请选择你的撕咬目标。' });
      this.gameLog.push({ type: 'wolf_king_claw_start', day: this.gameState.day, wolfKing: wolfKing.info }); // 记录事件
      this.gameState.wolfKingClawTargetId = null; // 重置目标
    } else {
      this.eventQueue.push({ event: GAME_PHASE.DAY_ANNOUNCEMENT }); // 狼王无法发动技能，继续处理死亡
    }
    return events;
  }

  async handleWolfKingClaw(wolfKingId, targetId) {
    if (this.gameState.phase !== GAME_PHASE.WOLF_KING_CLAW) return "当前不是狼王撕咬时间。";
    const wolfKing = this.getPlayer(wolfKingId);
    const target = this.getPlayer(targetId);

    if (!wolfKing || wolfKing.role.roleId !== ROLES.WOLF_KING || !wolfKing.hasTag(TAGS.WOLF_KING_CAN_CLAW)) return "你不是狼王或无法发动技能。";
    if (!target || !target.isAlive) return "目标无效或已出局。";

    this.pendingDeaths.push(target.userId);
    wolfKing.clearTemporaryTags(TAGS.WOLF_KING_CAN_CLAW); // 狼王发动技能后移除标记
    this.gameLog.push({ type: 'wolf_king_claw', day: this.gameState.day, wolfKing: wolfKing.info, target: target.info }); // 记录事件

    this.eventQueue.push({ event: GAME_PHASE.DAY_ANNOUNCEMENT }); // 重新进入白天公布阶段，处理狼王击杀的死亡
    return `${wolfKing.info} 撕咬了 ${target.info}。`;
  }

  startIdiotFlipPhase(idiotId, groupId) {
    const events = [];
    const idiot = this.getPlayer(idiotId);
    if (idiot && !idiot.isAlive && idiot.role.roleId === ROLES.IDIOT && idiot.hasTag(TAGS.IDIOT_CAN_FLIP)) {
      events.push({ type: 'group_message', content: `白痴 ${idiot.info} 翻牌！他将以白痴身份继续游戏。` });
      this.gameLog.push({ type: 'idiot_flip', day: this.gameState.day, idiot: idiot.info }); // 记录事件
      idiot.clearTemporaryTags(TAGS.IDIOT_CAN_FLIP); // 白痴翻牌后移除标记
      // 白痴翻牌后，他不再是出局状态，但失去了投票权
      idiot.isAlive = true; // 重新设置为存活
      idiot.addTag(TAGS.NO_VOTE); // 添加不能投票的标记
      this.eventQueue.push({ event: GAME_PHASE.DAY_ANNOUNCEMENT }); // 翻牌后继续处理死亡（如果没有其他死亡）
    } else {
      this.eventQueue.push({ event: GAME_PHASE.DAY_ANNOUNCEMENT }); // 白痴无法翻牌，继续处理死亡
    }
    return events;
  }

  checkGameEnd() {
    const alivePlayers = this.getAlivePlayers();
    const aliveWolves = alivePlayers.filter(p => WOLF_TEAM_ROLES.includes(p.role.roleId));
    const aliveGods = alivePlayers.filter(p => p.role.team === TEAMS.GOOD && p.role.roleId !== ROLES.VILLAGER);
    const aliveVillagers = alivePlayers.filter(p => p.role.roleId === ROLES.VILLAGER);
    const aliveGoodPeople = aliveGods.length + aliveVillagers.length;

    if (aliveWolves.length === 0) {
      return { isEnd: true, winner: TEAMS.GOOD, reason: '所有狼人出局，好人胜利。' };
    }

    if (aliveWolves.length >= aliveGoodPeople) {
      return { isEnd: true, winner: TEAMS.WOLF, reason: '狼人数量大于或等于好人数量，狼人胜利。' };
    }
    
    if (alivePlayers.length <= this.config.minPlayersForEnd) { // 玩家人数过少，游戏结束
      return { isEnd: true, winner: 'NONE', reason: '存活玩家人数过少，游戏无法继续。' };
    }

    return { isEnd: false };
  }

  // 游戏开始入口
  startGame(boardName) {
    // 1. 初始化游戏，分配角色
    const initResult = this.initializeGame(boardName);
    if (initResult.error) {
      return { error: initResult.error };
    }
    const initialEvents = initResult.events;

    // 2. 立即将游戏状态推进到夜晚开始阶段
    this.eventQueue.push({ event: GAME_PHASE.NIGHT_START });

    // 3. 处理事件队列，这会触发第一个阶段的事件和计时器
    // 注意：这里不直接 await processEventQueue，因为需要立即返回 initialEvents
    // processEventQueue 将由外部的 GameRoom 异步调用
    return { success: true, events: initialEvents };
  }

  // 序列化和反序列化
  serialize() {
    return {
      players: this.players.map(p => p.serialize()),
      gameState: this.gameState,
      eventQueue: this.eventQueue,
      pendingDeaths: this.pendingDeaths,
      gameLog: this.gameLog,
    };
  }

  static deserialize(data) {
    const engine = new GameEngine(data.players.map(pData => Player.deserialize(pData)));
    engine.gameState = data.gameState;
    engine.eventQueue = data.eventQueue;
    engine.pendingDeaths = data.pendingDeaths;
    engine.gameLog = data.gameLog;
    
    // 重新激活计时器（如果存在）
    if (engine.gameState.timerPhase && engine.gameState.timerEndTime) {
        const remainingTime = Math.max(0, Math.floor((engine.gameState.timerEndTime - Date.now()) / 1000));
        if (remainingTime > 0) {
            engine.startTimer(engine.gameState.timerPhase, remainingTime);
        } else {
            // 如果已经超时，则立即触发超时事件
            logger(`加载时发现计时器已超时，立即处理阶段：${engine.gameState.timerPhase}`);
            // 为了避免递归调用，这里不直接调用 processEventQueue，而是将事件推入队列等待外部触发
            engine.eventQueue.push({ event: 'timer_timeout_events', data: { events: [], groupId: engine.groupId } }); // groupId 需要从 GameRoom 传入
        }
    }
    return engine;
  }

  // 允许外部设置 groupId，主要用于 deserialize 后恢复 GameRoom 对 Engine 的引用
  setGroupId(groupId) {
    this.groupId = groupId;
  }

  // 调试和测试用
  getGameState() {
    return this.gameState;
  }

  getPlayersStatus() {
    return this.players.map(p => ({
      userId: p.userId,
      nickname: p.nickname,
      tempId: p.tempId,
      role: p.role ? p.role.name : '未分配',
      isAlive: p.isAlive,
      tags: p.tags,
      nightActionData: p.role ? p.role.nightActionData : null,
    }));
  }

  // 玩家操作
  async playerAction(userId, actionType, data) {
    const player = this.getPlayer(userId);
    if (!player) return { error: '玩家不存在。' };

    let message = '';
    let events = [];

    switch (actionType) {
      case 'nightAction':
        message = await this.handleNightAction(player, data);
        // 检查所有行动是否完成，如果完成则进入白天
        if (this.checkNightActionsComplete()) {
          events.push({ type: 'group_message', content: '所有玩家已完成夜晚行动。' });
          events.push(...(await this.processNightResults()));
        }
        break;
      case 'declareSheriffCandidate':
        message = await this.declareSheriffCandidate(userId);
        break;
      case 'voteSheriff':
        message = await this.voteSheriff(userId, data.targetId);
        // 检查是否所有人都投票了
        const alivePlayersCount = this.getAlivePlayers().length;
        const sheriffVotersCount = Object.keys(this.gameState.sheriffVotes).length;
        if (sheriffVotersCount >= alivePlayersCount) {
            events.push({ type: 'group_message', content: '所有存活玩家已完成警长投票。' });
            events.push(...(await this.processSheriffVoteResults()));
        }
        break;
      case 'vote':
        message = await this.vote(userId, data.targetId);
        // 检查是否所有人都投票了
        const currentVotersCount = Object.keys(this.gameState.votes).length;
        if (currentVotersCount >= this.getAlivePlayers().length) {
            events.push({ type: 'group_message', content: '所有存活玩家已完成投票。' });
            events.push(...(await this.processVoteResults()));
        }
        break;
      case 'hunterShoot':
        message = await this.handleHunterShoot(userId, data.targetId);
        break;
      case 'lastWords':
        events.push(...(await this.handleLastWords(userId, data.content)));
        message = '遗言已发送。';
        break;
      case 'wolfKingClaw':
        message = await this.handleWolfKingClaw(userId, data.targetId);
        break;
      case 'idiotFlip':
        events.push(...(await this.startIdiotFlipPhase(userId, this.groupId))); // 白痴翻牌是一个阶段转换
        message = '白痴已翻牌。';
        break;
      case 'nextSpeaker': // 仅用于调试或特殊指令
        events.push(...(await this.nextSpeaker()));
        message = '切换到下一位发言者。';
        break;
      case 'skipLastWords': // 跳过遗言
        if (this.gameState.phase === GAME_PHASE.LAST_WORDS && this.gameState.lastWordPlayerId === userId) {
            this.stopTimer();
            this.gameState.lastWordPlayerId = null;
            this.gameState.lastWordEndTime = null;
            this.eventQueue.push({ event: GAME_PHASE.DAY_ANNOUNCEMENT }); // 遗言结束后继续处理死亡
            message = '已跳过遗言。';
            events.push({ type: 'group_message', content: `${player.info} 跳过了遗言。` });
        } else {
            message = '当前无法跳过遗言。';
        }
        break;
      case 'skipSheriffElection': // 跳过警长竞选
        if (this.gameState.phase === GAME_PHASE.SHERIFF_ELECTION) {
            this.stopTimer();
            events.push({ type: 'group_message', content: '已跳过警长竞选。' });
            this.eventQueue.push({ event: GAME_PHASE.DAY_SPEAK }); // 直接进入白天发言
            message = '已跳过警长竞选。';
        } else {
            message = '当前无法跳过警长竞选。';
        }
        break;
      case 'forceSheriffVote': // 强制进入警长投票
        if (this.gameState.phase === GAME_PHASE.SHERIFF_ELECTION) {
            this.stopTimer();
            events.push({ type: 'group_message', content: '强制进入警上投票。' });
            events.push(...(await this.processSheriffVoteResults())); // 直接处理投票结果
            message = '强制进入警上投票。';
        } else {
            message = '当前无法强制进入警上投票。';
        }
        break;
      default:
        message = '未知行动类型。';
        break;
    }
    return { message, events };
  }
}

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
      // logger(`计时器超时：阶段 ${this.gameState.timerPhase}`); // 移除 logger，因为它可能未定义
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
      // logger('计时器已停止。'); // 移除 logger，因为它可能未定义
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
                player.addTag(TAGS.WOLF_KING_SELF_STAB, { sourceId: player.userId }); // 添加狼王自刀标签
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

    // 3. 处理死亡玩家
    // (此处省略了 processPendingDeaths 的内容，因为它在 transitionTo 中异步处理)

    return events;
  }

  async processPendingDeaths() {
    let events = [];
    if (this.pendingDeaths.length > 0) {
      for (const userId of this.pendingDeaths) {
        const player = this.getPlayer(userId);
        if (player && player.isAlive) {
          player.isAlive = false;
          events.push({ type: 'group_message', content: `${player.info} 死亡。` });
          this.gameLog.push({ type: 'player_death', day: this.gameState.day, player: player.info }); // 记录事件

          // 触发角色的 onDeath 钩子
          const deathEvent = player.role.onDeath(this, player);
          if (deathEvent) {
            // 如果是猎人开枪事件，则进入猎人开枪阶段
            if (deathEvent.event === GAME_PHASE.HUNTER_SHOOT) {
              this.eventQueue.unshift(deathEvent); // 优先处理猎人开枪
            } else {
              events.push(deathEvent);
            }
          }
        }
      }
      this.pendingDeaths = []; // 清空待处理死亡列表
    }

    // 检查游戏是否结束
    const checkResult = this.checkGameEnd();
    if (checkResult.isEnded) {
      events.push({ type: 'game_end', winner: checkResult.winner });
      this.gameLog.push({ type: 'game_end', day: this.gameState.day, winner: checkResult.winner }); // 记录事件
      return events;
    }

    // 如果没有特殊事件，进入警长竞选或白天发言
    if (!this.eventQueue.some(e => e.event === GAME_PHASE.HUNTER_SHOOT || e.event === GAME_PHASE.WOLF_KING_CLAW || e.event === GAME_PHASE.IDIOT_FLIP)) {
        if (this.gameState.day === 1) { // 第一天进入警长竞选
            events.push({ type: 'group_message', content: '进入警长竞选阶段。' });
            this.eventQueue.push({ event: GAME_PHASE.SHERIFF_ELECTION });
        } else {
            events.push({ type: 'group_message', content: '进入白天发言阶段。' });
            this.eventQueue.push({ event: GAME_PHASE.DAY_SPEAK });
        }
    }
    
    return events;
  }

  startSheriffElection() {
    let events = [{ type: 'group_message', content: '警长竞选开始。请想竞选警长的玩家发送 "上警"。' }];
    this.gameState.sheriffCandidates = []; // 清空候选人列表
    this.gameState.sheriffVotes = {}; // 清空警长投票
    this.players.forEach(p => p.clearTemporaryTags(TAGS.CANDIDATE)); // 清除上警标签
    return events;
  }

  handleSheriffElect(player) {
    if (this.gameState.phase !== GAME_PHASE.SHERIFF_ELECTION) return "当前不是警长竞选阶段。";
    if (!player.isAlive) return "你已死亡，无法竞选警长。";
    if (this.gameState.sheriffCandidates.includes(player.userId)) return "你已经上警了。";

    this.gameState.sheriffCandidates.push(player.userId);
    player.addTag(TAGS.CANDIDATE);
    this.gameLog.push({ type: 'sheriff_candidate', day: this.gameState.day, player: player.info }); // 记录事件
    return `${player.info} 已上警。`;
  }

  startSheriffVote() {
    let events = [];
    if (this.gameState.sheriffCandidates.length === 0) {
      events.push({ type: 'group_message', content: '无人上警，本局无警长。游戏进入白天发言阶段。' });
      this.gameLog.push({ type: 'no_sheriff', day: this.gameState.day }); // 记录事件
      this.eventQueue.push({ event: GAME_PHASE.DAY_SPEAK });
    } else if (this.gameState.sheriffCandidates.length === 1) {
      const sheriffId = this.gameState.sheriffCandidates[0];
      this.gameState.sheriffId = sheriffId;
      events.push({ type: 'group_message', content: `${this.getPlayer(sheriffId).info} 自动当选警长。游戏进入白天发言阶段。` });
      this.gameLog.push({ type: 'sheriff_auto_elected', day: this.gameState.day, sheriff: this.getPlayer(sheriffId).info }); // 记录事件
      this.eventQueue.push({ event: GAME_PHASE.DAY_SPEAK });
    } else {
      events.push({ type: 'group_message', content: `警长竞选者：${this.gameState.sheriffCandidates.map(id => this.getPlayer(id).info).join('，')}。请大家进行警上投票。` });
      this.gameState.sheriffCandidates.forEach(candidateId => {
        this.gameState.sheriffVotes[candidateId] = 0; // 初始化票数
      });
    }
    return events;
  }

  handleSheriffVote(voter, target) {
    if (this.gameState.phase !== GAME_PHASE.SHERIFF_VOTE) return "当前不是警上投票阶段。";
    if (!voter.isAlive) return "你已死亡，无法投票。";
    if (!this.gameState.sheriffCandidates.includes(target.userId)) return "你投票的目标不是警长候选人。";

    this.gameState.sheriffVotes[target.userId] = (this.gameState.sheriffVotes[target.userId] || 0) + 1;
    this.gameLog.push({ type: 'sheriff_vote', day: this.gameState.day, voter: voter.info, target: target.info }); // 记录事件
    return `你已投票给 ${target.info}。`;
  }

  async processSheriffVoteResults() {
    let events = [];
    let maxVotes = 0;
    let electedSheriffId = null;
    let tieCandidates = [];

    for (const candidateId in this.gameState.sheriffVotes) {
      const votes = this.gameState.sheriffVotes[candidateId];
      if (votes > maxVotes) {
        maxVotes = votes;
        electedSheriffId = candidateId;
        tieCandidates = [candidateId];
      } else if (votes === maxVotes) {
        tieCandidates.push(candidateId);
      }
    }

    if (tieCandidates.length > 1) {
      // 平票，进行 PK 投票
      events.push({ type: 'group_message', content: `警长竞选出现平票：${tieCandidates.map(id => this.getPlayer(id).info).join('，')}。进入 PK 投票阶段。` });
      this.gameLog.push({ type: 'sheriff_vote_tie', day: this.gameState.day, candidates: tieCandidates.map(id => this.getPlayer(id).info) }); // 记录事件
      this.eventQueue.push({ event: GAME_PHASE.PK_VOTE, data: { pkPlayers: tieCandidates } });
    } else if (electedSheriffId) {
      this.gameState.sheriffId = electedSheriffId;
      events.push({ type: 'group_message', content: `${this.getPlayer(electedSheriffId).info} 当选警长。` });
      this.gameLog.push({ type: 'sheriff_elected', day: this.gameState.day, sheriff: this.getPlayer(electedSheriffId).info }); // 记录事件
      // 警长发言
      events.push({ type: 'group_message', content: `警长 ${this.getPlayer(electedSheriffId).info} 请发言。` });
      this.startTimer(GAME_PHASE.DAY_SPEAK, this.config.sheriffSpeakDuration); // 警长有单独的发言时间
    } else {
      events.push({ type: 'group_message', content: '警长竞选无人当选。' });
      this.gameLog.push({ type: 'sheriff_no_one', day: this.gameState.day }); // 记录事件
    }

    // 无论是谁当选，都进入白天发言阶段
    this.eventQueue.push({ event: GAME_PHASE.DAY_SPEAK });
    return events;
  }

  startDaySpeakPhase() {
    let events = [{ type: 'group_message', content: '白天发言阶段开始。' }];
    // 确定发言顺序
    this.gameState.speakingOrder = this.getAlivePlayers().map(p => p.userId);
    if (this.gameState.sheriffId) {
      // 警长优先发言，然后按座位号从小到大
      const sheriffIndex = this.gameState.speakingOrder.indexOf(this.gameState.sheriffId);
      if (sheriffIndex > -1) {
        this.gameState.speakingOrder.splice(sheriffIndex, 1); // 移除警长
      }
      this.gameState.speakingOrder.sort((a, b) => this.getPlayer(a).tempId - this.getPlayer(b).tempId); // 按座位号排序
      this.gameState.speakingOrder.unshift(this.gameState.sheriffId); // 警长放第一位
    } else {
      // 无警长则按座位号从小到大
      this.gameState.speakingOrder.sort((a, b) => this.getPlayer(a).tempId - this.getPlayer(b).tempId);
    }
    this.gameState.currentSpeakerIndex = -1; // 准备开始发言
    this.gameLog.push({ type: 'day_speak_start', day: this.gameState.day, order: this.gameState.speakingOrder.map(id => this.getPlayer(id).info) }); // 记录事件
    this.eventQueue.push({ event: 'next_speaker_request' }); // 触发第一个玩家发言
    return events;
  }

  async nextSpeaker() {
    let events = [];
    this.gameState.currentSpeakerIndex++;
    if (this.gameState.currentSpeakerIndex < this.gameState.speakingOrder.length) {
      const speakerId = this.gameState.speakingOrder[this.gameState.currentSpeakerIndex];
      const speaker = this.getPlayer(speakerId);
      if (speaker && speaker.isAlive) {
        events.push({ type: 'group_message', content: `${speaker.info} 请发言。` });
        this.gameLog.push({ type: 'player_speak', day: this.gameState.day, player: speaker.info }); // 记录事件
        this.startTimer(GAME_PHASE.DAY_SPEAK, this.config.daySpeakDuration);
      } else {
        // 玩家已死亡，跳过
        events.push({ type: 'group_message', content: `${speaker.info} 已死亡，跳过其发言。` });
        events.push(...(await this.nextSpeaker())); // 递归调用，直到找到下一个活着的玩家或结束
      }
    } else {
      // 所有人都发言完毕，进入投票阶段
      events.push({ type: 'group_message', content: '所有玩家发言完毕，进入放逐投票阶段。' });
      this.gameLog.push({ type: 'day_speak_end', day: this.gameState.day }); // 记录事件
      this.eventQueue.push({ event: GAME_PHASE.DAY_VOTE });
    }
    return events;
  }

  startVotePhase() {
    let events = [];
    events.push({ type: 'group_message', content: '放逐投票阶段开始。请发送 "投票 [号码]" 来投票。' });
    this.gameState.votes = {}; // 清空投票
    return events;
  }

  handleVote(voter, target) {
    if (this.gameState.phase !== GAME_PHASE.DAY_VOTE && this.gameState.phase !== GAME_PHASE.PK_VOTE) return "当前不是投票阶段。";
    if (!voter.isAlive) return "你已死亡，无法投票。";
    if (!target.isAlive) return `${target.info} 已死亡，无法投票给他。`;
    if (voter.userId === target.userId) return "你不能投票给自己。"; // 避免自刀

    this.gameState.votes[voter.userId] = target.userId;
    this.gameLog.push({ type: 'player_vote', day: this.gameState.day, voter: voter.info, target: target.info }); // 记录事件
    return `你已投票给 ${target.info}。`;
  }

  async processVoteResults() {
    let events = [];
    const voteCounts = {};
    const alivePlayers = this.getAlivePlayers();

    // 统计票数
    alivePlayers.forEach(player => {
      const targetId = this.gameState.votes[player.userId];
      if (targetId) {
        voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
      }
    });

    let maxVotes = 0;
    let votedPlayerId = null;
    let tiePlayers = [];

    for (const playerId in voteCounts) {
      const votes = voteCounts[playerId];
      if (votes > maxVotes) {
        maxVotes = votes;
        votedPlayerId = playerId;
        tiePlayers = [playerId];
      } else if (votes === maxVotes) {
        tiePlayers.push(playerId);
      }
    }

    if (tiePlayers.length > 1) {
      // 平票，进入 PK 投票
      events.push({ type: 'group_message', content: `放逐投票出现平票：${tiePlayers.map(id => this.getPlayer(id).info).join('，')}。进入 PK 投票阶段。` });
      this.gameLog.push({ type: 'vote_tie', day: this.gameState.day, players: tiePlayers.map(id => this.getPlayer(id).info) }); // 记录事件
      this.eventQueue.push({ event: GAME_PHASE.PK_VOTE, data: { pkPlayers: tiePlayers } });
    } else if (votedPlayerId) {
      const votedPlayer = this.getPlayer(votedPlayerId);
      events.push({ type: 'group_message', content: `${votedPlayer.info} 被放逐出局。` });
      this.gameLog.push({ type: 'player_exiled', day: this.gameState.day, player: votedPlayer.info }); // 记录事件
      this.pendingDeaths.push(votedPlayerId); // 加入待处理死亡列表

      // 触发被投票出局的角色的 onVoteOut 钩子
      const onVoteOutEvent = votedPlayer.role.onVoteOut(this, votedPlayer);
      if (onVoteOutEvent) {
          // 如果是白痴翻牌事件，则进入白痴翻牌阶段
          if (onVoteOutEvent.event === GAME_PHASE.IDIOT_FLIP) {
              this.eventQueue.unshift(onVoteOutEvent); // 优先处理白痴翻牌
          } else {
              events.push(onVoteOutEvent); // 其他事件，例如狼王自爆（这里不处理，由狼王主动触发）
          }
      }
      this.eventQueue.push({ event: GAME_PHASE.DAY_ANNOUNCEMENT }); // 重新进入白天公布阶段，处理死亡
    } else {
      events.push({ type: 'group_message', content: '无人被放逐。' });
      this.gameLog.push({ type: 'no_exile', day: this.gameState.day }); // 记录事件
      // 如果无人被放逐，直接进入夜晚
      this.eventQueue.push({ event: GAME_PHASE.NIGHT_START });
    }
    return events;
  }

  startPkVotePhase(pkPlayers) {
    let events = [];
    this.gameState.pkPlayers = pkPlayers;
    this.gameState.pkVotes = {}; // 清空 PK 投票
    events.push({ type: 'group_message', content: `进入 PK 投票阶段，请在 ${pkPlayers.map(id => this.getPlayer(id).info).join('，')} 中选择一人投票。` });
    this.startTimer(GAME_PHASE.PK_VOTE, this.config.pkVoteDuration);
    return events;
  }

  async processPkVoteResults() {
    let events = [];
    const pkVoteCounts = {};
    const alivePlayers = this.getAlivePlayers();

    // 统计 PK 票数
    alivePlayers.forEach(player => {
      const targetId = this.gameState.votes[player.userId]; // PK 投票也使用 gameState.votes
      if (targetId && this.gameState.pkPlayers.includes(targetId)) {
        pkVoteCounts[targetId] = (pkVoteCounts[targetId] || 0) + 1;
      }
    });

    let maxVotes = 0;
    let votedPlayerId = null;
    let tiePlayers = [];

    for (const playerId in pkVoteCounts) {
      const votes = pkVoteCounts[playerId];
      if (votes > maxVotes) {
        maxVotes = votes;
        votedPlayerId = playerId;
        tiePlayers = [playerId];
      } else if (votes === maxVotes) {
        tiePlayers.push(playerId);
      }
    }

    if (tiePlayers.length > 1) {
      // PK 再次平票，处理方式：例如再次 PK，或无人出局
      events.push({ type: 'group_message', content: `PK 投票再次平票：${tiePlayers.map(id => this.getPlayer(id).info).join('，')}。无人出局。` });
      this.gameLog.push({ type: 'pk_vote_tie', day: this.gameState.day, players: tiePlayers.map(id => this.getPlayer(id).info) }); // 记录事件
      this.eventQueue.push({ event: GAME_PHASE.NIGHT_START }); // 直接进入夜晚
    } else if (votedPlayerId) {
      const votedPlayer = this.getPlayer(votedPlayerId);
      events.push({ type: 'group_message', content: `${votedPlayer.info} 在 PK 投票中被放逐出局。` });
      this.gameLog.push({ type: 'player_exiled_pk', day: this.gameState.day, player: votedPlayer.info }); // 记录事件
      this.pendingDeaths.push(votedPlayerId); // 加入待处理死亡列表

      // 触发被投票出局的角色的 onVoteOut 钩子
      const onVoteOutEvent = votedPlayer.role.onVoteOut(this, votedPlayer);
      if (onVoteOutEvent) {
          if (onVoteOutEvent.event === GAME_PHASE.IDIOT_FLIP) {
              this.eventQueue.unshift(onVoteOutEvent);
          } else {
              events.push(onVoteOutEvent);
          }
      }
      this.eventQueue.push({ event: GAME_PHASE.DAY_ANNOUNCEMENT }); // 重新进入白天公布阶段，处理死亡
    } else {
      events.push({ type: 'group_message', content: 'PK 投票无人出局。' });
      this.gameLog.push({ type: 'pk_vote_no_one', day: this.gameState.day }); // 记录事件
      this.eventQueue.push({ event: GAME_PHASE.NIGHT_START }); // 直接进入夜晚
    }
    this.gameState.pkPlayers = []; // 清空 PK 列表
    return events;
  }

  startHunterShootPhase(data) {
    let events = [];
    const hunter = this.getPlayer(data.shooterId);
    if (!hunter || !hunter.isAlive) {
      return [{ type: 'group_message', content: '猎人已死亡或无法开枪。' }];
    }
    events.push({ type: 'group_message', content: `${hunter.info} 是猎人，他选择开枪。请他发送 "开枪 [号码]"。` });
    this.gameLog.push({ type: 'hunter_shoot_prompt', day: this.gameState.day, hunter: hunter.info }); // 记录事件
    this.gameState.wolfKingClawTargetId = hunter.userId; // 记录猎人ID，等待其操作
    return events;
  }

  handleHunterShoot(hunter, target) {
    if (this.gameState.phase !== GAME_PHASE.HUNTER_SHOOT || this.gameState.wolfKingClawTargetId !== hunter.userId) {
      return "当前不是猎人开枪阶段。";
    }
    if (!hunter.isAlive) return "你已死亡，无法开枪。";
    if (!target.isAlive) return `${target.info} 已死亡，无法开枪。`;
    if (hunter.userId === target.userId) return "你不能开枪自杀。"; // 避免自杀

    this.pendingDeaths.push(target.userId); // 加入待处理死亡列表
    this.gameLog.push({ type: 'hunter_shoot', day: this.gameState.day, hunter: hunter.info, target: target.info }); // 记录事件
    this.gameState.wolfKingClawTargetId = null; // 清空
    this.eventQueue.push({ event: GAME_PHASE.DAY_ANNOUNCEMENT }); // 重新进入白天公布阶段，处理死亡
    return `${hunter.info} 对 ${target.info} 开枪了。`;
  }

  startLastWordsPhase(playerId) {
    let events = [];
    const player = this.getPlayer(playerId);
    if (player && player.isAlive) { // 只有活着的玩家才能留遗言
      events.push({ type: 'group_message', content: `${player.info} 请留遗言。` });
      this.gameState.lastWordPlayerId = playerId;
      this.gameState.lastWordEndTime = Date.now() + this.config.lastWordDuration * 1000;
      this.gameLog.push({ type: 'last_words_start', day: this.gameState.day, player: player.info }); // 记录事件
      this.startTimer(GAME_PHASE.LAST_WORDS, this.config.lastWordDuration);
    } else {
      // 玩家已死亡，直接进入夜晚
      events.push({ type: 'group_message', content: '无人留遗言。' });
      this.gameLog.push({ type: 'no_last_words', day: this.gameState.day }); // 记录事件
      this.eventQueue.push({ event: GAME_PHASE.NIGHT_START });
    }
    return events;
  }

  handleLastWords(player, content) {
    if (this.gameState.phase !== GAME_PHASE.LAST_WORDS || this.gameState.lastWordPlayerId !== player.userId) {
      return "当前不是你留遗言的时间。";
    }
    this.gameLog.push({ type: 'last_words_content', day: this.gameState.day, player: player.info, content: content }); // 记录遗言内容
    this.stopTimer(); // 遗言结束，停止计时器
    this.gameState.lastWordPlayerId = null;
    this.gameState.lastWordEndTime = null;
    this.eventQueue.push({ event: GAME_PHASE.NIGHT_START }); // 遗言结束后进入夜晚
    return `你已留下遗言。`;
  }

  startWolfKingClawPhase(wolfKingId, groupId) {
    let events = [];
    const wolfKing = this.getPlayer(wolfKingId);
    if (!wolfKing || !wolfKing.isAlive) {
      return [{ type: 'group_message', content: '狼王已死亡或无法发动技能。' }];
    }
    events.push({ type: 'group_message', content: `${wolfKing.info} 是狼王，他选择发动狼王爪。请他发送 "狼王爪 [号码]"。` });
    this.gameLog.push({ type: 'wolf_king_claw_prompt', day: this.gameState.day, wolfKing: wolfKing.info }); // 记录事件
    this.gameState.wolfKingClawTargetId = wolfKingId; // 记录狼王ID，等待其操作
    return events;
  }

  handleWolfKingClaw(wolfKing, target) {
    if (this.gameState.phase !== GAME_PHASE.WOLF_KING_CLAW || this.gameState.wolfKingClawTargetId !== wolfKing.userId) {
      return "当前不是你发动狼王爪的时间。";
    }
    if (!wolfKing.isAlive) return "你已死亡，无法发动狼王爪。";
    if (!target.isAlive) return `${target.info} 已死亡，无法发动狼王爪。`;
    if (wolfKing.userId === target.userId) return "你不能对自己发动狼王爪。";

    this.pendingDeaths.push(target.userId); // 加入待处理死亡列表
    this.gameLog.push({ type: 'wolf_king_claw', day: this.gameState.day, wolfKing: wolfKing.info, target: target.info }); // 记录事件
    this.gameState.wolfKingClawTargetId = null; // 清空
    this.eventQueue.push({ event: GAME_PHASE.DAY_ANNOUNCEMENT }); // 重新进入白天公布阶段，处理死亡
    return `${wolfKing.info} 对 ${target.info} 发动了狼王爪。`;
  }

  startIdiotFlipPhase(idiotId, groupId) {
    let events = [];
    const idiot = this.getPlayer(idiotId);
    if (!idiot || !idiot.isAlive) {
      return [{ type: 'group_message', content: '白痴已死亡或无法翻牌。' }];
    }
    events.push({ type: 'group_message', content: `${idiot.info} 是白痴，他选择翻牌。他将继续留在场上，但失去投票权。` });
    idiot.addTag(TAGS.REVEALED_IDIOT); // 添加白痴翻牌标签
    idiot.addTag(TAGS.IDIOT_FLIPPED); // 新增白痴已翻牌标签
    this.gameLog.push({ type: 'idiot_flip', day: this.gameState.day, idiot: idiot.info }); // 记录事件
    this.eventQueue.push({ event: GAME_PHASE.DAY_ANNOUNCEMENT }); // 返回白天公布阶段
    return events;
  }

  // --- 游戏结束判定 ---
  checkGameEnd() {
    const alivePlayers = this.getAlivePlayers();
    const goodPlayers = alivePlayers.filter(p => p.role.team === TEAMS.GOOD);
    const wolfPlayers = alivePlayers.filter(p => p.role.team === TEAMS.WOLF);

    if (wolfPlayers.length === 0) {
      return { isEnded: true, winner: TEAMS.GOOD }; // 狼人全部出局，好人胜利
    }
    if (wolfPlayers.length >= goodPlayers.length) {
      return { isEnded: true, winner: TEAMS.WOLF }; // 狼人数量大于等于好人数量，狼人胜利
    }
    if (goodPlayers.length === 0) { // 所有好人出局，狼人胜利
      return { isEnded: true, winner: TEAMS.WOLF };
    }
    return { isEnded: false };
  }

  // --- 游戏日志 ---
  getGameLog() {
    return this.gameLog;
  }

  // --- 玩家操作指令处理 (由 GameRoom 调用) ---
  
  // 示例：玩家发送 "行动 目标"
  // GameRoom 会解析指令，然后调用 GameEngine 的对应方法
  // 例如：gameEngine.handleNightAction(player, { actionType: 'kill', target: targetPlayer });
}

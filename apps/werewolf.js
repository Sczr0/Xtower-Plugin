// apps/werewolf.js
import plugin from '../../../lib/plugins/plugin.js';
import { GameRoom } from '../model/werewolf/GameRoom.js';
import { logger } from '../model/werewolf/utils.js';
import { PLUGIN_NAME, GAME_PHASE, GAME_STATUS, ROLES } from '../model/werewolf/constants.js'; // 导入 GAME_STATUS, ROLES
import werewolfConfig from '../model/werewolf/config.js'; // 导入狼人杀配置

export class WerewolfPlugin extends plugin {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: '重构后的狼人杀插件',
      event: 'message',
      priority: 50,
      rule: [
        { reg: '^#创建狼人杀(?:\\s+(.*))?$', fnc: 'createGame' },
        { reg: '^#加入狼人杀$', fnc: 'joinGame' },
        { reg: '^#开始狼人杀$', fnc: 'startGame' },
        { reg: '^#结束狼人杀$', fnc: 'endGame' },
        { reg: '^#(杀|刀|查验|救|毒|守)\\s*(\\d+)$', fnc: 'handleNightAction', permission: 'private' },
        { reg: '^#(狼聊|w)\\s+(.*)$', fnc: 'handleWolfChat', permission: 'private' },
        { reg: '^#投票\\s*(\\d+)$', fnc: 'handleVote', permission: 'private' },
        { reg: '^#(?:过|发言结束)$', fnc: 'handleEndTurn' },
        { reg: '^#上警$', fnc: 'handleSheriffElect', permission: 'private' },
        { reg: '^#退水$', fnc: 'handleSheriffWithdraw', permission: 'private' },
        { reg: '^#警上投票\\s*(\\d+)$', fnc: 'handleSheriffVote', permission: 'private' },
        { reg: '^#开枪\\s*(\\d+)$', fnc: 'handleHunterShoot', permission: 'private' },
        { reg: '^#遗言\\s*(.*)$', fnc: 'handleLastWord', permission: 'private' }, // 新增遗言命令
        { reg: '^#PK投票\\s*(\\d+)$', fnc: 'handlePkVote', permission: 'private' }, // 新增PK投票命令
        { reg: '^#自爆(?:\\s*(\\d+))?$', fnc: 'handleSelfExplode', permission: 'private' }, // 新增自爆命令
        { reg: '^#狼王爪\\s*(\\d+)$', fnc: 'handleWolfKingClaw', permission: 'private' }, // 狼王爪命令
      ],
    });
  }

  /**
   * 辅助函数：加载游戏房间并进行通用检查
   * @param {object} e 事件对象
   * @param {object} options 检查选项
   * @param {boolean} options.loadByUserId 是否通过用户ID加载房间
   * @param {boolean} options.checkGroup 是否检查是否在群聊中
   * @param {boolean} options.checkRoomExists 是否检查房间是否存在
   * @param {boolean} options.checkHost 是否检查是否为房主
   * @param {string} options.checkPhase 期望的游戏阶段
   * @param {string} options.checkStatus 期望的游戏状态
   * @returns {GameRoom|null} 游戏房间实例或null
   */
  async getGameRoomAndCheck(e, options = {}) {
    let room;
    if (options.loadByUserId) {
      room = await GameRoom.loadByUserId(e.user_id);
    } else {
      if (options.checkGroup && !e.isGroup) {
        e.reply('请在群聊中操作。');
        return null;
      }
      room = await GameRoom.load(e.group_id);
    }

    if (options.checkRoomExists && !room) {
      e.reply('本群没有狼人杀游戏，请先创建。');
      return null;
    }

    if (options.checkHost && room && e.user_id !== room.hostId) {
      e.reply('只有房主才能执行此操作。');
      return null;
    }

    if (options.checkPhase && room && (!room.engine || room.engine.gameState.phase !== options.checkPhase)) {
        e.reply(`当前不是${options.checkPhase}阶段。`);
        return null;
    }

    if (options.checkStatus && room && room.status !== options.checkStatus) {
        e.reply(`游戏状态不正确，当前状态为 ${room.status}。`);
        return null;
    }
    return room;
  }

  // --- 命令处理函数 ---

  async createGame(e) {
    const room = await this.getGameRoomAndCheck(e, { checkGroup: true });
    
    if (room && room.status !== GAME_STATUS.ENDED) { // 检查是否已有进行中或等待中的游戏
      return e.reply('本群已有正在进行或等待中的游戏。');
    }
    
    // 获取板子名称
    const boardName = e.msg.replace(/^#创建狼人杀\s*/, '').trim() || '预女猎守';
    
    const newRoom = await GameRoom.create(e.group_id, e.user_id, e.sender.card);
    newRoom.boardName = boardName; // 设置板子名称
    await newRoom.save(); // 保存板子名称
    
    return e.reply(`狼人杀房间创建成功！\n板子：【${boardName}】\n发送 #加入狼人杀 加入游戏。`);
  }

  async joinGame(e) {
    // GameRoom.addPlayer 内部已包含加载最新房间数据和乐观锁重试
    const room = await this.getGameRoomAndCheck(e, { checkGroup: true, checkRoomExists: true });
    if (!room) return;
    
    const result = await room.addPlayer(e.user_id, e.sender.card);
    return e.reply(result.message, true);
  }

  async startGame(e) {
    // GameRoom.startGame 内部已包含加载最新房间数据和乐观锁重试
    const room = await this.getGameRoomAndCheck(e, { checkGroup: true, checkRoomExists: true, checkHost: true });
    if (!room) return;

    const result = await room.startGame(room.boardName || '预女猎守');
    if (result.error) {
      logger.error(`startGame 失败: ${result.error}, groupId: ${e.group_id}, userId: ${e.user_id}`);
      return e.reply(`开始游戏失败：${result.error}`);
    }

    await this.processEvents(e, result.events);
  }

  async endGame(e) {
    // 重新加载最新房间数据以确保操作基于最新状态
    let room = await this.getGameRoomAndCheck(e, { checkGroup: true, checkRoomExists: true });
    if (!room) return;
    
    const canEnd = e.user_id === room.hostId || e.isMaster || (e.member && (e.member.is_admin || e.member.is_owner));
    if (!canEnd) {
      return e.reply('只有房主、群管理员或主人才能强制结束游戏。');
    }
    
    await room.cleanup(); 
    
    return e.reply('游戏已由管理员强制结束。');
 }

 async handleNightAction(e) {
  // 重新加载最新房间数据以确保操作基于最新状态
  let room = await this.getGameRoomAndCheck(e, { loadByUserId: true, checkPhase: GAME_PHASE.NIGHT_START });
  if (!room) return;
  const engine = room.engine;

  const player = engine.getPlayer(e.user_id);
  const match = e.msg.match(/#(杀|刀|查验|救|毒|守)\\s*(\\d+)/);
  if (!match) return e.reply('指令格式不正确，请发送 #杀/刀/查验/救/毒/守 [玩家编号]');

  const target = engine.getPlayerByTempId(match[2]);
  if (!target) {
      return e.reply(`编号 ${match[2]} 的玩家不存在。`);
  }
  const actionData = { target, actionType: match[1] };

  const message = await engine.handleAction(player, actionData);
  if (message) {
    logger.warn(`handleNightAction 消息: ${message}, userId: ${e.user_id}`); // 或 error, 取决于 message 内容
    e.reply(message);
  }
  
  await room.save(); // save 内部有乐观锁
  
  if (engine.checkNightActionsComplete()) {
    const events = await engine.processNightResults();
    await room.save(); // save 内部有乐观锁
    await this.processEvents(e, events, room.groupId);
  }
}
 
async handleVote(e) {
    // 重新加载最新房间数据以确保操作基于最新状态
    let room = await this.getGameRoomAndCheck(e, { loadByUserId: true, checkPhase: GAME_PHASE.DAY_VOTE });
    if (!room) return;
    const engine = room.engine;
    const match = e.msg.match(/#投票\\s*(\\d+)/);
    if (!match) return e.reply('指令格式不正确，请发送 #投票 [玩家编号]');
    const targetTempId = match[1];
    const result = engine.handleVote(e.user_id, targetTempId);

    if (!result.success) {
        logger.warn(`handleVote 失败: ${result.message}, userId: ${e.user_id}`);
        return e.reply(result.message);
    }
    
    await e.reply(result.message);
    await room.save(); // save 内部有乐观锁

    if (engine.checkAllVoted()) {
        const events = await engine.processVoteResults();
        await room.save(); // save 内部有乐观锁
        await this.processEvents(e, events, room.groupId);
    }
}

async handleEndTurn(e) {
    // 重新加载最新房间数据以确保操作基于最新状态
    let room = await this.getGameRoomAndCheck(e, { checkGroup: true, checkPhase: GAME_PHASE.DAY_SPEAK });
    if (!room) return;
    const engine = room.engine;
    const { speakingOrder, currentSpeakerIndex } = engine.gameState;
    const currentSpeakerId = speakingOrder[currentSpeakerIndex];

    if (e.user_id !== currentSpeakerId) {
        return e.reply('还没轮到你发言哦。', true);
    }

    const events = await engine.nextSpeaker();
    await room.save(); // save 内部有乐观锁
    await this.processEvents(e, events, room.groupId);
}

async handleSheriffElect(e) {
    // 重新加载最新房间数据以确保操作基于最新状态
    let room = await this.getGameRoomAndCheck(e, { checkGroup: true, checkPhase: GAME_PHASE.SHERIFF_ELECTION });
    if (!room) return;
    const engine = room.engine;
    const result = engine.electSheriff(e.user_id);
    if (!result.success) {
        logger.warn(`handleSheriffElect 失败: ${result.message}, userId: ${e.user_id}`);
        return e.reply(result.message);
    }
    await e.reply(result.message);
    await room.save(); // save 内部有乐观锁
}

async handleSheriffWithdraw(e) {
    // 重新加载最新房间数据以确保操作基于最新状态
    let room = await this.getGameRoomAndCheck(e, { checkGroup: true, checkPhase: GAME_PHASE.SHERIFF_ELECTION });
    if (!room) return;
    const engine = room.engine;
    const result = engine.withdrawSheriff(e.user_id);
    if (!result.success) {
        logger.warn(`handleSheriffWithdraw 失败: ${result.message}, userId: ${e.user_id}`);
        return e.reply(result.message);
    }
    await e.reply(result.message);
    await room.save(); // save 内部有乐观锁
}

async handleSheriffVote(e) {
    // 重新加载最新房间数据以确保操作基于最新状态
    let room = await this.getGameRoomAndCheck(e, { loadByUserId: true, checkPhase: GAME_PHASE.SHERIFF_VOTE });
    if (!room) return;
    const engine = room.engine;
    const match = e.msg.match(/#警上投票\\s*(\\d+)/);
    if (!match) return e.reply('指令格式不正确，请发送 #警上投票 [玩家编号]');

    const targetTempId = match[1];
    const result = engine.handleSheriffVote(e.user_id, targetTempId);

    if (!result.success) {
        logger.warn(`handleSheriffVote 失败: ${result.message}, userId: ${e.user_id}`);
        return e.reply(result.message);
    }
    
    await e.reply(result.message);
    await room.save(); // save 内部有乐观锁

    if (engine.checkAllSheriffVoted()) {
        const events = await engine.processSheriffVoteResults();
        await room.save(); // save 内部有乐观锁
        await this.processEvents(e, events, room.groupId);
    }
}

async handleHunterShoot(e) {
    // 重新加载最新房间数据以确保操作基于最新状态
    let room = await this.getGameRoomAndCheck(e, { loadByUserId: true, checkPhase: GAME_PHASE.HUNTER_SHOOT });
    if (!room) return;
    const engine = room.engine;
    const match = e.msg.match(/#开枪\\s*(\\d+)/);
    if (!match) return e.reply('指令格式不正确，请发送 #开枪 [玩家编号]');

    const targetTempId = match[1];
    const result = await engine.handleHunterShoot(e.user_id, targetTempId);

    if (!result.success) {
        logger.warn(`handleHunterShoot 失败: ${result.message}, userId: ${e.user_id}`);
        return e.reply(result.message);
    }
    await room.save(); // save 内部有乐观锁
    await this.processEvents(e, result.events, room.groupId);
}

async handleLastWord(e) {
    // 重新加载最新房间数据以确保操作基于最新状态
    let room = await this.getGameRoomAndCheck(e, { loadByUserId: true, checkPhase: GAME_PHASE.LAST_WORDS });
    if (!room) return;
    const engine = room.engine;
    const match = e.msg.match(/^#遗言\\s*(.*)$/);
    if (!match) return e.reply('请发送 #遗言 [你的遗言内容]');

    const lastWordContent = match[1].trim();
    const result = await engine.handleLastWord(e.user_id, lastWordContent);

    if (!result.success) {
        logger.warn(`handleLastWord 失败: ${result.message}, userId: ${e.user_id}`);
        return e.reply(result.message);
    }
    await room.save(); // save 内部有乐观锁
    await this.processEvents(e, result.events, room.groupId);
}

async handlePkVote(e) {
    // 重新加载最新房间数据以确保操作基于最新状态
    let room = await this.getGameRoomAndCheck(e, { loadByUserId: true, checkPhase: GAME_PHASE.PK_VOTE });
    if (!room) return;
    const engine = room.engine;
    const match = e.msg.match(/#PK投票\\s*(\\d+)/);
    if (!match) return e.reply('指令格式不正确，请发送 #PK投票 [玩家编号]');

    const targetTempId = match[1];
    const result = engine.handlePkVote(e.user_id, targetTempId);

    if (!result.success) {
        logger.warn(`handlePkVote 失败: ${result.message}, userId: ${e.user_id}`);
        return e.reply(result.message);
    }
    
    await e.reply(result.message);
    await room.save(); // save 内部有乐观锁

    if (engine.checkAllPkVoted()) {
        const events = await engine.processPkVoteResults();
        await room.save(); // save 内部有乐观锁
        await this.processEvents(e, events, room.groupId);
    }
}

async handleSelfExplode(e) {
    if (!werewolfConfig.enableSelfExplosion) {
        return e.reply('当前游戏未开启狼人自爆功能。');
    }

    // 重新加载最新房间数据以确保操作基于最新状态
    let room = await this.getGameRoomAndCheck(e, { loadByUserId: true, checkStatus: GAME_STATUS.RUNNING });
    if (!room) return;
    const engine = room.engine;

    const player = engine.getPlayer(e.user_id);
    if (!player || !player.isAlive || player.role.team !== 'wolf') {
        return e.reply('你不是存活的狼人，无法自爆。');
    }

    // 检查游戏阶段，只能在白天发言阶段自爆
    if (engine.gameState.phase !== GAME_PHASE.DAY_SPEAK) {
        return e.reply('当前阶段无法自爆。自爆只能在白天发言阶段进行。');
    }

    const match = e.msg.match(/^#自爆(?:\\s*(\\d+))?$/);
    let targetTempId = null;
    if (match && match[1]) {
        targetTempId = match[1];
    }
    
    const result = await engine.handleSelfExplode(e.user_id, targetTempId);

    if (!result.success) {
        logger.warn(`handleSelfExplode 失败: ${result.message}, userId: ${e.user_id}`);
        return e.reply(result.message);
    }

    await e.reply(result.message);
    await room.save(); // save 内部有乐观锁
    await this.processEvents(e, result.events, room.groupId);
}

// 新增：狼王爪命令处理
async handleWolfKingClaw(e) {
    // 重新加载最新房间数据以确保操作基于最新状态
    let room = await this.getGameRoomAndCheck(e, { loadByUserId: true, checkPhase: GAME_PHASE.WOLF_KING_CLAW });
    if (!room) return;
    const engine = room.engine;

    const player = engine.getPlayer(e.user_id);
    if (!player || player.role.roleId !== ROLES.WOLF_KING) {
        return e.reply('你不是狼王，无法使用狼王爪。');
    }

    const match = e.msg.match(/#狼王爪\\s*(\\d+)/);
    if (!match) return e.reply('指令格式不正确，请发送 #狼王爪 [玩家编号]');

    const targetTempId = match[1];
    const result = await engine.handleWolfKingClaw(e.user_id, targetTempId);

    if (!result.success) {
        logger.warn(`handleWolfKingClaw 失败: ${result.message}, userId: ${e.user_id}`);
        return e.reply(result.message);
    }
    await room.save(); // save 内部有乐观锁
    await this.processEvents(e, result.events, room.groupId);
}

  // --- 事件处理器 ---

  async processEvents(e, events, groupId = null) {
    const sourceGroupId = groupId || e.group_id;
    if (!this.adapter || !sourceGroupId) {
        logger.error('processEvents 缺少 adapter 或 groupId');
        return;
    }

    const eventQueue = [...events]; // 使用队列来处理事件

    while (eventQueue.length > 0) {
      const event = eventQueue.shift(); // 取出队列中的第一个事件
      logger.info(`[DEBUG] 处理事件: Type=${event.type}, Content=${JSON.stringify(event)}`);
      try {
        switch (event.type) {
          case 'group_message':
            await this.adapter.pickGroup(sourceGroupId).sendMsg(event.content);
            break;
          case 'private_message':
            await this.adapter.pickUser(event.userId).sendMsg(event.content);
            break;
          case 'last_words_prompt': // 处理遗言提示事件
            await this.adapter.pickUser(event.userId).sendMsg(`请发送你的遗言。你有 ${event.duration} 秒时间。发送 #遗言 [你的遗言内容]`);
            break;
          case 'wolf_king_claw_prompt': // 狼王爪提示
            await this.adapter.pickUser(event.userId).sendMsg(`狼王，你已出局，请发动狼王爪带走一名玩家。发送 #狼王爪 [玩家编号]`);
            break;
          case 'idiot_flip_card_prompt': // 白痴翻牌提示
            // 此事件仅用于通知用户白痴已自动翻牌，实际翻牌逻辑由 GameEngine 在其他事件流中完成。
            // 重新加载最新房间数据，因为 GameEngine.startIdiotFlipPhase 会修改 room
            let room = await GameRoom.load(sourceGroupId);
            if (room) {
                // 如果 GameEngine.startIdiotFlipPhase 已经处理了，这里只是发送提示
                // 确保 room 实例是最新的，以便后续操作（如果需要）
                // 这里不需要再次调用 room.save()，因为 GameEngine.startIdiotFlipPhase 内部不直接 save room
                // 且白痴翻牌后，由 GameEngine 决定下一步流程，最终会通过 processPendingDeaths 触发 save
            }
            await this.adapter.pickUser(event.userId).sendMsg(`白痴，你已被放逐，你的身份已自动亮出。`); // 提示信息修改
            break;
          case 'timer_timeout_events': // 计时器超时事件
            // 将计时器超时引发的事件添加到队列末尾，而不是递归调用
            eventQueue.push(...event.data.events);
            break;
          case 'game_end':
            let endMsg = `游戏结束！\n胜利方：${event.winner}阵营\n原因：${event.reason}`;
            await this.adapter.pickGroup(sourceGroupId).sendMsg(endMsg);
            const roomAtEnd = await GameRoom.load(sourceGroupId); // 重新加载最新房间数据
            if (roomAtEnd && werewolfConfig.enablePostGameReview) { // 根据配置判断是否展示赛后回顾
                let reviewMsg = "--- 赛后回顾 ---\n";
                reviewMsg += "玩家身份：\n";
                roomAtEnd.players.forEach(p => {
                    reviewMsg += `${p.info} (${p.role.name})\n`;
                });
                reviewMsg += "\n关键事件：\n";
                if (roomAtEnd.engine && roomAtEnd.engine.gameLog.length > 0) {
                    roomAtEnd.engine.gameLog.forEach(log => {
                        // 过滤掉不在配置中的事件类型
                        if (werewolfConfig.postGameReviewEvents.includes(log.type)) {
                            reviewMsg += `- 第${log.day}天: `;
                            switch(log.type) {
                                case 'wolf_kill': reviewMsg += `狼人刀了 ${log.target}`; break;
                                case 'witch_potion': reviewMsg += `女巫对 ${log.target} 使用了${log.potion === 'antidote' ? '解药' : '毒药'}`; break;
                                case 'seer_check': reviewMsg += `预言家查验了 ${log.target}，结果是 ${log.result}`; break;
                                case 'hunter_shoot': reviewMsg += `猎人 ${log.shooter} 开枪带走了 ${log.target}`; break;
                                case 'exiled': reviewMsg += `${log.player} 被放逐`; break;
                                case 'night_death': reviewMsg += `${log.player} 在夜晚死亡`; break;
                                case 'sheriff_elected': reviewMsg += `警长 ${log.sheriff} 当选`; break; // 修正
                                case 'sheriff_none': reviewMsg += `警长流失`; break;
                                case 'player_vote': reviewMsg += `${log.voter} 投票给了 ${log.target}`; break;
                                case 'exile_random': reviewMsg += `平票，随机放逐 ${log.player}`; break;
                                case 'exile_pk_pending': reviewMsg += `平票，进入PK环节`; break;
                                case 'night_action': reviewMsg += `${log.actor} 执行了 ${log.action}，目标 ${log.target}`; break;
                                case 'peaceful_night': reviewMsg += `平安夜`; break;
                                case 'day_speak_start': reviewMsg += `白天发言开始`; break;
                                case 'day_vote_start': reviewMsg += `白天投票开始`; break;
                                case 'vote_results': reviewMsg += `投票结果公布`; break;
                                case 'sheriff_election_start': reviewMsg += `警长竞选开始`; break;
                                case 'sheriff_candidate': reviewMsg += `${log.player} 上警`; break;
                                case 'sheriff_withdraw': reviewMsg += `${log.player} 退水`; break;
                                case 'sheriff_vote_start': reviewMsg += `警上投票开始`; break;
                                case 'sheriff_vote': reviewMsg += `${log.voter} 警上投票给了 ${log.target}`; break;
                                case 'last_word': reviewMsg += `${log.player} 遗言：${log.content}`; break;
                                case 'last_words_start': reviewMsg += `${log.player} 开始发表遗言`; break;
                                case 'next_speaker': reviewMsg += `轮到 ${log.speaker} 发言`; break;
                                case 'pk_vote_start': reviewMsg += `进入PK环节，PK玩家：${log.players.join('、')}`; break;
                                case 'pk_player_vote': reviewMsg += `${log.voter} PK投票给了 ${log.target}`; break;
                                case 'pk_vote_results': reviewMsg += `PK投票结果公布: ${log.summary}`; break;
                                case 'pk_exile_random': reviewMsg += `PK再次平票，随机放逐 ${log.player}`; break;
                                case 'pk_exile_no_one': reviewMsg += `PK再次平票，无人被放逐`; break;
                                case 'pk_exiled': reviewMsg += `${log.player} 在PK环节中被放逐`; break;
                                case 'wolf_king_self_stab': reviewMsg += `狼王 ${log.target} 自刀`; break;
                                case 'wolf_king_claw_start': reviewMsg += `狼王 ${log.wolfKing} 触发狼王爪技能`; break;
                                case 'wolf_king_claw': reviewMsg += `狼王 ${log.wolfKing} 狼王爪带走了 ${log.target}`; break;
                                case 'idiot_flip_card': reviewMsg += `白痴 ${log.idiot} 翻牌`; break;
                                case 'white_wolf_king_self_explode': reviewMsg += `白狼王 ${log.exploder} 自爆并带走了 ${log.target}`; break;
                                case 'wolf_self_explode': reviewMsg += `${log.exploder} 自爆`; break;
                                default: reviewMsg += `未知事件: ${log.type}`; break;
                            }
                            reviewMsg += '\n';
                        }
                    });
                } else {
                    reviewMsg += "无关键事件记录。\n";
                }
                await this.adapter.pickGroup(sourceGroupId).sendMsg(reviewMsg);
            }
            if (roomAtEnd) await roomAtEnd.cleanup();
            break;
          }
        } catch (err) {
          logger.error(`处理事件失败: `, err);
        }
      }
    }

  async handleWolfChat(e) {
    const room = await this.getGameRoomAndCheck(e, { loadByUserId: true, checkStatus: GAME_STATUS.RUNNING }); // 检查游戏是否运行中
    if (!room) return;
    
    const engine = room.engine;
    if (engine.gameState.phase !== GAME_PHASE.NIGHT_START) {
      return e.reply('非夜晚时间，狼人频道已关闭。');
    }
    
    const sender = engine.getPlayer(e.user_id);
    if (!sender || !sender.isAlive || sender.role.team !== 'wolf') {
      return e.reply('你不是存活的狼人，无法使用此功能。');
    }
  }
}
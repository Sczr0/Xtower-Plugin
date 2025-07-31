import plugin from '../../lib/plugins/plugin.js';
import { GameEngine } from '../models/werewolf/GameEngine.js';
import { DataManager } from '../models/werewolf/DataManager.js';
import { roleLoader } from '../models/werewolf/RoleLoader.js';
import { GAME_EVENTS, INTERACTION_EVENTS, ROLE_EVENTS, GAME_STATES } from '../models/werewolf/GameEvents.js';
import { BoardPresets, getBoardPreset, getAllPresets } from '../models/werewolf/BoardPresets.js';

/**
 * @class WerewolfV2Plugin
 * @description 狼人杀插件V2 - 事件驱动架构版本
 * 职责：作为Yunzai插件入口，连接游戏引擎与Bot平台，处理用户指令
 */
export class WerewolfV2Plugin extends plugin {
  constructor() {
    super({
      name: '狼人杀V2',
      dsc: '事件驱动的狼人杀游戏',
      event: 'message',
      priority: 1000,
      rule: [
        {
          reg: '^#(创建狼人杀|狼人杀)$',
          fnc: 'createGame'
        },
        {
          reg: '^#查看板子$',
          fnc: 'showBoardPresets'
        },
        {
          reg: '^#选择板子\\s*(\\S+)$',
          fnc: 'selectBoardPreset'
        },
        {
          reg: '^#(加入|加入狼人杀)$',
          fnc: 'joinGame'
        },
        {
          reg: '^#(退出|离开|退出游戏)$',
          fnc: 'leaveGame'
        },
        {
          reg: '^#(开始游戏|开始)$',
          fnc: 'startGame'
        },
        {
          reg: '^#查验\\s*(\\d+)$',
          fnc: 'handleNightAction'
        },
        {
          reg: '^#杀\\s*(\\d+)$',
          fnc: 'handleNightAction'
        },
        {
          reg: '^#(救|解药)\\s*(\\d+)$',
          fnc: 'handleNightAction'
        },
        {
          reg: '^#(毒|毒药)\\s*(\\d+)$',
          fnc: 'handleNightAction'
        },
        {
          reg: '^#(守|守护)\\s*(\\d+)$',
          fnc: 'handleNightAction'
        },
        {
          reg: '^#跳过$',
          fnc: 'handleNightAction'
        },
        {
          reg: '^#狼人\\s*(.+)$',
          fnc: 'handleWerewolfChat'
        },
        {
          reg: '^#投票\\s*(\\d+)$',
          fnc: 'handleVote'
        },
        {
          reg: '^#(游戏状态|状态)$',
          fnc: 'showGameStatus'
        },
        {
          reg: '^#(强制结束|结束游戏)$',
          fnc: 'forceEndGame'
        },
        {
          reg: '^#回顾日志$',
          fnc: 'showGameLog'
        }
      ]
    });

    this.gameEngines = new Map();
    this.initializeRoleLoader();
  }

  async initializeRoleLoader() {
    try {
      await roleLoader.initialize();
      console.log('[WerewolfV2] 角色加载器初始化完成');
    } catch (error) {
      console.error('[WerewolfV2] 角色加载器初始化失败:', error);
    }
  }

  async getGameEngine(groupId, createIfNotExist = false) {
    if (this.gameEngines.has(groupId)) {
      return this.gameEngines.get(groupId);
    }

    const gameData = await DataManager.load(groupId);
    if (gameData) {
      const engine = new GameEngine(groupId, gameData);
      this.setupEngineEventListeners(engine);
      this.gameEngines.set(groupId, engine);
      roleLoader.createRoleInstances(groupId, engine, gameData.players);
      return engine;
    }

    if (createIfNotExist) {
      const engine = new GameEngine(groupId);
      this.setupEngineEventListeners(engine);
      this.gameEngines.set(groupId, engine);
      return engine;
    }

    return null;
  }

  setupEngineEventListeners(engine) {
    engine.on(INTERACTION_EVENTS.SEND_GROUP_MESSAGE, this.handleSendGroupMessage.bind(this));
    engine.on(INTERACTION_EVENTS.SEND_PRIVATE_MESSAGE, this.handleSendPrivateMessage.bind(this));
    engine.on(INTERACTION_EVENTS.SAVE_GAME_DATA, this.handleSaveGameData.bind(this));
    engine.on(INTERACTION_EVENTS.DELETE_GAME_DATA, this.handleDeleteGameData.bind(this));
    engine.on(GAME_EVENTS.GAME_STARTED, this.onGameStarted.bind(this));
    engine.on(GAME_EVENTS.GAME_ENDED, this.onGameEnded.bind(this));
  }

  async createGame(e) {
    const groupId = e.group_id?.toString();
    if (!groupId) {
      return e.reply('❌ 只能在群聊中创建狼人杀游戏。');
    }

    const existingEngine = await this.getGameEngine(groupId);
    if (existingEngine) {
      return e.reply('❌ 本群已有正在进行的狼人杀游戏。');
    }

    const engine = await this.getGameEngine(groupId, true);
    // 初始创建游戏时不指定预设名称，默认使用 GameEngine 中的 default
    engine.initGame(e.user_id);

    return e.reply('🎮 狼人杀游戏已创建！发送 "#加入" 来参与游戏。');
  }

  async joinGame(e) {
    const groupId = e.group_id?.toString();
    if (!groupId) {
      return e.reply('❌ 只能在群聊中加入狼人杀游戏。');
    }

    const engine = await this.getGameEngine(groupId);
    if (!engine) {
      return e.reply('❌ 本群没有正在进行的狼人杀游戏，请先创建游戏。');
    }

    const result = engine.addPlayer(e.user_id, e.sender?.card || e.sender?.nickname || '未知');
    return e.reply(result.message);
  }

  async leaveGame(e) {
    const groupId = e.group_id?.toString();
    if (!groupId) {
      return e.reply('❌ 只能在群聊中操作。');
    }

    const engine = await this.getGameEngine(groupId);
    if (!engine) {
      return e.reply('❌ 本群没有正在进行的狼人杀游戏。');
    }

    const result = engine.removePlayer(e.user_id);
    return e.reply(result.message);
  }

  async startGame(e) {
    const groupId = e.group_id?.toString();
    if (!groupId) {
      return e.reply('❌ 只能在群聊中操作。');
    }

    const engine = await this.getGameEngine(groupId);
    if (!engine) {
      return e.reply('❌ 本群没有正在进行的狼人杀游戏。');
    }

    if (engine.gameState.hostUserId !== e.user_id) {
      return e.reply('❌ 只有房主才能开始游戏。');
    }

    const result = engine.startGame();
    if (result.success) {
      roleLoader.createRoleInstances(groupId, engine, engine.players);
    }
    
    return e.reply(result.message);
  }

  async handleNightAction(e) {
    const groupId = e.group_id?.toString();
    if (!groupId) return;

    const engine = await this.getGameEngine(groupId);
    if (!engine || engine.gameState.currentPhase !== GAME_STATES.NIGHT_PHASE) {
      return;
    }

    const msg = e.msg.trim();
    let actionType, targetId;

    if (msg.includes('查验')) {
      actionType = 'CHECK';
      targetId = msg.match(/\d+/)?.[0];
    } else if (msg.includes('杀')) {
      actionType = 'KILL';
      targetId = msg.match(/\d+/)?.[0];
    } else if (msg.includes('救') || msg.includes('解药')) {
      actionType = 'SAVE';
      targetId = msg.match(/\d+/)?.[0];
    } else if (msg.includes('毒') || msg.includes('毒药')) {
      actionType = 'POISON';
      targetId = msg.match(/\d+/)?.[0];
    } else if (msg.includes('守护') || msg.includes('守')) {
      actionType = 'PROTECT';
      targetId = msg.match(/\d+/)?.[0];
    } else if (msg.includes('跳过')) {
      actionType = 'SKIP';
    }

    if (actionType) {
      const action = {
        userId: e.user_id,
        type: actionType,
        targetId: targetId ? targetId.padStart(2, '0') : null
      };

      engine.handlePlayerAction(action);
    }
  }

  async handleWerewolfChat(e) {
    const groupId = e.group_id?.toString();
    if (!groupId) return;

    const engine = await this.getGameEngine(groupId);
    if (!engine || engine.gameState.currentPhase !== GAME_STATES.NIGHT_PHASE) {
      return;
    }

    const message = e.msg.replace(/^#狼人\s*/, '').trim();
    if (message) {
      engine.emit(ROLE_EVENTS.WEREWOLF_CHAT_MESSAGE, {
        senderId: e.user_id,
        message: message,
        groupId: groupId
      });
    }
  }

  async handleVote(e) {
    const groupId = e.group_id?.toString();
    if (!groupId) return;

    const engine = await this.getGameEngine(groupId);
    if (!engine || engine.gameState.currentPhase !== GAME_STATES.DAY_VOTE) {
      return;
    }

    const targetId = e.msg.match(/\d+/)?.[0];
    if (targetId) {
      const action = {
        userId: e.user_id,
        type: 'VOTE',
        targetId: targetId.padStart(2, '0')
      };

      engine.handlePlayerAction(action);
    }
  }

  async showGameStatus(e) {
    const groupId = e.group_id?.toString();
    if (!groupId) {
      return e.reply('❌ 只能在群聊中查看游戏状态。');
    }

    const engine = await this.getGameEngine(groupId);
    if (!engine) {
      return e.reply('❌ 本群没有正在进行的狼人杀游戏。');
    }

    let statusMsg = `🎮 狼人杀游戏状态\n\n`;
    statusMsg += `📊 当前阶段：${engine.gameState.currentPhase}\n`;
    statusMsg += `📅 游戏天数：第${engine.gameState.currentDay}天\n`;
    statusMsg += `👥 玩家数量：${engine.players.length}人\n\n`;

    statusMsg += `👤 玩家列表：\n`;
    engine.players.forEach(player => {
      const status = player.isAlive ? '🟢' : '💀';
      statusMsg += `${status} ${player.nickname}(${player.tempId}号)\n`;
    });

    return e.reply(statusMsg);
  }

  async forceEndGame(e) {
    const groupId = e.group_id?.toString();
    if (!groupId) {
      return e.reply('❌ 只能在群聊中操作。');
    }

    const engine = await this.getGameEngine(groupId);
    if (!engine) {
      return e.reply('❌ 本群没有正在进行的狼人杀游戏。');
    }

    if (engine.gameState.hostUserId !== e.user_id && !e.isMaster && !e.member?.is_admin) {
      return e.reply('❌ 只有房主、群管理员或机器人主人才能强制结束游戏。');
    }

    await this.cleanupGame(groupId);
    return e.reply('🎮 游戏已强制结束。');
  }

  async cleanupGame(groupId) {
    roleLoader.cleanupGroupRoles(groupId);
    
    if (this.gameEngines.has(groupId)) {
      const engine = this.gameEngines.get(groupId);
      engine.removeAllListeners();
      this.gameEngines.delete(groupId);
    }
    
    await DataManager.delete(groupId);
  }

  async handleSendGroupMessage(data) {
    const { groupId, message } = data;
    try {
      await Bot.pickGroup(groupId).sendMsg(message);
    } catch (error) {
      console.error(`[WerewolfV2] 发送群消息失败 (${groupId}):`, error);
    }
  }

  async handleSendPrivateMessage(data) {
    const { userId, message, groupId } = data;
    try {
      await Bot.pickUser(userId).sendMsg(message);
    } catch (error) {
      console.error(`[WerewolfV2] 发送私聊消息失败 (${userId}):`, error);
    }
  }

  async handleSaveGameData(data) {
    const { groupId, data: gameData } = data;
    await DataManager.saveAll(groupId, gameData);
  }

  async handleDeleteGameData(data) {
    const { groupId } = data;
    await DataManager.delete(groupId);
  }

  async onGameStarted(data) {
    console.log(`[WerewolfV2] 游戏开始 (${data.groupId})`);
  }

  async onGameEnded(data) {
    console.log(`[WerewolfV2] 游戏结束 (${data.groupId}), 胜者: ${data.winner}`);
    await this.cleanupGame(data.groupId);
  }
  async showBoardPresets(e) {
    const groupId = e.group_id?.toString();
    if (!groupId) {
      return e.reply('❌ 只能在群聊中操作。');
    }

    const presets = getAllPresets();
    if (presets.length === 0) {
      return e.reply('ℹ️ 暂无可用板子预设。');
    }

    let msg = '📜 可用狼人杀板子预设：\n\n';
    presets.forEach((preset, index) => {
      msg += `${index + 1}. ${preset.name} (${preset.roles.length}人局)\n`;
      msg += `   描述：${preset.description}\n`;
      msg += `   角色：${preset.roles.join('、')}\n\n`;
    });
    msg += '使用 "#选择板子 [板子名称]" 来选择板子，例如：#选择板子 6人新手局';
    return e.reply(msg);
  }

  async selectBoardPreset(e) {
    const groupId = e.group_id?.toString();
    if (!groupId) {
      return e.reply('❌ 只能在群聊中操作。');
    }

    const engine = await this.getGameEngine(groupId);
    if (!engine) {
      return e.reply('❌ 本群没有正在进行的狼人杀游戏，请先创建游戏。');
    }

    if (engine.gameState.hostUserId !== e.user_id) {
      return e.reply('❌ 只有房主才能选择板子。');
    }

    const presetName = e.msg.replace(/^#选择板子\s*/, '').trim();
    
    // 尝试根据名称查找预设
    let selectedPreset = null;
    for (const key in BoardPresets) {
      if (Object.hasOwnProperty.call(BoardPresets, key) && BoardPresets[key].name === presetName) {
        selectedPreset = BoardPresets[key];
        break;
      }
    }

    if (!selectedPreset) {
      return e.reply(`❌ 未找到名为 "${presetName}" 的板子预设。请使用 "#查看板子" 查看可用预设。`);
    }

    const result = engine.setBoardPreset(selectedPreset.name);
    if (result.success) {
      return e.reply(`✅ 板子已设置为：${selectedPreset.name} (${selectedPreset.roles.length}人局)\n当前玩家数：${engine.players.length}。`);
    } else {
      return e.reply(`❌ 设置板子失败：${result.message}`);
    }
  }

  async showGameLog(e) {
    const groupId = e.group_id?.toString();
    if (!groupId) {
      return e.reply('❌ 只能在群聊中操作。');
    }

    const engine = await this.getGameEngine(groupId);
    if (!engine) {
      return e.reply('❌ 本群没有正在进行的狼人杀游戏。');
    }

    const logSummary = engine.getGameLogSummary();
    return e.reply(logSummary);
  }
}
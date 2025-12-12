import GameRepository from './infra/GameRepository.js'
import MessageService from './services/MessageService.js'
import MuteService from './services/MuteService.js'
import PhaseService from './services/PhaseService.js'
import CommandService from './services/CommandService.js'
import LifecycleService from './services/LifecycleService.js'
import { PLUGIN_NAME } from './constants.js'

/**
 * @class WerewolfPlugin
 * @description Yunzai 插件控制器（命令路由层）。
 * 职责：生命周期指令（创建/加入/退出/开始）保留在此，其余指令委托给 CommandService。
 */
export class WerewolfPlugin extends plugin {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: '狼人杀游戏插件',
      event: 'message',
      priority: 50,
      rule: [
        { reg: '^#创建狼人杀$', fnc: 'createGame' },
        { reg: '^#加入狼人杀$', fnc: 'joinGame' },
        { reg: '^#退出狼人杀$', fnc: 'leaveGame' },
        { reg: '^#开始狼人杀$', fnc: 'startGame' },
        { reg: '^#(强制)?结束狼人杀$', fnc: 'forceEndGame' },
        { reg: '^#狼人杀状态$', fnc: 'showGameStatus' },
        { reg: '^#?(杀|刀)\\s*(\\d+)$', fnc: 'handleNightAction', permission: 'private' },
        { reg: '^#(狼聊|w)\\s*(.+)$', fnc: 'handleWerewolfChat', permission: 'private' },
        { reg: '^#?查验\\s*(\\d+)$', fnc: 'handleNightAction', permission: 'private' },
        { reg: '^#?救\\s*(\\d+)$', fnc: 'handleNightAction', permission: 'private' },
        { reg: '^#?毒\\s*(\\d+)$', fnc: 'handleNightAction', permission: 'private' },
        { reg: '^#?守\\s*(\\d+)$', fnc: 'handleNightAction', permission: 'private' },
        { reg: '^#?(结束发言|过)$', fnc: 'handleEndSpeech' },
        { reg: '^#投票\\s*(\\d+|弃票)$', fnc: 'handleVote' },
        { reg: '^#开枪\\s*(\\d+)$', fnc: 'handleHunterShoot', permission: 'private' },
        { reg: '^#自爆(?:\\s*(.*))?$', fnc: 'handleSelfDestruct' },
        { reg: '^#狼爪\\s*(\\d+)$', fnc: 'handleWolfKingClaw', permission: 'private' }
      ]
    })

    this.repo = new GameRepository(this)
    this.messageService = new MessageService()
    this.muteService = new MuteService()
    this.phaseService = new PhaseService({
      repo: this.repo,
      message: this.messageService,
      mute: this.muteService
    })
    this.commandService = new CommandService({
      repo: this.repo,
      phase: this.phaseService,
      message: this.messageService,
      mute: this.muteService
    })
    this.lifecycleService = new LifecycleService({
      repo: this.repo,
      message: this.messageService,
      phase: this.phaseService
    })

    setInterval(() => this.phaseService.checkAllGameTimers(), 5000)
  }

  // --- 生命周期指令 ---

  async createGame(e) { return this.lifecycleService.createGame(e) }
  async joinGame(e) { return this.lifecycleService.joinGame(e) }
  async leaveGame(e) { return this.lifecycleService.leaveGame(e) }
  async startGame(e) { return this.lifecycleService.startGame(e) }

  // --- 其余指令直接委托 ---

  async handleNightAction(e) { return this.commandService.handleNightAction(e) }
  async handleWerewolfChat(e) { return this.commandService.handleWerewolfChat(e) }
  async handleEndSpeech(e) { return this.commandService.handleEndSpeech(e) }
  async handleVote(e) { return this.commandService.handleVote(e) }
  async handleHunterShoot(e) { return this.commandService.handleHunterShoot(e) }
  async handleSelfDestruct(e) { return this.commandService.handleSelfDestruct(e) }
  async handleWolfKingClaw(e) { return this.commandService.handleWolfKingClaw(e) }
  async forceEndGame(e, isAutoCleanup = false) { return this.commandService.forceEndGame(e, isAutoCleanup) }
  async showGameStatus(e) { return this.commandService.showGameStatus(e) }
}

import { PLUGIN_NAME, GAME_PRESETS, AUTO_MUTE_ENABLED } from '../constants.js'

/**
 * @class LifecycleService
 * @description 狼人杀生命周期指令服务。
 * 职责：创建/加入/退出/开始对局，这些操作会影响游戏实例的创建与初始化。
 */
export default class LifecycleService {
  /**
   * @param {object} deps
   * @param {object} deps.repo GameRepository 实例
   * @param {object} deps.message MessageService 实例
   * @param {object} deps.phase PhaseService 实例
   */
  constructor({ repo, message, phase }) {
    this.repo = repo
    this.message = message
    this.phase = phase
  }

  /**
   * 处理 #创建狼人杀。
   */
  async createGame(e) {
    const groupId = e.group_id
    if (!groupId) return e.reply("请在群聊中使用此命令。")

    let game = await this.repo.getGameInstance(groupId)
    if (game && game.gameState.status !== 'ended') {
      return e.reply(`本群已有游戏（状态: ${game.gameState.status}）。\n请先 #结束狼人杀。`)
    }

    const match = e.msg.match(/^#创建狼人杀(?:\s+(.*))?$/)
    const presetName = match && match[1] ? match[1].trim() : 'default'

    game = await this.repo.getGameInstance(groupId, true, e.user_id, e.sender.card || e.sender.nickname)
    const initResult = await game.initGame(e.user_id, e.sender.card || e.sender.nickname, groupId, presetName)

    await this.repo.saveGameAll(groupId, game)
    return e.reply(initResult.message, true)
  }

  /**
   * 处理 #加入狼人杀。
   */
  async joinGame(e) {
    const groupId = e.group_id
    if (!groupId) return e.reply("请在群聊中使用此命令。", true)
    const game = await this.repo.getGameInstance(groupId)
    if (!game || game.gameState.status === 'ended') return e.reply("本群当前没有等待加入的游戏。", true)
    if (!['waiting', 'starting'].includes(game.gameState.status)) return e.reply("游戏已经开始或结束，无法加入。", true)

    const reachable = await this.message.sendDirectMessage(
      e.user_id,
      `[${PLUGIN_NAME}] 游戏加入成功！\n我们已确认可以向您发送私聊消息。`,
      groupId,
      false
    )
    if (!reachable) {
      return e.reply(
        `[!] 加入失败！无法向您发送私聊消息。\n请先添加机器人为好友，或检查是否已屏蔽机器人。解决后请重新加入。`,
        true,
        { at: true }
      )
    }

    const result = await game.addPlayer(e.user_id, e.sender.card || e.sender.nickname, groupId)
    if (result.success) {
      this.repo.cacheUserGroup(e.user_id, groupId)
      await this.repo.saveGameField(groupId, game, 'players')
      await this.repo.saveGameField(groupId, game, 'userGroupMap')
    }
    return e.reply(result.message, false, { at: true })
  }

  /**
   * 处理 #退出狼人杀。
   */
  async leaveGame(e) {
    const groupId = e.group_id
    if (!groupId) return e.reply("请在群聊中使用此命令。", true)
    const game = await this.repo.getGameInstance(groupId)
    if (!game || game.gameState.status === 'ended') return e.reply("本群当前没有游戏。", true)
    if (!['waiting', 'starting'].includes(game.gameState.status)) return e.reply("游戏已经开始，无法退出。", true)

    const result = await game.removePlayer(e.user_id)
    if (result.success) {
      this.repo.uncacheUserGroup(e.user_id)
      if (result.gameDissolved) {
        await this.phase.deleteGame(groupId)
      } else {
        await this.repo.saveGameField(groupId, game, 'players')
        await this.repo.saveGameField(groupId, game, 'userGroupMap')
      }
    }
    return e.reply(result.message, false, { at: true })
  }

  /**
   * 处理 #开始狼人杀。
   */
  async startGame(e) {
    const groupId = e.group_id
    if (!groupId) return e.reply("请在群聊中使用此命令。", true)
    const game = await this.repo.getGameInstance(groupId)
    if (!game || game.gameState.status === 'ended') return e.reply("本群当前没有游戏。", true)
    if (game.gameState.hostUserId !== e.user_id) return e.reply("只有房主才能开始游戏。", true)
    if (game.gameState.status !== 'waiting') return e.reply(`游戏状态为 ${game.gameState.status}，无法开始。`, true)

    const prepareResult = await game.prepareGameStart()
    if (!prepareResult.success) return e.reply(prepareResult.message, true)

    if (AUTO_MUTE_ENABLED) {
      game.gameState.hasPermission = e.group.is_admin
      const permissionMsg = game.gameState.hasPermission
        ? '【有权限模式】机器人将自动进行禁言/解禁。'
        : '【无权限模式】机器人权限不足，请玩家自觉遵守发言规则。'
      await e.reply(permissionMsg, true)
    }

    await this.repo.saveGameField(groupId, game, 'gameState')
    await e.reply("游戏即将开始，正在生成本局游戏配置...", true)

    const playerCount = game.players.length
    let preset = GAME_PRESETS[game.gameState.presetName] || GAME_PRESETS['default']

    if (preset.playerCount) {
      const { min, max } = preset.playerCount
      if (playerCount < min || playerCount > max) {
        await e.reply(`当前人数(${playerCount}人)不符合预设板子“${preset.name}”(${min}-${max}人)的要求，将自动切换至默认配置。`)
        preset = GAME_PRESETS['default']
        game.gameState.presetName = 'default'
      }
    }

    game.ruleset = preset.ruleset
    const distribution = preset.roles ? game.assignRolesFromPreset(preset) : game.calculateRoleDistribution()

    let distributionMessage = `--- 本局配置 (${playerCount}人 | ${preset.name}) ---\n`
    for (const role in distribution) {
      if (distribution[role] > 0) {
        distributionMessage += `${game.roles[role]}: ${distribution[role]}人\n`
      }
    }
    await this.message.sendSystemGroupMsg(groupId, distributionMessage.trim())

    const assignResult = game.assignRoles(distribution)
    if (!assignResult.success) {
      game.gameState.status = 'waiting'
      await this.repo.saveGameAll(groupId, game)
      return e.reply(assignResult.message, true)
    }

    await this.repo.saveGameAll(groupId, game)
    await this.phase.sendRolesToPlayers(groupId, game)
    game.gameState.isRunning = true
    await this.repo.saveGameAll(groupId, game)
    await this.phase.startNightPhase(groupId, game)
  }
}


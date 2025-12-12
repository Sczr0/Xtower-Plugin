import { ROLES } from '../constants.js'

/**
 * 创建角色专属行为映射表。
 * 说明：该表原本内嵌在 WerewolfGame 内，现迁出以降低核心类体积与耦合。
 * 所有方法均以 (game, player, ...) 形式显式传参，避免隐式依赖 this。
 */
export default function createRoleActions() {
  return {
    [ROLES.WEREWOLF]: {
      /**
       * 记录狼人袭击意图。实际结算在 `processNightActions` 中进行。
       * @param {WerewolfGame} game - 游戏实例。
       * @param {object} player - 狼人玩家对象。
       * @param {string} targetPlayerId - 目标玩家的临时ID。
       * @returns {object} 操作结果。
       */
      performNightKill: (game, player, targetPlayerId) => {
        const targetPlayer = game.players.find(p => p.tempId === targetPlayerId && p.isAlive)
        if (!targetPlayer) return { success: false, message: '目标玩家无效或已死亡。' }
        return { success: true, message: `已记录狼人对 ${targetPlayer.nickname}(${targetPlayer.tempId}号) 的袭击意图。` }
      },
      /**
       * 发送狼人频道消息给所有狼队友。
       * @param {WerewolfGame} game - 游戏实例。
       * @param {object} sender - 发送消息的狼人玩家对象。
       * @param {Array<object>} teammates - 其他狼队友列表。
       * @param {string} chatContent - 聊天内容。
       * @param {Function} sendDirectMessageFunc - 用于发送私聊消息的函数。
       * @returns {object} 操作结果。
       */
      sendWerewolfChat: async (game, sender, teammates, chatContent, sendDirectMessageFunc) => {
        const formattedMessage = `[狼人频道] ${sender.nickname}(${sender.tempId}号): ${chatContent}`
        for (const teammate of teammates) {
          await sendDirectMessageFunc(teammate.userId, formattedMessage, sender.groupId)
          await new Promise(resolve => setTimeout(resolve, 200))
        }
        return { success: true, message: '消息已成功发送至狼人频道。' }
      }
    },
    [ROLES.SEER]: {
      /**
       * 查验玩家身份。
       * @param {WerewolfGame} game - 游戏实例。
       * @param {object} player - 预言家玩家对象。
       * @param {string} targetPlayerId - 目标玩家的临时ID。
       * @returns {object} 操作结果和查验反馈。
       */
      checkPlayer: (game, player, targetPlayerId) => {
        const targetPlayer = game.players.find(p => p.tempId === targetPlayerId && p.isAlive)
        if (!targetPlayer) return { success: false, message: '目标玩家无效或已死亡。' }
        const isWerewolf = [ROLES.WEREWOLF, ROLES.WOLF_KING, ROLES.WHITE_WOLF_KING].includes(targetPlayer.role)
        const feedbackMsg = `[查验结果] ${targetPlayer.nickname}(${targetPlayer.tempId}号) 的身份是 【${isWerewolf ? '狼人' : '好人'}】。`
        game.gameState.eventLog.push({
          day: game.gameState.currentDay,
          phase: 'night',
          type: 'SEER_CHECK',
          actor: game.getPlayerInfo(player.userId),
          target: game.getPlayerInfo(targetPlayer.userId),
          result: isWerewolf ? ROLES.WEREWOLF : 'GOOD_PERSON'
        })
        return { success: true, message: feedbackMsg }
      }
    },
    [ROLES.WITCH]: {
      /**
       * 女巫使用解药或毒药。实际结算在 `processNightActions` 中进行。
       * @param {WerewolfGame} game - 游戏实例。
       * @param {object} witchPlayer - 女巫玩家对象。
       * @param {string} actionType - 行动类型 ('save' 或 'kill')。
       * @param {string} targetPlayerId - 目标玩家的临时ID。
       * @returns {object} 操作结果。
       */
      performAction: (game, witchPlayer, actionType, targetPlayerId) => {
        if (actionType === 'save' && !game.potions.save) return { success: false, message: '你的解药已经用完了。' }
        if (actionType === 'kill' && !game.potions.kill) return { success: false, message: '你的毒药已经用完了。' }
        if (game.gameState.nightActions[ROLES.WITCH]?.[witchPlayer.userId]) return { success: false, message: '你今晚已经行动过了。' }

        const targetPlayer = game.players.find(p => p.tempId === targetPlayerId && p.isAlive)
        if (!targetPlayer) return { success: false, message: '目标玩家无效或已死亡。' }

        return { success: true, message: `[狼人杀] 已收到您的行动指令，请等待夜晚结束。` }
      }
    },
    [ROLES.GUARD]: {
      /**
       * 守卫守护玩家。实际结算在 `processNightActions` 中进行。
       * @param {WerewolfGame} game - 游戏实例。
       * @param {object} guardPlayer - 守卫玩家对象。
       * @param {string} targetPlayerId - 目标玩家的临时ID。
       * @returns {object} 操作结果。
       */
      performProtection: (game, guardPlayer, targetPlayerId) => {
        const targetPlayer = game.players.find(p => p.tempId === targetPlayerId && p.isAlive)
        if (!targetPlayer) return { success: false, message: '目标玩家无效或已死亡。' }
        if (targetPlayer.userId === game.gameState.lastProtectedId) return { success: false, message: '不能连续两晚守护同一个人。' }
        return { success: true, message: `[狼人杀] 已收到您的行动指令，请等待夜晚结束。` }
      }
    },
    [ROLES.HUNTER]: {
      /**
       * 猎人开枪带人。
       * @param {WerewolfGame} game - 游戏实例。
       * @param {object} hunterPlayer - 猎人玩家对象。
       * @param {string} targetPlayerId - 目标玩家的临时ID。
       * @returns {object} 操作结果和消息。
       */
      shoot: (game, hunterPlayer, targetPlayerId) => {
        const targetPlayer = game.players.find(p => p.tempId === targetPlayerId && p.isAlive)
        if (!targetPlayer) return { success: false, message: "目标无效或已死亡。" }
        if (targetPlayer.userId === hunterPlayer.userId) return { success: false, message: "你不能对自己开枪。" }
        return { success: true, message: `猎人 ${game.getPlayerInfo(hunterPlayer.userId)} 开枪带走了 ${game.getPlayerInfo(targetPlayer.userId)}！` }
      }
    },
    [ROLES.WOLF_KING]: {
      /**
       * 狼王发动技能带人。
       * @param {WerewolfGame} game - 游戏实例。
       * @param {object} wolfKingPlayer - 狼王玩家对象。
       * @param {string} targetPlayerId - 目标玩家的临时ID。
       * @returns {object} 操作结果和消息。
       */
      claw: (game, wolfKingPlayer, targetPlayerId) => {
        const targetPlayer = game.players.find(p => p.tempId === targetPlayerId && p.isAlive)
        if (!targetPlayer) return { success: false, message: "目标无效或已死亡。" }
        if (targetPlayer.userId === wolfKingPlayer.userId) return { success: false, message: "你不能对自己使用技能。" }
        return { success: true, message: `狼王 ${game.getPlayerInfo(wolfKingPlayer.userId)} 发动技能，带走了 ${game.getPlayerInfo(targetPlayer.userId)}！` }
      }
    },
    [ROLES.WHITE_WOLF_KING]: {
      /**
       * 白狼王自爆并带人。
       * @param {WerewolfGame} game - 游戏实例。
       * @param {object} whiteWolfKingPlayer - 白狼王玩家对象。
       * @param {string} targetPlayerId - 目标玩家的临时ID (自爆时可能为null)。
       * @returns {object} 操作结果和消息。
       */
      selfDestructClaw: (game, whiteWolfKingPlayer, targetPlayerId) => {
        if (targetPlayerId) {
          const targetPlayer = game.players.find(p => p.tempId === targetPlayerId && p.isAlive)
          if (!targetPlayer) return { success: false, message: "目标无效或已死亡。" }
          if (targetPlayer.userId === whiteWolfKingPlayer.userId) return { success: false, message: "你不能对自己使用技能。" }
          return { success: true, message: `白狼王 ${game.getPlayerInfo(whiteWolfKingPlayer.userId)} 自爆并带走了 ${game.getPlayerInfo(targetPlayer.userId)}！` }
        }
        return { success: true, message: `白狼王 ${game.getPlayerInfo(whiteWolfKingPlayer.userId)} 选择自爆！` }
      }
    }
  }
}


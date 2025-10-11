import { ROLES } from '../roles/roles.js'
import { NIGHT_PHASES, DAY_PHASES } from './phases.js'

/**
 * 游戏状态枚举
 */
const GameStatus = {
  WAITING: 'waiting', // 等待玩家加入
  PLAYING: 'playing', // 游戏进行中
  ENDED: 'ended'      // 游戏已结束
}

/**
 * 游戏核心管理器
 * 负责管理所有狼人杀游戏房间的创建、状态维护和流程控制。
 */
export default class GameManager {
  constructor () {
    /**
     * 存储所有游戏房间的实例
     * @type {Map<string, GameRoom>}
     */
    this.rooms = new Map()
  }

  /**
   * 处理来自插件入口的指令
   * @param {string} command - 指令名称 (e.g., 'create', 'join')
   * @param {object} e - Yunzai的事件对象
   */
  async handleCommand (command, e) {
    try {
      const commandHandler = await import(`../commands/${command}.js`)
      if (commandHandler && typeof commandHandler.default === 'function') {
        commandHandler.default(e, this)
      } else {
        console.error(`[Werewolf] Command handler for '${command}' not found or is not a function.`)
      }
    } catch (error) {
      console.error(`[Werewolf] Error loading command '${command}':`, error)
    }
  }

  /**
   * 创建一个新的游戏房间
   * @param {string} groupId - 群组ID
   * @param {string} ownerId - 创建者ID
   * @returns {GameRoom}
   */
  createRoom(groupId, ownerId) {
    const newRoom = new GameRoom(groupId, ownerId)
    this.rooms.set(groupId, newRoom)
    return newRoom
  }
}

/**
 * 单个游戏房间的类
 * 负责管理一个群组内的游戏状态
 */
export class GameRoom {
  constructor (groupId, ownerId) {
    this.groupId = groupId
    this.ownerId = ownerId
    this.status = GameStatus.WAITING
    /** @type {Map<string, Player>} */
    this.players = new Map()
    this.day = 0 // 当前天数
    this.currentPhase = null // 当前阶段
    this.nightActions = new Map() // 存储夜晚的行动
    this.temporaryState = null // 临时状态，如猎人开枪
    this.temporaryTimer = null // 临时状态的计时器
    
    // 初始化时就将房主加入游戏
    this.addPlayer(ownerId, '房主')
  }

  addPlayer (userId, nickname) {
    if (this.status !== GameStatus.WAITING) {
      // 可以发送消息提示游戏已经开始
      return
    }
    if (this.players.has(userId)) {
      // 可以发送消息提示已经加入
      return
    }
    this.players.set(userId, new Player(userId, nickname))
  }

  startGame () {
    if (this.status !== GameStatus.WAITING) {
      return
    }
    // 至少需要6名玩家才能开始游戏
    if (this.players.size < 6) {
        Bot.sendGroupMsg(this.groupId, `当前玩家人数为 ${this.players.size}，至少需要6人才能开始游戏。`)
        return
    }

    this.status = GameStatus.PLAYING
    this.day = 1
    
    this._assignRoles()
    
    Bot.sendGroupMsg(this.groupId, '游戏开始！月黑风高，杀人夜...')
    this.nextPhase()
  }

  /**
   * 分配角色
   * @private
   */
  _assignRoles() {
    // TODO: 实现更复杂的角色分配逻辑
    const playerIds = Array.from(this.players.keys())
    playerIds.sort(() => Math.random() - 0.5) // 洗牌

    // 简易分配：2狼人，1预言家，1女巫，剩下村民
    const rolesToAssign = [ROLES.WEREWOLF.id, ROLES.WEREWOLF.id, ROLES.PROPHET.id, ROLES.WITCH.id]
    while (rolesToAssign.length < playerIds.length) {
        rolesToAssign.push(ROLES.VILLAGER.id)
    }
    rolesToAssign.sort(() => Math.random() - 0.5)

    playerIds.forEach(async (id, index) => {
        const player = this.players.get(id)
        await player.setRole(rolesToAssign[index])
        // 私聊发送角色信息
        Bot.pickUser(id).sendMsg(`你的身份是：【${ROLES[player.role].name}】`)
    })
  }

  /**
   * 推进到下一个游戏阶段
   */
  nextPhase() {
    const isNight = this.currentPhase ? NIGHT_PHASES.some(p => p.id === this.currentPhase.id) : false

    let nextPhase
    if (!this.currentPhase) {
        // 游戏开始，进入第一个夜晚阶段
        nextPhase = NIGHT_PHASES[0]
    } else {
        const currentPhaseArray = isNight ? NIGHT_PHASES : DAY_PHASES
        const currentIndex = currentPhaseArray.findIndex(p => p.id === this.currentPhase.id)
        
        if (currentIndex < currentPhaseArray.length - 1) {
            // 进入当前周期的下一个阶段
            nextPhase = currentPhaseArray[currentIndex + 1]
        } else {
            // 切换日夜
            if (isNight) {
                this._resolveNightActions() // 结算夜晚
                this.day++
                nextPhase = DAY_PHASES[0]
            } else {
                nextPhase = NIGHT_PHASES[0]
            }
        }
    }
    
    this.currentPhase = nextPhase
    this.broadcast('phaseChanged', { phase: this.currentPhase })
    Bot.sendGroupMsg(this.groupId, `【${this.currentPhase.name}】\n${this.currentPhase.description}`)
  }

  /**
   * 广播事件
   * @param {string} eventName - 事件名称
   * @param {object} payload - 事件负载
   */
  broadcast(eventName, payload) {
    console.log(`[GameRoom ${this.groupId}] Event: ${eventName}`, payload)
    // 将事件名转换为 onXxx 的格式
    const handlerName = `on${eventName.charAt(0).toUpperCase() + eventName.slice(1)}`
    
    for (const player of this.players.values()) {
      if (player.roleInstance && typeof player.roleInstance[handlerName] === 'function') {
        player.roleInstance[handlerName](this, payload)
      }
    }
  }

  /**
   * 设置一个临时状态
   * @param {string} stateName - 状态名称
   * @param {number} duration - 持续时间（秒）
   */
  setTemporaryState(stateName, duration) {
    this.temporaryState = stateName
    if (this.temporaryTimer) clearTimeout(this.temporaryTimer)
    this.temporaryTimer = setTimeout(() => {
        // 临时状态超时后的处理
        this.clearTemporaryState(stateName)
    }, duration * 1000)
  }

  clearTemporaryState(stateName) {
    if (this.temporaryState === stateName) {
        this.temporaryState = null
        clearTimeout(this.temporaryTimer)
        this.temporaryTimer = null
        // TODO: 可以在这里添加超时后的默认行为，比如猎人不选择目标则视为放弃开枪
    }
  }

  /**
   * 结算夜晚行动
   */
  _resolveNightActions() {
    const killedId = this.nightActions.get('wolf_kill')
    const savedId = this.nightActions.get('witch_save')
    const poisonedId = this.nightActions.get('witch_poison')

    let deaths = []

    if (killedId && killedId !== savedId) {
        deaths.push({ id: killedId, reason: 'killed_by_wolf' })
    }
    if (poisonedId) {
        deaths.push({ id: poisonedId, reason: 'poisoned_by_witch' })
    }

    // 清空夜晚行动记录
    this.nightActions.clear()

    if (deaths.length === 0) {
        Bot.sendGroupMsg(this.groupId, '昨夜是平安夜。')
        return
    }

    let deathMessages = []
    for (const death of deaths) {
        const player = this.players.get(death.id)
        if (player && player.isAlive) {
            player.isAlive = false
            deathMessages.push(`${player.nickname} 倒在了血泊中...`)
            this.broadcast('playerDied', { deceasedPlayer: player, reason: death.reason })
        }
    }
    Bot.sendGroupMsg(this.groupId, `天亮了，昨夜...\n${deathMessages.join('\n')}`)
  }

  /**
   * 处理来自私聊的技能指令
   * @param {object} e - Yunzai的事件对象
   */
  handleSkillCommand(e) {
    const player = this.players.get(e.user_id)
    if (!player || !player.isAlive || !player.roleInstance) {
      return // 非玩家或已死亡或无角色实例
    }

    // 检查当前阶段是否是该角色可以行动的阶段
    const roleConfig = ROLES[player.role]
    const activeSkill = roleConfig.skills.find(s => s.phase === this.currentPhase.id && s.type === 'active')

    if (!activeSkill) {
      e.reply('现在不是你的行动时间。')
      return
    }

    // 解析指令
    const [command, ...args] = e.msg.trim().split(/\s+/)
    const targetNumber = parseInt(args[0]) - 1

    if (command === activeSkill.command) {
        if (isNaN(targetNumber) && command !== 'save') { // 'save' (女巫救人) 不需要目标
            e.reply('指令格式错误，请提供有效的目标编号。')
            return
        }
        
        const targetPlayer = Array.from(this.players.values())[targetNumber]
        
        if (player.roleInstance[command]) {
            player.roleInstance[command](this, targetPlayer ? targetPlayer.id : null)
        }
    } else if (this.temporaryState === 'HUNTER_SHOOTING' && command === '开枪') {
        // 特殊处理猎人开枪
        if (player.role === 'HUNTER' && player.roleInstance.shoot) {
            const targetPlayer = Array.from(this.players.values())[targetNumber]
            player.roleInstance.shoot(this, targetPlayer ? targetPlayer.id : null)
        }
    }
  }
}

/**
 * 玩家类
 */
class Player {
  constructor (id, nickname) {
    this.id = id
    this.nickname = nickname
    this.role = null // 角色ID
    this.roleInstance = null // 角色逻辑实例
    this.isAlive = true
    this.isOnline = true // 用于处理掉线等情况
  }

  /**
   * 设置角色并实例化其逻辑
   * @param {string} roleId - 角色ID
   */
  async setRole(roleId) {
    this.role = roleId
    try {
      const RoleClass = (await import(`../roles/${roleId.toLowerCase()}.js`)).default
      this.roleInstance = new RoleClass(this)
    } catch (error) {
      console.error(`[Werewolf] Failed to load role logic for ${roleId}:`, error)
      this.roleInstance = null
    }
  }
}
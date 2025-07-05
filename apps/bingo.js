import plugin from '../../../lib/plugins/plugin.js'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'

// 数据管理类
class DailyData {
  constructor() {
    // 修改数据存储路径到 plugin/resource
    this.dataDir = path.join(process.cwd(), 'data', 'bingo')
    this.initDataDir()
    // 内存数据结构优化
    this.state = {
      date: '',
      correctUsers: new Map(), // 存储用户ID与{timestamp, name}
      hashData: { date: '', imageHash: '', answerHash: '' },
      ranking: new Map()       // 按日期分组的排名数据
    }
    this.resetTimer = null
    this.writeLock = false
  }

  async init() {
    await this.loadPersistentData()
    this.startDailyReset()
  }

  static async create() {
    const instance = new DailyData()
    await instance.init()
    return instance
  }

  initDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true })
    }
  }

  // 统一数据加载
  async loadPersistentData() {
    try {
      await Promise.all([
        this.loadHashData(),
        this.loadRankingData(),
        this.syncDateState()
      ])
    } catch (e) {
      console.error('[Bingo] 数据加载失败:', e)
    }
  }

  loadHashData() {
    const filePath = path.join(this.dataDir, 'hashData.json')
    try {
      if (fs.existsSync(filePath)) {
        this.state.hashData = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      }
    } catch (e) {
      console.error('[Bingo] 加载哈希数据失败:', e)
    }
  }

  // 排名数据存储优化
  loadRankingData() {
    const filePath = path.join(this.dataDir, 'ranking.json')
    try {
      if (fs.existsSync(filePath)) {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        // 转换格式: {日期 -> [{userId, name, timestamp}]}
        const rankingMap = new Map()
        for (const [date, users] of Object.entries(raw)) {
          rankingMap.set(date, users.filter(user =>
            user.userId && user.name && typeof user.timestamp === 'number'
          ))
        }
        this.state.ranking = rankingMap
      }
    } catch (e) {
      console.error('[Bingo] 加载排名数据失败:', e)
    }
  }

  // 日期状态同步
  syncDateState() {
    const today = this.getToday()
    if (this.state.date !== today) {
      this.state.date = today
      this.state.correctUsers.clear()
      // 清空当天的排名数据
      if (this.state.ranking.has(today)) {
        this.state.ranking.delete(today)
      }
    }
    // 加载当天的用户数据
    const dailyFile = path.join(this.dataDir, `${today}.users.json`)
    if (fs.existsSync(dailyFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(dailyFile, 'utf-8'))
        this.state.correctUsers = new Map(data.users.map(u => [u.userId, u]))
        console.log(`[Bingo] 已加载 ${today} 的用户数据`)
      } catch (e) {
        console.error(`[Bingo] 加载 ${today} 用户数据失败:`, e)
      }
    }
  }

  // 每日重置逻辑
  startDailyReset() {
    if (this.resetTimer) {
      clearInterval(this.resetTimer)
    }
    this.resetTimer = setInterval(() => {
      const today = this.getToday()
      if (this.state.date === today) return
      this.persistDailyData(this.state.date)
      this.state.date = today
      this.state.correctUsers.clear()
      // 清空当天的排名数据
      if (this.state.ranking.has(today)) {
        this.state.ranking.delete(today)
        this.saveRankingData()
      }
      console.log(`[Bingo] 已重置每日统计 ${today}`)
    }, 1000 * 60 * 60 * 24)
  }

  // 数据持久化优化
  async persistDailyData(date) {
    if (this.writeLock) {
      console.log('[Bingo] 数据正在写入中，跳过本次写入')
      return
    }
    this.writeLock = true
    try {
      if (!date) return
      // 保存正确用户（带时间戳和名称）
      const userFile = path.join(this.dataDir, `${date}.users.json`)
      const userData = {
        users: [...this.state.correctUsers.values()].map(user => ({
          userId: user.userId,
          name: user.name || '未知用户',
          timestamp: user.timestamp
        }))
      }
      fs.writeFileSync(userFile, JSON.stringify(userData), 'utf-8')
      // 按时间戳排序存储
      const rankingData = [...this.state.correctUsers.values()]
        .filter(user => user.userId && user.name && typeof user.timestamp === 'number')
        .sort((a, b) => a.timestamp - b.timestamp)
      this.state.ranking.set(date, rankingData)
      this.saveRankingData()
    } finally {
      this.writeLock = false
    }
  }

  async retryOperation(operation, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await operation()
      } catch (e) {
        if (i === maxRetries - 1) throw e
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)))
      }
    }
  }

  async saveRankingData() {
    await this.retryOperation(async () => {
      const filePath = path.join(this.dataDir, 'ranking.json')
      const data = Object.fromEntries([...this.state.ranking])
      await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2))
    })
  }

  // 工具方法
  getToday() {
    return new Date().toISOString().split('T')[0]
  }
}

// 初始化数据管理实例
const dataManager = await DailyData.create()

export class BingoPlugin extends plugin {
  constructor() {
    super({
      name: 'Bingo游戏',
      dsc: '每日Bingo挑战插件',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '^#今日bingo$',
          fnc: 'sendBingoImage'
        },
        {
          reg: '^#bingo\\s+([1-5][1-5]\\s*)+$',
          fnc: 'checkAnswer'
        },
        {
          reg: '^#查询Bingo排名$',
          fnc: 'queryRanking'
        }
      ]
    })
  }

  getTodayDataPath() {
    return {
      image: `https://raw.gitcode.com/Sczr0/Daily-Bingo/files/main/data/blank.png`,
      solution: `https://raw.gitcode.com/Sczr0/Daily-Bingo/raw/main/data/solutions.json`
    }
  }

  async fetchSolutions(url) {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error('数据未找到')
      const data = await response.json()
      return data.solutions
    } catch (e) {
      console.error('[Bingo] 获取解决方案失败:', e)
      return null
    }
  }

  generateHash(data) {
    return crypto.createHash('md5').update(data).digest('hex')
  }

  async sendBingoImage() {
    try {
      const { image } = this.getTodayDataPath()
      const today = dataManager.getToday()
      const imageUrl = `${image}?t=${Date.now()}`
      const imageResponse = await fetch(imageUrl)
      if (!imageResponse.ok) throw new Error('图片未找到')
      const imageBuffer = await imageResponse.arrayBuffer()
      const imageHash = this.generateHash(Buffer.from(imageBuffer))
      const solutionUrl = `${this.getTodayDataPath().solution}?t=${Date.now()}`
      const solutions = await this.fetchSolutions(solutionUrl)
      if (!solutions) throw new Error('答案数据未找到')
      const answerHash = this.generateHash(JSON.stringify(solutions))
      if (dataManager.state.hashData.date !== today) {
        dataManager.state.hashData = {
          date: today,
          imageHash: '',
          answerHash: ''
        }
        dataManager.state.correctUsers.clear()
        // 清空当天的排名数据
        if (dataManager.state.ranking.has(today)) {
          dataManager.state.ranking.delete(today)
        }
      }
      const isImageMatch = dataManager.state.hashData.imageHash === imageHash
      const isAnswerMatch = dataManager.state.hashData.answerHash === answerHash
      if (isImageMatch && isAnswerMatch) {
        return await this.reply([
          {
            type: 'image',
            file: image
          },
          `今日已有 ${dataManager.state.correctUsers.size} 人作答正确`,
          '\n提交格式为#bingo xx xx，xx的第1个数代表行，第2个数代表列,比如 13 代表第一行第三列。需要把所有符合条件的格子全部提交，并满足至少一个答案，否则会验证失败',
          '\n使用了聪明bingo游戏的规则，在此标注',
          '\n可通过#查询Bingo排名查看自己的提交排名'
        ])
      } else if (isImageMatch || isAnswerMatch) {
        return await this.reply('题目正在生成中，要不等等看？')
      } else {
        dataManager.state.hashData = {
          date: today,
          imageHash,
          answerHash
        }
        dataManager.state.correctUsers.clear()
        fs.writeFileSync(
          path.join(dataManager.dataDir, 'hashData.json'),
          JSON.stringify(dataManager.state.hashData, null, 2)
        )
        return await this.reply([
          {
            type: 'image',
            file: image
          },
          `今日已有 ${dataManager.state.correctUsers.size} 人作答正确`,
          '\n（题目已更新）',
          '\n提交格式为#bingo xx xx，xx的第1个数代表行，第2个数代表列,比如 13 代表第一行第三列。需要把所有符合条件的格子全部提交，并满足至少一个答案，否则会验证失败',
          '\n使用了聪明bingo游戏的规则，在此标注',
          '\n可通过#查询Bingo排名查看自己的提交排名'
        ])
      }
    } catch (e) {
      await this.reply('获取今日题目失败，请稍后再试')
      console.error('[Bingo] 发送图片失败:', e)
    }
  }

  parseInput(input) {
    const coords = new Set()
    const matches = input.matchAll(/([1-5])([1-5])/g)
    for (const match of matches) {
      const row = parseInt(match[1]) - 1
      const col = parseInt(match[2]) - 1
      coords.add(`${row},${col}`)
    }
    return coords.size > 0 ? coords : null
  }

  async checkAnswer() {
    const userId = this.e.user_id
    const userName = this.e.sender.card || this.e.sender.nickname
    const input = this.e.msg
    try {
      const userCoords = this.parseInput(input)
      if (!userCoords) {
        return await this.reply('坐标格式错误，栗子（例子）：#bingo 11 23 35\n需要把所有符合条件的格子全部提交，并满足至少一个答案，否则会验证失败')
      }
      const { solution } = this.getTodayDataPath()
      const solutions = await this.fetchSolutions(solution)
      if (!solutions || solutions.length === 0) {
        return await this.reply('今日题目数据尚未生成，等等看')
      }
      const solutionHashes = solutions.map(grid => {
        const cells = grid.flatMap((row, x) =>
          row.filter(cell => cell.checked)
            .map(cell => `${x},${cell.y}`)
        )
        return new Set(cells)
      })
      const userHash = new Set([...userCoords])
      const isValid = solutionHashes.some(solutionHash =>
        solutionHash.size === userHash.size &&
        [...solutionHash].every(coord => userHash.has(coord))
      )
      if (isValid) {
        if (!dataManager.state.correctUsers.has(userId)) {
          // 记录用户信息和提交时间
          dataManager.state.correctUsers.set(userId, {
            userId,
            name: userName || '未知用户',
            timestamp: Date.now()
          })
          dataManager.persistDailyData(dataManager.getToday())
          await this.reply([
            `🎉 作答正确！`,
            `\n你是今日第${dataManager.state.correctUsers.size}位回答正确者呢(￣▽￣)*`
          ])
        } else {
          const ranking = this.getUserRanking(userId)
          const userData = dataManager.state.correctUsers.get(userId)
          const timeStr = this.formatTime(userData.timestamp)
          await this.reply([
            `你已经提交过答案了呢awa`,
            `你今日的排名是第${ranking}位，提交时间: ${timeStr}`
          ])
        }
      } else {
        return await this.reply('❌ 验证失败，可能是部分格子不满足条件/没有五连勾QWQ')
      }
    } catch (e) {
      await this.reply('验证服务暂时不可用')
      console.error('[Bingo] 验证错误:', e)
    }
  }

  // 获取用户今日排名
  getUserRanking(userId) {
    const today = dataManager.getToday()
    const dailyRanking = dataManager.state.ranking.get(today) || []
    const index = dailyRanking.findIndex(u => u.userId === userId)
    return index === -1 ? -1 : index + 1
  }

  // 格式化时间
  formatTime(timestamp) {
    const date = new Date(timestamp)
    const hours = date.getHours().toString().padStart(2, '0')
    const minutes = date.getMinutes().toString().padStart(2, '0')
    const seconds = date.getSeconds().toString().padStart(2, '0')
    const milliseconds = date.getMilliseconds().toString().padStart(3, '0')
    return `${hours}:${minutes}:${seconds}.${milliseconds}`
  }

  async queryRanking() {
    const userId = this.e.user_id
    const userName = this.e.sender.card || this.e.sender.nickname
    const today = dataManager.getToday()
    const rankingData = dataManager.state.ranking.get(today) || []
    
    // 获取前三名信息
    let top3Msg = '🏆 今日前三名:\n'
    if (rankingData.length > 0) {
      const top3 = rankingData.slice(0, 3)
      top3.forEach((user, index) => {
        top3Msg += `${index + 1}. ${user.name || '未知用户'} (${this.formatTime(user.timestamp)})\n`
      })
    } else {
      top3Msg += '暂无排名数据~\n'
    }
  
    // 获取用户自己的排名信息
    const userIndex = rankingData.findIndex(u => u.userId === userId)
    if (userIndex !== -1) {
      const userData = rankingData[userIndex]
      await this.reply([
        top3Msg,
        `\n你的排名: 第${userIndex + 1}位`,
        `\n提交时间: ${this.formatTime(userData.timestamp)}`
      ])
    } else {
      await this.reply([
        top3Msg,
        `\n${userName || '未知用户'}，你今日尚未提交答案呢(￣▽￣)`
      ])
    }
  }
}

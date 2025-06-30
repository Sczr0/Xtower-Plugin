import fs from 'node:fs'
import path from 'node:path'
import lodash from 'lodash'

// --- 基础路径定义 ---
const _path = process.cwd().replace(/\\/g, '/')
const resourcesPath = path.join(_path, 'plugins/Xtower-Plugin/resources')
const questionsFile = path.join(resourcesPath, 'questions.json')

// --- Redis Key 前缀 ---
const redisKey = {
  answers: (questionId) => `Yunzai:ningke:answers:${questionId}`,
  lastQuestion: (userId) => `Yunzai:ningke:last_q:${userId}`
}

// --- 插件主体 ---
export class NingkePlugin extends plugin {
  constructor () {
    super({
      name: '你宁可',
      dsc: '你宁可？',
      event: 'message',
      priority: 500,
      rule: [
        { reg: '^#你宁可$', fnc: 'getQuestion' },
        { reg: '^#选择([AB12])$', fnc: 'chooseContext' },
        { reg: '^#选择(\\d+)\\s*([AB12])$', fnc: 'chooseById' },
        { reg: '^#查看(\\d+)$', fnc: 'viewStats' },
        { reg: '^#清除(我的)?选择(\\d+)$', fnc: 'clearMyChoice' },
        { reg: '^#清除选择(\\d+)\\s*(\\d+|\[CQ:at,qq=\\d+\])$', fnc: 'clearOtherChoice', permission: 'master' }
      ]
    })

    this.allQuestions = this.loadQuestions()
  }

  loadQuestions () {
    if (!fs.existsSync(resourcesPath)) {
      fs.mkdirSync(resourcesPath, { recursive: true })
    }
    if (!fs.existsSync(questionsFile)) {
      return null
    }
    try {
      const json = fs.readFileSync(questionsFile, 'utf8')
      const data = JSON.parse(json)
      const flattened = []
      for (const group in data) {
        for (const id in data[group]) {
          flattened.push({ id, group, options: data[group][id] })
        }
      }
      return flattened
    } catch (error) {
      return null
    }
  }

  getQuestionById (id) {
    if (!this.allQuestions) return null
    return this.allQuestions.find(q => q.id === id)
  }

  async getUserChoice (questionId, userId) {
    return redis.hGet(redisKey.answers(questionId), String(userId))
  }

  async getQuestion (e) {
    if (!this.allQuestions || this.allQuestions.length === 0) {
      return e.reply('题库空空如也，快让我的主人去添加题目吧！', true)
    }
    const question = lodash.sample(this.allQuestions)
    if (!question) {
      return e.reply('糟糕，随机抽取题目失败了！', true)
    }
    await redis.set(redisKey.lastQuestion(e.user_id), question.id, { EX: 300 })
    const msg = [
      `问题编号：#${question.id}`,
      `分组：${question.group}`,
      '你宁可',
      `A. ${question.options.A}`,
      'or',
      `B. ${question.options.B}`,
      '\n发送「#选择A」或「#选择B」进行回答\n发送「#查看' + question.id + '」看统计'
    ]
    await e.reply(msg.join('\n'))
  }

  async chooseContext (e) {
    const questionId = await redis.get(redisKey.lastQuestion(e.user_id))
    if (!questionId) {
      return e.reply('你还没有最近的题目哦，请使用「#选择<编号><选项>」来回答指定的题目吧~', true)
    }
    e.questionId = questionId
    return this.choose(e)
  }

  async chooseById (e) {
    e.questionId = e.msg.match(/^#选择(\d+)/)[1]
    return this.choose(e)
  }

  async choose (e) {
    const questionId = e.questionId
    let choice = e.msg.match(/[AB12]$/i)[0].toUpperCase()
    if (choice === '1') choice = 'A'
    if (choice === '2') choice = 'B'
    const question = this.getQuestionById(questionId)
    if (!question) {
      return e.reply(`编号为「${questionId}」的题目不存在哦。`, true)
    }
    const previousChoice = await this.getUserChoice(questionId, e.user_id)
    if (previousChoice) {
      await e.reply('你已经选择过了，不能反悔哦！', true)
      return this.viewStats(e)
    }
    await redis.hSet(redisKey.answers(questionId), String(e.user_id), choice)
    await e.reply(`你选择了 ${choice} 项，选择成功！`, true)
    return this.viewStats(e)
  }

  async viewStats (e) {
    const questionId = e.questionId || e.msg.match(/^#查看(\d+)/)[1]
    const question = this.getQuestionById(questionId)

    if (!question) {
      return e.reply(`编号为「${questionId}」的题目不存在哦。`, true)
    }
    
    const allAnswers = await redis.hGetAll(redisKey.answers(questionId))
    const total = Object.keys(allAnswers).length

    const minVotes = 5;
    if (total < minVotes) {
      return e.reply(`该问题投票人数不足${minVotes}人（当前${total}人），结果暂时保密哦~`, true)
    }
    const userChoice = allAnswers[String(e.user_id)]
    if (!userChoice) {
      return e.reply('你需要先对这个问题投票后才能查看结果哦！\n发送「#选择' + questionId + 'A」或「#选择' + questionId + 'B」即可投票。', true)
    }

    let countA = 0
    let countB = 0
    for (const userId in allAnswers) {
      if (allAnswers[userId] === 'A') countA++
      if (allAnswers[userId] === 'B') countB++
    }
    const percentA = total > 0 ? ((countA / total) * 100).toFixed(1) : '0.0'
    const percentB = total > 0 ? ((countB / total) * 100).toFixed(1) : '0.0'

    const msg = [
      `--- 题目 #${question.id} 统计 ---`,
      `你宁可\nA. ${question.options.A}\nB. ${question.options.B}`,
      '--------------------',
      `A: ${countA}人 (${percentA}%)`,
      `B: ${countB}人 (${percentB}%)`,
      `总计: ${total}人参与`,
      '--------------------',
      `你的选择是：${userChoice} (${userChoice === 'A' ? question.options.A : question.options.B})`
    ]

    await e.reply(msg.join('\n'))
  }

  async clearMyChoice (e) {
    if (!e.isMaster) {
      return e.reply('抱歉，为了游戏的公平性，选择不能随意清除哦。', true)
    }
    const questionId = e.msg.match(/(\d+)$/)[1]
    const question = this.getQuestionById(questionId)
    if (!question) {
      return e.reply(`编号为「${questionId}」的题目不存在哦。`, true)
    }
    const res = await redis.hDel(redisKey.answers(questionId), String(e.user_id))
    if (res > 0) {
      await e.reply(`你对于题目 #${questionId} 的选择记录已被清除。`, true)
    } else {
      await e.reply(`你本来就没有回答过题目 #${questionId} 哦。`, true)
    }
  }
  async clearOtherChoice (e) {
    const questionId = e.msg.match(/^#清除选择(\d+)/)[1]
    let targetId
    if (e.at) {
      targetId = e.at
    } else {
      targetId = e.msg.match(/\s(\d+)$/)?.[1]
    }
    if (!targetId) {
      return e.reply('请指定要清除的用户QQ或@对方。', true)
    }
    const question = this.getQuestionById(questionId)
    if (!question) {
      return e.reply(`编号为「${questionId}」的题目不存在哦。`, true)
    }
    const res = await redis.hDel(redisKey.answers(questionId), String(targetId))
    if (res > 0) {
      await e.reply(`用户 ${targetId} 对于题目 #${questionId} 的选择记录已被清除。`, true)
    } else {
      await e.reply(`用户 ${targetId} 并未回答过题目 #${questionId}。`, true)
    }
  }
}
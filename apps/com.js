import plugin from '../../../lib/plugins/plugin.js'
import { getConfigSection } from '../utils/config.js'

// ================= 配置入口 =================
// 统一读取 quickMath 配置，避免多处重复读写 YAML
const QUICK_MATH_CONFIG = getConfigSection('quickMath')

// 使用 Map 存储玩家状态
const pendingQuestions = new Map()

// 辅助函数库：用于生成不同难度的题目
const questionGenerators = {
  '简单': {
    '+': () => ({ num1: Math.floor(Math.random() * 20) + 1, num2: Math.floor(Math.random() * 20) + 1 }),
    '-': () => {
      let num1, num2;
      do { num1 = Math.floor(Math.random() * 19) + 2; num2 = Math.floor(Math.random() * (num1 - 1)) + 1; } 
      while (String(num1).split('').some((d, i) => d < String(num2).padStart(String(num1).length, '0')[i]));
      return { num1, num2 };
    }
  },
  '普通': {
    '+': () => {
      let num1, num2;
      do { num1 = Math.floor(Math.random() * 90) + 10; num2 = Math.floor(Math.random() * 90) + 10; } 
      while ((num1 % 10 + num2 % 10) < 10);
      return { num1, num2 };
    },
    '-': () => {
      let num1, num2;
      do { num1 = Math.floor(Math.random() * 90) + 10; num2 = Math.floor(Math.random() * 90) + 10; if (num1 < num2) [num1, num2] = [num2, num1]; } 
      while ((num1 % 10) >= (num2 % 10));
      return { num1, num2 };
    },
    '*': () => ({ num1: Math.floor(Math.random() * 90) + 10, num2: Math.floor(Math.random() * 8) + 2 })
  },
  '困难': {
    '+': () => {
      let n1, n2;
      do { n1 = Math.floor(Math.random() * 900) + 100; n2 = Math.floor(Math.random() * 900) + 100; }
      while ((n1 % 100 + n2 % 100) < 100 || (n1 % 10 + n2 % 10) < 10);
      return { num1: n1, num2: n2 };
    },
    '-': () => {
      let n1, n2;
      do { n1 = Math.floor(Math.random() * 900) + 100; n2 = Math.floor(Math.random() * 900) + 100; if (n1 < n2) [n1, n2] = [n2, n1]; }
      while ((n1 % 10) >= (n2 % 10) || (Math.floor(n1/10)%10) >= (Math.floor(n2/10)%10));
      return { num1: n1, num2: n2 };
    },
    '*': () => ({ num1: Math.floor(Math.random() * 90) + 10, num2: Math.floor(Math.random() * 90) + 10 }),
    '/': () => ({ num1: Math.floor(Math.random() * 900) + 100, num2: Math.floor(Math.random() * 8) + 2, isRemainder: true })
  },
  '地狱': {
    '+': () => ({ num1: Math.floor(Math.random() * 90000) + 1000, num2: Math.floor(Math.random() * 90000) + 1000 }),
    '-': () => ({ num1: Math.floor(Math.random() * 90000) + 1000, num2: Math.floor(Math.random() * 90000) + 1000, swap: true }),
    '*': () => ({ num1: Math.floor(Math.random() * 900) + 100, num2: Math.floor(Math.random() * 90) + 10 }),
    '/': () => ({ num1: Math.floor(Math.random() * 9000) + 1000, num2: Math.floor(Math.random() * 90) + 10, isRemainder: true })
  }
};

export class QuickMath extends plugin {
  constructor() {
    super({
      name: '自定义速算',
      dsc: '一个可自定义难度的速算小游戏',
      event: 'message',
      priority: 500,
      rule: [
        { reg: '^#速算(简单|普通|困难|地狱)?$', fnc: 'startNormalMode' },
        { reg: '^#无尽速算(简单|普通|困难|地狱)?$', fnc: 'startEndlessMode' }
      ]
    });
    // 通过统一入口获取速算配置
    this.config = QUICK_MATH_CONFIG;
    this.logger = {
        mark: (...args) => console.log('[QuickMath MARK]', ...args),
        error: (...args) => console.error('[QuickMath ERROR]', ...args),
        warn: (...args) => console.warn('[QuickMath WARN]', ...args)
    }
  }

  get isContext() {
    return this.e?.user_id && pendingQuestions.has(this.e.user_id);
  }

  async startNormalMode(e) {
    if (this.isContext) return e.reply('你已经有一个游戏在进行中了！', true);
    
    // 【新增】输入验证
    let level = e.msg.replace('#速算', '').trim() || '简单';
    const allowedLevels = Object.keys(questionGenerators);
    if (!allowedLevels.includes(level)) {
      level = '简单'; // 如果用户输入了无效难度，则默认为简单
    }
    
    await this.startGame(e, level, 'normal');
  }

  async startEndlessMode(e) {
    if (this.isContext) return e.reply('你已经有一个游戏在进行中了！', true);

    // 【新增】输入验证
    let level = e.msg.replace('#无尽速算', '').trim() || '简单';
    const allowedLevels = Object.keys(questionGenerators);
    if (!allowedLevels.includes(level)) {
      level = '简单';
    }
    
    await e.reply(`【无尽模式-${level}】已开启！答对一题自动进入下一题，答错、超时或放弃则结束。`, true, { at: true });
    await this.startGame(e, level, 'endless');
  }

  async startGame(e, level, mode) {
    this.setContext('handleAnswer');
    await this.sendNewQuestion(e, level, mode, true);
  }

  async sendNewQuestion(e, level, mode, isFirstQuestion = false) {
    const userId = e.user_id;
    const operators = Object.keys(questionGenerators[level]);
    const operator = operators[Math.floor(Math.random() * operators.length)];
    const gen = questionGenerators[level][operator]();
    let { num1, num2, isRemainder, swap } = gen;

    if (swap && num1 < num2) [num1, num2] = [num2, num1];
    
    let answer;
    if (operator === '+') answer = num1 + num2;
    else if (operator === '-') answer = num1 - num2;
    else if (operator === '*') answer = num1 * num2;
    else if (operator === '/') {
      if (isRemainder) answer = `${Math.floor(num1 / num2)} ${num1 % num2}`;
      else answer = num1 / num2;
    }
    
    let question = `${num1} ${operator.replace('*','×').replace('/','÷')} ${num2} = ?`;
    if (isRemainder) {
      question += " (格式: 商 余数)";
    }

    const oldData = pendingQuestions.get(userId);
    if (oldData) clearTimeout(oldData.timeout);
    
    const gameTimeout = this.config.answer_timeout_ms;
    const timeout = setTimeout(() => {
      if (pendingQuestions.has(userId)) {
        const data = pendingQuestions.get(userId);
        this.finish('handleAnswer');
        pendingQuestions.delete(userId);
        let replyMsg = `回答超时！正确答案是 ${data.answer}。`;
        if (data.mode === 'endless') replyMsg += `\n你在无尽模式中连续答对了 ${data.score} 题！`;
        e.reply(replyMsg, true);
      }
    }, gameTimeout);

    pendingQuestions.set(userId, {
      answer: String(answer),
      level: level,
      mode: mode,
      score: isFirstQuestion ? 0 : (oldData?.score || 0),
      timeout: timeout,
      attempts: 1
    });

    let questionText = `请在60秒内回答：\n${question}`;
    if (mode === 'endless') {
      questionText = `第 ${pendingQuestions.get(userId).score + 1} 题：\n${question}`;
    }
    await e.reply(questionText, true, { at: isFirstQuestion });
  }

  handleAnswer() {
    const e = this.e;
    const userId = e.user_id;
    const questionData = pendingQuestions.get(userId);

    if (!questionData) {
      this.finish('handleAnswer');
      return;
    }

    if (/^#?放弃$/.test(e.msg)) {
      return this.giveUp();
    }
    
    const userAnswer = e.msg.trim().replace(/\s+/g, ' ');

    if (userAnswer === questionData.answer) {
      if (questionData.mode === 'endless') {
        questionData.score++;
        e.reply(`回答正确！当前积分: ${questionData.score}。`, true);
        this.sendNewQuestion(e, questionData.level, 'endless');
      } else {
        e.reply('恭喜你，回答正确！', true);
        this.finish('handleAnswer');
        clearTimeout(questionData.timeout);
        pendingQuestions.delete(userId);
      }
      return true;
    } else {
      if (questionData.mode === 'endless') {
        let replyMsg = `回答错误！正确答案是 ${questionData.answer}。\n你在本次无尽模式中最终获得了 ${questionData.score} 分！`;
        e.reply(replyMsg, true);
        this.finish('handleAnswer');
        clearTimeout(questionData.timeout);
        pendingQuestions.delete(userId);
        return true;
      }
      
      const maxAttempts = this.config.normal_mode_max_attempts;
      if (questionData.attempts >= maxAttempts) {
        e.reply(`回答错误超过${maxAttempts}次！正确答案是 ${questionData.answer}。`, true);
        this.finish('handleAnswer');
        clearTimeout(questionData.timeout);
        pendingQuestions.delete(userId);
      } else {
        questionData.attempts++;
        e.reply(`回答错误，你还有 ${maxAttempts + 1 - questionData.attempts} 次机会。`, true);
      }
    }
  }

  giveUp() {
    const e = this.e;
    const userId = e.user_id;
    const questionData = pendingQuestions.get(userId);
    if (!questionData) return;

    this.finish('handleAnswer');
    clearTimeout(questionData.timeout);
    pendingQuestions.delete(userId);
    
    let replyMsg = `你选择放弃了，正确答案是 ${questionData.answer}。`;
    if (questionData.mode === 'endless') {
      replyMsg += `\n你在本次无尽模式中最终获得了 ${questionData.score} 分！`;
    }
    e.reply(replyMsg, true);
  }
}

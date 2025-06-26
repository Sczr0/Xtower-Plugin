function normalizeString(str) {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const charCode = str.charCodeAt(i);
    if (charCode >= 65281 && charCode <= 65374) {
      result += String.fromCharCode(charCode - 65248);
    } else if (charCode === 12288) {
      result += ' ';
    } else {
      result += str[i];
    }
  }
  return result.replace(/（/g, '(').replace(/）/g, ')').replace(/×/g, '*').replace(/÷/g, '/');
}

function judgeExpression(expression, numbers, target = 24) {
  try {
    const normalizedExpr = normalizeString(expression);
    const numsInExpr = normalizedExpr.match(/\d+/g);
    if (!numsInExpr || numsInExpr.length !== numbers.length) {
      return { success: false, message: `错误：必须使用且仅使用 ${numbers.length} 个给定的数字。`, result: null };
    }
    const sortedNumsInExpr = numsInExpr.map(Number).sort((a, b) => a - b);
    const sortedGivenNums = [...numbers].sort((a, b) => a - b);
    if (JSON.stringify(sortedNumsInExpr) !== JSON.stringify(sortedGivenNums)) {
      return { success: false, message: `错误：使用的数字 [${numsInExpr.join(', ')}] 与给定的数字 [${numbers.join(', ')}] 不符。`, result: null };
    }
    const safetyRegex = /[^0-9+\-*/().\s]/g;
    if (safetyRegex.test(normalizedExpr)) {
      const invalidChars = normalizedExpr.match(safetyRegex).join('');
      return { success: false, message: `错误：表达式包含非法字符: ${invalidChars}`, result: null };
    }
    const calculate = new Function(`return ${normalizedExpr}`);
    const result = calculate();
    if (!isFinite(result)) {
      return { success: false, message: '错误：计算结果无效（可能除以了零）。', result };
    }
    if (Math.abs(result - target) < 1e-9) {
      return { success: true, message: `恭喜！计算结果为 ${result}，正确！`, result };
    } else {
      return { success: false, message: `抱歉，计算结果为 ${result}，不等于 ${target}。`, result };
    }
  } catch (error) {
    return { success: false, message: `错误：表达式语法无效。`, result: null };
  }
}

function solveTargetNumber(numbers, target) {
  function find(nums) {
    if (nums.length === 1) {
      return Math.abs(nums[0].value - target) < 1e-9 ? nums[0].expr : null;
    }
    for (let i = 0; i < nums.length; i++) {
      for (let j = i + 1; j < nums.length; j++) {
        const a = nums[i];
        const b = nums[j];
        const remaining = nums.filter((_, index) => index !== i && index !== j);
        const operations = [
          { value: a.value + b.value, expr: `(${a.expr} + ${b.expr})` },
          { value: a.value - b.value, expr: `(${a.expr} - ${b.expr})` },
          { value: b.value - a.value, expr: `(${b.expr} - ${a.expr})` },
          { value: a.value * b.value, expr: `(${a.expr} * ${b.expr})` },
        ];
        if (b.value !== 0) operations.push({ value: a.value / b.value, expr: `(${a.expr} / ${b.expr})` });
        if (a.value !== 0) operations.push({ value: b.value / a.value, expr: `(${b.expr} / ${a.value})` });
        for (const op of operations) {
          const solution = find([...remaining, { value: op.value, expr: op.expr }]);
          if (solution) return solution;
        }
      }
    }
    return null;
  }
  const initialNums = numbers.map(n => ({ value: n, expr: `${n}` }));
  const finalSolution = find(initialNums);
  return { canSolve: !!finalSolution, solution: finalSolution };
}

function generate24PointPuzzle(min = 1, max = 10) {
  while (true) {
    const numbers = Array.from({ length: 4 }, () => Math.floor(Math.random() * (max - min + 1)) + min);
    const result = solveTargetNumber(numbers, 24);
    if (result.canSolve) {
      return { numbers, solution: result.solution };
    }
  }
}

export class twentyFourGame extends plugin {
  constructor() {
    super({
      name: '24点游戏',
      dsc: '24点出题、判题、游戏、求解',
      event: 'message',
      priority: 500,
      rule: [
        {
          reg: '^#?(24点|开始24点|出题)$',
          fnc: 'startGame'
        },
        {
          reg: /^#?求解\s*([\d\s,]+)$/,
          fnc: 'solveCustomProblem'
        },
        {
          reg: '^#?(24点)?答案$',
          fnc: 'getAnswer'
        },
        {
          reg: '^#?结束(24点)?$',
          fnc: 'endGame'
        },
        {
          reg: '^#?24点帮助$',
          fnc: 'showHelp'
        },
        {
          reg: /^(?=.*\d)(?=.*[+\-*/×÷（）()])[\d\s()（）+*/-×÷.]+$/,
          fnc: 'handleAnswer'
        }
      ]
    });

    this.gameSession = new Map();
  }

  getSessionId(e) {
    return e.isGroup ? e.group_id : e.user_id;
  }

  async startGame(e) {
    const sessionId = this.getSessionId(e);
    if (this.gameSession.has(sessionId)) {
      const existingGame = this.gameSession.get(sessionId);
      await e.reply(`你已经有一个游戏在进行中了！\n题目是：[${existingGame.numbers.join(', ')}]`, true);
      return;
    }
    const puzzle = generate24PointPuzzle();
    this.gameSession.set(sessionId, puzzle);
    const msg = `新的一局24点开始啦！\n请用下面这四个数字算出24：\n【 ${puzzle.numbers.join(', ')} 】\n请直接发送你的算式，如: (8-2)*4`;
    await e.reply(msg, true);
  }
  
  async handleAnswer(e) {
    const sessionId = this.getSessionId(e);
    if (!this.gameSession.has(sessionId)) return false;
    const puzzle = this.gameSession.get(sessionId);
    const result = judgeExpression(e.msg, puzzle.numbers, 24);
    if (result.success) {
      await e.reply(`回答正确！恭喜你！\n${result.message}`, true);
      this.gameSession.delete(sessionId);
    } else {
      await e.reply(result.message, true);
    }
  }

  async solveCustomProblem(e) {
    const sessionId = this.getSessionId(e);
    // 1. 解析用户输入的数字
    const numbersStr = e.reg.exec(e.msg)[1];
    const customNumbers = numbersStr.split(/[\s,]+/).filter(n => n).map(Number);
    
    if (customNumbers.some(isNaN) || customNumbers.length === 0) {
      await e.reply('请输入有效的数字哦，例如：#求解 1 2 3 4', true);
      return;
    }

    // 2. 反作弊检查
    if (this.gameSession.has(sessionId)) {
      const gameNumbers = this.gameSession.get(sessionId).numbers;
      // 排序后比较，确保与顺序无关
      const sortedGameNumbers = [...gameNumbers].sort((a,b) => a-b);
      const sortedCustomNumbers = [...customNumbers].sort((a,b) => a-b);

      if (JSON.stringify(sortedGameNumbers) === JSON.stringify(sortedCustomNumbers)) {
        await e.reply('嘿！不能用求解指令来算当前的游戏题目哦！', true);
        return;
      }
    }

    // 3. 执行求解
    const result = solveTargetNumber(customNumbers, 24);
    if (result.canSolve) {
      await e.reply(`[${customNumbers.join(', ')}] 的一个解是：\n${result.solution}`, true);
    } else {
      await e.reply(`[${customNumbers.join(', ')}] 无法计算出24。`, true);
    }
  }

  async getAnswer(e) {
    const sessionId = this.getSessionId(e);
    if (!this.gameSession.has(sessionId)) {
      await e.reply('当前没有正在进行的24点游戏哦，发送 #24点 开始一局吧！', true);
      return;
    }
    const puzzle = this.gameSession.get(sessionId);
    await e.reply(`参考答案是：${puzzle.solution}\n本局游戏已结束。`, true);
    this.gameSession.delete(sessionId);
  }
  
  async endGame(e) {
    const sessionId = this.getSessionId(e);
    if (this.gameSession.has(sessionId)) {
      this.gameSession.delete(sessionId);
      await e.reply('好的，本局24点游戏已结束。', true);
    } else {
      await e.reply('当前没有正在进行的24点游戏哦。', true);
    }
  }

  async showHelp(e) {
    const helpMsg = [
      '--- 24点游戏帮助 ---\n',
      '#24点 : 开始一局新游戏\n',
      '发送算式 (如 8/2+2*10 ) : 提交答案\n',
      '#求解 1 2 3 4 : 求解指定的数字组合\n', // 新增帮助条目
      '#答案 : 查看当前题目答案并结束\n',
      '#结束24点 : 放弃并结束当前游戏'
    ].join('');
    await e.reply(helpMsg, true);
  }
}
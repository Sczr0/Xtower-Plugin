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


// ---- 插件主类 ----

export class twentyFourGame extends plugin {
  constructor() {
    super({
      name: '24点游戏',
      dsc: '24点出题、判题、游戏、求解',
      event: 'message',
      priority: 100,
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
          // 修正了正则表达式中 `-` 的问题
          reg: /^(?=.*\d)(?=.*[+\-*\/×÷（）()])[\d\s()（）+*\/\-×÷.]+$/,
          fnc: 'handleAnswer'
        }
      ]
    });
  }

  // 获取会话ID
  getSessionId(e) {
    return e.isGroup ? `${e.group_id}_${e.user_id}` : e.user_id;
  }
  
  // 获取Redis键
  getRedisKey(e) {
      return `Yunzai:xtower-plugin:24game:${this.getSessionId(e)}`;
  }

  // 开始游戏 (使用Redis)
  async startGame(e) {
    const redisKey = this.getRedisKey(e);

    if (await redis.get(redisKey)) {
      const existingGameRaw = await redis.get(redisKey);
      const existingGame = JSON.parse(existingGameRaw);
      await e.reply(`你已经有一个游戏在进行中了！\n题目是：[${existingGame.numbers.join(', ')}]`, true);
      return;
    }

    const puzzle = generate24PointPuzzle();
    // 设置15分钟过期时间
    await redis.set(redisKey, JSON.stringify(puzzle), { EX: 60 * 15 }); 
    
    const msg = `新的一局24点开始啦！\n请用下面这四个数字算出24：\n【 ${puzzle.numbers.join(', ')} 】\n请直接发送你的算式，如: (8-2)*4，不用发等于号`;
    await e.reply(msg, true);
  }
  
  // 处理答案 (使用Redis)
  async handleAnswer(e) {
    const redisKey = this.getRedisKey(e);
    const gameDataRaw = await redis.get(redisKey);

    if (!gameDataRaw) {
      return false; 
    }
    
    const puzzle = JSON.parse(gameDataRaw);
    const result = judgeExpression(e.msg, puzzle.numbers, 24);

    if (result.success) {
      await e.reply(`回答正确！恭喜你！\n${result.message}`, true);
      await redis.del(redisKey);
    } else {
      await e.reply(result.message, true);
    }
  }

  // 求解自定义题目 (进行反作弊检查)
  async solveCustomProblem(e) {
    const redisKey = this.getRedisKey(e);

    const regex = /^#?求解\s*([\d\s,]+)$/;
    const match = regex.exec(e.msg);

    if (!match || !match[1]) {
      e.reply('处理求解指令时发生内部错误，无法解析数字。');
      return false;
    }

    const numbersStr = match[1];
    const customNumbers = numbersStr.split(/[\s,]+/).filter(n => n).map(Number);
    
    if (customNumbers.some(isNaN) || customNumbers.length === 0) {
      await e.reply('请输入有效的数字哦，例如：#求解 1 2 3 4', true);
      return;
    }

    const gameDataRaw = await redis.get(redisKey);
    if (gameDataRaw) {
      const gameNumbers = JSON.parse(gameDataRaw).numbers;
      const sortedGameNumbers = [...gameNumbers].sort((a,b) => a-b);
      const sortedCustomNumbers = [...customNumbers].sort((a,b) => a-b);

      if (JSON.stringify(sortedGameNumbers) === JSON.stringify(sortedCustomNumbers)) {
        await e.reply('嘿！不能用求解指令来算当前的游戏题目哦！', true);
        return;
      }
    }

    const result = solveTargetNumber(customNumbers, 24);
    if (result.canSolve) {
      await e.reply(`[${customNumbers.join(', ')}] 的一个解是：\n${result.solution}`, true);
    } else {
      await e.reply(`[${customNumbers.join(', ')}] 无法计算出24。`, true);
    }
  }

  // 获取答案
  async getAnswer(e) {
    const redisKey = this.getRedisKey(e);
    const gameDataRaw = await redis.get(redisKey);

    if (!gameDataRaw) {
      await e.reply('当前没有正在进行的24点游戏哦，发送 #24点 开始一局吧！', true);
      return;
    }
    const puzzle = JSON.parse(gameDataRaw);
    await e.reply(`参考答案是：${puzzle.solution}\n本局游戏已结束。`, true);
    await redis.del(redisKey);
  }
  
  // 结束游戏
  async endGame(e) {
    const redisKey = this.getRedisKey(e);
    
    if (await redis.get(redisKey)) {
      await redis.del(redisKey);
      await e.reply('好的，本局24点游戏已结束。', true);
    } else {
      await e.reply('当前没有正在进行的24点游戏哦。', true);
    }
  }

  // 显示帮助
  async showHelp(e) {
    const helpMsg = [
      '--- 24点游戏帮助 ---\n',
      '#24点 : 开始一局新游戏\n',
      '发送算式 (如 8/2+2*10 ) : 提交答案\n',
      '#求解 1 2 3 4 : 求解指定的数字组合\n',
      '#答案 : 查看当前题目答案并结束\n',
      '#结束24点 : 放弃并结束当前游戏'
    ].join('');
    await e.reply(helpMsg, true);
  }
}
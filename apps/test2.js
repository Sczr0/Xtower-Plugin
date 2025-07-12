import lodash from 'lodash';

// 模拟次数，建议值在 100,000 到 1,000,000 之间。
// 次数越高，结果越接近理论期望值，但计算时间越长。10万次在现代CPU上通常很快。
const SIMULATION_COUNT = 200000;

export class gachaCalc extends plugin {
  constructor() {
    super({
      name: '抽卡期望计算',
      dsc: '计算原神/星铁抽卡期望，发送 #期望计算帮助 查看详情',
      event: 'message',
      priority: 500,
      rule: [
        {
          reg: '^#期望计算帮助$',
          fnc: 'showHelp',
        },
        {
          reg: '^#期望计算(.*)$',
          fnc: 'calculateExpectation',
        },
      ],
    });
  }

  async showHelp(e) {
    const helpMessage = `--- 抽卡期望计算 帮助 ---
指令: #期望计算 [参数...]

说明:
• 参数之间用空格隔开，顺序可以随意调整。
• 插件会自动识别您输入的参数。
• 未提供的参数将使用默认值(如0抽，小保底等)。

可用参数列表:
1. 游戏 (必填):
   - 原神, genshin
   - 星铁, 崩铁, hsr

2. 卡池 (必填):
   - 角色, 人物
   - 武器 (仅原神)
   - 光锥 (仅星铁)

3. 数量 (选填, 默认1):
   - 格式: 数字 + 单位 (个/把/张/命/魂/精)
   - 示例: 3个, 2把, 6命

4. 垫抽 (选填, 默认0):
   - 格式: 数字 + 单位 (抽/垫)
   - 示例: 20抽, 55垫

5. 保底状态 (选填, 默认小保底):
   - 大保底, 必出
   - 小保底

6. 明光计数 (选填, 原神角色池专用):
   - 格式: 明光 + 数字
   - 示例: 明光2, 明光计数1

7. 命定值 (选填, 原神武器池专用):
   - 格式: 命定/定轨 + 数字
   - 示例: 命定值1, 定轨1

--- 指令示例 ---
• #期望计算 原神 角色
(计算从0开始抽1个UP角色的期望)

• #期望计算 星铁 光锥 2个 40抽
(计算已垫40抽，小保底，再抽2个UP光锥的期望)

• #期望计算 原神 武器 5把 定轨1
(计算已垫0抽，命定值1，再抽5把定轨武器的期望)

• #期望计算 50抽 大保底 原神 角色 3个 明光2
(参数顺序随意，效果等同于上面的说明)
`;
    await this.reply(helpMessage);
    return true;
  }

  async calculateExpectation(e) {
    const rawParams = e.msg.replace(/^#期望计算/, '').trim();
    if (!rawParams) {
      await this.reply('请输入要计算的卡池信息，或发送 #期望计算帮助 查看用法。');
      return true;
    }

    // 解析参数
    const args = this.parseArgs(rawParams);

    // 校验核心参数
    if (!args.game || !args.pool) {
      let errorMsg = '参数不完整，请提供游戏和卡池类型。\n';
      errorMsg += '支持的游戏：原神、星铁\n';
      errorMsg += '支持的卡池：角色、武器、光锥\n';
      errorMsg += '发送 #期望计算帮助 查看详细用法。';
      await this.reply(errorMsg);
      return true;
    }
    
    // 校验卡池与游戏的匹配性
    const poolCheck = {
      genshin: ['character', 'weapon'],
      hsr: ['character', 'lightcone']
    };
    
    let validPools = [];
    if (args.game === 'genshin') validPools = poolCheck.genshin;
    if (args.game === 'hsr') validPools = poolCheck.hsr;

    if (!validPools.includes(args.pool)) {
      let poolName = { 'character': '角色', 'weapon': '武器', 'lightcone': '光锥' }[args.pool];
      let gameName = { 'genshin': '原神', 'hsr': '星穹铁道' }[args.game];
      await this.reply(`【${gameName}】中没有【${poolName}】卡池，请检查输入。`);
      return true;
    }


    // 开始计算前，发送提示信息
    await this.reply(`正在玩命计算中，请稍候... (模拟次数: ${SIMULATION_COUNT.toLocaleString()})`);

    // 执行模拟
    try {
      const totalPulls = this.runMonteCarloSimulation(args);
      const expectedPulls = totalPulls / SIMULATION_COUNT;

      // 生成结果报告
      const report = this.generateReport(args, expectedPulls);
      await this.reply(report, true); // at=true
    } catch (error) {
      logger.error(`[抽卡期望计算] 发生错误: ${error.stack}`);
      await this.reply('计算过程中出现未知错误，请检查后台日志。');
    }

    return true;
  }

  /**
   * 解析用户输入的不定序参数字符串
   * @param {string} rawParams - 用户输入的参数字符串
   * @returns {object} 解析后的参数对象
   */
  parseArgs(rawParams) {
    const tokens = rawParams.split(/\s+/).filter(Boolean);
    const args = {
      game: null, // 'genshin' | 'hsr'
      pool: null, // 'character' | 'weapon' | 'lightcone'
      targetCount: 1,
      initialState: {
        pity: 0,
        isGuaranteed: false,
        // 原神角色池特有
        mingguangCounter: 0,
        // 原神武器池特有
        fatePoint: 0,
      },
    };

    tokens.forEach(token => {
      // 匹配游戏
      if (['原神', 'genshin'].includes(token.toLowerCase())) args.game = 'genshin';
      if (['星铁', '崩铁', 'hsr'].includes(token.toLowerCase())) args.game = 'hsr';

      // 匹配卡池
      if (['角色', '人物'].includes(token)) args.pool = 'character';
      if (['武器'].includes(token)) args.pool = 'weapon';
      if (['光锥'].includes(token)) args.pool = 'lightcone';

      // 匹配数量
      const countMatch = token.match(/^(\d+)(个|把|张|命|魂|精)$/);
      if (countMatch) args.targetCount = parseInt(countMatch[1]);
      
      // 匹配垫抽
      const pityMatch = token.match(/^(\d+)(抽|垫)$/);
      if (pityMatch) args.initialState.pity = parseInt(pityMatch[1]);

      // 匹配保底状态
      if (['大保底', '必出'].includes(token)) args.initialState.isGuaranteed = true;
      if (['小保底', '不歪'].includes(token)) args.initialState.isGuaranteed = false;

      // 匹配明光计数器
      const mingguangMatch = token.match(/^(明光|明光计数)(\d+)$/);
      if (mingguangMatch) args.initialState.mingguangCounter = parseInt(mingguangMatch[2]);

      // 匹配命定值
      const fatePointMatch = token.match(/^(命定|定轨)(值)?(\d+)$/);
      if (fatePointMatch) args.initialState.fatePoint = parseInt(fatePointMatch[3]);
    });
    
    // 如果用户只说了定轨1，自动设为大保底状态（因为此时必出）
    if (args.initialState.fatePoint >= 1) {
        args.initialState.isGuaranteed = true;
    }


    return args;
  }

  /**
   * 运行蒙特卡洛模拟
   */
  runMonteCarloSimulation(args) {
    let totalPullsSum = 0;
    for (let i = 0; i < SIMULATION_COUNT; i++) {
      totalPullsSum += this.simulateOneFullRun(args);
    }
    return totalPullsSum;
  }

  /**
   * 模拟一次完整的、获取N个目标的流程
   */
  simulateOneFullRun(args) {
    let totalPulls = 0;
    // 使用 lodash 的 cloneDeep 确保每次模拟的初始状态都是干净的
    let currentState = lodash.cloneDeep(args.initialState);

    for (let i = 0; i < args.targetCount; i++) {
      const result = this.getOneTarget(args.game, args.pool, currentState);
      totalPulls += result.pulls;
      currentState = result.newState; // 状态继承，用于计算下一个目标
    }
    return totalPulls;
  }

  /**
   * 模拟获取【一个】目标所需的抽数和最终状态
   */
  getOneTarget(game, pool, currentState) {
    let pulls = 0;
    let state = lodash.cloneDeep(currentState);

    while (true) {
      pulls++;
      state.pity++;

      const fiveStarProb = this.calculateFiveStarProb(game, pool, state.pity);

      if (Math.random() < fiveStarProb) {
        // 出金了！
        let isTarget = false;
        
        // 分发到不同的卡池逻辑处理器
        switch (`${game}-${pool}`) {
          case 'genshin-character':
            isTarget = this.handleGenshinCharacter(state, currentState);
            break;
          case 'genshin-weapon':
            isTarget = this.handleGenshinWeapon(state);
            break;
          case 'hsr-character':
            isTarget = this.handleHsrCharacter(state);
            break;
          case 'hsr-lightcone':
            isTarget = this.handleHsrLightCone(state);
            break;
        }

        // 根据结果更新状态
        if (isTarget) {
          // 抽到了！重置状态，完成本次获取
          state.pity = 0;
          state.isGuaranteed = false;
          if (`${game}-${pool}` === 'genshin-character') state.mingguangCounter = 0;
          if (`${game}-${pool}` === 'genshin-weapon') state.fatePoint = 0;
          return { pulls, newState: state };
        } else {
          // 歪了！更新状态以继续
          state.pity = 0;
          state.isGuaranteed = true; // 进入大保底
          
          if (`${game}-${pool}` === 'genshin-character') {
             // 只有在小保底（非大保底）时歪了，明光计数器才+1
            if (!currentState.isGuaranteed) {
                state.mingguangCounter++;
            }
          }
          if (`${game}-${pool}` === 'genshin-weapon') {
            state.fatePoint = 1; // 命定值满了
          }
        }
        // 更新用于下一次循环的初始状态
        currentState = lodash.cloneDeep(state);
      }
    }
  }

  // --- 各卡池逻辑处理器 ---

  handleGenshinCharacter(state, originalState) {
    if (state.isGuaranteed) return true; // 大保底必出

    // 小保底，应用“捕获明光”机制
    if (state.mingguangCounter >= 3) return true; // 1. 强制明光
    if (Math.random() < 0.00018) return true; // 2. 随机明光
    return Math.random() < 0.5; // 3. 普通50/50
  }

  handleGenshinWeapon(state) {
    if (state.fatePoint >= 1) return true; // 定轨满了（简化版），必出
    // 没满定轨时，75%概率UP，其中一半是目标
    return Math.random() < 0.375; 
  }

  handleHsrCharacter(state) {
    if (state.isGuaranteed) return true;
    return Math.random() < 0.5625; // 星铁角色UP率
  }

  handleHsrLightCone(state) {
    if (state.isGuaranteed) return true;
    return Math.random() < 0.75; // 星铁光锥UP率
  }

  /**
   * 计算当前抽数的出金概率（根据软保底）
   */
  calculateFiveStarProb(game, pool, pity) {
    let baseRate, softPityStart, softPityStep, maxPity;

    switch (`${game}-${pool}`) {
      case 'genshin-character':
        baseRate = 0.006; softPityStart = 74; softPityStep = 0.06; maxPity = 90;
        break;
      case 'genshin-weapon':
        baseRate = 0.007; softPityStart = 64; softPityStep = 0.07; maxPity = 80;
        break;
      case 'hsr-character':
        baseRate = 0.006; softPityStart = 74; softPityStep = 0.06; maxPity = 90;
        break;
      case 'hsr-lightcone':
        baseRate = 0.008; softPityStart = 66; softPityStep = 0.075; maxPity = 80;
        break;
      default:
        return 0;
    }
    
    if (pity >= maxPity) return 1.0;
    if (pity < softPityStart) return baseRate;
    return baseRate + (pity - softPityStart + 1) * softPityStep;
  }
  
  /**
   * 生成最终的报告文本
   */
  generateReport(args, expectedPulls) {
    const gameName = { 'genshin': '原神', 'hsr': '崩坏：星穹铁道' }[args.game];
    const poolName = { 'character': 'UP角色', 'weapon': '定轨武器', 'lightcone': 'UP光锥' }[args.pool];
    const unit = { 'character': '个', 'weapon': '把', 'lightcone': '个' }[args.pool];
    
    let report = `--- 抽卡期望计算 ---
游戏：${gameName}
卡池：${poolName}
目标：获取 ${args.targetCount}${unit}

【初始状态】
已垫抽数：${args.initialState.pity} 抽
`;

    if (args.pool === 'weapon') {
      report += `命定值：${args.initialState.fatePoint} 点 (定轨${args.initialState.fatePoint >= 1 ? '已满' : '未满'})\n`;
    } else {
      report += `保底状态：${args.initialState.isGuaranteed ? '大保底' : '小保底'}\n`;
    }
    
    if (args.game === 'genshin' && args.pool === 'character') {
      report += `明光计数：${args.initialState.mingguangCounter}\n`;
    }

    report += `\n【计算结果】
期望抽数：${expectedPulls.toFixed(2)} 抽
`;
    // 简单折算
    const pinkFates = Math.ceil(expectedPulls);
    const starStones = pinkFates * 160;
    report += `约等于：${pinkFates} 抽 (或 ${starStones.toLocaleString()} 星琼/原石)`;
    
    return report;
  }
}
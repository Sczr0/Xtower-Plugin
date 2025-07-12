import lodash from 'lodash';

// 模拟次数，可以适当增加以提高精度
const SIMULATION_COUNT = 100000;

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

    const args = this.parseArgs(rawParams);

    if (!args.game || !args.pool) {
      let errorMsg = '参数不完整，请提供游戏和卡池类型。\n';
      errorMsg += '支持的游戏：原神、星铁\n';
      errorMsg += '支持的卡池：角色、武器、光锥\n';
      errorMsg += '发送 #期望计算帮助 查看详细用法。';
      await this.reply(errorMsg);
      return true;
    }
    
    const poolCheck = {
      genshin: ['character', 'weapon'],
      hsr: ['character', 'lightcone']
    };
    
    let validPools = (args.game === 'genshin') ? poolCheck.genshin : poolCheck.hsr;
    if (!validPools.includes(args.pool)) {
      let poolName = { 'character': '角色', 'weapon': '武器', 'lightcone': '光锥' }[args.pool];
      let gameName = { 'genshin': '原神', 'hsr': '星穹铁道' }[args.game];
      await this.reply(`【${gameName}】中没有【${poolName}】卡池，请检查输入。`);
      return true;
    }

    await this.reply(`正在光速计算中，请稍候... (模拟次数: ${SIMULATION_COUNT.toLocaleString()})`);

    try {
      const totalPulls = this.runMonteCarloSimulation(args);
      const expectedPulls = totalPulls / SIMULATION_COUNT;

      const report = this.generateReport(args, expectedPulls);
      await this.reply(report, true);
    } catch (error) {
      logger.error(`[抽卡期望计算] 发生错误: ${error.stack}`);
      await this.reply('计算过程中出现未知错误，请检查后台日志。');
    }

    return true;
  }

  parseArgs(rawParams) {
    const tokens = rawParams.split(/\s+/).filter(Boolean);
    const args = {
      game: null,
      pool: null,
      targetCount: 1,
      initialState: {
        pity: 0,
        isGuaranteed: false,
        mingguangCounter: 0,
        fatePoint: 0,
      },
    };

    tokens.forEach(token => {
      if (['原神', 'genshin'].includes(token.toLowerCase())) args.game = 'genshin';
      if (['星铁', '崩铁', 'hsr'].includes(token.toLowerCase())) args.game = 'hsr';
      if (['角色', '人物'].includes(token)) args.pool = 'character';
      if (['武器'].includes(token)) args.pool = 'weapon';
      if (['光锥'].includes(token)) args.pool = 'lightcone';
      
      const countMatch = token.match(/^(\d+)(个|把|张|命|魂|精)$/);
      if (countMatch) args.targetCount = parseInt(countMatch[1]);
      
      const pityMatch = token.match(/^(\d+)(抽|垫)$/);
      if (pityMatch) args.initialState.pity = parseInt(pityMatch[1]);

      if (['大保底', '必出'].includes(token)) args.initialState.isGuaranteed = true;
      if (['小保底', '不歪'].includes(token)) args.initialState.isGuaranteed = false;

      const mingguangMatch = token.match(/^(明光|明光计数)(\d+)$/);
      if (mingguangMatch) args.initialState.mingguangCounter = parseInt(mingguangMatch[2]);

      const fatePointMatch = token.match(/^(命定|定轨)(值)?(\d+)$/);
      if (fatePointMatch) args.initialState.fatePoint = parseInt(fatePointMatch[3]);
    });
    
    if (args.initialState.fatePoint >= 1) {
        args.initialState.isGuaranteed = true;
    }

    return args;
  }

  runMonteCarloSimulation(args) {
    let totalPullsSum = 0;
    for (let i = 0; i < SIMULATION_COUNT; i++) {
      totalPullsSum += this.simulateOneFullRun(args);
    }
    return totalPullsSum;
  }

  simulateOneFullRun(args) {
    let totalPulls = 0;
    let currentState = lodash.cloneDeep(args.initialState);

    for (let i = 0; i < args.targetCount; i++) {
      const result = this.getOneTarget(args.game, args.pool, currentState);
      totalPulls += result.pulls;
      currentState = result.newState;
    }
    return totalPulls;
  }
  
  getOneTarget(startState) {
    let pulls = 0;
    let state = lodash.cloneDeep(startState); // 深拷贝一份初始状态，用于本次模拟
    
    while (true) {
        pulls++;
        state.pity++;

        const fiveStarProb = this.calculateFiveStarProb(game, pool, state.pity);

        if (Math.random() < fiveStarProb) {
            let isTarget = false;
            
            switch (`${game}-${pool}`) {
                case 'genshin-character':
                    isTarget = this.handleGenshinCharacter(state);
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

            if (isTarget) {
                state.pity = 0;
                state.isGuaranteed = false;
                if (`${game}-${pool}` === 'genshin-character') state.mingguangCounter = 0;
                if (`${game}-${pool}` === 'genshin-weapon') state.fatePoint = 0;
                return { pulls, newState: state };
            } else {
                // 歪了！
                if (`${game}-${pool}` === 'genshin-character' && !startState.isGuaranteed) {
                    state.mingguangCounter++;
                }
                if (`${game}-${pool}` === 'genshin-weapon') {
                    state.fatePoint = 1;
                }
                state.pity = 0;
                state.isGuaranteed = true;
                
                // 【重要】更新startState，为下一次循环做准备
                startState = lodash.cloneDeep(state);
            }
        }
    }
}


  handleGenshinCharacter(state) {
    if (state.isGuaranteed) return true;
    if (state.mingguangCounter >= 3) return true;
    if (Math.random() < 0.00018) return true;
    return Math.random() < 0.5;
  }

  handleGenshinWeapon(state) {
    if (state.fatePoint >= 1) return true;
    return Math.random() < 0.375;
  }

  handleHsrCharacter(state) {
    if (state.isGuaranteed) return true;
    return Math.random() < 0.5625;
  }

  handleHsrLightCone(state) {
    if (state.isGuaranteed) return true;
    return Math.random() < 0.75;
  }

  calculateFiveStarProb(game, pool, pity) {
    let baseRate, softPityStart, softPityStep, maxPity;

    switch (`${game}-${pool}`) {
      case 'genshin-character':
        baseRate = 0.006; softPityStart = 74; softPityStep = 0.06; maxPity = 90; break;
      case 'genshin-weapon':
        baseRate = 0.007; softPityStart = 64; softPityStep = 0.07; maxPity = 80; break;
      case 'hsr-character':
        baseRate = 0.006; softPityStart = 74; softPityStep = 0.06; maxPity = 90; break;
      case 'hsr-lightcone':
        baseRate = 0.008; softPityStart = 66; softPityStep = 0.075; maxPity = 80; break;
      default: return 0;
    }
    
    if (pity >= maxPity) return 1.0;
    if (pity < softPityStart) return baseRate;
    return baseRate + (pity - softPityStart + 1) * softPityStep;
  }
  
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
    const pinkFates = Math.ceil(expectedPulls);
    const starStones = pinkFates * 160;
    report += `约等于：${pinkFates} 抽 (或 ${starStones.toLocaleString()} 星琼/原石)`;
    
    return report;
  }
}
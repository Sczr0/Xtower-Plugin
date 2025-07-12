import plugin from '../../lib/plugins/plugin.js';
import { spawn } from 'child_process';
import path from 'path';

export class gachaCalc extends plugin {
  constructor() {
    super({
      name: '抽卡期望计算',
      dsc: '计算原神/星铁抽卡期望(高性能版)',
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

    this.pyScriptPath = path.join(this.path, 'test.py');
  }

  async showHelp(e) { /* ... 帮助信息不变 ... */ }

  async calculateExpectation(e) {
    const rawParams = e.msg.replace(/^#期望计算/, '').trim();
    if (!rawParams) { /* ... 参数检查 ... */ }
    const args = this.parseArgs(rawParams);
    if (!args.game || !args.pool) { /* ... 参数检查 ... */ }

    await this.reply(`正在光速计算中，请稍候... (外部Python核心)`);

    try {
      // 调用 Python 脚本并等待结果
      const expectedPulls = await this.runPythonCalculator(args);
      const report = this.generateReport(args, expectedPulls);
      await this.reply(report, true);
    } catch (error) {
      logger.error(`[抽卡期望计算] 外部脚本执行失败: ${error.message}`);
      // 向用户发送清晰的错误提示
      await this.reply(error.message, true);
    }

    return true;
  }

  /**
   * 调用外部Python脚本执行计算
   * @param {object} args - 包含所有计算参数的对象
   * @returns {Promise<number>} 返回一个包含期望抽数的Promise
   */
  runPythonCalculator(args) {
    return new Promise((resolve, reject) => {
      // 将JS对象转换为JSON字符串，以便传递给Python
      const argsJson = JSON.stringify(args);

      // 使用 'python3' 命令，这比 'python' 更明确
      const pyProcess = spawn('python3', [this.pyScriptPath, argsJson]);

      let result = '';
      let errorMessage = '';

      pyProcess.stdout.on('data', (data) => {
        result += data.toString();
      });

      pyProcess.stderr.on('data', (data) => {
        errorMessage += data.toString();
      });

      // 捕获 'spawn' 本身的错误，例如 'python3' 命令不存在
      pyProcess.on('error', (err) => {
        const userError = `错误：无法启动Python计算核心。\n请确认服务器已安装Python 3，并且 'python3' 命令在系统PATH中可用。\n底层错误: ${err.message}`;
        reject(new Error(userError));
      });

      pyProcess.on('close', (code) => {
        if (code === 0) {
          // 成功执行
          resolve(parseFloat(result));
        } else {
          // 脚本执行出错
          const userError = `错误：Python计算核心执行失败 (退出码: ${code})。\n请检查后台日志获取详细Python错误信息。\n错误日志: ${errorMessage || '无'}`;
          reject(new Error(userError));
        }
      });
    });
  }

  // ... (parseArgs 和 generateReport 函数保持不变，因为它们只负责数据处理和UI)
  parseArgs(rawParams) { /* ... 不变 ... */ }
  generateReport(args, expectedPulls) { /* ... 不变 ... */ }
}

// --- 为了代码完整性，附上不变的函数 ---
gachaCalc.prototype.parseArgs = function(rawParams) {
    const tokens = rawParams.split(/\s+/).filter(Boolean);
    const args = {
      game: null, pool: null, targetCount: 1,
      initialState: { pity: 0, isGuaranteed: false, mingguangCounter: 0, fatePoint: 0 },
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
    if (args.initialState.fatePoint >= 1) args.initialState.isGuaranteed = true;
    return args;
};
gachaCalc.prototype.generateReport = function(args, expectedPulls) {
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
};
gachaCalc.prototype.showHelp = function(e) {
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
    this.reply(helpMessage);
    return true;
};
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os'; 

// 定义所有合法的游戏和卡池组合，用于前置校验
const VALID_POOLS = {
    'genshin': ['character', 'weapon'],
    'hsr': ['character', 'lightcone']
};

export class gachaCalc extends plugin {
    constructor() {
        super({
            name: '抽卡期望计算',
            dsc: '计算原神/星铁抽卡期望与分布',
            event: 'message',
            priority: 500,
            rule: [
                { reg: '^#期望计算帮助$', fnc: 'showHelp' },
                { reg: '^#期望计算(.*)$', fnc: 'calculateExpectation' },
                { reg: '^#期望分布(.*)$', fnc: 'calculateDistribution' },
            ],
        });
    }

    // 指令入口: #期望计算
    async calculateExpectation(e) {
        await this.handleRequest(e, 'expectation');
    }

    // 指令入口: #期望分布
    async calculateDistribution(e) {
        await this.handleRequest(e, 'distribution');
    }

    /**
     * 统一处理所有请求的核心函数
     * @param {object} e - Yunzai的事件对象
     * @param {string} mode - 'expectation' (数学模式) 或 'distribution' (模拟模式)
     */
    async handleRequest(e, mode) {
        const command = mode === 'distribution' ? '#期望分布' : '#期望计算';
        const rawParams = e.msg.replace(command, '').trim();
        
        if (!rawParams) {
            await this.reply(`请输入参数。发送 #期望计算帮助 查看详情。`);
            return true;
        }

        const args = this.parseArgs(rawParams);
        
        // 在调用Python前，进行完整性与有效性校验
        if (!args.game || !args.pool || !VALID_POOLS[args.game]?.includes(args.pool)) {
            const poolNameMap = { 'character': '角色', 'weapon': '武器', 'lightcone': '光锥' };
            const gameNameMap = { 'genshin': '原神', 'hsr': '崩坏：星穹铁道' };
            const poolName = poolNameMap[args.pool] || args.pool || '未知';
            const gameName = gameNameMap[args.game] || args.game || '未知';
            await this.reply(`错误：【${gameName}】中没有【${poolName}】卡池，请检查输入。`);
            return true;
        }

        await this.reply(`正在光速计算中，请稍候... (模式: ${mode})`);
        args.mode = mode;

        try {
            const resultJson = await this.runPythonCalculator(args);
            const resultData = JSON.parse(resultJson);
            const report = this.generateReport(args, resultData);
            await this.reply(report, true);
        } catch (error) {
            logger.error(`[抽卡期望计算] 外部脚本执行失败: ${error.message}`);
            await this.reply(error.message, true);
        }
        return true;
    }

    /**
     * 调用外部Python脚本的核心函数
     * @param {object} args - 包含所有计算参数的对象
     * @returns {Promise<string>} 返回一个包含JSON结果字符串的Promise
     */
    runPythonCalculator(args) {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const pluginRoot = path.join(__dirname, '..');
        const pyScriptPath = path.join(pluginRoot, 'example', 'test.py');
        const pythonCommand = os.platform() === 'win32' ? 'python' : 'python3';

        return new Promise((resolve, reject) => {
            const argsJson = JSON.stringify(args);
            // 动态确定命令
            const pyProcess = spawn(pythonCommand, [pyScriptPath, argsJson]);

            let result = '';
            let errorMessage = '';

            pyProcess.stdout.on('data', (data) => { result += data.toString(); });
            pyProcess.stderr.on('data', (data) => { errorMessage += data.toString(); });

            pyProcess.on('error', (err) => {
                // 优化了错误提示
                reject(new Error(`错误：无法启动Python计算核心。\n请确认服务器已安装Python 3和numpy，并且 '${pythonCommand}' 命令在系统路径中可用。\n底层错误: ${err.message}`));
            });

            pyProcess.on('close', (code) => {
                if (code === 0) {
                    resolve(result);
                } else {
                    reject(new Error(`错误：Python计算核心执行失败 (退出码: ${code})。\n请检查后台日志。\n错误日志: ${errorMessage || '无'}`));
                }
            });
        });
    }
    
    /**
     * 生成最终发送给用户的报告
     * @param {object} args - 用户输入的参数
     * @param {object} data - Python脚本返回的数据
     */
    generateReport(args, data) {
        const gameName = { 'genshin': '原神', 'hsr': '崩坏：星穹铁道' }[args.game];
        const poolName = { 'character': 'UP角色', 'weapon': '定轨武器', 'lightcone': 'UP光锥' }[args.pool];
        const unit = { 'character': '个', 'weapon': '把', 'lightcone': '个' }[args.pool];
        
        let report = `--- 抽卡期望与分布 ---
游戏：${gameName} | 卡池：${poolName}
目标：获取 ${args.targetCount}${unit}

【初始状态】
${this.formatInitialState(args)}
`;
        const pullsData = data.pulls || { mean: data.mean };
        report += `
【抽数分析】
期望抽数 (平均值): ${pullsData.mean.toFixed(2)} 抽
`;
        if (args.mode === 'distribution') {
            report += `• 欧皇线 (25%): ${pullsData.p25} 抽内
• 中位线 (50%): ${pullsData.p50} 抽内
• 非酋线 (75%): ${pullsData.p75} 抽内
• 天选非酋 (95%): ${pullsData.p95} 抽内`;
        }
        
        if (data.success_rate !== undefined) {
            report += `

【预算达成概率】
使用 ${args.budget} 抽, 达成目标的概率为: ${data.success_rate.toFixed(2)}%`;
        } else if (args.budget && args.mode !== 'distribution') {
            report += `\n(提示: 预算概率计算仅在 #期望分布 模式下有效)`;
        }
        
        if (data.returns) {
            const returnData = data.returns;
            const returnName = args.game === 'genshin' ? '星辉' : '星芒';
            report += `

【${returnName}返还分析】 (副产物)
平均返还: ${returnData.mean.toFixed(2)} 个${returnName}
• 欧皇返还 (25%): ${returnData.p25} 个以上
• 中位返还 (50%): ${returnData.p50} 个以上
• 非酋返还 (75%): ${returnData.p75} 个以上`;
        }

        const pinkFates = Math.ceil(pullsData.mean);
        const starStones = pinkFates * 160;
        report += `\n\n(期望抽数约等于 ${pinkFates} 抽 或 ${starStones.toLocaleString()} 星琼/原石)`;
        return report;
    }
    
    /**
     * 格式化初始状态部分的文本
     * @param {object} args - 用户输入的参数
     */
    formatInitialState(args) {
        const { initialState } = args;
        let stateStr = `已垫抽数: ${initialState.pity} 抽\n`;
        if (args.pool === 'weapon') {
            stateStr += `命定值: ${initialState.fatePoint} 点`;
        } else {
            stateStr += `保底状态: ${initialState.isGuaranteed ? '大保底' : '小保底'}`;
        }
        if (args.game === 'genshin' && args.pool === 'character') {
            stateStr += `\n明光计数: ${initialState.mingguangCounter}`;
        }
        if (args.mode === 'distribution' && args.pool === 'character') {
            stateStr += ` \nUP四星状态: ${args.up4C6 ? '已满命' : '未满命'}`;
        }
        return stateStr;
    }
    
    /**
     * 解析用户输入的原始参数字符串
     * @param {string} rawParams - 用户输入的指令后续文本
     */
    parseArgs(rawParams) {
        const tokens = rawParams.split(/\s+/).filter(Boolean);
        const args = {
            game: null, pool: null, targetCount: 1, up4C6: false,
            budget: null,
            initialState: { pity: 0, isGuaranteed: false, mingguangCounter: 0, fatePoint: 0 }
        };
        tokens.forEach(token => {
            if (['原神', 'genshin'].includes(token.toLowerCase())) args.game = 'genshin';
            else if (['星铁', '崩铁', 'hsr'].includes(token.toLowerCase())) args.game = 'hsr';
            else if (['角色', '人物'].includes(token)) args.pool = 'character';
            else if (['武器'].includes(token)) args.pool = 'weapon';
            else if (['光锥'].includes(token)) args.pool = 'lightcone';
            else if (['四星满命', 'up4满命', 'up4c6'].includes(token.toLowerCase())) args.up4C6 = true;
            else if (['大保底', '必出'].includes(token)) args.initialState.isGuaranteed = true;
            else if (['小保底', '不歪'].includes(token)) args.initialState.isGuaranteed = false;
            
            const budgetMatch = token.match(/^(预算|持有|目标)(\d+)(抽|发)?$/);
            if (budgetMatch) {
                args.budget = parseInt(budgetMatch[2]);
            } else {
                const countMatch = token.match(/^(\d+)(个|把|张|命|魂|精)$/);
                if (countMatch) args.targetCount = parseInt(countMatch[1]);
                
                const pityMatch = token.match(/^(\d+)(抽|垫)$/);
                if (pityMatch) args.initialState.pity = parseInt(pityMatch[1]);
                
                const mingguangMatch = token.match(/^(明光|明光计数)(\d+)$/);
                if (mingguangMatch) args.initialState.mingguangCounter = parseInt(mingguangMatch[2]);
                
                const fatePointMatch = token.match(/^(命定|定轨)(值)?(\d+)$/);
                if (fatePointMatch) args.initialState.fatePoint = parseInt(fatePointMatch[3]);
            }
        });
        if (args.initialState.fatePoint >= 1) args.initialState.isGuaranteed = true;
        return args;
    }
    
    /**
     * 显示帮助信息
     */
    showHelp(e) {
        const helpMessage = `--- 抽卡期望计算 帮助 ---
指令:
  #期望计算 [参数...]  (快速获取平均值)
  #期望分布 [参数...]  (获取详细概率分布)

参数 (顺序随意):
 • 游戏: 原神, 星铁
 • 卡池: 角色, 武器, 光锥
 • 数量: 3个, 6命 (默认1)
 • 垫抽: 20抽, 50垫 (默认0)
 • 保底: 大保底, 小保底 (默认小保底)
 • 预算: 预算180抽 (分布模式专用, 计算成功率)
 • 明光: 明光2 (原神角色池专用)(计算方法：自上次小保底不歪开始连续歪了几次)
 • 定轨: 定轨1 (原神武器池专用)
 • 四星满命: (分布模式, 角色池专用)

示例:
 • #期望计算 原神 角色 3个
 • #期望分布 星铁 角色 1个 四星满命 预算150抽
`;
        this.reply(helpMessage);
        return true;
    }
}
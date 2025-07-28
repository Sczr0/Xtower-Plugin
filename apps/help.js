import { exec } from 'child_process'
export class XtowerHelp extends plugin {
  constructor () {
    super({
      name: 'Xtower 插件帮助',
      dsc: 'Xtower-Plugin 插件功能帮助',
      event: 'message',
      priority: 500, // 较高的优先级，确保能响应帮助指令
      rule: [
        {
          reg: '^#弦塔帮助$',
          fnc: 'showHelp'
        },
        {
          reg: '^#弦塔版本$',
          fnc: 'showVersion'
        }
      ]
    })
  }

  /**
   * 异步执行的帮助函数
   * @param {object} e 消息事件对象
   */
  async showHelp (e) {
    const helpMsg = `Xtower-Plugin 功能帮助
--------------------
【随机歌词】
• #抽歌词 ：随机抽取歌词
• #抽歌词 <数量> ：批量抽取歌词
• PS：后加-riv参数可去除歌词出处信息。

【聪明 Bingo】
• #今日bingo：获取今日题目
• #bingo <答案>：提交答案 (例: #bingo 13 24 35)
• #查询Bingo排名：查询个人及前三排名

【俄罗斯转盘】
• #俄罗斯转盘[数量]：创建游戏房间 (可指定1-5颗子弹)
• #加入转盘：加入当前游戏
• #退出转盘：(开始前)退出游戏
• #开始转盘：(房主)手动开始游戏
• #旋转 或 #转：(轮到你时)旋转弹巢
• #开枪：(轮到你时)对自己开枪
• #结束转盘：(房主)强制结束游戏

【速算】
• #速算 [难度]：开始一局速算挑战 (简单/普通/困难/地狱)
• #无尽速算 [难度]：开始无尽模式挑战，直至答错
• #放弃：放弃当前对局，并查看答案

【24点】
通过#24点帮助查看详情

【谁是卧底（测试）】
• #卧底创建 [模式]：创建房间 (明牌/暗牌)
• #加入卧底：加入当前游戏
• #退出卧底：退出等待中的游戏
• #开始卧底：(房主)开始游戏
• #发言结束：结束自己的发言回合
• #投票 <编号>：投票淘汰玩家 (例: #投票 01)
• #结束卧底：(房主)强制结束游戏

【狼人杀（测试）】
[群聊指令]
• #创建狼人杀：创建游戏房间
• #加入狼人杀：加入当前游戏
• #退出狼人杀：退出等待中的游戏
• #开始狼人杀：(房主)开始游戏 (需≥6人)
• #结束发言：白天结束自己的发言
• #投票 <编号>：白天投票淘汰玩家 (例: #投票 01)
• #狼人杀状态：查看游戏进程
• #结束狼人杀：(房主/管理)强制结束游戏

[私聊机器人指令]
• 杀/刀 <编号>：(狼人)夜晚刀人
• 查验 <编号>：(预言家)夜晚验人
• 救 <编号>：(女巫)夜晚救人
• 毒 <编号>：(女巫)夜晚毒人
• 守 <编号>：(守卫)夜晚守人
• 开枪 <编号>：(猎人)死亡时开枪`

    // 回复帮助信息
    await e.reply(helpMsg)

    // return true 阻止消息继续向下传递
    return true
  }

    /**
   * 显示插件的版本信息
   * @param {object} e 消息事件对象
   */
  async showVersion (e) {
    // 这条命令会获取最新一次git commit的信息，并用|||分隔
    const cmd = 'git log -1 --pretty=format:"%h|||%s|||%an|||%b"'

    exec(cmd, { cwd: this.dir }, (error, stdout, stderr) => {
      if (error) {
        console.error('获取Git版本信息失败:', error)
        e.reply('获取版本信息失败，可能是当前环境没有Git或这不是一个Git仓库。')
        return
      }

      if (stderr) {
        console.error('获取Git版本信息时出错:', stderr)
        e.reply('获取版本信息时出错，详情请查看后台日志。')
        return
      }

      // 解析返回的信息
      const parts = stdout.trim().split('|||')
      const hash = parts[0]
      const title = parts[1]
      const author = parts[2]
      let body = parts[3]

      if (!body || body.trim() === '') {
        body = '作者这次偷懒了，没有写更新说明~'
      }

      // 构建要发送的消息
      const versionMsg = `Xtower-Plugin 版本信息
--------------------
版本：${hash}
作者：${author}
更新标题：${title}
更新说明：${body}`

      e.reply(versionMsg)
    })

    return true
  }
}
/**
 * 游戏阶段配置文件
 * 定义了狼人杀游戏的所有可能阶段及其属性。
 * 这是实现游戏流程自动化和扩展性的核心。
 */

export const PHASES = {
  // --- 夜晚阶段 ---
  WOLF_KILL: {
    id: 'WOLF_KILL',
    name: '狼人行动',
    type: 'night',
    order: 100, // 使用 order 字段来决定执行顺序
    duration: 60, // 默认持续时间（秒）
    description: '狼人请睁眼，请选择今晚要袭击的目标。'
  },
  PROPHET_CHECK: {
    id: 'PROPHET_CHECK',
    name: '预言家行动',
    type: 'night',
    order: 200,
    duration: 30,
    description: '预言家请睁眼，请选择你要查验身份的玩家。'
  },
  WITCH_ACTION: {
    id: 'WITCH_ACTION',
    name: '女巫行动',
    type: 'night',
    order: 300,
    duration: 45,
    description: '女巫请睁眼，今晚这位玩家倒牌了，你要使用解药吗？你要使用毒药吗？'
  },

  // --- 白天阶段 ---
  ANNOUNCEMENT: {
    id: 'ANNOUNCEMENT',
    name: '公布夜晚结果',
    type: 'day',
    order: 500,
    description: '天亮了，昨夜...'
  },
  SPEECH: {
    id: 'SPEECH',
    name: '玩家发言',
    type: 'day',
    order: 600,
    description: '从警长左侧玩家开始轮流发言。'
  },
  VOTE: {
    id: 'VOTE',
    name: '投票放逐',
    type: 'day',
    order: 700,
    duration: 60,
    description: '请投票选出你认为的狼人。'
  },
  VOTE_RESULT: {
    id: 'VOTE_RESULT',
    name: '公布投票结果',
    type: 'day',
    order: 800,
    description: '投票结束，...'
  }
}

// 导出按顺序排列的夜晚阶段和白天阶段，方便游戏管理器直接使用
export const NIGHT_PHASES = Object.values(PHASES)
  .filter(p => p.type === 'night')
  .sort((a, b) => a.order - b.order)

export const DAY_PHASES = Object.values(PHASES)
  .filter(p => p.type === 'day')
  .sort((a, b) => a.order - b.order)
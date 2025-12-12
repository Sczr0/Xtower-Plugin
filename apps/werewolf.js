/**
 * 狼人杀插件入口（轻量包装层）。
 * 说明：历史上该模块在 apps/werewolf.js 内长期迭代导致石山代码。
 * 现已将核心逻辑、Redis 数据管理与插件控制器拆分至 models/werewolf/。
 * 请勿在本文件继续堆叠逻辑，新增功能一律进入 models/werewolf 对应子模块。
 */

export { WerewolfPlugin } from '../models/werewolf/WerewolfPlugin.js'


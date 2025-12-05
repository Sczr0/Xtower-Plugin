import path from 'path'
import fs from 'fs'
import yaml from 'js-yaml'
import lodash from 'lodash'
import { BASE_DEFAULTS, getConfigPath, loadConfig } from './utils/config.js'

// 插件名称
const pluginName = 'Xtower-Plugin'

// 插件配置文件的路径
const pluginConfigPath = getConfigPath()

// 辅助函数：确保目录存在
function ensureDirExists (filePath) {
  const dirname = path.dirname(filePath) // filePath 将是 .../config/config.yaml, dirname 将是 .../config
  if (fs.existsSync(dirname)) {
    return true
  }
  try {
    fs.mkdirSync(dirname, { recursive: true }) // 会尝试创建 .../Xtower-Plugin/config 目录
    return true
  } catch (error) {
    console.error(`[${pluginName}] Error creating directory ${dirname}:`, error)
    return false
  }
}

// 支持锅巴
export function supportGuoba () {
  // 构建插件图标的路径，如果需要的话
  // const iconAbsolutePath = path.join(process.cwd(), 'plugins', pluginName, 'resources', 'images', 'icon.png');

  return {
    // 插件信息，将会显示在前端页面
    pluginInfo: {
      name: pluginName,
      title: 'Xtower-Plugin',
      description: '零碎的JS功能实现',
      author: ['Sczr0'],
      authorLink: ['https://github.com/Sczr0'],
      link: 'https://github.com/Sczr0/Xtower-Plugin',
      isV3: true,
      isV2: false,
      showInMenu: 'auto',
      icon: 'mdi:puzzle-star-outline',
      iconColor: '#7B68EE'
      // iconPath: fs.existsSync(iconAbsolutePath) ? iconAbsolutePath : undefined
    },
    // 配置项信息
    configInfo: {
      // 配置项 schemas
      schemas: [
        {
          label: '随机歌词',
          component: 'SOFT_GROUP_BEGIN'
        },
        {
          field: 'lyrics.rateLimit.maxPerHour',
          label: '每小时最大调用次数',
          bottomHelpMessage: '限制用户每小时可以调用随机歌词功能的次数',
          component: 'InputNumber',
          componentProps: {
            min: 1,
            placeholder: '例如: 10'
          }
        },
        {
          field: 'lyrics.rateLimit.cooldown',
          label: '冷却时间 (毫秒)',
          bottomHelpMessage: '每次调用后的冷却时间，单位毫秒',
          component: 'InputNumber',
          componentProps: {
            min: 0,
            placeholder: '例如: 5000 (5秒)'
          }
        },
        {
          field: 'lyrics.batch_draw_max_count',
          label: '批量抽取最大数量',
          bottomHelpMessage: '允许用户一次性批量抽取歌词的最大条数',
          component: 'InputNumber',
          componentProps: {
            min: 1,
            max: 20,
            placeholder: '例如: 5'
          }
        },
        {
          label: '速算',
          component: 'SOFT_GROUP_BEGIN'
        },
        {
          field: 'quickMath.answer_timeout_ms',
          label: '答题超时 (毫秒)',
          bottomHelpMessage: '速算题目回答的超时时间，单位毫秒',
          component: 'InputNumber',
          componentProps: {
            min: 1000,
            placeholder: '例如: 30000 (30秒)'
          }
        },
        {
          field: 'quickMath.normal_mode_max_attempts',
          label: '普通模式最大尝试次数',
          bottomHelpMessage: '在普通模式下，用户答错一道题的最大次数',
          component: 'InputNumber',
          componentProps: {
            min: 1,
            placeholder: '例如: 3'
          }
        },
        {
          label: '俄罗斯转盘',
          component: 'SOFT_GROUP_BEGIN'
        },
        {
          field: 'russianRoulette.initial_spins',
          label: '初始旋转次数',
          bottomHelpMessage: '玩家开始游戏时拥有的旋转弹巢次数',
          component: 'InputNumber',
          componentProps: {
            min: 0,
            placeholder: '例如: 4'
          }
        },
        {
          field: 'russianRoulette.initial_foresights',
          label: '初始预知次数',
          bottomHelpMessage: '玩家开始游戏时拥有的预知技能次数',
          component: 'InputNumber',
          componentProps: {
            min: 0,
            placeholder: '例如: 1'
          }
        },
        {
          field: 'russianRoulette.initial_skips',
          label: '初始跳过次数',
          bottomHelpMessage: '玩家开始游戏时拥有的跳过本轮技能次数',
          component: 'InputNumber',
          componentProps: {
            min: 0,
            placeholder: '例如: 1'
          }
        },
        {
          field: 'russianRoulette.default_bullet_count',
          label: '默认子弹数量',
          bottomHelpMessage: '创建游戏时，若未指定，默认放入的子弹数量',
          component: 'InputNumber',
          componentProps: {
            min: 1,
            placeholder: '例如: 1'
          }
        },
        {
          field: 'russianRoulette.auto_start_delay_ms',
          label: '自动开始延迟 (毫秒)',
          bottomHelpMessage: '创建游戏后，等待玩家加入自动开始的延迟时间，单位毫秒',
          component: 'InputNumber',
          componentProps: {
            min: 5000,
            placeholder: '例如: 30000 (30秒)'
          }
        },
        {
          field: 'russianRoulette.cylinder_capacity',
          label: '弹巢容量',
          bottomHelpMessage: '左轮手枪的弹巢总容量，也决定了游戏最大人数',
          component: 'InputNumber',
          componentProps: {
            min: 2,
            max: 12,
            placeholder: '例如: 6'
          }
        }
      ],
      // 获取配置数据方法（用于前端填充显示数据）
      getConfigData () {
        let savedConfig = {}
        try {
          if (fs.existsSync(pluginConfigPath)) {
            const yamlText = fs.readFileSync(pluginConfigPath, 'utf8')
            savedConfig = yaml.load(yamlText) || {}
          }
        } catch (error) {
          console.error(`[${pluginName}] Failed to read config file ${pluginConfigPath}:`, error)
        }
        // 统一使用 BASE_DEFAULTS，确保各模块默认值一致
        return lodash.merge({}, BASE_DEFAULTS, savedConfig)
      },
      // 设置配置的方法（前端点确定后调用的方法）
      setConfigData (data, { Result }) {
        let currentConfig = {}
        try {
          if (fs.existsSync(pluginConfigPath)) {
            const yamlText = fs.readFileSync(pluginConfigPath, 'utf8')
            currentConfig = yaml.load(yamlText) || {}
          }
        } catch (error) {
          console.error(`[${pluginName}] Failed to read config file ${pluginConfigPath} before saving:`, error)
        }

        // 先合并统一默认值与当前配置，再叠加前端传入的变更
        let newConfig = lodash.merge({}, BASE_DEFAULTS, currentConfig)

        for (const keyPath in data) {
          if (Object.prototype.hasOwnProperty.call(data, keyPath)) {
            lodash.set(newConfig, keyPath, data[keyPath])
          }
        }

        try {
          // 确保 .../plugins/Xtower-Plugin/config/ 目录存在
          if (!ensureDirExists(pluginConfigPath)) {
            return Result.error('创建配置目录失败，无法保存！')
          }
          fs.writeFileSync(pluginConfigPath, yaml.dump(newConfig), 'utf8')
          return Result.ok({}, '配置保存成功awa~')
        } catch (error) {
          console.error(`[${pluginName}] Failed to write config file ${pluginConfigPath}:`, error)
          return Result.error('配置保存失败，请检查控制台日志！')
        }
      }
    }
  }
}

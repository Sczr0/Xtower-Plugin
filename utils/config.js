import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

// 统一的配置默认值，后续模块只需维护这里即可
export const BASE_DEFAULTS = {
  lyrics: {
    rateLimit: {
      maxPerHour: 10,
      cooldown: 5000
    },
    batch_draw_max_count: 5
  },
  quickMath: {
    answer_timeout_ms: 30000,
    normal_mode_max_attempts: 3
  },
  russianRoulette: {
    initial_spins: 4,
    initial_foresights: 1,
    initial_skips: 1,
    default_bullet_count: 1,
    auto_start_delay_ms: 30000,
    cylinder_capacity: 6
  },
  // 狼人杀默认值参考现有 config.yaml 与规划文档
  werewolf: {
    enableSheriff: true,
    exileTieHandling: 'no_exile',
    gameEndConditions: 'wolf_kill',
    enableLastWords: true,
    lastWordDuration: 60,
    lastWordMaxLength: 100,
    enablePostGameReview: true,
    postGameReviewEvents: ['wolf_kill', 'witch_potion', 'seer_check', 'hunter_shoot', 'exiled'],
    enableSelfExplosion: true,
    nightActionDuration: 30,
    sheriffSpeakDuration: 60,
    sheriffVoteDuration: 30,
    daySpeakDuration: 60,
    dayVoteDuration: 30
  }
}

// 根据运行位置自动推断插件根目录：优先认为当前 cwd 已是插件目录，否则回退到 Yunzai 下的 plugins/Xtower-Plugin
const CWD = process.cwd()
const PLUGIN_ROOT = fs.existsSync(path.join(CWD, 'apps'))
  ? CWD
  : path.join(CWD, 'plugins', 'Xtower-Plugin')
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'config', 'config.yaml')

let cacheConfig = null
let cacheMtime = 0

// 简单的克隆工具，兼容旧 Node 版本
const cloneValue = (val) => {
  if (globalThis.structuredClone) return globalThis.structuredClone(val)
  return JSON.parse(JSON.stringify(val))
}

/**
 * 简单的深度合并：对象递归，数组整体覆盖，原子值直接覆盖
 */
function mergeDeep (target, source) {
  if (source === undefined) return target
  if (target === null || typeof target !== 'object') return cloneValue(source)
  if (source === null || typeof source !== 'object') return source
  const output = Array.isArray(target) ? [...target] : { ...target }
  for (const key of Object.keys(source)) {
    const srcVal = source[key]
    const tgtVal = output[key]
    if (Array.isArray(srcVal)) {
      output[key] = [...srcVal]
    } else if (srcVal && typeof srcVal === 'object') {
      output[key] = mergeDeep(tgtVal ?? {}, srcVal)
    } else {
      output[key] = srcVal
    }
  }
  return output
}

function readYamlConfig () {
  if (!fs.existsSync(CONFIG_PATH)) return {}
  try {
    const text = fs.readFileSync(CONFIG_PATH, 'utf8')
    const parsed = yaml.load(text)
    return parsed || {}
  } catch (err) {
    console.error('[Xtower-Plugin] 读取配置文件失败，将使用默认值:', err)
    return {}
  }
}

/**
 * 读取并缓存完整配置（默认值 + 用户 YAML）
 * @param {boolean} forceReload 是否强制刷新缓存
 * @returns {object}
 */
export function loadConfig (forceReload = false) {
  const stat = fs.existsSync(CONFIG_PATH) ? fs.statSync(CONFIG_PATH) : null
  const mtime = stat ? stat.mtimeMs : 0
  if (!forceReload && cacheConfig && cacheMtime === mtime) return cacheConfig

  const userConfig = readYamlConfig()
  // 默认值在最前，用户配置覆盖
  cacheConfig = mergeDeep(BASE_DEFAULTS, userConfig)
  cacheMtime = mtime
  return cacheConfig
}

/**
 * 读取单个子配置，允许额外传入模块局部默认值进行覆盖
 * @param {string} section 配置段名，如 'lyrics'
 * @param {object} extraDefaults 模块内的额外默认值
 * @returns {object}
 */
export function getConfigSection (section, extraDefaults = {}) {
  const full = loadConfig()
  const base = BASE_DEFAULTS[section] || {}
  const mergedDefaults = mergeDeep(base, extraDefaults)
  return mergeDeep(mergedDefaults, full[section] || {})
}

/**
 * 获取配置文件绝对路径，便于日志或写入使用
 */
export function getConfigPath () {
  return CONFIG_PATH
}

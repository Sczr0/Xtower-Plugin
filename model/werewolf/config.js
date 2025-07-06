// model/werewolf/config.js
import YAML from 'yaml';
import fs from 'fs';
import path from 'path';

// 导入所有角色类
import { BaseRole } from './roles/BaseRole.js';
import { Hunter } from './roles/Hunter.js';
import { Seer } from './roles/Seer.js';
import { Werewolf } from './roles/Werewolf.js';
import { Witch } from './roles/Witch.js';
import { WolfKing } from './roles/WolfKing.js';
import { WhiteWolfKing } from './roles/WhiteWolfKing.js';
import { Idiot } from './roles/Idiot.js';
import { Villager } from './roles/Villager.js';

import { ROLES } from './constants.js';

// 假设 config.yaml 在项目根目录下的 config 文件夹内
const CONFIG_PATH = path.join(process.cwd(), 'config', 'config.yaml');

// 角色映射表
export const ROLES_MAP = {
    [ROLES.WEREWOLF]: Werewolf,
    [ROLES.VILLAGER]: Villager,
    [ROLES.SEER]: Seer,
    [ROLES.WITCH]: Witch,
    [ROLES.HUNTER]: Hunter,
    // [ROLES.GUARD]: Guard, // 假设存在Guard角色
    [ROLES.WOLF_KING]: WolfKing,
    [ROLES.WHITE_WOLF_KING]: WhiteWolfKing,
    [ROLES.IDIOT]: Idiot,
};

const DEFAULT_WEREWOLF_CONFIG = {
    enableSheriff: true, // 是否开启警长机制，默认开启
    exileTieHandling: 'no_exile', // 平票处理方式: 'pk' (PK发言再投票), 'random' (随机放逐), 'no_exile' (无人放逐)，默认为无人放逐
    gameEndConditions: 'wolf_kill', // 游戏胜利条件: 'town_kill' (屠城), 'wolf_kill' (屠边)，默认为屠边
    enableLastWords: true, // 是否开启遗言，默认开启
    lastWordDuration: 60, // 遗言持续时间 (秒)，默认60秒
    lastWordMaxLength: 100, // 遗言最大字数，默认100字
    enablePostGameReview: true, // 是否开启赛后回顾，默认开启
    postGameReviewEvents: [ // 赛后回顾包含的事件类型
        'wolf_kill', 'witch_potion', 'seer_check', 'hunter_shoot', 'exiled'
    ],
    enableSelfExplosion: false, // 是否开启狼人自爆功能，默认关闭

    // 计时器配置
    nightActionDuration: 30, // 夜晚行动计时器 (秒)，默认30秒
    sheriffSpeakDuration: 60, // 上警发言计时器 (秒)，默认60秒
    sheriffVoteDuration: 30, // 上警投票计时器 (秒)，默认30秒
    daySpeakDuration: 60, // 白天发言计时器 (秒)，默认60秒
    dayVoteDuration: 30, // 白天投票计时器 (秒)，默认30秒
};

let werewolfConfig = { ...DEFAULT_WEREWOLF_CONFIG };

function loadWerewolfConfig() {
    try {
        const fileContents = fs.readFileSync(CONFIG_PATH, 'utf8');
        const parsedConfig = YAML.parse(fileContents);
        if (parsedConfig.werewolf) {
            // 合并默认配置和文件中读取的配置
            werewolfConfig = { ...DEFAULT_WEREWOLF_CONFIG, ...parsedConfig.werewolf };
        }
    } catch (e) {
        console.error('加载狼人杀配置文件失败，使用默认配置:', e);
    }
    return werewolfConfig;
}

// 首次加载配置
loadWerewolfConfig();

export default werewolfConfig;
export { loadWerewolfConfig }; // 导出以便外部可以重新加载配置
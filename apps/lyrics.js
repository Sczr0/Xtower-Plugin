import fs from 'fs';
import path from 'path';
import fse from 'fs-extra';
import common from '../../../lib/common/common.js';
import { glob } from 'glob';
import yaml from 'js-yaml'; // 新增：引入yaml库

// ================= 配置 =================
// 定义常量
const PLUGIN_ROOT = path.join(process.cwd(), 'plugins', 'Xtower-Plugin'); // 新增：插件根目录
const LYRIC_ROOT = path.join(PLUGIN_ROOT, 'data', 'lyrics');
const COMMON_LYRICS_DIR = path.join(LYRIC_ROOT, 'common_lyrics');
const TEMP_DIR = path.join(PLUGIN_ROOT, 'data', 'temp');
const LYRICS_DATA_CONFIG_PATH = path.join(LYRIC_ROOT, 'config.json'); // 修改：之前叫CONFIG_PATH，现在更明确是lyrics模块的数据配置
const PLUGIN_MASTER_CONFIG_PATH = path.join(PLUGIN_ROOT, 'config', 'config.yaml'); // 新增：统一配置文件路径

// 确保目录存在
function ensureDirectoriesExist(directories) {
    directories.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

// 调用函数确保目录存在
ensureDirectoriesExist([LYRIC_ROOT, COMMON_LYRICS_DIR, TEMP_DIR]);

import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 默认的 lyrics 动态配置模板 (保存到 lyrics_data_config.json)
const DEFAULT_LYRICS_DATA_CONFIG = {
    libraries: {},       // 用户歌词库 {'库名称': '路径'}
    repositories: {},    // Git仓库 {'仓库名': 'URL'}
    groupMapping: {},    // 群组映射 {'群号': '库名称'}
    rateLimit: {         // 频率限制 (这个会被 config.yaml 或用户设置或旧的json配置覆盖)
        maxPerHour: 60,
        cooldown: 3600 * 1000
    }
    // batch_draw_max_count 将从 config.yaml 读取，不在此处定义默认值
};

// 新增：读取插件主配置文件 (config.yaml)
function loadPluginMasterConfig() {
    try {
        if (fs.existsSync(PLUGIN_MASTER_CONFIG_PATH)) {
            const fileContents = fs.readFileSync(PLUGIN_MASTER_CONFIG_PATH, 'utf8');
            const data = yaml.load(fileContents);
            return data || {}; // 返回空对象如果文件为空或解析结果为null/undefined
        }
        console.warn(`[Xtower-Plugin] 主配置文件 ${PLUGIN_MASTER_CONFIG_PATH} 未找到。`);
    } catch (error) {
        console.error(`[Xtower-Plugin] 加载或解析 ${PLUGIN_MASTER_CONFIG_PATH} 出错:`, error);
    }
    return {}; // 返回空对象如果文件不存在或出错
}


// ================= 插件主类 =================
export class LyricsPlugin extends plugin {
    constructor() {
        super({
            name: '随机歌词',
            desc: '随机歌词与仓库管理',
            event: 'message',
            priority: 0,
            rule: [
                { reg: '^#?抽歌词\\s*(-riv)?$', fnc: 'drawLyrics' },
                { reg: '^#?抽歌词\\s+(\\d+)\\s*(-riv)?$', fnc: 'batchDraw' },
                { reg: '^#?(?:歌词检索|搜歌词)\\s+(.+)$', fnc: 'searchLyrics' },
                { reg: '^#获取歌词\\s+(.+?)\\s+(.+)$', fnc: 'fetchFromRepo' },
                { reg: '^#新建歌词仓库\\s+(.+)\\s+(.+)$', fnc: 'addRepo' },
                { reg: '^#删除歌词仓库\\s+(.+)$', fnc: 'removeRepo' },
                { reg: '^#新建歌词库\\s+(.+)$', fnc: 'createLib' },
                { reg: '^#删除歌词库\\s+(.+)$', fnc: 'removeLib' },
                { reg: '^#关联群组\\s+(\\d+)\\s+(.+)$', fnc: 'linkGroup' },
                { reg: '^#歌词库列表$', fnc: 'listLibs' },
                { reg: '^#仓库列表$', fnc: 'listRepos' },
                { reg: '^#设置频率限制\\s+(\\d+)\\s+(\\d+)$', fnc: 'setRateLimit' },
                { reg: '^#更新公用库\\s+(.+)$', fnc: 'updateCommon' }
            ]
        })

        this.logger = { // 使用Yunzai内置的logger或Bot.logger通常更好，但这里保持原样
            mark: (...args) => console.log('[随机歌词 MARK]', ...args),
            error: (...args) => console.error('[随机歌词 ERROR]', ...args),
            warn: (...args) => console.warn('[随机歌词 WARN]', ...args)
        }

        // 初始化系统
        this.#initSystem();
    }

    // ================= 私有方法 =================
    #initSystem() {
        // 1. 加载插件主配置 (config.yaml)
        const masterConfig = loadPluginMasterConfig();

        // 提取 lyrics 模块在主配置中的默认设置
        const lyricsMasterDefaults = masterConfig.lyrics || {};

        // 2. 加载或初始化 lyrics 模块的动态数据配置 (lyrics_data_config.json)
        //    同时将 config.yaml 中的默认值按优先级合并进去
        this.config = this.#loadLyricsDataConfigWithMigration(lyricsMasterDefaults);

        // 3. 将从 config.yaml 读取的 batch_draw_max_count (如果存在) 保存到实例属性
        //    如果yaml中没有，则使用一个硬编码的默认值
        this.configEffectiveBatchDrawMaxCount = lyricsMasterDefaults.batch_draw_max_count !== undefined
            ? Number(lyricsMasterDefaults.batch_draw_max_count)
            : 20; // 默认值20

        // 预加载歌词缓存
        this.cache = {
            lyrics: new Map(),    // 歌词目录缓存 {路径: {files: [], mtime}}
            rateLimit: new Map()  // 频率限制缓存 {群号: {count, resetAt}}
        };
        this.#refreshCache(COMMON_LYRICS_DIR);
        // this.#validateConfig(); // 如果需要，可以取消注释
    }

    // 修改：加载 lyrics 模块的动态配置 (lyrics_data_config.json)，并结合来自 config.yaml 的默认值
    #loadLyricsDataConfigWithMigration(lyricsMasterDefaults) {
        const legacyPaths = {
            libraries: path.join(LYRIC_ROOT, 'libraries.json'),
            repositories: path.join(LYRIC_ROOT, 'repositories.json'),
            groupMapping: path.join(LYRIC_ROOT, 'groupLyricsMapping.json')
        };

        let loadedDataFromJSON = {}; // 用于存储从 LYRICS_DATA_CONFIG_PATH 加载的数据

        // 1. 尝试从 LYRICS_DATA_CONFIG_PATH (即 data/lyrics/config.json) 加载数据
        if (fs.existsSync(LYRICS_DATA_CONFIG_PATH)) {
            try {
                loadedDataFromJSON = JSON.parse(fs.readFileSync(LYRICS_DATA_CONFIG_PATH, 'utf-8'));
            } catch (e) {
                this.logger.error(`模块配置文件 ${LYRICS_DATA_CONFIG_PATH} 解析失败, 将尝试从头开始或迁移旧数据:`, e);
                // loadedDataFromJSON 保持为空对象 {}
            }
        }

        // 2. 确定 rateLimit 配置，优先级:
        //    a. LYRICS_DATA_CONFIG_PATH 中的 rateLimit (用户通过命令设置并保存的)
        //    b. config.yaml 中的 lyrics.rateLimit (插件级默认)
        //    c. DEFAULT_LYRICS_DATA_CONFIG.rateLimit (代码级硬编码默认)
        let finalRateLimit;
        if (loadedDataFromJSON.rateLimit && Object.keys(loadedDataFromJSON.rateLimit).length > 0) {
            finalRateLimit = loadedDataFromJSON.rateLimit;
        } else if (lyricsMasterDefaults.rateLimit && Object.keys(lyricsMasterDefaults.rateLimit).length > 0) {
            finalRateLimit = lyricsMasterDefaults.rateLimit;
        } else {
            finalRateLimit = { ...DEFAULT_LYRICS_DATA_CONFIG.rateLimit };
        }

        // 3. 初始化当前模块的配置对象 (this.config)
        //    对于 libraries, repositories, groupMapping，优先使用 LYRICS_DATA_CONFIG_PATH 中的数据，
        //    如果不存在，则使用 DEFAULT_LYRICS_DATA_CONFIG 中的空对象作为初始值。
        const currentDataConfig = {
            libraries: loadedDataFromJSON.libraries || { ...DEFAULT_LYRICS_DATA_CONFIG.libraries },
            repositories: loadedDataFromJSON.repositories || { ...DEFAULT_LYRICS_DATA_CONFIG.repositories },
            groupMapping: loadedDataFromJSON.groupMapping || { ...DEFAULT_LYRICS_DATA_CONFIG.groupMapping },
            rateLimit: finalRateLimit // 使用上面确定的 finalRateLimit
        };

        // 4. 迁移旧的独立json配置文件 (libraries.json, repositories.json, groupLyricsMapping.json)
        //    仅当 LYRICS_DATA_CONFIG_PATH 中对应的键不存在或为空时，才尝试迁移。
        let migrated = false;
        Object.entries(legacyPaths).forEach(([key, filePath]) => {
            if (!loadedDataFromJSON[key] || Object.keys(loadedDataFromJSON[key]).length === 0) {
                if (fs.existsSync(filePath)) {
                    try {
                        currentDataConfig[key] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                        fs.renameSync(filePath, `${filePath}.bak`); // 备份旧文件
                        this.logger.mark(`成功迁移旧配置 ${key} 到 ${LYRICS_DATA_CONFIG_PATH}`);
                        migrated = true;
                    } catch (e) {
                        this.logger.error(`迁移旧 ${key} 配置失败:`, e);
                    }
                }
            }
        });

        // 5. 如果进行了迁移操作，或者 LYRICS_DATA_CONFIG_PATH 文件原先不存在，
        //    则将整合后的配置保存到 LYRICS_DATA_CONFIG_PATH。
        if (migrated || !fs.existsSync(LYRICS_DATA_CONFIG_PATH)) {
            this.#saveLyricsDataConfig(currentDataConfig);
        }

        return currentDataConfig; // 返回最终的模块配置对象
    }

    // 修改：保存 lyrics 模块的动态配置到 LYRICS_DATA_CONFIG_PATH (data/lyrics/config.json)
    #saveLyricsDataConfig(data) {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }
        this.saveTimer = setTimeout(() => {
            try {
                // data 参数已经是纯粹的 lyrics 模块动态数据，可以直接保存
                fs.writeFileSync(LYRICS_DATA_CONFIG_PATH, JSON.stringify(data, null, 2));
                this.logger.mark(`模块配置文件 ${LYRICS_DATA_CONFIG_PATH} 保存成功`);
            } catch (err) {
                this.logger.error(`模块配置文件 ${LYRICS_DATA_CONFIG_PATH} 保存失败:`, err);
            } finally {
                this.saveTimer = null;
            }
        }, 500); // 500ms 防抖延迟
    }

    // ================= 歌词 =================
    #refreshCache(dir) {
        if (!fs.existsSync(dir)) return;
        try {
            const files = fs.readdirSync(dir)
                .filter(f => f.endsWith('.txt'))
                .filter(f => {
                    try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; }
                });

            this.cache.lyrics.set(dir, {
                files,
                mtime: Date.now()
            });
        } catch (error) {
            this.logger.error(`刷新缓存目录 ${dir} 失败:`, error);
        }
    }

    #getTargetDir(groupId) {
        const libName = this.config.groupMapping[String(groupId)]; // 确保groupId是字符串
        return libName && this.config.libraries[libName] ?
            this.config.libraries[libName] :
            COMMON_LYRICS_DIR;
    }

    #getRandomLyric(targetDir, isRiv) {
        try {
            const cache = this.cache.lyrics.get(targetDir);
            if (!cache || Date.now() - cache.mtime > 1800000) { // 30分钟刷新一次
                this.#refreshCache(targetDir);
            }

            const updatedCache = this.cache.lyrics.get(targetDir); // 重新获取可能已更新的缓存
            if (!updatedCache || !updatedCache.files || updatedCache.files.length === 0) {
                throw new Error(`歌词库为空或无法访问: ${targetDir}`);
            }
            const { files } = updatedCache;

            const file = files[Math.floor(Math.random() * files.length)];
            const filePath = path.join(targetDir, file);
            const content = fs.readFileSync(filePath, 'utf-8').replace(/\r\n?/g, '\n');

            const chunks = content.split('\n\n');
            const author = `——${path.basename(file, '.txt')}`;

            return chunks.length === 1 ?
                this.#handleSingleLine(content, author, isRiv) :
                this.#handleMultiLine(chunks, author, isRiv);
        } catch (err) {
            this.logger.error('歌词获取失败:', err);
            return '[随机歌词] 歌词服务暂时不可用，请提醒Bot主检查配置或歌词库文件。';
        }
    }

    #handleSingleLine(content, author, isRiv) {
        const lines = content.split('\n').filter(line => line.trim() !== ''); // 过滤空行
        if (lines.length === 0) return isRiv ? "..." : `...\n${author}`; // 防止空文件或只有空行
        const selected = lines[Math.floor(Math.random() * lines.length)];
        return isRiv ? selected : `${selected}\n${author}`;
    }

    #handleMultiLine(chunks, author, isRiv) {
        const validChunks = chunks.filter(chunk => chunk.trim() !== ''); // 过滤空段落
        if (validChunks.length === 0) return isRiv ? "..." : `...\n${author}`;
        const chunk = validChunks[Math.floor(Math.random() * validChunks.length)];
        return isRiv ? chunk : `${chunk}\n${author}`;
    }

    // ================= 指令处理 =================
    async drawLyrics(e) {
        const groupId = String(e.group_id);
        // 只需获取 maxPerHour，因为周期是固定的1小时
        const { maxPerHour } = this.config.rateLimit;
        // 定义1小时的毫秒数作为固定的频率周期
        const ONE_HOUR_IN_MS = 3600 * 1000;

        if (!this.cache.rateLimit.has(groupId)) {
            this.cache.rateLimit.set(groupId, { count: 0, resetAt: Date.now() });
        }

        const limit = this.cache.rateLimit.get(groupId);

        // 检查自上次重置以来是否已超过1小时
        if (Date.now() - limit.resetAt > ONE_HOUR_IN_MS) {
            // 如果超过1小时，则重置计数和重置时间戳
            limit.count = 0;
            limit.resetAt = Date.now();
        }

        // 检查在本小时周期内是否已达到次数上限
        if (limit.count >= maxPerHour) {
            // 计算当前1小时周期还剩多少分钟
            const remainingMs = ONE_HOUR_IN_MS - (Date.now() - limit.resetAt);
            const remainingMinutes = Math.ceil(remainingMs / 60000);
            await e.reply(`[随机歌词] 「冷却中」 (大约还需等待 ${remainingMinutes > 0 ? remainingMinutes : 1} 分钟)`);
            return;
        }

        const isRiv = e.msg.includes('-riv');
        const lyrics = this.#getRandomLyric(this.#getTargetDir(groupId), isRiv);
        await e.reply(lyrics);

        // 成功抽取后，计数加一
        limit.count++;
    }

    async batchDraw(e) {
        const match = e.msg.match(/^#?抽歌词\s+(\d+)\s*(-riv)?$/);
        if (!match) return await e.reply('❌ 格式：抽歌词 数量 [-riv]');

        const [_, countStr, rivFlag] = match;
        const isRiv = !!rivFlag;

        // 使用 this.configEffectiveBatchDrawMaxCount (来自 config.yaml 或硬编码默认值)
        const maxCount = this.configEffectiveBatchDrawMaxCount;
        let count = parseInt(countStr);

        if (isNaN(count) || count <= 0) {
            return await e.reply(`[随机歌词] 抽歌数量必须是正整数。`);
        }
        if (count > maxCount) {
            await e.reply(`[随机歌词] 单次最多抽取 ${maxCount} 条歌词哦~已调整为 ${maxCount} 条。`);
            count = maxCount;
        }

        const lyricsList = Array.from({ length: count }, () =>
            this.#getRandomLyric(this.#getTargetDir(String(e.group_id)), isRiv)
        );

        const msg = await common.makeForwardMsg(e, lyricsList, `[随机歌词] x${count}`);
        await e.reply(msg);
    }

    // 歌词检索：按群映射库或公共库搜索关键字
    async searchLyrics(e) {
        const match = e.msg.match(/^#?(?:歌词检索|搜歌词)\s+(.+)$/);
        if (!match) {
            return await e.reply('[随机歌词] 用法：#歌词检索 关键词');
        }

        const keywordRaw = match[1].trim();
        if (!keywordRaw) {
            return await e.reply('[随机歌词] 请输入要检索的关键词。');
        }

        const keyword = keywordRaw.toLowerCase();
        // 依据群配置获取检索目录：
        // - 群未关联或私聊：使用公共库
        // - 已关联：仅检索该库
        const groupId = String(e.group_id);
        const targetDir = this.#getTargetDir(groupId);

        // 若目录不存在或为空，尝试刷新缓存后判断
        this.#refreshCache(targetDir);

        let files = [];
        try {
            // 递归检索该库下所有 txt
            files = await glob('**/*.txt', { cwd: targetDir, absolute: true, nodir: true });
        } catch (err) {
            this.logger.error('检索时列举文件失败:', err);
        }

        if (!files || files.length === 0) {
            return await e.reply(`[随机歌词] 目标歌词库为空或不可用：${targetDir}`);
        }

        const results = [];
        const LIMIT = 100; // 默认返回前 100 条匹配片段

        // 转义关键词以安全用于正则
        const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escaped = escapeRegExp(keywordRaw);
        const testRegex = new RegExp(escaped, 'i');
        const replaceRegex = new RegExp(escaped, 'gi');

        for (const filePath of files) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8').replace(/\r\n?/g, '\n');
                const chunks = content.split('\n\n').filter(s => s.trim() !== '');
                for (const chunk of chunks) {
                    if (testRegex.test(chunk)) {
                        const author = `— ${path.basename(filePath, '.txt')}`;
                        const highlighted = chunk.replace(replaceRegex, '「$&」');
                        results.push(`${highlighted}\n${author}`);
                        if (results.length >= LIMIT) break;
                    }
                }
                if (results.length >= LIMIT) break;
            } catch (err) {
                // 单个文件读取失败不影响整体
                this.logger.warn('读取歌词文件失败（已跳过）:', filePath, err?.message || err);
            }
        }

        if (results.length === 0) {
            return await e.reply(`[随机歌词] 未在当前歌词库检索到：${keywordRaw}`);
        }

        if (results.length === 1) {
            return await e.reply(results[0]);
        }

        const forward = await common.makeForwardMsg(e, results, `[歌词检索] 命中 ${results.length} 条`);
        await e.reply(forward);
    }

    // ================= 管理功能 =================
    // 以下所有调用 this.#saveConfig 的地方都已改为 this.#saveLyricsDataConfig
    async addRepo(e) {
        if (!e.isMaster) {
            e.reply("无权限");
            return false;
        }
        const match = e.msg.match(/^#?新建歌词仓库\s+([\u4e00-\u9fa5\w-]+)\s+(.+)$/); // 仓库名允许中英文数字下划线短横线
        if (!match) return await e.reply('[随机歌词] 格式错误！正确格式：#新建歌词仓库 名称 仓库URL');
        const [_, name, url] = match;

        try {
            new URL(url); // 简单验证URL格式
            if (!url.endsWith('.git')) { // 简单检查是否git仓库
                await e.reply('[随机歌词] 仓库URL似乎不是一个有效的 .git 地址。');
                return;
            }
        } catch {
            await e.reply('[随机歌词] 仓库URL格式无效，请使用完整的git地址。');
            return;
        }

        if (this.config.repositories[name]) {
            await e.reply(`[随机歌词] 仓库【${name}】已经存在啦，换个名字试试？`);
            return;
        }

        this.config.repositories[name] = url;
        this.#saveLyricsDataConfig(this.config);
        await e.reply(`[随机歌词] 新歌词仓库【${name}】添加成功！`);
    }

    async updateCommon(e) {
        if (!e.isMaster) {
            e.reply("无权限");
            return false;
        }
        const repoName = e.msg.split(' ')[1]?.trim();
        if (!repoName) {
            return await e.reply('[随机歌词] 请指定要用于更新公用库的仓库名称。');
        }
        const repoUrl = this.config.repositories[repoName];

        if (!repoUrl) {
            await e.reply(`[随机歌词] 没找到名为【${repoName}】的仓库。请先使用 #新建歌词仓库 添加它。`);
            return;
        }

        await e.reply(`[随机歌词] 正在从仓库【${repoName}】更新公用库，请稍候...`);
        try {
            await this.#syncRepo(COMMON_LYRICS_DIR, repoUrl);
            this.#refreshCache(COMMON_LYRICS_DIR); // 同步后刷新缓存
            await e.reply(`[随机歌词] 公用库已成功从【${repoName}】更新！`);
        } catch (err) {
            this.logger.error(`更新公用库 ${repoName} 失败:`, err);
            await e.reply(`[随机歌词] 同步仓库【${repoName}】失败: ${err.message}`);
        }
    }

    async #syncRepo(targetDir, repoUrl) {
        const { execa } = await import('execa'); // 动态导入
        // 从URL中提取一个适合做目录名的仓库名
        let safeRepoName = 'default_repo';
        try {
            safeRepoName = new URL(repoUrl).pathname.split('/').pop().replace(/\.git$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
        } catch { /*保持默认*/ }

        const tempDir = path.join(TEMP_DIR, `sync_${Date.now()}_${safeRepoName}`);

        try {
            await fse.ensureDir(tempDir);
            this.logger.mark(`创建临时同步目录: ${tempDir}`);

            const gitDirInTarget = path.join(targetDir, '.git');
            const isTargetRepoExist = await fse.pathExists(gitDirInTarget);

            let sourceDirForSync = tempDir; // 默认从新克隆的目录同步

            if (isTargetRepoExist) {
                this.logger.mark(`目标目录 ${targetDir} 已是Git仓库，尝试拉取更新...`);
                try {
                    await execa('git', ['-C', targetDir, 'pull', '--rebase', '--autostash', '--depth=1'], { timeout: 60000 });
                    this.logger.mark(`仓库 ${targetDir} 更新成功。`);
                    sourceDirForSync = targetDir; // 直接使用目标目录作为源（因为它已更新）
                } catch (pullError) {
                    this.logger.warn(`在 ${targetDir} 执行 git pull 失败 (${pullError.message})，将尝试完整克隆到临时目录进行同步。`);
                    // 如果pull失败，则回退到完整克隆到tempDir的逻辑
                    await fse.emptyDir(tempDir); // 清空临时目录以备克隆
                    await execa('git', ['clone', '--depth=1', repoUrl, tempDir], { timeout: 120000 });
                    this.logger.mark(`仓库 ${repoUrl} 已克隆到 ${tempDir}`);
                }
            } else {
                this.logger.mark(`目标目录 ${targetDir} 不是Git仓库或首次同步，执行完整克隆...`);
                await execa('git', ['clone', '--depth=1', repoUrl, tempDir], { timeout: 120000 });
                this.logger.mark(`仓库 ${repoUrl} 已克隆到 ${tempDir}`);
            }

            this.logger.mark(`开始将 ${sourceDirForSync} 的 .txt 文件同步到 ${targetDir}`);
            await this.#syncFiles({
                src: sourceDirForSync,
                dest: targetDir,
                patterns: ['**/*.txt'] // 只同步txt文件
            });

            // 如果目标目录原先不是git仓库，或者pull失败后重新克隆了，
            // 那么现在 targetDir 可能还没有 .git 目录（如果 #syncFiles 只是复制文件内容）
            // 为了后续能pull，需要确保 .git 目录也被正确处理。
            // 一个更稳妥的方式是，如果 sourceDirForSync 是 tempDir (即新克隆的)
            // 且 targetDir 原来不是仓库，则需要将 .git 从 tempDir 移到 targetDir。
            // 但 #syncFiles 的robocopy /MIR 应该会处理好，rsync也类似。
            // 对于手动复制，需要注意。
            // 此处假设 #syncFiles 能够正确地使 dest 成为 src 的镜像（对于.txt文件）
            // 并且如果 dest 原来不是 repo，则它现在包含了来自 src 的 .git (如果src是tempDir)
            // 或 dest 本身的 .git (如果src是targetDir且pull成功)

            // 如果源是临时目录，并且目标目录是空的或者不是git仓库，则把.git也复制过去
            if (sourceDirForSync === tempDir && !isTargetRepoExist) {
                const tempGitDir = path.join(tempDir, '.git');
                if (await fse.pathExists(tempGitDir)) {
                    this.logger.mark(`将 .git 目录从 ${tempDir} 复制到 ${targetDir}`);
                    await fse.copy(tempGitDir, gitDirInTarget, { overwrite: true });
                }
            }


            const { stdout: hash } = await execa('git', ['rev-parse', 'HEAD'], {
                cwd: targetDir, // 确保在目标目录获取版本
                stdio: ['ignore', 'pipe', 'ignore']
            }).catch(() => ({ stdout: 'N/A' })); // 获取commit hash失败时的回退

            this.logger.mark(`同步完成！仓库 ${targetDir} 当前版本: ${hash.slice(0, 7)}`);

        } catch (error) {
            this.logger.error(`同步仓库 ${repoUrl} 到 ${targetDir} 过程中发生严重错误:`, error);
            throw error; // 将错误抛出，让调用者处理
        } finally {
            if (await fse.pathExists(tempDir)) {
                this.logger.mark(`清理临时同步目录: ${tempDir}`);
                await this.#nukeDirectory(tempDir).catch(err =>
                    this.logger.warn(`清理临时目录 ${tempDir} 遇到问题: ${err.message}`)
                );
            }
        }
    }

    async #syncFiles({ src, dest, patterns }) {
        await fse.ensureDir(dest); // 确保目标目录存在

        if (process.platform === 'win32') {
            const { execa } = await import('execa');
            // Robocopy: /MIR 镜像，/XO 排除旧文件，/XF 排除指定文件，/XD 排除指定目录
            // 我们只关心 txt 文件，所以用 /IF 包含 .txt，然后 /MIR
            // 注意：robocopy /MIR 会删除 dest 中存在但 src 中不存在的文件和目录。
            // 如果只想复制 txt，则需要更精细的控制，或者先清空dest中的txt再复制。
            // 为了简单起见，假设我们就是想让 dest 中的 txt 文件与 src 中的 txt 文件一致。
            await execa('robocopy', [
                src, dest,
                '*.txt', // 只复制txt文件
                '/S',    // 复制子目录，但不包括空目录
                '/XO',   // 排除较旧的文件 (通常用于备份，同步时可能不需要)
                '/NJH', '/NJS', '/NDL', '/NC', '/NS', // 精简输出
                // '/PURGE' // 删除目标中不存在于源的文件/目录。配合 /S 相当于部分镜像。
                // 但只针对 *.txt，其他文件不受影响。
            ], { windowsVerbatimArguments: true, shell: true, timeout: 120000 });
        } else {
            // 使用 rsync (如果可用) 或 glob + fse.copy
            try {
                const { execa } = await import('execa');
                // rsync: -a 归档模式, -m 清理空目录, --delete 删除dest中src不存在的文件, --include='*.txt' --exclude='*'
                // 下面的命令会使得 dest 中的 txt 文件与 src 中的 txt 文件完全一致，其他文件不受影响
                await execa('rsync', [
                    '-rtm', // recursive, times, prune-empty-dirs
                    '--delete', // delete extraneous files from dest dirs
                    '--include=**/', // ensures directories are traversed
                    '--include=*.txt', // include all .txt files
                    '--exclude=*', // exclude all other files at the top level of each dir
                    `${src}/`, `${dest}/` // 注意末尾的斜杠
                ], { timeout: 120000 });
                this.logger.mark(`使用 rsync 同步 ${src} 到 ${dest} 完成。`);
            } catch (rsyncErr) {
                this.logger.warn(`rsync 执行失败 (${rsyncErr.message})，回退到手动复制...`);
                // 回退到 glob 和 fse.copy
                // 1. 清理目标目录中所有 .txt 文件，防止旧文件残留
                const oldTxtFiles = await glob('**/*.txt', { cwd: dest, nodir: true });
                await Promise.all(oldTxtFiles.map(file => fse.remove(path.join(dest, file))));

                // 2. 匹配源目录中的 .txt 文件
                const filesToCopy = await glob(patterns, {
                    cwd: src,
                    nodir: true,
                    ignore: ['**/.git/**'] // 避免复制 .git 内部的东西
                });

                // 3. 并行复制文件
                await Promise.all(filesToCopy.map(async (fileRelativePath) => {
                    const srcPath = path.join(src, fileRelativePath);
                    const destPath = path.join(dest, fileRelativePath);
                    await fse.ensureDir(path.dirname(destPath)); // 确保目标子目录存在
                    await fse.copy(srcPath, destPath, { overwrite: true });
                }));
                this.logger.mark(`手动复制 ${filesToCopy.length} 个 .txt 文件从 ${src} 到 ${dest} 完成。`);
            }
        }
    }

    async #nukeDirectory(dir) {
        try {
            if (await fse.pathExists(dir)) {
                await fse.remove(dir);
                this.logger.mark(`目录 ${dir} 清理完成。`);
            }
        } catch (err) {
            this.logger.warn(`使用 fs-extra 清理目录 ${dir} 失败: ${err.message}。尝试强制删除...`);
            try {
                // 尝试更强的删除方法，例如使用 execa 调用系统命令
                const { execa } = await import('execa');
                if (process.platform === 'win32') {
                    await execa('cmd', ['/c', 'rd', '/s', '/q', dir], { shell: true });
                } else {
                    await execa('rm', ['-rf', dir], { shell: true });
                }
                if (await fse.pathExists(dir)) {
                    throw new Error(`强制删除后目录 ${dir} 仍然存在。`);
                }
                this.logger.mark(`目录 ${dir} 强制清理完成。`);
            } catch (forceErr) {
                this.logger.error(`强制清理目录 ${dir} 失败: ${forceErr.message}。可能需要手动清理。`);
                // 不向上抛出错误，避免阻塞其他逻辑，只记录错误
            }
        }
    }


    async createLib(e) {
        if (!e.isMaster) {
            e.reply("无权限");
            return false;
        }
        const libName = e.msg.split(' ')[1]?.trim();
        if (!libName) return await e.reply('[随机歌词] 请提供歌词库名称！格式：#新建歌词库 歌词库名');

        if (/[\\/:*?"<>|]/.test(libName) || libName === '.' || libName === '..') {
            return await e.reply('[随机歌词] 歌词库名称包含非法字符或为保留名称。');
        }

        const libPath = path.join(LYRIC_ROOT, libName);

        try {
            if (fs.existsSync(libPath)) {
                return await e.reply(`[随机歌词] 歌词库【${libName}】已经存在啦，换个名字试试？`);
            }

            await fs.promises.mkdir(libPath, { recursive: true });
            this.config.libraries[libName] = libPath; // 存储的是绝对路径
            this.#saveLyricsDataConfig(this.config);
            await e.reply(`[随机歌词] 新建歌词库【${libName}】成功！路径: ${libPath}\n快用【#获取歌词 ${libName} 仓库名】从仓库同步内容吧～`);
        } catch (err) {
            this.logger.error(`创建歌词库 ${libName} 失败:`, err);
            await e.reply(`[随机歌词] 创建歌词库【${libName}】失败：${err.message}`);
        }
    }

    async linkGroup(e) {
        if (!e.isMaster) {
            e.reply("无权限");
            return false;
        }
        const match = e.msg.match(/^#?关联群组\s+(\d+)\s+([\u4e00-\u9fa5\w-]+)$/);
        if (!match) return await e.reply('[随机歌词] 格式不对哦～示范：#关联群组 群号 歌词库名');

        const [_, groupId, libName] = match;
        if (!this.config.libraries[libName]) {
            return await e.reply(`[随机歌词] 没找到名为【${libName}】的歌词库。请先使用 #新建歌词库 创建它。`);
        }

        this.config.groupMapping[groupId] = libName;
        this.#saveLyricsDataConfig(this.config);
        await e.reply(`[随机歌词] 群组 ${groupId} 成功关联到歌词库【${libName}】啦！`);
    }

    async fetchFromRepo(e) {
        if (!e.isMaster) {
            e.reply("无权限");
            return false;
        }
        const match = e.msg.match(/^#?获取歌词\s+([\u4e00-\u9fa5\w-]+)\s+([\u4e00-\u9fa5\w-]+)$/);
        if (!match) return await e.reply('📌 格式：#获取歌词 目标歌词库名 仓库名');

        const [_, libName, repoName] = match;
        if (!this.config.libraries[libName]) {
            return await e.reply(`[随机歌词] 目标歌词库【${libName}】不存在。请先使用 #新建歌词库 创建。`);
        }
        if (!this.config.repositories[repoName]) {
            return await e.reply(`[随机歌词] 仓库【${repoName}】不存在。请先使用 #新建歌词仓库 添加。`);
        }

        const targetLibPath = this.config.libraries[libName];
        const repoUrl = this.config.repositories[repoName];

        await e.reply(`[随机歌词] 正在从仓库【${repoName}】同步到歌词库【${libName}】(${targetLibPath})，请稍候...`);
        try {
            await this.#syncRepo(targetLibPath, repoUrl);
            this.#refreshCache(targetLibPath); // 同步后刷新缓存
            await e.reply(`[随机歌词] 歌词库【${libName}】已成功从仓库【${repoName}】同步！`);
        } catch (err) {
            this.logger.error(`同步 ${repoName} 到 ${libName} 失败:`, err);
            await e.reply(`[随机歌词] 同步失败：${err.message}`);
        }
    }

    async listLibs(e) {
        // 无需主人权限，普通用户也可查看
        const libs = Object.keys(this.config.libraries);
        if (libs.length === 0) {
            return await e.reply('[随机歌词] 当前没有创建任何歌词库。主人可以使用 #新建歌词库 来创建。');
        }

        let response = '[随机歌词] 现有歌词库列表：\n';
        response += libs.map(lib => `  - ${lib}`).join('\n');

        // 显示群聊关联情况
        const currentGroupLib = this.config.groupMapping[String(e.group_id)];
        if (currentGroupLib) {
            response += `\n\n本群 (${e.group_id}) 当前关联歌词库: 【${currentGroupLib}】`;
        } else {
            response += `\n\n本群 (${e.group_id}) 未指定歌词库，将使用公共歌词库。`;
        }
        if (e.isMaster) {
            response += `\n主人可以使用 #关联群组 群号 歌词库名 来设置。`;
        }
        await e.reply(response);
    }

    async listRepos(e) {
        if (!e.isMaster) { // 此命令通常涉及仓库URL，可能敏感，设为主人权限
            e.reply("无权限");
            return false;
        }
        const entries = Object.entries(this.config.repositories);
        if (entries.length === 0) {
            return await e.reply('[随机歌词] 尚未添加任何歌词仓库。请使用 #新建歌词仓库 名称 URL 来添加。');
        }

        let response = '[随机歌词] 已添加的云端仓库列表：\n';
        response += entries.map(([name, url]) =>
            `✨ ${name}\n   ➤ ${url}` // 显示完整URL
        ).join('\n');
        response += '\n\n使用【#获取歌词 目标歌词库名 仓库名】可将仓库内容同步到指定歌词库。';
        await e.reply(response);
    }

    async removeLib(e) {
        if (!e.isMaster) {
            e.reply("无权限");
            return false;
        }
        const libName = e.msg.split(' ')[1]?.trim();
        if (!libName) return await e.reply('[随机歌词] 请指定要删除的歌词库名称。格式：#删除歌词库 歌词库名');

        if (!this.config.libraries[libName]) {
            return await e.reply(`[随机歌词] 歌词库【${libName}】不存在。`);
        }

        const libPath = this.config.libraries[libName];

        // 检查是否有群组关联此库
        const affectedGroups = Object.entries(this.config.groupMapping)
            .filter(([_, mappedLibName]) => mappedLibName === libName)
            .map(([groupId, _]) => groupId);

        if (affectedGroups.length > 0 && !e.msg.includes('--force')) {
            return await e.reply([
                `[随机歌词] 警告！歌词库【${libName}】正被以下群组使用:`,
                `${affectedGroups.join(', ')}`,
                `删除此库将导致这些群组回退到使用公共库。`,
                `如确认删除，请使用命令： #删除歌词库 ${libName} --force`
            ].join('\n'));
        }

        try {
            await this.#safeRemoveDir(libPath); // 安全删除目录
            delete this.config.libraries[libName];

            // 如果强制删除，解除关联群组
            if (affectedGroups.length > 0) {
                affectedGroups.forEach(groupId => {
                    delete this.config.groupMapping[groupId];
                });
            }

            this.#saveLyricsDataConfig(this.config);
            let replyMsg = `[随机歌词] 歌词库【${libName}】及其本地文件已成功删除。`;
            if (affectedGroups.length > 0) {
                replyMsg += `\n已自动解除其与群组 ${affectedGroups.join(', ')} 的关联。`;
            }
            await e.reply(replyMsg);
        } catch (err) {
            this.logger.error(`删除歌词库 ${libName} (路径: ${libPath}) 失败:`, err);
            await e.reply(`[随机歌词] 删除歌词库【${libName}】失败：${err.message}`);
        }
    }

    async removeRepo(e) {
        if (!e.isMaster) {
            e.reply("无权限");
            return false;
        }
        const repoName = e.msg.split(' ')[1]?.trim();
        if (!repoName) return await e.reply('[随机歌词] 请指定要删除的仓库配置名称。格式：#删除歌词仓库 仓库名');

        if (!this.config.repositories[repoName]) {
            return await e.reply(`[随机歌词] 名为【${repoName}】的仓库配置不存在。`);
        }

        // 删除仓库配置本身很简单，但重要的是提示用户这不会删除已同步到歌词库的本地文件
        // 也不影响歌词库与群组的关联（因为关联是基于歌词库名，而非仓库名）

        delete this.config.repositories[repoName];
        this.#saveLyricsDataConfig(this.config);

        await e.reply(
            `[随机歌词] 仓库配置【${repoName}】已成功删除。\n` +
            `请注意：这仅移除了仓库的记录，不会删除任何已通过此仓库同步到本地歌词库的文件。` +
            `如果需要删除对应的本地歌词库，请使用 #删除歌词库 命令。`
        );
    }

    async setRateLimit(e) {
        if (!e.isMaster) {
            e.reply("无权限");
            return false;
        }
        // 修改正则表达式，只匹配一个数字参数
        const match = e.msg.match(/^#?设置频率限制\s+(\d+)$/);
        if (!match) {
            // 更新帮助信息
            return await e.reply('⏳ 格式：#设置频率限制 每小时次数');
        }

        const [_, maxStr] = match;
        const maxPerHour = parseInt(maxStr);

        // 更新验证逻辑
        if (isNaN(maxPerHour) || maxPerHour < 0) {
            return await e.reply('[随机歌词] 参数无效。每小时次数必须是一个大于或等于0的数字。');
        }

        // 只保存 maxPerHour
        this.config.rateLimit = {
            maxPerHour: maxPerHour
        };
        this.#saveLyricsDataConfig(this.config); // 保存到 lyrics_data_config.json

        // 更新回复消息
        await e.reply([
            `[随机歌词] 频率限制已更新！`,
            `每小时最多抽歌: ${maxPerHour}次`,
            `此设置为全局默认，并已保存。`
        ].join('\n'));
    }
    async #safeRemoveDir(targetDirAbs) {
        // 再次确认路径安全性，确保只删除 LYRIC_ROOT 下的目录
        const safeBase = path.resolve(LYRIC_ROOT); // 获取绝对路径以进行比较
        const resolvedTargetDir = path.resolve(targetDirAbs);

        if (!resolvedTargetDir.startsWith(safeBase) || resolvedTargetDir === safeBase) {
            // 禁止删除 LYRIC_ROOT 本身或其外部的目录
            throw new Error(`[随机歌词] 安全限制：无法删除目录 ${targetDirAbs}。只能删除位于 ${LYRIC_ROOT} 内的子目录。`);
        }

        if (!fs.existsSync(resolvedTargetDir)) {
            this.logger.warn(`尝试删除不存在的目录: ${resolvedTargetDir}`);
            return;
        }

        this.logger.mark(`准备安全删除目录: ${resolvedTargetDir}`);
        await fse.remove(resolvedTargetDir); // fs-extra的remove是递归且安全的

        if (fs.existsSync(resolvedTargetDir)) {
            throw new Error(`[随机歌词] 目录 ${resolvedTargetDir} 删除后依然存在，可能需要手动清理。`);
        }
        this.logger.mark(`目录 ${resolvedTargetDir} 已成功安全删除。`);
    }
}

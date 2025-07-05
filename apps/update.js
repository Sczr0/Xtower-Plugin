import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { exec, execSync } = require("child_process");
import lodash from 'lodash';
import common from '../../../lib/common/common.js';

const PLUGIN_NAME = 'Xtower-Plugin';
const PLUGIN_PATH = `./plugins/${PLUGIN_NAME}/`;
const GITEE_URL = 'https://gitee.com/sczr/Xtower-Plugin';
const GITHUB_URL = 'https://github.com/Sczr0/Xtower-Plugin';

let updateStatus = false;

export class xtowerUpdate extends plugin {
    constructor() {
        super({
            name: 'Xtower更新',
            dsc: '更新插件',
            event: 'message',
            priority: 100,
            rule: [
                {
                    reg: /^(#|\/)?(xtower|弦塔)(强制)?更新$/i,
                    fnc: 'updatePlugin',
                }
            ]
        });
        this.task = {
            cron: '0 30 0 * * ?', // 每日0点30分执行
            name: 'Xtower-Plugin自动更新',
            fnc: this.autoUpdate.bind(this)
        };
    }

    async autoUpdate() {
        if (updateStatus) {
            logger.mark(`[${PLUGIN_NAME}] 上一个更新任务尚未完成，跳过本次自动更新。`);
            return;
        }
        logger.mark(`[${PLUGIN_NAME}] 开始执行自动更新...`);
        
        updateStatus = true;
        try {
            const oldCommitId = await getCommitId();
            const gitPullCmd = `git -C ${PLUGIN_PATH} pull --no-rebase`;
            const ret = await execPromise(gitPullCmd);

            if (ret.error) {
                let errMsgText = `[${PLUGIN_NAME}] 自动更新失败！`;
                if (ret.error.toString().includes("Timed out") || /Failed to connect|unable to access/g.test(ret.error.toString())) {
                    errMsgText += `\n原因：网络连接失败或超时。`;
                } else if (ret.error.toString().includes("be overwritten by merge") || ret.stdout.includes("CONFLICT")) {
                    errMsgText += `\n原因：存在代码冲突，请手动处理后或使用【#弦塔强制更新】进行覆盖更新。`;
                }
                logger.error(errMsgText);
                logger.error(ret.error);
                updateStatus = false;
                return;
            }

            const newTime = await getPluginTime();
            if (/(Already up[ -]to[ -]date|已经是最新的)/.test(ret.stdout)) {
                logger.mark(`[${PLUGIN_NAME}] 当前已是最新版本，无需更新。\n最后更新时间: ${newTime}`);
            } else {
                logger.mark(`[${PLUGIN_NAME}] 自动更新成功！\n最后更新时间: ${newTime}`);
                const updateLog = await getUpdateLog(oldCommitId);
                if(updateLog.length > 0) {
                   logger.mark(`[${PLUGIN_NAME}] 更新日志：\n` + updateLog.join('\n'));
                }
                logger.mark(`[${PLUGIN_NAME}] 更新已应用，部分功能可能需要重启Yunzai生效。`);
            }
        } catch (error) {
            logger.error(`[${PLUGIN_NAME}] 自动更新执行出错:`, error);
        } finally {
            updateStatus = false;
        }
    }

        async updatePlugin(e) {
        if (!e.isMaster) {
            return e.reply('暂无权限，只有主人才能操作哦~');
        }

        if (updateStatus) {
            return e.reply(`[${PLUGIN_NAME}] 操作过于频繁，上一个更新任务还未结束哦~`);
        }
        
        updateStatus = true;

        try {
            const isForce = e.msg.includes("强制");
            let command = `git -C ${PLUGIN_PATH} pull --no-rebase`;

            if (isForce) {
                await e.reply(`[${PLUGIN_NAME}] 正在执行强制更新，将放弃本地修改，请稍候...`);
                command = `git -C ${PLUGIN_PATH} checkout . && ${command}`;
            } else {
                await e.reply(`[${PLUGIN_NAME}] 正在拉取最新代码，请稍候...`);
            }

            const oldCommitId = await getCommitId();
            const ret = await execPromise(command);

            if (ret.error) {
                await handleGitError(ret.error, ret.stdout, e);
                updateStatus = false;
                return;
            }

            const newTime = await getPluginTime();
            if (/(Already up[ -]to[ -]date|已经是最新的)/.test(ret.stdout)) {
                await e.reply(`[${PLUGIN_NAME}] 已经是最新版本啦！\n最后更新时间: ${newTime}`);
            } else {
                await e.reply(`[${PLUGIN_NAME}] 更新成功！\n最后更新时间: ${newTime}`);
                
                const logMessages = await getUpdateLog(oldCommitId);
                if (logMessages.length > 0) {
                    let forwardMsg = await common.makeForwardMsg(e, logMessages, `[${PLUGIN_NAME}] 更新日志`);
                    if (forwardMsg) {
                        await e.reply(forwardMsg);
                    } else {
                        // 提取纯文本进行降级回复
                        const plainTextLog = logMessages.map(item => item.message).join('\n');
                        e.reply(plainTextLog);
                    }
                }
                // --- 结束修复 ---
                
                await e.reply('更新已应用，部分功能可能需要重启Yunzai生效。');
            }
        } catch (error) {
            logger.error(`[${PLUGIN_NAME}] 更新过程发生错误:`, error);
            await e.reply(`[${PLUGIN_NAME}] 更新失败，请查看控制台日志获取详细信息。`);
        } finally {
            updateStatus = false;
        }
    }
}

/**
 * 执行一个shell命令并返回Promise
 * @param {string} cmd 
 * @returns {Promise<{error: Error, stdout: string, stderr: string}>}
 */
function execPromise(cmd) {
    return new Promise((resolve) => {
        exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
            resolve({ error, stdout, stderr });
        });
    });
}

/**
 * 获取插件的最后git提交时间
 */
async function getPluginTime() {
    const cm = `git -C ${PLUGIN_PATH} log -1 --pretty=format:"%cd" --date=format:"%Y-%m-%d %H:%M:%S"`;
    try {
        let time = await execSync(cm, { encoding: "utf-8" });
        return lodash.trim(time);
    } catch (error) {
        logger.error(`获取[${PLUGIN_NAME}]提交时间失败:`, error.toString());
        return "获取时间失败";
    }
}

/**
 * 获取上次提交的commitId
 */
async function getCommitId() {
    const cm = `git -C ${PLUGIN_PATH} rev-parse --short HEAD`;
    try {
        let commitId = await execSync(cm, { encoding: "utf-8" });
        return lodash.trim(commitId);
    } catch (error) {
        logger.error(`获取[${PLUGIN_NAME}]commitId失败:`, error.toString());
        return null;
    }
}

/**
 * 获取更新日志
 */
async function getUpdateLog(oldCommitId, e = null) {
    const cm = `git -C ${PLUGIN_PATH} log ${oldCommitId}..HEAD --pretty=format:"%h||[%cd] %s" --date=format:"%m-%d %H:%M" -20`;
    let log_str;
    try {
        log_str = await execSync(cm, { encoding: "utf-8" });
    } catch (error) {
        logger.error(error.toString());
        return [];
    }
    if (!log_str) return [];

    let logs = log_str.split("\n").map(line => {
        let [commit, message] = line.split("||");
        return message;
    }).filter(Boolean); // 过滤空行

    let log_msg = [`[${PLUGIN_NAME}] 更新日志:`];
    log_msg.push(...logs);
    
    // 非自动更新且是私聊/群聊消息，附带链接
    if (e) {
        log_msg.push(`\n更多详情请前往仓库查看:\nGitee: ${GITEE_URL}\nGitHub: ${GITHUB_URL}`);
    }

    if (e && (e.isGroup || e.isPrivate)) {
        // 制作转发消息
        return logs.map((msg, index) => ({
            message: `${index + 1}. ${msg}`,
            user_id: Bot.uin,
            nickname: Bot.nickname
        })).concat({
            message: `\n更多详情请前往仓库查看:\nGitee(首选): ${GITEE_URL}\nGitHub(备用): ${GITHUB_URL}`,
            user_id: Bot.uin,
            nickname: Bot.nickname
        });
    }

    return log_msg;
}

/**
 * 处理Git错误并回复
 */
async function handleGitError(err, stdout, e) {
    const errMsg = err.toString();
    stdout = stdout.toString();
    let replyMsg = `[${PLUGIN_NAME}] 更新失败！`;

    if (errMsg.includes("Timed out") || /Failed to connect|unable to access/g.test(errMsg)) {
        const remote = errMsg.match(/'(.+?)'/g)?.[0]?.replace(/'/g, "") || "远程仓库";
        replyMsg += `\n原因：连接 ${remote} 超时或失败。`;
        replyMsg += `\n\n💡提示：\n国内服务器建议使用Gitee源，访问速度更快。`;
        replyMsg += `\n备用仓库地址: \n- Gitee: ${GITEE_URL}.git\n- GitHub: ${GITHUB_URL}.git`;
        replyMsg += `\n\n您可以尝试进入插件目录【${PLUGIN_PATH}】手动执行以下命令切换远程仓库地址：\ngit remote set-url origin ${GITEE_URL}.git`;

    } else if (errMsg.includes("be overwritten by merge") || stdout.includes("CONFLICT")) {
        replyMsg += `\n原因：存在代码冲突，这通常意味着您修改过插件文件。`;
        replyMsg += `\n\n解决方案：\n1. 如果您想保留修改，请手动处理冲突文件。\n2. 如果您想放弃修改，请使用【#弦塔强制更新】命令。`;
    } else {
        replyMsg += `\n未知错误，请查看控制台日志。\n${errMsg}`;
    }

    await e.reply(replyMsg);
}
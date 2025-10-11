import plugin from '../../../lib/plugins/plugin.js';
import fs from 'node:fs';
import path from 'node:path';

// --- 配置项 ---
const WAITING_TIMEOUT = 5 * 60 * 1000; // 等待阶段超时时间 (5分钟)
const SPEAKING_TIMEOUT = 45 * 1000;   // 发言阶段超时时间 (45秒)
const VOTING_TIMEOUT = 45 * 1000;     // 投票阶段超时时间 (45秒)
const VOTE_GRACE = 1500;              // 投票截止后的缓冲期，避免临界竞态 (1.5秒)

// 游戏数据存储在内存中
const gameRooms = {};

// 插件根目录
const _path = process.cwd();
const plugin_path = path.join(_path, 'plugins', 'Xtower-Plugin');

// 加载词库
let wordPairs = [];
try {
  const wordsPath = path.join(plugin_path, 'resources', 'word_pairs.json');
  wordPairs = JSON.parse(fs.readFileSync(wordsPath, 'utf8'));
  if (!Array.isArray(wordPairs) || wordPairs.length === 0) {
    logger.warn('[谁是卧底] 词库 resources/word_pairs.json 加载失败或为空。');
  }
} catch (error) {
  logger.error('[谁是卧底] 加载词库失败', error);
  logger.warn('[谁是卧底] 请在 plugins/Xtower-Plugin/resources/ 目录下创建 word_pairs.json。');
}

export class undercover extends plugin {
  constructor() {
    super({
      name: '谁是卧底',
      dsc: '谁是卧底游戏',
      event: 'message',
      priority: 500,
      rule: [
        { reg: /^#卧底创建(\s*(明牌|暗牌))?$/, fnc: 'createGame' },
        { reg: /^#加入卧底$/, fnc: 'joinGame' },
        { reg: /^#退出卧底$/, fnc: 'quitGame' },
        { reg: /^#开始卧底$/, fnc: 'startGame' },
        { reg: /^(#结束发言|#发言结束)$/, fnc: 'endTurn' },
        { reg: /^#投票\s*(\d+)$/, fnc: 'votePlayer' },
        { reg: /^#结束卧底$/, fnc: 'endGame' }
      ]
    });
  }

  // --- 计时器与核心逻辑辅助函数 ---

  clearTimer(room) {
    if (room && room.timerId) {
      clearTimeout(room.timerId);
      room.timerId = null;
    }
  }
  
  async nextTurnOrVote(e, room, markPreviousAsSpoken = true) {
    this.clearTimer(room);

    if (markPreviousAsSpoken) {
      const lastPlayer = room.players[room.currentPlayerIndex];
      if (lastPlayer && lastPlayer.isAlive) {
        lastPlayer.hasSpoken = true;
      }
    }

    let nextPlayerIndex = -1;
    for (let i = 0; i <= room.players.length; i++) {
      const checkIndex = (room.currentPlayerIndex + i) % room.players.length;
      const player = room.players[checkIndex];
      if (player.isAlive && !player.hasSpoken) {
        nextPlayerIndex = checkIndex;
        break;
      }
    }
    
    if (nextPlayerIndex === -1) {
        const self = room.players[room.currentPlayerIndex];
        if (self.isAlive && !self.hasSpoken) {
            nextPlayerIndex = room.currentPlayerIndex;
        }
    }

    if (nextPlayerIndex !== -1) {
      room.currentPlayerIndex = nextPlayerIndex;
      const nextPlayer = room.players[nextPlayerIndex];
      const playerNumber = (nextPlayerIndex + 1).toString().padStart(2, '0');
      
      await e.reply([
        `💡 Spotlight on... 【${playerNumber}】号玩家 ${nextPlayer.name}！\n\n`,
        `请开始你的描述，时间为 ${SPEAKING_TIMEOUT / 1000} 秒。\n`,
        '（发言完毕后，请发送 #结束发言）'
      ]);

      room.timerId = setTimeout(() => {
        const currentRoom = this.getRoom(e.group_id);
        if (currentRoom && currentRoom.status === 'speaking' && currentRoom.currentPlayerIndex === nextPlayerIndex) {
          e.reply(`⏰ 玩家【${nextPlayer.name}】发言超时，自动进入下一位。`);
          this.nextTurnOrVote(e, currentRoom);
        }
      }, SPEAKING_TIMEOUT);
    } else {
      await this.startVoting(e, room);
    }
  }
  
  async startVoting(e, room) {
    this.clearTimer(room);
    room.status = 'voting';
    room.votes = {};
    room.voteDeadline = Date.now() + VOTING_TIMEOUT; // 记录截止时间，便于竞态控制
    let voteMsg = '🗣️ 所有玩家陈述完毕，投票环节到！\n\n';
    voteMsg += this.getPlayerList(room);
    voteMsg += `\n\n投出你心中最可疑的那个人吧！\n`;
    voteMsg += `➡️ 请在 ${VOTING_TIMEOUT / 1000} 秒内发送【#投票 编号】\n（例如：#投票 01）`;
    await e.reply(voteMsg);

    room.timerId = setTimeout(() => {
      const currentRoom = this.getRoom(e.group_id);
      if (currentRoom && currentRoom.status === 'voting') {
        e.reply('⏰ 投票时间到！现在开始统计票数...');
        // 给出极短缓冲时间，确保临界点发送的投票能被记录
        currentRoom.timerId = setTimeout(() => {
          const r = this.getRoom(e.group_id);
          if (r && r.status === 'voting') {
            this.tallyVotes(e, r);
          }
        }, VOTE_GRACE);
      }
    }, VOTING_TIMEOUT);
  }

  async tallyVotes(e, room) {
    this.clearTimer(room);

    const voteCounts = {};
    Object.values(room.votes).forEach(votedId => {
      voteCounts[votedId] = (voteCounts[votedId] || 0) + 1;
    });

    let maxVotes = 0;
    let eliminatedPlayerId = null;
    let isTie = false;

    for (const playerId in voteCounts) {
      if (voteCounts[playerId] > maxVotes) {
        maxVotes = voteCounts[playerId];
        eliminatedPlayerId = playerId;
        isTie = false;
      } else if (voteCounts[playerId] === maxVotes) {
        isTie = true;
      }
    }
    
    let voteResultMsg = '【本轮投票结果】\n';
    const votedPlayers = room.players.filter(p => voteCounts[p.id] > 0);
    if(votedPlayers.length > 0) {
      votedPlayers.forEach(p => {
        voteResultMsg += `${p.name}: ${voteCounts[p.id]}票\n`;
      });
    } else {
      voteResultMsg += '无人投票。\n'
    }

    if (isTie && eliminatedPlayerId !== null) {
      await e.reply(voteResultMsg + '\n出现了平票！暂时无人出局，危机解除...了吗？游戏继续！');
      await this.startNextRound(e, room);
    } else if (eliminatedPlayerId) {
      const eliminatedPlayer = room.players.find(p => p.id === Number(eliminatedPlayerId));
      eliminatedPlayer.isAlive = false;
      
      await e.reply(`${voteResultMsg}\n大家的手指向了同一个人... 惨遭淘汰的是【${eliminatedPlayer.name}】！\n\n他的真实身份是...【${eliminatedPlayer.role}】！词语是【${eliminatedPlayer.word}】。`);
      
      if (!await this.checkWinCondition(e, room)) {
        await this.startNextRound(e, room);
      }
    } else {
      await e.reply(voteResultMsg + '\n没有人获得足够票数，本轮安全度过！游戏继续！');
      await this.startNextRound(e, room);
    }
  }
  
  async startNextRound(e, room) {
    room.status = 'speaking';
    room.players.forEach(p => p.hasSpoken = false);

    let nextPlayerFound = false;
    let startIndex = room.currentPlayerIndex;
    for(let i=0; i<room.players.length; i++) {
        let checkIndex = (startIndex + i) % room.players.length;
        if(room.players[checkIndex].isAlive) {
            room.currentPlayerIndex = checkIndex;
            nextPlayerFound = true;
            break;
        }
    }

    if(!nextPlayerFound) { 
      await this.checkWinCondition(e, room);
      return;
    }

    await e.reply('新一轮开始！请准备发言！');
    await this.nextTurnOrVote(e, room, false);
  }
  
  getUndercoverCount(playerCount) {
    if (playerCount <= 5) return 1;
    if (playerCount <= 9) return 2;
    if (playerCount <= 13) return 3;
    if (playerCount <= 16) return 4;
    return Math.floor(playerCount / 4);
  }

  getRoom(groupId) { return gameRooms[groupId]; }
  
  getPlayerList(room) { 
    let msg = '【当前玩家】\n';
    room.players.forEach((p, index) => {
      const number = (index + 1).toString().padStart(2, '0');
      msg += `${number}. ${p.isAlive ? '🙂' : '💀'}${p.name}\n`;
    });
    msg += `\n总人数：${room.players.length}人`;
    return msg.trim();
  }

  async checkWinCondition(e, room) { 
    const alivePlayers = room.players.filter(p => p.isAlive);
    const aliveCivilians = alivePlayers.filter(p => p.role === '平民');
    const aliveUndercovers = alivePlayers.filter(p => p.role === '卧底');
    let isGameOver = false;
    let winMsg = '';
    if (aliveUndercovers.length === 0) {
      isGameOver = true;
      winMsg = '所有卧底都已被揪出，平民获得了最终胜利！';
    } else if (aliveUndercovers.length >= aliveCivilians.length) {
      isGameOver = true;
      winMsg = '卧底们技高一筹，成功潜伏到了最后！卧底阵营胜利！';
    } else if (alivePlayers.length <= 2 && aliveUndercovers.length > 0) {
        isGameOver = true;
        winMsg = '场上仅剩2人，游戏无法结束，卧底阵营胜利！';
    }
    if (isGameOver) {
      this.clearTimer(room);
      let finalReveal = '【游戏结束 - 身份揭晓】\n';
      room.players.forEach(p => {
        finalReveal += `${p.name}: [${p.role}] - ${p.word}\n`;
      });
      await e.reply(`${winMsg}\n\n${finalReveal}`);
      delete gameRooms[e.group_id];
      return true;
    }
    return false;
  }
  
  // --- 指令功能 ---

  async createGame(e) {
    if (this.getRoom(e.group_id)) {
      return e.reply('本群已经有一场游戏啦，请勿重复创建哦。');
    }
    const mode = e.msg.includes('明牌') ? '明牌' : '暗牌';
    const room = {
      ownerId: e.user_id, status: 'waiting', mode: mode, players: [],
      wordPair: [], civilianWord: '', undercoverWord: '',
      currentPlayerIndex: 0, votes: {}, timerId: null
    };
    gameRooms[e.group_id] = room;
    room.players.push({ id: e.user_id, name: e.sender.card || e.sender.nickname, role: null, word: null, isAlive: true, hasSpoken: false });
    room.timerId = setTimeout(() => {
        if (this.getRoom(e.group_id) && this.getRoom(e.group_id).status === 'waiting') {
            delete gameRooms[e.group_id];
            e.reply(`[谁是卧底] 房间因长时间无人开始，已自动解散了哦~`);
        }
    }, WAITING_TIMEOUT);
    return e.reply(
      `「谁是卧底」游戏房间已开启！\n\n` +
      `游戏模式：【${mode}】\n` +
      `本局房主：${e.sender.card || e.sender.nickname}\n\n` +
      `发送【#加入卧底】加入卧底游戏！\n` +
      `房主可以发送【#开始卧底】开始游戏\n\n` +
      `（房间将在${WAITING_TIMEOUT / 60 / 1000}分钟后自动解散）`
    );
  }
  
  async joinGame(e) { 
    const room = this.getRoom(e.group_id);
    if (!room || room.status !== 'waiting') return e.reply('现在没有可以加入的游戏。');
    if (room.players.find(p => p.id === e.user_id)) return e.reply('你已经加入，请勿重复加入！');
    room.players.push({ id: e.user_id, name: e.sender.card || e.sender.nickname, role: null, word: null, isAlive: true, hasSpoken: false });
    return e.reply([`欢迎玩家【${e.sender.card || e.sender.nickname}】加入对局！🎉\n\n`, this.getPlayerList(room)]);
  }

  async quitGame(e) { 
    const room = this.getRoom(e.group_id);
    if (!room || room.status !== 'waiting') return e.reply('游戏已经开始，不能中途跑路');
    if (e.user_id === room.ownerId) {
      this.clearTimer(room);
      delete gameRooms[e.group_id];
      return e.reply('啊哦，房主跑路啦！本轮游戏已解散~ 🤷');
    }
    const playerIndex = room.players.findIndex(p => p.id === e.user_id);
    if (playerIndex === -1) return e.reply('你都不在游戏里，怎么退出？');
    const playerName = room.players[playerIndex].name;
    room.players.splice(playerIndex, 1);
    return e.reply([`玩家【${playerName}】挥手告别，离开了游戏~ 👋\n\n`, this.getPlayerList(room)]);
  }

  async startGame(e) {
    const room = this.getRoom(e.group_id);
    if (!room || room.status !== 'waiting') return e.reply('游戏已经开始了，请勿重复操作。');
    if (e.user_id !== room.ownerId) return e.reply('只有房主才能启动游戏哦！');
    if (room.players.length < 3) return e.reply('还不够人，至少要3个才能开始。');

    this.clearTimer(room);
    room.status = 'speaking';
    if (wordPairs.length === 0) return e.reply('糟糕，词库空空如也，游戏无法开始！请联系管理员。');
    
    const pairIndex = Math.floor(Math.random() * wordPairs.length);
    [room.civilianWord, room.undercoverWord] = Math.random() > 0.5 ? wordPairs[pairIndex] : [wordPairs[pairIndex][1], wordPairs[pairIndex][0]];
    
    const undercoverCount = this.getUndercoverCount(room.players.length);
    room.players.sort(() => Math.random() - 0.5); 

    room.players.forEach((player, index) => {
      if (index < undercoverCount) {
        player.role = '卧底';
        player.word = room.undercoverWord;
      } else {
        player.role = '平民';
        player.word = room.civilianWord;
      }
    });

    room.players.sort(() => Math.random() - 0.5); 

    let startMsg = `🏁 游戏正式开始！\n\n🔍 本局共有 ${undercoverCount} 名卧底，他们就藏在你们之中...\n\n${this.getPlayerList(room)}\n\n🤫 正在悄悄给每位玩家发送ta的秘密词语，请查收私信...`;
    await e.reply(startMsg);

    for (const player of room.players) {
        try {
            let privateContent = '';
            if (room.mode === '明牌') {
                privateContent = `你的身份是：${player.role}\n你的词语是：【${player.word}】`;
            } else {
                privateContent = `你的词语是：【${player.word}】`;
            }
            await Bot.pickUser(player.id).sendMsg(`\n\n${privateContent}\n\n记住你的词语，不要暴露哦！`);
        } catch (err) {
            logger.error(`[谁是卧底] 发送私聊给 ${player.name}(${player.id}) 失败:`, err);
            await e.reply(`@${player.name} 私信发送失败！请检查好友关系或临时会话设置。`);
        }
    }
    
    await e.reply('词语已派发完毕！\n现在，请开始你的表演... 🎤');
    
    const firstPlayerIndex = room.players.findIndex(p => p.isAlive);
    if(firstPlayerIndex !== -1) {
        room.currentPlayerIndex = firstPlayerIndex;
    }
    
    await this.nextTurnOrVote(e, room, false);
  }

  async endTurn(e) {
    const room = this.getRoom(e.group_id);
    if (!room || room.status !== 'speaking') return;
    
    const currentPlayer = room.players[room.currentPlayerIndex];
    if (e.user_id !== currentPlayer.id) return e.reply('还没轮到你发言，不要抢麦哦~');
    
    await e.reply(`👌 玩家【${currentPlayer.name}】发言完毕，麦克风传给下一位~`);
    await this.nextTurnOrVote(e, room);
  }

  async votePlayer(e) { 
    const room = this.getRoom(e.group_id);
    if (!room || room.status !== 'voting') return;
    const voter = room.players.find(p => p.id === e.user_id);
    if (!voter || !voter.isAlive) return e.reply('你已经出局或不是玩家，不能投票啦~');
    if (room.votes[e.user_id]) return e.reply('每人一票，你已经投过啦！');
    const votedNumber = parseInt(e.msg.match(/^#投票\s*(\d+)/)[1]);
    if (isNaN(votedNumber) || votedNumber < 1 || votedNumber > room.players.length) return e.reply('请输入有效的玩家编号哦！');
    const votedPlayer = room.players[votedNumber - 1];
    if (!votedPlayer.isAlive) return e.reply('这位玩家已经出局了，放过ta吧~');
    if (votedPlayer.id === e.user_id) return e.reply('不可以投自己哦，要相信自己是好人！');
    room.votes[e.user_id] = votedPlayer.id;
    await e.reply(`【${voter.name}】将他宝贵的一票投给了【${votedPlayer.name}】。`);
    const alivePlayersCount = room.players.filter(p => p.isAlive).length;
    if (Object.keys(room.votes).length >= alivePlayersCount) {
        await e.reply('所有在线玩家已投票完毕，马上揭晓结果！');
        await this.tallyVotes(e, room);
    }
  }

  async endGame(e) { 
    const room = this.getRoom(e.group_id);
    if (!room) return e.reply('当前没有游戏在进行哦。');
    if (e.user_id !== room.ownerId) return e.reply('只有房主才能强制结束游戏！');
    this.clearTimer(room);
    let finalReveal = '';
    if (room.status !== 'waiting') {
        finalReveal = '\n【身份揭晓】\n';
        room.players.forEach(p => { finalReveal += `${p.name}: [${p.role}] - ${p.word}\n`; });
    }
    delete gameRooms[e.group_id];
    return e.reply(`游戏被房主强制结束啦，期待下次再战！${finalReveal}`);
  }
}
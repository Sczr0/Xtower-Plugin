// model/werewolf/GameRoom.js
import { Player } from './Player.js';
import { GameEngine } from './GameEngine.js';
import { getRoomRedisKey, getUserGroupRedisKey, logger } from './utils.js';
import { GAME_STATUS, DATA_EXPIRATION, REDIS_KEYS } from './constants.js';
import werewolfConfig from './config.js';

const MAX_RETRIES = 5; // 最大重试次数
const RETRY_DELAY_MS = 100; // 重试延迟

/**
 * @class GameRoom
 * @description 管理单个游戏房间的生命周期和数据持久化。
 */
export class GameRoom {
  constructor(groupId, hostId, hostNickname) {
    this.groupId = groupId;
    this.hostId = hostId;
    this.status = GAME_STATUS.WAITING;
    this.players = []; // Player 类的实例数组
    this.engine = null; // GameEngine 实例
    this.boardName = null; // 记录板子名称
    this.version = 0; // 新增：乐观锁版本号
  }

  // --- 静态方法 (与Redis交互) ---
  
  static async create(groupId, hostId, hostNickname) {
    const room = new GameRoom(groupId, hostId, hostNickname);
    // 创建者自动加入，此处的 save 会被 addPlayer 内部的 save 替代
    // 但为了确保房间被初始化并有一个版本号，这里先调用一次 save
    room.version = 1; // 新房间从版本1开始
    await room._saveWithOptimisticLock(); // 使用新的保存方法
    const result = await room.addPlayer(hostId, hostNickname); // addPlayer 内部会再次 save
    return room;
  }

  static async load(groupId) {
    const key = getRoomRedisKey(groupId);
    const data = await redis.get(key);
    if (!data) return null;
    
    const parsedData = JSON.parse(data);
    const room = new GameRoom(parsedData.groupId, parsedData.hostId);
    room.status = parsedData.status;
    room.players = parsedData.players.map(pData => Player.deserialize(pData));
    room.boardName = parsedData.boardName;
    room.version = parsedData.version || 0; // 加载版本号，如果不存在则为0
    
    if (parsedData.engine) {
      room.engine = GameEngine.deserialize(parsedData.engine);
    }
    return room;
  }

  static async loadByUserId(userId) {
    const userGroupKey = getUserGroupRedisKey(userId);
    const groupId = await redis.get(userGroupKey);
    
    if (!groupId) {
      logger(`无法通过用户ID ${userId} 找到对应的群组ID。`);
      return null;
    }
    return await GameRoom.load(groupId);
  }

  async _saveWithOptimisticLock() {
    const key = getRoomRedisKey(this.groupId);
    let retries = 0;

    while (retries < MAX_RETRIES) {
      await redis.watch(key); // 监视房间键

      const currentData = await redis.get(key);
      let currentVersion = 0;
      if (currentData) {
        try {
          const parsedCurrentData = JSON.parse(currentData);
          currentVersion = parsedCurrentData.version || 0;
        } catch (e) {
          logger(`解析房间数据失败: ${e.message}`);
          // 如果数据损坏，则认为版本为0，强制覆盖
          currentVersion = 0;
        }
      }

      // 如果当前房间的版本号与 Redis 中的不一致，且不是新房间（版本号为0）
      // 或者当前房间的版本号是0但 Redis 中有数据，说明 Redis 数据更新了
      if (currentVersion > 0 && this.version !== currentVersion) {
        logger(`乐观锁冲突：房间 ${this.groupId} 版本不匹配。当前本地版本 ${this.version}，Redis版本 ${currentVersion}。`);
        await redis.unwatch(); // 解除监视
        retries++;
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        // 重新加载房间数据，然后重试
        const reloadedRoom = await GameRoom.load(this.groupId);
        if (reloadedRoom) {
            Object.assign(this, reloadedRoom); // 将重新加载的数据合并到当前实例
        }
        continue;
      }
      
      this.version++; // 递增版本号
      const dataToSave = {
        groupId: this.groupId,
        hostId: this.hostId,
        status: this.status,
        players: this.players.map(p => p.serialize()),
        engine: this.engine ? this.engine.serialize() : null,
        boardName: this.boardName,
        version: this.version, // 保存新的版本号
      };

      const multi = redis.multi();
      multi.set(key, JSON.stringify(dataToSave), { EX: DATA_EXPIRATION });
      
      try {
        const result = await multi.exec();
        if (result !== null) {
          logger(`房间 ${this.groupId} 保存成功，版本 ${this.version}。`);
          return true; // 保存成功
        } else {
          logger(`房间 ${this.groupId} 乐观锁事务失败，重试中... (尝试 ${retries + 1}/${MAX_RETRIES})`);
          retries++;
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
          // 重新加载房间数据，然后重试
          const reloadedRoom = await GameRoom.load(this.groupId);
          if (reloadedRoom) {
              Object.assign(this, reloadedRoom); // 将重新加载的数据合并到当前实例
          }
        }
      } catch (e) {
        logger(`执行 Redis 事务时发生错误: ${e.message}`);
        await redis.unwatch(); // 确保在错误时解除监视
        throw e; // 抛出错误
      }
    }
    logger(`房间 ${this.groupId} 达到最大重试次数，保存失败。`);
    return false; // 达到最大重试次数
  }

  // 将原来的 save 方法替换为 _saveWithOptimisticLock
  async save() {
    return this._saveWithOptimisticLock();
  }

  async delete() {
    // 删除所有玩家的 user->group 映射
    const userKeys = this.players.map(p => getUserGroupRedisKey(p.userId));
    if (userKeys.length > 0) await redis.del(userKeys);
    // 删除房间数据
    await redis.del(getRoomRedisKey(this.groupId));
  }

  async cleanup() {
    const key = getRoomRedisKey(this.groupId);
    // 检查Redis中是否还存在该房间，防止重复清理
    const exists = await redis.exists(key);
    if (!exists) {
      logger(`房间 ${this.groupId} 的资源已被清理，跳过本次操作。`);
      return;
    }

    logger(`开始清理房间 ${this.groupId} 的所有资源...`);
    
    // 1. 清理 deadline ZSET (计时器核心)
    await redis.zRem(REDIS_KEYS.DEADLINE_ZSET, String(this.groupId));

    // 2. 清理所有玩家的 user->group 映射
    const userKeys = this.players.map(p => getUserGroupRedisKey(p.userId));
    if (userKeys.length > 0) {
      await redis.del(userKeys);
    }
    
    // 3. 删除房间主数据
    await redis.del(key);
    logger(`房间 ${this.groupId} 的资源清理完毕。`);
  }

  // --- 实例方法 (游戏准备阶段) ---

  async addPlayer(userId, nickname) {
    // 重试机制确保 addPlayer 操作的原子性
    let retries = 0;
    while (retries < MAX_RETRIES) {
        const room = await GameRoom.load(this.groupId); // 重新加载最新数据
        if (!room) return { success: false, message: '房间不存在或已结束。' };
        Object.assign(this, room); // 将最新数据合并到当前实例

        if (this.status !== GAME_STATUS.WAITING) {
            return { success: false, message: '游戏已开始，无法加入。' };
        }
        if (this.players.some(p => p.userId === userId)) {
            return { success: false, message: '你已经加入游戏了。' };
        }
        
        const tempId = String(this.players.length + 1).padStart(2, '0');
        const player = new Player(userId, nickname, tempId);
        this.players.push(player);
        
        // 记录 user -> group 映射
        await redis.set(getUserGroupRedisKey(userId), this.groupId, { EX: DATA_EXPIRATION });
        
        const saveSuccess = await this._saveWithOptimisticLock();
        if (saveSuccess) {
            return { success: true, message: `${player.info} 加入游戏。当前人数：${this.players.length}` };
        } else {
            logger(`addPlayer 乐观锁冲突，重试中... (尝试 ${retries + 1}/${MAX_RETRIES})`);
            retries++;
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
    }
    return { success: false, message: '加入游戏失败，请稍后再试。' };
  }
  
  async startGame(boardName) { // 移除了 config 参数，因为 GameEngine 直接从 werewolfConfig 导入
    // 重试机制确保 startGame 操作的原子性
    let retries = 0;
    while (retries < MAX_RETRIES) {
        const room = await GameRoom.load(this.groupId); // 重新加载最新数据
        if (!room) return { error: '房间不存在或已结束。' };
        Object.assign(this, room); // 将最新数据合并到当前实例

        // 1. 创建游戏引擎实例
        this.engine = new GameEngine(this.players); // GameEngine 内部会使用 werewolfConfig

        // 2. 分配角色 (这个逻辑应该在 GameEngine 内部完成)
        // GameEngine 的 initializeGame 方法会处理角色分配并返回事件
        const gameStartResult = this.engine.initializeGame(boardName);
        if (gameStartResult.error) {
            this.engine = null; // 分配失败，回滚
            return { error: gameStartResult.error };
        }

        this.status = GAME_STATUS.RUNNING;
        
        // 3. 准备私聊身份信息和进入第一夜的事件
        const events = gameStartResult.events; // GameEngine.initializeGame 返回的事件

        const saveSuccess = await this._saveWithOptimisticLock();
        if (saveSuccess) {
            return { success: true, events };
        } else {
            logger(`startGame 乐观锁冲突，重试中... (尝试 ${retries + 1}/${MAX_RETRIES})`);
            retries++;
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
    }
    return { error: '开始游戏失败，请稍后再试。' };
  }
}
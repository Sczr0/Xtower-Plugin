/**
 * @class EventEmitter
 * @description 简单的发布-订阅事件发射器实现
 * 提供事件的注册、触发、移除等功能，支持游戏引擎的事件驱动架构
 */
export class EventEmitter {
  constructor() {
    this.events = new Map();
  }

  /**
   * 注册事件监听器
   * @param {string} eventName - 事件名称
   * @param {Function} listener - 监听器函数
   * @param {object} options - 选项 { once: boolean }
   */
  on(eventName, listener, options = {}) {
    if (!this.events.has(eventName)) {
      this.events.set(eventName, []);
    }
    
    const listenerWrapper = {
      fn: listener,
      once: options.once || false
    };
    
    this.events.get(eventName).push(listenerWrapper);
    return this;
  }

  /**
   * 注册一次性事件监听器
   * @param {string} eventName - 事件名称
   * @param {Function} listener - 监听器函数
   */
  once(eventName, listener) {
    return this.on(eventName, listener, { once: true });
  }

  /**
   * 触发事件
   * @param {string} eventName - 事件名称
   * @param {any} data - 事件数据
   */
  emit(eventName, data) {
    if (!this.events.has(eventName)) {
      return false;
    }

    const listeners = this.events.get(eventName);
    const toRemove = [];

    for (let i = 0; i < listeners.length; i++) {
      const listener = listeners[i];
      try {
        listener.fn(data);
        if (listener.once) {
          toRemove.push(i);
        }
      } catch (error) {
        console.error(`[EventEmitter] 事件监听器执行错误 (${eventName}):`, error);
      }
    }

    // 移除一次性监听器
    for (let i = toRemove.length - 1; i >= 0; i--) {
      listeners.splice(toRemove[i], 1);
    }

    return true;
  }

  /**
   * 移除事件监听器
   * @param {string} eventName - 事件名称
   * @param {Function} listener - 要移除的监听器函数
   */
  off(eventName, listener) {
    if (!this.events.has(eventName)) {
      return this;
    }

    const listeners = this.events.get(eventName);
    for (let i = listeners.length - 1; i >= 0; i--) {
      if (listeners[i].fn === listener) {
        listeners.splice(i, 1);
      }
    }

    if (listeners.length === 0) {
      this.events.delete(eventName);
    }

    return this;
  }

  /**
   * 移除指定事件的所有监听器
   * @param {string} eventName - 事件名称
   */
  removeAllListeners(eventName) {
    if (eventName) {
      this.events.delete(eventName);
    } else {
      this.events.clear();
    }
    return this;
  }

  /**
   * 获取指定事件的监听器数量
   * @param {string} eventName - 事件名称
   * @returns {number} 监听器数量
   */
  listenerCount(eventName) {
    return this.events.has(eventName) ? this.events.get(eventName).length : 0;
  }

  /**
   * 获取所有事件名称
   * @returns {Array<string>} 事件名称数组
   */
  eventNames() {
    return Array.from(this.events.keys());
  }
}
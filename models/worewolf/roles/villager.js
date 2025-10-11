/**
 * 村民角色逻辑
 * 作为一个基础角色，村民没有任何主动或被动技能。
 * 这个文件主要用于保持角色结构的一致性。
 */
export default class Villager {
  constructor (player) {
    this.player = player
  }

  // 村民没有技能，所以这里是空的
}
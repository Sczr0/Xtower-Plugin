import fetch from "node-fetch";
import { segment } from "oicq";

//感谢大佬qq: 717157592提供V2版本 
//V3版本由果丁修改qq：985318935   qq群：625882201宣传下小群不过分吧（狗头）
//有bug不要联系，不会改
//使用说明：此插件需要装ffmpeg，安装教程:Window在云崽群发送 ffmpeg;   linux在云崽群发送 linux安装ffmpeg;

//历史版本:
//猜歌名2.1:增加了提示指令,返回歌曲为一整首歌
//猜歌名3.0:增加了自动提示,修改了命令,返回歌曲改为返回铃声

//目前版本:
//猜歌名3.3:更换了接口,支持猜网易云的自定义歌单,意思就是歌单有什么歌,机器人就随机发歌单的其中一首歌让你们猜

let music = [7916853026];  //这里改网易云的歌单id

export class example extends plugin {
  constructor () {
    super({
      /** 功能名称 */
      name: '猜歌名',
      /** 功能描述 */
      dsc: '简单开发示例',
      /** https://oicqjs.github.io/oicq/#events */
      event: 'message',
      /** 优先级，数字越小等级越高 */
      priority: 150000,
      rule: [
        {
          /** 命令正则匹配 */
          reg: '^猜歌名$',
          /** 执行方法 */
          fnc: 'guessmusic'
        },
        {
          /** 命令正则匹配 */
          reg: '^投降$',
          /** 执行方法 */
          fnc: 'EndCheck'
        },
        {
          /** 命令正则匹配 */
          reg: '',
          /** 执行方法 */
          fnc: 'answerCheck'
        }
      ]
    })
  }

 
async guessmusic(e) {
 

  let guessConfig = getGuessConfig(e)
  if (guessConfig.gameing) {
    e.reply('猜歌名正在进行哦!')
    return true;
  }
 
   let res = await(await fetch(`https://song.xtower.site/api/v1/music/random?id=${music}`)).json();
    console.log(`答案: ${res[0].name} (歌手: ${res[0].artist})`);
  
    e.reply( `游戏开始拉,请听语音猜出歌名！\n游戏区分大小写,猜的歌名必须跟答案一样才算你对噢~\n结束游戏指令【投降】`,true);
    e.reply(segment.record(res[0].url));
    
    setTimeout(() => {
      e.reply(`爱莉希雅的秘密调查♪\n这里有你喜欢的音乐吗♪`);
    }, 2000)//毫秒数
   
  guessConfig.gameing = true;
  guessConfig.current = res[0].name;
 

    guessConfig.timer = setTimeout(() => {
      if (guessConfig.gameing) {
        guessConfig.gameing = false;
        e.reply(`嘿嘿,猜歌名结束拉,很遗憾没有人猜中噢！歌名是【${res[0].name}】`);
     
		return true;
      }
    }, 120000)//毫秒数


  return true; //返回true 阻挡消息不再往下
}

async answerCheck(e) {
    
    let guessConfig = getGuessConfig(e);
    let {gameing, current } = guessConfig;
    
   
   
  if (gameing && e.msg == guessConfig.current) {
      e.reply(`哇~真棒,我就知道你能猜中~\n这束鲜花~要好好收下哦♪`, true);
      guessConfig.gameing = false;
      clearTimeout(guessConfig.timer)
      return true;
    }
}
  
async EndCheck(e) {
    
    let guessConfig = getGuessConfig(e);
    let {gameing, current } = guessConfig;
    
    if(gameing){
         guessConfig.gameing = false
         clearTimeout(guessConfig.timer);
         
         
         e.reply(`猜歌名已结束\n歌名是:` + guessConfig.current);
         
         return true;
    }else{
        e.reply(`猜歌名游戏都没开始呢♪`)
        return true;
    }
 }
}

  const guessConfigMap = new Map()

function getGuessConfig(e) {
    let key = e.message_type + e[e.isGroup ? 'group_id' : 'user_id'];
    let config = guessConfigMap.get(key);
    if (config == null) {
      config = {
        gameing: false,
        current: '',
        timer: null,
      }
      guessConfigMap.set(key, config);
    }
    return config;
  }
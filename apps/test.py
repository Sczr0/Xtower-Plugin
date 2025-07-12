import sys
import json
import random

# 模拟次数可以设得非常高，以获得稳定精确的结果
# 1,000,000 次在现代CPU上用Python计算也很快
SIMULATION_COUNT = 1000000

# --- 逻辑核心区，与JS最终版逻辑完全对应 ---

def calculate_five_star_prob(game, pool, pity):
    if game == 'genshin':
        if pool == 'character':
            base_rate, soft_pity_start, soft_pity_step, max_pity = 0.006, 74, 0.06, 90
        else:  # weapon
            base_rate, soft_pity_start, soft_pity_step, max_pity = 0.007, 64, 0.07, 80
    else:  # hsr
        if pool == 'character':
            base_rate, soft_pity_start, soft_pity_step, max_pity = 0.006, 74, 0.06, 90
        else:  # lightcone
            base_rate, soft_pity_start, soft_pity_step, max_pity = 0.008, 66, 0.075, 80
    
    if pity >= max_pity: return 1.0
    if pity < soft_pity_start: return base_rate
    return base_rate + (pity - soft_pity_start + 1) * soft_pity_step

def handle_genshin_character(state):
    if state['isGuaranteed']: return True
    if state['mingguangCounter'] >= 3: return True
    if random.random() < 0.00018: return True
    return random.random() < 0.5

def handle_genshin_weapon(state):
    if state['fatePoint'] >= 1: return True
    return random.random() < 0.375

def handle_hsr_character(state):
    if state['isGuaranteed']: return True
    return random.random() < 0.5625

def handle_hsr_lightcone(state):
    if state['isGuaranteed']: return True
    return random.random() < 0.75

def get_one_target_pulls(game, pool, state):
    pulls = 0
    while True:
        pulls += 1
        state['pity'] += 1
        five_star_prob = calculate_five_star_prob(game, pool, state['pity'])

        if random.random() < five_star_prob:
            was_guaranteed_on_hit = state['isGuaranteed']
            is_target = False
            
            pool_key = f"{game}-{pool}"
            if pool_key == "genshin-character": is_target = handle_genshin_character(state)
            elif pool_key == "genshin-weapon": is_target = handle_genshin_weapon(state)
            elif pool_key == "hsr-character": is_target = handle_hsr_character(state)
            elif pool_key == "hsr-lightcone": is_target = handle_hsr_lightcone(state)

            if is_target:
                if pool_key == 'genshin-character' and not was_guaranteed_on_hit:
                    state['mingguangCounter'] = 0
                
                state['pity'] = 0
                state['isGuaranteed'] = False
                if pool_key == 'genshin-weapon':
                    state['fatePoint'] = 0
                return pulls
            else:
                if pool_key == 'genshin-character' and not was_guaranteed_on_hit:
                    state['mingguangCounter'] += 1
                if pool_key == 'genshin-weapon':
                    state['fatePoint'] = 1
                state['pity'] = 0
                state['isGuaranteed'] = True

def simulate_one_full_run(args):
    total_pulls = 0
    # Python的字典是可变的，所以直接复制即可，效果类似JS的展开语法
    state = args['initialState'].copy() 
    for _ in range(args['targetCount']):
        total_pulls += get_one_target_pulls(args['game'], args['pool'], state)
    return total_pulls

def run_monte_carlo_simulation(args):
    total_pulls_sum = 0
    for _ in range(SIMULATION_COUNT):
        total_pulls_sum += simulate_one_full_run(args)
    return total_pulls_sum

# --- 主程序入口 ---
if __name__ == "__main__":
    try:
        if len(sys.argv) < 2:
            raise ValueError("缺少计算参数JSON")

        # 从命令行参数读取JSON字符串
        input_json = sys.argv[1]
        # 解析JSON为Python字典
        args_data = json.loads(input_json)
        
        # 执行主计算
        total_pulls = run_monte_carlo_simulation(args_data)
        
        # 计算最终期望值
        expected_pulls = total_pulls / SIMULATION_COUNT
        
        # 将结果打印到标准输出，JS将会读取它
        print(expected_pulls)
        
    except Exception as e:
        # 如果发生任何错误，打印到标准错误流，并以非零码退出
        print(f"Python script error: {e}", file=sys.stderr)
        sys.exit(1)
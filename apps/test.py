# =============================================================================
# FINAL, FULLY-MODIFIED test.py
# (All fixes and new features included)
# =============================================================================

import sys
import json
import numpy as np

# -----------------------------------------------------------------------------
# MonteCarloModel (Simulation Engine)
# -----------------------------------------------------------------------------
class MonteCarloModel:
    def __init__(self, args):
        self.args = args
        # 角色池模拟更复杂，需要更多样本
        self.simulation_count = 100000 if args['pool'] == 'character' else 50000
    
    def run(self):
        rng = self._RNG()
        model_key = f"{self.args['game']}-{self.args['pool']}"
        model_logic = MODEL_LOGIC[model_key]

        pulls_results, returns_results = [], []
        
        # 主模拟循环
        for _ in range(self.simulation_count):
            pulls, returns = self._simulate_one_full_run(rng, model_logic)
            pulls_results.append(pulls)
            # 只有角色池有详细的返还物计算
            if self.args['pool'] == 'character':
                returns_results.append(returns)
        
        pulls_array = np.array(pulls_results)
        pulls_data = self._calculate_percentiles(pulls_array)
        result = {"pulls": pulls_data}
        
        # 如果提供了预算，计算成功率
        if self.args.get('budget') is not None:
            budget = self.args['budget']
            success_count = np.sum(pulls_array <= budget)
            result['success_rate'] = (success_count / self.simulation_count) * 100

        # 如果计算了返还物，则加入结果
        if returns_results:
            result["returns"] = self._calculate_percentiles(np.array(returns_results), is_float=True)
            
        return result

    def _calculate_percentiles(self, data, is_float=False):
        dtype = float if is_float else int
        return {
            "mean": np.mean(data),
            "p25": dtype(np.percentile(data, 25)),
            "p50": dtype(np.percentile(data, 50)),
            "p75": dtype(np.percentile(data, 75)),
            "p90": dtype(np.percentile(data, 90)),
            "p95": dtype(np.percentile(data, 95))
        }

    def _simulate_one_full_run(self, rng, model_logic):
        total_pulls, total_returns = 0, 0
        # 复制初始状态，避免在多次模拟中被污染
        state = self.args['initialState'].copy()
        state['pity4'] = 0
        state['isGuaranteed4'] = False
        
        # 'collection' 用于追踪获取到的角色/武器，以计算返还
        collection = {'up_5_star': 0}

        # 循环获取目标
        for _ in range(self.args['targetCount']):
            pulls, returns = model_logic.get_one_target_pulls_sim(state, rng, collection, self.args.get('up4C6', False))
            total_pulls += pulls
            total_returns += returns
            
        return total_pulls, total_returns

    class _RNG:
        """一个预生成随机数的快速RNG，避免在循环中频繁调用np.random"""
        CHUNK_SIZE = 1_000_000
        def __init__(self): self.chunk=np.random.rand(self.CHUNK_SIZE); self.index=0
        def get(self):
            if self.index >= self.CHUNK_SIZE: self.chunk=np.random.rand(self.CHUNK_SIZE); self.index=0
            num=self.chunk[self.index]; self.index+=1; return num

# -----------------------------------------------------------------------------
# MathematicalModel (Expectation Engine)
# -----------------------------------------------------------------------------
class MathematicalModel:
    def __init__(self, args):
        self.args = args
        self.model_logic = MODEL_LOGIC[f"{args['game']}-{args['pool']}"]

    def run(self):
        # 注意: 只有原神角色池有复杂的`get_total_expectation`实现
        # 其他模型使用简化计算
        if hasattr(self.model_logic, 'get_total_expectation'):
            mean = self.model_logic.get_total_expectation(self.args)
        else:
            # 简化计算：第一个的期望 + (n-1) * 后续的期望
            initial_pulls = self.model_logic.get_expectation_for_state(self.args['initialState'])
            subsequent_pulls = self.model_logic.get_subsequent_expectation()
            mean = initial_pulls + (self.args['targetCount'] - 1) * subsequent_pulls
        return {"mean": mean}

# -----------------------------------------------------------------------------
# Base GachaLogic (Defines common interface)
# -----------------------------------------------------------------------------
class GachaLogic:
    def __init__(self):
        # 延迟加载，只有在需要时才计算矩阵
        self.E_values = None
    
    def _ensure_tables_calculated(self):
        if self.E_values is None:
            A, b = self._build_transition_matrix()
            self.E_values = np.linalg.solve(A, b)
            
    # 通用的状态更新逻辑
    def _update_state_after_win(self, s, wg): s['pity'], s['isGuaranteed'] = 0, False
    def _update_state_after_lose(self, s, wg): s['pity'], s['isGuaranteed'] = 0, True

# =============================================================================
# Genshin Impact Character Logic (Most Complex)
# =============================================================================
class GenshinCharacterLogic(GachaLogic):
    PITY_MAX, GUARANTEE_MAX, MINGGUANG_MAX = 90, 2, 4
    TOTAL_STATES = PITY_MAX * GUARANTEE_MAX * MINGGUANG_MAX
    Absorption_Probs = None # 用于计算后续明光状态的概率

    def _ensure_tables_calculated(self):
        if self.E_values is None: self.E_values = self._solve_expectations()
        if self.Absorption_Probs is None: self.Absorption_Probs = self._solve_absorption_probabilities()

    def _state_to_index(self, s): return s[0] + s[1]*self.PITY_MAX + s[2]*self.PITY_MAX*self.GUARANTEE_MAX
    def _get_prob_5_star(self, p): pull=p+1; return 1. if pull>=90 else (0.006 if pull<74 else 0.006+(pull-73)*0.06)
    def _get_win_lose_prob(self, is_g, mg=0):
        if is_g or mg>=3: return 1.0, 0.0
        p_mg=0.00018; p_win=p_mg+(1-p_mg)*0.5; p_lose=(1-p_mg)*0.5
        return p_win, p_lose

    def _solve_expectations(self):
        A=np.identity(self.TOTAL_STATES); b=np.ones(self.TOTAL_STATES)
        for i in range(self.TOTAL_STATES):
            mg,is_g,p=i//(self.PITY_MAX*self.GUARANTEE_MAX),(i%(self.PITY_MAX*self.GUARANTEE_MAX))//self.PITY_MAX,i%self.PITY_MAX
            p5=self._get_prob_5_star(p)
            if p5<1.0: A[i,self._state_to_index((p+1,is_g,mg))]-=(1-p5)
            if p5>0:
                _,p_lose=self._get_win_lose_prob(is_g,mg)
                if p_lose>0:
                    new_mg=mg+1 if not is_g else mg
                    A[i,self._state_to_index((0,1,min(new_mg,self.MINGGUANG_MAX-1)))]-=p5*p_lose
        return np.linalg.solve(A,b)

    def _solve_absorption_probabilities(self):
        Q=np.zeros((self.TOTAL_STATES,self.TOTAL_STATES)); R=np.zeros((self.TOTAL_STATES,self.MINGGUANG_MAX))
        for i in range(self.TOTAL_STATES):
            mg,is_g,p=i//(self.PITY_MAX*self.GUARANTEE_MAX),(i%(self.PITY_MAX*self.GUARANTEE_MAX))//self.PITY_MAX,i%self.PITY_MAX
            p5=self._get_prob_5_star(p)
            if p5<1.0: Q[i,self._state_to_index((p+1,is_g,mg))]=(1-p5)
            if p5>0:
                p_win,p_lose=self._get_win_lose_prob(is_g,mg)
                if p_lose>0:
                    new_mg=mg+1 if not is_g else mg
                    Q[i,self._state_to_index((0,1,min(new_mg,self.MINGGUANG_MAX-1)))]=p5*p_lose
                if p_win>0:
                    final_mg=0 if not is_g else mg
                    R[i,final_mg]=p5*p_win
        N=np.linalg.inv(np.identity(self.TOTAL_STATES)-Q); B=np.dot(N,R)
        return B

    def get_total_expectation(self, args):
        self._ensure_tables_calculated()
        initial_state=args['initialState']; target_count=args['targetCount']; total_pulls=0.0
        start_state_index=self._state_to_index((initial_state['pity'],1 if initial_state['isGuaranteed']else 0,initial_state['mingguangCounter']))
        pulls_for_first=self.E_values[start_state_index]
        total_pulls+=pulls_for_first
        if target_count > 1:
            current_mg_dist=self.Absorption_Probs[start_state_index]
            for i in range(2,target_count+1):
                pulls_for_this_target=0; next_mg_dist=np.zeros(self.MINGGUANG_MAX)
                for mg,prob in enumerate(current_mg_dist):
                    if prob>1e-9:
                        state_idx=self._state_to_index((0,0,mg)); exp_from_this_mg=self.E_values[state_idx]
                        pulls_for_this_target+=prob*exp_from_this_mg
                        next_mg_dist+=prob*self.Absorption_Probs[state_idx]
                total_pulls+=pulls_for_this_target; current_mg_dist=next_mg_dist
        return total_pulls

    def get_one_target_pulls_sim(self,state,rng,collection,up4_c6):
        pulls,returns_this_run=0,0
        while True:
            pulls+=1; state['pity']+=1; state['pity4']+=1; p5=self._get_prob_5_star(state['pity']-1)
            if rng.get()<p5:
                was_guaranteed=state['isGuaranteed']; p_win,_=self._get_win_lose_prob(was_guaranteed,state.get('mingguangCounter',0))
                is_target=rng.get()<p_win; state['pity'],state['pity4']=0,0
                if is_target:
                    returns_this_run+=self._get_5_star_return(True,collection,rng); self._update_state_after_win(state,was_guaranteed); return pulls,returns_this_run
                else:
                    returns_this_run+=self._get_5_star_return(False,collection,rng); self._update_state_after_lose(state,was_guaranteed)
            elif state['pity4']>=10 or rng.get()<0.051/(1-p5 if p5<1 else 0.99): returns_this_run+=self._handle_4_star_pull(state,rng,collection,up4_c6)
    
    # 【MODIFIED】Detailed 5-star return logic for Genshin
    def _get_5_star_return(self, is_up, c, rng):
        NUM_STANDARD_5_STARS = 7
        if is_up:
            c['up_5_star'] = c.get('up_5_star', 0) + 1
            return 10 if c['up_5_star'] <= 7 else 25
        else:
            char_index = int(rng.get() * NUM_STANDARD_5_STARS)
            char_key = f"std_5_star_{char_index}"
            c[char_key] = c.get(char_key, 0) + 1
            if c[char_key] == 1: return 0
            elif c[char_key] <= 7: return 10
            else: return 25

    # This logic is already correct for Genshin's 4-star pool
    def _handle_4_star_pull(self,s,r,c,u):
        s['pity4']=0; NUM_CHARS, NUM_WEAPONS = 39, 18
        TOTAL_OFF_BANNER = NUM_CHARS + NUM_WEAPONS
        if s['isGuaranteed4'] or r.get()<0.5: s['isGuaranteed4']=False; return 5 if u else 2
        else:
            s['isGuaranteed4']=True
            if r.get() < NUM_CHARS / TOTAL_OFF_BANNER: # It's a character
                i=f"std_char_{int(r.get()*NUM_CHARS)}"; c[i]=c.get(i,0)+1; return 0 if c[i]==1 else (2 if c[i]<=7 else 5)
            else: # It's a weapon
                return 2
    
    def _update_state_after_win(self,state,was_guaranteed):
        super()._update_state_after_win(state,was_guaranteed)
        if not was_guaranteed: state['mingguangCounter']=0
        
    def _update_state_after_lose(self,state,was_guaranteed):
        super()._update_state_after_lose(state,was_guaranteed)
        if not was_guaranteed: state['mingguangCounter'] = state.get('mingguangCounter', 0) + 1

# =============================================================================
# Honkai: Star Rail Character Logic (For Detailed Simulation)
# =============================================================================
class HSRCharacterLogic(GenshinCharacterLogic):
    """Inherits from Genshin logic for simulation structure, but overrides return calculations."""
    def _get_5_star_return(self, is_up, c, rng):
        # Simply call the parent (Genshin) logic and multiply by 4
        genshin_returns = super()._get_5_star_return(is_up, c, rng)
        return genshin_returns * 4

    def _handle_4_star_pull(self, s, r, c, u):
        s['pity4'] = 0
        NUM_CHARS, NUM_LCS = 22, 29
        TOTAL_OFF_BANNER = NUM_CHARS + NUM_LCS
        
        if s.get('isGuaranteed4', False) or r.get() < 0.5:
            s['isGuaranteed4'] = False
            return 20 if u else 8  # 5*4 or 2*4
        else:
            s['isGuaranteed4'] = True
            if r.get() < NUM_CHARS / TOTAL_OFF_BANNER: # It's a character
                i = f"std_char_{int(r.get() * NUM_CHARS)}"
                c[i] = c.get(i, 0) + 1
                if c[i] == 1: return 0
                elif c[i] <= 7: return 8
                else: return 20
            else: # It's a light cone
                return 8

# =============================================================================
# Simplified Models for Math & Basic Simulation
# =============================================================================
# 【FIXED】Inherits from GachaLogic, not GachaModel
class SimpleGachaModel(GachaLogic):
    """Base class for Weapon, Light Cone, and HSR Character (Math) models."""
    def get_expectation_for_state(self, state_dict):
        self._ensure_tables_calculated()
        state_tuple = self._dict_to_tuple(state_dict)
        return self.E_values[self._state_to_index(state_tuple)]
    
    def get_subsequent_expectation(self):
        self._ensure_tables_calculated()
        return self.E_values[self._state_to_index(self.zero_state)]

    # 【NEW】Generic simulation method for all simple models
    def get_one_target_pulls_sim(self, state, rng, collection, up4_c6):
        pulls, returns_this_run = 0, 0
        while True:
            pulls += 1
            state['pity'] += 1
            state['pity4'] += 1
            p5 = self._get_prob_5_star(state['pity'] - 1)
            if rng.get() < p5:
                was_guaranteed = state['isGuaranteed'] or state.get('fatePoint', 0) >= 2
                p_win, _ = self._get_win_lose_prob(was_guaranteed)
                is_target = rng.get() < p_win
                state['pity'], state['pity4'] = 0, 0
                if is_target:
                    returns_this_run += self._get_5_star_return(True, collection, rng)
                    self._update_state_after_win(state, was_guaranteed)
                    return pulls, returns_this_run
                else:
                    returns_this_run += self._get_5_star_return(False, collection, rng)
                    self._update_state_after_lose(state, was_guaranteed)
            elif state['pity4'] >= 10 or rng.get() < (0.051 / (1 - p5 if p5 < 1 else 0.99)):
                returns_this_run += self._handle_4_star_pull(state, rng, collection, up4_c6)
    
    # Default return logic for models without detailed implementation
    def _get_5_star_return(self, is_up, c, rng): return 10
    def _handle_4_star_pull(self, s, r, c, u): s['pity4'] = 0; return 2

class GenshinWeaponModel(SimpleGachaModel):
    PITY_MAX, FATE_MAX = 80, 3 # 0, 1, 2
    TOTAL_STATES = PITY_MAX * FATE_MAX
    zero_state = (0, 0, False)
    
    def _dict_to_tuple(self, d): return (d['pity'], d.get('fatePoint', 0), d['isGuaranteed'])
    def _state_to_index(self, s): return s[0] + s[1] * self.PITY_MAX + (1 if s[2] else 0) * self.PITY_MAX * self.FATE_MAX
    def _get_prob_5_star(self, p):
        pull = p + 1; return 1. if pull >= 80 else (0.007 if pull < 64 else 0.007 + (pull - 63) * 0.07)
    def _get_win_lose_prob(self, is_g_or_fate_full): return (1.0, 0.0) if is_g_or_fate_full else (0.75, 0.25)
    def _build_transition_matrix(self):
        A, b = np.identity(self.TOTAL_STATES), np.ones(self.TOTAL_STATES)
        for i in range(self.TOTAL_STATES):
            guaranteed, fate, pity = i // (self.PITY_MAX * self.FATE_MAX), (i % (self.PITY_MAX * self.FATE_MAX)) // self.PITY_MAX, i % self.PITY_MAX
            p5 = self._get_prob_5_star(pity)
            is_g_or_fate_full = guaranteed or fate >= 2
            if p5 < 1.0: A[i, self._state_to_index((pity + 1, fate, guaranteed))] -= (1.0 - p5)
            if p5 > 0:
                p_win, p_lose = self._get_win_lose_prob(is_g_or_fate_full)
                if p_lose > 0: A[i, self._state_to_index((0, min(fate + 1, self.FATE_MAX - 1), True))] -= p5 * p_lose
        return A, b
    def _update_state_after_win(self, s, wg): s['pity'], s['fatePoint'], s['isGuaranteed'] = 0, 0, False
    def _update_state_after_lose(self, s, wg): s['pity'], s['fatePoint'], s['isGuaranteed'] = 0, min(s.get('fatePoint',0) + 1, self.FATE_MAX - 1), True


class HSRCharacterModel(SimpleGachaModel):
    PITY_MAX, GUARANTEE_MAX = 90, 2
    TOTAL_STATES = PITY_MAX * GUARANTEE_MAX
    zero_state = (0, 0)

    def _dict_to_tuple(self, d): return (d['pity'], 1 if d['isGuaranteed'] else 0)
    def _state_to_index(self, s): return s[0] + s[1] * self.PITY_MAX
    def _get_prob_5_star(self, p):
        pull = p + 1; return 1. if pull >= 90 else (0.006 if pull < 74 else 0.006 + (pull - 73) * 0.06)
    def _get_win_lose_prob(self, is_g): return (1.0, 0.0) if is_g else (0.5, 0.5) # HSR is 50/50
    def _build_transition_matrix(self):
        A, b = np.identity(self.TOTAL_STATES), np.ones(self.TOTAL_STATES)
        for i in range(self.TOTAL_STATES):
            is_g, pity = i // self.PITY_MAX, i % self.PITY_MAX
            p5 = self._get_prob_5_star(pity)
            if p5 < 1.0: A[i, self._state_to_index((pity + 1, is_g))] -= (1.0 - p5)
            if p5 > 0:
                _, p_lose = self._get_win_lose_prob(is_g)
                if p_lose > 0: A[i, self._state_to_index((0, 1))] -= p5 * p_lose
        return A, b
    
    # 【NEW】Detailed return logic for HSR Character simulation
    def _get_5_star_return(self, is_up, c, rng):
        NUM_STANDARD_5_STARS = 7
        if is_up:
            c['up_5_star'] = c.get('up_5_star', 0) + 1
            return 40 if c['up_5_star'] <= 7 else 100
        else:
            char_index = int(rng.get() * NUM_STANDARD_5_STARS)
            char_key = f"std_5_star_{char_index}"
            c[char_key] = c.get(char_key, 0) + 1
            if c[char_key] == 1: return 0
            elif c[char_key] <= 7: return 40
            else: return 100
            
    def _handle_4_star_pull(self, s, r, c, u):
        s['pity4'] = 0
        NUM_CHARS, NUM_LCS = 22, 29
        TOTAL_OFF_BANNER = NUM_CHARS + NUM_LCS
        if s.get('isGuaranteed4', False) or r.get() < 0.5:
            s['isGuaranteed4'] = False
            return 20 if u else 8
        else:
            s['isGuaranteed4'] = True
            if r.get() < NUM_CHARS / TOTAL_OFF_BANNER:
                char_index = int(r.get() * NUM_CHARS)
                char_key = f"std_char_{char_index}"
                c[char_key] = c.get(char_key, 0) + 1
                if c[char_key] == 1: return 0
                elif c[char_key] <= 7: return 8
                else: return 20
            else:
                return 8

class HSRLightConeModel(SimpleGachaModel):
    PITY_MAX, GUARANTEE_MAX = 80, 2
    TOTAL_STATES = PITY_MAX * GUARANTEE_MAX
    zero_state = (0, 0)

    def _dict_to_tuple(self, d): return (d['pity'], 1 if d['isGuaranteed'] else 0)
    def _state_to_index(self, s): return s[0] + s[1] * self.PITY_MAX
    def _get_prob_5_star(self, p):
        pull = p + 1; return 1. if pull >= 80 else (0.008 if pull < 66 else 0.008 + (pull - 65) * 0.08)
    def _get_win_lose_prob(self, is_g): return (1.0, 0.0) if is_g else (0.75, 0.25)
    def _build_transition_matrix(self):
        A, b = np.identity(self.TOTAL_STATES), np.ones(self.TOTAL_STATES)
        for i in range(self.TOTAL_STATES):
            is_g, pity = i // self.PITY_MAX, i % self.PITY_MAX
            p5 = self._get_prob_5_star(pity)
            if p5 < 1.0: A[i, self._state_to_index((pity + 1, is_g))] -= (1.0 - p5)
            if p5 > 0:
                _, p_lose = self._get_win_lose_prob(is_g)
                if p_lose > 0: A[i, self._state_to_index((0, 1))] -= p5 * p_lose
        return A, b
    
    # Simplified return logic for HSR Light Cones
    def _get_5_star_return(self, is_up, c, rng): return 40
    def _handle_4_star_pull(self, s, r, c, u): s['pity4'] = 0; return 8

# -----------------------------------------------------------------------------
# Logic Dispatcher
# 【FIXED】All class names are now correct.
# -----------------------------------------------------------------------------
MODEL_LOGIC = {
    "genshin-character": GenshinCharacterLogic(),
    "genshin-weapon": GenshinWeaponModel(),
    # Note: For HSR Characters, simulation uses HSRCharacterModel's detailed methods,
    # while math expectation uses its simpler matrix methods.
    "hsr-character": HSRCharacterModel(),
    "hsr-lightcone": HSRLightConeModel()
}

# -----------------------------------------------------------------------------
# Main Execution Block
# -----------------------------------------------------------------------------
if __name__ == "__main__":
    try:
        args = json.loads(sys.argv[1])
        mode = args.get('mode', 'expectation')
        
        # Select the engine based on the mode
        model = MonteCarloModel(args) if mode == 'distribution' else MathematicalModel(args)
        
        # Run the engine and print result as JSON
        print(json.dumps(model.run()))
        
    except Exception as e:
        import traceback
        # Print a detailed error to stderr for the JS plugin to catch
        print(f"FATAL SCRIPT ERROR: {e}\n{traceback.format_exc()}", file=sys.stderr)
        sys.exit(1)
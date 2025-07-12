import sys
import json
import numpy as np

# -----------------------------------------------------------------------------
# 1. 基础概率和模型定义 (与上一版基本相同，但更精炼)
# -----------------------------------------------------------------------------

class GachaModel:
    """所有卡池模型的基类"""
    def __init__(self):
        self.E_values = self._solve()

    def _solve(self):
        A, b = self._build_transition_matrix()
        try:
            return np.linalg.solve(A, b)
        except np.linalg.LinAlgError:
            raise RuntimeError(f"模型 {self.__class__.__name__} 的转移矩阵是奇异的，无法求解。")

    def get_total_expectation(self, args):
        """计算获取N个目标的总期望值"""
        initial_state = args['initialState']
        target_count = args['targetCount']

        # 1. 计算第一个目标的期望
        pulls_for_first = self.get_expectation_for_state(initial_state)
        if target_count == 1:
            return pulls_for_first
        
        # 2. 计算后续目标的期望值
        pulls_for_subsequent = self._get_subsequent_expectation(initial_state)
        
        # 3. 加总
        return pulls_for_first + (target_count - 1) * pulls_for_subsequent

    # 以下方法由子类实现
    def get_expectation_for_state(self, state_dict):
        raise NotImplementedError
    def _get_subsequent_expectation(self, from_state_dict):
        raise NotImplementedError
    def _build_transition_matrix(self):
        raise NotImplementedError

class GenshinCharacterModel(GachaModel):
    """原神角色池模型"""
    PITY_MAX, GUARANTEE_MAX, MINGGUANG_MAX = 90, 2, 4
    TOTAL_STATES = PITY_MAX * GUARANTEE_MAX * MINGGUANG_MAX

    def __init__(self):
        super().__init__()
        # 缓存从0 pity, 小保底, 不同明光计数开始的期望值
        self.E_base = {mg: self.E_values[self._state_to_index((0, 0, mg))] for mg in range(self.MINGGUANG_MAX)}

    def _state_to_index(self, state):
        pity, is_g, mg = state
        return pity + is_g * self.PITY_MAX + mg * self.PITY_MAX * self.GUARANTEE_MAX

    def _get_prob_5_star(self, pity):
        pull = pity + 1
        if pull >= 90: return 1.0
        if pull < 74: return 0.006
        return 0.006 + (pull - 74 + 1) * 0.06

    def _get_win_lose_prob(self, is_guaranteed, mingguang):
        if is_guaranteed: return 1.0, 0.0
        if mingguang >= 3: return 1.0, 0.0
        p_mg_win = 0.00018
        p_5050_win = (1 - p_mg_win) * 0.5
        p_win = p_mg_win + p_5050_win
        return p_win, 1.0 - p_win
    
    def _build_transition_matrix(self):
        A = np.identity(self.TOTAL_STATES)
        b = np.ones(self.TOTAL_STATES)
        for i in range(self.TOTAL_STATES):
            mg = i // (self.PITY_MAX * self.GUARANTEE_MAX)
            is_g = (i % (self.PITY_MAX * self.GUARANTEE_MAX)) // self.PITY_MAX
            pity = i % self.PITY_MAX
            p5 = self._get_prob_5_star(pity)
            if p5 < 1.0:
                A[i, self._state_to_index((pity + 1, is_g, mg))] -= (1.0 - p5)
            if p5 > 0:
                p_win, p_lose = self._get_win_lose_prob(is_g, mg)
                if p_lose > 0:
                    new_mg = mg + 1 if not is_g else mg
                    A[i, self._state_to_index((0, 1, min(new_mg, self.MINGGUANG_MAX - 1)))] -= p5 * p_lose
        return A, b

    def get_expectation_for_state(self, state_dict):
        pity, is_g, mg = state_dict['pity'], 1 if state_dict['isGuaranteed'] else 0, state_dict['mingguangCounter']
        return self.E_values[self._state_to_index((pity, is_g, mg))]

    def _get_subsequent_expectation(self, from_state_dict):
        is_g, mg = 1 if from_state_dict['isGuaranteed'] else 0, from_state_dict['mingguangCounter']
        p_win, p_lose = self._get_win_lose_prob(is_g, mg)
        
        # 如果赢了，下一个状态从明光0开始
        e_if_win = self.E_base[0]
        # 如果输了，下一个状态从明光+1开始
        e_if_lose = self.E_base[min(mg + 1, self.MINGGUANG_MAX - 1)] if not is_g else self.E_base[mg]
        
        return p_win * e_if_win + p_lose * e_if_lose

# --- 其他卡池模型（简化，因为它们没有复杂的继承状态） ---
class SimpleGachaModel(GachaModel):
    """用于星铁角色、光锥和原神武器的简化模型基类"""
    def get_expectation_for_state(self, state_dict):
        state_tuple = self._dict_to_tuple(state_dict)
        return self.E_values[self._state_to_index(state_tuple)]
    
    def _get_subsequent_expectation(self, from_state_dict):
        # 对于这些简单模型，后续期望总是等于从0开始的期望
        return self.E_values[self._state_to_index(self.zero_state)]

class GenshinWeaponModel(SimpleGachaModel):
    PITY_MAX, FATE_MAX = 80, 2
    TOTAL_STATES = PITY_MAX * FATE_MAX
    zero_state = (0, 0)
    
    def _dict_to_tuple(self, d): return (d['pity'], d['fatePoint'])
    def _state_to_index(self, s): return s[0] + s[1] * self.PITY_MAX
    def _get_prob_5_star(self, p):
        pull = p + 1
        if pull >= 80: return 1.0
        if pull < 64: return 0.007
        return 0.007 + (pull - 64 + 1) * 0.07
    def _get_win_lose_prob(self, fate): return (1.0, 0.0) if fate >= 1 else (0.375, 0.625)
    
    def _build_transition_matrix(self):
        A, b = np.identity(self.TOTAL_STATES), np.ones(self.TOTAL_STATES)
        for i in range(self.TOTAL_STATES):
            fate, pity = i // self.PITY_MAX, i % self.PITY_MAX
            p5 = self._get_prob_5_star(pity)
            if p5 < 1.0: A[i, self._state_to_index((pity + 1, fate))] -= (1.0 - p5)
            if p5 > 0:
                p_win, p_lose = self._get_win_lose_prob(fate)
                if p_lose > 0: A[i, self._state_to_index((0, 1))] -= p5 * p_lose
        return A, b

class HSRCharacterModel(SimpleGachaModel):
    PITY_MAX, GUARANTEE_MAX = 90, 2
    TOTAL_STATES = PITY_MAX * GUARANTEE_MAX
    zero_state = (0, 0)

    def _dict_to_tuple(self, d): return (d['pity'], 1 if d['isGuaranteed'] else 0)
    def _state_to_index(self, s): return s[0] + s[1] * self.PITY_MAX
    def _get_prob_5_star(self, p):
        pull = p + 1
        if pull >= 90: return 1.0
        if pull < 74: return 0.006
        return 0.006 + (pull - 74 + 1) * 0.06
    def _get_win_lose_prob(self, is_g): return (1.0, 0.0) if is_g else (0.5625, 0.4375)

    def _build_transition_matrix(self):
        A, b = np.identity(self.TOTAL_STATES), np.ones(self.TOTAL_STATES)
        for i in range(self.TOTAL_STATES):
            is_g, pity = i // self.PITY_MAX, i % self.PITY_MAX
            p5 = self._get_prob_5_star(pity)
            if p5 < 1.0: A[i, self._state_to_index((pity + 1, is_g))] -= (1.0 - p5)
            if p5 > 0:
                p_win, p_lose = self._get_win_lose_prob(is_g)
                if p_lose > 0: A[i, self._state_to_index((0, 1))] -= p5 * p_lose
        return A, b

class HSRLightConeModel(SimpleGachaModel):
    PITY_MAX, GUARANTEE_MAX = 80, 2
    TOTAL_STATES = PITY_MAX * GUARANTEE_MAX
    zero_state = (0, 0)

    def _dict_to_tuple(self, d): return (d['pity'], 1 if d['isGuaranteed'] else 0)
    def _state_to_index(self, s): return s[0] + s[1] * self.PITY_MAX
    def _get_prob_5_star(self, p):
        pull = p + 1
        if pull >= 80: return 1.0
        if pull < 66: return 0.008
        return 0.008 + (pull - 66 + 1) * 0.08
    def _get_win_lose_prob(self, is_g): return (1.0, 0.0) if is_g else (0.75, 0.25)
    
    def _build_transition_matrix(self):
        A, b = np.identity(self.TOTAL_STATES), np.ones(self.TOTAL_STATES)
        for i in range(self.TOTAL_STATES):
            is_g, pity = i // self.PITY_MAX, i % self.PITY_MAX
            p5 = self._get_prob_5_star(pity)
            if p5 < 1.0: A[i, self._state_to_index((pity + 1, is_g))] -= (1.0 - p5)
            if p5 > 0:
                p_win, p_lose = self._get_win_lose_prob(is_g)
                if p_lose > 0: A[i, self._state_to_index((0, 1))] -= p5 * p_lose
        return A, b

# -----------------------------------------------------------------------------
# 3. 模型工厂和主程序入口
# -----------------------------------------------------------------------------

MODEL_FACTORY = {
    "genshin-character": GenshinCharacterModel,
    "genshin-weapon": GenshinWeaponModel,
    "hsr-character": HSRCharacterModel,
    "hsr-lightcone": HSRLightConeModel
}

model_cache = {}

def get_model(game, pool):
    key = f"{game}-{pool}"
    if key not in model_cache:
        model_class = MODEL_FACTORY.get(key)
        if not model_class:
            raise NotImplementedError(f"模型 {key} 尚未实现。")
        model_cache[key] = model_class()
    return model_cache[key]

if __name__ == "__main__":
    try:
        if len(sys.argv) < 2: raise ValueError("缺少计算参数JSON")
        args = json.loads(sys.argv[1])
        model = get_model(args['game'], args['pool'])
        total_pulls = model.get_total_expectation(args)
        print(total_pulls)
    except Exception as e:
        import traceback
        print(f"Python script error: {e}\n{traceback.format_exc()}", file=sys.stderr)
        sys.exit(1)
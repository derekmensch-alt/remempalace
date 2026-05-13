import type { InjectionBudget, Tier } from "./types.js";

export interface BudgetManagerOptions {
  maxMemoryTokens: number;
  budgetPercent: number;
  l2BudgetFloor: number;
}

export class BudgetManager {
  constructor(private readonly opts: BudgetManagerOptions) {}

  compute(params: { conversationTokens: number; contextWindow?: number }): InjectionBudget {
    const { maxMemoryTokens, budgetPercent, l2BudgetFloor } = this.opts;
    const contextWindow = params.contextWindow ?? 200000;
    const safetyMargin = 0.1;
    const available = Math.max(
      0,
      contextWindow - params.conversationTokens - contextWindow * safetyMargin,
    );
    const contextFillRatio = params.conversationTokens / contextWindow;

    let allowedTiers: Tier[];
    if (contextFillRatio >= 0.8) {
      allowedTiers = [];
    } else if (contextFillRatio >= 0.7) {
      allowedTiers = ["L0"];
    } else if (contextFillRatio > 1 - l2BudgetFloor) {
      allowedTiers = ["L0", "L1"];
    } else {
      allowedTiers = ["L0", "L1", "L2"];
    }

    const budgetTokens = Math.min(
      Math.floor(available * budgetPercent),
      maxMemoryTokens,
    );

    return {
      maxTokens: Math.max(0, budgetTokens),
      allowedTiers,
      contextFillRatio,
    };
  }
}

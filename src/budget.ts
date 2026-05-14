import type { TokenUsage } from './types.js';

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export class BudgetManager {
  #globalBudget?: { tokens: number };
  #totalUsed: number = 0;

  constructor(globalBudget?: { tokens: number }) {
    this.#globalBudget = globalBudget;
  }

  consume(usage: TokenUsage): void {
    const tokens = usage.inputTokens + usage.outputTokens + (usage.cacheCreationTokens ?? 0);
    this.#totalUsed += tokens;
  }

  canAfford(estimatedTokens: number): boolean {
    if (!this.#globalBudget) return true;
    return this.#totalUsed + estimatedTokens <= this.#globalBudget.tokens;
  }

  isExceeded(): boolean {
    if (!this.#globalBudget) return false;
    return this.#totalUsed > this.#globalBudget.tokens;
  }

  remaining(): number {
    if (!this.#globalBudget) return Infinity;
    return Math.max(0, this.#globalBudget.tokens - this.#totalUsed);
  }

  totalUsed(): number {
    return this.#totalUsed;
  }
}

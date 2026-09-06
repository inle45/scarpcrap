/**
 * Limitation de debit et budget d'appels.
 *
 * Deux mecanismes complementaires :
 *  - `RateLimiter` espace les requetes dans le temps (respect des CGU des API) ;
 *  - `CallBudget` plafonne le nombre total d'appels d'un cycle, pour ne pas
 *    cramer le quota quotidien gratuit en une seule execution.
 */

export class RateLimiter {
  private readonly minIntervalMs: number;
  private nextFreeAt = 0;

  /** @param perMinute nombre de requetes autorisees par minute. */
  constructor(perMinute: number) {
    this.minIntervalMs = perMinute > 0 ? Math.ceil(60_000 / perMinute) : 0;
  }

  /** Attend le temps necessaire pour respecter l'intervalle minimum. */
  async acquire(): Promise<void> {
    if (this.minIntervalMs === 0) return;
    const now = Date.now();
    const waitMs = Math.max(0, this.nextFreeAt - now);
    this.nextFreeAt = Math.max(now, this.nextFreeAt) + this.minIntervalMs;
    if (waitMs > 0) await sleep(waitMs);
  }

  /** Recule la prochaine fenetre, par exemple apres un 429 avec Retry-After. */
  penalize(ms: number): void {
    this.nextFreeAt = Math.max(this.nextFreeAt, Date.now() + ms);
  }
}

export class BudgetExhaustedError extends Error {
  constructor(public readonly scope: string, public readonly limit: number) {
    super(`Budget d'appels epuise pour ${scope} (${limit} appels)`);
    this.name = 'BudgetExhaustedError';
  }
}

export class CallBudget {
  private used = 0;

  constructor(
    public readonly scope: string,
    public readonly limit: number,
  ) {}

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  get spent(): number {
    return this.used;
  }

  /** Consomme un jeton ; leve `BudgetExhaustedError` si le budget est epuise. */
  take(n = 1): void {
    if (this.used + n > this.limit) throw new BudgetExhaustedError(this.scope, this.limit);
    this.used += n;
  }

  /** Variante non levee, pour les boucles qui doivent juste s'arreter. */
  tryTake(n = 1): boolean {
    if (this.used + n > this.limit) return false;
    this.used += n;
    return true;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

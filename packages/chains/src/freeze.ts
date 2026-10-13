/**
 * Freezes an object and every object nested in it, and returns the same reference with its type
 * unchanged. Used for trusted data that ends up in fees and signed quotes (`CHAINS`, `TOKEN_LIST`
 * and `FEE_SCHEDULE`): runtime code must not be able to change it. `readonly` and `as const`
 * are type-level only; this is the runtime guarantee.
 */
export function deepFreeze<T extends object>(value: T): T {
  for (const nested of Object.values(value) as unknown[]) {
    if (typeof nested === 'object' && nested !== null && !Object.isFrozen(nested)) {
      deepFreeze(nested);
    }
  }
  return Object.freeze(value);
}

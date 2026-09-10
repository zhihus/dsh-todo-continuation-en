/**
 * Minimal ambient typing for the one browser module this plugin's settings page
 * requires. The client bundle runs inside the host's loader (see types/globals.d.ts),
 * so there is nothing to install — this stub keeps `tsc --noEmit` honest about the
 * hooks the code actually uses.
 */
declare module "react" {
  export const Fragment: any
  export function createElement(...args: any[]): any
  export function useState<T>(initial: T): [T, (value: T) => void]
  export function useEffect(effect: () => void | (() => void), deps?: unknown[]): void
  export function useSyncExternalStore<T>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => T,
  ): T
}

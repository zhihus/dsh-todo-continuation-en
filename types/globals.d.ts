/**
 * Ambient declarations for the browser settings page: the host injects these
 * globals before any client bundle runs, so they cannot be imported — they can
 * only be declared. The loader's `require` returns untyped module exports
 * (React is the only one this plugin asks for), which is the honest level of
 * typing achievable without vendoring the host's own bundle types.
 */
export {}

declare global {
  interface Window {
    __ModuleLoader__: {
      load(spec: {
        id: string
        factory: (require: (name: string) => any) => {
          inject: string[]
          apply: (ctx: any) => void
          [exportName: string]: unknown
        }
      }): void
    }
  }
}

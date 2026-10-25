// Lets the verify scripts load app modules under plain `node`.
// The app uses extensionless relative imports (bundler resolution); Node's
// type stripping needs the `.ts`. Import this FIRST, then load app modules
// with a dynamic `await import(...)` — static imports are linked before this
// hook registers.
import { registerHooks } from "node:module"

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (err) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../")
      if (relative && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw err
    }
  },
})

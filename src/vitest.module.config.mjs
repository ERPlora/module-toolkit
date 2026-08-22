// The ONE vitest configuration the gate runs a module with (module-toolkit#74).
//
// 🔴 A PLAIN OBJECT, NOT `defineConfig`. This file is handed to vitest as `--config` from wherever
// the toolkit happens to live, which is NOT inside the module: an `import { defineConfig } from
// 'vitest/config'` here is resolved relative to THIS file, and on a runner — where vitest is
// installed next to the module and not next to the toolkit — it dies with
// «Cannot find package 'vitest'» before a single test is collected. Vitest accepts a plain object
// config, so the file needs no import at all and works from any directory.
//
// WHY THE TOOLKIT OWNS IT instead of using each module's own. 23 of the 25 module repos carry no
// `vitest.config.ts`, so vitest's defaults would apply: environment `node`, where a Lit Web
// Component cannot mount, and an `include` that also sweeps `dist/` and the `.wt-*` worktrees a
// shared checkout holds. The two modules that DO carry one (`sales`, `kitchen`) declare exactly
// what `test` says below, character for character — this is not a new rule, it is the rule they
// already share, moved to the one place that cannot drift from what `--list` promises.
export default {
  // 🔴 THE TSCONFIG, because a module repo does NOT ship a usable one and without it every test of
  // several modules is red for a reason that has nothing to do with the module. The toolkit is the
  // wrapper that provides the dependencies AND the tsconfig — its own package.json says so, and the
  // module repo stays clean. Both of these were reproduced on a stripped checkout (which is exactly
  // what a runner has) before being written down:
  //
  //   * 22 of the 25 modules carry NO `tsconfig.json`. With none, `experimentalDecorators` is off,
  //     Lit's `@state()` is a parse error, and all 96 tests of `appointments` die with «SyntaxError:
  //     Invalid or unexpected token». Getting the decorator to compile is only half: with
  //     `useDefineForClassFields` left on, Lit then throws at RUNTIME — «will not trigger updates as
  //     expected because they are set using class fields» — because a native field shadows the
  //     accessor the decorator installed.
  //   * the 3 that DO carry one (`flows`, `modifiers`, `printing`) are `{ extends:
  //     '../../tsconfig.json' }` — a path that exists only inside the development workspace. Off it
  //     the transform dies outright («Failed to load tsconfig: Tsconfig not found») and the module
  //     collects ZERO tests: 26 files of `flows`, red before running a line. That is a latent defect
  //     in those three repos, and stating the tsconfig here is also what stops it from mattering.
  //
  // Vite 8 transpiles with oxc; `tsconfig` given INLINE wins over whatever the tree holds, so all 25
  // modules are transpiled identically whatever each repo happens to carry. Same values as the
  // development workspace's own `tsconfig.json`, so what CI compiles is what the author compiles.
  oxc: {
    tsconfig: {
      compilerOptions: {
        target: 'ES2022',
        experimentalDecorators: true, // Lit's `@state()` / `@property()` are legacy decorators
        useDefineForClassFields: false, // with `true` the class field shadows the decorator's accessor
      },
    },
  },
  test: {
    // Kept in sync with `TS_TEST_GLOBS` in run-vitest.mjs — asserted by its own test, because a
    // gate that lists one set and runs another is the hole this whole file closes.
    include: ['ui/**/*.test.ts'],
    // happy-dom gives a real DOM (custom elements + shadow root), so the component is MOUNTED and
    // what it paints is checked, not what its source says. It does not do layout: anything that
    // depends on flex or scroll is verified in a real browser.
    environment: 'happy-dom',
  },
};

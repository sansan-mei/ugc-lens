import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixDeclarationImports } from '../../scripts/build.ts'

test('fixDeclarationImports：相对路径的 .ts 改成 .js，包名和其他内容不动', () => {
  const input = [
    "export { a } from './config.ts';",
    'import type { B } from "../llm/types.ts";',
    "export type C = import('./pipeline/merge.ts').Theme;",
    "import * as z from 'zod';",
    "import x from 'some.ts';",
    "const note = 'file.ts';",
  ].join('\n')
  assert.equal(
    fixDeclarationImports(input),
    [
      "export { a } from './config.js';",
      'import type { B } from "../llm/types.js";',
      "export type C = import('./pipeline/merge.js').Theme;",
      "import * as z from 'zod';",
      "import x from 'some.ts';",
      "const note = 'file.ts';",
    ].join('\n'),
  )
})

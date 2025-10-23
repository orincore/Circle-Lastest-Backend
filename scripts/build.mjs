import { build } from 'esbuild'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Basic ESM build for low-RAM servers. No type-checking, just transpile & bundle entry.
// Entry: src/index.ts -> dist/index.js

const external = [
  // Keep native/peer deps external if needed
  'pg-native',
]

const tsconfig = resolve(process.cwd(), 'tsconfig.json')

async function main() {
  await build({
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.js',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: false,
    minify: false,
    external,
    tsconfig,
  })
  console.log('esbuild: bundle created at dist/index.js')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

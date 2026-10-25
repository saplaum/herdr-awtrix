import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const targets = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-arm64": "bun-linux-arm64",
  "linux-x64": "bun-linux-x64",
} as const

type Target = keyof typeof targets
const args = process.argv.slice(2)
const target = args[0] ?? `${process.platform}-${process.arch}`
if (args.length > 1 || !Object.hasOwn(targets, target)) {
  throw new Error(`Usage: bun run build [${Object.keys(targets).join("|")}]`)
}

const root = resolve(import.meta.dir, "..")
const manifest = Bun.TOML.parse(readFileSync(resolve(root, "herdr-plugin.toml"), "utf8")) as { version: string }
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
if (manifest.version !== pkg.version) throw new Error("Package and manifest versions must match")
const tag = process.env.GITHUB_REF
if (tag?.startsWith("refs/tags/v") && tag !== `refs/tags/v${pkg.version}`) {
  throw new Error(`Release tag must match manifest version v${pkg.version}`)
}
const directory = resolve(root, "dist", target)
mkdirSync(directory, { recursive: true })
const outfile = resolve(directory, "herdr-awtrix")
const result = await Bun.build({
  entrypoints: [resolve(root, "index.ts")],
  compile: {
    target: targets[target as Target],
    outfile,
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
  minify: true,
})
if (!result.success) throw new AggregateError(result.logs, "Standalone build failed")
console.log(outfile)

// A default/native build also prepares this checkout for `herdr plugin link`.
// Explicit cross-builds never replace the locally runnable executable.
if (args.length === 0) {
  const bin = resolve(root, "bin")
  mkdirSync(bin, { recursive: true })
  const temporary = resolve(bin, `herdr-awtrix.${process.pid}.tmp`)
  copyFileSync(outfile, temporary)
  chmodSync(temporary, 0o755)
  renameSync(temporary, resolve(bin, "herdr-awtrix"))
  writeFileSync(resolve(bin, "version"), `${pkg.version}\n`)
  console.log(`Local launcher ready: ${resolve(bin, "herdr-awtrix")}`)
}

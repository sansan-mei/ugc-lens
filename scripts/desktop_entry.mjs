// 桌面单文件包的入口，由 Node SEA 放在虚拟文件系统根目录执行；编译产物在同一棵目录树里
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { desktopArgs } from './dist/cli/desktop.js'

const { args, workdir } = desktopArgs(process.argv.slice(2), homedir())
if (workdir) mkdirSync(workdir, { recursive: true })
process.argv.splice(2, process.argv.length, ...args)
await import('./dist/cli/index.js')

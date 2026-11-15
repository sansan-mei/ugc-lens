import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ugc-lens 的全部数据都写在 ~/.ugc-lens，任何没有显式隔离的测试都会碰到本机真实目录。
// npm test 用 --import 预先加载本文件，每个测试进程（及其子进程）默认使用一个临时主目录。
const home = mkdtempSync(join(tmpdir(), 'ugc-lens-test-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.once('exit', () => rmSync(home, { recursive: true, force: true }))

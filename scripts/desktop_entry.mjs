// 桌面单文件包的入口，由 Node SEA 放在虚拟文件系统根目录执行；编译产物在同一棵目录树里
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { isDoubleClick, launchDesktop } from './dist/cli/desktop.js'
import { openBrowser } from './dist/cli/ui.js'

if (isDoubleClick(process.argv.slice(2))) {
  // 双击：打开已在运行的界面，或在后台启动一个，然后启动器自己退出
  await launchDesktop({ home: homedir(), execPath: process.execPath, open: openBrowser, spawn })
} else {
  await import('./dist/cli/index.js')
}

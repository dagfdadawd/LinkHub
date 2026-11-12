#requires -Version 7
<#
  为 verifier 生成一个「干净验收沙箱」：
  - 复制当前工作区源码（含未提交改动），但排除 node_modules / .git / 真实 .env / 运行期产物；
  - 用 junction 把主仓库的 4 个 node_modules 挂进来（不跑 pnpm install）；
  - 沙箱内没有 .env，可模拟「全新用户无配置」启动，绝不接触真实凭据。

  用法：
    pwsh -NoProfile -File docs/qa/verification/tools/make-sandbox.ps1 [-Sandbox <目录>] [-Force]
  默认沙箱：%TEMP%\linkhub-verify-sandbox
#>
param(
  [string]$Sandbox = (Join-Path $env:TEMP 'linkhub-verify-sandbox'),
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$env:PATH = "C:\Users\zx\AppData\Local\Temp\qoder-pnpm-shim;$env:PATH"

# 脚本位于 <repo>/docs/qa/verification/tools/ → 仓库根是上溯 4 级
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
if (-not (Test-Path (Join-Path $repo 'unimsg-connector\packages\server\src\index.ts'))) {
  throw "无法定位仓库根（从 $PSScriptRoot 上溯得到 $repo）"
}
Write-Host "[sandbox] repo   : $repo"
Write-Host "[sandbox] sandbox: $Sandbox"

if (Test-Path $Sandbox) {
  if (-not $Force) { throw "沙箱已存在：$Sandbox（加 -Force 覆盖）" }
  Write-Host '[sandbox] 清理旧沙箱…'
  Remove-Item $Sandbox -Recurse -Force
}
New-Item -ItemType Directory -Path $Sandbox -Force | Out-Null

# robocopy：/E 含空目录；排除 node_modules、.git、真实 .env 与所有运行期产物
$excludeDirs = @('node_modules', '.git', '.data', '.shots', 'screenshots')
$excludeFiles = @(
  '.env', '.env.local', '*.log', '*.log.err',
  '.mail-watermarks.json', '.feishu-user-token.json', '.feishu-user-receive.json'
)
$roboArgs = @($repo, $Sandbox, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1')
$roboArgs += '/XD'
$roboArgs += $excludeDirs
$roboArgs += '/XF'
$roboArgs += $excludeFiles
& robocopy @roboArgs | Out-Null
$roboCode = $LASTEXITCODE
# robocopy: 0-7 都是成功
if ($roboCode -ge 8) { throw "robocopy 失败（exit=$roboCode）" }

# junction：主仓库的 node_modules（含 pnpm workspace 链接）
$junctions = @(
  'unimsg-connector\node_modules',
  'unimsg-connector\packages\server\node_modules',
  'unimsg-connector\packages\web\node_modules',
  'unimsg-connector\packages\shared\node_modules'
)
foreach ($rel in $junctions) {
  $target = Join-Path $repo $rel
  $link = Join-Path $Sandbox $rel
  if (-not (Test-Path $target)) { throw "主仓库缺少 $rel（未安装依赖？本项目约定不跑 pnpm install，请联系 lead）" }
  New-Item -ItemType Junction -Path $link -Target $target | Out-Null
  Write-Host "[sandbox] junction: $rel -> $target"
}

# 硬校验：沙箱内不得出现 .env / 运行期凭据文件
$leaks = Get-ChildItem $Sandbox -Recurse -File -Force -ErrorAction SilentlyContinue |
  Where-Object {
    $_.FullName -notmatch '\\node_modules\\' -and (
      $_.Name -eq '.env' -or
      $_.Name -eq '.feishu-user-token.json' -or
      $_.Name -eq '.feishu-user-receive.json' -or
      $_.Name -eq '.mail-watermarks.json'
    )
  }
if ($leaks) { throw "沙箱内发现敏感运行期文件：$($leaks.FullName -join ', ')" }

$serverIndex = Join-Path $Sandbox 'unimsg-connector\packages\server\src\index.ts'
if (-not (Test-Path $serverIndex)) { throw '沙箱缺少 server/src/index.ts' }

Write-Host '[sandbox] OK：干净副本已就绪（无 .env、无运行期凭据），可安全启动全 Mock 场景。'
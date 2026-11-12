<#
  LinkHub 桌面版（轻量启动器 · Windows Smart App Control 兼容）

  背景：部分 Windows 11 开启了「智能应用控制」，会拦截未签名 exe（Electron 官方二进制无签名）。
  本启动器改用系统已签名的 node.exe 跑本地服务 + 用已签名的 Edge/Chrome 以 --app 模式打开窗口，
  效果接近桌面 App（无地址栏/标签页、独立任务栏窗口），且在开着智能应用控制的机器上也能用。

  由构建脚本生成时会把 __LINKHUB_DESKTOP_TOKEN__ 替换成本次构建的随机令牌。
#>
$ErrorActionPreference = 'Stop'

$Token = '__LINKHUB_DESKTOP_TOKEN__'
$root = Split-Path -Parent $PSScriptRoot
$nodeExe = Join-Path $root 'runtime\node.exe'
$serverEntry = Join-Path $root 'server\server.cjs'
$appData = Join-Path $env:APPDATA 'LinkHub'
$dataDir = Join-Path $appData 'data'
$logsDir = Join-Path $appData 'logs'
$envFile = Join-Path $appData '.env'
$launcherLog = Join-Path $logsDir 'launcher.log'
$serverOut = Join-Path $logsDir 'server.log'
$serverErr = Join-Path $logsDir 'server.err.log'
$profileDir = Join-Path $appData 'browser-profile'

Add-Type -AssemblyName System.Windows.Forms | Out-Null

function Write-Log([string]$msg) {
  try {
    $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
    Add-Content -LiteralPath $launcherLog -Value $line -Encoding UTF8
  } catch { }
}
function Show-Error([string]$title, [string]$message) {
  [System.Windows.Forms.MessageBox]::Show($message, $title, 'OK', 'Error') | Out-Null
}
function Show-Info([string]$title, [string]$message) {
  [System.Windows.Forms.MessageBox]::Show($message, $title, 'OK', 'Information') | Out-Null
}

# 单实例：已有实例在跑时提示并退出
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'Global\LinkHubDesktopApp', [ref]$createdNew)
if (-not $createdNew) {
  Show-Info 'LinkHub' 'LinkHub 已经在运行了。'
  exit 0
}

foreach ($dir in @($appData, $dataDir, $logsDir)) {
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

# 首次运行：创建用户配置（模板来自包内 config\.env.example，绝不携带任何真实凭据）
if (-not (Test-Path -LiteralPath $envFile)) {
  $template = Join-Path $root 'config\.env.example'
  $header = @(
    '# ============================================================',
    '# LinkHub 桌面版用户配置（只在本机生效，不会进仓库/交付包）',
    '#',
    '# · 本文件位置：%APPDATA%\LinkHub\.env',
    '# · 改完保存后，关闭 App 重新打开即可生效',
    '# · 平台账号填写方法见包内 README.txt 或仓库 docs/personal-identity.md',
    '# · 不填任何凭据也能用：四平台自动 Mock，可完整走通演示闭环',
    '# ============================================================',
    ''
  ) -join "`r`n"
  $body = ''
  if (Test-Path -LiteralPath $template) { $body = Get-Content -LiteralPath $template -Raw -Encoding UTF8 }
  Set-Content -LiteralPath $envFile -Value ($header + $body) -Encoding UTF8
  Write-Log '已创建首次运行配置文件'
}

if (-not (Test-Path -LiteralPath $nodeExe)) {
  Show-Error 'LinkHub 启动失败' "找不到内置运行时：`n$nodeExe`n`n请重新解压完整的 LinkHub 包。"
  exit 1
}
if (-not (Test-Path -LiteralPath $serverEntry)) {
  Show-Error 'LinkHub 启动失败' "找不到本地服务：`n$serverEntry`n`n请重新解压完整的 LinkHub 包。"
  exit 1
}

# 清理上次异常退出可能残留的进程（只清理带我们专属 profile 的浏览器进程）
try {
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profileDir) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} catch { }

# 选一个空闲端口 —— 只能从「已登记端口池」里挑。
#
# 为什么要固定端口池：飞书 OAuth 要求「安全设置 → 重定向 URL」与回调地址**逐字符一致**，
# 而 localhost 是每台机器各自的地址（同一个 http://localhost:3901/... 在每台员工机器上都成立）。
# 因此应用级一次登记 3901–3910 这组回调地址后，全公司所有员工机器都能直接授权，
# 不需要每台机器单独去飞书后台加 URL。反过来说：**端口一旦落到登记范围之外，授权就会报
# 「20029 重定向 URL 有误」**，所以这里不再任意顺延到 3930，只在这 10 个端口里挑。
# 管理员要用别的端口：先在飞书后台登记同一组地址，再用 LINKHUB_DESKTOP_PORTS 覆盖（逗号分隔）。
$portPool = @()
$poolEnv = [string]$env:LINKHUB_DESKTOP_PORTS
if ($poolEnv.Trim()) {
  foreach ($item in ($poolEnv -split '[,\s]+')) {
    $n = 0
    if ([int]::TryParse($item, [ref]$n) -and $n -gt 0 -and $n -lt 65536) { $portPool += $n }
  }
}
if ($portPool.Count -eq 0) { $portPool = @(3901, 3902, 3903, 3904, 3905, 3906, 3907, 3908, 3909, 3910) }
$port = 0
foreach ($candidate in $portPool) {
  $listener = $null
  try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $candidate)
    $listener.Start()
    $listener.Stop()
    $port = $candidate
    break
  } catch {
    if ($listener) { try { $listener.Stop() } catch { } }
  }
}
if ($port -eq 0) {
  $poolText = ($portPool -join ' / ')
  Show-Error 'LinkHub 启动失败' ("端口 $poolText 全部被占用，无法启动本地服务。`n`n这些端口是飞书 OAuth 回调的预登记端口（不能随意换，否则飞书授权会报「20029 重定向 URL 有误」）。`n请先关闭占用它们的程序后重试；排查命令：`n  netstat -ano | findstr :3901")
  exit 1
}

# 准备服务环境变量（web 构建时已烤入同一个 API_TOKEN）
$env:SERVER_HOST = '127.0.0.1'
$env:SERVER_PORT = "$port"
$env:API_TOKEN = $Token
$env:WEB_DIST = Join-Path $root 'web'
$env:DATA_DIR = $dataDir
$env:LINKHUB_DESKTOP = '1'
$env:LINKHUB_CONFIG_FILE = $envFile
$bundledDws = Join-Path $root 'tools\dws.exe'
$userDws = Join-Path $env:USERPROFILE '.local\bin\dws.exe'
if (Test-Path -LiteralPath $bundledDws) { $env:DWS_BIN = $bundledDws }
elseif (Test-Path -LiteralPath $userDws) { $env:DWS_BIN = $userDws }
$feishuRedirectConfigured = $false
try {
  $envText = Get-Content -LiteralPath $envFile -Raw -Encoding UTF8
  $feishuRedirectConfigured = [bool]($envText -match '(?m)^\s*FEISHU_REDIRECT_URI\s*=')
} catch { }
if (-not $feishuRedirectConfigured) {
  $env:FEISHU_REDIRECT_URI = "http://localhost:$port/api/feishu/oauth/callback"
}

Write-Log "启动本地服务：node $serverEntry (port=$port)"

$server = $null
$browser = $null
$fallbackBrowser = $false
try {
  $server = Start-Process -FilePath $nodeExe -ArgumentList @("`"$serverEntry`"") `
    -WorkingDirectory $appData -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr

  $base = "http://127.0.0.1:$port"
  $ready = $false
  for ($i = 0; $i -lt 120; $i++) {
    if ($server.HasExited) { break }
    try {
      $health = Invoke-RestMethod -Uri "$base/api/health" -TimeoutSec 1
      if ($health.ok) { $ready = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 250
  }

  if (-not $ready) {
    $tail = ''
    foreach ($f in @($serverErr, $serverOut)) {
      if (Test-Path -LiteralPath $f) {
        $tail += (Get-Content -LiteralPath $f -Tail 15 -ErrorAction SilentlyContinue) -join "`n"
        $tail += "`n`n"
      }
    }
    Show-Error 'LinkHub 启动失败' "本地服务没有在 30 秒内就绪。`n`n最近日志：`n$tail`n日志位置：$logsDir"
    exit 1
  }

  Write-Log '本地服务已就绪，打开应用窗口'

  # 找 App 模式宿主浏览器（Edge 是 Windows 11 自带且已签名，智能应用控制不会拦截）
  $browserCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

  $browserArgs = @(
    "--app=$base/",
    "--user-data-dir=$profileDir",
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--no-service-autorun',
    '--disable-features=msEdgeFirstRunExperience,msEdgeSyncConfirmationDialog,msEdgeIdentityRoot,msEdgeSidebarV2,msEdgeWorkspaces',
    '--window-size=1320,880'
  )
  # 支持/自动化用：设置 LINKHUB_DEBUG_PORT 后可远程调试（普通用户不用）
  if ($env:LINKHUB_DEBUG_PORT) {
    $browserArgs += "--remote-debugging-port=$($env:LINKHUB_DEBUG_PORT)"
  }

  if ($browserCandidates.Count -gt 0) {
    $browserExe = $browserCandidates[0]
    Write-Log "使用浏览器 App 模式：$browserExe"
    $browser = Start-Process -FilePath $browserExe -ArgumentList $browserArgs -PassThru
    # 等待 App 窗口关闭（Edge/Chrome 的 --app 会随窗口关闭而退出）
    try { $browser.WaitForExit() } catch { }
    Start-Sleep -Milliseconds 800
  } else {
    # 兜底：没有 Edge/Chrome 时用默认浏览器打开（此时以对话框作为"关闭 App"的开关）
    $fallbackBrowser = $true
    Write-Log '未找到 Edge/Chrome，回退默认浏览器'
    Start-Process $base
    Show-Info 'LinkHub 已启动' "已在默认浏览器打开：$base`n`n关闭本对话框会停止后台服务。"
  }
} catch {
  Write-Log ("启动异常：" + $_.Exception.Message)
  Show-Error 'LinkHub 启动异常' ($_.Exception.Message + "`n`n日志位置：$logsDir")
} finally {
  Write-Log '正在退出并停止本地服务'
  if ($server -and -not $server.HasExited) {
    try { & taskkill.exe /PID $server.Id /T /F 2>$null | Out-Null } catch { }
    try { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue } catch { }
  }
  # 结束时清理本次打开的 App 窗口进程（专属 profile，不会影响用户日常浏览器）
  try {
    Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profileDir) } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch { }
  if (-not $fallbackBrowser) { }
  try { $mutex.ReleaseMutex() } catch { }
  try { $mutex.Dispose() } catch { }
}
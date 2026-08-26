# CCUI-Launcher manager.ps1
# Claude Code UI (claudecodeui) one-click launcher caretaker.
# Flow: open splash window immediately -> start dev server if not running
#       -> wait for port -> navigate same window to the real UI via CDP
#       -> watch browser process -> on browser close, kill server tree and exit.

# ============ Configuration (edit here only) ============
$ProjectDir    = "D:\Claude_Tools\claudecodeui"
$ViteScript    = "D:\Claude_Tools\claudecodeui\node_modules\vite\bin\vite.js"
$TsxScript     = "D:\Claude_Tools\claudecodeui\node_modules\tsx\dist\cli.mjs"
$UiPort        = 5173
$UiUrl         = "http://localhost:5173"
$SplashFile    = "D:\Claude_Tools\CCUI-Launcher\splash.html"
$BrowserExe    = "msedge.exe"
$LogDir        = "D:\Claude_Tools\CCUI-Launcher\logs"
$WaitTimeoutSec = 60
$WatchIntervalSec = 2
$CdpPort       = 9223
# ========================================================

$ErrorActionPreference = "SilentlyContinue"

function Write-Log {
    param([string]$Message)
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path (Join-Path $LogDir "launch-$(Get-Date -Format 'yyyyMMdd').log") -Value "[$stamp] $Message"
}

function Test-PortListening {
    param([int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return $null -ne $conn
}

# ---------- Step 1: start server FIRST (parallel with splash) ----------
# Launching the dev server before opening the browser window overlaps the
# Edge startup time with Vite's boot, shaving ~1s off cold start.
$serverPid = $null
if (Test-PortListening -Port $UiPort) {
    Write-Log "Port $UiPort already in use, reusing existing server."
} else {
    Write-Log "Starting vite + backend directly (fast path)."
    $nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    $viteProc = Start-Process -FilePath $nodeExe `
        -ArgumentList "`"$ViteScript`"" `
        -WorkingDirectory $ProjectDir `
        -WindowStyle Hidden `
        -PassThru `
        -RedirectStandardOutput (Join-Path $LogDir "server-out.log") `
        -RedirectStandardError  (Join-Path $LogDir "server-err.log")
    $tsxProc = Start-Process -FilePath $nodeExe `
        -ArgumentList "`"$TsxScript`" --tsconfig `"server/tsconfig.json`" server/index.ts" `
        -WorkingDirectory $ProjectDir `
        -WindowStyle Hidden `
        -PassThru
    $serverPid = "$($viteProc.Id),$($tsxProc.Id)"
    Write-Log "Server PIDs: vite=$($viteProc.Id), backend=$($tsxProc.Id)"
}

# ---------- Step 2: open Edge app-mode splash window ----------
$edgePath = (Get-Command $BrowserExe -ErrorAction SilentlyContinue).Source
if (-not $edgePath) {
    $candidate = "C:\Program Files (x86)\Microsoft\Edge\Application\$BrowserExe"
    if (Test-Path $candidate) { $edgePath = $candidate }
}
if (-not $edgePath) {
    Write-Log "FATAL: browser $BrowserExe not found."
    exit 1
}

# Size the app window to 2/3 width; height = 2/3 working area, centered.
Add-Type -AssemblyName System.Windows.Forms
$workArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$winW = [int]($workArea.Width * 2 / 3)
$winH = [int]($workArea.Height * 2 / 3)
$winX = [int]($workArea.X + ($workArea.Width - $winW) / 2)
$winY = [int]($workArea.Y + ($workArea.Height - $winH) / 2)

$splashUrl = "file:///" + ($SplashFile -replace '\\', '/')
$edgeProc = Start-Process -FilePath $edgePath -ArgumentList `
    "--app=$splashUrl", `
    "--window-position=$winX,$winY", `
    "--window-size=$winW,$winH" -PassThru
$browserProcId = $edgeProc.Id
Write-Log "Splash window opened (PID $browserProcId)."

# ---------- Step 3: wait for UI to be ready ----------
$ready = $false
$deadline = (Get-Date).AddSeconds($WaitTimeoutSec)
while ((Get-Date) -lt $deadline) {
    if (Test-PortListening -Port $UiPort) {
        Start-Sleep -Milliseconds 200
        $ready = $true
        break
    }
    # Bail out early if user closed the splash while waiting.
    $splashAlive = Get-Process -Id $browserProcId -ErrorAction SilentlyContinue
    if (-not $splashAlive) {
        Write-Log "User closed splash during startup. Aborting wait."
        break
    }
    Start-Sleep -Milliseconds 150
}

function Invoke-CdpNavigate {
    param([string]$Url)
    # Deprecated: CDP Page.navigate needs a WebSocket client that PowerShell 5
    # lacks. The splash page handles its own navigation now. Kept as no-op.
    return $false
}

# ---------- Step 4: wait for splash to navigate itself to the UI ----------
# The splash page polls port 5173 and redirects in-place when the server is
# reachable (true same-window handoff). PowerShell must NOT spawn a second
# Edge process here: Edge is single-instance, so Stop-Process on the first
# launcher PID would kill the whole tree including the new UI window.
if (-not $ready) {
    Write-Log "FATAL: UI did not come up within ${WaitTimeoutSec}s. Check server-err.log."
} else {
    Write-Log "UI is up on port $UiPort. Splash page will self-navigate once UI answers."
}

# ---------- Step 5: watch browser; on close kill server tree ----------
while ($true) {
    Start-Sleep -Seconds $WatchIntervalSec

    # The window may have started as --app=splash.html and navigated to the UI
    # URL in-place, so match either form. Alive = our PID exists OR any Edge
    # process still carries one of our --app URLs.
    $ourAlive = Get-Process -Id $browserProcId -ErrorAction SilentlyContinue
    $appAlive = Get-CimInstance Win32_Process -Filter "Name = '$BrowserExe'" |
        Where-Object {
            $_.CommandLine -like "*--app=$UiUrl*" -or
            $_.CommandLine -like "*--app=http*localhost*"  # navigated app window
        }

    if (-not $ourAlive -and -not $appAlive) {
        Write-Log "Browser window closed. Shutting down server tree..."
        break
    }
}

if ($serverPid) {
    foreach ($spid in ($serverPid -split ',')) {
        & taskkill /PID $spid /T /F 2>$null | Out-Null
    }
    Write-Log "Killed launcher trees rooted at: $serverPid."
}

$portConn = Get-NetTCPConnection -LocalPort $UiPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($portConn) {
    $listenerPid = $portConn.OwningProcess
    if ($listenerPid -and $listenerPid -ne $PID) {
        & taskkill /PID $listenerPid /T /F 2>$null | Out-Null
        Write-Log "Killed remaining listener PID $listenerPid on port $UiPort."
    }
}

Write-Log "Shutdown complete. Manager exiting."
exit 0

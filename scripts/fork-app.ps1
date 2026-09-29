# Windows counterpart of scripts/fork-app.sh (PowerShell 7), with the same
# commands and the builds\<branch> layout the app's update menu reads. Builds
# live outside the checkout in $env:T3CODE_FORK_APP_ROOT (default
# ~/Documents/private/t3code-app):
#
#   slot-*\           the builds themselves; never moved, because pnpm's
#                     node_modules junctions on Windows hold absolute paths
#   current           junction to the slot the running app uses
#   builds\<branch>   junction to the newest build of each branch, waiting to be
#                     switched to
#   home\             app state (T3CODE_HOME): settings and the saved connection
#   logs\             app.log, fork-app.log, fork-watch.log
#   source\           the detached worktree `watch` builds origin/fork from
#
# A slot no junction points at is spare: the next prepare builds into it and
# keeps its node_modules. One spare stays, the others are deleted.
#
# The Windows app has no local environment and no t3 service of its own; it
# connects to the Mac's service over a paired connection. So there is no
# prepare-server or restart-service here, and `watch` prepares the app only.
#
#   scripts\fork-app.ps1 prepare           build this checkout (including uncommitted
#                                          changes) into builds\<branch>
#   scripts\fork-app.ps1 restart [branch]  switch to that branch's build and relaunch;
#                                          the app's update menu runs this
#   scripts\fork-app.ps1 delete <branch>   remove a branch's build
#   scripts\fork-app.ps1 watch             fetch origin/fork and prepare a new commit;
#                                          the running app runs this every minute
#   scripts\fork-app.ps1 start | stop | status
#   scripts\fork-app.ps1 shortcut          Start menu and desktop shortcuts that run `restart`
param([Parameter(Position = 0)][string]$Command, [Parameter(Position = 1)][string]$Arg)
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

# `watch` builds the worktree in source\ with this script; the override names it.
$ScriptRepo = if ($env:T3CODE_FORK_REPO) { $env:T3CODE_FORK_REPO } else { Split-Path -Parent $PSScriptRoot }
$Root = if ($env:T3CODE_FORK_APP_ROOT) { $env:T3CODE_FORK_APP_ROOT } else { Join-Path $HOME "Documents\private\t3code-app" }
$HomeDir = Join-Path $Root "home"
$LogDir = Join-Path $Root "logs"
$BuildsDir = Join-Path $Root "builds"
$CurrentLink = Join-Path $Root "current"
$WatchBranch = if ($env:T3CODE_FORK_WATCH_BRANCH) { $env:T3CODE_FORK_WATCH_BRANCH } else { "fork" }
$WatchSource = Join-Path $Root "source"
$NodeMajor = 26
# The app window and the Start menu shortcut share it, so the taskbar shows the
# shortcut's "esveo code" instead of electron.exe's "Electron".
$AppUserModelId = "com.esveo.code"
$Pnpm = "pnpm@11.10.0"

New-Item -ItemType Directory -Force (Join-Path $HomeDir "userdata"), $LogDir, $BuildsDir | Out-Null

# The update menu and the shortcut run this hidden; nobody sees the output.
if ($Command -eq "restart") {
  Start-Transcript -Append -Path (Join-Path $LogDir "fork-app.log") | Out-Null
}

function Use-Node {
  if ((node -v 2>$null) -like "v$NodeMajor.*") { return }
  # nvm-windows' `nvm use` needs admin rights; putting the version first on PATH does not.
  $nvmHome = if ($env:NVM_HOME) { $env:NVM_HOME } else { Join-Path $env:LOCALAPPDATA "nvm" }
  $dir = Get-ChildItem $nvmHome -Directory -Filter "v$NodeMajor.*" -ErrorAction SilentlyContinue |
    Sort-Object { [version]$_.Name.TrimStart("v") } | Select-Object -Last 1
  if (-not $dir) { throw "Node $NodeMajor not found; run 'nvm install $NodeMajor'." }
  $env:PATH = "$($dir.FullName);$env:PATH"
}

function Invoke-Native([string]$Dir, [scriptblock]$Block) {
  Push-Location $Dir
  try { & $Block; if ($LASTEXITCODE) { throw "Command failed with exit code $LASTEXITCODE" } }
  finally { Pop-Location }
}

# Directory-based lock; waits while another holder is alive, steals a dead one.
function Lock-Root([string]$Name) {
  $lock = Join-Path $Root ".$Name.lock"
  while ($true) {
    try { New-Item -ItemType Directory $lock -ErrorAction Stop | Out-Null; break } catch {}
    $holder = Get-Content (Join-Path $lock "pid") -ErrorAction SilentlyContinue
    if ($holder -and -not (Get-Process -Id $holder -ErrorAction SilentlyContinue)) {
      Remove-Item -Recurse -Force $lock; continue
    }
    Write-Host "Waiting for another $Name (pid $holder) ..."
    Start-Sleep 3
  }
  Set-Content (Join-Path $lock "pid") $PID
}

function Unlock-Root([string]$Name) {
  Remove-Item -Recurse -Force (Join-Path $Root ".$Name.lock") -ErrorAction SilentlyContinue
}

# Removes a directory tree without following the junctions inside it.
function Remove-Tree([string]$Path) {
  if (Test-Path $Path) { cmd /c rmdir /s /q $Path | Out-Null }
}

function Get-LinkTarget([string]$Link) {
  $item = Get-Item $Link -Force -ErrorAction SilentlyContinue
  if ($item.LinkType -eq "Junction") { [string]$item.Target } else { $null }
}

# Points a junction at a slot; removing a junction never touches the slot's files.
function Set-Link([string]$Link, [string]$Target) {
  if (Test-Path $Link) { [System.IO.Directory]::Delete($Link, $false) }
  if ($Target) { New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null }
}

function Get-Slots {
  Get-ChildItem $Root -Directory -Filter "slot-*" | Where-Object { -not $_.LinkType } |
    ForEach-Object FullName
}

function Get-UsedSlots {
  @(Get-LinkTarget $CurrentLink) + @(Get-ChildItem $BuildsDir -Force | ForEach-Object { Get-LinkTarget $_.FullName }) |
    Where-Object { $_ }
}

function Read-BuildInfo([string]$Dir) {
  try { Get-Content -Raw (Join-Path $Dir ".fork-build.json") | ConvertFrom-Json } catch { $null }
}

# The directory name a branch's build goes by; the same rule as fork-app.sh.
function Get-Slug([string]$Branch) {
  ($Branch -replace '[^A-Za-z0-9-]', '-' -replace '-{2,}', '-').Trim("-")
}

function Assert-Slug([string]$Slug) {
  if ($Slug -notmatch '^[A-Za-z0-9-]+$') { $Host.UI.WriteErrorLine("Not a branch slug: $Slug"); exit 2 }
}

# The branch a build belongs to. Builds from before slots were per branch carry
# only a label, which starts with the branch.
function Get-BuildSlug($Info) {
  $branch = if ($Info.branch) { $Info.branch } else { ($Info.label -split "@")[0] }
  Get-Slug ($branch -replace '^origin/', '')
}

# The name a build carries. `watch` builds a detached worktree and says which
# branch it is building.
function Get-Branch([string]$Repo) {
  if ($env:T3CODE_FORK_BUILD_BRANCH) { return $env:T3CODE_FORK_BUILD_BRANCH }
  $branch = git -C $Repo rev-parse --abbrev-ref HEAD
  if ($branch -eq "HEAD") {
    $branch = git -C $Repo for-each-ref --points-at HEAD --count 1 --format='%(refname:short)' refs/remotes/origin refs/heads
    $branch = $branch -replace '^origin/', ''
  }
  if ($branch) { $branch } else { "detached" }
}

# Electron and its helpers all run an electron.exe inside a slot.
function Get-AppProcesses {
  $prefix = (Join-Path $Root "slot-").ToLower()
  Get-CimInstance Win32_Process |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith($prefix) }
}

function Stop-App {
  $procs = @(Get-AppProcesses)
  if (-not $procs) { return }
  Write-Host "Stopping app ..."
  $procs | ForEach-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue)?.CloseMainWindow() } | Out-Null
  for ($i = 0; $i -lt 20; $i++) {
    if (-not @(Get-AppProcesses)) { return }
    Start-Sleep -Milliseconds 500
  }
  Get-AppProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep 1 # let Windows release file handles
}

function Set-AppEnv {
  # Agents running inside T3 Code inherit these; a child server that sees them refuses to start.
  Remove-Item Env:VITE_DEV_SERVER_URL, Env:T3_SERVICE_LAUNCHER_CONTEXT, Env:T3_BOOT_SERVICE_UNIT, Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $env:T3CODE_HOME = $HomeDir
  $env:T3CODE_DESKTOP_USER_DATA_DIR_NAME = "t3code-fork"
  $env:T3CODE_DISABLE_AUTO_UPDATE = "1"
  $env:T3CODE_FORK_APP_ROOT = $Root
  $env:T3CODE_FORK_APP_SCRIPT = $PSCommandPath
  $env:T3CODE_DESKTOP_APP_USER_MODEL_ID = $AppUserModelId
}

# Clerk registers t3code:// as a bare `electron.exe "%1"` on every start, which
# Electron cannot open without the app path and without the env above. Point it
# at `open-url` instead, which starts a second instance that hands the URL to
# the running app through the single-instance lock.
function Register-UrlHandler {
  $key = "HKCU:\Software\Classes\t3code\shell\open\command"
  if (-not (Test-Path $key)) { return }
  $conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
  $command = "`"$conhost`" --headless `"$((Get-Command pwsh).Source)`" -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" open-url `"%1`""
  Set-Item $key $command
}

function Open-Url {
  $slot = Get-LinkTarget $CurrentLink
  if (-not $slot) { return }
  Set-AppEnv
  $desktop = Join-Path $slot "apps\desktop"
  $electron = Join-Path $desktop "node_modules\electron\dist\electron.exe"
  Start-Process $electron -ArgumentList "dist-electron/main.cjs", "`"$Arg`"" -WorkingDirectory $desktop
}

function Start-App {
  $slot = Get-LinkTarget $CurrentLink
  $info = if ($slot) { Read-BuildInfo $slot }
  if (-not $info) { throw "No build in $CurrentLink yet; run 'scripts\fork-app.ps1 prepare' first." }
  Use-Node
  # No local server: the app only talks to paired environments, e.g. the Mac's t3 service.
  $settings = Join-Path $HomeDir "userdata\desktop-settings.json"
  if (-not (Test-Path $settings)) { Set-Content $settings '{"localEnvironmentEnabled":false}' }
  $log = Join-Path $LogDir "app.log"
  Set-AppEnv
  # The stopped app's launcher (cmd, node) holds the log a few seconds longer; a
  # log that stays would fail the redirect below and pass the check with old lines.
  # Agent processes the old app spawned (claude, MCP servers) inherit the handle
  # and can outlive it indefinitely, so fall back to a fresh file.
  for ($i = 0; (Test-Path $log) -and $i -lt 5; $i++) {
    Remove-Item $log -ErrorAction SilentlyContinue
    if (Test-Path $log) { Start-Sleep 1 }
  }
  if (Test-Path $log) { $log = Join-Path $LogDir "app-$(Get-Date -Format yyyyMMdd-HHmmss).log" }
  Write-Host "Starting $($info.label) (log: $log) ..."
  # From the real slot path, so every resolved path matches pnpm's junctions.
  # The desktop's start script, without the second or so npx and vp add.
  $proc = Start-Process cmd.exe -ArgumentList "/c node scripts\start-electron.mjs > `"$log`" 2>&1" `
    -WorkingDirectory (Join-Path $slot "apps\desktop") -WindowStyle Hidden -PassThru
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep 1
    if (Select-String -Quiet -Path $log -Pattern "main window created" -ErrorAction SilentlyContinue) {
      Register-UrlHandler
      Write-Host "App window is open."; return
    }
    if ($proc.HasExited) {
      Get-Content $log -Tail 20 -ErrorAction SilentlyContinue | Write-Host
      throw "App exited during startup; see $log"
    }
  }
  throw "App did not report a window within 60 s; check $log"
}

# Copies the checkout into a slot: tracked and untracked source, minus what
# fork-app.sh's .gitignore filter drops. Excluded dirs (node_modules, dist)
# survive in the slot, so repeat builds stay fast.
function Sync-Source([string]$From, [string]$To) {
  Write-Host "Syncing $From -> $To ..."
  $xd = ".git node_modules .bun .turbo dist dist-exe dist-electron .electron-runtime .astro build release release-mock .logs .t3 .idea .playwright playwright-report __screenshots__ .vitest-* .tanstack squashfs-root .vercel .gstack .plans .showcase .generated target .alchemy .pnpm-store .repos".Split(" ")
  # .env stays in: it carries the public T3 Connect identifiers the web build bakes in.
  $xf = ".git *.log *.tsbuildinfo .DS_Store .fork-build.json".Split(" ")
  robocopy $From $To /MIR /XD @xd /XF @xf /NFL /NDL /NJH /NJS /NP /R:2 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
  $global:LASTEXITCODE = 0
}

# Installs only the workspaces a build needs, for this machine alone; the whole
# workspace made every build several GB bigger.
function Install-Deps([string]$Dir, [string[]]$Packages) {
  $marker = Join-Path $Dir "node_modules\.fork-slim-install"
  # A slot left from a full install keeps packages a filtered install leaves alone; start it over once.
  if ((Test-Path (Join-Path $Dir "node_modules")) -and -not (Test-Path $marker)) {
    Write-Host "Removing the full install left in $Dir ..."
    Get-ChildItem $Dir -Directory -Recurse -Depth 2 -Filter node_modules |
      Where-Object { $_.FullName.Substring($Dir.Length) -notmatch 'node_modules.*node_modules' } |
      ForEach-Object { Remove-Tree $_.FullName }
  }
  $filters = @("--filter", "@t3tools/monorepo", "--filter", "@t3tools/scripts...")
  foreach ($package in $Packages) { $filters += @("--filter", "$package...") }
  Write-Host "Installing dependencies ..."
  Invoke-Native $Dir {
    npx -y $Pnpm install --frozen-lockfile --prefer-offline --config.confirmModulesPurge=false `
      --os (node -p process.platform) --cpu (node -p process.arch) @filters
  }
  New-Item -ItemType File -Force $marker | Out-Null
}

# Fetches Electron (from its download cache) now instead of on the first start.
function Install-Electron([string]$Slot) {
  $desktop = Join-Path $Slot "apps\desktop"
  $electron = Invoke-Native $desktop { node -p "require('path').dirname(require.resolve('electron/package.json'))" }
  Invoke-Native $electron { node install.js }
  Invoke-Native $desktop { node scripts/ensure-electron-runtime.mjs | Out-Null }
}

# The slot a branch's build goes into. The branch's waiting build is withdrawn
# first, so the update menu never offers a half-built slot; it is rebuilt in
# place, else a spare slot is recycled, else a new one is made.
function Select-Staging([string]$Slug) {
  $link = Join-Path $BuildsDir $Slug
  $own = Get-LinkTarget $link
  if ($own) { Set-Link $link $null }
  if ($own -and $own -ne (Get-LinkTarget $CurrentLink)) { return $own }
  $used = @(Get-UsedSlots)
  $spare = Get-Slots | Where-Object { $used -notcontains $_ } | Select-Object -First 1
  if ($spare) { return $spare }
  $name = [char[]]"abcdefghijklmnopqrstuvwxyz" | ForEach-Object { "slot-$_" } |
    Where-Object { -not (Test-Path (Join-Path $Root $_)) } | Select-Object -First 1
  (New-Item -ItemType Directory (Join-Path $Root $name)).FullName
}

function Invoke-Prepare {
  Lock-Root prepare
  try {
    Use-Node
    $branch = Get-Branch $ScriptRepo
    $slug = Get-Slug $branch
    $sha = git -C $ScriptRepo rev-parse HEAD
    $dirty = [bool](git -C $ScriptRepo status --porcelain)
    $label = "$branch@$($sha.Substring(0, 7))$(if ($dirty) { '+changes' }) $(Get-Date -Format HH:mm)"

    Lock-Root swap
    try { $staging = Select-Staging $slug } finally { Unlock-Root swap }
    Remove-Item (Join-Path $staging ".fork-build.json") -ErrorAction SilentlyContinue
    Sync-Source $ScriptRepo $staging
    Install-Deps $staging @("@t3tools/desktop", "t3")
    Write-Host "Building $label ..."
    $env:T3CODE_COMMIT_HASH = $sha
    Invoke-Native $staging { npx vp run build:desktop }
    Install-Electron $staging

    # Get-ChildItem does not follow junctions, so pnpm's links are not counted twice.
    $size = (Get-ChildItem $staging -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    @{
      label = $label; branch = $branch; commit = $sha; dirty = $dirty; source = $ScriptRepo
      builtAt = (Get-Date).ToUniversalTime().ToString("s") + "Z"; sizeBytes = [long]$size
    } | ConvertTo-Json -Compress | Set-Content (Join-Path $staging ".fork-build.json")

    Lock-Root swap
    try { Set-Link (Join-Path $BuildsDir $slug) $staging } finally { Unlock-Root swap }
    Write-Host "Prepared $label into builds\$slug. The app's update menu now offers it."
  } finally { Unlock-Root prepare }
}

# Deletes spare slots beyond one. Skipped while a prepare runs, since its
# staging slot is not linked yet.
function Remove-SpareSlots {
  $lock = Join-Path $Root ".prepare.lock"
  try { New-Item -ItemType Directory $lock -ErrorAction Stop | Out-Null } catch { return }
  try {
    $used = @(Get-UsedSlots)
    Get-Slots | Where-Object { $used -notcontains $_ } | Select-Object -Skip 1 | ForEach-Object {
      Write-Host "Removing spare build $_ ..."
      Remove-Tree $_
    }
  } finally { Remove-Item -Recurse -Force $lock -ErrorAction SilentlyContinue }
}

function Invoke-Restart([string]$Slug) {
  Lock-Root swap
  try {
    $build = $null
    if ($Slug) {
      Assert-Slug $Slug
      $build = Get-LinkTarget (Join-Path $BuildsDir $Slug)
      if (-not $build -or -not (Read-BuildInfo $build)) { throw "No build for $Slug in $BuildsDir." }
    }
    Stop-App
    if ($build) {
      $previous = Get-LinkTarget $CurrentLink
      Set-Link (Join-Path $BuildsDir $Slug) $null
      Set-Link $CurrentLink $build
      # The replaced build goes back to its branch, so the menu can return to
      # it, unless that branch has a newer build waiting; then it is spare.
      $info = if ($previous) { Read-BuildInfo $previous }
      if ($info) {
        $back = Join-Path $BuildsDir (Get-BuildSlug $info)
        if (-not (Test-Path $back)) { Set-Link $back $previous }
      }
    }
  } finally { Unlock-Root swap }
  Start-App
  Remove-SpareSlots
}

function Invoke-Delete([string]$Slug) {
  if (-not $Slug) { $Host.UI.WriteErrorLine("usage: delete <branch>"); exit 2 }
  Assert-Slug $Slug
  $link = Join-Path $BuildsDir $Slug
  Lock-Root swap
  try {
    $found = [bool](Get-LinkTarget $link)
    if ($found) { Set-Link $link $null }
  } finally { Unlock-Root swap }
  Remove-SpareSlots
  Write-Host $(if ($found) { "Removed the build of $Slug." } else { "No build of $Slug to remove." })
}

function Test-BuildContains([string]$Dir, [string]$Commit) {
  $built = (Read-BuildInfo $Dir)?.commit
  if (-not $built) { return $false }
  git -C $ScriptRepo merge-base --is-ancestor $Commit $built 2>$null
  $LASTEXITCODE -eq 0
}

# One pass: prepare the app for what was pushed to the fork branch, unless a
# build already has it. Builds from its own detached worktree, never from the
# working checkout.
function Invoke-Watch {
  git -C $ScriptRepo fetch --quiet origin $WatchBranch
  if ($LASTEXITCODE) { Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') fetch failed; trying again next pass"; return }
  $remote = git -C $ScriptRepo rev-parse "origin/$WatchBranch"
  $slug = Get-Slug $WatchBranch
  if ((Test-BuildContains (Join-Path $BuildsDir $slug) $remote) -or (Test-BuildContains $CurrentLink $remote)) { return }
  # A commit that failed to build waits half an hour before the next try.
  $failed = Join-Path $LogDir ".watch-failed-$slug"
  if ((Get-Content $failed -ErrorAction SilentlyContinue) -eq $remote -and
    (Get-Item $failed).LastWriteTime -gt (Get-Date).AddMinutes(-30)) { return }
  if (-not (Test-Path (Join-Path $WatchSource ".git"))) {
    Remove-Tree $WatchSource
    git -C $ScriptRepo worktree prune
    git -C $ScriptRepo worktree add --detach $WatchSource $remote | Out-Null
  }
  git -C $WatchSource checkout --detach --force $remote 2>&1 | Out-Null
  Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') origin/$WatchBranch is at $($remote.Substring(0, 7)); preparing ..."
  $env:T3CODE_FORK_REPO = $WatchSource
  $env:T3CODE_FORK_BUILD_BRANCH = $WatchBranch
  pwsh -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath prepare
  if ($LASTEXITCODE) {
    Set-Content $failed $remote
    Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') preparing $($remote.Substring(0, 7)) failed; next try in 30 minutes"
    exit 1
  }
  Remove-Item $failed -ErrorAction SilentlyContinue
}

# WScript.Shell cannot set a shortcut's AppUserModelID; IPropertyStore can.
function Set-ShortcutAppId([string]$Path, [string]$Id) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ShortcutAppId {
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    void GetCount(out uint count);
    void GetAt(uint index, out PropertyKey key);
    void GetValue(ref PropertyKey key, out PropVariant value);
    void SetValue(ref PropertyKey key, ref PropVariant value);
    void Commit();
  }
  [StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit, Size = 24)] struct PropVariant {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr value;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHGetPropertyStoreFromParsingName(string path, IntPtr bindCtx, int flags, ref Guid iid, out IPropertyStore store);
  public static void Set(string path, string id) {
    var iid = typeof(IPropertyStore).GUID;
    IPropertyStore store;
    SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 2 /* GPS_READWRITE */, ref iid, out store);
    var key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    var value = new PropVariant { vt = 31 /* VT_LPWSTR */, value = Marshal.StringToCoTaskMemUni(id) };
    try { store.SetValue(ref key, ref value); store.Commit(); }
    finally { Marshal.FreeCoTaskMem(value.value); Marshal.ReleaseComObject(store); }
  }
}
"@
  [ShortcutAppId]::Set($Path, $Id)
}

function New-Shortcuts {
  $shell = New-Object -ComObject WScript.Shell
  foreach ($dir in [Environment]::GetFolderPath("Programs"), [Environment]::GetFolderPath("Desktop")) {
    Remove-Item (Join-Path $dir "T3 Code Fork.lnk") -ErrorAction SilentlyContinue
    $path = Join-Path $dir "esveo code.lnk"
    $lnk = $shell.CreateShortcut($path)
    # A headless console keeps pwsh from flashing a terminal window.
    $lnk.TargetPath = Join-Path $env:SystemRoot "System32\conhost.exe"
    $lnk.Arguments = "--headless `"$((Get-Command pwsh).Source)`" -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" restart"
    $lnk.WorkingDirectory = $ScriptRepo
    $lnk.IconLocation = Join-Path $ScriptRepo "assets\prod\t3-black-windows.ico"
    $lnk.Save()
    Set-ShortcutAppId $path $AppUserModelId
    Write-Host "Created $path"
  }
}

function Show-Status {
  Write-Host "app:     $(if (@(Get-AppProcesses)) { 'running' } else { 'stopped' })"
  $current = Get-LinkTarget $CurrentLink
  Write-Host "current: $(if ($current) { (Read-BuildInfo $current).label } else { 'none' })"
  Get-ChildItem $BuildsDir -Force | ForEach-Object {
    Write-Host "build:   $($_.Name): $((Read-BuildInfo $_.FullName).label)"
  }
}

switch ($Command) {
  "prepare" { Invoke-Prepare }
  "restart" { Invoke-Restart $Arg }
  "delete" { Invoke-Delete $Arg }
  "watch" { Invoke-Watch }
  "start" { Stop-App; Start-App }
  "stop" { Stop-App }
  "status" { Show-Status }
  "shortcut" { New-Shortcuts }
  "open-url" { Open-Url }
  { $_ -in "prepare-server", "restart-service" } {
    $Host.UI.WriteErrorLine("$_ is macOS only; the Windows app uses the Mac's t3 service."); exit 2
  }
  default { $Host.UI.WriteErrorLine("usage: fork-app.ps1 prepare|restart [branch]|delete <branch>|watch|start|stop|status|shortcut"); exit 2 }
}

# FliggyClaim - 一键安装到 Chrome (Windows)
#
# 用法：在解压后的目录右键 install.ps1 → "用 PowerShell 运行"
#       或在 PowerShell 中执行 .\scripts\install.ps1
#
# 注意：Windows 默认禁止运行未签名脚本，可临时绕过：
#   PowerShell -ExecutionPolicy Bypass -File .\scripts\install.ps1

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
if (-not $Root) { $Root = (Resolve-Path "..").Path }
$Target = Join-Path $env:USERPROFILE ".fliggyclaim\extension"
$Launcher = Join-Path $env:USERPROFILE ".fliggyclaim\启动飞猪报销助手.cmd"

Write-Host "→ 安装扩展到 $Target"
New-Item -ItemType Directory -Force -Path $Target | Out-Null
Get-ChildItem $Target -Force | Remove-Item -Recurse -Force

foreach ($name in @("manifest.json","background","content","icons","lib","options","popup")) {
    Copy-Item -Recurse -Force (Join-Path $Root $name) $Target
}

# 探测 Chrome
$candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Google\Chrome Beta\Application\chrome.exe",
    "$env:LOCALAPPDATA\Chromium\Application\chrome.exe"
)
$chrome = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) {
    Write-Error "✗ 没有找到 Chrome。请先安装 Chrome 后再运行本脚本。"
    exit 1
}
Write-Host "→ 检测到 Chrome: $chrome"

# 写启动器 .cmd
$cmd = @"
@echo off
rem 由 FliggyClaim 安装脚本生成。运行本启动器会以加载报销助手扩展的方式打开 Chrome。
start "" "$chrome" --load-extension="$Target" %*
"@
Set-Content -Path $Launcher -Value $cmd -Encoding ASCII

Write-Host ""
Write-Host "✓ 安装完成"
Write-Host ""
Write-Host "下次直接双击启动："
Write-Host "    $Launcher"
Write-Host ""
Write-Host "或永久安装：在 chrome://extensions 打开开发者模式 → 「加载已解压的扩展程序」选择："
Write-Host "    $Target"
Write-Host ""

$ans = Read-Host "现在就启动 Chrome 加载扩展吗? [Y/n]"
if (-not $ans -or $ans -match "^[Yy]") {
    Write-Host "→ 正在启动 Chrome..."
    Start-Process $chrome -ArgumentList "--load-extension=`"$Target`""
}

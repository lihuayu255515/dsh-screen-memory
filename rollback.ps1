# dsh-screen-memory 一键回滚（Windows）
#
# 作用：把插件从 DSH profile 里摘干净（备份原文件），**不删你的截图数据**。
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\rollback.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\rollback.ps1 -Profile web
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\rollback.ps1 -PurgeData
param(
    [string]$Profile = 'web',
    [switch]$PurgeData
)

$ErrorActionPreference = 'Stop'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path $dshHome (Join-Path 'profiles' $Profile)
$pkgPath = Join-Path $profileDir 'package.json'

Write-Host "== dsh-screen-memory 回滚 =="
Write-Host "profile : $profileDir"

if (-not (Test-Path $pkgPath)) {
    Write-Host "!! 找不到 $pkgPath，可能 profile 名不对（用 -Profile <名字>）"
    exit 1
}

$json = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$changed = @()

if ($json.dependencies -and $json.dependencies.PSObject.Properties.Name -contains 'dsh-screen-memory') {
    $json.dependencies.PSObject.Properties.Remove('dsh-screen-memory')
    $changed += 'dependencies'
}

$bundles = $null
if ($json.dsh -and $json.dsh.profile -and $json.dsh.profile.bundles) {
    $bundles = @($json.dsh.profile.bundles)
    $filtered = @($bundles | Where-Object { $_ -ne 'dsh-screen-memory' })
    if ($filtered.Count -ne $bundles.Count) {
        $json.dsh.profile.bundles = $filtered
        $changed += 'dsh.profile.bundles'
    }
}

if ($changed.Count -eq 0) {
    Write-Host "没有在 package.json 里找到 dsh-screen-memory（可能已卸载）"
} else {
    # 只有真的要改才备份；备份名带秒，同一秒内重复执行会加序号，绝不覆盖
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$pkgPath.bak-screen-memory-$stamp"
    $n = 1
    while (Test-Path $backup) {
        $backup = "$pkgPath.bak-screen-memory-$stamp-$n"
        $n++
    }
    Copy-Item $pkgPath $backup -Force
    Write-Host "已备份 : $(Split-Path -Leaf $backup)"
    $json | ConvertTo-Json -Depth 20 | Set-Content $pkgPath -Encoding UTF8
    Write-Host "已移除 : $($changed -join ', ')"
}

if ($PurgeData) {
    $dataDir = Join-Path $dshHome 'storages\screen-memory'
    if (Test-Path $dataDir) {
        $size = (Get-ChildItem $dataDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
        Remove-Item $dataDir -Recurse -Force
        Write-Host ("已删除数据目录：$dataDir（约 {0:N1} MB）" -f ($size / 1MB))
    } else {
        Write-Host "数据目录本来就不存在：$dataDir"
    }
} else {
    $dataDir = Join-Path $dshHome 'storages\screen-memory'
    Write-Host "数据保留在：$dataDir（要删加 -PurgeData）"
}

Write-Host ""
Write-Host "完成。请重启 DSH 生效。"
Write-Host "如需重新安装：dsh plugin --profile $Profile add <包路径>"

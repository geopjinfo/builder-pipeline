# Mechanical file placement for the builder kit (Windows PowerShell 5.1+).
# Usage:  powershell -File builder\scripts\unpack.ps1 <claude-code|codex>   (from the TARGET repo root)
# Copies only; never overwrites an existing file. Filling PIPELINE_PROFILE.md and harness
# wiring stay on you / your agent — see builder\UNPACK.md.

param([Parameter(Mandatory = $true)][ValidateSet('claude-code', 'codex')][string]$Target)

$ErrorActionPreference = 'Stop'
$Kit = Join-Path $PSScriptRoot '..'

function Copy-KitFile([string]$Src, [string]$Dst) {
    if (Test-Path $Dst) { Write-Host "skip (exists): $Dst"; return }
    $dir = Split-Path $Dst -Parent
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
    Copy-Item $Src $Dst
    Write-Host "installed:     $Dst"
}

if ($Target -eq 'claude-code') {
    Get-ChildItem (Join-Path $Kit 'agents\*.md') | ForEach-Object {
        Copy-KitFile $_.FullName (Join-Path '.claude\agents' $_.Name)
    }
    foreach ($s in 'build-module-pipeline', 'scaffold-module', 'module-readiness-check', 'setup-builder') {
        Copy-KitFile (Join-Path $Kit "skills\$s.md") (Join-Path ".claude\skills\$s" 'SKILL.md')
    }
}
else {
    Get-ChildItem (Join-Path $Kit 'agents\*.md') | ForEach-Object {
        Copy-KitFile $_.FullName (Join-Path '.builder\personas' $_.Name)
    }
    Get-ChildItem (Join-Path $Kit 'skills\*.md') | ForEach-Object {
        Copy-KitFile $_.FullName (Join-Path '.builder\playbooks' $_.Name)
    }
}

Copy-KitFile (Join-Path $Kit 'templates\task-board.md')        'tasks\README.md'
Copy-KitFile (Join-Path $Kit 'templates\deferred-registry.md') 'DEFERRED_TASKS.md'
Copy-KitFile (Join-Path $Kit 'templates\module-brief.md')      'specs\module-brief.template.md'
Copy-KitFile (Join-Path $Kit 'PIPELINE_PROFILE.template.md')   'PIPELINE_PROFILE.md'

# Board tooling: the computed progress bar, its CI gate, and the rendered run board + watcher.
# Shipping the board RULES without these leaves both unenforceable — a typed bar is a claim nobody
# re-derives, and a page nobody re-renders is stale without saying so.
foreach ($f in 'board-progress.mjs','board-check-all.mjs','board-render.mjs','board-watch.mjs') {
    Copy-KitFile (Join-Path $Kit "scripts\$f") (Join-Path 'scripts' $f)
}
foreach ($f in 'board-rows.cjs','board-parse.cjs','run-log.cjs','transcript-usage.cjs','pricing.cjs','board-freshness.cjs') {
    Copy-KitFile (Join-Path $Kit "scripts\lib\$f") (Join-Path 'scripts\lib' $f)
}

if (-not (Test-Path '.gitignore') -or -not (Select-String -Path '.gitignore' -Pattern '^\.pipeline/$' -Quiet)) {
    Write-Host "note: add '.pipeline/' to .gitignore"
}
Write-Host 'done. Next: fill PIPELINE_PROFILE.md and finish the wiring steps in builder\UNPACK.md.'

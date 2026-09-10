# Mechanical file placement for the builder kit — the no-Node fallback (Windows PowerShell 5.1+).
# Usage:  powershell -File builder\scripts\unpack.ps1 <claude-code|codex>   (from the TARGET repo root)
# The scripts it installs need Node 18+ to run. `node builder/cli.js unpack` is the complete
# installer (agent frontmatter transform, hooks, skill references, experimental files); use this
# only where the CLI cannot run.
# Copies only; never overwrites an existing file. Filling PIPELINE_PROFILE.md and harness
# wiring stay on you / your agent — see builder\UNPACK.md.

param([Parameter(Mandatory = $true)][ValidateSet('claude-code', 'codex')][string]$Target)

$ErrorActionPreference = 'Stop'
$Kit = Join-Path $PSScriptRoot '..'

function Copy-KitFile([string]$Src, [string]$Dst) {
    if (Test-Path -LiteralPath $Dst) { Write-Host "skip (exists): $Dst"; return }
    $dir = Split-Path $Dst -Parent
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
    Copy-Item -LiteralPath $Src -Destination $Dst
    Write-Host "installed:     $Dst"
}

# Every file under <SrcDir>, recursively, to the same relative path under <DstDir>; copy-if-absent.
# -Exclude names top-level files of <SrcDir> to leave out.
function Copy-KitTree([string]$SrcDir, [string]$DstDir, [string[]]$Exclude = @()) {
    if (-not (Test-Path -LiteralPath $SrcDir)) { return }
    $root = (Resolve-Path -LiteralPath $SrcDir).Path.TrimEnd('\', '/')
    Get-ChildItem -LiteralPath $root -Recurse -File | Sort-Object FullName | ForEach-Object {
        $rel = $_.FullName.Substring($root.Length).TrimStart('\', '/')
        if ($Exclude -notcontains $rel) {
            Copy-KitFile $_.FullName (Join-Path $DstDir $rel)
        }
    }
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

# Scripts: the board tooling (computed progress bar, its CI gate, the rendered run board + watcher),
# the checkers, and every library they share. The whole tree is copied, not a hand-kept list: a list
# goes stale the moment a script gains a require, and the fallback then installs a board that cannot
# render. Shipping the board RULES without these leaves both unenforceable — a typed bar is a claim
# nobody re-derives, and a page nobody re-renders is stale without saying so.
Copy-KitTree (Join-Path $Kit 'scripts') 'scripts' @('unpack.sh', 'unpack.ps1')
# Contract-oracle adapters: the oracle script looks in scripts\oracles\.
Copy-KitTree (Join-Path $Kit 'oracles') 'scripts\oracles'

if (-not (Test-Path '.gitignore') -or -not (Select-String -Path '.gitignore' -Pattern '^\.pipeline/$' -Quiet)) {
    Write-Host "note: add '.pipeline/' to .gitignore"
}
Write-Host 'done. Next: fill PIPELINE_PROFILE.md and finish the wiring steps in builder\UNPACK.md.'

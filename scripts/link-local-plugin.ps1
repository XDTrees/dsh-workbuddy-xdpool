# Link the local dsh-workbuddy-xdpool working tree into the DSH desktop profile,
# so the installed plugin IS the checkout: rebuild the bundle and the running
# plugin sees the change, with no reinstall and no version bump.
#
# Why this is needed at all: the profile pins a published tarball
# (`dsh-workbuddy-xdpool@1.7.1` at the time of writing) which pnpm unpacks into
# a real directory. That copy never sees local edits, so code changes stayed
# invisible until a new version was published and installed.
#
# Re-run this after anything that reinstalls the plugin (the plugin manager, a
# `pnpm install` in the profile, a market update): those replace the junction
# with a fresh tarball copy and the local checkout stops being used.

$ErrorActionPreference = 'Stop'

$source = 'C:\Users\Admin\Desktop\cool\DSHP\dsh-workbuddy-xdpool'
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$target = Join-Path $profileDir 'node_modules\dsh-workbuddy-xdpool'
$backup = "$target.bak"

if (-not (Test-Path (Join-Path $source 'package.json'))) {
  throw "source checkout not found at $source"
}
if (-not (Test-Path (Join-Path $profileDir 'package.json'))) {
  throw "DSH profile not found at $profileDir"
}

# Verify the bundle the profile will actually load carries the latest source.
$libIndex = Join-Path $source 'lib\index.js'
if (-not (Test-Path $libIndex)) {
  Write-Warning "no built bundle at $libIndex - run 'pnpm run build' first or the plugin will fail to load"
}

$existing = Get-Item $target -Force -ErrorAction SilentlyContinue
if ($existing -ne $null -and $existing.LinkType -eq 'Junction') {
  $pointsAt = $existing.Target
  if ($pointsAt -eq $source) {
    Write-Host "already linked: $target -> $source"
    exit 0
  }
  Write-Host "junction points elsewhere ($pointsAt); replacing"
  Remove-Item $target -Force
}

# Preserve whatever is there now (the tarball copy) so this is reversible.
if ((Test-Path $target) -and -not (Test-Path $backup)) {
  Move-Item $target $backup
  Write-Host "backed up the packaged copy to $backup"
} elseif (Test-Path $target) {
  Remove-Item $target -Recurse -Force
}

New-Item -ItemType Junction -Path $target -Target $source | Out-Null
Write-Host "linked: $target -> $source"

$version = (Get-Content (Join-Path $source 'package.json') -Raw | ConvertFrom-Json).version
Write-Host "profile now loads dsh-workbuddy-xdpool v$version from the working tree"
Write-Host ''
Write-Host 'To pick up source changes: run `pnpm run watch` in the checkout (rebuilds lib/ on every save).'

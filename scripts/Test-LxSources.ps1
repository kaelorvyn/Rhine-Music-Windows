<#
  音源健康测试台 · 实时刷新
  用法：powershell -NoProfile -ExecutionPolicy Bypass -File "本文件路径"
  逐条显示：哪个音源正在测、哪些已完成、可用（绿）/死源（红），测完输出汇总。
#>
param(
  [string]$Repo = 'C:\Users\Administrator\Documents\Codex\project-0038-莱茵音乐增强\repo\Rhine-Music-Windows',
  [string]$Node = 'D:\nodejs\node.exe'
)
# ── 控制台统一 UTF-8 ────────────────────────────────────────────────
# node 输出的是 UTF-8；PowerShell 5.1 默认按 GBK(936) 解码子进程输出，
# 音源名和状态文字就会变成乱码。三处编码全部钉死成 UTF-8。
$ErrorActionPreference = 'Continue'
try {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [Console]::OutputEncoding = $utf8
  [Console]::InputEncoding = $utf8
  $script:OutputEncoding = $utf8
  $OutputEncoding = $utf8
  $env:PYTHONIOENCODING = 'utf-8'
} catch {}
if (-not (Test-Path $Node)) { $Node = 'node' }
Set-Location $Repo

$script:rows = @{}          # "file|source" -> row
$script:order = @()         # 保持登记顺序
$script:total = 0
$script:lastDraw = [DateTime]::MinValue
$script:finished = $false
$script:loadLine = '加载音源中…'

function Row-StateName($row) {
  switch ($row.State) {
    'run'   { '● 测试中' }
    'ok'    { '✓ 可用  ' }
    'dead'  { '✗ 死源  ' }
    'retry' { '… 重试  ' }
    default { '· 待测  ' }
  }
}

function Render([switch]$Force) {
  if (-not $Force -and ([DateTime]::Now - $script:lastDraw).TotalMilliseconds -lt 120) { return }
  $script:lastDraw = [DateTime]::Now
  $width = try { [Console]::WindowWidth - 1 } catch { 120 }
  if ($width -lt 60) { $width = 120 }
  $rows = @($script:order | ForEach-Object { $script:rows[$_] } | Where-Object { $_ })
  $done = @($rows | Where-Object { $_.State -in @('ok','dead') }).Count
  $okc  = @($rows | Where-Object { $_.State -eq 'ok' }).Count
  $deadc= @($rows | Where-Object { $_.State -eq 'dead' }).Count
  $runc = @($rows | Where-Object { $_.State -eq 'run' }).Count
  $wait = @($rows | Where-Object { $_.State -eq 'new' }).Count

  $lines = New-Object System.Collections.Generic.List[object]
  $lines.Add(@{ Text = ('═' * 12 + ' 莱茵音乐 · 音源健康测试台 ' + '═' * 12); Color = 'Cyan' })
  $lines.Add(@{ Text = ("进度 {0}/{1}   可用 {2}   死源 {3}   测试中 {4}   待测 {5}   {6}" -f $done, $script:total, $okc, $deadc, $runc, $wait, $script:loadLine); Color = 'White' })
  $lines.Add(@{ Text = ('状态      平台  结果                         耗时      音源'); Color = 'DarkGray' })
  $sorted = @($rows | Sort-Object -Property `
      @{ Expression = { @{ run = 0; ok = 1; dead = 2; retry = 3; new = 4 }[$_.State] } }, `
      @{ Expression = { $_.Name } }, `
      @{ Expression = { $_.Source } })
  foreach ($row in $sorted) {
    $detail = if ($row.State -eq 'ok') { ($row.Quality + ' ' + $row.Ms + 'ms') } elseif ($row.State -eq 'dead') { $row.Error } elseif ($row.State -eq 'run') { '尝试 ' + $row.Tier } elseif ($row.State -eq 'retry') { $row.Error } else { '' }
    $line = ('{0}  {1,-4}  {2,-28}  {3,-8}  {4}' -f (Row-StateName $row), $row.Source, $detail, $(if ($row.State -eq 'ok') { $row.Ms } else { '' }), $row.Name)
    $color = switch ($row.State) { 'ok' { 'Green' } 'dead' { 'Red' } 'run' { 'Yellow' } 'retry' { 'DarkYellow' } default { 'DarkGray' } }
    $lines.Add(@{ Text = $line; Color = $color })
  }
  try {
    $max = [Math]::Min($lines.Count, [Console]::WindowHeight - 1)
    for ($i = 0; $i -lt $max; $i++) {
      [Console]::SetCursorPosition(0, $i)
      [Console]::ForegroundColor = $lines[$i].Color
      $text = $lines[$i].Text
      if ($text.Length -ge $width) { $text = $text.Substring(0, $width) } else { $text = $text.PadRight($width) }
      [Console]::Write($text)
    }
    [Console]::ResetColor()
  } catch {
    $lines | ForEach-Object { Write-Host $_.Text -ForegroundColor $_.Color }
  }
}

Render -Force
& $Node 'scripts/lx-live-test.mjs' | ForEach-Object {
  $line = $_
  if (-not $line) { return }
  try { $ev = $line | ConvertFrom-Json } catch { return }
  switch ($ev.ev) {
    'load' { $script:loadLine = ('加载 {0}/{1}' -f $ev.ok, $ev.total) ; Render }
    'loadfail' { $script:loadLine = ('加载失败: ' + $ev.file) ; Render }
    'meta' {
      $k = $ev.file + '|' + $ev.source
      if (-not $script:rows.ContainsKey($k)) {
        $script:rows[$k] = [pscustomobject]@{ Key = $k; File = $ev.file; Name = $ev.name; Source = $ev.source; State = 'new'; Tier = ''; Ms = ''; Quality = ''; Error = '' }
        $script:order += $k
        $script:total++
      }
      Render
    }
    'start' {
      $k = $ev.file + '|' + $ev.source
      if ($script:rows.ContainsKey($k)) { $r = $script:rows[$k]; $r.State = 'run'; $r.Tier = [string]$ev.tier; Render }
    }
    'end' {
      $k = $ev.file + '|' + $ev.source
      if ($script:rows.ContainsKey($k)) {
        $r = $script:rows[$k]
        if ($ev.ok) { $r.State = 'ok'; $r.Quality = [string]$ev.tier; $r.Ms = [string]$ev.ms; $r.Error = '' }
        else { if ($r.State -ne 'ok') { $r.State = 'retry'; $r.Error = [string]$ev.error }; $r.Tier = [string]$ev.tier }
        Render
      }
    }
    'final' {
      foreach ($p in $ev.sources.PSObject.Properties) {
        $k = $ev.file + '|' + $p.Name
        if ($script:rows.ContainsKey($k)) {
          $r = $script:rows[$k]
          if ($p.Value.ok) { $r.State = 'ok'; $r.Quality = [string]$p.Value.quality; $r.Ms = [string]$p.Value.ms }
          else { $r.State = 'dead'; $r.Error = [string]$p.Value.error }
        }
      }
      Render -Force
    }
    'done' {
      $script:finished = $true
      try { [Console]::SetCursorPosition(0, 0) } catch {}
      Render -Force
      $y = try { [Console]::WindowHeight - 2 } catch { 0 }
      try { [Console]::SetCursorPosition(0, $y) } catch {}
      Write-Host ''
      Write-Host ('══ 完成：{0} 个文件，可用 {1}，死源 {2}，加载失败 {3}，用时 {4}s ══' -f $ev.total, $ev.alive, $ev.dead, $ev.failed, $ev.seconds) -ForegroundColor Cyan
      Write-Host ('报告：' + $ev.report) -ForegroundColor DarkGray
      Write-Host '关闭窗口或按 Ctrl+C 结束。' -ForegroundColor DarkGray
    }
  }
}
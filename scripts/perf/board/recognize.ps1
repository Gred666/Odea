# Experiment 4 (docs/白板.md): feed strokes to the Windows handwriting recognizers (Tablet PC COM API).
# In:  JSON file  { "items": [ { "text": "...", "strokes": [ [x0,y0,x1,y1,...], ... ] }, ... ] }  (ink units = 0.01 mm)
# Out: JSON file  [ { "recognizer": "...", "factoid": "...", "results": [ { "top": "...", "alts": [...] }, ... ] }, ... ]
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less script as ANSI.
param([string]$In, [string]$Out)

$data = Get-Content -Raw -Encoding UTF8 $In | ConvertFrom-Json
$recognizers = New-Object -ComObject msinkaut.InkRecognizers
$runs = @()

for ($r = 0; $r -lt $recognizers.Count; $r++) {
  $rec = $recognizers.Item($r)
  $langs = @($rec.Languages)
  if ($langs.Count -eq 0) { continue }          # the gesture recognizer
  $lang = '{0:x4}' -f $langs[0]
  if ($lang -eq '1009') { continue }            # en-CA: same engine as en-US
  foreach ($factoid in @('DEFAULT', 'NUMBER', 'DIGIT')) {
    $results = @()
    foreach ($item in $data.items) {
      $ink = New-Object -ComObject msinkaut.InkObject
      foreach ($stroke in $item.strokes) {
        # PowerShell's own COM binder hands the array over as VARIANT[] (E_INVALIDARG): go through reflection
        # so it stays int[], and pass null (not Type.Missing) for the packet description
        [int[]]$points = $stroke
        $call = New-Object object[] 2
        $call[0] = $points
        $call[1] = $null
        $null = [System.__ComObject].InvokeMember('CreateStroke', [Reflection.BindingFlags]::InvokeMethod, $null, $ink, $call)
      }
      $ctx = $rec.CreateRecognizerContext()
      if ($factoid -ne 'DEFAULT') { $ctx.Factoid = $factoid }
      # keep the collection in a variable: @($ink.Strokes) would unroll it into single strokes
      $strokes = $ink.Strokes
      $ctx.Strokes = $strokes
      $ctx.EndInkInput()
      $status = 0
      $top = ''
      $alts = @()
      try {
        $result = $ctx.Recognize([ref]$status)
        if ($result) {
          $top = $result.TopString
          $list = $result.AlternatesFromSelection(0, -1, 5)
          for ($a = 0; $a -lt $list.Count; $a++) { $alts += $list.Item($a).String }
        }
      } catch {
        $top = 'ERROR: ' + $_.Exception.Message
      }
      $results += [pscustomobject]@{ top = $top; alts = $alts }
    }
    $runs += [pscustomobject]@{ recognizer = $lang; factoid = $factoid; results = $results }
  }
}

$json = $runs | ConvertTo-Json -Depth 6 -Compress
[IO.File]::WriteAllText($Out, $json, (New-Object Text.UTF8Encoding($false)))

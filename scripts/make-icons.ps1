# Generates the Route Lens app icons into icons\.
# Dev-time only; the PNGs it produces are what ships.
#
#   powershell -ExecutionPolicy Bypass -File scripts\make-icons.ps1

Add-Type -AssemblyName System.Drawing

$root    = Split-Path -Parent $PSScriptRoot
$iconDir = Join-Path $root 'icons'
if (-not (Test-Path $iconDir)) { New-Item -ItemType Directory -Path $iconDir | Out-Null }

$bg     = [System.Drawing.Color]::FromArgb(255, 18, 18, 31)     # --bg
$accent = [System.Drawing.Color]::FromArgb(255, 108, 92, 231)   # --accent
$start  = [System.Drawing.Color]::FromArgb(255, 74, 222, 128)   # --ok
$finish = [System.Drawing.Color]::FromArgb(255, 255, 92, 138)   # --accent-2

function New-RouteLensIcon {
    param(
        [int]    $Size,
        [string] $OutPath,
        [double] $Inset = 0.0   # padding fraction, for maskable icons
    )

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    $g.Clear($bg)

    # Everything is drawn in a 512-unit space, then scaled.
    $scale = $Size / 512.0
    $pad   = 512.0 * $Inset
    $inner = 512.0 - (2 * $pad)
    $u     = { param($v) ($pad + ($v / 512.0) * $inner) * $scale }

    # The "lens": a ring, deliberately open at the ends of the route.
    $ringPen = New-Object System.Drawing.Pen($accent, (26 * $scale * ($inner / 512.0)))
    $r0 = & $u 96
    $r1 = & $u 416
    $g.DrawArc($ringPen, $r0, $r0, ($r1 - $r0), ($r1 - $r0), 35, 290)

    # The route: a winding path across the middle.
    $pathPen = New-Object System.Drawing.Pen($accent, (34 * $scale * ($inner / 512.0)))
    $pathPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pathPen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $pathPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    $pts = @(
        (New-Object System.Drawing.PointF((& $u 150), (& $u 340))),
        (New-Object System.Drawing.PointF((& $u 232), (& $u 246))),
        (New-Object System.Drawing.PointF((& $u 288), (& $u 292))),
        (New-Object System.Drawing.PointF((& $u 366), (& $u 178)))
    )
    $g.DrawCurve($pathPen, $pts, 0.55)

    # Start and end markers.
    $dot = 46.0 * $scale * ($inner / 512.0)
    $sb  = New-Object System.Drawing.SolidBrush($start)
    $fb  = New-Object System.Drawing.SolidBrush($finish)
    $g.FillEllipse($sb, ($pts[0].X - $dot / 2), ($pts[0].Y - $dot / 2), $dot, $dot)
    $g.FillEllipse($fb, ($pts[3].X - $dot / 2), ($pts[3].Y - $dot / 2), $dot, $dot)

    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)

    foreach ($d in @($ringPen, $pathPen, $sb, $fb, $g, $bmp)) { $d.Dispose() }
    Write-Host "wrote $OutPath"
}

New-RouteLensIcon -Size 512 -OutPath (Join-Path $iconDir 'icon-512.png')
New-RouteLensIcon -Size 192 -OutPath (Join-Path $iconDir 'icon-192.png')
New-RouteLensIcon -Size 180 -OutPath (Join-Path $iconDir 'apple-touch-icon.png')
New-RouteLensIcon -Size 32  -OutPath (Join-Path $iconDir 'favicon-32.png')
# Maskable icons get cropped to a circle on Android, so keep clear of the edge.
New-RouteLensIcon -Size 512 -OutPath (Join-Path $iconDir 'maskable-512.png') -Inset 0.14

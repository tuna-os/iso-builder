# Fake tunaos-media-helper for the unit tests and the UI smoke (`--fake-helper`).
# Speaks desktop/PROTOCOL.md v1 with canned data and never opens a disk: `write`
# only sleeps and reports progress. Runs under Windows PowerShell 5.1 and pwsh 7.
#
# Environment knobs (not inherited through a real UAC prompt, so the UI smoke only
# uses them for unelevated subcommands):
#   FAKE_HELPER_FAIL      catalog | build | write   make that subcommand fail
#   FAKE_HELPER_DELAY_MS  sleep per progress event (default 300, slow enough for screenshots)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8

$sub = if ($args.Count -gt 0) { [string]$args[0] } else { '' }
$opts = @{}
for ($i = 1; $i -lt $args.Count; $i++) {
    $a = [string]$args[$i]
    if (-not $a.StartsWith('--')) { continue }
    $name = $a.Substring(2)
    if ($i + 1 -lt $args.Count -and -not ([string]$args[$i + 1]).StartsWith('--')) {
        $opts[$name] = [string]$args[$i + 1]
        $i++
    } else {
        $opts[$name] = $true
    }
}

$fail = [string]$env:FAKE_HELPER_FAIL
$delay = if ($env:FAKE_HELPER_DELAY_MS) { [int]$env:FAKE_HELPER_DELAY_MS } else { 300 }

function Emit($obj) {
    $line = $obj | ConvertTo-Json -Compress -Depth 8
    if ($opts.ContainsKey('events')) {
        [IO.File]::AppendAllText($opts['events'], $line + "`n", $utf8)
    } else {
        [Console]::Out.WriteLine($line)
        [Console]::Out.Flush()
    }
}

function Fail([string]$kind, [string]$message) {
    Emit ([ordered]@{ event = 'error'; kind = $kind; message = $message })
    [Console]::Error.WriteLine("fake-helper: ${kind}: $message")
    exit 1
}

function Check-Cancel {
    if ($opts.ContainsKey('cancel-file') -and [IO.File]::Exists($opts['cancel-file'])) {
        Emit ([ordered]@{ event = 'error'; kind = 'cancelled'; message = 'Cancelled.' })
        exit 130
    }
}

function Phase([string]$phase, [string]$unit, [long]$total, [int]$steps, [string]$label) {
    for ($s = 1; $s -le $steps; $s++) {
        Check-Cancel
        [Threading.Thread]::Sleep($delay)
        Emit ([ordered]@{ event = 'progress'; phase = $phase; current = [long]($total * $s / $steps); total = $total; unit = $unit; message = "$label $s/$steps" })
    }
}

function Target([string]$base, [string]$desktop, [string]$platform = 'linux/amd64', [string]$edition = 'standard', [long]$size = 1625549436) {
    [ordered]@{
        id = "${base}:${desktop}:${platform}"; base = $base; desktop = $desktop; platform = $platform
        edition = $edition; hardware = 'generic'; image = "ghcr.io/tuna-os/${base}:${desktop}"
        compressedSize = $size; browserQualified = $false
    }
}

switch ($sub) {
    'version' {
        Emit ([ordered]@{ event = 'version'; helper = '0.0.0-fake'; engine = 'fake'; protocol = 1 })
    }
    'catalog' {
        if ($fail -eq 'catalog') { Fail 'network' 'Could not reach iso.tunaos.org and no offline copy is available.' }
        Emit ([ordered]@{ event = 'log'; level = 'info'; message = 'fake catalog' })
        Emit ([ordered]@{
            event = 'catalog'; snapshotDigest = 'sha256:fake'; defaultTarget = 'yellowfin:gnome:linux/amd64'
            desktops = @(
                [ordered]@{ id = 'gnome'; label = 'GNOME'; description = 'A clean, focused desktop with an app overview.' },
                [ordered]@{ id = 'kde'; label = 'KDE Plasma'; description = 'A familiar layout with a taskbar and lots of customization.' },
                [ordered]@{ id = 'cosmic'; label = 'COSMIC'; description = 'Flexible workspaces with optional window tiling.' },
                [ordered]@{ id = 'niri'; label = 'Niri'; description = 'A scrolling, keyboard-focused window layout.' },
                [ordered]@{ id = 'xfce'; label = 'XFCE'; description = 'A lightweight, traditional desktop.' }
            )
            bases = @(
                [ordered]@{ id = 'yellowfin'; label = 'AlmaLinux Kitten 10 (flagship)' },
                [ordered]@{ id = 'bonito'; label = 'Fedora 44' },
                [ordered]@{ id = 'skipjack'; label = 'CentOS Stream 10' }
            )
            targets = @(
                (Target 'yellowfin' 'gnome'), (Target 'bonito' 'gnome'), (Target 'skipjack' 'gnome'),
                (Target 'yellowfin' 'kde'), (Target 'bonito' 'kde'),
                (Target 'bonito' 'cosmic'), (Target 'bonito' 'niri'), (Target 'skipjack' 'xfce'),
                (Target 'yellowfin' 'gnome' 'linux/arm64'), (Target 'yellowfin' 'gnome' 'linux/amd64' 'hwe')
            )
        })
    }
    'drives' {
        Emit ([ordered]@{
            event = 'drives'
            drives = @(
                [ordered]@{ id = 'disk2:4C530001230618115104'; path = '\\.\PhysicalDrive2'; name = 'SanDisk Ultra'; sizeBytes = 15376318464; bus = 'usb'; removable = $true; mounted = @('E:\'); systemDisk = $false },
                [ordered]@{ id = 'disk3:0019E06B9C6BF2B1A0000035'; path = '\\.\PhysicalDrive3'; name = 'Kingston DataTraveler 3.0'; sizeBytes = 30943995904; bus = 'usb'; removable = $true; mounted = @(); systemDisk = $false }
            )
        })
    }
    'build' {
        if (-not $opts.ContainsKey('out')) { Emit ([ordered]@{ event = 'error'; kind = 'usage'; message = 'build needs --out' }); exit 2 }
        Phase 'download' 'bytes' 1625549436 6 'Downloading'
        if ($fail -eq 'build') { Fail 'storage' 'There is not enough free space on this computer: 25 GB needed, 3 GB available.' }
        Phase 'unpack' 'layers' 12 3 'Unpacking layer'
        Phase 'overlay' 'steps' 1 1 'Overlay'
        Phase 'erofs' 'bytes' 6000000000 3 'Packing'
        Phase 'esp' 'steps' 1 1 'Boot files'
        Phase 'iso' 'bytes' 2400000000 2 'Writing ISO'
        $out = [IO.Path]::GetFullPath($opts['out'])
        [IO.File]::WriteAllText($out, "FAKE TUNAOS ISO`n", $utf8)
        $digest = [Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes($out))
        $hash = [BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant()
        Emit ([ordered]@{ event = 'done'; path = $out; bytes = (New-Object IO.FileInfo $out).Length; sha256 = $hash })
    }
    'write' {
        if (-not $opts.ContainsKey('iso') -or -not $opts.ContainsKey('device')) { Emit ([ordered]@{ event = 'error'; kind = 'usage'; message = 'write needs --iso and --device' }); exit 2 }
        Phase 'write' 'bytes' 2400000000 8 'Writing'
        if ($fail -eq 'write') { Fail 'device-changed' 'The USB stick was unplugged while writing.' }
        if (-not $opts.ContainsKey('no-verify')) { Phase 'verify' 'bytes' 2400000000 5 'Verifying' }
        Emit ([ordered]@{ event = 'done'; device = $opts['device']; bytes = 2400000000; verified = (-not $opts.ContainsKey('no-verify')) })
    }
    default {
        Emit ([ordered]@{ event = 'error'; kind = 'usage'; message = "unknown subcommand '$sub'" })
        exit 2
    }
}
exit 0

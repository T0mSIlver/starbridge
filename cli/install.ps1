# Installs the starbridge CLI into ~\.local\bin from a GitHub Release, then runs `starbridge setup`.
#
#   irm https://starbridge.run/install.ps1 | iex
#
# starbridge.run serves this file from the deployed revision of main; each release also carries
# a copy as an asset. It is install.sh for Windows PowerShell 5.1 and PowerShell 7.
#
# It accepts the binary only if its hash is in SHA256SUMS and SHA256SUMS carries the release
# key's minisign signature, for STARBRIDGE_VERSION when that is set. Windows has no Ed25519
# check of its own, so it downloads minisign's official Windows build, pinned by its hash.
#
# STARBRIDGE_VERSION=1.2.3      a version other than the latest release
# STARBRIDGE_INSTALL_DIR=<dir>  instead of ~\.local\bin
# STARBRIDGE_NO_SETUP=1         install only
# STARBRIDGE_RELEASES_URL=<url> a mirror of https://github.com/T0mSIlver/starbridge/releases
# STARBRIDGE_MINISIGN=<path>    a minisign already installed, instead of the download

# A script block: under `iex` nothing it sets stays in the caller's session, and a failure throws
# rather than `exit`, which would close the caller's window.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  # The release key. Also in cli/minisign.pub, cli/install.sh, cli/src/release.ts and the README.
  $PubKey = 'RWRT+qMmByDpj/1KhL5yCxdzIkVgZ3NqTrlVIIvhrezr/38FgzBIen0F'
  # minisign 0.12 for Windows, checked against jedisct1's key RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3.
  $MinisignUrl = 'https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-win64.zip'
  $MinisignSha256 = '37b600344e20c19314b2e82813db2bfdcc408b77b876f7727889dbd46d539479'

  $Releases = if ($env:STARBRIDGE_RELEASES_URL) { $env:STARBRIDGE_RELEASES_URL } else { 'https://github.com/T0mSIlver/starbridge/releases' }
  $Dir = if ($env:STARBRIDGE_INSTALL_DIR) { $env:STARBRIDGE_INSTALL_DIR } else { Join-Path $HOME '.local\bin' }

  function Fail($why) { throw "starbridge install: $why" }

  $os = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
  $arch = switch ("$os") { 'X64' { 'x64' } 'Arm64' { 'arm64' } default { Fail "no build for $os; try npm i -g starbridge" } }
  $asset = "starbridge-windows-$arch.exe"
  $version = if ($env:STARBRIDGE_VERSION) { $env:STARBRIDGE_VERSION -replace '^v', '' }
  $base = if ($version) { "$Releases/download/v$version" } else { "$Releases/latest/download" }

  # Windows PowerShell 5.1 may not offer TLS 1.2 by default, which GitHub requires.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $tmp = Join-Path ([IO.Path]::GetTempPath()) "starbridge-$([guid]::NewGuid())"
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    function Get-File($url, $out) {
      try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out } catch { Fail "could not download ${url}: $($_.Exception.Message)" }
    }
    function Get-Sha256($path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }

    foreach ($f in 'SHA256SUMS', 'SHA256SUMS.minisig', $asset) { Get-File "$base/$f" (Join-Path $tmp $f) }

    $minisign = $env:STARBRIDGE_MINISIGN
    if (-not $minisign) {
      $zip = Join-Path $tmp 'minisign.zip'
      Get-File $MinisignUrl $zip
      if ((Get-Sha256 $zip) -ne $MinisignSha256) { Fail 'the minisign download does not match its pinned hash' }
      Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $tmp 'minisign')
      $cpu = if ($arch -eq 'arm64') { 'aarch64' } else { 'x86_64' }
      $minisign = Join-Path $tmp "minisign\minisign-win64\$cpu\minisign.exe"
    }

    # -Q prints the trusted comment, which names the version the signature is for. Windows
    # PowerShell turns a native command's stderr into an error that 'Stop' would throw.
    $ErrorActionPreference = 'Continue'
    $signed = & $minisign -VQ -P $PubKey -m (Join-Path $tmp 'SHA256SUMS') -x (Join-Path $tmp 'SHA256SUMS.minisig') 2>$null
    $ok = $LASTEXITCODE -eq 0
    $ErrorActionPreference = 'Stop'
    if (-not $ok) { Fail 'SHA256SUMS does not carry the release signature' }
    $signed = "$signed".Trim()
    if ($version -and $signed -ne "starbridge v$version") { Fail "SHA256SUMS is signed for `"$signed`", not starbridge v$version" }

    $want = $null
    foreach ($line in Get-Content -LiteralPath (Join-Path $tmp 'SHA256SUMS')) {
      if ($line -match '^([0-9a-f]{64}) [ *](.+)$' -and $Matches[2] -eq $asset) { $want = $Matches[1] }
    }
    if (-not $want) { Fail "SHA256SUMS lists no $asset" }
    if ((Get-Sha256 (Join-Path $tmp $asset)) -ne $want) { Fail "$asset does not match its hash in SHA256SUMS" }

    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    $exe = Join-Path $Dir 'starbridge.exe'
    $next = Join-Path $Dir '.starbridge.new'
    Move-Item -Force -LiteralPath (Join-Path $tmp $asset) -Destination $next
    # Windows replaces no running .exe, such as the agent's, but lets it be renamed.
    if (Test-Path -LiteralPath $exe) {
      Remove-Item -Force -LiteralPath "$exe.old" -ErrorAction SilentlyContinue
      Move-Item -Force -LiteralPath $exe -Destination "$exe.old"
    }
    Move-Item -LiteralPath $next -Destination $exe
    # PowerShell on Linux or macOS, where its tests run.
    if ($IsWindows -eq $false) { chmod 755 $exe }
    Remove-Item -Force -LiteralPath "$exe.old" -ErrorAction SilentlyContinue
    Write-Host "Installed $(& $exe --version) to $exe"
  } finally {
    Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
  }

  # The user's PATH, read and written unexpanded so its %VARIABLES% survive.
  $onPath = ($env:Path -split ';') -contains $Dir
  if (-not $onPath -and $IsWindows -ne $false) {
    $key = Get-Item -LiteralPath 'HKCU:\Environment'
    $userPath = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    if (($userPath -split ';') -notcontains $Dir) {
      $joined = (@($Dir) + @($userPath -split ';' | Where-Object { $_ })) -join ';'
      Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Value $joined -Type ExpandString
      # Setting any user variable through .NET tells open programs the environment changed.
      [Environment]::SetEnvironmentVariable('STARBRIDGE_INSTALL', '1', 'User')
      [Environment]::SetEnvironmentVariable('STARBRIDGE_INSTALL', $null, 'User')
      Write-Host "Added $Dir to your PATH; terminals opened from now on find starbridge."
    }
    $env:Path = "$Dir;$env:Path"
  } elseif (-not $onPath) {
    Write-Host "Add $Dir to your PATH."
  }

  if (-not $env:STARBRIDGE_NO_SETUP -and ((& $exe --help) -match '^  starbridge setup')) {
    & $exe setup
  }
}

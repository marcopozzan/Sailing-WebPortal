# =============================================================================
# Deploy Sailing Portal -> Azure App Service Linux Python 3.11
# =============================================================================
# Versione "robusta" riscritta da zero dopo i bug visti nei deploy precedenti:
#
# BUG #1 - Compress-Archive di PowerShell crea zip con backslash nei path.
#   Su Linux il filesystem NON interpreta '\' come separatore di cartelle:
#   tratta il backslash come parte del nome file. Risultato: 'static\index.html'
#   diventa UN file con quel nome letterale invece di una cartella 'static/'
#   con dentro 'index.html'.
#   FIX: uso .NET ZipFile API che genera path con '/'.
#
# BUG #2 - Oryx in modalita' "express build" mette tutto in output.tar.zst
#   e NON lo estrae sempre correttamente -> wwwroot resta con solo il tar
#   compresso e niente app.py.
#   FIX: forzo BUILD_FLAGS=UseExpressBuild=false in App Settings.
#
# BUG #3 - WARNING su stderr di az.exe causano NativeCommandError in PS.
#   FIX: $ErrorActionPreference=Continue + PSNativeCommandUseErrorActionPreference=false.
#
# BUG #4 - HTTP smoke test post-deploy puo' rispondere un'istanza vecchia.
#   FIX: verifica via Kudu VFS API che app.py e static/index.html siano
#   davvero sul filesystem.
#
# Cosa fa, in ordine:
#   1. Verifica az CLI + login
#   2. Verifica sorgenti (backend/app.py, frontend/index.html)
#   3. Verifica App Service esistente con runtime Python
#   4. Pre-flight App Settings: BUILD_FLAGS, ENABLE_ORYX_BUILD, SCM_DO_BUILD,
#      WEBSITES_PORT
#   5. Pre-flight Startup Command: deve essere "startup.sh"
#   6. Build zip:
#       - backend/* alla radice (app.py, requirements.txt, startup.sh, migrations)
#       - frontend/* dentro static/
#       - usa System.IO.Compression.ZipFile (slash corretti)
#   7. Verifica zip: app.py + static/index.html alla giusta posizione,
#      nessun backslash nei path
#   8. Deploy via "az webapp deploy --type zip --restart true"
#   9. Verifica post-deploy via Kudu VFS API
#  10. Smoke test HTTP su /health, /index.html, /
#
# Usage:
#   .\deploy.ps1                                  # legge deploy-config.ps1
#   .\deploy.ps1 -AppName mio-app -ResourceGroup mio-rg
#   .\deploy.ps1 -SkipPreflight                   # salta verifica App Settings
#   .\deploy.ps1 -SkipPostCheck                   # salta verifica Kudu API
# =============================================================================

[CmdletBinding()]
param(
    [string]$AppName,
    [string]$ResourceGroup,
    [switch]$SkipPreflight,
    [switch]$SkipPostCheck
)

# IMPORTANTE: az.exe scrive WARNING su stderr durante operazioni normali
# ("Initiating deployment", "Warming up Kudu", ecc). Con $ErrorActionPreference
# globale=Stop, PowerShell promuoverebbe quei warning a errori terminanti.
# Uso "Continue" e gestisco gli errori manualmente via $LASTEXITCODE.
$ErrorActionPreference = "Continue"
$WarningPreference = "Continue"

# PS 7.3+ ha una nuova feature che fa applicare $ErrorActionPreference
# anche ai comandi nativi. La disattivo. Su PS < 7.3 e' innocuo.
if ($null -ne (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue)) {
    $PSNativeCommandUseErrorActionPreference = $false
}

# -----------------------------------------------------------------------------
# Helpers di output
# -----------------------------------------------------------------------------
function Write-Step { param([string]$m) Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "    [OK] $m" -ForegroundColor Green }
function Write-Warn { param([string]$m) Write-Host "    [!]  $m" -ForegroundColor Yellow }
function Write-Err  { param([string]$m) Write-Host "    [X]  $m" -ForegroundColor Red }

# -----------------------------------------------------------------------------
# Path script
# -----------------------------------------------------------------------------
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $ScriptDir) {
    Write-Host "ERRORE: impossibile determinare la cartella dello script." -ForegroundColor Red
    exit 1
}

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------
$configFile = Join-Path $ScriptDir "deploy-config.ps1"
if (Test-Path $configFile) {
    . $configFile
}

# Default sensati
if (-not $RESOURCE_GROUP) { $RESOURCE_GROUP = "rg-sailing" }
if (-not $APP_NAME)       { $APP_NAME       = "sailingrace" }
if (-not $BACKEND_DIR)    { $BACKEND_DIR    = "..\backend" }
if (-not $FRONTEND_DIR)   { $FRONTEND_DIR   = "..\frontend" }

# Override CLI > config
if ($AppName)       { $APP_NAME       = $AppName }
if ($ResourceGroup) { $RESOURCE_GROUP = $ResourceGroup }

$backendPath  = Join-Path $ScriptDir $BACKEND_DIR
$frontendPath = Join-Path $ScriptDir $FRONTEND_DIR

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Sailing Portal Deploy" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Resource Group: $RESOURCE_GROUP"
Write-Host "  App Service:    $APP_NAME"
Write-Host "  Backend src:    $backendPath"
Write-Host "  Frontend src:   $frontendPath"
Write-Host ""

# =============================================================================
# STEP 1: AZ CLI + LOGIN
# =============================================================================
Write-Step "Verifica az CLI + login"

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    Write-Err "az CLI non trovato. Installa da: https://aka.ms/installazurecliwindows"
    exit 1
}

$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"
$accountJson = & az account show 2>&1
$accountExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP

if ($accountExit -ne 0) {
    Write-Host "    Non sei loggato. Lancio az login..." -ForegroundColor Yellow
    az login | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Err "Login fallito"; exit 1 }
    $accountJson = & az account show 2>&1
}
$account = $null
try {
    $jsonText = ($accountJson | Where-Object { $_ -is [string] }) -join "`n"
    $account = $jsonText | ConvertFrom-Json
} catch { }
if ($account) {
    Write-Ok "Loggato come: $($account.user.name)"
    Write-Host "    Subscription: $($account.name)"
}

# =============================================================================
# STEP 2: VERIFICA SORGENTI
# =============================================================================
Write-Step "Verifica sorgenti"

if (-not (Test-Path $backendPath)) {
    Write-Err "Cartella backend non trovata: $backendPath"
    exit 1
}
$appPyPath = Join-Path $backendPath "app.py"
if (-not (Test-Path $appPyPath)) {
    Write-Err "app.py non trovato in $backendPath"
    exit 1
}
if (-not (Test-Path (Join-Path $backendPath "requirements.txt"))) {
    Write-Err "requirements.txt non trovato"
    exit 1
}
Write-Ok "Backend OK"

if (-not (Test-Path $frontendPath)) {
    Write-Err "Cartella frontend non trovata: $frontendPath"
    exit 1
}
if (-not (Test-Path (Join-Path $frontendPath "index.html"))) {
    Write-Err "frontend/index.html non trovato"
    exit 1
}
Write-Ok "Frontend OK (index.html presente)"

# =============================================================================
# STEP 3: VERIFICA APP SERVICE
# =============================================================================
Write-Step "Verifica App Service: $APP_NAME"

$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"
$appJson = & az webapp show --name $APP_NAME --resource-group $RESOURCE_GROUP 2>&1
$appExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP

if ($appExit -ne 0) {
    Write-Err "App Service '$APP_NAME' non trovato in resource group '$RESOURCE_GROUP'"
    Write-Host "    Verifica nomi in deploy-config.ps1 oppure passa -AppName/-ResourceGroup"
    exit 1
}
$app = $null
try {
    $jsonText = ($appJson | Where-Object { $_ -is [string] }) -join "`n"
    $app = $jsonText | ConvertFrom-Json
} catch { }
if (-not $app) { Write-Err "Errore parse risposta az webapp show"; exit 1 }
Write-Ok "App Service trovato: state=$($app.state), runtime=$($app.siteConfig.linuxFxVersion)"

if ($app.siteConfig.linuxFxVersion -notmatch "PYTHON") {
    Write-Err "Runtime corrente '$($app.siteConfig.linuxFxVersion)' non e' Python"
    exit 1
}

# =============================================================================
# STEP 4: PRE-FLIGHT App Settings
# =============================================================================
if (-not $SkipPreflight) {
    Write-Step "Pre-flight: App Settings critiche"

    $settingsJson = & az webapp config appsettings list `
        --name $APP_NAME --resource-group $RESOURCE_GROUP 2>&1
    $settings = @{}
    try {
        $jsonText = ($settingsJson | Where-Object { $_ -is [string] }) -join "`n"
        ($jsonText | ConvertFrom-Json) | ForEach-Object { $settings[$_.name] = $_.value }
    } catch { }

    # Settings critiche per il deploy:
    # BUILD_FLAGS=UseExpressBuild=false -> Oryx NON crea output.tar.zst,
    #                                      estrae i file direttamente in wwwroot
    # SCM_DO_BUILD_DURING_DEPLOYMENT=true -> Oryx fa pip install
    # ENABLE_ORYX_BUILD=true -> abilita Oryx
    # WEBSITES_PORT=8000 -> deve coincidere col --bind di gunicorn
    $criticalSettings = [ordered]@{
        "BUILD_FLAGS"                    = "UseExpressBuild=false"
        "SCM_DO_BUILD_DURING_DEPLOYMENT" = "true"
        "ENABLE_ORYX_BUILD"              = "true"
        "WEBSITES_PORT"                  = "8000"
    }

    $needsUpdate = @()
    foreach ($k in $criticalSettings.Keys) {
        $expected = $criticalSettings[$k]
        $current = $settings[$k]
        if ($current -ne $expected) {
            $needsUpdate += "$k=$expected"
            Write-Warn "Setting '$k' = '$current' (atteso '$expected')"
        } else {
            Write-Ok "Setting '$k' = '$current'"
        }
    }

    if ($needsUpdate.Count -gt 0) {
        Write-Host "    Aggiorno settings..." -ForegroundColor Yellow
        az webapp config appsettings set `
            --name $APP_NAME --resource-group $RESOURCE_GROUP `
            --settings $needsUpdate | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "App Settings aggiornate"
        }
    }

    # Startup command: deve essere "startup.sh" (lo script nel backend)
    Write-Step "Pre-flight: Startup Command"
    $currentStartup = $app.siteConfig.appCommandLine
    $expectedStartup = "startup.sh"
    if ($currentStartup -ne $expectedStartup) {
        Write-Warn "Startup command corrente: '$currentStartup'"
        Write-Host "    Aggiorno a: '$expectedStartup'..."
        az webapp config set `
            --name $APP_NAME --resource-group $RESOURCE_GROUP `
            --startup-file $expectedStartup | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "Startup command aggiornato"
        }
    } else {
        Write-Ok "Startup command: '$currentStartup'"
    }
}

# =============================================================================
# STEP 5: BUILD ZIP
# =============================================================================
Write-Step "Build zip di deploy"

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$stagingDir = Join-Path $env:TEMP "sailing-stage-$timestamp"
$zipPath    = Join-Path $env:TEMP "sailing-deploy-$timestamp.zip"

if (Test-Path $stagingDir) { Remove-Item $stagingDir -Recurse -Force -ErrorAction SilentlyContinue }
if (Test-Path $zipPath)    { Remove-Item $zipPath    -Force -ErrorAction SilentlyContinue }

try {
    New-Item -ItemType Directory -Path $stagingDir -ErrorAction Stop | Out-Null

    # Copio backend/* alla radice dello staging (escludo cache e cartelle inutili)
    Get-ChildItem -Path $backendPath -Force | Where-Object {
        $_.Name -notin @("__pycache__", ".venv", ".env", "static")
    } | ForEach-Object {
        if ($_.PSIsContainer) {
            Copy-Item -Path $_.FullName -Destination $stagingDir -Recurse -Force -ErrorAction Stop
        } else {
            Copy-Item -Path $_.FullName -Destination $stagingDir -Force -ErrorAction Stop
        }
    }

    # Pulizia ricorsiva di __pycache__/.pyc (Copy-Item -Exclude non funziona ricorsivo)
    Get-ChildItem $stagingDir -Recurse -Force -Directory `
        | Where-Object { $_.Name -in @("__pycache__", ".venv") } `
        | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem $stagingDir -Recurse -Force -File `
        | Where-Object { $_.Extension -eq ".pyc" } `
        | Remove-Item -Force -ErrorAction SilentlyContinue

    # Copio frontend/* dentro static/
    $staticDir = Join-Path $stagingDir "static"
    New-Item -ItemType Directory -Path $staticDir -ErrorAction Stop | Out-Null
    Get-ChildItem -Path $frontendPath -Force | ForEach-Object {
        if ($_.PSIsContainer) {
            Copy-Item -Path $_.FullName -Destination $staticDir -Recurse -Force -ErrorAction Stop
        } else {
            Copy-Item -Path $_.FullName -Destination $staticDir -Force -ErrorAction Stop
        }
    }

    # Sanity check pre-zip
    if (-not (Test-Path (Join-Path $stagingDir "app.py"))) {
        Write-Err "app.py manca dallo staging"; exit 1
    }
    if (-not (Test-Path (Join-Path $stagingDir "static\index.html"))) {
        Write-Err "static/index.html manca dallo staging"; exit 1
    }
    Write-Ok "Staging OK"

    # CRITICO: zip con path normalizzati a '/' (no backslash su Linux!).
    # NOTA: ZipFile.CreateFromDirectory su Windows PowerShell 5.1 (.NET
    # Framework < 4.6.1) usa il separatore di sistema (= '\' su Windows)
    # invece di '/'. Risultato: zip illeggibili su Linux.
    # Soluzione: creo lo zip entry-by-entry, scrivendo '/' come separatore.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Add-Type -AssemblyName System.IO.Compression

    $zipStream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
    $archive = New-Object System.IO.Compression.ZipArchive(
        $zipStream,
        [System.IO.Compression.ZipArchiveMode]::Create
    )
    try {
        # Enumero tutti i file dello staging in modo ricorsivo
        $stagingFull = (Get-Item $stagingDir).FullName
        $files = Get-ChildItem -Path $stagingDir -Recurse -File -Force
        foreach ($file in $files) {
            # Calcolo path relativo allo staging, sostituendo \ con /
            $rel = $file.FullName.Substring($stagingFull.Length + 1) `
                       -replace '\\', '/'
            # Creo entry nel zip
            $entry = $archive.CreateEntry(
                $rel,
                [System.IO.Compression.CompressionLevel]::Optimal
            )
            $entryStream = $entry.Open()
            try {
                $fileStream = [System.IO.File]::OpenRead($file.FullName)
                try {
                    $fileStream.CopyTo($entryStream)
                } finally {
                    $fileStream.Dispose()
                }
            } finally {
                $entryStream.Dispose()
            }
        }
    } finally {
        $archive.Dispose()
        $zipStream.Dispose()
    }

    $zipSize = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
    Write-Ok "Zip creato: $zipPath ($zipSize KB)"

    Remove-Item $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
} catch {
    Write-Err "Errore creazione zip: $_"
    if (Test-Path $stagingDir) { Remove-Item $stagingDir -Recurse -Force -ErrorAction SilentlyContinue }
    exit 1
}

# =============================================================================
# STEP 6: VERIFICA CONTENUTO ZIP
# =============================================================================
Write-Step "Verifica contenuto zip"

Add-Type -AssemblyName System.IO.Compression
$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
$entries = @($zip.Entries | ForEach-Object { $_.FullName })
$zip.Dispose()

# Nessun backslash (problema noto Compress-Archive)
$hasBackslash = $entries | Where-Object { $_ -match "\\" }
if ($hasBackslash.Count -gt 0) {
    Write-Err "Lo zip contiene path con backslash. Esempi:"
    $hasBackslash | Select-Object -First 5 | ForEach-Object { Write-Host "      $_" }
    exit 1
}
Write-Ok "Path zip usano '/' (slash) - $($entries.Count) file totali"

# app.py + static/index.html nelle posizioni giuste
if (-not ($entries -contains "app.py")) {
    Write-Err "Lo zip non contiene 'app.py' alla radice"; exit 1
}
if (-not ($entries -contains "static/index.html")) {
    Write-Err "Lo zip non contiene 'static/index.html'"; exit 1
}
Write-Ok "app.py + static/index.html alla posizione corretta"

# =============================================================================
# STEP 7: DEPLOY
# =============================================================================
Write-Step "Deploy zip su App Service (puo' richiedere 2-5 minuti)"
Write-Host "    Oryx fara' pip install di pymssql, fastapi, uvicorn, ecc." -ForegroundColor DarkGray

$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"
try {
    $deployOut = & az webapp deploy `
        --resource-group $RESOURCE_GROUP `
        --name $APP_NAME `
        --src-path $zipPath `
        --type zip `
        --restart true `
        --async false 2>&1 | Out-String
    $deployExit = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $prevEAP
}

Write-Host $deployOut

if ($deployExit -ne 0) {
    Write-Err "Deploy fallito (exit $deployExit)"
    Write-Host ""
    Write-Host "  Diagnostica:" -ForegroundColor Yellow
    Write-Host "    1. https://$APP_NAME.scm.azurewebsites.net/api/deployments/latest"
    Write-Host "    2. az webapp log tail -n $APP_NAME -g $RESOURCE_GROUP"
    Write-Host "    3. az webapp ssh -n $APP_NAME -g $RESOURCE_GROUP"
    Write-Host ""
    Write-Host "  Zip mantenuto in: $zipPath"
    exit 1
}
Write-Ok "Deploy completato"

# =============================================================================
# STEP 8: VERIFICA POST-DEPLOY VIA KUDU API
# =============================================================================
if (-not $SkipPostCheck) {
    Write-Step "Verifica post-deploy: file su /home/site/wwwroot"

    Write-Host "    Attendo 30s per estrazione Oryx..."
    Start-Sleep -Seconds 30

    $kuduBase = "https://$APP_NAME.scm.azurewebsites.net/api/vfs"

    # Token AAD per Kudu
    $tokenJson = & az account get-access-token --resource "https://management.core.windows.net/" 2>&1
    $token = $null
    try {
        $jsonText = ($tokenJson | Where-Object { $_ -is [string] }) -join "`n"
        $token = ($jsonText | ConvertFrom-Json).accessToken
    } catch { }

    if (-not $token) {
        Write-Warn "Impossibile ottenere token AAD per Kudu, salto verifica"
    } else {
        $headers = @{ Authorization = "Bearer $token" }
        $allOk = $true

        # Verifica app.py
        try {
            $r = Invoke-WebRequest -Uri "$kuduBase/site/wwwroot/app.py" `
                -Method Head -Headers $headers -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
            Write-Ok "app.py PRESENTE in /home/site/wwwroot"
        } catch {
            Write-Err "app.py NON trovato in wwwroot"
            Write-Host "       Probabile: Oryx non ha estratto il deploy"
            Write-Host "       Vedi anche: az webapp log tail"
            $allOk = $false
        }

        # Verifica static/index.html
        try {
            $r = Invoke-WebRequest -Uri "$kuduBase/site/wwwroot/static/index.html" `
                -Method Head -Headers $headers -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
            Write-Ok "static/index.html PRESENTE"
        } catch {
            Write-Err "static/index.html NON trovato"
            $allOk = $false
        }

        # Verifica che NON ci sia output.tar.zst (sintomo del bug Oryx)
        try {
            $r = Invoke-WebRequest -Uri "$kuduBase/site/wwwroot/output.tar.zst" `
                -Method Head -Headers $headers -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
            Write-Warn "output.tar.zst PRESENTE (sintomo: Oryx non ha estratto)"
            Write-Host "       Fix: az webapp ssh + estrazione manuale"
            $allOk = $false
        } catch {
            # 404 = good (non c'e' tar.zst, file estratti correttamente)
        }

        if (-not $allOk) {
            Write-Host ""
            Write-Host "  Per diagnosticare:" -ForegroundColor Yellow
            Write-Host "    az webapp ssh -n $APP_NAME -g $RESOURCE_GROUP"
            Write-Host "    > ls -la /home/site/wwwroot/"
        }
    }
}

# =============================================================================
# STEP 9: SMOKE TEST HTTP
# =============================================================================
Write-Step "Smoke test HTTP"
$appUrl = "https://$APP_NAME.azurewebsites.net"
$endpoints = @(
    @{Url = "$appUrl/health";     Name = "/health"}
    @{Url = "$appUrl/index.html"; Name = "/index.html"}
    @{Url = "$appUrl/";           Name = "/"}
)
foreach ($ep in $endpoints) {
    $tries = 0; $maxTries = 6; $delay = 10
    $done = $false
    while ($tries -lt $maxTries -and -not $done) {
        $tries++
        try {
            $r = Invoke-WebRequest -Uri $ep.Url -Method GET `
                -TimeoutSec 30 -ErrorAction Stop -UseBasicParsing
            if ($r.StatusCode -eq 200) {
                Write-Ok "$($ep.Name) HTTP 200"
            } else {
                Write-Warn "$($ep.Name) HTTP $($r.StatusCode)"
            }
            $done = $true
        } catch {
            if ($tries -eq $maxTries) {
                Write-Warn "$($ep.Name) non risponde"
            } else {
                Start-Sleep -Seconds $delay
            }
        }
    }
}

Remove-Item $zipPath -Force -ErrorAction SilentlyContinue

# =============================================================================
# RIEPILOGO
# =============================================================================
Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  FATTO" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Apri: $appUrl" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Diagnostica:"
Write-Host "    az webapp log tail -n $APP_NAME -g $RESOURCE_GROUP"
Write-Host "    az webapp ssh -n $APP_NAME -g $RESOURCE_GROUP"
Write-Host "    az webapp restart -n $APP_NAME -g $RESOURCE_GROUP"
Write-Host ""

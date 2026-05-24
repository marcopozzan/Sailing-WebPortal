# =============================================================================
# Fix Stuck Deploy - sistema un'App Service che ha output.tar.zst non estratto
# =============================================================================
# Quando Oryx mette il deploy in output.tar.zst e poi NON lo estrae in wwwroot,
# il container finisce per girare senza app.py e il portale risponde
# {"detail":"Not Found"} su /.
#
# Questo script:
#   1. Verifica via Kudu API se output.tar.zst e' presente in wwwroot
#   2. Se si', si collega via SSH al container e:
#       - Sposta output.tar.zst fuori
#       - Estrae il tar dentro wwwroot
#       - Rimuove residui
#   3. Restart App Service
#   4. Verifica HTTP
#
# Usage:
#   .\fix-stuck-deploy.ps1
# =============================================================================

[CmdletBinding()]
param(
    [string]$AppName,
    [string]$ResourceGroup
)

$ErrorActionPreference = "Continue"
if ($null -ne (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue)) {
    $PSNativeCommandUseErrorActionPreference = $false
}

function Write-Step { param([string]$m) Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "    [OK] $m" -ForegroundColor Green }
function Write-Warn { param([string]$m) Write-Host "    [!]  $m" -ForegroundColor Yellow }
function Write-Err  { param([string]$m) Write-Host "    [X]  $m" -ForegroundColor Red }

# Config
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$configFile = Join-Path $ScriptDir "deploy-config.ps1"
if (Test-Path $configFile) { . $configFile }
if ($AppName)       { $APP_NAME       = $AppName }
if ($ResourceGroup) { $RESOURCE_GROUP = $ResourceGroup }
if (-not $APP_NAME)       { $APP_NAME       = "sailingrace" }
if (-not $RESOURCE_GROUP) { $RESOURCE_GROUP = "rg-sailing" }

Write-Host ""
Write-Host "  Fix stuck deploy: $APP_NAME (RG: $RESOURCE_GROUP)" -ForegroundColor Cyan
Write-Host ""

# =============================================================================
# STEP 1: VERIFICA STATO ATTUALE VIA KUDU API
# =============================================================================
Write-Step "Verifica stato attuale wwwroot"

$kuduBase = "https://$APP_NAME.scm.azurewebsites.net/api/vfs"
$tokenJson = & az account get-access-token --resource "https://management.core.windows.net/" 2>&1
$token = $null
try {
    $jsonText = ($tokenJson | Where-Object { $_ -is [string] }) -join "`n"
    $token = ($jsonText | ConvertFrom-Json).accessToken
} catch { }

if (-not $token) {
    Write-Err "Impossibile ottenere token AAD per Kudu. Lancia 'az login' prima."
    exit 1
}

$headers = @{ Authorization = "Bearer $token" }
$hasAppPy = $false
$hasTarZst = $false

try {
    Invoke-WebRequest -Uri "$kuduBase/site/wwwroot/app.py" `
        -Method Head -Headers $headers -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop | Out-Null
    $hasAppPy = $true
    Write-Ok "app.py presente"
} catch { Write-Warn "app.py NON presente" }

try {
    Invoke-WebRequest -Uri "$kuduBase/site/wwwroot/output.tar.zst" `
        -Method Head -Headers $headers -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop | Out-Null
    $hasTarZst = $true
    Write-Warn "output.tar.zst PRESENTE (deploy bloccato)"
} catch { Write-Ok "output.tar.zst non presente (buon segno)" }

if ($hasAppPy -and -not $hasTarZst) {
    Write-Host ""
    Write-Ok "Lo stato e' gia' pulito. Nulla da fare."
    Write-Host ""
    exit 0
}

# =============================================================================
# STEP 2: ESTRAI TAR.ZST VIA SSH
# =============================================================================
Write-Step "Estrazione manuale del tar.zst"

if (-not $hasTarZst) {
    Write-Err "output.tar.zst non c'e' ma manca anche app.py. Strano stato."
    Write-Host "       Lancia .\deploy.ps1 per ridepoloyare da zero."
    exit 1
}

Write-Host "    Eseguo i comandi via SSH..."
Write-Host ""

# Costruisco lo script bash da eseguire via SSH
$bashCmd = @'
set -e
cd /home/site/wwwroot
echo "=== Stato iniziale ==="
ls -la
echo ""
echo "=== Sposto tar fuori ==="
mv output.tar.zst /tmp/output.tar.zst
echo ""
echo "=== Decompressione zstd ==="
zstd -d /tmp/output.tar.zst -o /tmp/output.tar
echo ""
echo "=== Estrazione tar in wwwroot ==="
tar -xf /tmp/output.tar -C /home/site/wwwroot/
echo ""
echo "=== Pulizia temp ==="
rm -f /tmp/output.tar /tmp/output.tar.zst
[ -d /home/site/wwwroot/extracted ] && rm -rf /home/site/wwwroot/extracted
echo ""
echo "=== Stato finale ==="
ls -la
echo ""
echo "=== Verifica app.py + static ==="
[ -f app.py ] && echo "app.py OK" || echo "app.py MISSING"
[ -f static/index.html ] && echo "static/index.html OK" || echo "static/index.html MISSING"
'@

# az webapp ssh non accetta script in input (solo modalita' interattiva).
# Uso "az webapp create-remote-connection" + ssh client, oppure semplicemente
# istruisco l'utente a fare i comandi manualmente.
Write-Host "  ATTENZIONE: az webapp ssh non puo' essere automatizzato." -ForegroundColor Yellow
Write-Host "  Apri SSH manualmente in un terminale separato e copia/incolla questi comandi:" -ForegroundColor Yellow
Write-Host ""
Write-Host "    az webapp ssh -n $APP_NAME -g $RESOURCE_GROUP" -ForegroundColor White
Write-Host ""
Write-Host "  Una volta dentro la SSH, copia/incolla:" -ForegroundColor Yellow
Write-Host "  ----------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host $bashCmd -ForegroundColor White
Write-Host "  ----------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Una volta finito (vedi 'app.py OK' + 'static/index.html OK')," -ForegroundColor Yellow
Write-Host "  digita 'exit' per uscire dalla SSH e torna qui." -ForegroundColor Yellow
Write-Host ""
$resp = Read-Host "Hai eseguito i comandi? [s/N]"
if ($resp -notmatch '^[sS]') {
    Write-Host "Annullato. Quando vuoi rilancia: .\fix-stuck-deploy.ps1" -ForegroundColor Yellow
    exit 0
}

# =============================================================================
# STEP 3: RESTART
# =============================================================================
Write-Step "Restart App Service"
az webapp restart --name $APP_NAME --resource-group $RESOURCE_GROUP | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Ok "Restart inviato"
}

# =============================================================================
# STEP 4: VERIFICA HTTP
# =============================================================================
Write-Step "Smoke test HTTP (attesa 60s per restart)"
Start-Sleep -Seconds 60

$appUrl = "https://$APP_NAME.azurewebsites.net"
foreach ($path in @("/health", "/index.html", "/")) {
    try {
        $r = Invoke-WebRequest -Uri "$appUrl$path" -Method GET `
            -TimeoutSec 30 -ErrorAction Stop -UseBasicParsing
        Write-Ok "$path HTTP $($r.StatusCode)"
    } catch {
        Write-Warn "$path non risponde ancora"
    }
}

Write-Host ""
Write-Host "  Se vedi 200 su tutti, apri: $appUrl" -ForegroundColor Cyan
Write-Host ""

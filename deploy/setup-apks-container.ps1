# =============================================================================
# Setup container 'apks' su Azure Blob Storage
# =============================================================================
# Crea il container per il sideloading APK con:
#   - public-access: blob (chiunque puo' scaricare via URL pubblico)
#   - upload SOLO via SAS URL generato dal backend con admin token
#
# Da lanciare una sola volta dopo aver fatto deploy del codice backend.
# Idempotente: se il container esiste gia', nessun errore.
#
# Usage:
#   .\setup-apks-container.ps1 -StorageAccount <nome> [-ContainerName apks]
# =============================================================================

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$StorageAccount,
    [string]$ContainerName = "apks"
)

$ErrorActionPreference = "Continue"
if ($null -ne (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue)) {
    $PSNativeCommandUseErrorActionPreference = $false
}

function Write-Step { param([string]$m) Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "    [OK] $m" -ForegroundColor Green }
function Write-Warn { param([string]$m) Write-Host "    [!]  $m" -ForegroundColor Yellow }
function Write-Err  { param([string]$m) Write-Host "    [X]  $m" -ForegroundColor Red }

Write-Step "Setup container '$ContainerName' su storage '$StorageAccount'"

# Verifica login
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"
$null = & az account show 2>&1
$loginExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
if ($loginExit -ne 0) {
    Write-Err "Non sei loggato. Lancia 'az login' prima."
    exit 1
}

# Prendi la storage key
$key = az storage account keys list `
    --account-name $StorageAccount `
    --query "[0].value" -o tsv 2>$null
if (-not $key) {
    Write-Err "Impossibile leggere chiave per storage '$StorageAccount'. Verifica nome e permessi."
    exit 1
}
Write-Ok "Chiave storage recuperata"

# Verifica se container esiste
$exists = az storage container exists `
    --account-name $StorageAccount `
    --account-key $key `
    --name $ContainerName `
    --query "exists" -o tsv 2>$null

if ($exists -eq "true") {
    Write-Warn "Container '$ContainerName' esiste gia', riuso"
} else {
    az storage container create `
        --account-name $StorageAccount `
        --account-key $key `
        --name $ContainerName `
        --public-access blob | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "Container '$ContainerName' creato (public-access: blob)"
    } else {
        Write-Err "Creazione container fallita"
        exit 1
    }
}

# Verifica/imposta public-access su blob (anonymous read sui blob,
# nessuna listazione anonima)
$accessLevel = az storage container show `
    --account-name $StorageAccount `
    --account-key $key `
    --name $ContainerName `
    --query "properties.publicAccess" -o tsv 2>$null

if ($accessLevel -ne "blob") {
    az storage container set-permission `
        --account-name $StorageAccount `
        --account-key $key `
        --name $ContainerName `
        --public-access blob | Out-Null
    Write-Ok "Public access impostato a 'blob' (download pubblico per URL diretto)"
} else {
    Write-Ok "Public access gia configurato (blob)"
}

$publicUrl = "https://$StorageAccount.blob.core.windows.net/$ContainerName/"
Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  SETUP COMPLETATO" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Container URL pubblico:" -ForegroundColor White
Write-Host "    $publicUrl" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Configurazione App Service da verificare:"
Write-Host "    AZURE_BLOB_CONTAINER_APKS = $ContainerName"
Write-Host ""
Write-Host "  Verifica:"
Write-Host "    az webapp config appsettings list --name <app> -g <rg> \``"
Write-Host "      --query `"[?name=='AZURE_BLOB_CONTAINER_APKS']`" -o table"
Write-Host ""
Write-Host "  Se la variabile manca, aggiungi:"
Write-Host "    az webapp config appsettings set --name <app> -g <rg> \``"
Write-Host "      --settings AZURE_BLOB_CONTAINER_APKS=$ContainerName"
Write-Host ""
Write-Host "  Apri la pagina nel portale:"
Write-Host "    https://<app>.azurewebsites.net/apk.html"
Write-Host ""

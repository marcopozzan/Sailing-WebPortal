# =============================================================================
# Configurazione deploy - Sailing Portal
# =============================================================================
# Questi nomi devono corrispondere alle risorse Azure esistenti.
# deploy.ps1 importa questo file con: . .\deploy-config.ps1
# =============================================================================

# --- Risorse Azure ---
$RESOURCE_GROUP = "rg-sailing"
$APP_NAME       = "sailingrace"

# --- Path sorgenti (relativi a questa cartella deploy/) ---
$BACKEND_DIR  = "..\backend"
$FRONTEND_DIR = "..\frontend"

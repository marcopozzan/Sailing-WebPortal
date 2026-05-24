// =============================================================================
// Configurazione runtime del frontend
// =============================================================================
// Backend e frontend sono ospitati sullo stesso App Service: il frontend e'
// servito come file statici dalla cartella backend/static/ via FastAPI
// StaticFiles, e gli endpoint API stanno sullo stesso dominio in /api/*.
// Quindi API_BASE e' vuoto: le chiamate sono relative al dominio corrente.
// Questo elimina anche il problema CORS (stesso origin).
//
// Per puntare a un backend remoto (es. dev locale verso staging), imposta
// window.SAILING_API_BASE a un URL completo (es. 'https://sailing-api-xxx.azurewebsites.net').
window.SAILING_API_BASE = '';

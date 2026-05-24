/**
 * auth.js - STUB DI COMPATIBILITÀ
 *
 * Il portale è ora PUBBLICO: niente login utente, niente JWT, niente bcrypt.
 * Questo file resta solo come shim retrocompatibile per non dover modificare
 * tutti i punti del frontend che chiamano window.SailingAuth.* (sono ~23
 * chiamate sparse su 7 file).
 *
 * API esposta (immutata):
 *   - getToken()            → null (sito pubblico, niente token utente)
 *   - getCurrentUser()      → null
 *   - isLoggedIn()          → true (per non far scattare flow di login disabilitato)
 *   - login(...)            → throw (non disponibile)
 *   - logout()              → no-op
 *   - authFetch(url, opts)  → wrapper trasparente attorno a fetch()
 *                              (NIENTE Authorization header, sito pubblico)
 *   - showLoginIfNeeded()   → no-op
 *   - wireLoginForm()       → no-op
 *   - refreshUser()         → Promise<null>
 *
 * NOTA: gli endpoint admin (/api/admin/*) NON passano da authFetch:
 * boatconfig.js e jsoneditor.js inviano direttamente l'header X-Admin-Token
 * letto da localStorage('sailing_admin_token'). Quel flusso è invariato.
 */
(function () {
    'use strict';

    // Sito pubblico: niente token utente.
    function getToken()        { return null; }
    function getCurrentUser()  { return null; }
    function isLoggedIn()      { return true; }  // true per non triggerare login screen

    function login(_u, _p) {
        return Promise.reject(new Error(
            'Login utente disabilitato: portale pubblico'));
    }

    function logout() { /* no-op */ }

    /** Wrapper trasparente: niente Authorization header.
     *  Mantiene la stessa firma di prima per compatibilità. */
    async function authFetch(url, opts) {
        return fetch(url, opts || {});
    }

    function refreshUser() { return Promise.resolve(null); }

    /** Login screen: nasconde se per qualche motivo è ancora nel DOM. */
    function showLoginIfNeeded() {
        const ls = document.getElementById('login-screen');
        if (ls) ls.style.display = 'none';
        // Mostra l'app principale (se in HTML c'era display:none in attesa di login)
        const main = document.getElementById('app-main');
        if (main) main.style.display = '';
        // Nasconde lo slot info utente nell'header (se presente)
        const userSlot = document.getElementById('user-info-slot');
        if (userSlot) userSlot.style.display = 'none';
    }

    function wireLoginForm() { /* no-op */ }

    // Esporto la stessa interfaccia di prima
    window.SailingAuth = {
        getToken: getToken,
        getCurrentUser: getCurrentUser,
        isLoggedIn: isLoggedIn,
        login: login,
        logout: logout,
        authFetch: authFetch,
        refreshUser: refreshUser,
        showLoginIfNeeded: showLoginIfNeeded,
        wireLoginForm: wireLoginForm,
    };
})();

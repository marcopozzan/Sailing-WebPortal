/**
 * Sailing Cloud - Navigation router.
 *
 * Gestisce lo switch tra le 4 schermate principali (Live, Replay, Polari, WPT)
 * e l'overlay Config. Espone window.SailingNav.show(name) per attivare una
 * schermata da qualunque punto del codice.
 *
 * Le schermate emettono eventi su window quando attivate, cosi' i moduli
 * (app.js, replay.js, polarview.js, wptview.js) possono rispondere e
 * fare lazy-init senza appesantire il caricamento iniziale.
 */
(function() {
    const SCREENS = ['live', 'replay', 'polar', 'waypoints', 'weather'];
    let currentScreen = 'live';

    function show(name) {
        // Log diagnostico per debug. Resta in produzione: aiuta a capire
        // problemi di routing senza fare cambi al codice.
        console.log('[nav] show:', name);
        if (!SCREENS.includes(name)) {
            console.error('[nav] Schermata non riconosciuta:', name,
                '— SCREENS = ', SCREENS);
            return;
        }
        const el = document.getElementById('screen-' + name);
        if (!el) {
            console.error('[nav] Elemento DOM #screen-' + name + ' non trovato. ' +
                'Probabile cache browser: fai Ctrl+Shift+R.');
            return;
        }
        SCREENS.forEach(s => {
            const e = document.getElementById('screen-' + s);
            if (e) e.classList.toggle('active', s === name);
        });
        document.querySelectorAll('.nav-btn[data-screen]').forEach(b => {
            b.classList.toggle('active', b.dataset.screen === name);
        });
        currentScreen = name;
        // Emetto evento custom per chi vuole inizializzarsi al volo
        window.dispatchEvent(new CustomEvent('screenChanged', {
            detail: { name }
        }));
    }

    function getCurrent() {
        return currentScreen;
    }

    // -------------------------------------------------------------------
    // Boot
    // -------------------------------------------------------------------
    document.addEventListener('DOMContentLoaded', () => {
        // Sanity check: ogni schermata deve avere il suo <section id="screen-X">.
        // Se manca, vuol dire che il browser sta servendo HTML cachato (non
        // aggiornato). Lo segnalo a console cosi' l'utente sa che deve fare
        // hard reload (Ctrl+Shift+R).
        SCREENS.forEach(s => {
            if (!document.getElementById('screen-' + s)) {
                console.warn('[nav] Sanity check fallito: manca #screen-' + s +
                    '. HTML non aggiornato? Prova hard reload (Ctrl+Shift+R).');
            }
        });

        // Pulsanti nav -> show
        document.querySelectorAll('.nav-btn[data-screen]').forEach(btn => {
            btn.onclick = () => show(btn.dataset.screen);
        });

        // Link "data-jump-screen" (es. dentro l'overlay Config) -> show
        document.querySelectorAll('[data-jump-screen]').forEach(el => {
            el.addEventListener('click', (e) => {
                e.preventDefault();
                // Chiudo eventuale overlay aperto
                const overlay = document.getElementById('config-overlay');
                if (overlay) overlay.style.display = 'none';
                show(el.dataset.jumpScreen);
            });
        });
    });

    window.SailingNav = { show, getCurrent };
})();

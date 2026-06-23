let socket, waitInterval, retryInterval, currentCard = null;
        let waitSeconds = 0, turnstileToken = null;

        const sid = localStorage.getItem('sid') || Math.random().toString(36).substr(2, 9);
        localStorage.setItem('sid', sid);

        // ── Tema ──────────────────────────────────────────────────────────
        const savedTheme = localStorage.getItem('gk_theme') ||
            (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        applyTheme(savedTheme);

        function applyTheme(t) {
            document.documentElement.setAttribute('data-theme', t);
            document.getElementById('theme-toggle').textContent = t === 'dark' ? '☀️' : '🌙';
            localStorage.setItem('gk_theme', t);
            const tw = document.getElementById('turnstile-container');
            if (tw) tw.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light');
        }
        function toggleTheme() {
            applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
        }

        // ── Turnstile ─────────────────────────────────────────────────────
        function onTurnstileSuccess(token) { turnstileToken = token; document.getElementById('submit-btn').disabled = false; }
        function onTurnstileExpired()      { turnstileToken = null;  document.getElementById('submit-btn').disabled = true; }
        function onTurnstileError()        { turnstileToken = null;  document.getElementById('submit-btn').disabled = true; }

        function updateCharCount(el) {
            const n = el.value.length;
            const d = document.getElementById('char-count');
            d.textContent = `${n} / 200`;
            d.classList.toggle('warn', n > 160);
        }

        // ── Bağlantı ──────────────────────────────────────────────────────
        function setConn(state, label) {
            document.getElementById('conn-badge').className = state;
            document.getElementById('conn-label').textContent = label;
        }
        function showBanner(attempt) {
            document.getElementById('rc-attempt').textContent = attempt > 0 ? ` (${attempt}. deneme)` : '';
            document.getElementById('reconnect-banner').classList.add('visible');
        }
        function hideBanner() { document.getElementById('reconnect-banner').classList.remove('visible'); }

        // ── Konfeti ───────────────────────────────────────────────────────
        function confetti() {
            const box = document.getElementById('confetti-box');
            const colors = ['#6366f1','#22c55e','#f59e0b','#ec4899','#06b6d4','#f87171'];
            for (let i = 0; i < 70; i++) {
                const p = document.createElement('div');
                const size = Math.random() * 8 + 4;
                p.className = 'cp';
                p.style.cssText = `
                    left:${Math.random()*100}%;
                    width:${size}px;height:${size}px;
                    background:${colors[Math.floor(Math.random()*colors.length)]};
                    border-radius:${Math.random()>.5?'50%':'2px'};
                    animation-delay:${Math.random()*.8}s;
                    animation-duration:${Math.random()*1.5+2}s;
                `;
                box.appendChild(p);
                setTimeout(() => p.remove(), 3500);
            }
        }

        // ── Geri sayım ────────────────────────────────────────────────────
        function startRetry(sec = 30) {
            let r = sec;
            const el  = document.getElementById('retry-info');
            const btn = document.querySelector('#action-area button');
            el.innerHTML = `Tekrar başvurabilmek için <strong id="r-sec">${r}</strong> saniye bekleyin.`;
            if (btn) btn.disabled = true;
            retryInterval = setInterval(() => {
                r--;
                const s = document.getElementById('r-sec');
                if (s) s.textContent = r;
                if (r <= 0) {
                    clearInterval(retryInterval);
                    el.innerHTML = '';
                    if (btn) btn.disabled = false;
                }
            }, 1000);
        }

        // ── Kart geçişi ───────────────────────────────────────────────────
        function showCard(status) {
            console.log('[GK] showCard:', status, '| currentCard:', currentCard);
            if (waitInterval  && status !== 'pending') { clearInterval(waitInterval);  waitSeconds = 0; }
            if (retryInterval)                         { clearInterval(retryInterval); retryInterval = null; }

            if (status === 'idle') {
                currentCard = 'room-idle';
                activateCard('room-idle');
                return;
            }
            if (status === 'pending') {
                currentCard = 'room-pending';
                activateCard('room-pending');
                waitSeconds = 0;
                document.getElementById('wait-seconds').textContent = '0';
                waitInterval = setInterval(() => {
                    waitSeconds++;
                    const el = document.getElementById('wait-seconds');
                    if (el) el.textContent = waitSeconds;
                }, 1000);
                return;
            }

            const cfgs = {
                approved: {
                    ic:'success', stroke:'var(--success)', path:'<polyline points="20 6 9 17 4 12"/>',
                    bc:'approved', bt:'Erişim Onaylandı',
                    tt:'Hoş geldiniz!', td:'Sisteme giriş yapmaya yetkiniz var.',
                    action:`<button class="btn btn-primary" onclick="location.reload()">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>Panele Git</button>`,
                    fn: () => confetti()
                },
                rejected: {
                    ic:'danger', stroke:'var(--danger)',
                    path:'<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
                    bc:'rejected', bt:'Erişim Reddedildi',
                    tt:'Talebiniz reddedildi.', td:'Yönetici talebinizi onaylamadı.',
                    action:`<button class="btn btn-secondary" onclick="goIdle()">Tekrar Dene</button>`,
                    fn: () => startRetry(30)
                },
                blocked: {
                    ic:'blocked', stroke:'var(--danger)',
                    path:'<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
                    bc:'blocked', bt:'Erişim Engellendi',
                    tt:'Bu sisteme erişiminiz engellendi.',
                    td:'Güvenlik nedeniyle erişiminiz kalıcı olarak kısıtlanmıştır.',
                    action:'', fn: null
                }
            };
            const c = cfgs[status];
            if (!c) return;
            currentCard = 'room-result';
            document.getElementById('res-icon-wrap').className = `card-icon ${c.ic}`;
            const svg = document.getElementById('res-icon-svg');
            svg.setAttribute('stroke', c.stroke);
            svg.innerHTML = c.path;
            const badge = document.getElementById('res-badge');
            badge.className = `res-badge ${c.bc}`;
            badge.textContent = c.bt;
            document.getElementById('res-t').textContent = c.tt;
            document.getElementById('res-d').textContent = c.td;
            document.getElementById('retry-info').innerHTML = '';
            document.getElementById('action-area').innerHTML = c.action;
            activateCard('room-result');
            if (c.fn) setTimeout(c.fn, 200);
        }

        function activateCard(id) {
            console.log('[GK] activateCard:', id);
            const el = document.getElementById(id);
            if (!el) return;
            // Tüm kartları gizle — sadece class ile, inline style kullanma
            document.querySelectorAll('.card').forEach(c => {
                c.style.display = '';  // inline style temizle, CSS'e bırak
                if (c.id !== id) {
                    c.classList.remove('active', 'leaving');
                }
            });
            // Hedef kartı göster
            void el.offsetHeight;
            el.classList.remove('leaving');
            el.classList.add('active');
        }

        function goIdle() { location.reload(); }

        // ── İstek gönder ──────────────────────────────────────────────────
        function req() {
            if (!turnstileToken) return alert('Lütfen doğrulamayı tamamlayın!');
            const note = document.getElementById('note').value.trim();
            document.getElementById('submit-btn').disabled = true;
            const t = turnstileToken; turnstileToken = null;
            socket.emit('request_access', { turnstileToken: t, note });
        }

        // ── Socket ────────────────────────────────────────────────────────
        async function init() {
            const fp = await FingerprintJS.load();
            const { visitorId } = await fp.get();

            setConn('connecting', 'Bağlanıyor');
            activateCard('room-idle');
            currentCard = 'room-idle';

            socket = io({
                auth: { sessionId: sid, deviceId: visitorId },
                reconnectionDelay: 1000,
                reconnectionDelayMax: 5000,
            });

            socket.on('connect',           () => { setConn('connected',    'Bağlı');              hideBanner(); });
            socket.on('disconnect',        (r) => { setConn('disconnected', 'Bağlantı kesildi');  if (r !== 'io client disconnect') showBanner(0); });
            socket.on('reconnect_attempt', (n) => { setConn('connecting',   'Yeniden bağlanıyor'); showBanner(n); });
            socket.on('reconnect',         ()  => { setConn('connected',    'Yeniden bağlandı');  hideBanner(); });
            socket.on('connect_error',     ()  => { setConn('disconnected', 'Bağlanamadı'); });

            socket.on('status_update', (data) => {
                console.log('[GK] status_update:', data.status, '| currentCard:', currentCard);
                if (data.token) localStorage.setItem('gk_token', data.token);
                if ((data.status === 'rejected' || data.status === 'idle') && currentCard === 'room-idle') {
                    console.log('[GK] idle/rejected geldi ama zaten formdayız, atlandı');
                    return;
                }
                showCard(data.status);
            });
            socket.on('force_reload',  ()     => location.reload());
            socket.on('rate_limited',  (data) => {
                const btn = document.getElementById('submit-btn');
                const ori = btn.innerHTML;
                btn.textContent = '⏳ ' + (data.message || 'Çok fazla istek.');
                btn.disabled = true;
                setTimeout(() => { btn.innerHTML = ori; btn.disabled = false; }, 60000);
            });
        }

        init();

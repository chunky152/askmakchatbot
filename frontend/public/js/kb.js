/**
 * AskMak Knowledge Base & Ticketing Client Module
 * Handles category/title drill-down in the welcome screen, answer rendering in chat, and ticket submission.
 */

const KB = (function() {
    let currentCategory = null;
    let cachedCategories = null;

    // DOM Elements
    const els = {
        section: () => document.getElementById('kb-section'),
        nav: () => document.getElementById('kb-nav'),
        backBtn: () => document.getElementById('kb-back-btn'),
        breadcrumb: () => document.getElementById('kb-breadcrumb'),
        categories: () => document.getElementById('kb-categories'),
        titles: () => document.getElementById('kb-titles'),
        ticketBtn: () => document.getElementById('kb-ticket-btn'),
        ticketModal: () => document.getElementById('kb-ticket-modal'),
        ticketModalClose: () => document.getElementById('kb-ticket-modal-close'),
        ticketForm: () => document.getElementById('kb-ticket-form'),
        ticketCategory: () => document.getElementById('kt-category'),
        ticketTitle: () => document.getElementById('kt-title'),
        ticketEmail: () => document.getElementById('kt-email'),
        ticketError: () => document.getElementById('kb-ticket-error'),
        ticketSubmit: () => document.getElementById('kb-ticket-submit'),
        ticketSuccess: () => document.getElementById('kb-ticket-success')
    };

    function init() {
        // Only initialize if we're on the chat page with the kb section
        if (!els.section()) return;

        // Hide KB section by default until auth state is known
        els.section().classList.add('hidden');

        // Immediate fallback: if Auth is already resolved before KB.init() runs
        if (window.Auth && Auth.isAuthenticated && Auth.isAuthenticated() && Auth.user) {
            show(Auth.user);
        }

        // Listen for auth:ready event (the normal async path)
        window.addEventListener('auth:ready', (e) => {
            if (e.detail && e.detail.isAuthenticated && e.detail.user) {
                show(e.detail.user);
            } else {
                // Guest or logged out — hide the section
                els.section().classList.add('hidden');
            }
        });

        setupEventListeners();
    }

    /** Show the KB section and load categories for the given authenticated user. */
    function show(user) {
        if (!els.section()) return;
        els.section().classList.remove('hidden');
        if (els.ticketEmail() && user && user.email) {
            els.ticketEmail().value = user.email;
        }
        loadCategories();
    }

    function setupEventListeners() {
        if (els.backBtn()) {
            els.backBtn().addEventListener('click', showCategories);
        }

        if (els.ticketBtn()) {
            els.ticketBtn().addEventListener('click', () => openTicketModal());
        }

        if (els.ticketModalClose()) {
            els.ticketModalClose().addEventListener('click', closeTicketModal);
        }

        if (els.ticketForm()) {
            els.ticketForm().addEventListener('submit', handleTicketSubmit);
        }
    }

    async function loadCategories() {
        try {
            if (cachedCategories) {
                renderCategories(cachedCategories);
                return;
            }

            const res = await fetch('/api/kb/categories');
            if (!res.ok) throw new Error('Failed to load categories');
            
            const data = await res.json();
            cachedCategories = data.categories || [];
            renderCategories(cachedCategories);
        } catch (err) {
            console.error('[KB]', err);
            els.categories().innerHTML = '<span class="text-xs text-red-400">Unable to load topics.</span>';
        }
    }

    function renderCategories(categories) {
        const container = els.categories();
        if (!categories.length) {
            container.innerHTML = '<span class="text-xs text-zinc-400">No topics available.</span>';
            return;
        }

        container.innerHTML = '';
        categories.forEach(cat => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'px-3 py-1.5 rounded-full border border-zinc-200 dark:border-white/10 bg-white dark:bg-white/5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:border-mak-green/50 hover:bg-mak-green/5 dark:hover:bg-mak-green/10 hover:text-mak-green dark:hover:text-mak-green transition shadow-sm cursor-pointer';
            btn.textContent = cat;
            btn.addEventListener('click', () => loadTitles(cat));
            container.appendChild(btn);
        });
    }

    function showCategories() {
        currentCategory = null;
        els.backBtn().classList.add('hidden');
        els.backBtn().classList.remove('flex');
        els.breadcrumb().textContent = '';
        els.titles().classList.add('hidden');
        els.categories().classList.remove('hidden');
    }

    async function loadTitles(category) {
        currentCategory = category;
        els.categories().classList.add('hidden');
        els.titles().innerHTML = '<div class="text-xs text-center text-zinc-400 py-2 animate-pulse">Loading questions…</div>';
        els.titles().classList.remove('hidden');
        
        els.breadcrumb().textContent = category;
        els.backBtn().classList.remove('hidden');
        els.backBtn().classList.add('flex');  // ensure flex display when unhidden

        try {
            const res = await fetch('/api/kb/categories/' + encodeURIComponent(category));
            if (!res.ok) throw new Error('Failed to load titles');
            const data = await res.json();
            
            const container = els.titles();
            container.innerHTML = '';
            
            if (!data.entries || !data.entries.length) {
                container.innerHTML = '<div class="text-xs text-center text-zinc-500 py-2">No questions found in this category.</div>';
                return;
            }

            data.entries.forEach(entry => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'w-full text-left px-4 py-3 rounded-xl border border-zinc-200 dark:border-white/10 bg-white/80 dark:bg-white/5 hover:bg-mak-green/5 dark:hover:bg-mak-green/10 hover:border-mak-green/30 dark:hover:border-mak-green/30 text-sm font-medium text-zinc-800 dark:text-zinc-200 transition shadow-sm cursor-pointer';
                btn.textContent = entry.title;
                btn.addEventListener('click', () => loadAnswer(entry.id, entry.title));
                container.appendChild(btn);
            });
        } catch (err) {
            console.error('[KB]', err);
            els.titles().innerHTML = '<div class="text-xs text-center text-red-400 py-2">Failed to load questions.</div>';
        }
    }

    async function loadAnswer(id, title) {
        if (!window.Chat) return;

        // Switch to chat view and show the user's question as a bubble
        Chat.switchToChat();
        Chat.appendMessage(
            { role: 'user', content: title, created_at: new Date().toISOString() },
            true
        );

        // Show typing indicator while fetching
        Chat.showTyping(true);

        try {
            const res = await fetch('/api/kb/entries/' + id);
            if (!res.ok) throw new Error('Failed to load answer');
            const data = await res.json();

            Chat.showTyping(false);

            // Render the KB answer as an assistant message
            Chat.appendMessage(
                { role: 'assistant', content: data.entry.content, created_at: new Date().toISOString() },
                true
            );
        } catch (err) {
            console.error('[KB]', err);
            Chat.showTyping(false);
            if (window.Utils) {
                Utils.showToast('Could not load answer. Please try again.', 'error');
            }
        }
    }

    function openTicketModal(categoryPrefill = null) {
        const cat = categoryPrefill || currentCategory || '';
        els.ticketCategory().value = cat;
        els.ticketTitle().value = '';
        els.ticketError().classList.add('hidden');
        els.ticketForm().classList.remove('hidden');
        els.ticketSuccess().classList.add('hidden');
        els.ticketSubmit().disabled = false;
        els.ticketModal().classList.remove('hidden');
        setTimeout(() => els.ticketTitle().focus(), 100);
    }

    function closeTicketModal() {
        els.ticketModal().classList.add('hidden');
    }

    async function handleTicketSubmit(e) {
        e.preventDefault();
        
        const category = els.ticketCategory().value.trim();
        const title = els.ticketTitle().value.trim();
        const email = els.ticketEmail().value.trim();
        
        if (!category || !title || !email) {
            showTicketError('Please fill in all fields.');
            return;
        }

        const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRe.test(email)) {
            showTicketError('Please enter a valid email address.');
            return;
        }

        els.ticketError().classList.add('hidden');
        els.ticketSubmit().disabled = true;
        els.ticketSubmit().textContent = 'Submitting...';

        try {
            const res = await fetch('/api/kb/tickets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ category, title, student_email: email })
            });

            const data = await res.json();
            
            if (!res.ok) {
                throw new Error(data.error || 'Failed to submit ticket');
            }

            // Show success state
            els.ticketForm().classList.add('hidden');
            els.ticketSuccess().classList.remove('hidden');
            
            // Auto close after 3 seconds
            setTimeout(closeTicketModal, 3000);
        } catch (err) {
            console.error('[KB]', err);
            showTicketError(err.message || 'Something went wrong. Please try again.');
        } finally {
            els.ticketSubmit().disabled = false;
            els.ticketSubmit().textContent = 'Submit Ticket';
        }
    }

    function showTicketError(msg) {
        const errEl = els.ticketError();
        errEl.textContent = msg;
        errEl.classList.remove('hidden');
    }

    return {
        init,
        show,
        openTicketModal
    };
})();

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', KB.init);
} else {
    KB.init();
}

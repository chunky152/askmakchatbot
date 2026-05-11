var Chat = {
  chatId: null,
  isStreaming: false,
  controller: null,
  inChatMode: false,
  /** In-memory turns for guests only (not sent to server except as prompt context). */
  guestTurns: [],

  /** Mobile (<lg): fixed #chat-top-bar needs matching top padding on #chat-body */
  mqMobileChat: typeof window.matchMedia !== 'undefined' ? window.matchMedia('(max-width: 1023px)') : null,

  syncMobileHeaderInset: function() {
    var bar = document.getElementById('chat-top-bar');
    var bodyEl = document.getElementById('chat-body');
    if (!bar || !bodyEl) return;
    if (!Chat.mqMobileChat || !Chat.mqMobileChat.matches) {
      bodyEl.style.paddingTop = '';
      return;
    }
    bodyEl.style.paddingTop = bar.offsetHeight + 'px';
  },

  bindMobileHeaderInsetSync: function() {
    var bar = document.getElementById('chat-top-bar');
    if (!bar || typeof window.ResizeObserver === 'undefined') return;
    var ro = new ResizeObserver(function() {
      Chat.syncMobileHeaderInset();
    });
    ro.observe(bar);
  },

  updateAccountChrome: function() {
    var signedIn = Auth.isAuthenticated();
    var gh = document.getElementById('guest-menu-hint');
    var gsi = document.getElementById('guest-menu-signin');
    var gsu = document.getElementById('guest-menu-signup');
    var mem = document.getElementById('memories-btn');
    var lo = document.getElementById('logout-btn');
    if (gh) gh.classList.toggle('hidden', signedIn);
    if (gsi) gsi.classList.toggle('hidden', signedIn);
    if (gsu) gsu.classList.toggle('hidden', signedIn);
    if (mem) mem.classList.toggle('hidden', !signedIn);
    if (lo) lo.classList.toggle('hidden', !signedIn);
  },

  init: function() {
    var self = this;

    Auth.init().then(function() {
      self.updateAccountChrome();
      Sidebar.init();
      self.renderWelcome();
      Upload.init();
    });

    var input = document.getElementById('message-input');
    var sendBtn = document.getElementById('send-btn');

    input.addEventListener('input', function() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 128) + 'px';
      sendBtn.disabled = !input.value.trim() && !Upload.file;
    });

    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        self.sendMessage();
      }
    });

    sendBtn.addEventListener('click', function() { self.sendMessage(); });

    var themeToggleSidebar = document.getElementById('theme-toggle');
    if (themeToggleSidebar) themeToggleSidebar.addEventListener('click', function() { Theme.toggle(); });
    var themeToggleHeader = document.getElementById('header-theme-toggle');
    if (themeToggleHeader) {
      themeToggleHeader.addEventListener('click', function(e) {
        e.stopPropagation();
        Theme.toggle();
      });
    }
    document.getElementById('modal-theme-toggle').addEventListener('click', function() { Theme.toggle(); });

    document.getElementById('user-menu-btn').addEventListener('click', function(e) {
      e.stopPropagation();
      document.getElementById('user-menu-dropdown').classList.toggle('hidden');
    });

    document.addEventListener('click', function(e) {
      if (!e.target.closest('#user-menu-btn') && !e.target.closest('#user-menu-dropdown')) {
        document.getElementById('user-menu-dropdown').classList.add('hidden');
      }
    });

    document.getElementById('settings-btn').addEventListener('click', function() {
      document.getElementById('user-menu-dropdown').classList.add('hidden');
      document.getElementById('settings-modal').classList.remove('hidden');
    });

    document.getElementById('memories-btn').addEventListener('click', function() {
      document.getElementById('user-menu-dropdown').classList.add('hidden');
      document.getElementById('memories-modal').classList.remove('hidden');
      self.loadMemories();
    });

    document.getElementById('logout-btn').addEventListener('click', function() {
      document.getElementById('user-menu-dropdown').classList.add('hidden');
      Auth.logout();
    });

    document.querySelectorAll('.modal-close').forEach(function(btn) {
      btn.addEventListener('click', function() {
        btn.closest('[id$="-modal"]').classList.add('hidden');
      });
    });

    document.querySelectorAll('[id$="-modal"]').forEach(function(modal) {
      modal.addEventListener('click', function(e) {
        if (e.target === modal) modal.classList.add('hidden');
      });
    });

    var msgs = document.getElementById('chat-messages');
    var scrollBtn = document.getElementById('scroll-bottom');
    msgs.addEventListener('scroll', function() {
      var atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 100;
      if (atBottom) {
        scrollBtn.classList.add('hidden');
        scrollBtn.classList.remove('flex');
      } else {
        scrollBtn.classList.remove('hidden');
        scrollBtn.classList.add('flex');
      }
    });
    scrollBtn.addEventListener('click', function() {
      msgs.scrollTo({ top: msgs.scrollHeight, behavior: 'smooth' });
    });

    window.addEventListener('online', function() {
      document.getElementById('offline-banner').classList.add('hidden');
      self.syncMobileHeaderInset();
    });
    window.addEventListener('offline', function() {
      document.getElementById('offline-banner').classList.remove('hidden');
      self.syncMobileHeaderInset();
    });

    self.bindMobileHeaderInsetSync();
    self.syncMobileHeaderInset();
    window.addEventListener('resize', function() {
      self.syncMobileHeaderInset();
    });
    window.addEventListener('orientationchange', function() {
      setTimeout(function() {
        self.syncMobileHeaderInset();
      }, 250);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function() {
        self.syncMobileHeaderInset();
      });
    }
    if (Chat.mqMobileChat && typeof Chat.mqMobileChat.addEventListener === 'function') {
      Chat.mqMobileChat.addEventListener('change', function() {
        self.syncMobileHeaderInset();
      });
    }
  },

  switchToChat: function() {
    if (!this.inChatMode) {
      this.inChatMode = true;
      document.getElementById('welcome-screen').classList.add('hidden');
      var msgs = document.getElementById('chat-messages');
      msgs.classList.remove('hidden');
      msgs.classList.add('flex', 'flex-col', 'flex-1');
    }
    var chatBody = document.getElementById('chat-body');
    if (chatBody) {
      chatBody.classList.remove('chat-body-welcome');
      chatBody.classList.add('chat-body-chat');
    }
  },

  switchToWelcome: function() {
    this.inChatMode = false;
    document.getElementById('welcome-screen').classList.remove('hidden');
    var msgs = document.getElementById('chat-messages');
    msgs.innerHTML = '';
    msgs.classList.add('hidden');
    msgs.classList.remove('flex', 'flex-col', 'flex-1');
    var chatBody = document.getElementById('chat-body');
    if (chatBody) {
      chatBody.classList.add('chat-body-welcome');
      chatBody.classList.remove('chat-body-chat');
    }
  },

  renderWelcome: function() {
    var greetEl = document.getElementById('welcome-greeting');
    var leadEl = document.getElementById('welcome-lead');
    var first = Auth.user ? Auth.user.full_name.split(' ')[0] : null;
    if (greetEl) {
      greetEl.textContent = first
        ? 'Hi ' + first + '! I\'m AskMak'
        : 'Hi, I\'m AskMak';
    }
    if (leadEl) leadEl.textContent = 'How can I help you today?';
    this.updateAccountChrome();
    this.switchToWelcome();
    this.loadKBCategories();
  },

  newChat: function() {
    this.chatId = null;
    this.guestTurns = [];
    this.isStreaming = false;
    if (this.controller) { this.controller.abort(); this.controller = null; }
    Sidebar.activeId = null;
    Sidebar.render();
    this.renderWelcome();
  },

  loadChat: async function(id) {
    try {
      this.switchToChat();
      var result = await API.get('/chats/' + id + '/messages');
      this.chatId = id;
      var msgs = document.getElementById('chat-messages');
      msgs.innerHTML = '';

      var messages = result.messages || result || [];
      var self = this;
      messages.forEach(function(msg) {
        self.appendMessage(msg, false);
      });

      msgs.scrollTop = msgs.scrollHeight;
    } catch (e) {
      Utils.showToast('Failed to load chat', 'error');
    }
  },

  sendMessage: async function() {
    if (this.isStreaming) return;

    var input = document.getElementById('message-input');
    var text = input.value.trim();
    if (!text && !Upload.file) return;

    this.switchToChat();

    var imageKey = null;
    if (Upload.file) {
      imageKey = await Upload.upload(this.chatId || 'temp');
    }

    input.value = '';
    input.style.height = 'auto';
    document.getElementById('send-btn').disabled = true;

    var userMsg = {
      role: 'user',
      content: text,
      image_key: imageKey,
      created_at: new Date().toISOString()
    };
    this.appendMessage(userMsg);

    this.isStreaming = true;
    this.showTyping(true);

    try {
      this.controller = new AbortController();
      var self = this;
      var botContent = '';
      var botDiv = null;
      var signedIn = Auth.isAuthenticated();

      function onStreamData(data) {
        if (data.type === 'token' || data.type === 'delta') {
          botContent += data.content || data.delta || '';
          if (!botDiv) {
            self.showTyping(false);
            botDiv = self.appendMessage({ role: 'assistant', content: botContent, created_at: new Date().toISOString() });
          } else {
            var bubble = botDiv.querySelector('.msg-content');
            if (bubble) bubble.innerHTML = Utils.renderMarkdown(botContent);
          }
          var msgs = document.getElementById('chat-messages');
          msgs.scrollTop = msgs.scrollHeight;
        }

        if (data.type === 'sources' && data.sources) {
          var srcHtml = self.renderSources(data.sources);
          if (botDiv) {
            var wrapper = botDiv.querySelector('.msg-meta');
            if (wrapper) wrapper.insertAdjacentHTML('afterbegin', srcHtml);
          }
        }

        if (data.type === 'done') {
          if (botDiv) {
            var actionsHtml = self.renderActions(data.message_id);
            var wrapper = botDiv.querySelector('.msg-meta');
            if (wrapper) wrapper.insertAdjacentHTML('beforeend', actionsHtml);
            self.bindActions(botDiv);
          }
          if (!signedIn && botContent) {
            self.guestTurns.push({ role: 'user', content: text });
            self.guestTurns.push({ role: 'assistant', content: botContent });
          }
        }

        if (data.type === 'error') {
          self.showTyping(false);
          Utils.showToast(
            data.message || 'Hmm, I didn\'t get that. Try asking about courses or fees.',
            'error'
          );
        }
      }

      if (signedIn) {
        if (!this.chatId) {
          var chatResult = await API.post('/chats', { title: text.substring(0, 50) });
          this.chatId = chatResult.id;
          Sidebar.addChat(chatResult);
        }
        await API.stream(
          '/chats/' + this.chatId + '/messages',
          { content: text, image_key: imageKey },
          onStreamData,
          this.controller.signal
        );
      } else {
        await API.stream(
          '/chats/guest/stream',
          { content: text, image_key: imageKey, history: this.guestTurns.slice() },
          onStreamData,
          this.controller.signal
        );
      }

    } catch (e) {
      if (e.name !== 'AbortError') {
        Utils.showToast('Hmm, I couldn\'t send that. Check your connection, then try again.', 'error');
      }
    } finally {
      this.isStreaming = false;
      this.showTyping(false);
      this.controller = null;
    }
  },

  appendMessage: function(msg, scroll) {
    var msgs = document.getElementById('chat-messages');
    var div = document.createElement('div');
    var isUser = msg.role === 'user';

    div.className = 'flex gap-2 max-w-3xl w-full mx-auto py-2 sm:py-3 lg:gap-3 animate-fade-in' + (isUser ? ' flex-row-reverse' : '');
    if (msg.id) div.dataset.msgId = msg.id;

    var avatarBg = isUser
      ? 'bg-mak-green text-white ring-2 ring-white/25 dark:ring-white/15'
      : 'bg-mak-green text-white ring-2 ring-mak-green/20';
    var avatarText = isUser ? Utils.getInitials(Auth.user ? Auth.user.full_name : 'G') : 'M';

    var html =
      '<div class="w-7 h-7 sm:w-8 sm:h-8 rounded-full text-[10px] sm:text-xs ' +
      avatarBg +
      ' flex items-center justify-center font-semibold shrink-0">' +
      avatarText +
      '</div>';
    html += '<div class="flex-1 min-w-0' + (isUser ? ' flex flex-col items-end' : '') + '">';

    if (isUser) {
      html +=
        '<div class="msg-user-bubble bg-mak-green text-white px-3.5 sm:px-4 py-3 rounded-2xl rounded-br-sm text-sm max-w-[min(94%,26rem)] sm:max-w-[85%] break-words shadow-sm">';
      html += Utils.escapeHtml(msg.content || '');
      html += '</div>';
    } else {
      html +=
        '<div class="msg-content rounded-2xl rounded-tl-sm border-0 shadow-none bg-transparent dark:bg-transparent px-0 sm:px-0.5 py-1.5 sm:py-1.5 text-[0.9375rem] sm:text-sm break-words max-w-[min(94%,32rem)] sm:max-w-[90%] text-zinc-800 dark:text-zinc-100 prose prose-sm prose-zinc dark:prose-invert max-w-none prose-strong:text-zinc-900 dark:prose-strong:text-white prose-pre:overflow-x-auto prose-table:overflow-x-auto prose-table:block prose-table:max-w-full prose-img:rounded-lg prose-serif prose-a:text-mak-green dark:prose-a:text-mak-green prose-headings:font-semibold prose-headings:text-mak-green dark:prose-headings:text-zinc-50 dark:prose-code:text-mak-green/95 dark:prose-pre:bg-chat-sidebar/80 dark:prose-pre:text-zinc-200">';
      html += Utils.renderMarkdown(msg.content || '');
      html += '</div>';
    }

    if (msg.image_key) {
      html += '<img src="/api/images/' + msg.image_key + '" alt="Attached image" class="mt-2 w-full max-w-full sm:max-w-xs rounded-lg cursor-pointer hover:opacity-90 transition" onclick="Utils.openLightbox(this.src)">';
    }

    html += '<div class="msg-meta flex flex-wrap items-center gap-2 mt-1.5">';
    html += '<span class="text-[11px] text-zinc-500 dark:text-mak-green/50">' + Utils.formatTime(msg.created_at) + '</span>';
    html += '</div>';

    html += '</div>';
    div.innerHTML = html;
    msgs.appendChild(div);

    if (scroll !== false) {
      msgs.scrollTop = msgs.scrollHeight;
    }

    return div;
  },

  renderSources: function(sources) {
    if (!sources || !sources.length) return '';
    var html = '<div class="flex flex-wrap gap-1.5">';
    sources.forEach(function(s) {
      html += '<a href="' + Utils.escapeHtml(s.url || '#') + '" target="_blank" rel="noopener" class="inline-flex items-center gap-1 px-2.5 py-1 bg-zinc-100/80 dark:bg-mak-green/[0.08] rounded-full text-[11px] text-zinc-600 dark:text-zinc-300 no-underline hover:bg-zinc-200/90 dark:hover:bg-mak-green/15 transition">';
      html += '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
      html += Utils.escapeHtml(Utils.truncate(s.title || s.url, 30));
      html += '</a>';
    });
    html += '</div>';
    return html;
  },

  renderActions: function(messageId) {
    var html = '<div class="flex gap-0.5 items-center">';
    html += '<button class="feedback-btn bg-transparent border border-transparent rounded p-1 px-1.5 cursor-pointer text-zinc-400 dark:text-zinc-500 flex items-center gap-1 text-xs hover:bg-zinc-100 dark:hover:bg-mak-green/10 hover:border-zinc-200 dark:hover:border-mak-green/30 transition" data-type="positive" data-msg="' + (messageId || '') + '" title="Helpful">';
    html += '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z"/></svg>';
    html += '</button>';
    html += '<button class="feedback-btn bg-transparent border border-transparent rounded p-1 px-1.5 cursor-pointer text-zinc-400 dark:text-zinc-500 flex items-center gap-1 text-xs hover:bg-zinc-100 dark:hover:bg-mak-green/10 hover:border-zinc-200 dark:hover:border-mak-green/30 transition" data-type="negative" data-msg="' + (messageId || '') + '" title="Not helpful">';
    html += '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22h0a3.13 3.13 0 0 1-3-3.88Z"/></svg>';
    html += '</button>';
    html += '<button class="copy-btn bg-transparent border border-transparent rounded p-1 px-1.5 cursor-pointer text-zinc-400 dark:text-zinc-500 flex items-center gap-1 text-xs hover:bg-zinc-100 dark:hover:bg-mak-green/10 hover:border-zinc-200 dark:hover:border-mak-green/30 transition" title="Copy">';
    html += '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
    html += '</button>';
    html += '<button class="escalate-btn bg-transparent border border-transparent rounded p-1 px-1.5 cursor-pointer text-zinc-400 dark:text-zinc-500 flex items-center gap-1 text-xs hover:bg-zinc-100 dark:hover:bg-mak-green/10 hover:border-zinc-200 dark:hover:border-mak-green/30 transition" data-msg="' + (messageId || '') + '" title="Escalate to staff">';
    html += '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M12 12v9"/><path d="m8 17 4-5 4 5"/></svg>';
    html += '</button>';
    html += '</div>';
    return html;
  },

  bindActions: function(div) {
    var self = this;

    div.querySelectorAll('.feedback-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        self.sendFeedback(btn.dataset.msg, btn.dataset.type);
        div.querySelectorAll('.feedback-btn').forEach(function(b) {
          b.classList.remove('!text-mak-green', '!text-mak-red');
        });
        btn.classList.add(btn.dataset.type === 'positive' ? '!text-mak-green' : '!text-mak-red');
      });
    });

    div.querySelectorAll('.copy-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var bubble = div.querySelector('.msg-content');
        var plain = bubble ? bubble.textContent || bubble.innerText || '' : '';
        if (!plain.trim()) return;
        Utils.copyTextToClipboard(plain.trim()).then(function(ok) {
          if (ok) Utils.showToast('Copied to clipboard', 'success');
          else Utils.showToast('Could not copy (try HTTPS or paste manually)', 'error');
        });
      });
    });

    div.querySelectorAll('.escalate-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        self.escalate(btn.dataset.msg);
      });
    });
  },

  sendFeedback: async function(messageId, type) {
    if (!messageId) return;
    try {
      await API.post('/messages/' + messageId + '/feedback', { type: type });
    } catch (e) {}
  },

  escalate: async function(messageId) {
    if (!messageId) return;
    var confirmed = await Utils.showConfirm('Escalate to staff', 'This will flag the response for review by university staff. Continue?');
    if (!confirmed) return;
    try {
      await API.post('/messages/' + messageId + '/escalate');
      Utils.showToast('Escalated to staff', 'success');
    } catch (e) {
      Utils.showToast('Failed to escalate', 'error');
    }
  },

  showTyping: function(show) {
    var el = document.getElementById('typing-indicator');
    if (show) {
      el.classList.remove('hidden');
      el.classList.add('flex');
    } else {
      el.classList.add('hidden');
      el.classList.remove('flex');
    }
  },

  loadMemories: async function() {
    var list = document.getElementById('memories-list');
    try {
      var result = await API.get('/memories');
      var memories = result.memories || result || [];
      if (!memories.length) {
        list.innerHTML = '<div class="text-sm text-zinc-500 dark:text-zinc-400 text-center py-6">No memories yet</div>';
        return;
      }
      var html = '';
      memories.forEach(function(m) {
        html += '<div class="flex items-start gap-3 p-3 bg-zinc-100 dark:bg-chat-canvas/80 dark:border dark:border-chat-line/60 rounded-lg">';
        html += '<div class="flex-1 text-sm text-zinc-700 dark:text-zinc-200">' + Utils.escapeHtml(m.content) + '</div>';
        html += '<button class="memory-delete shrink-0 w-6 h-6 rounded hover:bg-zinc-200 dark:hover:bg-mak-green/15 flex items-center justify-center text-zinc-400 bg-transparent border-none cursor-pointer transition" data-id="' + m.id + '">';
        html += '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
        html += '</button></div>';
      });
      list.innerHTML = html;
      list.querySelectorAll('.memory-delete').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          try {
            await API.delete('/memories/' + btn.dataset.id);
            btn.closest('.flex').remove();
            Utils.showToast('Memory deleted', 'success');
          } catch (e) {
            Utils.showToast('Failed to delete memory', 'error');
          }
        });
      });
    } catch (e) {
      list.innerHTML = '<div class="text-sm text-zinc-500 text-center py-6">Failed to load memories</div>';
    }
  },

  loadKBCategories: async function() {
    var container = document.getElementById('kb-categories');
    if (!container) return;
    try {
      var result = await API.get('/kb/categories');
      var categories = result.categories || [];
      if (!categories.length) {
        container.innerHTML = '';
        return;
      }
      var html = '';
      var self = this;
      categories.forEach(function(cat) {
        html += '<button class="kb-cat-btn px-4 py-2 bg-zinc-100 dark:bg-chat-raised hover:bg-mak-green/10 dark:hover:bg-mak-green/20 border border-zinc-200 dark:border-chat-line rounded-xl text-xs font-semibold text-zinc-700 dark:text-zinc-200 transition cursor-pointer" data-category="' + Utils.escapeHtml(cat) + '">';
        html += Utils.escapeHtml(cat);
        html += '</button>';
      });
      container.innerHTML = html;

      container.querySelectorAll('.kb-cat-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          self.showKBTitles(btn.dataset.category);
        });
      });
    } catch (e) {
      container.innerHTML = '';
    }
  },

  showKBTitles: async function(category) {
    var modal = document.getElementById('kb-modal');
    var titleEl = document.getElementById('kb-modal-title');
    var bodyEl = document.getElementById('kb-modal-body');
    
    titleEl.textContent = category;
    bodyEl.innerHTML = '<div class="flex items-center justify-center py-10"><span class="loading-spinner"></span></div>';
    modal.classList.remove('hidden');

    try {
      var result = await API.get('/kb/categories/' + encodeURIComponent(category) + '/titles');
      var titles = result.titles || [];
      
      var html = '<div class="space-y-2">';
      var self = this;
      titles.forEach(function(item) {
        html += '<button class="kb-title-btn w-full text-left px-4 py-3 bg-zinc-50 dark:bg-chat-canvas hover:bg-zinc-100 dark:hover:bg-mak-green/5 border border-zinc-200 dark:border-chat-line rounded-lg text-sm text-zinc-700 dark:text-zinc-200 transition cursor-pointer" data-id="' + item.id + '">';
        html += Utils.escapeHtml(item.title);
        html += '</button>';
      });
      
      html += '<div class="pt-4 border-t border-zinc-100 dark:border-chat-line mt-4">';
      html += '<p class="text-xs text-zinc-500 dark:text-zinc-400 mb-3 text-center">Didn\'t find what you were looking for?</p>';
      html += '<button id="kb-ticket-trigger" class="w-full py-2.5 bg-mak-green text-white rounded-lg text-sm font-semibold hover:opacity-90 transition cursor-pointer">File a Formal Ticket</button>';
      html += '</div>';
      html += '</div>';
      
      bodyEl.innerHTML = html;

      bodyEl.querySelectorAll('.kb-title-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          self.showKBContent(btn.dataset.id);
        });
      });

      document.getElementById('kb-ticket-trigger').addEventListener('click', function() {
        self.showTicketForm(category);
      });

    } catch (e) {
      bodyEl.innerHTML = '<p class="text-sm text-mak-red">Failed to load titles.</p>';
    }
  },

  showKBContent: async function(id) {
    var bodyEl = document.getElementById('kb-modal-body');
    bodyEl.innerHTML = '<div class="flex items-center justify-center py-10"><span class="loading-spinner"></span></div>';

    try {
      var result = await API.get('/kb/documents/' + id);
      var doc = result.document;
      
      var html = '<div class="prose prose-sm dark:prose-invert max-w-none">';
      html += '<h4 class="text-mak-green dark:text-white mb-2">' + Utils.escapeHtml(doc.title) + '</h4>';
      html += '<div class="text-zinc-700 dark:text-zinc-300 leading-relaxed">' + Utils.renderMarkdown(doc.content) + '</div>';
      html += '<div class="mt-8 pt-4 border-t border-zinc-100 dark:border-chat-line flex flex-col gap-3">';
      html += '<button id="kb-back-titles" class="text-sm text-zinc-500 dark:text-zinc-400 hover:text-mak-green transition bg-transparent border-none cursor-pointer">← Back to ' + Utils.escapeHtml(doc.category) + '</button>';
      html += '<button id="kb-ticket-trigger-inner" class="w-full py-2.5 bg-zinc-100 dark:bg-mak-green/20 text-zinc-700 dark:text-mak-green rounded-lg text-sm font-semibold hover:bg-zinc-200 dark:hover:bg-mak-green/30 transition cursor-pointer">Not what I needed - File a Formal Ticket</button>';
      html += '</div>';
      html += '</div>';
      
      bodyEl.innerHTML = html;

      var self = this;
      document.getElementById('kb-back-titles').addEventListener('click', function() {
        self.showKBTitles(doc.category);
      });
      document.getElementById('kb-ticket-trigger-inner').addEventListener('click', function() {
        self.showTicketForm(doc.category, doc.title);
      });

    } catch (e) {
      bodyEl.innerHTML = '<p class="text-sm text-mak-red">Failed to load content.</p>';
    }
  },

  showTicketForm: function(category, titleHint) {
    var titleEl = document.getElementById('kb-modal-title');
    var bodyEl = document.getElementById('kb-modal-body');
    
    titleEl.textContent = 'File a Formal Ticket';
    
    var email = Auth.user ? Auth.user.email : '';
    
    var html = '<form id="kb-ticket-form" class="space-y-4">';
    html += '<div><label class="block text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase mb-1">Email</label>';
    html += '<input type="email" id="ticket-email" value="' + Utils.escapeHtml(email) + '" required placeholder="Enter your email" class="w-full bg-zinc-50 dark:bg-chat-canvas border border-zinc-200 dark:border-chat-line rounded-lg px-3 py-2 text-sm focus:border-mak-green outline-none dark:text-white transition"></div>';
    
    html += '<div><label class="block text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase mb-1">Category</label>';
    html += '<input type="text" id="ticket-category" value="' + Utils.escapeHtml(category) + '" readonly class="w-full bg-zinc-100 dark:bg-chat-sidebar/50 border border-zinc-200 dark:border-chat-line rounded-lg px-3 py-2 text-sm text-zinc-500 cursor-not-allowed"></div>';
    
    html += '<div><label class="block text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase mb-1">Inquiry Title</label>';
    html += '<input type="text" id="ticket-title" value="' + Utils.escapeHtml(titleHint || '') + '" required placeholder="What is your question about?" class="w-full bg-zinc-50 dark:bg-chat-canvas border border-zinc-200 dark:border-chat-line rounded-lg px-3 py-2 text-sm focus:border-mak-green outline-none dark:text-white transition"></div>';
    
    html += '<p class="text-[11px] text-zinc-500 dark:text-zinc-400 italic">This ticket will be sent to Makerere staff. You will receive an email once it is resolved and added to our Knowledge Base.</p>';
    
    html += '<div class="pt-2 flex gap-3">';
    html += '<button type="button" id="kb-ticket-cancel" class="flex-1 py-2.5 bg-zinc-100 dark:bg-chat-raised text-zinc-600 dark:text-zinc-300 rounded-lg text-sm font-semibold hover:bg-zinc-200 transition cursor-pointer">Cancel</button>';
    html += '<button type="submit" class="flex-1 py-2.5 bg-mak-green text-white rounded-lg text-sm font-semibold hover:opacity-90 transition cursor-pointer">Send Ticket</button>';
    html += '</div></form>';
    
    bodyEl.innerHTML = html;

    var self = this;
    document.getElementById('kb-ticket-cancel').addEventListener('click', function() {
      self.showKBTitles(category);
    });

    document.getElementById('kb-ticket-form').addEventListener('submit', function(e) {
      e.preventDefault();
      self.submitTicket();
    });
  },

  submitTicket: async function() {
    var email = document.getElementById('ticket-email').value;
    var category = document.getElementById('ticket-category').value;
    var title = document.getElementById('ticket-title').value;
    
    var bodyEl = document.getElementById('kb-modal-body');
    var originalHtml = bodyEl.innerHTML;
    bodyEl.innerHTML = '<div class="flex items-center justify-center py-10"><span class="loading-spinner"></span></div>';

    try {
      await API.post('/escalations', {
        user_email: email,
        category: category,
        title: title,
        reason: 'Knowledge Base lookup failure'
      });
      
      bodyEl.innerHTML = '<div class="text-center py-10"><div class="w-16 h-16 bg-mak-green/10 text-mak-green rounded-full flex items-center justify-center mx-auto mb-4"><svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div><h3 class="text-lg font-bold dark:text-white mb-2">Ticket Sent</h3><p class="text-sm text-zinc-500 dark:text-zinc-400">Our staff will review your inquiry and get back to you via email.</p><button id="kb-done" class="mt-6 px-8 py-2 bg-mak-green text-white rounded-lg font-semibold hover:opacity-90 transition cursor-pointer">Done</button></div>';
      
      document.getElementById('kb-done').addEventListener('click', function() {
        document.getElementById('kb-modal').classList.add('hidden');
      });

    } catch (e) {
      Utils.showToast('Failed to send ticket', 'error');
      bodyEl.innerHTML = originalHtml;
    }
  }
};

document.addEventListener('DOMContentLoaded', function() { Chat.init(); });

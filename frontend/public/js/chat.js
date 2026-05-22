var Chat = {
  chatId: null,
  isStreaming: false,
  controller: null,
  inChatMode: false,
  /** In-memory turns for guests only (not sent to server except as prompt context). */
  guestTurns: [],

  /** Mobile (<lg): fixed #chat-top-bar needs matching top padding on #chat-body */
  mqMobileChat: typeof window.matchMedia !== 'undefined' ? window.matchMedia('(max-width: 1023px)') : null,

  /** Keep fixed top bar aligned with the visual viewport when mobile browsers shift layout (e.g. keyboard). */
  syncMobileTopBarVisualPosition: function() {
    var bar = document.getElementById('chat-top-bar');
    if (!bar) return;
    if (!Chat.mqMobileChat || !Chat.mqMobileChat.matches) {
      bar.style.transform = '';
      return;
    }
    var vv = window.visualViewport;
    if (!vv) return;
    var y = vv.offsetTop;
    bar.style.transform = y ? 'translate3d(0,' + y + 'px,0)' : '';
  },

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

  applyMobileChatChrome: function() {
    Chat.syncMobileHeaderInset();
    Chat.syncMobileTopBarVisualPosition();
  },

  bindMobileHeaderInsetSync: function() {
    var bar = document.getElementById('chat-top-bar');
    if (!bar || typeof window.ResizeObserver === 'undefined') return;
    var ro = new ResizeObserver(function() {
      Chat.applyMobileChatChrome();
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
      // Explicitly show the KB section if the user is logged in
      if (Auth.isAuthenticated() && window.KB && KB.show) {
        KB.show(Auth.user);
      }
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

    document.addEventListener('click', function(e) {
      var q = e.target && e.target.closest ? e.target.closest('a[href="#quick-topics"]') : null;
      if (!q) return;
      e.preventDefault();
      self.focusQuickAccess();
    });

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
      self.applyMobileChatChrome();
    });
    window.addEventListener('offline', function() {
      document.getElementById('offline-banner').classList.remove('hidden');
      self.applyMobileChatChrome();
    });

    self.bindMobileHeaderInsetSync();
    self.applyMobileChatChrome();
    window.addEventListener('resize', function() {
      self.applyMobileChatChrome();
    });
    window.addEventListener('orientationchange', function() {
      setTimeout(function() {
        self.applyMobileChatChrome();
      }, 250);
    });
    if (window.visualViewport) {
      var onVV = function() {
        self.applyMobileChatChrome();
      };
      window.visualViewport.addEventListener('resize', onVV);
      window.visualViewport.addEventListener('scroll', onVV);
    }
    if (Chat.mqMobileChat && typeof Chat.mqMobileChat.addEventListener === 'function') {
      Chat.mqMobileChat.addEventListener('change', function() {
        self.applyMobileChatChrome();
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

  /**
   * Return to the welcome screen and DICTS quick-access topic grid (same as starting a new chat).
   * Used by assistant links `[Choose another quick-access topic](#quick-topics)` and the #quick-topics hash.
   */
  focusQuickAccess: function() {
    this.newChat();
    if (window.AskMakQuickTopics && typeof window.AskMakQuickTopics.resetToGrid === 'function') {
      window.AskMakQuickTopics.resetToGrid();
    }
    var el = document.getElementById('quick-topics');
    if (el && typeof el.scrollIntoView === 'function') {
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (_) {
        el.scrollIntoView();
      }
    }
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

    var botContent = '';
    var botDiv = null;

    try {
      this.controller = new AbortController();
      var self = this;
      var signedIn = Auth.isAuthenticated();

      function stripStreamingCaret() {
        if (!botDiv) return;
        botDiv.classList.remove('msg-row-streaming');
        var bubble = botDiv.querySelector('.msg-content');
        if (bubble && bubble.querySelector('.msg-stream-caret')) {
          bubble.innerHTML = Utils.renderMarkdown(botContent);
        }
      }

      function onStreamData(data) {
        if (data.type === 'token' || data.type === 'delta') {
          botContent += data.content || data.delta || '';
          var caret = '<span class="msg-stream-caret" aria-hidden="true"></span>';
          if (!botDiv) {
            self.showTyping(false);
            botDiv = self.appendMessage(
              { role: 'assistant', content: botContent, created_at: new Date().toISOString() },
              true,
              { streaming: true }
            );
          } else {
            var bubble = botDiv.querySelector('.msg-content');
            if (bubble) bubble.innerHTML = Utils.renderMarkdown(botContent) + caret;
          }
          var msgs = document.getElementById('chat-messages');
          msgs.scrollTop = msgs.scrollHeight;
        }

        /* 
        if (data.type === 'sources' && data.sources) {
          var srcHtml = self.renderSources(data.sources);
          if (botDiv) {
            var wrapper = botDiv.querySelector('.msg-meta');
            if (wrapper) wrapper.insertAdjacentHTML('afterbegin', srcHtml);
          }
        }
        */

        if (data.type === 'done') {
          if (botDiv) {
            stripStreamingCaret();
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
          stripStreamingCaret();
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
      if (botDiv) {
        botDiv.classList.remove('msg-row-streaming');
        var bubbleFin = botDiv.querySelector('.msg-content');
        if (bubbleFin && bubbleFin.querySelector('.msg-stream-caret')) {
          bubbleFin.innerHTML = Utils.renderMarkdown(botContent);
        }
      }
    }
  },

  appendMessage: function(msg, scroll, opts) {
    opts = opts || {};
    var msgs = document.getElementById('chat-messages');
    var div = document.createElement('div');
    var isUser = msg.role === 'user';

    var entranceClass = '';
    if (scroll !== false) {
      if (isUser) entranceClass = ' animate-msg-user-in';
      else if (opts.streaming) entranceClass = ' animate-assistant-in';
      else entranceClass = ' animate-fade-in';
    }

    div.className =
      'flex gap-2 max-w-3xl w-full mx-auto py-2 sm:py-3 lg:gap-3 motion-reduce:animate-none' +
      entranceClass +
      (isUser ? ' flex-row-reverse' : '') +
      (!isUser && opts.streaming ? ' msg-row-streaming' : '');
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
      if (opts.streaming) html += '<span class="msg-stream-caret" aria-hidden="true"></span>';
      html += '</div>';
    }

    if (msg.image_key) {
      html += '<img src="/api/images/' + msg.image_key + '" alt="Attached image" class="mt-2 w-full max-w-full sm:max-w-xs rounded-lg cursor-pointer hover:opacity-90 transition" onclick="Utils.openLightbox(this.src)">';
    }

    // Meta row: clock-style timestamp (e.g. "10:42 AM") for bot responses,
    // relative time ("2m ago") for user messages. Streaming bot replies get
    // their actions injected later on the 'done' SSE event; loaded/non-stream
    // bot replies get the Copy action attached immediately below.
    var stamp = isUser
      ? Utils.formatTime(msg.created_at)
      : Utils.formatClockTime(msg.created_at);
    html += '<div class="msg-meta flex flex-wrap items-center gap-2 mt-1.5">';
    html += '<span class="msg-time text-[11px] text-zinc-500 dark:text-mak-green/50" data-iso="' + Utils.escapeHtml(msg.created_at || '') + '">' + Utils.escapeHtml(stamp) + '</span>';
    html += '</div>';

    html += '</div>';
    div.innerHTML = html;
    msgs.appendChild(div);

    // For non-streaming bot replies (loaded history, KB direct answers, etc.)
    // attach the Copy action immediately so it isn't missing.
    if (!isUser && !opts.streaming) {
      var wrapper = div.querySelector('.msg-meta');
      if (wrapper) {
        wrapper.insertAdjacentHTML('beforeend', this.renderActions(msg.id));
        this.bindActions(div);
      }
    }

    if (scroll !== false) {
      msgs.scrollTop = msgs.scrollHeight;
    }

    return div;
  },

  renderActions: function(messageId) {
    // Per product spec: bot replies show only the Copy action.
    // Like/dislike feedback and the "escalate to staff" cloud icon were
    // intentionally removed; an absolute clock timestamp is rendered
    // alongside this in the .msg-meta row.
    var html = '<div class="flex gap-0.5 items-center">';
    html += '<button class="copy-btn bg-transparent border border-transparent rounded p-1 px-1.5 cursor-pointer text-zinc-400 dark:text-zinc-500 flex items-center gap-1 text-xs hover:bg-zinc-100 dark:hover:bg-mak-green/10 hover:border-zinc-200 dark:hover:border-mak-green/30 transition" data-msg="' + (messageId || '') + '" aria-label="Copy response" title="Copy response">';
    html += '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
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
  }
};

document.addEventListener('DOMContentLoaded', function() { Chat.init(); });

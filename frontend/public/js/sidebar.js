var Sidebar = {
  chats: [],
  activeId: null,

  init: function() {
    var self = this;

    self.applyDesktopCollapsedFromStorage();
    var colBtn = document.getElementById('sidebar-collapse-toggle');
    if (colBtn) {
      colBtn.addEventListener('click', function(e) {
        e.preventDefault();
        self.toggleDesktopCollapsed();
      });
      self.syncCollapseToggleButton();
    }

    document.getElementById('sidebar-toggle').addEventListener('click', function() { self.toggle(); });
    document.getElementById('sidebar-overlay').addEventListener('click', function() { self.close(); });
    document.getElementById('new-chat-btn').addEventListener('click', function() {
      Chat.newChat();
      self.close();
    });
    document.getElementById('clear-history-btn').addEventListener('click', function() { self.clearAllHistory(); });

    var signInBtn = document.getElementById('sidebar-sign-in');
    if (signInBtn) {
      signInBtn.addEventListener('click', function() {
        window.location.href = '/login.html?next=%2Fchat.html';
      });
    }

    var qaBlock = document.querySelector('#sidebar .sidebar-quick-block');
    if (qaBlock) {
      qaBlock.querySelectorAll('a.sidebar-nav-btn[href]').forEach(function(link) {
        link.addEventListener('click', function() { self.close(); });
      });
    }

    var searchToggle = document.getElementById('search-chats-toggle');
    var searchPanel = document.getElementById('chat-search-panel');
    var searchInput = document.getElementById('chat-search');
    searchToggle.addEventListener('click', function() {
      if (!self.isDrawerViewport() && self.isDesktopCollapsed()) {
        self.setDesktopCollapsed(false);
      }
      var opening = searchPanel.classList.contains('hidden');
      searchPanel.classList.toggle('hidden');
      searchToggle.setAttribute('aria-expanded', opening ? 'true' : 'false');
      if (opening) {
        searchInput.focus();
      } else {
        searchInput.value = '';
        self.render();
      }
    });
    searchInput.addEventListener('input', Utils.debounce(function(e) {
      self.render(e.target.value.toLowerCase().trim());
    }, 200));
    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        searchPanel.classList.add('hidden');
        searchToggle.setAttribute('aria-expanded', 'false');
        searchInput.value = '';
        self.render();
      }
    });

    this.load();
    this.applyResponsiveSidebar();
    if (typeof window.matchMedia !== 'undefined') {
      var mq = window.matchMedia('(min-width: 1024px)');
      var onBreak = function() {
        Sidebar.applyResponsiveSidebar();
      };
      if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', onBreak);
      } else if (mq.addListener) {
        mq.addListener(onBreak);
      }
    }
  },

  isDesktopCollapsed: function() {
    var s = document.getElementById('sidebar');
    return !!(s && s.classList.contains('is-collapsed'));
  },

  syncCollapseToggleButton: function() {
    var btn = document.getElementById('sidebar-collapse-toggle');
    if (!btn) return;
    var collapsed = this.isDesktopCollapsed();
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    var expand = collapsed ? 'Expand sidebar (show labels)' : 'Collapse sidebar (icons only)';
    btn.title = expand;
    btn.setAttribute('aria-label', expand);
  },

  applyDesktopCollapsedFromStorage: function() {
    try {
      if (localStorage.getItem('askmak-sidebar-collapsed') !== '1') return;
      var s = document.getElementById('sidebar');
      if (!s) return;
      s.classList.add('is-collapsed');
      var searchPanel = document.getElementById('chat-search-panel');
      var searchToggle = document.getElementById('search-chats-toggle');
      if (searchPanel) searchPanel.classList.add('hidden');
      if (searchToggle) searchToggle.setAttribute('aria-expanded', 'false');
    } catch (e) {}
  },

  setDesktopCollapsed: function(collapsed) {
    if (this.isDrawerViewport()) return;
    var s = document.getElementById('sidebar');
    if (!s) return;
    s.classList.toggle('is-collapsed', !!collapsed);
    try {
      localStorage.setItem('askmak-sidebar-collapsed', collapsed ? '1' : '0');
    } catch (e) {}
    this.syncCollapseToggleButton();
    if (collapsed) {
      var searchPanel = document.getElementById('chat-search-panel');
      var searchToggle = document.getElementById('search-chats-toggle');
      var searchInput = document.getElementById('chat-search');
      if (searchPanel) searchPanel.classList.add('hidden');
      if (searchToggle) searchToggle.setAttribute('aria-expanded', 'false');
      if (searchInput && searchInput.value) {
        searchInput.value = '';
        this.render();
      }
    }
  },

  toggleDesktopCollapsed: function() {
    if (this.isDrawerViewport()) return;
    this.setDesktopCollapsed(!this.isDesktopCollapsed());
  },

  /** Below lg breakpoint: sidebar uses display toggle (hidden drawer); desktop always shows sidebar. */
  isDrawerViewport: function() {
    return typeof window.matchMedia !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches;
  },

  applyResponsiveSidebar: function() {
    var s = document.getElementById('sidebar');
    var overlay = document.getElementById('sidebar-overlay');
    if (!s || !overlay) return;
    var wide = typeof window.matchMedia !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches;
    if (wide) {
      s.classList.remove('hidden');
      s.classList.remove('flex');
      s.style.transform = '';
      overlay.classList.add('hidden');
      s.setAttribute('aria-hidden', 'false');
      return;
    }
    overlay.classList.add('hidden');
    s.classList.add('hidden');
    s.classList.remove('flex');
    s.style.transform = '';
    s.setAttribute('aria-hidden', 'true');
  },

  toggle: function() {
    if (!this.isDrawerViewport()) return;
    var s = document.getElementById('sidebar');
    if (!s.classList.contains('hidden')) this.close();
    else this.open();
  },

  open: function() {
    if (!this.isDrawerViewport()) return;
    var s = document.getElementById('sidebar');
    var overlay = document.getElementById('sidebar-overlay');
    s.classList.remove('hidden');
    s.classList.add('flex');
    s.style.transform = '';
    overlay.classList.remove('hidden');
    s.setAttribute('aria-hidden', 'false');
  },

  close: function() {
    if (!this.isDrawerViewport()) return;
    var s = document.getElementById('sidebar');
    var overlay = document.getElementById('sidebar-overlay');
    s.classList.add('hidden');
    s.classList.remove('flex');
    s.style.transform = '';
    overlay.classList.add('hidden');
    s.setAttribute('aria-hidden', 'true');
  },

  clearAllHistory: async function() {
    if (!Auth.isAuthenticated()) {
      Chat.guestTurns = [];
      Chat.newChat();
      this.close();
      Utils.showToast('Conversation cleared (guest session)', 'success');
      return;
    }
    if (!this.chats.length) {
      Utils.showToast('No chats to clear', 'info');
      return;
    }
    var confirmed = await Utils.showConfirm(
      'Delete chat history',
      'This permanently deletes every chat and message in your history. You cannot undo this.'
    );
    if (!confirmed) return;

    try {
      await API.delete('/chats/all');
      this.chats = [];
      this.activeId = null;
      Chat.newChat();
      this.close();
      Utils.showToast('Chat history cleared', 'success');
    } catch (e) {
      Utils.showToast((e && e.message) || 'Failed to clear history', 'error');
    }
  },

  load: async function() {
    try {
      var result = await API.get('/chats');
      this.chats = result.chats || result || [];
    } catch (e) {
      this.chats = [];
    }
    this.render();
    this.syncGuestFooter();
  },

  render: function(filter) {
    var list = document.getElementById('chat-list');
    var groups = Utils.groupByDate(this.chats);
    var html = '';
    var self = this;
    var labels = { today: 'Today', yesterday: 'Yesterday', week: 'This week', older: 'Older' };

    Object.keys(groups).forEach(function(key) {
      var items = groups[key];
      if (filter) {
        items = items.filter(function(c) {
          return (c.title || '').toLowerCase().indexOf(filter) !== -1;
        });
      }
      if (!items.length) return;

      html += '<div class="sidebar-chat-group text-[10px] uppercase tracking-[0.12em] text-zinc-400 dark:text-white/30 px-2 pt-3 pb-1 mt-1 first:mt-0 first:pt-1 font-semibold select-none">' + labels[key] + '</div>';

      items.forEach(function(chat) {
        var isActive = chat.id === self.activeId;
        var activeClass = isActive
          ? ' text-mak-dark dark:text-white bg-zinc-200/90 dark:bg-mak-green/[0.14]'
          : '';
        var safeTitle = Utils.escapeHtml(chat.title || 'New chat').replace(/"/g, '&quot;');
        html += '<div class="sidebar-chat-row flex items-center gap-2 px-2 py-2 cursor-pointer text-[13px] text-zinc-600 hover:bg-zinc-200/50 hover:text-zinc-900 dark:text-white/65 dark:hover:bg-white/[0.04] dark:hover:text-white transition group relative' + activeClass + '" data-id="' + chat.id + '" title="' + safeTitle + '">';
        html += '<span class="shrink-0 text-zinc-400 group-hover:text-zinc-600 dark:text-white/30 dark:group-hover:text-white/45" aria-hidden="true">';
        html += '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
        html += '</span>';
        html += '<span class="chat-row-title truncate flex-1 min-w-0">' + Utils.escapeHtml(chat.title || 'New chat') + '</span>';
        html += '<button class="opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0 w-7 h-7 flex items-center justify-center text-zinc-500 hover:text-zinc-900 hover:bg-zinc-300/60 dark:text-white/35 dark:hover:text-white dark:hover:bg-white/[0.08] bg-transparent border-none cursor-pointer rounded-md transition chat-menu-btn" data-id="' + chat.id + '">';
        html += '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>';
        html += '</button></div>';
      });
    });

    if (!html) {
      if (filter) {
        if (this.chats.length) {
          html =
            '<div class="sidebar-empty-block text-center px-3 py-8">' +
            '<p class="text-sm text-zinc-500 dark:text-white/55">No matching chats</p>' +
            '<p class="text-xs text-zinc-400 dark:text-white/35 mt-1">Try another title.</p></div>';
        } else if (Auth.isAuthenticated()) {
          html =
            '<div class="sidebar-empty-block text-center px-3 py-8">' +
            '<p class="text-sm text-zinc-500 dark:text-white/55">No chats to search</p>' +
            '<p class="text-xs text-zinc-400 dark:text-white/35 mt-1">Start a conversation first.</p></div>';
        } else {
          html =
            '<div class="sidebar-empty-block text-center px-3 py-10">' +
            '<p class="text-sm text-zinc-500 dark:text-white/55">Guest chats are not saved</p>' +
            '<p class="text-xs text-zinc-400 dark:text-white/35 mt-2">History only appears when you\'re signed in—search won\'t show past threads for guests.</p>' +
            '</div>';
        }
      } else if (!Auth.isAuthenticated()) {
        html =
          '<div class="sidebar-empty-block text-center px-3 py-10">' +
          '<p class="text-sm text-zinc-500 dark:text-white/55">Guest chats are not saved</p>' +
          '<p class="text-xs text-zinc-400 dark:text-white/35 mt-2">History is only stored for signed-in accounts. Questions you ask as a guest stay in this browser until you refresh or leave.</p>' +
          '</div>';
      } else {
        html =
          '<div class="sidebar-empty-block text-center px-3 py-10">' +
          '<p class="text-sm text-zinc-500 dark:text-white/55">No conversations yet</p>' +
          '<p class="text-xs text-zinc-400 dark:text-white/35 mt-1">Start with New Chat.</p></div>';
      }
    }

    list.innerHTML = html;

    list.querySelectorAll('[data-id]').forEach(function(el) {
      if (el.classList.contains('chat-menu-btn')) return;
      el.addEventListener('click', function(e) {
        if (e.target.closest('.chat-menu-btn') || e.target.closest('.chat-dropdown')) return;
        self.select(el.dataset.id);
      });
    });

    list.querySelectorAll('.chat-menu-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        self.openMenu(btn, btn.dataset.id);
      });
    });
  },

  select: function(id) {
    this.activeId = id;
    this.close();
    this.render();
    Chat.loadChat(id);
  },

  openMenu: function(btn, chatId) {
    this.closeMenus();
    var dropdown = document.createElement('div');
    dropdown.className = 'chat-dropdown absolute right-0 top-full mt-1 bg-white dark:bg-chat-raised border border-gray-200 dark:border-chat-line rounded-lg shadow-xl z-50 min-w-[140px] p-1';
    dropdown.innerHTML =
      '<button class="flex items-center gap-2 w-full px-3 py-2 bg-transparent border-none rounded text-gray-700 dark:text-gray-200 text-[13px] cursor-pointer text-left hover:bg-gray-100 dark:hover:bg-mak-green/10 transition" data-action="rename">' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>' +
        'Rename</button>' +
      '<button class="flex items-center gap-2 w-full px-3 py-2 bg-transparent border-none rounded text-mak-red text-[13px] cursor-pointer text-left hover:bg-red-50 dark:hover:bg-red-950/20 transition" data-action="delete">' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>' +
        'Delete</button>';

    btn.closest('.relative').appendChild(dropdown);

    var self = this;
    dropdown.querySelector('[data-action="rename"]').addEventListener('click', function(e) {
      e.stopPropagation();
      self.startRename(chatId);
    });
    dropdown.querySelector('[data-action="delete"]').addEventListener('click', function(e) {
      e.stopPropagation();
      self.deleteChat(chatId);
    });

    setTimeout(function() {
      document.addEventListener('click', function handler() {
        self.closeMenus();
        document.removeEventListener('click', handler);
      });
    }, 10);
  },

  closeMenus: function() {
    document.querySelectorAll('.chat-dropdown').forEach(function(el) { el.remove(); });
  },

  startRename: function(chatId) {
    this.closeMenus();
    var chat = this.chats.find(function(c) { return c.id === chatId; });
    if (!chat) return;

    var el = document.querySelector('[data-id="' + chatId + '"]:not(.chat-menu-btn)');
    if (!el) return;

    var span = el.querySelector('.chat-row-title');
    var original = span.textContent;
    var input = document.createElement('input');
    input.type = 'text';
    input.value = original;
    input.className = 'w-full px-0 py-1 bg-transparent border-0 border-b border-zinc-300 text-zinc-900 text-[13px] outline-none focus:border-mak-green dark:border-white/15 dark:text-white dark:placeholder-white/35 dark:focus:border-mak-green/60 focus:ring-0 placeholder-zinc-400';

    span.replaceWith(input);
    input.focus();
    input.select();

    var self = this;
    function finish() {
      var newTitle = input.value.trim() || original;
      self.renameChat(chatId, newTitle);
    }

    input.addEventListener('blur', finish);
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = original; input.blur(); }
    });
  },

  renameChat: async function(chatId, title) {
    try {
      await API.patch('/chats/' + chatId, { title: title });
      var chat = this.chats.find(function(c) { return c.id === chatId; });
      if (chat) chat.title = title;
    } catch (e) {
      Utils.showToast('Failed to rename chat', 'error');
    }
    this.render();
  },

  deleteChat: async function(chatId) {
    this.closeMenus();
    var confirmed = await Utils.showConfirm('Delete chat', 'This chat and all its messages will be permanently deleted.');
    if (!confirmed) return;

    try {
      await API.delete('/chats/' + chatId);
      this.chats = this.chats.filter(function(c) { return c.id !== chatId; });
      if (this.activeId === chatId) {
        this.activeId = null;
        Chat.newChat();
      }
      this.render();
      Utils.showToast('Chat deleted', 'success');
    } catch (e) {
      Utils.showToast('Failed to delete chat', 'error');
    }
  },

  addChat: function(chat) {
    this.chats.unshift(chat);
    this.activeId = chat.id;
    this.render();
  },

  syncGuestFooter: function() {
    var link = document.getElementById('sidebar-sign-in');
    if (!link) return;
    if (Auth.isAuthenticated()) {
      link.classList.add('hidden');
    } else {
      link.classList.remove('hidden');
    }
  }
};

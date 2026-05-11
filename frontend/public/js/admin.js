(function() {
  var lastActivity = Date.now();
  var INACTIVITY_MS = 30 * 60 * 1000;
  var pollTimer = null;
  var charts = { conv: null, perf: null, hour: null };

  var adminUsersPager = { page: 1, limit: 100, q: '' };

  var BAR_HOUR_PALETTE = [
    '#00a651', '#0d9488', '#d97706', '#6366f1', '#db2777', '#0891b2', '#7c3aed', '#eab308',
    '#059669', '#f97316', '#8b5cf6', '#0ea5e9', '#e11d48', '#64748b', '#84cc16'
  ];

  var PERF_DONUT_COLORS = ['#00a651', '#0f766e', '#d97706', '#6366f1', '#be123c', '#7c3aed', '#0891b2'];

  function touch() { lastActivity = Date.now(); }

  function adminFetch(path, opts) {
    touch();
    opts = opts || {};
    opts.credentials = 'include';
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
      opts.headers = opts.headers || {};
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    return fetch('/api/admin' + path, opts).then(function(res) {
      if (res.status === 401) { window.location.href = '/login.html'; return Promise.reject(); }
      if (res.status === 403) { window.location.href = '/'; return Promise.reject(); }
      var ct = res.headers.get('content-type') || '';
      if (ct.indexOf('application/json') >= 0) return res.json().then(function(j) {
        if (!res.ok) throw new Error(j.error || 'Request failed');
        return j;
      });
      if (!res.ok) throw new Error('Request failed');
      return res.text();
    });
  }

  function destroyCharts() {
    ['conv', 'perf', 'hour'].forEach(function(k) {
      if (charts[k]) { charts[k].destroy(); charts[k] = null; }
    });
  }

  function setActiveNav(section) {
    document.querySelectorAll('.admin-nav').forEach(function(btn) {
      btn.removeAttribute('data-active');
      if (btn.getAttribute('data-section') === section) btn.setAttribute('data-active', 'true');
    });
    document.getElementById('section-title').textContent =
      { overview: 'Overview', escalations: 'Escalations', unresolved: 'Unresolved', users: 'Users',
        conversations: 'Conversations', feedback: 'Feedback', documents: 'Knowledge base',
        reference: 'Reference images', ingest: 'Ingestion', settings: 'Settings' }[section] || section;
  }

  function openModal(title, html) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('admin-modal').classList.remove('hidden');
  }

  function closeModal() {
    document.getElementById('admin-modal').classList.add('hidden');
  }

  function escBadge(n) {
    var el = document.getElementById('nav-esc-count');
    if (!el) return;
    if (n > 0) { el.textContent = String(n); el.classList.remove('hidden'); }
    else { el.classList.add('hidden'); }
  }

  function loadOverview() {
    destroyCharts();
    var main = document.getElementById('admin-main');
    main.innerHTML = '<div class="text-gray-500">Loading…</div>';
    Promise.all([
      adminFetch('/stats'),
      adminFetch('/stats/timeseries?days=30'),
      adminFetch('/stats/performance-overview'),
      adminFetch('/stats/messages-by-hour'),
      adminFetch('/activity/recent?limit=20')
    ]).then(function(results) {
      var s = results[0];
      var ts = results[1].points || [];
      var perfRaw = results[2].segments || [];
      var hours = results[3].hours || [];
      var activity = results[4].chats || [];
      escBadge(s.pending_escalations || 0);

      var cards = [
        { label: 'Chats today', v: s.conversations_today, tone: 'emerald' },
        { label: 'Chats (7d)', v: s.conversations_week, tone: 'teal' },
        { label: 'Chats (30d)', v: s.conversations_month, tone: 'cyan' },
        { label: 'Active users (7d)', v: s.active_users_7d, tone: 'amber' },
        { label: 'Guest sessions (7d)', v: s.guest_sessions_week, tone: 'violet' },
        {
          label: 'Pending escalations',
          v: s.pending_escalations,
          tone: (s.pending_escalations || 0) > 0 ? 'danger' : 'clear'
        },
        { label: 'Avg confidence today', v: s.avg_confidence_today != null ? s.avg_confidence_today.toFixed(3) : '—', tone: 'sky' },
        { label: 'Est. API cost (month)', v: '$' + (s.estimated_api_cost_month_usd || 0), tone: 'slate' }
      ];

      var html = '<div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">';
      cards.forEach(function(c) {
        html += '<div class="admin-stat-card" data-tone="' + Utils.escapeHtml(c.tone) + '">';
        html += '<div class="admin-stat-label">' + Utils.escapeHtml(c.label) + '</div>';
        html += '<div class="admin-stat-value">' + Utils.escapeHtml(String(c.v)) + '</div></div>';
      });
      html += '</div><div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">';
      html +=
        '<div class="admin-overview-panel flex flex-col">' +
          '<div class="admin-overview-chart-meta">' +
            '<h3 class="admin-overview-chart-title">Chat volume</h3>' +
            '<p class="admin-overview-chart-sub">New chats per day · trailing 30 days</p>' +
          '</div>' +
          '<div class="relative flex-1 min-h-[200px] lg:min-h-[220px]"><canvas id="chart-conv" aria-label="Chat volume chart"></canvas></div>' +
        '</div>';

      html +=
        '<div class="admin-overview-panel admin-overview-panel--accent flex flex-col">' +
          '<div class="admin-overview-chart-meta">' +
            '<h3 class="admin-overview-chart-title">Operational mix</h3>' +
            '<p class="admin-overview-chart-sub">Rolling 7 days · signed-in vs guest chats and message traffic</p>' +
          '</div>' +
          '<div class="relative flex-1 min-h-[210px] lg:min-h-[240px]"><canvas id="chart-perf" aria-label="Operations mix chart"></canvas></div>' +
        '</div>';

      html +=
        '<div class="admin-overview-panel admin-overview-panel--neutral flex flex-col">' +
          '<div class="admin-overview-chart-meta">' +
            '<h3 class="admin-overview-chart-title">Demand by hour</h3>' +
            '<p class="admin-overview-chart-sub">UTC · all messages aggregated over last 30 days</p>' +
          '</div>' +
          '<div class="relative flex-1 min-h-[200px] lg:min-h-[220px]"><canvas id="chart-hour" aria-label="Hourly demand chart"></canvas></div>' +
        '</div>';
      html +=
        '</div><h2 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 shrink-0">Recent activity</h2>';
      html += '<div class="admin-overview-activity thin-scroll admin-overview-activity--scroll">';
      if (!activity.length) html += '<div class="p-4 text-gray-500 text-sm admin-overview-activity-row">No chats yet</div>';
      activity.forEach(function(ch) {
        var who = ch.user_id ? (Utils.escapeHtml(ch.full_name || ch.email || 'User')) : 'Guest';
        var badge = ch.escalated ? '<span class="text-xs bg-mak-red/15 text-mak-red px-2 py-0.5 rounded">Escalated</span>' : '<span class="text-xs bg-mak-green/15 text-mak-green px-2 py-0.5 rounded">Active</span>';
        var prev = Utils.truncate(ch.first_message || '', 80);
        html += '<button type="button" class="admin-overview-activity-row w-full text-left p-3 flex gap-3 items-start admin-open-chat" data-id="' + ch.id + '">';
        html += '<div class="flex-1 min-w-0"><div class="flex items-center gap-2 mb-0.5"><span class="font-medium text-sm">' + Utils.escapeHtml(ch.title || 'Chat') + '</span>' + badge + '</div>';
        html += '<div class="text-xs text-gray-500">' + who + ' · ' + Utils.formatTime(ch.updated_at) + '</div>';
        html += '<div class="text-xs text-gray-600 dark:text-gray-400 mt-1">' + Utils.escapeHtml(prev) + '</div></div></button>';
      });
      html += '</div>';
      main.innerHTML = html;

      var labels = ts.map(function(p) { return p.d; });
      var data = ts.map(function(p) { return p.c; });

      charts.conv = new Chart(document.getElementById('chart-conv'), {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'New chats',
              data: data,
              borderColor: '#00a651',
              backgroundColor: 'rgba(0,166,81,0.07)',
              fill: true,
              tension: 0.28,
              pointRadius: 2,
              pointHoverRadius: 4
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
            y: { beginAtZero: true, ticks: { precision: 0 } }
          }
        }
      });

      var perfSlices = perfRaw.filter(function(seg) {
        return (seg.value || 0) > 0;
      });
      var donutLabels = perfSlices.map(function(x) {
        return x.label || '—';
      });
      var donutData = perfSlices.map(function(x) {
        return x.value;
      });
      var donutBg = donutLabels.map(function(_, i) {
        return PERF_DONUT_COLORS[i % PERF_DONUT_COLORS.length];
      });
      if (!donutData.length) {
        donutLabels = ['No activity (last 7 days)'];
        donutData = [1];
        donutBg = ['#94a3b8'];
      }

      charts.perf = new Chart(document.getElementById('chart-perf'), {
        type: 'doughnut',
        data: {
          labels: donutLabels,
          datasets: [
            {
              data: donutData,
              backgroundColor: donutBg,
              borderWidth: 0,
              hoverOffset: 8
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '58%',
          plugins: {
            legend: {
              position: 'bottom',
              labels: {
                padding: 10,
                usePointStyle: true,
                pointStyle: 'circle',
                boxWidth: 8,
                font: { size: 11 }
              }
            }
          }
        }
      });

      var hLabels = hours.map(function(h) {
        return String(h.h).padStart(2, '0') + ':00';
      });
      var hData = hours.map(function(h) {
        return h.c;
      });
      var hColors = hData.map(function(_, i) {
        return BAR_HOUR_PALETTE[i % BAR_HOUR_PALETTE.length];
      });

      charts.hour = new Chart(document.getElementById('chart-hour'), {
        type: 'bar',
        data: {
          labels: hLabels,
          datasets: [
            {
              label: 'Messages logged',
              data: hData,
              backgroundColor: hColors,
              borderRadius: 5,
              borderSkipped: false
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: true,
              position: 'top',
              labels: { font: { size: 11 } }
            },
            tooltip: {
              callbacks: {
                label: function(ctx) {
                  var v =
                    ctx.parsed && typeof ctx.parsed.y === 'number'
                      ? ctx.parsed.y
                      : typeof ctx.raw === 'number'
                        ? ctx.raw
                        : ctx.formattedValue;
                  return ' ' + v + ' messages';
                }
              }
            }
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { maxRotation: 45, minRotation: 0, font: { size: 10 } }
            },
            y: {
              beginAtZero: true,
              ticks: { precision: 0 }
            }
          }
        }
      });

      main.querySelectorAll('.admin-open-chat').forEach(function(btn) {
        btn.addEventListener('click', function() { openConversationModal(btn.getAttribute('data-id')); });
      });
    }).catch(function() { main.innerHTML = '<p class="text-mak-red">Failed to load overview</p>'; });
  }

  function openConversationModal(id) {
    adminFetch('/conversations/' + id).then(function(d) {
      var msgs = d.messages || [];
      var html = '<div class="space-y-2">';
      msgs.forEach(function(m) {
        var role = m.role;
        var bubble = role === 'user' ? 'bg-mak-green/15' : role === 'assistant' ? 'bg-gray-100 dark:bg-gray-800' : 'bg-mak-gold/10';
        html += '<div class="rounded-lg p-2 ' + bubble + '"><span class="text-xs font-semibold uppercase text-gray-500">' + role + '</span>';
        html += '<div class="prose prose-sm prose-sans dark:prose-invert max-w-none">' + (role === 'assistant' ? Utils.renderMarkdown(m.content || '') : Utils.escapeHtml(m.content || '')) + '</div>';
        if (m.image_url) html += '<img src="' + Utils.escapeHtml(m.image_url) + '" class="mt-2 max-h-40 rounded cursor-pointer" onclick="Utils.openLightbox(this.src)">';
        html += '</div>';
      });
      html += '</div>';
      openModal(d.chat.title || 'Conversation', html);
    }).catch(function() { Utils.showToast('Failed to load chat', 'error'); });
  }

  function loadEscalations(statusFilter) {
    var main = document.getElementById('admin-main');
    main.innerHTML = 'Loading…';
    var qs = '/escalations?limit=50';
    if (statusFilter) qs += '&status=' + encodeURIComponent(statusFilter);
    adminFetch(qs).then(function(d) {
      var rows = d.escalations || [];
      var html = '<div class="flex flex-wrap gap-2 mb-4"><select id="esc-filter" class="border rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700">';
      ['', 'pending', 'in_progress', 'resolved', 'dismissed'].forEach(function(s) {
        var sel = statusFilter === s ? ' selected' : '';
        html += '<option value="' + s + '"' + sel + '>' + (s || 'All statuses') + '</option>';
      });
      html += '</select></div><div class="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"><table class="min-w-full text-sm"><thead><tr class="border-b border-gray-200 dark:border-gray-800 text-left text-gray-500">';
      html += '<th class="p-3">Date</th><th class="p-3">User</th><th class="p-3">Category</th><th class="p-3">Title / Preview</th><th class="p-3">Status</th><th class="p-3"></th></tr></thead><tbody>';
      rows.forEach(function(e) {
        var who = e.user_email || e.user_name || 'Guest';
        var category = e.category || 'Chat';
        var titleOrPreview = e.title || Utils.truncate(e.message_content || '', 60);
        html += '<tr class="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50">';
        html += '<td class="p-3 whitespace-nowrap text-xs">' + Utils.formatTime(e.created_at) + '</td>';
        html += '<td class="p-3 text-xs">' + Utils.escapeHtml(who) + '</td>';
        html += '<td class="p-3 text-xs"><span class="px-2 py-0.5 rounded-full bg-mak-green/10 text-mak-green text-[10px] font-semibold uppercase">' + Utils.escapeHtml(category) + '</span></td>';
        html += '<td class="p-3 max-w-xs truncate text-xs" title="' + Utils.escapeHtml(titleOrPreview) + '">' + Utils.escapeHtml(titleOrPreview) + '</td>';
        html += '<td class="p-3"><span class="text-[10px] px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 uppercase font-bold">' + e.status + '</span></td>';
        html += '<td class="p-3 text-right"><button type="button" class="text-mak-green text-xs font-semibold admin-esc-open" data-id="' + e.id + '">View</button></td></tr>';
      });
      html += '</tbody></table></div>';
      if (!rows.length) html = '<p class="text-gray-500">No escalations</p>';
      main.innerHTML = html;
      var selEl = document.getElementById('esc-filter');
      if (selEl) selEl.addEventListener('change', function() { loadEscalations(selEl.value || null); });
      main.querySelectorAll('.admin-esc-open').forEach(function(btn) {
        btn.addEventListener('click', function() { openEscalationDetail(btn.getAttribute('data-id')); });
      });
      adminFetch('/stats').then(function(s) { escBadge(s.pending_escalations || 0); }).catch(function() {});
    }).catch(function() { main.innerHTML = '<p class="text-mak-red">Failed to load</p>'; });
  }

  function openEscalationDetail(id) {
    adminFetch('/escalations/' + id).then(function(d) {
      var esc = d.escalation;
      var msgs = d.messages || [];
      var html = '<div class="mb-4 p-3 bg-gray-50 dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 space-y-1">';
      if (esc.user_email) html += '<p class="text-xs"><strong>User Email:</strong> ' + Utils.escapeHtml(esc.user_email) + '</p>';
      if (esc.category) html += '<p class="text-xs"><strong>Category:</strong> ' + Utils.escapeHtml(esc.category) + '</p>';
      if (esc.title) html += '<p class="text-xs"><strong>Inquiry Title:</strong> ' + Utils.escapeHtml(esc.title) + '</p>';
      html += '<p class="text-xs"><strong>Reason:</strong> ' + Utils.escapeHtml(esc.reason || '—') + '</p>';
      html += '</div>';

      if (msgs.length) {
        html += '<div class="space-y-2 max-h-[40vh] overflow-y-auto thin-scroll mb-4">';
        msgs.forEach(function(m) {
          var hl = m.id === esc.message_id ? ' ring-2 ring-mak-red/50' : '';
          html += '<div class="rounded-lg p-2 bg-gray-50 dark:bg-gray-950' + hl + '"><span class="text-[10px] uppercase font-bold text-gray-500">' + m.role + '</span>';
          html += '<div class="text-xs leading-relaxed">' + (m.role === 'assistant' ? Utils.renderMarkdown(m.content || '') : Utils.escapeHtml(m.content || '')) + '</div></div>';
        });
        html += '</div>';
      }

      html += '<div class="mt-4 space-y-3 border-t border-gray-200 dark:border-gray-700 pt-4">';
      html += '<textarea id="esc-admin-note" rows="4" class="w-full border rounded-lg p-3 text-sm bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 focus:ring-2 focus:ring-mak-green/20 focus:border-mak-green outline-none transition" placeholder="Write the answer here... This will be emailed to the user and published to the Knowledge Base."></textarea>';
      html += '<div class="flex flex-wrap gap-2">';
      html += '<button type="button" class="admin-esc-patch px-4 py-2.5 rounded-lg bg-mak-green text-white text-sm font-semibold shadow-sm hover:opacity-90 transition" data-id="' + id + '" data-status="resolved">Resolve & Publish</button>';
      html += '<button type="button" class="admin-esc-patch px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium hover:bg-gray-50 transition" data-id="' + id + '" data-status="in_progress">Mark In Progress</button>';
      html += '<button type="button" class="admin-esc-patch px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium hover:bg-red-50 hover:text-red-600 transition" data-id="' + id + '" data-status="dismissed">Dismiss</button>';
      html += '</div></div>';
      openModal('Escalation', html);
      document.querySelectorAll('.admin-esc-patch').forEach(function(b) {
        b.addEventListener('click', function() {
          var st = b.getAttribute('data-status');
          var note = document.getElementById('esc-admin-note');
          var body = { status: st };
          if (note && note.value.trim()) body.admin_response = note.value.trim();
          adminFetch('/escalations/' + b.getAttribute('data-id'), { method: 'PATCH', body: body }).then(function() {
            Utils.showToast('Updated', 'success');
            closeModal();
            loadEscalations(null);
          }).catch(function(e) { Utils.showToast(e.message || 'Failed', 'error'); });
        });
      });
    });
  }

  function loadUnresolved() {
    var main = document.getElementById('admin-main');
    adminFetch('/unresolved?limit=100').then(function(d) {
      var items = d.items || [];
      var html = '<p class="text-sm text-gray-500 mb-4">Assistant messages with low confidence or hedge phrases.</p>';
      html += '<div class="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"><table class="min-w-full text-sm"><thead><tr class="border-b text-left text-gray-500"><th class="p-3">When</th><th class="p-3">User</th><th class="p-3">Excerpt</th><th class="p-3">Conf</th><th class="p-3"></th></tr></thead><tbody>';
      items.forEach(function(m) {
        var who = m.full_name || m.email || 'Guest';
        html += '<tr class="border-b border-gray-100 dark:border-gray-800"><td class="p-3 whitespace-nowrap">' + Utils.formatTime(m.created_at) + '</td>';
        html += '<td class="p-3">' + Utils.escapeHtml(who) + '</td>';
        html += '<td class="p-3 max-w-md truncate">' + Utils.escapeHtml(Utils.truncate(m.content || '', 100)) + '</td>';
        html += '<td class="p-3">' + (m.confidence_score != null ? m.confidence_score.toFixed(2) : '—') + '</td>';
        html += '<td class="p-3 space-x-2 whitespace-nowrap"><button type="button" class="text-mak-green text-xs admin-open-chat" data-id="' + m.chat_id + '">Chat</button>';
        html += '<button type="button" class="text-xs text-gray-600 dark:text-gray-400 admin-unres-dismiss" data-mid="' + m.id + '">Dismiss</button>';
        html += '<button type="button" class="text-xs text-mak-red admin-unres-esc" data-mid="' + m.id + '">Escalate</button></td></tr>';
      });
      html += '</tbody></table></div>';
      if (!items.length) html = '<p class="text-gray-500">No unresolved items detected</p>';
      main.innerHTML = html;
      main.querySelectorAll('.admin-open-chat').forEach(function(btn) {
        btn.addEventListener('click', function() { openConversationModal(btn.getAttribute('data-id')); });
      });
      main.querySelectorAll('.admin-unres-dismiss').forEach(function(btn) {
        btn.addEventListener('click', function() {
          adminFetch('/unresolved/' + btn.getAttribute('data-mid'), { method: 'PATCH', body: { action: 'dismiss' } }).then(function() {
            Utils.showToast('Dismissed', 'success');
            loadUnresolved();
          }).catch(function(e) { Utils.showToast(e.message || 'Failed', 'error'); });
        });
      });
      main.querySelectorAll('.admin-unres-esc').forEach(function(btn) {
        btn.addEventListener('click', function() {
          adminFetch('/unresolved/' + btn.getAttribute('data-mid'), { method: 'PATCH', body: { action: 'escalate' } }).then(function() {
            Utils.showToast('Escalation created', 'success');
            loadUnresolved();
          }).catch(function(e) { Utils.showToast(e.message || 'Failed', 'error'); });
        });
      });
    }).catch(function() { main.innerHTML = '<p class="text-mak-red">Failed</p>'; });
  }

  function adminUsersBadgeRole(role) {
    var r = String(role || 'student').toLowerCase();
    if (r === 'admin') {
      return '<span class="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold uppercase tracking-wide bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 ring-1 ring-emerald-500/25">Admin</span>';
    }
    return '<span class="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold uppercase tracking-wide bg-slate-500/10 text-slate-700 dark:text-slate-300 ring-1 ring-slate-500/15">Student</span>';
  }

  function adminUsersBadgeVerified(ok) {
    if (ok) {
      return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/12 text-emerald-800 dark:text-emerald-200 ring-1 ring-emerald-500/20"><svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75 9 17.25 19.5 6.75"/></svg>Verified</span>';
    }
    return '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/12 text-amber-900 dark:text-amber-200 ring-1 ring-amber-500/25">Pending</span>';
  }

  function loadUsers() {
    var main = document.getElementById('admin-main');
    main.innerHTML =
      '<div class="animate-pulse space-y-5">' +
      '<div class="h-36 rounded-2xl bg-gradient-to-br from-emerald-100/50 to-transparent dark:from-mak-green/15 dark:to-transparent"></div>' +
      '<div class="h-52 rounded-2xl bg-gray-100/90 dark:bg-gray-800/60"></div></div>';

    var qs =
      '?page=' +
      adminUsersPager.page +
      '&limit=' +
      adminUsersPager.limit +
      (adminUsersPager.q ? '&q=' + encodeURIComponent(adminUsersPager.q) : '');

    adminFetch('/users' + qs)
      .then(function(d) {
        var rows = d.users || [];
        var total = typeof d.total === 'number' ? d.total : 0;
        var page = d.page || 1;
        var limit = d.limit || adminUsersPager.limit;
        var sum = d.summary || {};
        var totalPages = Math.max(1, Math.ceil(total / limit));
        var fromIx = total ? (page - 1) * limit + 1 : 0;
        var toIx = Math.min(page * limit, total);

        var html = '<div class="admin-users space-y-6">';

        html += '<div class="relative overflow-hidden rounded-2xl border border-emerald-200/55 dark:border-mak-green/20 bg-gradient-to-br from-white via-emerald-50/40 to-white dark:from-gray-900 dark:via-mak-green/[0.07] dark:to-gray-950 shadow-lg shadow-emerald-900/[0.06]">';
        html += '<div class="absolute -right-16 -top-20 h-48 w-48 rounded-full bg-mak-green/10 blur-3xl pointer-events-none" aria-hidden="true"></div>';
        html += '<div class="relative p-5 sm:p-6 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">';
        html += '<div class="min-w-0 flex-1">';
        html +=
          '<p class="admin-kb-eyebrow text-[11px] font-semibold uppercase tracking-[0.14em] text-mak-green/90 mb-1">Directory</p>';
        html += '<h2 class="text-xl sm:text-2xl font-bold text-mak-dark dark:text-white tracking-tight">Registered users</h2>';
        html +=
          '<p class="mt-2 text-sm text-gray-600 dark:text-gray-400 max-w-xl leading-relaxed">Everyone who signed up for AskMak. Search by name or email; open a row for chats and memories. Totals below include every account in the database.</p>';
        html += '</div>';
        html += '<div class="flex flex-wrap gap-2 sm:flex-col sm:items-end">';
        html +=
          '<span class="inline-flex items-center gap-2 rounded-xl bg-emerald-500/[0.1] px-4 py-2.5 ring-1 ring-emerald-500/20"><span class="text-2xl font-bold tabular-nums text-mak-dark dark:text-white">' +
          String(sum.total_registered != null ? sum.total_registered : total) +
          '</span><span class="text-[11px] font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400 leading-tight">accounts</span></span>';
        html += '</div></div>';

        html += '<div class="relative grid grid-cols-2 lg:grid-cols-4 gap-3 px-5 sm:px-6 pb-5 sm:pb-6">';
        var statCards = [
          { label: 'Verified email', val: sum.verified },
          { label: 'Awaiting verify', val: sum.pending_verification },
          { label: 'Administrators', val: sum.admins },
          { label: 'This page', val: rows.length }
        ];
        statCards.forEach(function(sc, i) {
          var muted = i === 3;
          html +=
            '<div class="rounded-xl border px-4 py-3 ' +
            (muted
              ? 'border-emerald-200/40 dark:border-mak-green/15 bg-emerald-50/30 dark:bg-mak-green/[0.04]'
              : 'border-gray-200/80 dark:border-gray-700 bg-white/80 dark:bg-gray-900/50') +
            '">';
          html +=
            '<p class="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">' +
            Utils.escapeHtml(sc.label) +
            '</p>';
          html +=
            '<p class="mt-1 text-lg font-semibold tabular-nums text-mak-dark dark:text-white">' +
            Utils.escapeHtml(String(sc.val != null ? sc.val : '—')) +
            '</p></div>';
        });
        html += '</div></div>';

        html +=
          '<div class="flex flex-col sm:flex-row sm:flex-wrap gap-3 sm:items-center sm:justify-between rounded-2xl border border-gray-200/90 dark:border-gray-700 bg-white/90 dark:bg-gray-900/70 px-4 py-3 shadow-sm">';
        html += '<div class="flex flex-1 min-w-0 gap-2 items-center">';
        html +=
          '<label class="sr-only" for="admin-users-search">Search users</label><div class="relative flex-1 min-w-0 max-w-md">';
        html +=
          '<span class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-4.35-4.35M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z"/></svg></span>';
        html +=
          '<input id="admin-users-search" type="search" autocomplete="off" placeholder="Search name or email…" value="' +
          Utils.escapeHtml(adminUsersPager.q) +
          '" class="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 py-2.5 pl-9 pr-3 text-sm text-mak-dark dark:text-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-mak-green/35 focus:border-mak-green/40"></div>';
        html +=
          '<button type="button" id="admin-users-search-btn" class="shrink-0 rounded-xl bg-mak-green hover:bg-[#009149] text-white text-sm font-semibold px-4 py-2.5 shadow-sm shadow-mak-green/25 transition border-none cursor-pointer">Search</button>';
        html += '</div>';
        html += '<div class="text-sm text-gray-600 dark:text-gray-400 tabular-nums">';
        if (adminUsersPager.q) {
          html +=
            Utils.escapeHtml(String(total)) +
            ' match' +
            (total === 1 ? '' : 'es') +
            (total ? ' · rows ' + fromIx + '–' + toIx : '');
        } else {
          html += total ? 'Rows ' + fromIx + '–' + toIx + ' · ' + total + ' listed on this slice' : 'No accounts yet';
        }
        html += '</div></div>';

        html +=
          '<div class="overflow-x-auto rounded-2xl border border-gray-200/90 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-md shadow-emerald-900/[0.04] ring-1 ring-black/[0.03] dark:ring-white/[0.04]">';
        html +=
          '<table class="admin-users-table min-w-full text-sm"><thead><tr class="border-b border-gray-200 dark:border-gray-800 bg-emerald-50/50 dark:bg-mak-green/[0.06] text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">';
        html +=
          '<th class="px-4 py-3.5 whitespace-nowrap">Member</th><th class="px-4 py-3.5 whitespace-nowrap">Email</th><th class="px-4 py-3.5 whitespace-nowrap">Role</th><th class="px-4 py-3.5 whitespace-nowrap">Status</th><th class="px-4 py-3.5 whitespace-nowrap">Joined</th><th class="px-4 py-3.5 whitespace-nowrap">Last active</th><th class="px-4 py-3.5 whitespace-nowrap text-right">Chats</th><th class="px-4 py-3.5 whitespace-nowrap text-right">Actions</th></tr></thead><tbody>';

        if (!rows.length) {
          html +=
            '<tr><td colspan="8" class="px-6 py-16 text-center text-gray-500 dark:text-gray-400">' +
            (adminUsersPager.q
              ? 'No users match <strong class="text-mak-dark dark:text-white">' +
                Utils.escapeHtml(adminUsersPager.q) +
                '</strong>. Try another search.'
              : 'No registered users yet. New signups will appear here.') +
            '</td></tr>';
        } else {
          rows.forEach(function(u) {
            html +=
              '<tr class="admin-users-table-row border-b border-gray-100 dark:border-gray-800/90 last:border-0 hover:bg-emerald-50/40 dark:hover:bg-mak-green/[0.04] transition-colors">';
            html += '<td class="px-4 py-3.5 font-medium text-mak-dark dark:text-white">' + Utils.escapeHtml(u.full_name || '—') + '</td>';
            html +=
              '<td class="px-4 py-3.5 text-gray-700 dark:text-gray-300 max-w-[14rem] truncate" title="' +
              Utils.escapeHtml(u.email || '') +
              '">' +
              Utils.escapeHtml(u.email || '') +
              '</td>';
            html += '<td class="px-4 py-3.5">' + adminUsersBadgeRole(u.role) + '</td>';
            html += '<td class="px-4 py-3.5">' + adminUsersBadgeVerified(u.email_verified) + '</td>';
            html +=
              '<td class="px-4 py-3.5 whitespace-nowrap text-gray-600 dark:text-gray-400 text-xs">' +
              Utils.escapeHtml(Utils.formatTime(u.created_at)) +
              '</td>';
            html +=
              '<td class="px-4 py-3.5 whitespace-nowrap text-gray-600 dark:text-gray-400 text-xs">' +
              (u.last_active ? Utils.escapeHtml(Utils.formatTime(u.last_active)) : '—') +
              '</td>';
            html +=
              '<td class="px-4 py-3.5 text-right tabular-nums font-medium text-mak-dark dark:text-white">' +
              String(u.chat_count != null ? u.chat_count : 0) +
              '</td>';
            html += '<td class="px-4 py-3.5 text-right whitespace-nowrap space-x-2">';
            html +=
              '<button type="button" class="inline-flex items-center rounded-lg border border-emerald-200 dark:border-mak-green/30 bg-emerald-50/80 dark:bg-mak-green/10 px-2.5 py-1.5 text-xs font-semibold text-mak-green hover:bg-emerald-100 dark:hover:bg-mak-green/20 cursor-pointer admin-user-open" data-id="' +
              u.id +
              '">View</button>';
            if (u.role !== 'admin') {
              html +=
                '<button type="button" class="inline-flex items-center rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50/80 dark:bg-red-950/30 px-2.5 py-1.5 text-xs font-semibold text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-950/50 cursor-pointer admin-user-del" data-id="' +
                u.id +
                '">Delete</button>';
            }
            html += '</td></tr>';
          });
        }
        html += '</tbody></table></div>';

        if (total > limit || page > 1) {
          html += '<div class="flex flex-col sm:flex-row items-center justify-between gap-4 pt-1">';
          html +=
            '<p class="text-xs text-gray-500 dark:text-gray-400 order-2 sm:order-1">Page <span class="font-semibold text-mak-dark dark:text-white">' +
            page +
            '</span> of <span class="font-semibold">' +
            totalPages +
            '</span></p>';
          html += '<div class="flex gap-2 order-1 sm:order-2">';
          html +=
            '<button type="button" id="admin-users-prev" class="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-2 text-sm font-medium text-mak-dark dark:text-white hover:bg-emerald-50 dark:hover:bg-mak-green/10 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"' +
            (page <= 1 ? ' disabled' : '') +
            '>Previous</button>';
          html +=
            '<button type="button" id="admin-users-next" class="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-2 text-sm font-medium text-mak-dark dark:text-white hover:bg-emerald-50 dark:hover:bg-mak-green/10 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"' +
            (page >= totalPages ? ' disabled' : '') +
            '>Next</button>';
          html += '</div></div>';
        }

        html += '</div>';
        main.innerHTML = html;

        var searchIn = document.getElementById('admin-users-search');
        function runSearch() {
          adminUsersPager.q = searchIn ? String(searchIn.value || '').trim() : '';
          adminUsersPager.page = 1;
          loadUsers();
        }
        var sb = document.getElementById('admin-users-search-btn');
        if (sb) sb.addEventListener('click', runSearch);
        if (searchIn) {
          searchIn.addEventListener('keydown', function(ev) {
            if (ev.key === 'Enter') {
              ev.preventDefault();
              runSearch();
            }
          });
        }

        var prev = document.getElementById('admin-users-prev');
        if (prev)
          prev.addEventListener('click', function() {
            if (adminUsersPager.page > 1) {
              adminUsersPager.page--;
              loadUsers();
            }
          });
        var next = document.getElementById('admin-users-next');
        if (next)
          next.addEventListener('click', function() {
            adminUsersPager.page++;
            loadUsers();
          });

        main.querySelectorAll('.admin-user-open').forEach(function(btn) {
          btn.addEventListener('click', function() {
            adminFetch('/users/' + btn.getAttribute('data-id')).then(function(ud) {
              var u = ud.user;
              var chats = ud.chats || [];
              var memN = (ud.memories || []).length;
              var fb = ud.feedback || {};
              var mh = '<div class="space-y-4 text-mak-dark dark:text-gray-100">';
              mh +=
                '<div><p class="text-lg font-semibold">' +
                Utils.escapeHtml(u.full_name || '') +
                '</p><p class="text-sm text-mak-green font-medium">' +
                Utils.escapeHtml(u.email || '') +
                '</p></div>';
              mh +=
                '<div class="flex flex-wrap gap-2">' +
                adminUsersBadgeRole(u.role) +
                ' ' +
                adminUsersBadgeVerified(u.email_verified) +
                '</div>';
              mh +=
                '<dl class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs border border-gray-200 dark:border-gray-700 rounded-xl p-3 bg-gray-50/80 dark:bg-gray-950/40">';
              mh +=
                '<div><dt class="text-gray-500 dark:text-gray-400 uppercase tracking-wide font-semibold">Joined</dt><dd class="font-medium">' +
                Utils.escapeHtml(Utils.formatTime(u.created_at)) +
                '</dd></div>';
              mh +=
                '<div><dt class="text-gray-500 dark:text-gray-400 uppercase tracking-wide font-semibold">Saved memories</dt><dd class="font-medium">' +
                String(memN) +
                '</dd></div>';
              mh +=
                '<div><dt class="text-gray-500 dark:text-gray-400 uppercase tracking-wide font-semibold">Chats (loaded)</dt><dd class="font-medium">' +
                String(chats.length) +
                ' recent</dd></div>';
              mh +=
                '<div><dt class="text-gray-500 dark:text-gray-400 uppercase tracking-wide font-semibold">Feedback</dt><dd class="font-medium">' +
                (fb.up || 0) +
                ' up · ' +
                (fb.down || 0) +
                ' down</dd></div></dl>';
              if (chats.length) {
                mh += '<div><p class="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-2">Recent chats</p><ul class="space-y-1.5 max-h-40 overflow-y-auto thin-scroll text-xs">';
                chats.slice(0, 12).forEach(function(ch) {
                  mh +=
                    '<li class="flex justify-between gap-2 border-b border-gray-100 dark:border-gray-800 pb-1">' +
                    '<span class="truncate">' +
                    Utils.escapeHtml(ch.title || 'Chat') +
                    '</span>' +
                    '<span class="shrink-0 text-gray-400">' +
                    Utils.escapeHtml(Utils.formatTime(ch.updated_at)) +
                    '</span></li>';
                });
                mh += '</ul></div>';
              }
              mh += '</div>';
              openModal('User profile', mh);
            });
          });
        });
        main.querySelectorAll('.admin-user-del').forEach(function(btn) {
          btn.addEventListener('click', function() {
            if (!confirm('Delete this user? This removes their chats and linked data.')) return;
            adminFetch('/users/' + btn.getAttribute('data-id'), { method: 'DELETE' }).then(function() {
              Utils.showToast('Deleted', 'success');
              var tp = typeof total === 'number' ? total : 0;
              if (tp > 1 && rows.length === 1 && adminUsersPager.page > 1) adminUsersPager.page--;
              loadUsers();
            }).catch(function(e) { Utils.showToast(e.message || 'Failed', 'error'); });
          });
        });
      })
      .catch(function() {
        main.innerHTML =
          '<p class="rounded-xl border border-red-200 bg-red-50 dark:bg-red-950/40 dark:border-red-900/40 p-6 text-red-800 dark:text-red-200 font-medium">Could not load users. Check network and permissions, then reopen this section.</p>';
      });
  }

  function loadConversations() {
    var main = document.getElementById('admin-main');
    adminFetch('/conversations?limit=50').then(function(d) {
      var rows = d.conversations || [];
      var html = '<div class="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"><table class="min-w-full text-sm"><thead><tr class="border-b text-left text-gray-500">';
      html += '<th class="p-3">Updated</th><th class="p-3">Title</th><th class="p-3">Who</th><th class="p-3">Msgs</th><th class="p-3"></th></tr></thead><tbody>';
      rows.forEach(function(c) {
        var who = c.user_id ? (c.full_name || c.email || 'User') : 'Guest';
        html += '<tr class="border-b border-gray-100 dark:border-gray-800"><td class="p-3 whitespace-nowrap">' + Utils.formatTime(c.updated_at) + '</td>';
        html += '<td class="p-3">' + Utils.escapeHtml(c.title || '') + '</td><td class="p-3">' + Utils.escapeHtml(who) + '</td>';
        html += '<td class="p-3">' + (c.message_count || 0) + '</td>';
        html += '<td class="p-3"><button type="button" class="text-mak-green text-xs admin-open-chat" data-id="' + c.id + '">View</button></td></tr>';
      });
      html += '</tbody></table></div>';
      main.innerHTML = html;
      main.querySelectorAll('.admin-open-chat').forEach(function(btn) {
        btn.addEventListener('click', function() { openConversationModal(btn.getAttribute('data-id')); });
      });
    }).catch(function() { main.innerHTML = '<p class="text-mak-red">Failed</p>'; });
  }

  function loadFeedback() {
    var main = document.getElementById('admin-main');
    adminFetch('/feedback?limit=100').then(function(d) {
      var rows = d.feedback || [];
      var html = '<button type="button" id="fb-export" class="inline-block mb-4 text-sm text-mak-green font-medium hover:underline bg-transparent border-none cursor-pointer p-0">Download CSV</button>';
      html += '<div class="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"><table class="min-w-full text-sm"><thead><tr class="border-b text-left text-gray-500">';
      html += '<th class="p-3">Date</th><th class="p-3">Rating</th><th class="p-3">Preview</th></tr></thead><tbody>';
      rows.forEach(function(f) {
        html += '<tr class="border-b border-gray-100 dark:border-gray-800"><td class="p-3">' + Utils.formatTime(f.created_at) + '</td>';
        html += '<td class="p-3">' + (f.rating ? 'Up' : 'Down') + '</td>';
        html += '<td class="p-3 truncate max-w-md">' + Utils.escapeHtml(Utils.truncate(f.message_preview || '', 80)) + '</td></tr>';
      });
      html += '</tbody></table></div>';
      main.innerHTML = html;
      var ex = document.getElementById('fb-export');
      if (ex) ex.addEventListener('click', function() {
        fetch('/api/admin/feedback/export', { credentials: 'include' }).then(function(res) {
          if (!res.ok) throw new Error('Export failed');
          return res.blob();
        }).then(function(blob) {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'askmak-feedback.csv';
          a.click();
          URL.revokeObjectURL(a.href);
        }).catch(function() { Utils.showToast('Export failed', 'error'); });
      });
    }).catch(function() { main.innerHTML = '<p class="text-mak-red">Failed</p>'; });
  }

  function loadDocuments() {
    var main = document.getElementById('admin-main');

    function kbAttrQuotes(s) {
      return Utils.escapeHtml(String(s)).replace(/"/g, '&quot;');
    }

    function loadKbWithQuery(searchQuery) {
      var qTrim = typeof searchQuery === 'string' ? searchQuery.trim() : '';
      adminFetch('/documents?limit=50&q=' + encodeURIComponent(qTrim)).then(function(d) {
      var rows = d.documents || [];
      var totalKb = typeof d.total === 'number' ? d.total : rows.length;
      var listLimit = typeof d.limit === 'number' ? d.limit : 50;
      var tableCaption =
        totalKb > rows.length
          ? 'Showing ' + rows.length + ' of ' + totalKb + ' chunks'
          : rows.length === 1
            ? '1 chunk in the index'
            : rows.length + ' chunks in the index';

      var html = '<div class="admin-kb">';
      html += '<header class="admin-kb-hero">';
      html += '<div class="admin-kb-hero__main">';
      html += '<p class="admin-kb-eyebrow">Retrieval &amp; answers</p>';
      html += '<h2 class="admin-kb-title">Knowledge base</h2>';
      html +=
        '<p class="admin-kb-lede">Add text entries or upload PDFs. Content is chunked, embedded with OpenAI, and matched when users ask questions.</p>';
      html += '</div>';
      html += '<div class="admin-kb-hero__stat" title="Total chunks in the database">';
      html += '<span class="admin-kb-hero__stat-value">' + totalKb + '</span>';
      html += '<span class="admin-kb-hero__stat-label">indexed chunk' + (totalKb === 1 ? '' : 's') + '</span>';
      html += '</div></header>';

      html += '<div class="admin-kb-panels">';
      html += '<article class="admin-kb-panel">';
      html += '<div class="admin-kb-panel__head">';
      html +=
        '<span class="admin-kb-panel__icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.875v-1.5a3.375 3.375 0 0 1 3.375-3.375h1.125c.621 0 1.125.504 1.125 1.125v3.375c0 .621-.504 1.125-1.125 1.125h-2.25c-.621 0-1.125-.504-1.125-1.125Zm-6.75 0v-2.625A3.375 3.375 0 0 0 9.375 8.25h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 1 3.375-3.375H9.75"/></svg></span>';
      html += '<div><h3 class="admin-kb-panel__title">Manual entry</h3>';
      html += '<p class="admin-kb-panel__desc">One title and body become one or more searchable chunks.</p></div></div>';
      html += '<div class="admin-kb-panel__body">';
      html += '<div class="admin-kb-field"><label class="admin-kb-label" for="doc-title">Title</label>';
      html +=
        '<input id="doc-title" type="text" autocomplete="off" placeholder="e.g. How do I defer a semester?" class="admin-kb-input"></div>';
      html += '<div class="admin-kb-field"><label class="admin-kb-label" for="doc-body">Content</label>';
      html +=
        '<textarea id="doc-body" rows="5" placeholder="Full answer or article text…" class="admin-kb-textarea"></textarea></div>';
      html += '<div class="admin-kb-field"><label class="admin-kb-label" for="doc-cat">Category</label>';
      html +=
        '<input id="doc-cat" type="text" autocomplete="off" placeholder="faq, admissions, fees, it… (default faq)" class="admin-kb-input"></div>';
      html += '</div>';
      html += '<button type="button" id="doc-save" class="admin-kb-btn admin-kb-btn--primary">Save &amp; embed</button>';
      html += '</article>';

      html += '<article class="admin-kb-panel">';
      html += '<div class="admin-kb-panel__head">';
      html +=
        '<span class="admin-kb-panel__icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.875v-1.5a3.375 3.375 0 0 1 3.375-3.375h9.75A3.375 3.375 0 0 1 22.125 6v9.75a3.375 3.375 0 0 1-3.375 3.375h-9.75a3.375 3.375 0 0 1-3.375-3.375V6Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M4.875 6.75h4.875a1.875 1.875 0 0 1 1.875 1.875v9.75a1.875 1.875 0 0 1-1.875 1.875H4.875A1.875 1.875 0 0 1 3 18.375v-9.75A1.875 1.875 0 0 1 4.875 6.75Z"/></svg></span>';
      html += '<div><h3 class="admin-kb-panel__title">Upload PDF</h3>';
      html +=
        '<p class="admin-kb-panel__desc">Text is extracted and split automatically. Image-only PDFs need OCR elsewhere first.</p></div></div>';
      html += '<div class="admin-kb-panel__body">';
      html += '<div class="admin-kb-field"><label class="admin-kb-label" for="doc-pdf-file">PDF file</label>';
      html += '<input id="doc-pdf-file" type="file" accept="application/pdf,.pdf" class="admin-kb-input admin-kb-input--file"></div>';
      html += '<div class="admin-kb-field"><label class="admin-kb-label" for="doc-pdf-title">Title <span class="admin-kb-optional">optional</span></label>';
      html +=
        '<input id="doc-pdf-title" type="text" autocomplete="off" placeholder="Uses PDF metadata or filename if empty" class="admin-kb-input"></div>';
      html += '<div class="admin-kb-field"><label class="admin-kb-label" for="doc-pdf-cat">Category</label>';
      html +=
        '<input id="doc-pdf-cat" type="text" autocomplete="off" placeholder="default faq" class="admin-kb-input"></div>';
      html += '</div>';
      html += '<button type="button" id="doc-pdf-upload" class="admin-kb-btn admin-kb-btn--secondary">Upload PDF &amp; embed</button>';
      html += '</article></div>';

      html += '<div class="admin-kb-tips" role="note">';
      html += '<span class="admin-kb-tips__icon" aria-hidden="true">';
      html +=
        '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z"/></svg>';
      html += '</span>';
      html += '<ul class="admin-kb-tips__list">';
      html += '<li>Embedding can take a few seconds; wait for the confirmation toast.</li>';
      html += '<li>Manual and PDF chunks show <strong>Edit</strong>; crawled pages are delete-only here.</li>';
      html += '<li>Large PDFs create many rows—delete one part at a time, or rely on ingestion for bulk refresh.</li>';
      html += '</ul></div>';

      html += '<section class="admin-kb-index admin-kb-section" aria-labelledby="admin-kb-index-heading">';
      html += '<div class="admin-kb-index__head">';
      html += '<div><h3 id="admin-kb-index-heading" class="admin-kb-index__title">Indexed chunks</h3>';
      html += '<p class="admin-kb-index__meta">Up to ' + listLimit + ' newest · ' + Utils.escapeHtml(tableCaption) + '</p></div>';
      html += '</div>';
      html += '<div class="admin-kb-index__toolbar" role="search">';
      html += '<span id="admin-kb-search-desc" class="admin-kb-index__toolbar-label">Find in index</span>';
      html += '<div class="admin-kb-search-field">';
      html +=
        '<input id="admin-kb-search" type="search" class="admin-kb-search-input" placeholder="Title or chunk text…" autocomplete="off" aria-describedby="admin-kb-search-desc" value="' +
        kbAttrQuotes(qTrim) +
        '"></div>';
      html += '<button type="button" id="admin-kb-search-go" class="admin-kb-search-go">Search</button>';
      html += '</div>';
      html += '<div class="admin-kb-table-scroll thin-scroll">';
      html += '<table class="admin-kb-table"><thead><tr>';
      html += '<th class="admin-kb-th admin-kb-col-title">Title</th>';
      html += '<th class="admin-kb-th admin-kb-col-preview">Preview</th>';
      html += '<th class="admin-kb-th admin-kb-col-cat">Category</th>';
      html += '<th class="admin-kb-th admin-kb-col-src">Source</th>';
      html += '<th class="admin-kb-th admin-kb-col-actions"><span class="sr-only">Actions</span></th></tr></thead><tbody>';

      if (!rows.length) {
        var emptyMsg =
          qTrim
            ? 'No chunks match your search. Try another keyword or clear the filter.'
            : 'No chunks yet. Add a manual entry or upload a PDF to get started.';
        html += '<tr><td colspan="5"><div class="admin-kb-empty">' + emptyMsg + '</div></td></tr>';
      } else {
        rows.forEach(function(r) {
          var rawTitle = String(r.title || '');
          var rawCat = String(r.category || '');
          var rawSrc = String(r.source_url || '');
          var prev = String(r.content_preview || '').trim();
          var titleHtml = Utils.escapeHtml(rawTitle);
          var catHtml = Utils.escapeHtml(rawCat);
          var srcHtml = Utils.escapeHtml(rawSrc);
          var previewHtml = prev ? Utils.escapeHtml(Utils.truncate(prev, 140)) : '<span class="admin-kb-preview-placeholder">—</span>';
          var titleAttr = titleHtml.replace(/"/g, '&quot;');
          var catAttr = catHtml.replace(/"/g, '&quot;');
          var srcAttr = srcHtml.replace(/"/g, '&quot;');
          var srcPlain = rawSrc;
          var canEdit = (r.metadata && r.metadata.manual) ||
            (rawSrc && (srcPlain.indexOf('manual://') === 0 || srcPlain.indexOf('manual-pdf://') === 0));
          html += '<tr class="admin-kb-tr">';
          html += '<td class="admin-kb-td admin-kb-col-title"><span class="admin-kb-ellipsis" title="' + titleAttr + '">' + titleHtml + '</span></td>';
          html +=
            '<td class="admin-kb-td admin-kb-col-preview"><span class="admin-kb-preview-snippet admin-kb-ellipsis" title="' +
            kbAttrQuotes(prev) +
            '">' +
            previewHtml +
            '</span></td>';
          html +=
            '<td class="admin-kb-td admin-kb-col-cat"><span class="admin-kb-pill" title="' + catAttr + '">' +
            (catHtml || '—') +
            '</span></td>';
          html += '<td class="admin-kb-td admin-kb-col-src"><span class="admin-kb-ellipsis admin-kb-mono" title="' + srcAttr + '">' + srcHtml + '</span></td>';
          html += '<td class="admin-kb-td admin-kb-col-actions"><div class="admin-kb-row-actions">';
          if (canEdit) {
            html +=
              '<button type="button" class="admin-kb-iconbtn admin-kb-iconbtn--edit admin-doc-edit" data-id="' +
              Utils.escapeHtml(String(r.id)) +
              '">Edit</button>';
          }
          html +=
        '<button type="button" class="admin-kb-iconbtn admin-kb-iconbtn--danger admin-doc-del" data-id="' +
            Utils.escapeHtml(String(r.id)) +
            '">Delete</button>';
          html += '</div></td></tr>';
        });
      }

      html += '</tbody></table></div></section></div>';
      main.innerHTML = html;

      document.getElementById('doc-save').addEventListener('click', function() {
        var title = document.getElementById('doc-title').value.trim();
        var content = document.getElementById('doc-body').value.trim();
        var category = document.getElementById('doc-cat').value.trim() || 'faq';
        if (!title || !content) { Utils.showToast('Title and content required', 'error'); return; }
        adminFetch('/documents', { method: 'POST', body: { title: title, content: content, category: category } }).then(function() {
          Utils.showToast('Saved', 'success');
          loadDocuments();
        }).catch(function(e) { Utils.showToast(e.message || 'Failed', 'error'); });
      });
      document.getElementById('doc-pdf-upload').addEventListener('click', function() {
        var fileInput = document.getElementById('doc-pdf-file');
        var f = fileInput && fileInput.files && fileInput.files[0];
        if (!f) { Utils.showToast('Choose a PDF file', 'error'); return; }
        var fd = new FormData();
        fd.append('file', f);
        var pt = document.getElementById('doc-pdf-title').value.trim();
        if (pt) fd.append('title', pt);
        var pcat = document.getElementById('doc-pdf-cat').value.trim() || 'faq';
        fd.append('category', pcat);
        var btn = document.getElementById('doc-pdf-upload');
        btn.disabled = true;
        adminFetch('/documents/upload-pdf', { method: 'POST', body: fd }).then(function(j) {
          Utils.showToast('Added ' + (j.inserted || 0) + ' chunk(s)', 'success');
          fileInput.value = '';
          loadDocuments();
        }).catch(function(e) { Utils.showToast(e.message || 'Failed', 'error'); })
          .finally(function() { btn.disabled = false; });
      });

      function runKbSearch() {
        var inp = document.getElementById('admin-kb-search');
        loadKbWithQuery(inp ? inp.value : '');
      }

      document.getElementById('admin-kb-search-go').addEventListener('click', runKbSearch);
      var searchEl = document.getElementById('admin-kb-search');
      if (searchEl) {
        searchEl.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') { e.preventDefault(); runKbSearch(); }
        });
      }

      main.querySelectorAll('.admin-doc-edit').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var id = btn.getAttribute('data-id');
          adminFetch('/documents/' + id).then(function(d) {
            var doc = d.document;
            var mh = '<div class="admin-kb-form-stack text-sm">';
            mh += '<div class="admin-kb-field"><label class="admin-kb-label" for="edit-doc-title">Title</label>';
            mh +=
              '<input id="edit-doc-title" type="text" class="admin-kb-input" value="' +
              Utils.escapeHtml(doc.title || '') +
              '"></div>';
            mh += '<div class="admin-kb-field"><label class="admin-kb-label" for="edit-doc-cat">Category</label>';
            mh +=
              '<input id="edit-doc-cat" type="text" class="admin-kb-input" value="' +
              Utils.escapeHtml(doc.category || '') +
              '"></div>';
            mh += '<div class="admin-kb-field"><label class="admin-kb-label" for="edit-doc-body">Content</label>';
            mh +=
              '<textarea id="edit-doc-body" rows="12" class="admin-kb-textarea">' +
              Utils.escapeHtml(doc.content || '') +
              '</textarea></div>';
            mh += '<button type="button" id="edit-doc-save" class="admin-kb-btn admin-kb-btn--primary">Save &amp; re-embed</button></div>';
            openModal('Edit document', mh);
            document.getElementById('edit-doc-save').addEventListener('click', function() {
              var body = {
                title: document.getElementById('edit-doc-title').value.trim(),
                content: document.getElementById('edit-doc-body').value.trim(),
                category: document.getElementById('edit-doc-cat').value.trim() || 'faq'
              };
              if (!body.title || !body.content) { Utils.showToast('Title and content required', 'error'); return; }
              adminFetch('/documents/' + id, { method: 'PUT', body: body }).then(function() {
                Utils.showToast('Updated', 'success');
                closeModal();
                loadDocuments();
              }).catch(function(e) { Utils.showToast(e.message || 'Failed', 'error'); });
            });
          }).catch(function() { Utils.showToast('Failed to load', 'error'); });
        });
      });
      main.querySelectorAll('.admin-doc-del').forEach(function(btn) {
        btn.addEventListener('click', function() {
          if (!confirm('Delete this chunk?')) return;
          adminFetch('/documents/' + btn.getAttribute('data-id'), { method: 'DELETE' }).then(function() {
            loadKbWithQuery(qTrim);
          });
        });
      });
      }).catch(function() { main.innerHTML = '<p class="text-mak-red">Failed</p>'; });
    }

    loadKbWithQuery('');
  }

  function loadReference() {
    var main = document.getElementById('admin-main');
    adminFetch('/reference-images').then(function(d) {
      var imgs = d.images || [];
      var html = '<form id="ref-form" class="mb-6 flex flex-wrap gap-2 items-end rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4">';
      html += '<div><label class="text-xs text-gray-500">Image</label><input type="file" name="image" accept="image/*" required class="block text-sm"></div>';
      html += '<div><label class="text-xs text-gray-500">Category</label><input name="category" value="maps" class="border rounded px-2 py-1 text-sm w-28 bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700"></div>';
      html += '<div><label class="text-xs text-gray-500">Name</label><input name="name" placeholder="campus_map" class="border rounded px-2 py-1 text-sm w-36 bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700"></div>';
      html += '<button type="submit" class="px-4 py-2 rounded-lg bg-mak-green text-white text-sm">Upload</button></form>';
      html += '<div class="grid grid-cols-2 md:grid-cols-4 gap-3">';
      imgs.forEach(function(im) {
        html += '<div class="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden bg-white dark:bg-gray-900">';
        if (im.url) html += '<img src="' + Utils.escapeHtml(im.url) + '" class="w-full h-28 object-cover cursor-pointer" onclick="Utils.openLightbox(this.src)">';
        html += '<div class="p-2 text-xs flex flex-col gap-1"><span class="truncate text-gray-600 dark:text-gray-400" title="' + Utils.escapeHtml(im.key) + '">' + Utils.escapeHtml(im.display_name || im.key) + '</span>';
        html += '<div class="flex justify-end gap-2"><button type="button" class="text-mak-green shrink-0 admin-ref-edit" data-key="' + Utils.escapeHtml(im.key) + '">Edit meta</button>';
        html += '<button type="button" class="text-mak-red shrink-0 admin-ref-del" data-key="' + Utils.escapeHtml(im.key) + '">×</button></div></div></div>';
      });
      html += '</div>';
      if (!imgs.length) html += '<p class="text-gray-500 text-sm">No reference images yet</p>';
      main.innerHTML = html;
      var form = document.getElementById('ref-form');
      if (form) form.addEventListener('submit', function(ev) {
        ev.preventDefault();
        var fd = new FormData(form);
        fetch('/api/admin/reference-images', { method: 'POST', body: fd, credentials: 'include' }).then(function(res) {
          if (!res.ok) return res.json().then(function(j) { throw new Error(j.error); });
          return res.json();
        }).then(function() { Utils.showToast('Uploaded', 'success'); loadReference(); })
          .catch(function(e) { Utils.showToast(e.message || 'Failed', 'error'); });
      });
      main.querySelectorAll('.admin-ref-edit').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var key = btn.getAttribute('data-key');
          var im = imgs.filter(function(x) { return x.key === key; })[0] || {};
          var tagsStr = Array.isArray(im.tags) ? im.tags.join(', ') : (im.tags ? String(im.tags) : '');
          var mh = '<div class="space-y-2 text-sm"><p class="text-xs text-gray-500 break-all">' + Utils.escapeHtml(key) + '</p>';
          mh += '<label class="block text-xs text-gray-500">Display name</label><input id="ref-meta-name" class="w-full border rounded-lg px-3 py-2 bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700" value="' + Utils.escapeHtml(im.display_name || '') + '">';
          mh += '<label class="block text-xs text-gray-500 mt-2">Category</label><input id="ref-meta-cat" class="w-full border rounded-lg px-3 py-2 bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700" value="' + Utils.escapeHtml(im.category || '') + '">';
          mh += '<label class="block text-xs text-gray-500 mt-2">Description</label><textarea id="ref-meta-desc" rows="3" class="w-full border rounded-lg px-3 py-2 bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700">' + Utils.escapeHtml(im.description || '') + '</textarea>';
          mh += '<label class="block text-xs text-gray-500 mt-2">Tags (comma-separated)</label><input id="ref-meta-tags" class="w-full border rounded-lg px-3 py-2 bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700" value="' + Utils.escapeHtml(tagsStr) + '">';
          mh += '<button type="button" id="ref-meta-save" class="mt-2 w-full py-2 rounded-lg bg-mak-green text-white text-sm font-medium">Save metadata</button></div>';
          openModal('Reference image', mh);
          document.getElementById('ref-meta-save').addEventListener('click', function() {
            var rawTags = document.getElementById('ref-meta-tags').value.split(',').map(function(t) { return t.trim(); }).filter(Boolean);
            adminFetch('/reference-images/' + encodeURIComponent(key), {
              method: 'PUT',
              body: {
                display_name: document.getElementById('ref-meta-name').value.trim() || null,
                category: document.getElementById('ref-meta-cat').value.trim() || null,
                description: document.getElementById('ref-meta-desc').value.trim() || null,
                tags: rawTags
              }
            }).then(function() {
              Utils.showToast('Saved', 'success');
              closeModal();
              loadReference();
            }).catch(function(e) { Utils.showToast(e.message || 'Failed', 'error'); });
          });
        });
      });
      main.querySelectorAll('.admin-ref-del').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var key = btn.getAttribute('data-key');
          if (!confirm('Delete?')) return;
          adminFetch('/reference-images/' + encodeURIComponent(key), { method: 'DELETE' }).then(function() { loadReference(); });
        });
      });
    }).catch(function() { main.innerHTML = '<p class="text-mak-red">Failed</p>'; });
  }

  function loadIngest() {
    var main = document.getElementById('admin-main');

    function statusClass(st) {
      var s = String(st || '').toLowerCase();
      if (s === 'completed' || s === 'complete' || s === 'done') return 'admin-ingest-status--done';
      if (s === 'started' || s === 'running') return 'admin-ingest-status--run';
      return 'admin-ingest-status--muted';
    }

    function formatStatsSnippet(stats) {
      if (stats == null) return '';
      var o = stats;
      if (typeof stats === 'string') {
        try { o = JSON.parse(stats); } catch (e) { return ''; }
      }
      if (typeof o !== 'object' || o === null) return '';
      var parts = [];
      if (o.chunksCreated != null) parts.push(Utils.escapeHtml(String(o.chunksCreated)) + ' chunks');
      if (o.errors != null && Number(o.errors) > 0) parts.push(Utils.escapeHtml(String(o.errors)) + ' err.');
      return parts.length ? '<span class="admin-ingest-dates">' + parts.join(' · ') + '</span>' : '';
    }

    adminFetch('/ingest/status').then(function(d) {
      var chunks = d.document_chunks != null ? d.document_chunks : 0;
      var runs = d.runs || [];

      var html = '<div class="admin-ingest">';
      html += '<header class="admin-ingest-hero">';
      html += '<div class="admin-ingest-hero__main">';
      html += '<p class="admin-ingest-kicker">Pipeline</p>';
      html += '<h2 class="admin-ingest-title">Web &amp; file ingestion</h2>';
      html +=
        '<p class="admin-ingest-lede">Runs the full crawler and embedding script in the background. Expect several minutes and OpenAI embedding usage.</p>';
      html += '</div>';
      html += '<div class="admin-ingest-actions">';
      html +=
        '<div class="admin-ingest-stat-card" title="Document chunks stored for retrieval">';
      html += '<span class="admin-ingest-stat-value">' + chunks + '</span>';
      html += '<span class="admin-ingest-stat-label">chunks in DB</span></div>';
      html += '</div>';
      html += '</header>';

      html += '<section class="admin-ingest-panel" aria-labelledby="admin-ingest-start-heading">';
      html += '<h3 id="admin-ingest-start-heading" class="admin-ingest-panel-title">Bulk refresh</h3>';
      html += '<p class="admin-ingest-panel-sub">Start a new run. Recent activity appears below.</p>';
      html += '<div class="flex flex-wrap items-center gap-3">';
      html += '<button type="button" id="btn-ingest" class="admin-ingest-btn">Start ingestion</button>';
      html += '<span class="admin-ingest-hint">Uses ingest.js · status rows update after the script finishes.</span>';
      html += '</div></section>';

      html += '<section class="admin-ingest-panel" aria-labelledby="admin-ingest-runs-heading">';
      html += '<h3 id="admin-ingest-runs-heading" class="admin-ingest-panel-title">Recent runs</h3>';
      html += '<p class="admin-ingest-panel-sub">Newest first (last ' + Utils.escapeHtml(String(runs.length)) + ')</p>';

      if (!runs.length) {
        html += '<p class="admin-ingest-empty">No ingestion history yet.</p>';
      } else {
        html += '<div role="list">';
        runs.forEach(function(r) {
          var badgeClass = statusClass(r.status);
          var src = Utils.escapeHtml(String(r.source || '—'));
          var stDisp = Utils.escapeHtml(String(r.status || ''));
          var started = Utils.formatDate(r.started_at);
          var finished =
            r.finished_at ?
              Utils.formatDate(r.finished_at) :
              null;
          var timeLine =
            Utils.escapeHtml(started) + (finished ? ' → ' + Utils.escapeHtml(finished) : '');
          html += '<div class="admin-ingest-row" role="listitem">';
          html += '<span class="admin-ingest-row-time">' + timeLine + '</span>';
          html += '<span class="admin-ingest-status ' + badgeClass + '">' + stDisp + '</span>';
          html += '<span class="admin-ingest-row-main">' + src + '</span>';
          html += formatStatsSnippet(r.stats);
          html += '</div>';
        });
        html += '</div>';
      }
      html += '</section></div>';

      main.innerHTML = html;

      document.getElementById('btn-ingest').addEventListener('click', function() {
        var b = document.getElementById('btn-ingest');
        b.disabled = true;
        adminFetch('/ingest', { method: 'POST', body: { source: 'all' } })
          .then(function() {
            Utils.showToast('Ingestion started in background', 'success');
            loadIngest();
          })
          .catch(function(e) {
            Utils.showToast(e.message || 'Failed', 'error');
          })
          .finally(function() {
            var btn = document.getElementById('btn-ingest');
            if (btn) btn.disabled = false;
          });
      });
    }).catch(function() { main.innerHTML = '<p class="text-mak-red">Failed</p>'; });
  }

  function loadSettings() {
    var main = document.getElementById('admin-main');
    adminFetch('/settings').then(function(d) {
      var s = d.settings || {};
      function pickStr(v) { return v == null ? '' : String(v); }
      function pickNum(v, def) {
        if (v == null || v === '') return def;
        if (typeof v === 'number' && !isNaN(v)) return Math.round(v);
        var n = parseInt(String(v), 10);
        return isNaN(n) ? def : n;
      }
      function pickFloat(v, def) {
        if (v == null || v === '') return def;
        if (typeof v === 'number' && !isNaN(v)) return v;
        var f = parseFloat(String(v));
        return isNaN(f) ? def : f;
      }
      function pickBool(v, def) {
        if (v === true || v === 'true') return true;
        if (v === false || v === 'false') return false;
        return def;
      }

      var prompt = pickStr(s.system_prompt);
      var guestRate = pickNum(s.guest_rate_limit, 20);
      var authRate = pickNum(s.auth_rate_limit, 100);
      var confidence = pickFloat(s.confidence_escalation_threshold, 0.65);
      var maxTool = pickNum(s.max_tool_depth, 3);
      var guestRetention = pickNum(s.guest_chat_retention_days, 30);
      var guestEnabled = pickBool(s.guest_mode_enabled, true);
      var domains = pickStr(s.allowed_fetch_domains) || '*.mak.ac.ug';

      var schemaMissing = !!(d.note && String(d.note).indexOf('admin_schema') >= 0);

      var html = '<div class="admin-settings">';
      html += '<div class="admin-settings-hero"><div>';
      html += '<h2>Platform settings</h2>';
      html += '<p>Configure prompts, safeguards, guest access, and tool limits stored in your database.</p>';
      if (schemaMissing) {
        html += '<p class="admin-settings-warning">' + Utils.escapeHtml(d.note || '') + '</p>';
      }
      html += '</div><span class="admin-settings-badge">Admin</span></div>';

      html += '<div class="admin-settings-grid">';
      html += '<section class="admin-settings-card admin-settings-card--full">';
      html += '<h3>Assistant persona</h3>';
      html += '<div class="admin-settings-field"><label for="set-prompt">System prompt</label>';
      html +=
        '<textarea id="set-prompt" class="admin-settings-textarea admin-settings-textarea--prompt" rows="6">' +
        Utils.escapeHtml(prompt) +
        '</textarea>';
      html += '<p class="admin-settings-hint">Base instructions injected for every AskMak reply. Tone, scope (Makerere-only), escalation rules, etc.</p></div></section>';

      html += '<section class="admin-settings-card">';
      html += '<h3>Message rate limits</h3>';
      html += '<div class="admin-settings-row admin-settings-row--2">';
      html += '<div class="admin-settings-field"><label for="set-guest">Guest messages per hour</label>';
      html += '<input id="set-guest" type="number" min="1" max="9999" class="admin-settings-input" value="' + guestRate + '">';
      html += '<p class="admin-settings-hint">Per guest token / session cap before slowdown.</p></div>';
      html += '<div class="admin-settings-field"><label for="set-auth">Signed-in messages per hour</label>';
      html += '<input id="set-auth" type="number" min="1" max="9999" class="admin-settings-input" value="' + authRate + '">';
      html += '<p class="admin-settings-hint">Per authenticated user.</p></div></div></section>';

      html += '<section class="admin-settings-card">';
      html += '<h3>Quality & tooling</h3>';
      html += '<div class="admin-settings-field"><label for="set-confidence">Escalation confidence threshold</label>';
      html += '<input id="set-confidence" type="number" min="0" max="1" step="0.01" class="admin-settings-input" value="' + confidence + '">';
      html += '<p class="admin-settings-hint">0–1. Below this retrieval confidence suggests staff review / escalation workflows.</p></div>';
      html += '<div class="admin-settings-field"><label for="set-max-tool">Max tool recursion depth</label>';
      html += '<input id="set-max-tool" type="number" min="1" max="12" class="admin-settings-input" value="' + maxTool + '">';
      html += '<p class="admin-settings-hint">How deeply chained tool calls may run.</p></div></section>';

      html += '<section class="admin-settings-card">';
      html += '<h3>Guest experience</h3>';
      html += '<label class="admin-settings-check" for="set-guest-enabled">';
      html += '<input type="checkbox" id="set-guest-enabled"' + (guestEnabled ? ' checked' : '') + '>';
      html += '<span><strong>Guest mode</strong> Allow chats without signing in (subject to retention and hourly caps).</span></label>';
      html += '<div class="admin-settings-field admin-settings-field--spaced"><label for="set-guest-retention">Guest chat retention (days)</label>';
      html += '<input id="set-guest-retention" type="number" min="1" max="730" class="admin-settings-input" value="' + guestRetention + '">';
      html += '<p class="admin-settings-hint">How long anonymised guest threads are retained for support.</p></div></section>';

      html += '<section class="admin-settings-card">';
      html += '<h3>Fetching & URLs</h3>';
      html += '<div class="admin-settings-field"><label for="set-domains">Allowed fetch domain pattern</label>';
      html += '<input id="set-domains" type="text" autocomplete="off" class="admin-settings-input" value="' + Utils.escapeHtml(domains) + '" placeholder="*.mak.ac.ug">';
      html += '<p class="admin-settings-hint">Wildcard pattern restricting outbound page fetches.</p></div></section>';

      html += '<section class="admin-settings-card admin-settings-card--full admin-settings-card--muted">';
      html += '<h3>Environment (read-only)</h3>';
      html += '<p class="admin-settings-note">API keys and network endpoints are configured in <code>.env</code>; chat models listed here mirror the running server.</p>';
      html += '<dl class="admin-settings-env">';
      html += '<dt>Chat model</dt><dd>' + Utils.escapeHtml(d.openai_model || '—') + '</dd>';
      html += '<dt>Embedding model</dt><dd>' + Utils.escapeHtml(d.embedding_model || '—') + '</dd>';
      html += '</dl></section></div>';

      html += '<div class="admin-settings-actions">';
      html += '<button type="button" id="set-save" class="admin-settings-save">Save all settings</button>';
      html += '<span class="admin-settings-save-hint">Updates apply on the next request.</span></div></div>';

      main.innerHTML = html;

      document.getElementById('set-save').addEventListener('click', function() {
        var gr = parseInt(document.getElementById('set-guest').value, 10);
        var ar = parseInt(document.getElementById('set-auth').value, 10);
        var conf = parseFloat(document.getElementById('set-confidence').value);
        var mtd = parseInt(document.getElementById('set-max-tool').value, 10);
        var gret = parseInt(document.getElementById('set-guest-retention').value, 10);
        if (isNaN(gr) || gr < 1) { Utils.showToast('Guest rate must be ≥ 1', 'error'); return; }
        if (isNaN(ar) || ar < 1) { Utils.showToast('Auth rate must be ≥ 1', 'error'); return; }
        if (isNaN(conf) || conf < 0 || conf > 1) { Utils.showToast('Confidence must be between 0 and 1', 'error'); return; }
        if (isNaN(mtd) || mtd < 1) { Utils.showToast('Tool depth must be ≥ 1', 'error'); return; }
        if (isNaN(gret) || gret < 1) { Utils.showToast('Retention must be ≥ 1 day', 'error'); return; }
        var domVal = document.getElementById('set-domains').value.trim();
        if (!domVal) { Utils.showToast('Domain pattern required', 'error'); return; }
        var payload = {
          system_prompt: document.getElementById('set-prompt').value,
          guest_rate_limit: gr,
          auth_rate_limit: ar,
          confidence_escalation_threshold: conf,
          max_tool_depth: mtd,
          guest_chat_retention_days: gret,
          guest_mode_enabled: document.getElementById('set-guest-enabled').checked,
          allowed_fetch_domains: domVal
        };
        adminFetch('/settings', { method: 'PUT', body: payload }).then(function() {
          Utils.showToast('Saved', 'success');
          loadSettings();
        }).catch(function(e) { Utils.showToast(e.message || 'Failed', 'error'); });
      });
    }).catch(function() { main.innerHTML = '<p class="text-mak-red">Failed</p>'; });
  }

  function loadSection(name) {
    setActiveNav(name);
    destroyCharts();
    if (name === 'overview') loadOverview();
    else if (name === 'escalations') loadEscalations(null);
    else if (name === 'unresolved') loadUnresolved();
    else if (name === 'users') loadUsers();
    else if (name === 'conversations') loadConversations();
    else if (name === 'feedback') loadFeedback();
    else if (name === 'documents') loadDocuments();
    else if (name === 'reference') loadReference();
    else if (name === 'ingest') loadIngest();
    else if (name === 'settings') loadSettings();
  }

  function poll() {
    adminFetch('/stats').then(function(s) { escBadge(s.pending_escalations || 0); }).catch(function() {});
  }

  function init() {
    fetch('/api/auth/me', { credentials: 'include' }).then(function(r) {
      if (!r.ok) { window.location.href = '/login.html'; return; }
      return r.json();
    }).then(function(data) {
      if (
        !data ||
        !data.user ||
        String(data.user.role || '')
          .trim()
          .toLowerCase() !== 'admin'
      ) {
        window.location.href = '/';
        return;
      }
      var displayName = data.user.full_name || data.user.email || 'Admin';
      document.getElementById('admin-user-label').textContent = displayName;
      var av = document.getElementById('admin-user-avatar');
      if (av) av.textContent = (displayName.trim().charAt(0) || '?').toUpperCase();
      document.querySelectorAll('.admin-nav').forEach(function(btn) {
        btn.addEventListener('click', function() { loadSection(btn.getAttribute('data-section')); });
      });
      document.getElementById('admin-logout-header').addEventListener('click', function() {
        fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).then(function() {
          window.location.href = '/';
        });
      });
      document.getElementById('modal-close').addEventListener('click', closeModal);
      document.getElementById('admin-modal').addEventListener('click', function(e) { if (e.target.id === 'admin-modal') closeModal(); });
      document.getElementById('sidebar-open').addEventListener('click', function() {
        document.getElementById('admin-sidebar').classList.remove('-translate-x-full');
        document.getElementById('sidebar-overlay').classList.remove('hidden');
      });
      document.getElementById('sidebar-close').addEventListener('click', function() {
        document.getElementById('admin-sidebar').classList.add('-translate-x-full');
        document.getElementById('sidebar-overlay').classList.add('hidden');
      });
      document.getElementById('sidebar-overlay').addEventListener('click', function() {
        document.getElementById('admin-sidebar').classList.add('-translate-x-full');
        document.getElementById('sidebar-overlay').classList.add('hidden');
      });
      var tt = document.getElementById('theme-toggle-admin');
      if (tt) tt.addEventListener('click', function() { Theme.toggle(); });
      ['mousemove', 'keydown', 'click'].forEach(function(ev) {
        document.addEventListener(ev, touch, true);
      });
      setInterval(function() {
        if (Date.now() - lastActivity > INACTIVITY_MS) {
          fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).finally(function() {
            window.location.href = '/login.html';
          });
        }
      }, 60000);
      pollTimer = setInterval(poll, 60000);
      loadSection('overview');
    }).catch(function() { window.location.href = '/login.html'; });
  }

  document.addEventListener('DOMContentLoaded', init);
})();

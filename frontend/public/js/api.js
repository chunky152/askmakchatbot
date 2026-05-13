var API = {
  baseUrl: '/api',

  async request(method, url, data, isFormData) {
    var options = {
      method: method,
      headers: {},
      credentials: 'include'
    };

    if (data && !isFormData) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(data);
    } else if (data && isFormData) {
      options.body = data;
    }

    var response = await fetch(this.baseUrl + url, options);

    if (response.status === 401) {
      var path = window.location.pathname;
      var publicPages = [
        '/login.html',
        '/signup.html',
        '/forgot-password.html',
        '/reset-password.html',
        '/',
        '/index.html',
        '/verify.html',
        '/chat.html'
      ];
      if (publicPages.indexOf(path) === -1) {
        window.location.href = '/login.html';
        throw { status: 401, message: 'Unauthorized' };
      }
    }

    var contentType = response.headers.get('content-type');
    var result;

    if (contentType && contentType.includes('application/json')) {
      result = await response.json();
    } else {
      result = await response.text();
    }

    if (!response.ok) {
      var msg = typeof result === 'object' ? (result.error || result.message) : result;
      throw { status: response.status, message: msg || 'Something went wrong' };
    }

    return result;
  },

  get: function(url) { return this.request('GET', url); },
  post: function(url, data) { return this.request('POST', url, data); },
  patch: function(url, data) { return this.request('PATCH', url, data); },
  put: function(url, data) { return this.request('PUT', url, data); },
  delete: function(url) { return this.request('DELETE', url); },
  upload: function(url, formData) { return this.request('POST', url, formData, true); },

  stream: async function(url, data, onData, signal) {
    var response = await fetch(this.baseUrl + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(data),
      signal: signal
    });

    var streamPath = window.location.pathname || '';
    var onChatPage =
      streamPath === '/chat.html' || (streamPath.length >= 9 && streamPath.slice(-9) === 'chat.html');

    if (response.status === 401 && onChatPage) {
      window.location.href = '/login.html?next=%2Fchat.html';
      throw { status: 401, message: 'Unauthorized' };
    }

    if (!response.ok) {
      var err = await response.json().catch(function() { return {}; });
      throw { status: response.status, message: err.error || 'Stream failed' };
    }

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    while (true) {
      var result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      var lines = buffer.split('\n');
      buffer = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.startsWith('data: ')) {
          try {
            var parsed = JSON.parse(line.substring(6));
            onData(parsed);
          } catch (e) {}
        }
      }
    }
  }
};

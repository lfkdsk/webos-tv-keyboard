(function () {
  'use strict';
  var SERVICE = 'luna://com.lfkdsk.tvkeyboard.service/';
  var dot = document.getElementById('dot'), statusText = document.getElementById('statusText');
  var settings = {toast: true};
  function call(method, params, cb) {
    try {
      var b = new PalmServiceBridge();
      b.onservicecallback = function (raw) { var r; try { r = JSON.parse(raw); } catch (e) { r = null; } try { b.cancel(); } catch (e) {} cb(r); };
      b.call(SERVICE + method, JSON.stringify(params || {}));
    } catch (e) { cb(null); }
  }
  function render(r) {
    if (!r || r.returnValue !== true) { statusText.textContent = '服务没有响应，请重新安装应用。'; return; }
    if (r.qr) document.getElementById('qr').innerHTML = r.qr;
    document.getElementById('url').textContent = r.url || (r.listenError ? '端口被占用：' + r.listenError : '没有找到电视的局域网地址');
    settings = r.settings || settings;
    var ok = false, text;
    if (r.pairing === 'prompting') text = '请在电视弹出的提示里选择「允许」';
    else if (r.pairing !== 'ready') text = '正在连接电视的输入接口…' + (r.error ? '（' + r.error + '）' : '');
    else { ok = true; text = '已就绪。打开支持的 App，用手机打字即可'; }
    dot.classList.toggle('ok', ok); statusText.textContent = text;
  }
  function refresh() { call('state', {}, render); }
  document.addEventListener('keydown', function (e) {
    if (e.keyCode === 461 || e.keyCode === 27) { e.preventDefault(); try { if (window.webOS && webOS.platformBack) webOS.platformBack(); else window.close(); } catch (err) { window.close(); } }
  });
  refresh(); setInterval(refresh, 2000);
})();

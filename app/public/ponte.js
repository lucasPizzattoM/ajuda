/*
 * Ponte entre um documento importado e o aplicativo da aula.
 *
 * O servidor coloca este arquivo dentro de cada documento. Ele roda dentro do documento
 * (que fica isolado num iframe) e conversa com o aplicativo por postMessage:
 *   - avisa a altura do documento, para o aplicativo mostrar a página inteira sem rolagem interna;
 *   - avisa onde está o ponteiro, para os outros verem para onde você aponta;
 *   - sincroniza respostas abertas (<details>), campos (sliders, caixas de texto) e botões;
 *   - transforma links internos (#parte2) em rolagem do aplicativo;
 *   - entrega e aplica o estado do documento para quem entra no meio da aula.
 *
 * Um documento pode, se quiser, definir window.aulaEstado = { obter(), aplicar(estado) }
 * para guardar estados que não ficam em campos (ex.: qual modo está escolhido).
 */
(function(){
  'use strict';
  if (window.parent === window) return;          /* aberto fora do aplicativo: não faz nada */

  var token = '';
  try { token = new URLSearchParams(location.search).get('f') || ''; } catch(_){}
  function postar(m){
    m.aula = 1; m.f = token;
    try { window.parent.postMessage(m, '*'); } catch(_){}
  }

  /* O documento roda isolado e o navegador recusa localStorage. Troca por uma versão em memória
     para documentos que usam armazenamento não quebrarem. */
  ['localStorage', 'sessionStorage'].forEach(function(nome){
    try { window[nome].getItem('_'); return; } catch(_){}
    var dados = {};
    var mem = {
      getItem: function(k){ k = String(k); return Object.prototype.hasOwnProperty.call(dados, k) ? dados[k] : null; },
      setItem: function(k, v){ dados[String(k)] = String(v); },
      removeItem: function(k){ delete dados[String(k)]; },
      clear: function(){ dados = {}; },
      key: function(i){ var ks = Object.keys(dados); return i < ks.length ? ks[i] : null; },
      get length(){ return Object.keys(dados).length; }
    };
    try { Object.defineProperty(window, nome, {value: mem, configurable: true}); } catch(_){}
  });

  /* Sem barra de rolagem dentro do documento: quem rola é o aplicativo. */
  var estilo = document.createElement('style');
  estilo.textContent = 'html{overflow:hidden!important;scrollbar-width:none}html::-webkit-scrollbar{display:none}';
  (document.head || document.documentElement).appendChild(estilo);

  /* ---------------- altura ---------------- */
  function altura(){
    var b = document.body;
    if (!b) return 0;
    var max = 0, filhos = b.children, i, el, cs, r;
    for (i = 0; i < filhos.length; i++){
      el = filhos[i];
      if (/^(SCRIPT|STYLE|TEMPLATE|LINK|META)$/.test(el.tagName)) continue;
      cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.display === 'none') continue;
      r = el.getBoundingClientRect();
      var fundo = r.bottom + window.scrollY + (parseFloat(cs.marginBottom) || 0);
      if (fundo > max) max = fundo;
    }
    try {
      var rg = document.createRange();
      rg.selectNodeContents(b);
      var rr = rg.getBoundingClientRect();
      if (!max && rr.bottom) max = rr.bottom + window.scrollY;
    } catch(_){}
    var bs = getComputedStyle(b);
    max += (parseFloat(bs.paddingBottom) || 0) + (parseFloat(bs.borderBottomWidth) || 0) + (parseFloat(bs.marginBottom) || 0);
    return Math.ceil(max);
  }
  var ultimaH = 0, timerH = null;
  function medir(){
    timerH = null;
    var h = altura();
    if (h > 0 && Math.abs(h - ultimaH) >= 1){ ultimaH = h; postar({tipo:'tamanho', h:h}); }
  }
  function agendarMedida(){ if (!timerH) timerH = setTimeout(medir, 60); }

  /* ---------------- identificar elementos ---------------- */
  var GRUPOS = {campo:'input,select,textarea', botao:'button', det:'details'};
  function chave(el, grupo){
    if (el.id) return '#' + el.id;
    var todos = document.querySelectorAll(GRUPOS[grupo]);
    for (var i = 0; i < todos.length; i++) if (todos[i] === el) return grupo + ':' + i;
    return null;
  }
  function achar(k){
    if (typeof k !== 'string') return null;
    if (k.charAt(0) === '#') return document.getElementById(k.slice(1));
    var p = k.split(':'), sel = GRUPOS[p[0]];
    return sel ? document.querySelectorAll(sel)[Number(p[1])] || null : null;
  }
  function ignorarCampo(el){ return el.type === 'password' || el.type === 'file' || el.type === 'hidden'; }
  function valor(el){
    if (el.type === 'checkbox' || el.type === 'radio') return !!el.checked;
    if (el.tagName === 'SELECT' && el.multiple){
      return Array.prototype.filter.call(el.options, function(o){ return o.selected; }).map(function(o){ return o.value; });
    }
    return String(el.value).slice(0, 5000);
  }

  /* ---------------- o que acontece aqui vai para os outros ---------------- */
  var aplicando = false;

  function aoCampo(e){
    if (aplicando) return;
    var el = e.target;
    if (!el || !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || ignorarCampo(el)) return;
    var k = chave(el, 'campo');
    if (k) postar({tipo:'evento', e:{k:'campo', id:k, v:valor(el), ev:e.type === 'change' ? 'change' : 'input'}});
  }
  document.addEventListener('input', aoCampo, true);
  document.addEventListener('change', aoCampo, true);

  document.addEventListener('toggle', function(e){
    var d = e.target;
    if (!d || d.tagName !== 'DETAILS') return;
    agendarMedida();
    if (d._aulaRemoto){ d._aulaRemoto = false; return; }
    var k = chave(d, 'det');
    if (k) postar({tipo:'evento', e:{k:'det', id:k, o:d.open}});
  }, true);

  document.addEventListener('click', function(e){
    var alvo = e.target && e.target.closest ? e.target : null;
    if (!alvo) return;
    var a = alvo.closest('a[href]');
    if (a){
      var href = a.getAttribute('href') || '';
      if (href.charAt(0) === '#'){
        e.preventDefault();
        var id = href.slice(1), dest = null;
        try { dest = id ? document.getElementById(decodeURIComponent(id)) : null; } catch(_){}
        var y = dest ? dest.getBoundingClientRect().top + window.scrollY : 0;
        if (dest) y -= parseFloat(getComputedStyle(dest).scrollMarginTop) || 0;
        postar({tipo:'irPara', y:Math.max(0, y)});
        return;
      }
      if (!a.target || /^_(self|top|parent)$/.test(a.target)){ a.target = '_blank'; a.rel = 'noopener'; }
      return;
    }
    if (aplicando) return;
    var b = alvo.closest('button');
    if (b && !b.disabled){
      var k = chave(b, 'botao');
      if (k) postar({tipo:'evento', e:{k:'botao', id:k}});
    }
  }, true);

  var ultPonteiro = 0;
  document.addEventListener('pointermove', function(e){
    var t = Date.now();
    if (t - ultPonteiro < 60) return;
    ultPonteiro = t;
    postar({tipo:'ponteiro', x:Math.round(e.clientX + window.scrollX), y:Math.round(e.clientY + window.scrollY)});
  }, {capture:true, passive:true});

  var ultRolou = 0;
  function rolou(e){
    if (e && e.type === 'touchmove'){
      var t = e.target;
      if (t && t.closest && t.closest('input,select,textarea,[contenteditable]')) return;
    }
    var agora = Date.now();
    if (agora - ultRolou < 300) return;
    ultRolou = agora;
    postar({tipo:'rolou'});
  }
  window.addEventListener('wheel', rolou, {passive:true});
  window.addEventListener('touchmove', rolou, {passive:true});

  document.addEventListener('keydown', function(e){
    var t = e.target, campo = t && (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable);
    if (e.key === 'Escape') postar({tipo:'atalho', k:'esc'});
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !campo) postar({tipo:'atalho', k:'desfazer'});
  }, true);

  /* ---------------- o que vem dos outros ---------------- */
  function aplicarCampo(el, v, ev){
    if (!el || ignorarCampo(el)) return;
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!v;
    else if (el.tagName === 'SELECT' && el.multiple && Array.isArray(v)){
      Array.prototype.forEach.call(el.options, function(o){ o.selected = v.indexOf(o.value) > -1; });
    } else el.value = String(v);
    el.dispatchEvent(new Event(ev === 'change' ? 'change' : 'input', {bubbles:true}));
  }
  function abrirDetalhe(d, aberto){
    if (!d || d.tagName !== 'DETAILS' || d.open === aberto) return;
    d._aulaRemoto = true;
    d.open = aberto;
  }
  function aplicarEvento(e){
    if (!e || typeof e !== 'object') return;
    aplicando = true;
    try {
      if (e.k === 'campo') aplicarCampo(achar(e.id), e.v, e.ev);
      else if (e.k === 'det') abrirDetalhe(achar(e.id), !!e.o);
      else if (e.k === 'botao'){ var b = achar(e.id); if (b && b.tagName === 'BUTTON' && !b.disabled) b.click(); }
    } catch(err){ console.warn(err); }
    finally { aplicando = false; }
    agendarMedida();
  }
  function estado(){
    var det = Array.prototype.map.call(document.querySelectorAll('details'), function(d){ return d.open; });
    var campos = {};
    Array.prototype.forEach.call(document.querySelectorAll(GRUPOS.campo), function(el){
      if (ignorarCampo(el) || (el.type === 'radio' && !el.checked)) return;
      var k = chave(el, 'campo');
      if (k) campos[k] = valor(el);
    });
    var extra = null;
    try { if (window.aulaEstado && typeof window.aulaEstado.obter === 'function') extra = window.aulaEstado.obter(); } catch(err){ console.warn(err); }
    return {det:det, campos:campos, extra:extra};
  }
  function aplicarEstado(s){
    if (!s || typeof s !== 'object') return;
    if (Array.isArray(s.det)){
      Array.prototype.forEach.call(document.querySelectorAll('details'), function(d, i){ abrirDetalhe(d, !!s.det[i]); });
    }
    aplicando = true;
    try {
      if (s.campos && typeof s.campos === 'object'){
        Object.keys(s.campos).forEach(function(k){ aplicarCampo(achar(k), s.campos[k], 'input'); });
      }
      if (s.extra !== null && s.extra !== undefined && window.aulaEstado && typeof window.aulaEstado.aplicar === 'function'){
        window.aulaEstado.aplicar(s.extra);
      }
    } catch(err){ console.warn(err); }
    finally { aplicando = false; }
    agendarMedida();
  }

  window.addEventListener('message', function(ev){
    if (ev.source !== window.parent) return;
    var m = ev.data;
    if (!m || m.aula !== 1) return;
    if (m.tipo === 'aplicar') aplicarEvento(m.e);
    else if (m.tipo === 'pedirEstado'){
      var s = null;
      try { s = JSON.parse(JSON.stringify(estado())); } catch(_){}
      postar({tipo:'estado', pid:m.pid, s:s});
    }
    else if (m.tipo === 'aplicarEstado') aplicarEstado(m.s);
  });

  /* ---------------- início ---------------- */
  function iniciar(){
    postar({tipo:'pronto', titulo:document.title || ''});
    medir();
    if (window.ResizeObserver){
      var ro = new ResizeObserver(agendarMedida);
      ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
    }
    if (window.MutationObserver && document.body){
      new MutationObserver(agendarMedida).observe(document.body, {childList:true, subtree:true, attributes:true, characterData:true});
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(agendarMedida);
    document.addEventListener('transitionend', agendarMedida, true);
    document.addEventListener('load', agendarMedida, true);
    setInterval(agendarMedida, 2000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
  window.addEventListener('load', agendarMedida);
})();

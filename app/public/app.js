/*
 * Lousa ao vivo: o aplicativo.
 *
 * O documento (uma aula em HTML) abre num iframe isolado, sempre com a mesma largura lógica
 * para todo mundo e escalado para caber na tela. Assim um traço feito no notebook cai no mesmo
 * ponto do documento no celular. O desenho fica num canvas por cima; as coordenadas são do documento.
 */
(function(){
  'use strict';
  var $ = function(id){ return document.getElementById(id); };
  var root = document.documentElement;
  var cv = $('quadro'), ctx = cv.getContext('2d');
  var palco = $('palco'), folha = $('folha'), camadaCursores = $('cursores');
  var LIMITE_MSG = 60000;
  var LARGURAS = {430:'Celular', 768:'Tablet', 1100:'Computador'};
  var TOOLS = {caneta:1, marca:1, borracha:1};
  var CORES = {'--blue':1, '--green':1, '--red':1, '--ink':1};

  function gerarId(n){
    var abc = 'abcdefghijkmnpqrstuvwxyz23456789', out = '', buf = new Uint32Array(n);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    for (var i = 0; i < n; i++) out += abc[buf[i] % abc.length];
    return out;
  }
  function r1(v){ return Math.round(v * 10) / 10; }
  function lerLocal(k){ try { return localStorage.getItem(k); } catch(_){ return null; } }
  function gravarLocal(k, v){ try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch(_){} }
  function larguraValida(v){ v = Math.round(Number(v)); return v >= 320 && v <= 1600 ? v : 430; }
  function idValido(id){ return typeof id === 'string' && /^[a-z0-9]{10}$/.test(id); }
  function rotuloLargura(l){ return LARGURAS[l] || (l + ' px'); }
  function rotuloTamanho(b){ b = Number(b) || 0; return b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1048576).toFixed(1).replace('.', ',') + ' MB'; }

  var meuId = gerarId(10), seq = 0;

  /* ---------------- avisos ---------------- */
  var avisoEl = $('aviso'), avisoTimer = null;
  function avisar(texto, ms){
    avisoEl.textContent = texto;
    avisoEl.hidden = false;
    clearTimeout(avisoTimer);
    avisoTimer = setTimeout(function(){ avisoEl.hidden = true; }, ms || 3500);
  }

  /* ---------------- documento aberto ---------------- */
  var doc = null;                 /* {id, titulo, largura} */
  var docH = 0, docPronto = false, tokenFolha = '', estadoPendente = null, timerCarga = null;
  var crescimentos = [], alturaTravada = false;
  var s = 1;                      /* escala atual: px da tela por px do documento */

  /* desenhos e desfazer, separados por documento */
  var tracosPorDoc = {}, acoesPorDoc = {}, estadosPorDoc = {};
  function tracos(d){ d = d || (doc && doc.id); if (!d) return []; if (!tracosPorDoc[d]) tracosPorDoc[d] = []; return tracosPorDoc[d]; }
  function acoes(){ if (!doc) return []; if (!acoesPorDoc[doc.id]) acoesPorDoc[doc.id] = []; return acoesPorDoc[doc.id]; }
  var atual = null, remotos = {}, ativo = false;
  var ferramenta = {tool:'caneta', color:'--blue'};

  function calcularEscala(){
    if (!doc) return 1;
    var gut = root.clientWidth < 600 ? 12 : 32;
    return Math.max(0.3, Math.min((root.clientWidth - 2 * gut) / doc.largura, 1.6));
  }
  function ajustarPalco(){
    if (!doc){ palco.hidden = true; return; }
    palco.hidden = false;
    s = calcularEscala();
    var h = docH > 0 ? docH : 700;
    folha.style.width = doc.largura + 'px';
    folha.style.height = h + 'px';
    folha.style.transform = 'scale(' + s.toFixed(4) + ')';
    palco.style.width = (doc.largura * s).toFixed(2) + 'px';
    palco.style.height = (h * s).toFixed(2) + 'px';
  }
  function paraPagina(cx, cy){
    var r = palco.getBoundingClientRect();
    return [(cx - r.left) / s, (cy - r.top) / s];
  }
  function paraFolha(m){
    m.aula = 1;
    try { folha.contentWindow.postMessage(m, '*'); } catch(_){}
  }

  function atualizarCabecalho(){
    $('tituloDoc').textContent = doc ? doc.titulo : 'Nenhum documento aberto';
    document.title = doc ? doc.titulo + ' · Lousa ao vivo' : 'Lousa ao vivo';
  }
  function atualizarUrl(){
    var base = location.pathname;
    var q = sala ? '?sala=' + sala : (doc ? '?doc=' + doc.id : '');
    try { history.replaceState(null, '', base + q); } catch(_){}
  }

  function abrirDoc(d, op){
    op = op || {};
    if (!d || !idValido(d.id)) return;
    if (sala && papel === 'aluno' && !op.remoto){ avisar('Durante a aula, quem escolhe o documento é o professor.'); return; }
    var largura = larguraValida(d.largura);
    var titulo = String(d.titulo || 'Documento').slice(0, 120);
    if (doc && doc.id === d.id && doc.largura === largura){
      doc.titulo = titulo;
      atualizarCabecalho();
      if (op.estado){ if (docPronto) paraFolha({tipo:'aplicarEstado', s:op.estado}); else estadoPendente = op.estado; }
      if (!op.remoto && sala && papel === 'professor') enviar({t:'doc', doc:doc});
      return;
    }
    var mudouDoc = !doc || doc.id !== d.id;
    doc = {id:d.id, titulo:titulo, largura:largura};
    if (mudouDoc){
      docH = 0; docPronto = false; crescimentos = []; alturaTravada = false;
      estadoPendente = op.estado || estadosPorDoc[d.id] || null;
      remotos = {}; atual = null;
      Object.keys(cursores).forEach(removerCursor);
      tokenFolha = gerarId(8);
      $('carregando').textContent = 'Carregando documento…';
      $('carregando').hidden = false;
      folha.src = '/doc/' + doc.id + '?f=' + tokenFolha;
      clearTimeout(timerCarga);
      timerCarga = setTimeout(function(){
        if (!docPronto) $('carregando').textContent = 'Não consegui carregar o documento. Confira a internet e abra de novo.';
      }, 15000);
      if (!(seguindo && papel === 'aluno')) window.scrollTo(0, 0);
    }
    $('vazio').hidden = true;
    ajustarPalco();
    atualizarCabecalho();
    atualizarUrl();
    renderListas();
    if (!sala) gravarLocal('aula-ultimo-doc', doc.id);
    if (!op.remoto && sala && papel === 'professor') enviar({t:'doc', doc:doc});
    pedir();
  }
  function fecharDoc(){
    doc = null; docPronto = false; docH = 0; remotos = {}; atual = null;
    clearTimeout(timerCarga);
    folha.removeAttribute('src');
    Object.keys(cursores).forEach(removerCursor);
    palco.hidden = true;
    if (ativo) ligarDesenho(false);
    atualizarCabecalho();
    atualizarUrl();
    mostrarVazio();
    pedir();
  }
  function mostrarVazio(){
    if (doc) return;
    var esperando = sala && papel === 'aluno';
    $('vazio').hidden = false;
    $('vazioTitulo').textContent = esperando ? 'Esperando o professor' : 'Escolha um documento';
    $('vazioTexto').textContent = esperando
      ? 'Assim que o professor abrir um documento, ele aparece aqui.'
      : 'Abra uma aula da biblioteca para estudar, desenhar por cima ou dar aula ao vivo.';
    $('vazioLista').hidden = esperando;
    $('vazioDica').hidden = esperando || listaDocs.length > 0 || !listaCarregada;
    $('vazioCriar').hidden = esperando;
  }

  function definirAltura(h){
    h = Math.round(Number(h));
    if (!(h > 0)) return;
    h = Math.min(h, 60000);
    if (h > docH && docH > 0){
      if (alturaTravada) return;
      var agora = Date.now();
      crescimentos.push(agora);
      crescimentos = crescimentos.filter(function(t){ return agora - t < 3000; });
      if (crescimentos.length > 20){
        alturaTravada = true;
        console.warn('A altura do documento não para de crescer (talvez use 100vh). Travei no tamanho atual.');
        return;
      }
    }
    if (h === docH) return;
    docH = h;
    ajustarPalco();
    pedir();
    if (seguindo && papel === 'aluno' && centroProf !== null) seguirPara(centroProf);
  }

  /* mensagens que vêm de dentro do documento (ponte.js) */
  window.addEventListener('message', function(ev){
    if (ev.source !== folha.contentWindow) return;
    var m = ev.data;
    if (!m || m.aula !== 1 || m.f !== tokenFolha || !doc) return;
    switch (m.tipo){
      case 'pronto':
        docPronto = true;
        clearTimeout(timerCarga);
        $('carregando').hidden = true;
        if (estadoPendente){ paraFolha({tipo:'aplicarEstado', s:estadoPendente}); estadoPendente = null; guardarEstadoDepois(); }
        break;
      case 'tamanho': definirAltura(m.h); break;
      case 'ponteiro': enviarCursor(Number(m.x), Number(m.y)); break;
      case 'rolou': pararDeSeguir(); break;
      case 'irPara': irPara(Number(m.y)); break;
      case 'evento': if (m.e && typeof m.e === 'object'){ enviar({t:'evt', d:doc.id, e:m.e}); guardarEstadoDepois(); } break;
      case 'estado': if (esperaEstado[m.pid]) esperaEstado[m.pid](m.s); break;
      case 'atalho':
        if (m.k === 'esc'){ if (ativo) ligarDesenho(false); fecharPaineis(); }
        else if (m.k === 'desfazer' && (ativo || acoes().length)) desfazer();
        break;
    }
  });

  var esperaEstado = {};
  function obterEstadoDoc(cb){
    if (!doc || !docPronto) return cb(null);
    var pid = gerarId(8), feito = false;
    esperaEstado[pid] = function(st){
      if (feito) return;
      feito = true;
      delete esperaEstado[pid];
      cb(st || null);
    };
    paraFolha({tipo:'pedirEstado', pid:pid});
    setTimeout(function(){ if (esperaEstado[pid]) esperaEstado[pid](null); }, 800);
  }

  var timerGuardar = null;
  function guardarEstadoDepois(){
    clearTimeout(timerGuardar);
    timerGuardar = setTimeout(function(){
      var id = doc && doc.id;
      obterEstadoDoc(function(st){ if (st && doc && doc.id === id) estadosPorDoc[id] = st; });
    }, 300);
  }

  function irPara(y){
    if (!isFinite(y)) return;
    pararDeSeguir();
    var r = palco.getBoundingClientRect();
    var alvo = window.scrollY + r.top + y * s - 12;
    window.scrollTo({top:Math.max(0, alvo), behavior:reduzir ? 'auto' : 'smooth'});
  }

  /* ---------------- desenho ---------------- */
  var dpr = 1, pend = false, pointers = new Map(), panning = false, lastPanY = 0;

  function escuro(){
    var c = getComputedStyle(root).getPropertyValue('--sheet').trim();
    var m = /^#?([0-9a-f]{6})$/i.exec(c);
    if (!m) return false;
    var n = parseInt(m[1], 16);
    return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) < 128;
  }
  function cores(){
    var cs = getComputedStyle(root), o = {};
    Object.keys(CORES).forEach(function(k){ o[k] = cs.getPropertyValue(k).trim(); });
    return o;
  }
  function limites(st){
    var mn = Infinity, mx = -Infinity;
    for (var i = 0; i < st.pts.length; i++){ var y = st.pts[i][1]; if (y < mn) mn = y; if (y > mx) mx = y; }
    st.minY = mn; st.maxY = mx;
    return st;
  }
  function tracar(st, ox, oy, cor, dark){
    var p = st.pts;
    if (!p.length) return;
    ctx.save();
    ctx.lineWidth = st.w * s; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (st.tool === 'borracha'){ ctx.globalCompositeOperation = 'destination-out'; ctx.strokeStyle = 'rgba(0,0,0,1)'; }
    else if (st.tool === 'marca'){ ctx.strokeStyle = dark ? 'rgba(255,214,0,0.32)' : 'rgba(255,214,0,0.42)'; }
    else ctx.strokeStyle = cor[st.color] || '#1D5BD6';
    ctx.beginPath();
    var x0 = ox + p[0][0] * s, y0 = oy + p[0][1] * s;
    ctx.moveTo(x0, y0);
    if (p.length === 1) ctx.lineTo(x0 + 0.01, y0);
    else {
      for (var i = 1; i < p.length - 1; i++){
        var xc = ox + (p[i][0] + p[i+1][0]) / 2 * s, yc = oy + (p[i][1] + p[i+1][1]) / 2 * s;
        ctx.quadraticCurveTo(ox + p[i][0] * s, oy + p[i][1] * s, xc, yc);
      }
      var L = p[p.length - 1];
      ctx.lineTo(ox + L[0] * s, oy + L[1] * s);
    }
    ctx.stroke();
    ctx.restore();
  }
  function redesenhar(){
    pend = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!doc) return;
    var r = palco.getBoundingClientRect();
    posicionarCursores(r);
    var lista = tracos().slice();
    Object.keys(remotos).forEach(function(k){ if (remotos[k].d === doc.id) lista.push(remotos[k]); });
    if (atual) lista.push(atual);
    if (!lista.length) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.left, r.top, r.width, r.height);
    ctx.clip();
    var cor = cores(), dark = escuro(), H = window.innerHeight;
    lista.forEach(function(st){
      var m = st.w * s;
      if (r.top + st.maxY * s < -m || r.top + st.minY * s > H + m) return;
      tracar(st, r.left, r.top, cor, dark);
    });
    ctx.restore();
  }
  function pedir(){ if (!pend){ pend = true; requestAnimationFrame(redesenhar); } }
  function tamanho(){
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(window.innerWidth * dpr);
    cv.height = Math.round(window.innerHeight * dpr);
    ajustarPalco();
    redesenhar();
  }
  function media(){ var t = 0; pointers.forEach(function(v){ t += v; }); return t / pointers.size; }
  function indice(lista, id){ for (var i = 0; i < lista.length; i++) if (lista[i].id === id) return i; return -1; }

  var enviados = 0, timerPts = null;
  cv.addEventListener('pointerdown', function(e){
    if (!ativo || !doc) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    pointers.set(e.pointerId, e.clientY);
    try { cv.setPointerCapture(e.pointerId); } catch(_){}
    if (pointers.size >= 2){
      if (atual) enviar({t:'del', d:atual.d, id:atual.id});
      atual = null; panning = true; lastPanY = media(); pararDeSeguir(); pedir();
      return;
    }
    if (panning) return;
    var w = ferramenta.tool === 'marca' ? 20 : ferramenta.tool === 'borracha' ? 28 : 3.5;
    var pt = paraPagina(e.clientX, e.clientY);
    atual = {id:meuId + '-' + (++seq), d:doc.id, tool:ferramenta.tool, color:ferramenta.color, w:w, pts:[pt], minY:pt[1], maxY:pt[1]};
    enviados = 1;
    enviar({t:'s0', d:doc.id, id:atual.id, tool:atual.tool, color:atual.color, w:w, p:[r1(pt[0]), r1(pt[1])]});
    pedir();
  });
  cv.addEventListener('pointermove', function(e){
    if (!ativo || !pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, e.clientY);
    if (panning){ var m = media(); window.scrollBy(0, lastPanY - m); lastPanY = m; return; }
    if (!atual) return;
    var evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
    if (!evs.length) evs = [e];
    evs.forEach(function(ev){
      var pt = paraPagina(ev.clientX, ev.clientY), last = atual.pts[atual.pts.length - 1];
      if (Math.abs(pt[0] - last[0]) + Math.abs(pt[1] - last[1]) < 1.5) return;
      atual.pts.push(pt);
      if (pt[1] < atual.minY) atual.minY = pt[1];
      if (pt[1] > atual.maxY) atual.maxY = pt[1];
    });
    agendarPontos();
    pedir();
  });
  function agendarPontos(){
    if (timerPts || !conectado) return;
    timerPts = setTimeout(function(){
      timerPts = null;
      if (atual && atual.pts.length > enviados){
        enviar({t:'sp', d:atual.d, id:atual.id, pts:atual.pts.slice(enviados).map(function(p){ return [r1(p[0]), r1(p[1])]; })});
        enviados = atual.pts.length;
      }
    }, 50);
  }
  function fim(e){
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size > 0){ if (panning) lastPanY = media(); return; }
    if (panning){ panning = false; return; }
    if (atual){
      clearTimeout(timerPts); timerPts = null;
      var st = atual;
      atual = null;
      tracos(st.d).push(st);
      if (doc && st.d === doc.id) acoes().push({tipo:'add', id:st.id});
      enviar({t:'s1', d:st.d, st:compactar(st)});
      pedir();
    }
  }
  cv.addEventListener('pointerup', fim);
  cv.addEventListener('pointercancel', fim);

  function compactar(st){
    return {id:st.id, tool:st.tool, color:st.color, w:st.w, pts:st.pts.map(function(p){ return [r1(p[0]), r1(p[1])]; })};
  }
  function tracoValido(st, d){
    if (!st || typeof st.id !== 'string' || st.id.length > 40 || !TOOLS[st.tool]) return null;
    if (st.tool === 'caneta' && !CORES[st.color]) return null;
    var w = Number(st.w);
    if (!(w > 0 && w <= 40) || !Array.isArray(st.pts) || !st.pts.length || st.pts.length > 6000) return null;
    var pts = [];
    for (var i = 0; i < st.pts.length; i++){
      var p = st.pts[i];
      if (!Array.isArray(p) || !isFinite(p[0]) || !isFinite(p[1])) return null;
      pts.push([Number(p[0]), Number(p[1])]);
    }
    return limites({id:st.id, d:d, tool:st.tool, color:st.tool === 'caneta' ? st.color : null, w:w, pts:pts});
  }

  function desfazer(){
    if (!doc) return;
    var pilha = acoes(), lista = tracos();
    while (pilha.length){
      var a = pilha.pop();
      if (a.tipo === 'add'){
        var i = indice(lista, a.id);
        if (i < 0) continue;
        lista.splice(i, 1);
        enviar({t:'del', d:doc.id, id:a.id});
        break;
      }
      if (a.tipo === 'limpar'){
        var volta = a.antes.filter(function(st){ return indice(lista, st.id) < 0; });
        tracosPorDoc[doc.id] = volta.concat(lista);
        enviarEmPartes(volta, function(parte){ return {t:'add', d:doc.id, at:0, sts:parte}; });
        break;
      }
    }
    pedir();
  }
  function limpar(){
    if (!doc || !tracos().length) return;
    acoes().push({tipo:'limpar', antes:tracos()});
    tracosPorDoc[doc.id] = [];
    enviar({t:'clr', d:doc.id});
    pedir();
  }

  /* ---------------- barra de ferramentas e painéis ---------------- */
  var btnDesenho = $('toggleDesenho'), kit = $('kit');
  var paineis = {docs:{el:$('painelDocs'), btn:$('btnDocs')}, vivo:{el:$('painelVivo'), btn:$('btnVivo')}, criar:{el:$('painelCriar'), btn:null}};
  function abrirPainel(nome){
    Object.keys(paineis).forEach(function(n){
      var aberto = n === nome;
      paineis[n].el.hidden = !aberto;
      if (paineis[n].btn) paineis[n].btn.setAttribute('aria-expanded', String(aberto || (n === 'docs' && nome === 'criar')));
    });
    if (nome === 'docs') aoAbrirDocs();
    if (nome === 'criar') aoAbrirCriar();
  }
  function fecharPaineis(){ abrirPainel(null); }
  function alternarPainel(nome){
    if (paineis[nome].el.hidden){ if (ativo) ligarDesenho(false); abrirPainel(nome); }
    else fecharPaineis();
  }
  $('btnDocs').addEventListener('click', function(){ alternarPainel('docs'); });
  $('btnVivo').addEventListener('click', function(){ alternarPainel('vivo'); });
  document.querySelectorAll('[data-fechar]').forEach(function(b){ b.addEventListener('click', fecharPaineis); });

  function ligarDesenho(on){
    if (on && !doc){ avisar('Abra um documento para desenhar.'); return; }
    ativo = on;
    document.body.classList.toggle('desenhando', on);
    kit.hidden = !on;
    btnDesenho.setAttribute('aria-pressed', String(on));
    $('toggleTxt').textContent = on ? 'Pronto' : 'Desenhar';
    $('icLapis').hidden = on;
    $('icOk').hidden = !on;
    if (on){ fecharPaineis(); avisar('Desenhe com o dedo ou o mouse. Para rolar a página, use dois dedos ou a rodinha do mouse.', 5000); }
    else { avisoEl.hidden = true; pointers.clear(); atual = null; panning = false; pedir(); }
  }
  btnDesenho.addEventListener('click', function(){ ligarDesenho(!ativo); });
  $('desfazer').addEventListener('click', desfazer);
  $('limpar').addEventListener('click', limpar);
  kit.querySelectorAll('[data-tool]').forEach(function(b){
    b.addEventListener('click', function(){
      ferramenta = {tool:b.getAttribute('data-tool'), color:b.getAttribute('data-color')};
      kit.querySelectorAll('[data-tool]').forEach(function(o){ o.setAttribute('aria-pressed', String(o === b)); });
      var c = ferramenta.color ? 'var(' + ferramenta.color + ')' : (ferramenta.tool === 'marca' ? 'var(--marker)' : 'var(--muted)');
      document.body.style.setProperty('--pen-atual', c);
    });
  });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape'){ if (ativo) ligarDesenho(false); fecharPaineis(); }
    var alvo = e.target && e.target.tagName;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !/INPUT|TEXTAREA|SELECT/.test(alvo || '') && (ativo || acoes().length)){ e.preventDefault(); desfazer(); }
  });

  /* ---------------- biblioteca ---------------- */
  var listaDocs = [], listaCarregada = false, admin = false, token = lerLocal('aula-token') || '';
  var editandoId = null, arquivoImport = null, confirmarApagar = null;

  function api(metodo, caminho, corpo, cab){
    var headers = cab || {};
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(caminho, {method:metodo, headers:headers, body:corpo, cache:'no-store'}).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(j){
        if (!r.ok){
          if (r.status === 401 && token && caminho !== '/api/login') sairAdmin(true);
          throw new Error(j.erro || 'Algo deu errado no servidor. Tente de novo.');
        }
        return j;
      });
    }, function(){ throw new Error('Sem conexão com o servidor. Confira a internet e tente de novo.'); });
  }
  function buscarLista(){
    return api('GET', '/api/docs').then(function(j){
      listaDocs = Array.isArray(j.docs) ? j.docs.filter(function(d){ return d && idValido(d.id); }) : [];
      listaCarregada = true;
      $('docsErro').hidden = true;
      renderListas();
      mostrarVazio();
      return listaDocs;
    }, function(err){
      listaCarregada = true;
      $('docsErro').textContent = err.message;
      $('docsErro').hidden = false;
      renderListas();
      mostrarVazio();
      throw err;
    });
  }
  function aoAbrirDocs(){
    buscarLista().catch(function(){});
    var aluno = sala && papel === 'aluno';
    $('docsNotaAluno').hidden = !aluno;
    $('docsAdmin').hidden = aluno;
    $('docsCriar').hidden = aluno;
    atualizarAdminUi();
  }

  function svgIcone(caminhos){
    var ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '18'); svg.setAttribute('height', '18');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    caminhos.forEach(function(d){ var p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.appendChild(p); });
    return svg;
  }
  function renderLista(ul, comAdmin){
    ul.textContent = '';
    var bloqueado = sala && papel === 'aluno';
    listaDocs.forEach(function(d){
      var li = document.createElement('li');
      if (doc && doc.id === d.id) li.className = 'atual';
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'doc-abrir';
      b.disabled = !!bloqueado;
      var t = document.createElement('span'); t.className = 'doc-titulo'; t.textContent = d.titulo || 'Documento';
      var m = document.createElement('span'); m.className = 'doc-meta';
      m.textContent = rotuloLargura(larguraValida(d.largura)) + ' · ' + rotuloTamanho(d.tamanho);
      b.appendChild(t); b.appendChild(m);
      b.addEventListener('click', function(){ fecharPaineis(); abrirDoc(d); });
      li.appendChild(b);
      if (comAdmin && admin && !bloqueado){
        var ed = document.createElement('button');
        ed.type = 'button'; ed.className = 'ico'; ed.setAttribute('aria-label', 'Editar ' + (d.titulo || 'documento'));
        ed.appendChild(svgIcone(['M4 20h4l10.5-10.5a2.828 2.828 0 1 0-4-4L4 16v4', 'M13.5 6.5l4 4']));
        ed.addEventListener('click', function(){ mostrarEditar(d); });
        li.appendChild(ed);
        if (confirmarApagar === d.id){
          var cf = document.createElement('button');
          cf.type = 'button'; cf.className = 'perigo'; cf.textContent = 'Apagar de vez';
          cf.addEventListener('click', function(){ apagarDoc(d); });
          li.appendChild(cf);
        } else {
          var ap = document.createElement('button');
          ap.type = 'button'; ap.className = 'ico'; ap.setAttribute('aria-label', 'Apagar ' + (d.titulo || 'documento'));
          ap.appendChild(svgIcone(['M4 7h16', 'M10 11v6', 'M14 11v6', 'M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12', 'M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3']));
          ap.addEventListener('click', function(){
            confirmarApagar = d.id;
            renderListas();
            setTimeout(function(){ if (confirmarApagar === d.id){ confirmarApagar = null; renderListas(); } }, 5000);
          });
          li.appendChild(ap);
        }
      }
      ul.appendChild(li);
    });
  }
  function renderListas(){
    renderLista($('docsLista'), true);
    renderLista($('vazioLista'), false);
    $('docsVazio').hidden = !listaCarregada || listaDocs.length > 0;
  }

  function atualizarAdminUi(){
    $('btnMostrarLogin').hidden = admin;
    $('painelAdmin').hidden = !admin;
    if (admin) $('formLogin').hidden = true;
    renderListas();
  }
  function sairAdmin(expirou){
    admin = false; token = '';
    gravarLocal('aula-token', null);
    $('formImport').hidden = true; $('formEditar').hidden = true;
    atualizarAdminUi();
    if (expirou) avisar('Sua sessão de professor expirou. Entre com a senha de novo.');
  }
  $('btnMostrarLogin').addEventListener('click', function(){
    $('formLogin').hidden = false;
    $('loginErro').hidden = true;
    $('loginSenha').focus();
  });
  $('formLogin').addEventListener('submit', function(e){
    e.preventDefault();
    var senha = $('loginSenha').value;
    var err = $('loginErro');
    if (!senha){ err.textContent = 'Digite a senha de professor.'; err.hidden = false; return; }
    err.hidden = true;
    api('POST', '/api/login', JSON.stringify({senha:senha}), {'Content-Type':'application/json'}).then(function(j){
      token = j.token; admin = true;
      gravarLocal('aula-token', token);
      $('loginSenha').value = '';
      atualizarAdminUi();
      avisar('Modo professor ligado. Agora você pode importar e apagar documentos.');
    }, function(er){ err.textContent = er.message; err.hidden = false; });
  });
  $('loginSenha').addEventListener('input', function(){ $('loginErro').hidden = true; });
  $('btnSairAdmin').addEventListener('click', function(){ sairAdmin(false); });
  if (token){
    api('GET', '/api/sessao').then(function(){ admin = true; atualizarAdminUi(); }, function(){});
  }

  /* importar */
  var soltar = $('soltar'), inputArq = $('importInput');
  inputArq.addEventListener('change', function(){ if (inputArq.files && inputArq.files[0]) prepararImport(inputArq.files[0]); inputArq.value = ''; });
  ['dragenter', 'dragover'].forEach(function(t){ soltar.addEventListener(t, function(e){ e.preventDefault(); soltar.classList.add('sobre'); }); });
  ['dragleave', 'drop'].forEach(function(t){ soltar.addEventListener(t, function(){ soltar.classList.remove('sobre'); }); });
  soltar.addEventListener('drop', function(e){
    e.preventDefault();
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) prepararImport(f);
  });
  function prepararImport(arq){
    var err = $('importErro');
    $('formEditar').hidden = true;
    $('formImport').hidden = false;
    err.hidden = true;
    arquivoImport = null;
    $('importArquivo').textContent = arq.name + ' · ' + rotuloTamanho(arq.size);
    if (!/\.html?$/i.test(arq.name) && arq.type !== 'text/html'){
      err.textContent = 'Escolha um arquivo .html.'; err.hidden = false; return;
    }
    if (arq.size > 20 * 1048576){ err.textContent = 'O arquivo passa de 20 MB. Diminua as imagens dentro dele e tente de novo.'; err.hidden = false; return; }
    var leitor = new FileReader();
    leitor.onload = function(){
      arquivoImport = {nome:arq.name, html:String(leitor.result || '')};
      var titulo = '';
      try { titulo = (new DOMParser().parseFromString(arquivoImport.html, 'text/html').title || '').trim(); } catch(_){}
      $('importTitulo').value = (titulo || arq.name.replace(/\.html?$/i, '')).slice(0, 120);
      $('importLargura').value = '430';
      $('importTitulo').focus();
    };
    leitor.onerror = function(){ err.textContent = 'Não consegui ler o arquivo. Tente de novo.'; err.hidden = false; };
    leitor.readAsText(arq);
  }
  $('importCancelar').addEventListener('click', function(){ $('formImport').hidden = true; arquivoImport = null; });
  $('importTitulo').addEventListener('input', function(){ $('importErro').hidden = true; });
  $('formImport').addEventListener('submit', function(e){
    e.preventDefault();
    var err = $('importErro'), titulo = $('importTitulo').value.trim(), btn = $('importEnviar');
    if (!arquivoImport){ err.textContent = 'Escolha o arquivo de novo.'; err.hidden = false; return; }
    if (!titulo){ err.textContent = 'Dê um título para o documento.'; err.hidden = false; $('importTitulo').focus(); return; }
    btn.disabled = true; btn.textContent = 'Importando…';
    api('POST', '/api/docs', new Blob([arquivoImport.html], {type:'text/html'}), {
      'Content-Type':'text/html; charset=utf-8', 'X-Titulo':encodeURIComponent(titulo), 'X-Largura':$('importLargura').value
    }).then(function(j){
      $('formImport').hidden = true; arquivoImport = null;
      avisar('Documento importado.');
      return buscarLista().then(function(){ if (j.doc && !(sala && papel === 'aluno')){ fecharPaineis(); abrirDoc(j.doc); } });
    }, function(er){ err.textContent = er.message; err.hidden = false; })
      .then(function(){ btn.disabled = false; btn.textContent = 'Importar'; }, function(){ btn.disabled = false; btn.textContent = 'Importar'; });
  });

  /* editar e apagar */
  function mostrarEditar(d){
    editandoId = d.id;
    $('formImport').hidden = true;
    $('formEditar').hidden = false;
    $('editarErro').hidden = true;
    $('editarTitulo').value = d.titulo || '';
    var l = String(larguraValida(d.largura));
    var sel = $('editarLargura');
    if (!sel.querySelector('option[value="' + l + '"]')){
      var o = document.createElement('option'); o.value = l; o.textContent = l + ' px'; sel.appendChild(o);
    }
    sel.value = l;
    $('editarTitulo').focus();
  }
  $('editarCancelar').addEventListener('click', function(){ $('formEditar').hidden = true; editandoId = null; });
  $('editarTitulo').addEventListener('input', function(){ $('editarErro').hidden = true; });
  $('formEditar').addEventListener('submit', function(e){
    e.preventDefault();
    var err = $('editarErro'), titulo = $('editarTitulo').value.trim();
    if (!titulo){ err.textContent = 'Dê um título para o documento.'; err.hidden = false; return; }
    api('POST', '/api/docs/' + editandoId, JSON.stringify({titulo:titulo, largura:Number($('editarLargura').value)}), {'Content-Type':'application/json'}).then(function(j){
      $('formEditar').hidden = true; editandoId = null;
      avisar('Documento atualizado.');
      if (j.doc && doc && doc.id === j.doc.id) abrirDoc(j.doc);
      return buscarLista();
    }, function(er){ err.textContent = er.message; err.hidden = false; }).catch(function(){});
  });
  function apagarDoc(d){
    confirmarApagar = null;
    api('DELETE', '/api/docs/' + d.id).then(function(){
      delete tracosPorDoc[d.id]; delete acoesPorDoc[d.id]; delete estadosPorDoc[d.id];
      if (doc && doc.id === d.id) fecharDoc();
      if (lerLocal('aula-ultimo-doc') === d.id) gravarLocal('aula-ultimo-doc', null);
      avisar('Documento apagado.');
      return buscarLista();
    }, function(er){ avisar(er.message, 5000); renderListas(); }).catch(function(){});
  }

  /* ---------------- criar aula com o Claude ---------------- */
  var textoPrompt = null, textoModelo = null;
  var CAMPOS_CRIAR = ['criarMateria', 'criarTema', 'criarPublico', 'criarModelo', 'criarOutro', 'criarObs'];
  function buscarTexto(url){
    return fetch(url, {cache:'no-store'}).then(function(r){ if (!r.ok) throw new Error(); return r.text(); });
  }
  function aoAbrirCriar(){
    $('criarVerModelo').hidden = !!(sala && papel === 'aluno');
    $('criarErro').hidden = true;
    var tarefas = [];
    if (textoPrompt === null) tarefas.push(buscarTexto('/prompt-aula.txt').then(function(t){ textoPrompt = t; }, function(){
      $('criarErro').textContent = 'Não consegui carregar o prompt do servidor. Confira a internet e abra de novo.';
      $('criarErro').hidden = false;
    }));
    if (textoModelo === null) tarefas.push(buscarTexto('/modelo.html').then(function(t){ textoModelo = t; }, function(){ textoModelo = ''; }));
    Promise.all(tarefas).then(atualizarPrompt);
    atualizarPrompt();
  }
  function valorCampo(id, padrao){ var v = $(id).value.trim().replace(/\s+/g, ' '); return v || padrao; }
  function nomeModelo(){ return $('criarModelo').value === 'outro' ? valorCampo('criarOutro', '[MODELO DE AULA]') : $('criarModelo').value; }
  function montarPrompt(comCodigo){
    if (textoPrompt === null) return '';
    var t = textoPrompt
      .split('{{MATERIA}}').join(valorCampo('criarMateria', '[MATÉRIA]'))
      .split('{{TEMA}}').join(valorCampo('criarTema', '[TEMA]'))
      .split('{{PUBLICO}}').join(valorCampo('criarPublico', '[SÉRIE OU PÚBLICO]'))
      .split('{{MODELO}}').join(nomeModelo())
      .split('{{OBSERVACOES}}').join(valorCampo('criarObs', 'nenhuma'))
      .replace(/\s+$/, '');
    if ($('criarComModelo').checked && textoModelo){
      t += '\n\n## Código do modelo\nUse este modelo como base: mantenha o CSS, as classes e o JavaScript dos componentes, '
        + 'troque a cor em --acento para combinar com a matéria, apague os componentes que não usar, repita os que precisar '
        + 'e substitua todo o texto entre [colchetes].\n\n'
        + (comCodigo ? '```html\n' + textoModelo.trim() + '\n```' : '(O código completo do modelo vai junto quando você copiar.)');
    }
    return t + '\n';
  }
  function atualizarPrompt(){
    $('criarOutroCampo').hidden = $('criarModelo').value !== 'outro';
    var semModelo = textoModelo === '';
    $('criarComModelo').disabled = semModelo;
    if (textoPrompt === null){ $('criarPrompt').value = 'Carregando…'; $('criarTamanho').textContent = ''; return; }
    $('criarPrompt').value = montarPrompt(false);
    var total = montarPrompt(true).length;
    $('criarTamanho').textContent = (semModelo ? 'O modelo não foi encontrado no servidor; o prompt vai sem ele. ' : '')
      + 'Ao copiar: ' + (total < 1000 ? total + ' caracteres.' : Math.round(total / 1000) + ' mil caracteres.');
    var salvo = {};
    CAMPOS_CRIAR.forEach(function(id){ salvo[id] = $(id).value; });
    salvo.criarComModelo = $('criarComModelo').checked;
    gravarLocal('aula-criar', JSON.stringify(salvo));
  }
  (function restaurarCriar(){
    var salvo = null;
    try { salvo = JSON.parse(lerLocal('aula-criar') || 'null'); } catch(_){}
    if (salvo && typeof salvo === 'object'){
      CAMPOS_CRIAR.forEach(function(id){ if (typeof salvo[id] === 'string') $(id).value = salvo[id]; });
      if ($('criarModelo').selectedIndex < 0) $('criarModelo').selectedIndex = 0;
      if (typeof salvo.criarComModelo === 'boolean') $('criarComModelo').checked = salvo.criarComModelo;
    }
  })();
  CAMPOS_CRIAR.concat(['criarComModelo']).forEach(function(id){
    $(id).addEventListener('input', atualizarPrompt);
    $(id).addEventListener('change', atualizarPrompt);
  });
  $('docsCriar').addEventListener('click', function(){ abrirPainel('criar'); });
  $('vazioCriar').addEventListener('click', function(){ abrirPainel('criar'); });
  $('criarCopiar').addEventListener('click', function(){
    var btn = $('criarCopiar');
    if (textoPrompt === null){
      $('criarErro').textContent = 'O prompt ainda está carregando. Tente de novo em um instante.';
      $('criarErro').hidden = false;
      return;
    }
    var texto = montarPrompt(true);
    function copiou(){
      btn.textContent = 'Copiado';
      setTimeout(function(){ btn.textContent = 'Copiar prompt'; }, 2000);
      avisar('Prompt copiado. Cole numa conversa com o Claude.');
    }
    function manual(){
      var ta = $('criarPrompt');
      ta.value = texto; ta.focus(); ta.select();
      avisar('Selecionei o prompt inteiro. Copie com Ctrl+C ou segurando o dedo.', 5000);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(texto).then(copiou, manual);
    else manual();
  });
  $('criarVerModelo').addEventListener('click', function(){
    var achar = function(){ var m = null; listaDocs.forEach(function(d){ if (d.origem === 'modelo.html') m = d; }); return m; };
    var abrir = function(m){
      if (m){ fecharPaineis(); abrirDoc(m); }
      else avisar('O modelo não está mais na biblioteca. Use Baixar o modelo.', 5000);
    };
    var m = achar();
    if (m) abrir(m); else buscarLista().then(function(){ abrir(achar()); }, function(){ abrir(null); });
  });

  /* ---------------- cursores das outras pessoas ---------------- */
  var cursores = {};
  function corDe(id){ var p = pessoas[id]; return p && p.papel === 'professor' ? 'var(--red)' : 'var(--violet)'; }
  function nomeDe(id){ var p = pessoas[id]; return p ? p.nome : 'Visitante'; }
  function moverCursor(id, x, y){
    if (!isFinite(x) || !isFinite(y)) return;
    var c = cursores[id];
    if (!c){
      var el = document.createElement('div');
      el.className = 'cursor';
      el.appendChild(document.createElement('i'));
      el.appendChild(document.createElement('span'));
      camadaCursores.appendChild(el);
      c = cursores[id] = {el:el};
    }
    c.x = x; c.y = y; c.visto = Date.now();
    c.el.style.setProperty('--c', corDe(id));
    c.el.lastChild.textContent = nomeDe(id);
    c.el.hidden = false;
    pedir();
  }
  function posicionarCursores(r){
    Object.keys(cursores).forEach(function(id){
      var c = cursores[id];
      if (c.el.hidden) return;
      c.el.style.transform = 'translate(' + (r.left + c.x * s - 7).toFixed(1) + 'px,' + (r.top + c.y * s - 7).toFixed(1) + 'px)';
    });
  }
  function removerCursor(id){ var c = cursores[id]; if (c){ c.el.remove(); delete cursores[id]; } }
  setInterval(function(){
    var agora = Date.now();
    Object.keys(cursores).forEach(function(id){ if (!cursores[id].el.hidden && agora - cursores[id].visto > 4000) cursores[id].el.hidden = true; });
  }, 1000);

  var ultimoCur = 0;
  function enviarCursor(x, y){
    if (!conectado || atual || !doc || !isFinite(x) || !isFinite(y)) return;
    if (x < 0 || y < 0 || x > doc.largura || y > (docH || 700)) return;
    var agora = Date.now();
    if (agora - ultimoCur < 80) return;
    ultimoCur = agora;
    enviar({t:'cur', d:doc.id, x:r1(x), y:r1(y)});
  }
  document.addEventListener('pointermove', function(e){
    if (!conectado || !doc) return;
    var p = paraPagina(e.clientX, e.clientY);
    enviarCursor(p[0], p[1]);
  }, {passive:true});

  /* ---------------- aula ao vivo (WebSocket com o servidor) ---------------- */
  var podeVivo = /^https?:$/.test(location.protocol);
  var ws = null, conectado = false, sala = null, papel = null, meuNome = '';
  var tentativas = 0, timerReconexao = null, ultimoRecebido = 0;
  var pessoas = {}, primeiraSync = false, conectouEm = 0, jaAvisouEntrada = false;
  var seguindo = false, centroProf = null, alvoRolagem = null, animando = false;
  var pedidoAtual = null, recebendo = null, timerPedido = null;
  var nomeInput = $('vivoNome'), codigoInput = $('vivoCodigo'), erroEl = $('vivoErro'), btnSeguir = $('btnSeguir');

  function mostrarErro(t){ erroEl.textContent = t; erroEl.hidden = !t; }
  function mostrarTelaVivo(){
    $('vivoSemSite').hidden = podeVivo;
    $('vivoEntrar').hidden = !podeVivo || !!sala;
    $('vivoSala').hidden = !sala;
    $('chipVivo').hidden = !sala;
    if (sala) $('chipVivoTxt').textContent = (conectado ? 'Ao vivo · ' : 'Reconectando · ') + sala;
  }
  function setStatus(t, cls){ var el = $('vivoStatus'); el.textContent = t; el.className = 'status' + (cls ? ' ' + cls : ''); mostrarTelaVivo(); }
  function urlSala(c){ return location.origin + location.pathname + '?sala=' + c; }
  function urlWs(){ return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'; }
  function normalizarCodigo(v){ return (v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); }
  function gerarCodigo(){
    var abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', out = '', buf = new Uint32Array(5);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    for (var i = 0; i < 5; i++) out += abc[buf[i] % abc.length];
    return out;
  }

  function enviar(m){
    if (!conectado || !ws || ws.readyState !== 1) return;
    m.de = meuId;
    try { ws.send(JSON.stringify({tipo:'msg', m:m})); } catch(_){}
  }
  function enviarEmPartes(lista, montar){
    if (!conectado) return;
    var parte = [], tam = 0;
    lista.forEach(function(st){
      var c = compactar(st), t = JSON.stringify(c).length;
      if (parte.length && tam + t > LIMITE_MSG){ enviar(montar(parte)); parte = []; tam = 0; }
      parte.push(c); tam += t;
    });
    if (parte.length) enviar(montar(parte));
  }

  function conectar(){
    clearTimeout(timerReconexao); timerReconexao = null;
    if (!sala) return;
    var meu;
    try { meu = new WebSocket(urlWs()); } catch(_){ perdeuConexao(); return; }
    ws = meu;
    meu.onopen = function(){
      if (ws !== meu) return;
      ultimoRecebido = Date.now();
      meu.send(JSON.stringify({tipo:'entrar', sala:sala, id:meuId, nome:meuNome, papel:papel}));
    };
    meu.onmessage = function(ev){
      if (ws !== meu) return;
      ultimoRecebido = Date.now();
      var d;
      try { d = JSON.parse(ev.data); } catch(_){ return; }
      if (!d || typeof d !== 'object') return;
      if (d.tipo === 'pessoas'){
        atualizarPessoas(d.lista);
        if (!conectado) aoConectar();
      } else if (d.tipo === 'msg'){
        try { receber(d.m); } catch(err){ console.warn(err); }
      } else if (d.tipo === 'erro'){
        setStatus(String(d.texto || 'O servidor recusou a entrada.').slice(0, 120), 'ruim');
      }
    };
    meu.onclose = function(){ if (ws === meu){ ws = null; perdeuConexao(); } };
    meu.onerror = function(){};
  }
  function aoConectar(){
    conectado = true;
    tentativas = 0;
    root.classList.add('conectado');
    conectouEm = Date.now();
    setStatus(papel === 'professor' ? 'Ao vivo. Você é o professor.' : 'Ao vivo', 'ok');
    if (papel === 'professor' && doc) enviar({t:'doc', doc:doc});
    else pedirEstado();
    if (papel === 'aluno' && !jaAvisouEntrada){
      jaAvisouEntrada = true;
      fecharPaineis();
      avisar('Você entrou na aula. A página vai acompanhar o professor.', 4000);
    }
  }
  function perdeuConexao(){
    conectado = false;
    root.classList.remove('conectado');
    if (!sala) return;
    setStatus('Sem conexão. Tentando de novo…', 'ruim');
    var espera = Math.min(10000, 800 * Math.pow(2, tentativas++));
    clearTimeout(timerReconexao);
    timerReconexao = setTimeout(conectar, espera);
  }
  function reconectarJa(){ if (sala && !ws){ tentativas = 0; conectar(); } }
  setInterval(function(){
    if (!ws || ws.readyState !== 1) return;
    if (Date.now() - ultimoRecebido > 45000){
      var morto = ws; ws = null;
      try { morto.close(); } catch(_){}
      perdeuConexao();
      return;
    }
    try { ws.send('{"tipo":"pulso"}'); } catch(_){}
  }, 15000);
  document.addEventListener('visibilitychange', function(){ if (!document.hidden) reconectarJa(); });
  window.addEventListener('online', reconectarJa);

  function entrar(codigo, comoProfessor){
    if (!podeVivo){ mostrarTelaVivo(); abrirPainel('vivo'); return; }
    if (sala) sair(true);
    mostrarErro('');
    sala = codigo;
    papel = comoProfessor ? 'professor' : 'aluno';
    meuNome = (nomeInput.value.trim() || (comoProfessor ? 'Professor' : 'Aluno')).slice(0, 20);
    gravarLocal('aula-nome', meuNome);
    if (comoProfessor) gravarLocal('aula-prof-' + codigo, '1');

    pessoas = {}; primeiraSync = false; jaAvisouEntrada = false;
    Object.keys(cursores).forEach(removerCursor);
    remotos = {}; atual = null;
    seguindo = !comoProfessor; centroProf = null;
    btnSeguir.hidden = true;
    if (!comoProfessor){
      /* quem é aluno recebe tudo do professor: começa do zero */
      tracosPorDoc = {}; acoesPorDoc = {}; estadosPorDoc = {};
      if (doc) fecharDoc(); else mostrarVazio();
    }

    $('vivoCodigoAtual').textContent = codigo;
    $('vivoLink').value = urlSala(codigo);
    setStatus('Conectando…');
    renderPessoas();
    renderListas();
    atualizarUrl();
    tentativas = 0;
    conectar();
  }

  function sair(trocando){
    clearTimeout(timerReconexao); timerReconexao = null;
    if (ws){ var w = ws; ws = null; try { w.close(1000); } catch(_){} }
    conectado = false; sala = null; papel = null; seguindo = false; pedidoAtual = null;
    root.classList.remove('conectado');
    btnSeguir.hidden = true;
    Object.keys(cursores).forEach(removerCursor);
    pessoas = {}; remotos = {};
    if (trocando) return;
    mostrarTelaVivo();
    atualizarUrl();
    renderListas();
    if (doc) gravarLocal('aula-ultimo-doc', doc.id); else mostrarVazio();
    pedir();
  }

  $('vivoCriar').addEventListener('click', function(){ entrar(gerarCodigo(), true); });
  function tentarEntrar(){
    var c = normalizarCodigo(codigoInput.value);
    codigoInput.value = c;
    if (c.length !== 5){ mostrarErro('O código tem 5 letras ou números. Confira e tente de novo.'); codigoInput.focus(); return; }
    entrar(c, lerLocal('aula-prof-' + c) === '1');
  }
  $('vivoEntrarBtn').addEventListener('click', tentarEntrar);
  codigoInput.addEventListener('keydown', function(e){ if (e.key === 'Enter') tentarEntrar(); });
  codigoInput.addEventListener('input', function(){ mostrarErro(''); });
  $('vivoSair').addEventListener('click', function(){ sair(false); });
  $('vivoCopiar').addEventListener('click', function(){
    var campo = $('vivoLink'), texto = campo.value;
    function selecionar(){ campo.focus(); campo.select(); avisar('Selecionei o link. Copie com Ctrl+C ou segurando o dedo.'); }
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(texto).then(function(){ avisar('Link copiado. Mande para a outra pessoa.'); }, selecionar);
    } else selecionar();
  });

  function atualizarPessoas(lista){
    var novo = {};
    (Array.isArray(lista) ? lista : []).forEach(function(p){
      if (p && typeof p.id === 'string') novo[p.id] = {nome:String(p.nome || 'Visitante').slice(0, 20), papel:p.papel === 'professor' ? 'professor' : 'aluno'};
    });
    if (primeiraSync && Date.now() - conectouEm > 2000){
      Object.keys(novo).forEach(function(k){ if (!pessoas[k] && k !== meuId) avisar(novo[k].nome + ' entrou na aula'); });
      Object.keys(pessoas).forEach(function(k){ if (!novo[k] && k !== meuId){ avisar(pessoas[k].nome + ' saiu da aula'); removerCursor(k); } });
    }
    pessoas = novo;
    primeiraSync = true;
    renderPessoas();
  }
  function renderPessoas(){
    var box = $('vivoPessoas');
    box.textContent = '';
    var ids = Object.keys(pessoas);
    if (!ids.length){ var v = document.createElement('span'); v.className = 'muted'; v.textContent = 'Só você por enquanto'; box.appendChild(v); return; }
    ids.sort(function(a, b){ return (pessoas[a].papel === 'professor' ? 0 : 1) - (pessoas[b].papel === 'professor' ? 0 : 1); });
    ids.forEach(function(id){
      var p = pessoas[id], el = document.createElement('span');
      el.className = 'pessoa';
      el.style.setProperty('--c', p.papel === 'professor' ? 'var(--red)' : 'var(--violet)');
      el.textContent = p.nome + (p.papel === 'professor' ? ' (professor)' : '') + (id === meuId ? ' · você' : '');
      box.appendChild(el);
    });
  }

  /* estado para quem acabou de entrar */
  function pedirEstado(){
    pedidoAtual = gerarId(8);
    recebendo = {partes:{}, n:0, extra:null};
    enviar({t:'oi', pid:pedidoAtual});
    clearTimeout(timerPedido);
    timerPedido = setTimeout(function(){
      if (pedidoAtual && Object.keys(pessoas).length > 1) enviar({t:'oi', pid:pedidoAtual});
    }, 3000);
  }
  function souQuemResponde(quemPediu){
    var ids = Object.keys(pessoas).filter(function(id){ return id !== quemPediu; });
    if (ids.indexOf(meuId) < 0) ids.push(meuId);
    var profs = ids.filter(function(id){ return pessoas[id] && pessoas[id].papel === 'professor'; }).sort();
    if (profs.length) return profs[0] === meuId;
    return ids.sort()[0] === meuId;
  }
  function responderEstado(pid, para){
    obterEstadoDoc(function(estadoDoc){
      var extra = {
        doc:doc ? {id:doc.id, titulo:doc.titulo, largura:doc.largura} : null,
        docEstado:estadoDoc,
        rol:papel === 'professor' ? (doc ? r1(centroAtual()) : null) : centroProf
      };
      if (JSON.stringify(extra).length > 300000) extra.docEstado = null;
      var partes = [], parte = [], tam = 0;
      tracos().forEach(function(st){
        var c = compactar(st), t = JSON.stringify(c).length;
        if (parte.length && tam + t > LIMITE_MSG){ partes.push(parte); parte = []; tam = 0; }
        parte.push(c); tam += t;
      });
      partes.push(parte);
      partes.forEach(function(p, k){ enviar({t:'est', pid:pid, para:para, k:k, n:partes.length, sts:p, extra:k === 0 ? extra : null}); });
    });
  }
  function receberEstado(m){
    if (m.para !== meuId || m.pid !== pedidoAtual || !recebendo) return;
    if (!(m.n >= 1 && m.n < 500) || !(m.k >= 0 && m.k < m.n) || !Array.isArray(m.sts)) return;
    recebendo.n = m.n;
    recebendo.partes[m.k] = m.sts;
    if (m.extra) recebendo.extra = m.extra;
    if (Object.keys(recebendo.partes).length < recebendo.n) return;
    var ex = recebendo.extra || {};
    var docRemoto = ex.doc && idValido(ex.doc.id) ? ex.doc : null;
    pedidoAtual = null; clearTimeout(timerPedido);
    if (docRemoto){
      var lista = [], vistos = {};
      for (var k = 0; k < recebendo.n; k++){
        (recebendo.partes[k] || []).forEach(function(st){
          var v = tracoValido(st, docRemoto.id);
          if (v && !vistos[v.id]){ vistos[v.id] = 1; lista.push(v); }
        });
      }
      var meus = tracos(docRemoto.id).filter(function(st){ return st.id.indexOf(meuId + '-') === 0 && !vistos[st.id]; });
      tracosPorDoc[docRemoto.id] = lista.concat(meus);
      abrirDoc(docRemoto, {remoto:true, estado:ex.docEstado || null});
    } else if (papel === 'aluno' && doc){
      fecharDoc();
    }
    if (ex.rol !== null && ex.rol !== undefined && isFinite(ex.rol)){ centroProf = Number(ex.rol); seguirPara(centroProf); }
    recebendo = null;
    pedir();
  }

  function receber(m){
    if (!m || typeof m !== 'object' || typeof m.de !== 'string' || m.de === meuId) return;
    var de = m.de, st, lista, i;
    var d = idValido(m.d) ? m.d : null;
    switch (m.t){
      case 's0':
        if (!d || !Array.isArray(m.p)) return;
        st = tracoValido({id:m.id, tool:m.tool, color:m.color, w:m.w, pts:[m.p]}, d);
        if (st){ remotos[st.id] = st; if (doc && d === doc.id) moverCursor(de, st.pts[0][0], st.pts[0][1]); }
        break;
      case 'sp':
        st = remotos[m.id];
        if (!st || !Array.isArray(m.pts) || st.pts.length + m.pts.length > 6000) return;
        m.pts.forEach(function(p){
          if (Array.isArray(p) && isFinite(p[0]) && isFinite(p[1])){
            st.pts.push([Number(p[0]), Number(p[1])]);
            if (p[1] < st.minY) st.minY = Number(p[1]);
            if (p[1] > st.maxY) st.maxY = Number(p[1]);
          }
        });
        var ult = st.pts[st.pts.length - 1];
        if (doc && st.d === doc.id) moverCursor(de, ult[0], ult[1]);
        break;
      case 's1':
        if (!d) return;
        st = tracoValido(m.st, d);
        if (!st) return;
        delete remotos[st.id];
        lista = tracos(d);
        if (indice(lista, st.id) < 0) lista.push(st);
        break;
      case 'del':
        delete remotos[m.id];
        Object.keys(tracosPorDoc).forEach(function(k){
          if (d && k !== d) return;
          i = indice(tracosPorDoc[k], m.id);
          if (i > -1) tracosPorDoc[k].splice(i, 1);
        });
        break;
      case 'clr':
        if (!d) return;
        tracosPorDoc[d] = [];
        Object.keys(remotos).forEach(function(k){ if (remotos[k].d === d) delete remotos[k]; });
        break;
      case 'add':
        if (!d || !Array.isArray(m.sts)) return;
        lista = tracos(d);
        var novos = m.sts.map(function(x){ return tracoValido(x, d); }).filter(function(x){ return x && indice(lista, x.id) < 0; });
        var at = Math.max(0, Math.min(lista.length, Number(m.at) || 0));
        Array.prototype.splice.apply(lista, [at, 0].concat(novos));
        break;
      case 'cur':
        if (doc && d === doc.id) moverCursor(de, Number(m.x), Number(m.y));
        return;
      case 'rol':
        if (!pessoas[de] || pessoas[de].papel !== 'professor' || !isFinite(m.c)) return;
        if (!doc || d !== doc.id) return;
        centroProf = Number(m.c);
        seguirPara(centroProf);
        return;
      case 'doc':
        if (!pessoas[de] || pessoas[de].papel !== 'professor' || papel === 'professor') return;
        if (m.doc && idValido(m.doc.id)) abrirDoc(m.doc, {remoto:true});
        else if (doc) fecharDoc();
        return;
      case 'evt':
        if (doc && d === doc.id && docPronto && m.e && typeof m.e === 'object'){ paraFolha({tipo:'aplicar', e:m.e}); guardarEstadoDepois(); }
        return;
      case 'oi':
        if (typeof m.pid === 'string' && souQuemResponde(de)) responderEstado(m.pid, de);
        return;
      case 'est':
        receberEstado(m);
        return;
      default:
        return;
    }
    pedir();
  }

  /* rolagem: o professor guia, quem é aluno acompanha */
  var reduzir = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function centroAtual(){ var r = palco.getBoundingClientRect(); return (window.innerHeight / 2 - r.top) / s; }
  var timerRol = null;
  function avisarRolagem(){
    if (!conectado || papel !== 'professor' || !doc || timerRol) return;
    timerRol = setTimeout(function(){ timerRol = null; if (doc) enviar({t:'rol', d:doc.id, c:r1(centroAtual())}); }, 120);
  }
  function seguirPara(centro){
    if (!seguindo || papel !== 'aluno' || !doc) return;
    var r = palco.getBoundingClientRect();
    var alvo = window.scrollY + r.top + centro * s - window.innerHeight / 2;
    var max = root.scrollHeight - window.innerHeight;
    alvoRolagem = Math.max(0, Math.min(max, alvo));
    if (reduzir){ window.scrollTo(0, alvoRolagem); alvoRolagem = null; return; }
    if (animando) return;
    animando = true;
    var antes = null;
    (function passo(){
      if (alvoRolagem === null || !seguindo){ animando = false; return; }
      var y = window.scrollY, dif = alvoRolagem - y;
      if (Math.abs(dif) < 1 || y === antes){ window.scrollTo(0, alvoRolagem); alvoRolagem = null; animando = false; return; }
      antes = y;
      window.scrollTo(0, y + dif * 0.25);
      requestAnimationFrame(passo);
    })();
  }
  function pararDeSeguir(){
    if (!seguindo || papel !== 'aluno') return;
    seguindo = false;
    alvoRolagem = null;
    btnSeguir.hidden = false;
  }
  btnSeguir.addEventListener('click', function(){
    seguindo = true;
    btnSeguir.hidden = true;
    if (centroProf !== null) seguirPara(centroProf);
  });
  window.addEventListener('wheel', pararDeSeguir, {passive:true});
  window.addEventListener('touchmove', function(e){
    if (e.target === cv && e.touches.length < 2) return;
    if (e.target && e.target.closest && e.target.closest('.barra')) return;
    pararDeSeguir();
  }, {passive:true});
  window.addEventListener('keydown', function(e){
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].indexOf(e.key) > -1 && !(e.target && /INPUT|TEXTAREA|SELECT|BUTTON/.test(e.target.tagName))) pararDeSeguir();
  });

  /* ---------------- ligações gerais ---------------- */
  window.addEventListener('scroll', function(){ pedir(); avisarRolagem(); }, {passive:true});
  window.addEventListener('resize', tamanho);
  try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', pedir); } catch(_){}
  new MutationObserver(pedir).observe(root, {attributes:true, attributeFilter:['data-theme']});

  /* início */
  nomeInput.value = lerLocal('aula-nome') || '';
  mostrarTelaVivo();
  renderPessoas();
  tamanho();
  atualizarCabecalho();
  var params = new URLSearchParams(location.search);
  var codigoUrl = normalizarCodigo(params.get('sala'));
  if (codigoUrl.length === 5){
    codigoInput.value = codigoUrl;
    mostrarVazio();
    if (podeVivo && nomeInput.value) entrar(codigoUrl, lerLocal('aula-prof-' + codigoUrl) === '1');
    else { abrirPainel('vivo'); if (podeVivo) nomeInput.focus(); }
    buscarLista().catch(function(){});
  } else {
    var pedido = params.get('doc') || lerLocal('aula-ultimo-doc');
    buscarLista().then(function(lista){
      var alvo = null;
      lista.forEach(function(d){ if (d.id === pedido) alvo = d; });
      if (alvo) abrirDoc(alvo);
      else {
        mostrarVazio();
        if (params.get('doc')) avisar('Esse documento não existe mais na biblioteca.');
      }
    }, function(){ mostrarVazio(); });
  }

  /* usado só nos testes automáticos */
  window.__aula = {estado:function(){
    return {doc:doc, docH:docH, docPronto:docPronto, escala:s, tracos:tracos(), tracosPorDoc:tracosPorDoc, pessoas:pessoas,
      conectado:conectado, sala:sala, papel:papel, seguindo:seguindo, admin:admin, listaDocs:listaDocs};
  }};
})();
